import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getRuntimeScope } from "./runtime-scope.js";
import { currentRelayGoal } from "./relay-scope.js";
import type { ProcessEffectReference } from "./goal-effect-scope.js";

const execFileAsync = promisify(execFile);
const JOURNAL_VERSION = 1;
const MAX_RECORDS = 128;

export type ProcessScopeKind = "goal" | "session" | "unknown";

export interface ProcessJournalRecord {
  readonly id: string;
  readonly scope_kind?: ProcessScopeKind;
  readonly goal_id?: string | null;
  readonly owner_session_id?: string | null;
  readonly pid: number;
  readonly command_hash: string;
  readonly cwd: string;
  readonly started_at: string;
  readonly process_start_identity: string | null;
  readonly full_output_path: string | null;
  readonly stdout_path?: string | null;
  readonly stderr_path?: string | null;
  readonly state_path?: string | null;
  readonly control_dir?: string | null;
  readonly host_pid?: number | null;
  readonly host_start_identity?: string | null;
  readonly state: "running" | "finished";
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly updated_at: string;
  /** Advisory discovery only; authoritative settlement verifies the Goal effect record and host receipt. */
  readonly effect_binding?: ProcessEffectReference;
}

interface ProcessJournalFile {
  readonly version: number;
  readonly records: readonly ProcessJournalRecord[];
}

const queues = new Map<string, Promise<void>>();

export function processCommandHash(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

export function processJournalPath(workspaceRoot: string): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const slug = createHash("sha256").update(path.resolve(workspaceRoot).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(home, "process-journal", `${slug}.json`);
}

async function loadFile(filePath: string): Promise<ProcessJournalFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as ProcessJournalFile;
    if (parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed.records)) return { version: JOURNAL_VERSION, records: [] };
    return { version: JOURNAL_VERSION, records: parsed.records.slice(-MAX_RECORDS) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: JOURNAL_VERSION, records: [] };
    throw error;
  }
}

async function saveFile(filePath: string, value: ProcessJournalFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    await fs.rename(temp, filePath);
  } catch (error) {
    // Windows rename does not always replace an existing file. The journal is
    // advisory recovery metadata, so an explicit replace is preferable to a
    // non-atomic in-place rewrite. Never remove anything outside this file.
    if (process.platform !== "win32") throw error;
    await fs.rm(filePath, { force: true });
    await fs.rename(temp, filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

async function mutate(workspaceRoot: string, fn: (records: ProcessJournalRecord[]) => void): Promise<void> {
  const filePath = processJournalPath(workspaceRoot);
  const previous = queues.get(filePath) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = await loadFile(filePath);
    const records = [...current.records];
    fn(records);
    records.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    await saveFile(filePath, { version: JOURNAL_VERSION, records: records.slice(-MAX_RECORDS) });
  });
  queues.set(filePath, next);
  try {
    await next;
  } finally {
    if (queues.get(filePath) === next) queues.delete(filePath);
  }
}

export interface CapturedProcessScope {
  readonly workspace_root: string;
  readonly scope_kind: ProcessScopeKind;
  readonly goal_id: string | null;
  readonly owner_session_id: string | null;
}

const capturedProcessScopes = new WeakSet<object>();
const workspaceIdentity = (root: string) => process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);

/** Capture only invocation/Relay authority. Record input and the global Goal projection cannot grant ownership. */
export function captureProcessScope(workspaceRoot: string): CapturedProcessScope {
  const runtime = getRuntimeScope();
  const relayGoal = currentRelayGoal(workspaceRoot);
  if (runtime && workspaceIdentity(runtime.workspaceRoot) !== workspaceIdentity(workspaceRoot)) {
    throw new Error("PROCESS_WORKSPACE_SCOPE_MISMATCH");
  }
  if (runtime?.goalId && relayGoal && runtime.goalId !== relayGoal) throw new Error("PROCESS_GOAL_SCOPE_MISMATCH");
  const goalId = relayGoal || runtime?.goalId || null;
  const ownerSessionId = goalId ? runtime?.goalOwnerSessionId || null : runtime?.mcpSessionId || null;
  const scope = Object.freeze({
    workspace_root: path.resolve(workspaceRoot),
    scope_kind: goalId ? "goal" as const : ownerSessionId ? "session" as const : "unknown" as const,
    goal_id: goalId,
    owner_session_id: ownerSessionId,
  });
  capturedProcessScopes.add(scope);
  return scope;
}

type ProcessOwnership = Pick<ProcessJournalRecord, "scope_kind" | "goal_id" | "owner_session_id">;

/** Older records without an explicit session marker never gain session control from incidental metadata. */
export function processScopeKind(record: ProcessOwnership): ProcessScopeKind {
  if (typeof record.goal_id === "string" && record.goal_id.length > 0) return "goal";
  if (record.scope_kind === "session" && typeof record.owner_session_id === "string" && record.owner_session_id.length > 0) return "session";
  return "unknown";
}

/** Only a scope captured from trusted invocation context may authorize process access. */
export function processScopeMatches(record: ProcessOwnership, scope: CapturedProcessScope): boolean {
  if (!capturedProcessScopes.has(scope)) return false;
  const kind = processScopeKind(record);
  if (kind === "unknown") return false;
  // The conversation that started a process keeps control of it after it
  // creates, replaces or finishes a Goal. Other conversations never match;
  // a verified successor of the same Goal still matches by Goal.
  const ownerSession = typeof record.owner_session_id === "string" && record.owner_session_id ? record.owner_session_id : null;
  if (ownerSession && scope.owner_session_id === ownerSession) return true;
  return kind === "goal" && scope.scope_kind === "goal" && record.goal_id === scope.goal_id;
}

export async function upsertProcessJournalRecord(
  workspaceRoot: string,
  record: ProcessJournalRecord,
  capturedScope: CapturedProcessScope = captureProcessScope(workspaceRoot),
): Promise<void> {
  if (!capturedProcessScopes.has(capturedScope) || workspaceIdentity(capturedScope.workspace_root) !== workspaceIdentity(workspaceRoot)) {
    throw new Error("PROCESS_SCOPE_NOT_CAPTURED");
  }
  await mutate(workspaceRoot, (records) => {
    const index = records.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      const previous = records[index];
      const previousKind = processScopeKind(previous);
      if (previousKind !== "unknown" && !processScopeMatches(previous, capturedScope)) throw new Error("PROCESS_OWNER_SCOPE_MISMATCH");
      // Completion/status updates cannot transfer ownership, including legacy unknown ownership.
      records[index] = {
        ...record,
        scope_kind: previousKind,
        goal_id: previous.goal_id ?? null,
        owner_session_id: previous.owner_session_id ?? null,
        effect_binding: previous.effect_binding,
      };
    } else {
      records.push({
        ...record,
        scope_kind: capturedScope.scope_kind,
        goal_id: capturedScope.goal_id,
        owner_session_id: capturedScope.owner_session_id,
      });
    }
  });
}

/** Legacy unknown records remain conservative references; this list never grants process control. */
export async function listProcessJournalRecords(workspaceRoot: string, goalId?: string): Promise<ProcessJournalRecord[]> {
  return [...(await loadFile(processJournalPath(workspaceRoot))).records]
    .filter((record) => goalId === undefined || processScopeKind(record) === "unknown" || record.goal_id === goalId)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export async function getProcessJournalRecord(workspaceRoot: string, id: string, goalId?: string): Promise<ProcessJournalRecord | null> {
  return (await listProcessJournalRecords(workspaceRoot, goalId)).find((item) => item.id === id) ?? null;
}

/**
 * Stable process-start identity used only to reject PID reuse. It is not a
 * credential and is deliberately separate from command text.
 */
export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const script = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().ToString('O')`;
      const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 3000,
        maxBuffer: 16 * 1024,
      });
      const value = stdout.trim();
      return value || null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 3000,
      maxBuffer: 16 * 1024,
    });
    const value = stdout.trim().replace(/\s+/g, " ");
    return value || null;
  } catch {
    return null;
  }
}

export type RecoveredProcessIdentity = "same" | "different_or_gone" | "unverifiable";

export async function verifyRecoveredProcessIdentity(record: ProcessJournalRecord): Promise<RecoveredProcessIdentity> {
  if (!record.process_start_identity) return "unverifiable";
  const current = await readProcessStartIdentity(record.pid);
  if (!current) return "different_or_gone";
  return current === record.process_start_identity ? "same" : "different_or_gone";
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/**
 * Return the number of bytes in a complete UTF-8 sequence at `index`.
 *
 * `null` means that a valid leading byte is present but its sequence is cut
 * off by `end`; a single byte means the input is malformed at this position.
 * Logs written by the managed process are normally valid UTF-8, but treating
 * malformed bytes as one-byte replacement input keeps the cursor advancing.
 */
function completeUtf8Width(buffer: Buffer, index: number, end: number): number | null {
  const first = buffer[index];
  if (first <= 0x7f) return 1;

  let width: number;
  let secondMin = 0x80;
  let secondMax = 0xbf;
  if (first >= 0xc2 && first <= 0xdf) {
    width = 2;
  } else if (first >= 0xe0 && first <= 0xef) {
    width = 3;
    if (first === 0xe0) secondMin = 0xa0;
    if (first === 0xed) secondMax = 0x9f;
  } else if (first >= 0xf0 && first <= 0xf4) {
    width = 4;
    if (first === 0xf0) secondMin = 0x90;
    if (first === 0xf4) secondMax = 0x8f;
  } else {
    return 1;
  }

  if (index + width > end) return null;
  const second = buffer[index + 1];
  if (second < secondMin || second > secondMax) return 1;
  for (let cursor = index + 2; cursor < index + width; cursor += 1) {
    if (!isUtf8Continuation(buffer[cursor])) return 1;
  }
  return width;
}

/**
 * Find the last byte boundary that ends on a complete UTF-8 code point.
 * Byte offsets remain authoritative for the persistent log, while pages never
 * expose a replacement character caused solely by a page boundary.
 */
function completeUtf8End(buffer: Buffer, start: number, end: number): number {
  let cursor = start;
  let safeEnd = start;
  while (cursor < end) {
    const width = completeUtf8Width(buffer, cursor, end);
    if (width === null) break;
    cursor += width;
    safeEnd = cursor;
  }
  return safeEnd;
}

export async function readProcessLogPage(
  filePath: string,
  requestedOffset = 0,
  requestedBytes = 12_000,
): Promise<{ content: string; offset: number; bytes_read: number; next_offset: number | null; size: number; eof: boolean }> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("Process log path is not a regular file");
  const offset = Math.min(stat.size, Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0));
  const limit = Math.min(200_000, Math.max(1_024, Number.isFinite(requestedBytes) ? Math.floor(requestedBytes) : 12_000));
  if (offset >= stat.size) {
    return { content: "", offset: stat.size, bytes_read: 0, next_offset: null, size: stat.size, eof: true };
  }

  // Probe up to three preceding bytes so a caller that supplies a cursor from
  // an older implementation cannot begin in the middle of a UTF-8 sequence.
  // Cursors returned below are always complete-code-point boundaries.
  const probeStart = Math.max(0, offset - 3);
  const probeLength = Math.min(stat.size - probeStart, offset - probeStart + limit);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(probeLength);
    const { bytesRead: probeBytesRead } = await handle.read(buffer, 0, probeLength, probeStart);
    let startIndex = Math.min(probeBytesRead, offset - probeStart);
    while (startIndex > 0 && isUtf8Continuation(buffer[startIndex])) startIndex -= 1;

    const endLimit = Math.min(probeBytesRead, startIndex + limit);
    let endIndex = completeUtf8End(buffer, startIndex, endLimit);
    // A damaged or concurrently-written log must not leave a cursor stuck at
    // the same offset forever. Valid UTF-8 pages always take the safe path.
    if (endIndex === startIndex && endLimit > startIndex) endIndex = endLimit;

    const effectiveOffset = probeStart + startIndex;
    const bytesRead = Math.max(0, endIndex - startIndex);
    const next = effectiveOffset + bytesRead;
    return {
      content: buffer.subarray(startIndex, endIndex).toString("utf8"),
      offset: effectiveOffset,
      bytes_read: bytesRead,
      next_offset: next < stat.size ? next : null,
      size: stat.size,
      eof: next >= stat.size,
    };
  } finally {
    await handle.close();
  }
}
