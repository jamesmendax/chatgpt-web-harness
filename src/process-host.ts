#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { writeTextFileCas } from "./lib/safe-text-write.js";
import type { ProcessHostSpec, ProcessHostState } from "./lib/process-control.js";
import { readProcessStartIdentity } from "./lib/process-journal.js";
import { claimManagedProcessEffect } from "./lib/goal-effect-scope.js";
import { windowsLaunch } from "./lib/windows-launch.js";
import { ProcessOutputQueue, PostExitOutputDrain, writeAllProcessOutput } from "./lib/process-output-queue.js";

// After the managed child exits, wait this long for its pipes to drain before
// reporting the exit; a background descendant may hold them open forever.
const STDIO_LINGER_MS = 3_000;
// Active descendants can keep producing forever. Stop further intake after
// this grace, then retain and finish every chunk already accepted by the host.
const MAX_POST_EXIT_OUTPUT_DRAIN_MS = 15_000;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const specPath = process.argv[2];
if (!specPath) throw new Error("process-host requires a spec path");
const spec = JSON.parse(await fs.readFile(specPath, "utf8")) as ProcessHostSpec;
// The managed launch capability must disappear from disk before user code starts.
await fs.rm(specPath);
if (spec.version !== 1 || !spec.id || !spec.shell || !Array.isArray(spec.args)) throw new Error("invalid process-host spec");
if (spec.goal_effect && spec.goal_effect.process_id !== spec.id) throw new Error("GOAL_PROCESS_EFFECT_BINDING_INVALID");
const hostIdentity = await readProcessStartIdentity(process.pid);
const managedEffect = spec.goal_effect
  ? await claimManagedProcessEffect(spec.goal_effect, hostIdentity ?? "")
  : undefined;

await Promise.all([
  fs.mkdir(path.dirname(spec.full_output_path), { recursive: true }),
  fs.mkdir(path.dirname(spec.stdout_path), { recursive: true }),
  fs.mkdir(path.dirname(spec.stderr_path), { recursive: true }),
  fs.mkdir(spec.control_dir, { recursive: true }),
]);

const full = await fs.open(spec.full_output_path, "a");
const stdoutFile = await fs.open(spec.stdout_path, "a");
const stderrFile = await fs.open(spec.stderr_path, "a");
const startedAt = new Date().toISOString();
await full.write(`# cwd: ${spec.cwd}\n# started: ${startedAt}\n\n`);

let state: ProcessHostState = {
  version: 1,
  id: spec.id,
  host_pid: process.pid,
  child_pid: null,
  running: true,
  exit_code: null,
  signal: null,
  stdout_bytes: 0,
  stderr_bytes: 0,
  output_encoding: spec.output_encoding ?? "utf-8",
  execution_mode: spec.execution_mode ?? "shell",
  decode_anomaly: false,
  stdin_open: true,
  started_at: startedAt,
  updated_at: startedAt,
  host_start_identity: hostIdentity,
  ...(managedEffect ? { effect_binding: managedEffect.reference } : {}),
};

async function saveState(): Promise<void> {
  state = { ...state, updated_at: new Date().toISOString() };
  await writeTextFileCas(spec.state_path, `${JSON.stringify(state, null, 2)}\n`);
}

// Exact argv on Windows: resolve through PATHEXT and run .cmd/.bat via cmd.exe
// (Node refuses them with shell:false). Shell mode already names PowerShell.
const launch = spec.execution_mode === "argv"
  ? windowsLaunch(spec.shell, spec.args, process.env, spec.cwd)
  : { file: spec.shell, args: spec.args, windowsVerbatimArguments: false };
let child: ChildProcessWithoutNullStreams;
try {
  child = spawn(launch.file, launch.args, {
    cwd: spec.cwd,
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments === true,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (error) {
  // Some launch errors throw synchronously (EINVAL, ENAMETOOLONG). Publish a
  // definite "nothing ran" state instead of dying without one.
  state = { ...state, running: false, stdin_open: false, spawn_error: errorMessage(error) };
  await full.write(`\n# spawn_error: ${state.spawn_error}\n`).catch(() => undefined);
  await saveState();
  await Promise.all([full.close(), stdoutFile.close(), stderrFile.close()].map((p) => p.catch(() => undefined)));
  await managedEffect?.abandon();
  process.exit(1);
}
let spawnError: string | undefined;
let childExited = false;
let stdioHeld = false;
// Install terminal listeners synchronously, before any filesystem or identity await.
// A very short command may close while its durable identity is still being bound.
const childClosed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  // Without a PID the command never started (ENOENT); close follows either way.
  child.once("error", (error) => { if (!child.pid) spawnError = errorMessage(error); });
  child.once("close", (code, signal) => resolve({ code, signal: signal ?? null }));
  // A background descendant can inherit the pipes and keep them open after
  // the managed child exited. Report that exit instead of "running" forever;
  // the descendant itself is left alone.
  child.once("exit", (code, signal) => {
    childExited = true;
    const drain = new PostExitOutputDrain(Date.now(), STDIO_LINGER_MS, MAX_POST_EXIT_OUTPUT_DRAIN_MS);
    const linger = setInterval(() => {
      const decision = drain.evaluate(Date.now(), {
        pendingBytes: outputQueue.pendingBytes,
        backpressured: outputQueue.backpressured,
        bufferedBytes: child.stdout.readableLength + child.stderr.readableLength,
        revision: outputQueue.revision,
      });
      if (decision === "wait") return;
      clearInterval(linger);
      stdioHeld = true;
      stopOutputIntake();
      resolve({ code, signal: signal ?? null });
    }, 50);
    child.once("close", () => clearInterval(linger));
  });
});
// A pending stdin write fails with EOF/EPIPE once the child exits; without a
// listener that error would terminate the host before it saves a final state.
child.stdin?.on("error", () => { state = { ...state, stdin_open: false }; });
state = { ...state, child_pid: child.pid ?? null };

function taskkill(pid: number, force: boolean): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
    killer.once("error", reject);
    killer.once("close", (code) => resolve(code));
  });
}

async function terminateChild(force: boolean): Promise<void> {
  if (!child.pid || !state.running || childExited) return;
  if (process.platform === "win32") {
    // Node's child.kill() only targets the shell process on Windows. Commands
    // started through PowerShell/cmd may leave grandchildren alive, so use the
    // native tree-aware terminator. Ask politely first unless forced; a
    // windowless console process "can only be terminated forcefully", and a
    // stop request must still stop it, so fall back to /F.
    if (!force && (await taskkill(child.pid, false)) === 0) {
      const deadline = Date.now() + 1500;
      while (!childExited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      if (childExited) return;
    }
    if (childExited) return;
    const code = await taskkill(child.pid, true);
    if (code === 0 || childExited || !state.running) return;
    throw new Error(`taskkill failed with exit code ${code}`);
  }
  if (!child.kill(force ? "SIGKILL" : "SIGTERM")) {
    throw new Error("child process did not accept termination signal");
  }
}

const stdoutDecoder = new TextDecoder(spec.output_encoding ?? "utf-8");
const stderrDecoder = new TextDecoder(spec.output_encoding ?? "utf-8");
const outputQueue = new ProcessOutputQueue([child.stdout, child.stderr], async (stream, chunk) => {
    if (stream === "stdout") {
      state = { ...state, stdout_bytes: state.stdout_bytes + chunk.length };
      await writeAllProcessOutput(stdoutFile, chunk);
      const text = stdoutDecoder.decode(chunk, { stream: true });
      if (text.includes("\uFFFD")) state = { ...state, decode_anomaly: true };
      if (text) await writeAllProcessOutput(full, `[stdout]\n${text}`);
    } else {
      state = { ...state, stderr_bytes: state.stderr_bytes + chunk.length };
      await writeAllProcessOutput(stderrFile, chunk);
      const text = stderrDecoder.decode(chunk, { stream: true });
      if (text.includes("\uFFFD")) state = { ...state, decode_anomaly: true };
      if (text) await writeAllProcessOutput(full, `[stderr]\n${text}`);
    }
}, { onError: error => { state = { ...state, log_error: String(error) }; } });
const receiveStdout = (chunk: Buffer): void => outputQueue.enqueue("stdout", chunk);
const receiveStderr = (chunk: Buffer): void => outputQueue.enqueue("stderr", chunk);
child.stdout.on("data", receiveStdout);
child.stderr.on("data", receiveStderr);

function stopOutputIntake(): void {
  outputQueue.stopSources();
  for (const [stream, source, listener] of [
    ["stdout", child.stdout, receiveStdout],
    ["stderr", child.stderr, receiveStderr],
  ] as const) {
    source.off("data", listener);
    // Keep buffers already read by Node before closing descendant-held pipes.
    // These are finite Readable buffers, not an unbounded new intake loop.
    while (source.readableLength > 0) {
      const bytes = source.read(source.readableLength) as Buffer | null;
      if (!bytes) break;
      outputQueue.enqueue(stream, bytes);
    }
    source.destroy();
  }
}
try {
  const childIdentity = child.pid ? await readProcessStartIdentity(child.pid) : null;
  if (managedEffect) {
    if (!child.pid) throw new Error("GOAL_PROCESS_EFFECT_CHILD_UNCERTAIN");
    await managedEffect.bindChild(child.pid, childIdentity);
  }
  state = { ...state, child_start_identity: childIdentity };
  await saveState();
} catch (error) {
  // Without a published state nobody can observe or stop this child; do not
  // leave it running untracked.
  await terminateChild(true).catch(() => undefined);
  throw error;
}

const handled = new Set<string>();
async function scanCommands(): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(spec.control_dir); } catch { return; }
  for (const name of names.filter((value) => value.endsWith(".cmd.json")).sort()) {
    const commandPath = path.join(spec.control_dir, name);
    if (handled.has(commandPath)) continue;
    handled.add(commandPath);
    let command: any;
    try { command = JSON.parse(await fs.readFile(commandPath, "utf8")); }
    catch { handled.delete(commandPath); continue; }
    const receiptPath = path.join(spec.control_dir, `${command.command_id}.receipt.json`);
    let ok = true;
    let error: string | undefined;
    try {
      if (command.action === "stdin") {
        if (!state.running || !child.stdin.writable) throw new Error("stdin is not writable");
        const text = typeof command.text === "string" ? command.text : "";
        if (text) child.stdin.write(text);
        if (command.close_stdin) {
          child.stdin.end();
          state = { ...state, stdin_open: false };
        }
      } else if (command.action === "stop") {
        await terminateChild(command.force === true);
      } else {
        throw new Error("unknown process control action");
      }
      await saveState();
    } catch (caught) {
      ok = false;
      error = caught instanceof Error ? caught.message : String(caught);
    }
    await writeTextFileCas(receiptPath, `${JSON.stringify({ version: 1, command_id: command.command_id, ok, ...(error ? { error } : {}), completed_at: new Date().toISOString() })}\n`)
      .catch(() => undefined);
  }
}

const timer = setInterval(() => { void scanCommands(); }, 50);

try {
    const { code, signal } = await childClosed;
    clearInterval(timer);
    await outputQueue.idle();
    const outTail = stdoutDecoder.decode();
    const errTail = stderrDecoder.decode();
    if (outTail.includes("\uFFFD") || errTail.includes("\uFFFD")) state = { ...state, decode_anomaly: true };
    if (outTail) await writeAllProcessOutput(full, `[stdout]\n${outTail}`);
    if (errTail) await writeAllProcessOutput(full, `[stderr]\n${errTail}`);
    state = {
      ...state,
      running: false,
      exit_code: code,
      signal: signal ?? null,
      stdin_open: false,
      ...(spawnError ? { spawn_error: spawnError } : {}),
      ...(stdioHeld ? { stdio_held_by_descendant: true } : {}),
    };
    await writeAllProcessOutput(full, `\n# exit: ${code}\n# signal: ${signal ?? "none"}\n${spawnError ? `# spawn_error: ${spawnError}\n` : ""}${stdioHeld ? "# stdio_held_by_descendant: true\n# output_capture_incomplete: inherited-pipe intake cutoff\n" : ""}`);
    await Promise.all([full.close(), stdoutFile.close(), stderrFile.close()].map((p) => p.catch(() => undefined)));
    // This proves the directly managed ChildProcess closed. It does not certify
    // arbitrary detached descendants or completion of external side effects.
    if (managedEffect) await managedEffect.complete(code, signal, saveState);
    else await saveState();
} finally {
    // Failure to persist a trustworthy terminal receipt leaves its reservation.
    await managedEffect?.abandon();
}
