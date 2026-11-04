import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { createHash } from "crypto";
import os from "os";
import path from "path";
import { StringDecoder } from "node:string_decoder";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  full_output_path?: string;
  log_incomplete?: boolean;
  log_error?: string;
  stdout_chars: number;
  stderr_chars: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
}

import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";
import { childProcessEnv } from "./child-env.js";

let sessionCwd: string | null = null;
let sessionInitializedAt: string | null = null;
let persistenceRoot: string | null = null;
const history: string[] = [];
const MAX_HISTORY = 50;
const MAX_COMMAND_OUTPUT_CHARS = Math.max(
  20_000,
  Number.parseInt(process.env.COMMAND_OUTPUT_MAX_CHARS || "200000", 10) || 200_000
);
const MAX_COMMAND_LOG_FILES = Math.max(
  20,
  Number.parseInt(process.env.COMMAND_LOG_MAX_FILES || "120", 10) || 120
);

function commandLogDir(root: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const slug = createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
  return path.join(base, "projects", slug, "command-logs");
}

export function createCommandLogPath(root: string): string | undefined {
  try {
    const dir = commandLogDir(root);
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((left, right) => right.time - left.time);
    for (const stale of existing.slice(MAX_COMMAND_LOG_FILES - 1)) {
      try { fs.rmSync(path.join(dir, stale.name), { force: true }); } catch {}
    }
    const filePath = path.join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.log`
    );
    return filePath;
  } catch {
    return undefined;
  }
}

export function createCommandLogFile(root: string): { path?: string; readonly stream?: fs.WriteStream; readonly error?: string } {
  const filePath = createCommandLogPath(root);
  let failure: string | undefined;
  let stream: fs.WriteStream | undefined;
  if (!filePath) failure = "command log path unavailable";
  else {
    try {
      stream = fs.createWriteStream(filePath, { flags: "wx" });
      // Install before the first write and retain for the stream's lifetime.
      stream.on("error", (error: NodeJS.ErrnoException) => {
        failure = error.code || error.message || "command log write failed";
        stream = undefined;
      });
    } catch (error) {
      failure = (error as NodeJS.ErrnoException).code || "command log creation failed";
    }
  }
  return { path: filePath, get stream() { return stream; }, get error() { return failure; } };
}

function appendCappedText(current: string, chunk: string, maxChars: number): string {
  if (chunk.length >= maxChars) return chunk.slice(-maxChars);
  const overflow = current.length + chunk.length - maxChars;
  return overflow > 0 ? current.slice(overflow) + chunk : current + chunk;
}

export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;
  // Retain the owned ChildProcess handle; never look up or kill a replacement
  // PID after this child has exited. Fallback kills only this child, not a tree.
  const fallback = (): void => {
    if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null) return;
    try { child.kill("SIGKILL"); } catch {}
  };
  if (process.platform === "win32") {
    try {
      const root = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const taskkill = path.win32.join(path.win32.isAbsolute(root) ? root : "C:\\Windows", "System32", "taskkill.exe");
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      let settled = false;
      const finish = (failed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failed) {
          console.warn("[process-cleanup] Tree cleanup unavailable; using owned-child fallback only.");
          fallback();
        }
      };
      // spawn failures arrive asynchronously. try/catch alone used to crash
      // the entire MCP on a command timeout when taskkill was absent from PATH.
      killer.once("error", () => finish(true));
      killer.once("exit", (code) => finish(code !== 0));
      const timer = setTimeout(() => {
        finish(true);
        try { killer.kill("SIGKILL"); } catch {}
      }, 5000);
      timer.unref();
      killer.unref();
      return;
    } catch {}
  }
  fallback();
}

export function setShellPersistenceRoot(workspaceRoot: string): void {
  persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
}

/** Restore cwd from disk (ChatGPT = new MCP session per tool call). */
export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  setShellPersistenceRoot(defaultCwd);
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd);
  if (saved?.cwd) {
    sessionCwd = path.resolve(saved.cwd);
    sessionInitializedAt = saved.updated_at;
    if (saved.recent_commands?.length) {
      history.length = 0;
      history.push(...saved.recent_commands.slice(-MAX_HISTORY));
    }
    return;
  }
  initShellSession(defaultCwd);
}

export function getShellCwd(): string {
  if (!sessionCwd) throw new Error("Shell session not initialized");
  return sessionCwd;
}

export function resetShellSession(cwd: string): void {
  sessionCwd = path.resolve(cwd);
  sessionInitializedAt = new Date().toISOString();
  if (persistenceRoot) {
    void saveGlobalShellState(persistenceRoot, sessionCwd, undefined, null);
  }
}

export function getShellStatus() {
  return {
    active: sessionCwd !== null,
    cwd: sessionCwd,
    started_at: sessionInitializedAt,
    recent_commands: [...history].slice(-10),
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Cập nhật cwd khi gặp cd / Set-Location ở đầu command (giống Bash persistent). */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd" };
}

export function transpileCompoundOperators(cmd: string): string {
  if (!cmd.includes("&&") && !cmd.includes("||")) return cmd;

  const tokens: { type: "text" | "&&" | "||"; value: string }[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < cmd.length) {
    const char = cmd[i];
    const nextChar = cmd[i + 1];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      i++;
    } else if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      i++;
    } else if (!inSingleQuote && !inDoubleQuote && char === "&" && nextChar === "&") {
      if (current.trim()) tokens.push({ type: "text", value: current.trim() });
      tokens.push({ type: "&&", value: "&&" });
      current = "";
      i += 2;
    } else if (!inSingleQuote && !inDoubleQuote && char === "|" && nextChar === "|") {
      if (current.trim()) tokens.push({ type: "text", value: current.trim() });
      tokens.push({ type: "||", value: "||" });
      current = "";
      i += 2;
    } else {
      current += char;
      i++;
    }
  }

  if (current.trim()) tokens.push({ type: "text", value: current.trim() });
  if (tokens.length <= 1) return cmd;

  let result = `${tokens[0].value}; $__localCoderSuccess = $?`;

  for (let j = 1; j < tokens.length; j += 2) {
    const op = tokens[j];
    const nextCmd = tokens[j + 1]?.value;
    if (!nextCmd) break;

    if (op.type === "&&") {
      result += `; if ($__localCoderSuccess) { ${nextCmd}; $__localCoderSuccess = $? }`;
    } else if (op.type === "||") {
      result += `; if (-not $__localCoderSuccess) { ${nextCmd}; $__localCoderSuccess = $? }`;
    }
  }

  return `${result}; if (-not $__localCoderSuccess) { exit 1 }`;
}

export function getWinShell(): { shell: string; isPwsh: boolean } {
  const configuredShell = process.env.SHELL?.trim();
  if (configuredShell && /(?:^|[\\/])(pwsh|powershell)(?:\.exe)?$/i.test(configuredShell)) {
    return { shell: configuredShell, isPwsh: /pwsh(?:\.exe)?$/i.test(configuredShell) };
  }

  const pwshPaths = [
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Program Files (x86)\\PowerShell\\7\\pwsh.exe",
  ];
  for (const p of pwshPaths) {
    if (fs.existsSync(p)) return { shell: p, isPwsh: true };
  }

  const sysPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  if (fs.existsSync(sysPowerShell)) return { shell: sysPowerShell, isPwsh: false };

  return { shell: "powershell.exe", isPwsh: false };
}

function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const log = createCommandLogFile(persistenceRoot || cwd);
    log.stream?.write(`# cwd: ${cwd}\n# started: ${new Date(startedAt).toISOString()}\n\n`);
    let effectiveCommand = command;
    let shell = "bash";
    let args: string[] = ["-lc", effectiveCommand];

    if (process.platform === "win32") {
      const winShellInfo = getWinShell();
      shell = winShellInfo.shell;
      if (!winShellInfo.isPwsh) {
        effectiveCommand = transpileCompoundOperators(command);
      }
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
    }

    const child = spawn(shell, args, {
      cwd,
      windowsHide: true,
      env: {
        ...childProcessEnv(),
        CI: "true",
        PAGER: "cat",
        GIT_PAGER: "cat",
        NO_COLOR: "1",
        npm_config_yes: "true",
      },
    });

    if (child.stdin) {
      child.stdin.end();
    }

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let stdoutChars = 0;
    let stderrChars = 0;
    let timedOut = false;
    let settled = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let decodersFlushed = false;

    const appendStdout = (chunk: string): void => {
      if (!chunk) return;
      stdoutChars += chunk.length;
      log.stream?.write(`[stdout]\n${chunk}`);
      if (stdout.length + chunk.length > MAX_COMMAND_OUTPUT_CHARS) stdoutTruncated = true;
      stdout = appendCappedText(stdout, chunk, MAX_COMMAND_OUTPUT_CHARS);
    };
    const appendStderr = (chunk: string): void => {
      if (!chunk) return;
      stderrChars += chunk.length;
      log.stream?.write(`[stderr]\n${chunk}`);
      if (stderr.length + chunk.length > MAX_COMMAND_OUTPUT_CHARS) stderrTruncated = true;
      stderr = appendCappedText(stderr, chunk, MAX_COMMAND_OUTPUT_CHARS);
    };
    const flushDecoders = (): void => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      appendStdout(stdoutDecoder.end());
      appendStderr(stderrDecoder.end());
    };

    const finish = (result: ShellExecResult, trailer: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let resolved = false;
      const done = (error?: Error | null): void => {
        if (resolved) return;
        resolved = true;
        const failure = log.error || (error && ((error as NodeJS.ErrnoException).code || error.message));
        resolve(failure ? { ...result, log_incomplete: true, log_error: failure } : result);
      };
      const stream = log.stream;
      if (!stream) { done(); return; }
      stream.once("error", done);
      stream.end(trailer, done);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    child.stdout?.on("data", (d: Buffer) => {
      appendStdout(stdoutDecoder.write(d));
    });
    child.stderr?.on("data", (d: Buffer) => {
      appendStderr(stderrDecoder.write(d));
    });
    child.on("close", (code) => {
      flushDecoders();
      const durationMs = Date.now() - startedAt;
      const timeoutMessage = timedOut ? `Command timed out after ${timeoutMs / 1000}s` : "";
      finish({
          command,
          cwd,
          stdout: `${stdoutTruncated ? `[output truncated to last ${MAX_COMMAND_OUTPUT_CHARS} chars]\n` : ""}${stdout.trim()}`,
          stderr: `${stderrTruncated ? `[output truncated to last ${MAX_COMMAND_OUTPUT_CHARS} chars]\n` : ""}${stderr.trim()}${timeoutMessage ? `${stderr.trim() ? "\n" : ""}${timeoutMessage}` : ""}`,
          exit_code: timedOut ? null : code,
          timed_out: timedOut,
          duration_ms: durationMs,
          ...(log.path ? { full_output_path: log.path } : {}),
          stdout_chars: stdoutChars,
          stderr_chars: stderrChars,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
        }, `\n# ${timedOut ? "timed_out: true" : `exit: ${code}`}\n# duration_ms: ${durationMs}\n`);
    });
    child.on("error", (err) => {
      flushDecoders();
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      finish({
        command,
        cwd,
        stdout: stdout.trim(),
        stderr: `${stderr.trim()}${stderr.trim() ? "\n" : ""}${message}`,
        exit_code: null,
        timed_out: false,
        duration_ms: durationMs,
        ...(log.path ? { full_output_path: log.path } : {}),
        stdout_chars: stdoutChars,
        stderr_chars: stderrChars + message.length,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
      }, `\n# spawn_error: ${message}\n# duration_ms: ${durationMs}\n`);
    });
  });
}

let shellExecChain: Promise<unknown> = Promise.resolve();

export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  // sessionCwd and the persisted global state are shared across concurrent
  // calls — serialize them so parallel run_command invocations cannot race.
  const run = shellExecChain.catch(() => undefined).then(() => execInShellSessionInner(command, defaultCwd, timeoutMs, workingDirectory));
  shellExecChain = run.catch(() => undefined);
  return run;
}

async function execInShellSessionInner(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  if (!sessionCwd) initShellSession(defaultCwd);
  const persistentCwd = sessionCwd!;
  const executionBase = workingDirectory ? path.resolve(workingDirectory) : persistentCwd;
  const { cwd, command: effective } = applyCwdDirectives(executionBase, command);

  history.push(effective);
  if (history.length > MAX_HISTORY) history.shift();

  const result = await runOnce(effective, cwd, timeoutMs);
  // Commit the session cwd only after a successful run: a failed `cd` (or a
  // failing command after cd) must not poison every later call in the session.
  if (!workingDirectory && result.exit_code === 0) sessionCwd = cwd;

  if (persistenceRoot) {
    const prev = await loadGlobalShellState(persistenceRoot, defaultCwd);
    await saveGlobalShellState(
      persistenceRoot,
      workingDirectory ? persistentCwd : result.exit_code === 0 ? cwd : persistentCwd,
      effective,
      prev
    );
  }

  return result;
}
