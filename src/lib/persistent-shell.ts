import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import { createHash } from "crypto";
import os from "os";
import path from "path";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  operation_started?: boolean;
  duration_ms: number;
  full_output_path?: string;
  log_incomplete?: boolean;
  log_error?: string;
  stdout_chars: number;
  stderr_chars: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  execution_mode?: "shell" | "argv";
  output_encoding?: string;
  decode_anomaly?: boolean;
  raw_stdout_path?: string;
  raw_stderr_path?: string;
  /** The command exited while a background descendant still held its output pipes. */
  stdio_held_by_descendant?: boolean;
}

import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";
import { childProcessEnv } from "./child-env.js";
import { windowsLaunch } from "./windows-launch.js";

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
// After the command itself exits, wait this long for its pipes to drain. A
// background descendant (Start-Process, `start /b`, adb's server) inherits the
// pipes and may hold them open indefinitely; it must not hold the command slot.
export const STDIO_LINGER_MS = 1_500;

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
      try {
        const stalePath = path.join(dir, stale.name);
        fs.rmSync(stalePath, { force: true });
        fs.rmSync(`${stalePath}.stdout.raw`, { force: true });
        fs.rmSync(`${stalePath}.stderr.raw`, { force: true });
      } catch {}
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
    // An unhandled rejection here would terminate the whole MCP server.
    saveGlobalShellState(persistenceRoot, sessionCwd, undefined, null)
      .catch((error) => console.warn("[shell] Could not persist the reset working folder:", error?.message || error));
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

// One leading cd / chdir / Set-Location / sl / pushd whose target this parser
// can resolve exactly: a literal (quoted or plain) path, ~, or $env:NAME.
// Anything else ($var, (expr), wildcards, `cd -`) returns null: the command
// then runs unchanged and the shell resolves it; only the saved folder stays.
function parseLeadingCd(rest: string, current: string): { cwd: string | null; length: number } | null {
  const head = /^(?:cd|chdir|set-location|sl|pushd)(?=\s|;|&&|$)/i.exec(rest);
  if (!head) return null;
  let i = head[0].length;
  const skipSpace = (): void => { while (i < rest.length && /\s/.test(rest[i])) i++; };
  skipSpace();
  const parameter = /^(?:-(?:literalpath|path|lp)|\/d)(?=\s)/i.exec(rest.slice(i));
  if (parameter) { i += parameter[0].length; skipSpace(); }
  let target: string | null = null;
  if (i < rest.length && rest[i] !== ";" && !rest.startsWith("&&", i)) {
    const quote = rest[i];
    if (quote === "'" || quote === '"') {
      const end = rest.indexOf(quote, i + 1);
      if (end < 0) return null;
      target = rest.slice(i + 1, end);
      if (quote === '"' && /[$`]/.test(target)) return null;
      i = end + 1;
    } else {
      const word = /^[^\s;&|<>(){}`'"]+/.exec(rest.slice(i));
      if (!word) return null;
      target = word[0];
      i += word[0].length;
      const variable = /^\$(?:env:|\{env:)([A-Za-z_][\w]*)\}?(?:([\\/].*))?$/i.exec(target);
      if (variable) {
        const value = process.env[variable[1]] ?? Object.entries(process.env).find(([key]) => key.toLowerCase() === variable[1].toLowerCase())?.[1];
        if (!value) return null;
        target = value + (variable[2] ?? "");
      } else if (/^~(?:[\\/]|$)/.test(target)) {
        target = os.homedir() + target.slice(1);
      } else if (/[$*?[\]@%]/.test(target) || target === "-" || target === "+") {
        return null;
      }
    }
    if (!target) return null;
  }
  skipSpace();
  if (i < rest.length) {
    if (rest[i] === ";") i++;
    else if (rest.startsWith("&&", i)) i += 2;
    else return null;
  }
  skipSpace();
  const cwd = target === null ? null : path.isAbsolute(target) ? path.resolve(target) : path.resolve(current, target);
  return { cwd, length: i };
}

/** Cập nhật cwd khi gặp cd / Set-Location ở đầu command (giống Bash persistent). */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const directive = parseLeadingCd(rest, cwd);
    if (!directive) break;
    if (directive.cwd) cwd = directive.cwd;
    rest = rest.slice(directive.length).trim();
  }

  return { cwd, command: rest || "pwd" };
}

const POWERSHELL_CODE_PAGES: Readonly<Record<string, number>> = {
  gbk: 936, gb18030: 54936, big5: 950, shift_jis: 932, "euc-jp": 51932, "euc-kr": 949,
  "utf-16le": 1200, "utf-16be": 1201, "iso-8859-1": 28591, "koi8-r": 20866,
};

function powershellEncoding(encoding: string): string {
  let canonical = "utf-8";
  try { canonical = new TextDecoder(encoding).encoding; } catch { /* validated by the caller */ }
  const windows = /^windows-(\d{3,4})$/.exec(canonical);
  const codePage = POWERSHELL_CODE_PAGES[canonical] ?? (windows ? Number(windows[1]) : undefined);
  return codePage ? `[System.Text.Encoding]::GetEncoding(${codePage})` : "[System.Text.UTF8Encoding]::new()";
}

/**
 * PowerShell decodes native output with [Console]::OutputEncoding and writes
 * its own output with it, so the requested encoding must be set in PowerShell
 * as well; GBK output was otherwise already lost there. The trailer reports a
 * failing native exit code (robocopy 8, git 128) instead of -Command's generic
 * 1, while success still follows PowerShell's rule: the last statement's $?.
 */
export function wrapPowerShellCommand(command: string, encoding = "utf-8"): string {
  return `$OutputEncoding = [Console]::OutputEncoding = ${powershellEncoding(encoding)}; $global:LASTEXITCODE = 0; ${command}\n`
    + "if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }";
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

  return `${result}; if (-not $__localCoderSuccess) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }`;
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

function runOnce(command: string, cwd: string, timeoutMs: number, direct?: { executable: string; args: string[] }, outputEncoding = "utf-8"): Promise<ShellExecResult> {
  return new Promise((resolve) => {
    const encoding = outputEncoding.toLowerCase() === "cp936" ? "gbk" : outputEncoding;
    const stdoutDecoder = new TextDecoder(encoding);
    const stderrDecoder = new TextDecoder(encoding);
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
      effectiveCommand = wrapPowerShellCommand(effectiveCommand, encoding);
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", effectiveCommand];
    }

    const env = {
      ...childProcessEnv(),
      CI: "true",
      PAGER: "cat",
      GIT_PAGER: "cat",
      NO_COLOR: "1",
      npm_config_yes: "true",
    };
    let verbatim = false;
    if (direct) {
      const launch = windowsLaunch(direct.executable, direct.args, env, cwd);
      shell = launch.file; args = launch.args; verbatim = launch.windowsVerbatimArguments === true;
    }
    let child: ChildProcess;
    try {
      child = spawn(shell, args, {
        shell: false,
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        env,
      });
    } catch (error) {
      // Node throws synchronously for some launch errors (EINVAL, ENAMETOOLONG).
      // Report them like an asynchronous spawn error instead of leaking the log.
      const message = spawnErrorMessage(error, cwd);
      log.stream?.end(`\n# spawn_error: ${message}\n`);
      resolve({ command, cwd, stdout: "", stderr: message, exit_code: null, timed_out: false, operation_started: false,
        duration_ms: Date.now() - startedAt, ...(log.path ? { full_output_path: log.path } : {}),
        stdout_chars: 0, stderr_chars: message.length, stdout_truncated: false, stderr_truncated: false,
        execution_mode: direct ? "argv" : "shell", output_encoding: encoding });
      return;
    }

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
    const rawStdout = log.path ? fs.createWriteStream(`${log.path}.stdout.raw`) : undefined;
    const rawStderr = log.path ? fs.createWriteStream(`${log.path}.stderr.raw`) : undefined;
    let rawLogError: string | undefined;
    const rawFinished = [rawStdout, rawStderr].map(stream => stream ? new Promise<void>(resolve => {
      stream.once("finish", resolve);
      stream.once("error", error => { rawLogError = error.message; resolve(); });
    }) : Promise.resolve());
    let decodeAnomaly = false;
    let decodersFlushed = false;

    const appendStdout = (chunk: string): void => {
      if (!chunk) return;
      if (chunk.includes("\uFFFD")) decodeAnomaly = true;
      stdoutChars += chunk.length;
      log.stream?.write(`[stdout]\n${chunk}`);
      if (stdout.length + chunk.length > MAX_COMMAND_OUTPUT_CHARS) stdoutTruncated = true;
      stdout = appendCappedText(stdout, chunk, MAX_COMMAND_OUTPUT_CHARS);
    };
    const appendStderr = (chunk: string): void => {
      if (!chunk) return;
      if (chunk.includes("\uFFFD")) decodeAnomaly = true;
      stderrChars += chunk.length;
      log.stream?.write(`[stderr]\n${chunk}`);
      if (stderr.length + chunk.length > MAX_COMMAND_OUTPUT_CHARS) stderrTruncated = true;
      stderr = appendCappedText(stderr, chunk, MAX_COMMAND_OUTPUT_CHARS);
    };
    const flushDecoders = (): void => {
      if (decodersFlushed) return;
      decodersFlushed = true;
      appendStdout(stdoutDecoder.decode());
      appendStderr(stderrDecoder.decode());
    };

    const finish = (result: ShellExecResult, trailer: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(lingerTimer);
      rawStdout?.end(); rawStderr?.end();
      result.execution_mode = direct ? "argv" : "shell";
      result.operation_started = Boolean(child.pid);
      result.output_encoding = encoding;
      result.decode_anomaly = decodeAnomaly;
      if (decodeAnomaly && log.path) { result.raw_stdout_path = `${log.path}.stdout.raw`; result.raw_stderr_path = `${log.path}.stderr.raw`; }
      let resolved = false;
      const done = (error?: Error | null): void => {
        if (resolved) return;
        resolved = true;
        void Promise.all(rawFinished).then(() => {
          const failure = log.error || rawLogError || (error && ((error as NodeJS.ErrnoException).code || error.message));
          if (!decodeAnomaly && log.path) {
            try { fs.rmSync(`${log.path}.stdout.raw`, { force: true }); fs.rmSync(`${log.path}.stderr.raw`, { force: true }); } catch {}
          }
          resolve(failure ? { ...result, log_incomplete: true, log_error: failure } : result);
        });
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
      rawStdout?.write(d);
      appendStdout(stdoutDecoder.decode(d, { stream: true }));
    });
    child.stderr?.on("data", (d: Buffer) => {
      rawStderr?.write(d);
      appendStderr(stderrDecoder.decode(d, { stream: true }));
    });
    let lingerTimer: ReturnType<typeof setTimeout> | undefined;
    let stdioHeld = false;
    const completeRun = (code: number | null): void => {
      if (settled) return;
      clearTimeout(lingerTimer);
      flushDecoders();
      const durationMs = Date.now() - startedAt;
      const timeoutMessage = timedOut ? `Command timed out after ${timeoutMs / 1000}s` : "";
      const heldMessage = stdioHeld ? "[command exited; a background process it started still holds its output, which is not captured here]" : "";
      const notes = [timeoutMessage, heldMessage].filter(Boolean).join("\n");
      finish({
          command,
          cwd,
          stdout: `${stdoutTruncated ? `[output truncated to last ${MAX_COMMAND_OUTPUT_CHARS} chars]\n` : ""}${stdout.trim()}`,
          stderr: `${stderrTruncated ? `[output truncated to last ${MAX_COMMAND_OUTPUT_CHARS} chars]\n` : ""}${stderr.trim()}${notes ? `${stderr.trim() ? "\n" : ""}${notes}` : ""}`,
          exit_code: timedOut ? null : code,
          timed_out: timedOut,
          duration_ms: durationMs,
          ...(log.path ? { full_output_path: log.path } : {}),
          stdout_chars: stdoutChars,
          stderr_chars: stderrChars,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
          ...(stdioHeld ? { stdio_held_by_descendant: true } : {}),
        }, `\n# ${timedOut ? "timed_out: true" : `exit: ${code}`}${stdioHeld ? "\n# stdio_held_by_descendant: true" : ""}\n# duration_ms: ${durationMs}\n`);
    };
    // "close" waits for every holder of the pipes. Report this command once
    // it exits and its pipes drain, or after STDIO_LINGER_MS; the descendant
    // keeps running untouched (it is often a server the caller just started).
    child.on("exit", (code) => {
      if (settled) return;
      lingerTimer = setTimeout(() => {
        stdioHeld = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        completeRun(code);
      }, STDIO_LINGER_MS);
    });
    child.on("close", (code) => completeRun(code));
    child.on("error", (err) => {
      flushDecoders();
      const durationMs = Date.now() - startedAt;
      const message = spawnErrorMessage(err, cwd);
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
  workingDirectory?: string,
  outputEncoding = "utf-8"
): Promise<ShellExecResult> {
  new TextDecoder(outputEncoding.toLowerCase() === "cp936" ? "gbk" : outputEncoding);
  // sessionCwd and the persisted global state are shared across concurrent
  // calls — serialize them so parallel run_command invocations cannot race.
  const run = shellExecChain.catch(() => undefined).then(() => execInShellSessionInner(command, defaultCwd, timeoutMs, workingDirectory, outputEncoding));
  shellExecChain = run.catch(() => undefined);
  return run;
}

async function execInShellSessionInner(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string,
  outputEncoding = "utf-8"
): Promise<ShellExecResult> {
  if (!sessionCwd) initShellSession(defaultCwd);
  // A saved working folder that was deleted or moved would otherwise fail every
  // later command with a misleading "spawn …powershell.exe ENOENT".
  let cwdFallbackFrom: string | undefined;
  if (!workingDirectory && !(await isDirectory(sessionCwd!))) {
    cwdFallbackFrom = sessionCwd!;
    sessionCwd = path.resolve(defaultCwd);
  }
  const persistentCwd = sessionCwd!;
  const executionBase = workingDirectory ? path.resolve(workingDirectory) : persistentCwd;
  const { cwd, command: effective } = applyCwdDirectives(executionBase, command);

  history.push(effective);
  if (history.length > MAX_HISTORY) history.shift();

  const result = await runOnce(effective, cwd, timeoutMs, undefined, outputEncoding);
  if (cwdFallbackFrom) result.stderr = `${result.stderr}${result.stderr ? "\n" : ""}[saved working folder ${cwdFallbackFrom} no longer exists; using ${persistentCwd}]`;
  // Commit the session cwd only after a successful run: a failed `cd` (or a
  // failing command after cd) must not poison every later call in the session.
  if (!workingDirectory && result.exit_code === 0) sessionCwd = cwd;

  if (persistenceRoot) {
    // The command already ran; a state-file failure must not turn its result
    // into an error that invites a repeat of its side effects.
    try {
      const prev = await loadGlobalShellState(persistenceRoot, defaultCwd);
      await saveGlobalShellState(
        persistenceRoot,
        workingDirectory ? persistentCwd : result.exit_code === 0 ? cwd : persistentCwd,
        effective,
        prev
      );
    } catch (error) {
      console.warn("[shell] Could not persist the working folder:", (error as Error)?.message || error);
    }
  }

  return result;
}

// Node reports a missing working folder as "spawn …powershell.exe ENOENT",
// which reads as if PowerShell itself were missing.
function spawnErrorMessage(error: unknown, cwd: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return (error as NodeJS.ErrnoException)?.code === "ENOENT" && !fs.existsSync(cwd)
    ? `${message} (the working folder ${cwd} does not exist; nothing ran)`
    : message;
}

async function isDirectory(target: string): Promise<boolean> {
  try { return (await fs.promises.stat(target)).isDirectory(); } catch { return false; }
}

export async function execArgvInShellSession(executable: string, args: string[], defaultCwd: string, timeoutMs: number, workingDirectory?: string, encoding = "utf-8"): Promise<ShellExecResult> {
  // Validate before spawning, retaining the same serialized ownership and timeout path.
  new TextDecoder(encoding.toLowerCase() === "cp936" ? "gbk" : encoding);
  const run = shellExecChain.catch(() => undefined).then(async () => {
    if (!sessionCwd) initShellSession(defaultCwd);
    const cwd = workingDirectory ? path.resolve(workingDirectory) : sessionCwd!;
    return runOnce(JSON.stringify([executable, ...args]), cwd, timeoutMs, { executable, args }, encoding);
  });
  shellExecChain = run.catch(() => undefined);
  return run;
}
