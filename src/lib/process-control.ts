import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeTextFileCas } from "./safe-text-write.js";
import { readProcessStartIdentity, type ProcessJournalRecord } from "./process-journal.js";
import type { ManagedProcessEffectLaunch, ProcessEffectReference } from "./goal-effect-scope.js";

export interface ProcessHostSpec {
  version: 1;
  id: string;
  shell: string;
  args: string[];
  cwd: string;
  full_output_path: string;
  stdout_path: string;
  stderr_path: string;
  state_path: string;
  control_dir: string;
  output_encoding?: string;
  execution_mode?: "shell" | "argv";
  /** Internal one-use capability, consumed before spawning the user's command. */
  goal_effect?: ManagedProcessEffectLaunch;
}

export interface ProcessHostState {
  version: 1;
  id: string;
  host_pid: number;
  child_pid: number | null;
  running: boolean;
  exit_code: number | null;
  signal: string | null;
  stdout_bytes: number;
  stderr_bytes: number;
  output_encoding?: string;
  decode_anomaly?: boolean;
  execution_mode?: "shell" | "argv";
  log_error?: string;
  stdin_open: boolean;
  started_at: string;
  updated_at: string;
  effect_binding?: ProcessEffectReference;
  host_start_identity?: string | null;
  child_start_identity?: string | null;
}

export interface ProcessControlPaths {
  root: string;
  spec: string;
  state: string;
  controlDir: string;
  stdout: string;
  stderr: string;
}

function processNamespace(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot).toLowerCase()).digest("hex").slice(0, 16);
}

export function processControlPaths(workspaceRoot: string, id: string): ProcessControlPaths {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const root = path.join(home, "process-control", processNamespace(workspaceRoot), id);
  return {
    root,
    spec: path.join(root, "host-spec.json"),
    state: path.join(root, "state.json"),
    controlDir: path.join(root, "commands"),
    stdout: path.join(root, "stdout.log"),
    stderr: path.join(root, "stderr.log"),
  };
}

export async function writeProcessHostSpec(specPath: string, spec: ProcessHostSpec): Promise<void> {
  await fs.mkdir(path.dirname(specPath), { recursive: true });
  await fs.mkdir(spec.control_dir, { recursive: true });
  // The host is spawned only after this function returns. A direct exclusive
  // write avoids CAS hardlink temporaries retaining the private launch capability.
  const handle = await fs.open(specPath, "wx", 0o600);
  let complete = false;
  try {
    try { await handle.writeFile(JSON.stringify(spec, null, 2) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    complete = true;
  } finally {
    if (!complete) await fs.unlink(specPath).catch(() => undefined);
  }
}

export async function readProcessHostState(statePath: string | null | undefined): Promise<ProcessHostState | null> {
  if (!statePath) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as ProcessHostState;
    if (parsed.version !== 1 || typeof parsed.id !== "string") return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function waitForProcessHostState(statePath: string, timeoutMs = 5000): Promise<ProcessHostState> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  for (;;) {
    const state = await readProcessHostState(statePath);
    if (state?.child_pid) return state;
    if (Date.now() >= deadline) throw new Error("PROCESS_HOST_START_TIMEOUT: host did not publish child state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitForProcessHostExit(
  statePath: string,
  hostPid: number,
  hostStartIdentity: string | null | undefined,
  timeoutMs = 5000,
): Promise<{ state: ProcessHostState | null; host_exited: boolean }> {
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let lastState: ProcessHostState | null = null;
  for (;;) {
    lastState = await readProcessHostState(statePath);
    const hostIdentity = hostStartIdentity ? await readProcessStartIdentity(hostPid) : null;
    const hostExited = !hostStartIdentity || hostIdentity !== hostStartIdentity;
    if (lastState && !lastState.running && hostExited) return { state: lastState, host_exited: true };
    if (Date.now() >= deadline) return { state: lastState, host_exited: hostExited };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function processControlAvailable(record: ProcessJournalRecord): Promise<boolean> {
  if (!record.control_dir || !record.state_path || !record.host_pid || !record.host_start_identity) return false;
  const [hostIdentity, childIdentity, state] = await Promise.all([
    readProcessStartIdentity(record.host_pid),
    record.process_start_identity ? readProcessStartIdentity(record.pid) : Promise.resolve(null),
    readProcessHostState(record.state_path),
  ]);
  if (hostIdentity !== record.host_start_identity) return false;
  if (record.state === "running" && record.process_start_identity && childIdentity !== record.process_start_identity) return false;
  return Boolean(state && state.id === record.id && state.host_pid === record.host_pid);
}

interface ProcessControlCommand {
  version: 1;
  command_id: string;
  action: "stdin" | "stop";
  text?: string;
  close_stdin?: boolean;
  force?: boolean;
  created_at: string;
}

interface ProcessControlReceipt {
  version: 1;
  command_id: string;
  ok: boolean;
  error?: string;
  completed_at: string;
}

export async function sendProcessControl(
  controlDir: string,
  action: "stdin" | "stop",
  options: { text?: string; closeStdin?: boolean; force?: boolean; timeoutMs?: number } = {},
): Promise<ProcessControlReceipt> {
  await fs.mkdir(controlDir, { recursive: true });
  const commandId = randomUUID();
  const command: ProcessControlCommand = {
    version: 1,
    command_id: commandId,
    action,
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.closeStdin === undefined ? {} : { close_stdin: options.closeStdin }),
    ...(options.force === undefined ? {} : { force: options.force }),
    created_at: new Date().toISOString(),
  };
  const commandPath = path.join(controlDir, `${commandId}.cmd.json`);
  const receiptPath = path.join(controlDir, `${commandId}.receipt.json`);
  await writeTextFileCas(commandPath, `${JSON.stringify(command)}\n`, { createOnly: true });
  const deadline = Date.now() + Math.max(100, Math.min(options.timeoutMs ?? 5000, 30_000));
  for (;;) {
    try {
      const parsed = JSON.parse(await fs.readFile(receiptPath, "utf8")) as ProcessControlReceipt;
      if (parsed.command_id === commandId) {
        await fs.rm(commandPath, { force: true }).catch(() => undefined);
        await fs.rm(receiptPath, { force: true }).catch(() => undefined);
        return parsed;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`PROCESS_CONTROL_TIMEOUT: ${action} command was not acknowledged`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function readTextTail(filePath: string | null | undefined, maxBytes: number, encoding = "utf-8"): Promise<{ text: string; bytes: number }> {
  if (!filePath) return { text: "", bytes: 0 };
  try {
    const stat = await fs.stat(filePath);
    const size = stat.size;
    const length = Math.min(size, Math.max(1, maxBytes));
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, size - length));
      return { text: new TextDecoder(encoding.toLowerCase() === "cp936" ? "gbk" : encoding).decode(buffer.subarray(0, bytesRead)), bytes: size };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", bytes: 0 };
    throw error;
  }
}