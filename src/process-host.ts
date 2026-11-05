#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeTextFileCas } from "./lib/safe-text-write.js";
import type { ProcessHostSpec, ProcessHostState } from "./lib/process-control.js";
import { readProcessStartIdentity } from "./lib/process-journal.js";
import { claimManagedProcessEffect } from "./lib/goal-effect-scope.js";

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

const child = spawn(spec.shell, spec.args, {
  cwd: spec.cwd,
  windowsHide: true,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
// Install terminal listeners synchronously, before any filesystem or identity await.
// A very short command may close while its durable identity is still being bound.
const childClosed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
  child.once("error", () => { /* close follows; a missing child PID remains uncertain. */ });
  child.once("close", (code, signal) => resolve({ code, signal: signal ?? null }));
});
state = { ...state, child_pid: child.pid ?? null };

async function terminateChild(force: boolean): Promise<void> {
  if (!child.pid || !state.running) return;
  if (process.platform === "win32") {
    // Node's child.kill() only targets the shell process on Windows. Commands
    // started through PowerShell/cmd may leave grandchildren alive, so use the
    // native tree-aware terminator and wait for its acknowledgement.
    await new Promise<void>((resolve, reject) => {
      const args = ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])];
      const killer = spawn("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || !state.running) resolve();
        else reject(new Error(`taskkill failed with exit code ${code}`));
      });
    });
    return;
  }
  if (!child.kill(force ? "SIGKILL" : "SIGTERM")) {
    throw new Error("child process did not accept termination signal");
  }
}

const stdoutDecoder = new TextDecoder(spec.output_encoding ?? "utf-8");
const stderrDecoder = new TextDecoder(spec.output_encoding ?? "utf-8");
let writeChain = Promise.resolve();
function queueWrite(stream: "stdout" | "stderr", chunk: Buffer): void {
  if (!chunk.length) return;
  writeChain = writeChain.then(async () => {
    if (stream === "stdout") {
      state = { ...state, stdout_bytes: state.stdout_bytes + chunk.length };
      await stdoutFile.write(chunk);
      const text = stdoutDecoder.decode(chunk, { stream: true });
      if (text.includes("\uFFFD")) state = { ...state, decode_anomaly: true };
      if (text) await full.write(`[stdout]\n${text}`);
    } else {
      state = { ...state, stderr_bytes: state.stderr_bytes + chunk.length };
      await stderrFile.write(chunk);
      const text = stderrDecoder.decode(chunk, { stream: true });
      if (text.includes("\uFFFD")) state = { ...state, decode_anomaly: true };
      if (text) await full.write(`[stderr]\n${text}`);
    }
  }).catch(error => { state = { ...state, log_error: String(error) }; });
}
child.stdout.on("data", (chunk: Buffer) => queueWrite("stdout", chunk));
child.stderr.on("data", (chunk: Buffer) => queueWrite("stderr", chunk));
const childIdentity = child.pid ? await readProcessStartIdentity(child.pid) : null;
if (managedEffect) {
  if (!child.pid) throw new Error("GOAL_PROCESS_EFFECT_CHILD_UNCERTAIN");
  await managedEffect.bindChild(child.pid, childIdentity);
}
state = { ...state, child_start_identity: childIdentity };
await saveState();

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
    await writeChain;
    const outTail = stdoutDecoder.decode();
    const errTail = stderrDecoder.decode();
    if (outTail.includes("\uFFFD") || errTail.includes("\uFFFD")) state = { ...state, decode_anomaly: true };
    if (outTail) await full.write(`[stdout]\n${outTail}`);
    if (errTail) await full.write(`[stderr]\n${errTail}`);
    state = {
      ...state,
      running: false,
      exit_code: code,
      signal: signal ?? null,
      stdin_open: false,
    };
    await full.write(`\n# exit: ${code}\n# signal: ${signal ?? "none"}\n`);
    await Promise.all([full.close(), stdoutFile.close(), stderrFile.close()].map((p) => p.catch(() => undefined)));
    // This proves the directly managed ChildProcess closed. It does not certify
    // arbitrary detached descendants or completion of external side effects.
    if (managedEffect) await managedEffect.complete(code, signal, saveState);
    else await saveState();
} finally {
    // Failure to persist a trustworthy terminal receipt leaves its reservation.
    await managedEffect?.abandon();
}