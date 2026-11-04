import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export type HarnessEvidenceKind = "deterministic" | "runtime" | "model_assessed" | "user_confirmed";

export type HarnessEventType =
  | "goal/change"
  | "task/change"
  | "tool/observation"
  | "evidence/recorded"
  | "context/bundle"
  | "goal/stall";

/**
 * Log format version. Bump exactly when an older runtime could no longer read a
 * new log with full semantic correctness (header shape, envelope keys, core
 * event semantics). Adding an ordinary event type does NOT bump — the reader
 * refuses such logs instead of silently skipping them.
 */
export const HARNESS_LOG_VERSION = 2;

const EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "goal/change",
  "task/change",
  "tool/observation",
  "evidence/recorded",
  "context/bundle",
  "goal/stall",
]);

// Fixed envelope key set: a write-site bug and a read-site refusal.
const ENVELOPE_KEYS: ReadonlySet<string> = new Set<string>([
  "type",
  "seq",
  "time",
  "data",
  "task_id",
  "goal_id",
  "evidence_kind",
  "project_roots",
  "id",
  "causation_id",
]);

const MAX_EVENT_JSON_BYTES = 64 * 1024;
const MAX_DATA_DEPTH = 16;

export class HarnessLogFormatError extends Error {
  readonly file_path: string;

  constructor(filePath: string, message: string) {
    super(message);
    this.name = "HarnessLogFormatError";
    this.file_path = filePath;
  }
}

export interface HarnessEvent {
  type: HarnessEventType;
  seq: number;
  time: string;
  data: Record<string, unknown>;
  task_id?: string;
  goal_id?: string;
  evidence_kind?: HarnessEvidenceKind;
  project_roots?: string[];
  id?: string;
  causation_id?: string;
}

type HarnessEventInput = Omit<HarnessEvent, "seq" | "time">;

interface HarnessLogHeader {
  kind: "harness-log";
  version: number;
  workspace_root: string;
  created_at: string;
}

interface ScanResult {
  format: "none" | "legacy" | "v2" | "error";
  header: HarnessLogHeader | null;
  events: HarnessEvent[];
  healthy_end_offset: number;
  total_bytes: number;
  torn_tail: boolean;
  degraded: boolean;
  error?: string;
}

const readyChains = new Map<string, Promise<void>>();
const appendChains = new Map<string, Promise<void>>();
const seqCaches = new Map<string, number>();
const healthySizes = new Map<string, number>();
const repairCounts = new Map<string, number>();
const writeFailures = new Map<string, { count: number; last_error: string; last_at: string }>();

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function harnessEventLogPath(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", projectSlug(workspaceRoot), "harness-events.jsonl");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonData(value: unknown, at: string, seen: Set<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) throw new Error(`cyclic reference at ${at}`);
    if (Array.isArray(value)) {
      if (value.length > 4096) throw new Error(`array at ${at} exceeds 4096 entries`);
      seen.add(value);
      value.forEach((item, index) => assertJsonData(item, `${at}[${index}]`, seen));
      seen.delete(value);
      return;
    }
    if (!isPlainObject(value)) throw new Error(`non-plain object at ${at}`);
    const keys = Object.keys(value);
    if (keys.length > 512) throw new Error(`object at ${at} exceeds 512 keys`);
    seen.add(value);
    for (const key of keys) {
      const item = value[key];
      if (item === undefined) continue; // JSON.stringify drops undefined fields — treat them as absent
      assertJsonData(item, `${at}.${key}`, seen);
    }
    seen.delete(value);
    return;
  }
  throw new Error(`non-JSON value (${typeof value}) at ${at}`);
}

function parseHeaderLine(line: string, filePath: string): HarnessLogHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new HarnessLogFormatError(filePath, "log header line is not valid JSON");
  }
  const header = parsed as Partial<HarnessLogHeader>;
  if (header.kind !== "harness-log" || typeof header.version !== "number") {
    throw new HarnessLogFormatError(filePath, "first log line is not a harness-log header");
  }
  if (header.version > HARNESS_LOG_VERSION) {
    throw new HarnessLogFormatError(
      filePath,
      `log format v${header.version} is newer than supported v${HARNESS_LOG_VERSION}: the log was written by a newer harness — upgrade the harness to open it`
    );
  }
  if (header.version < HARNESS_LOG_VERSION) {
    throw new HarnessLogFormatError(
      filePath,
      `log format v${header.version} is older than supported v${HARNESS_LOG_VERSION}, and this build ships no upgrade path for it`
    );
  }
  return header as HarnessLogHeader;
}

// Structural validation only: unknown keys/types/refusals are a wrong read and
// refuse the whole log. Parse failures and seq gaps are tail damage handled by
// the caller (healthy prefix + removable tail), never a hard refusal.
function validateEventLine(parsed: Record<string, unknown>, filePath: string): HarnessEvent {
  for (const key of Object.keys(parsed)) {
    if (!ENVELOPE_KEYS.has(key)) {
      throw new HarnessLogFormatError(filePath, `event envelope carries unknown key "${key}" — likely written by a newer harness`);
    }
  }
  if (typeof parsed.type !== "string" || !EVENT_TYPES.has(parsed.type)) {
    throw new HarnessLogFormatError(filePath, `unknown event type "${String(parsed.type)}" — likely written by a newer harness`);
  }
  if (!Number.isInteger(parsed.seq) || (parsed.seq as number) < 0) {
    throw new HarnessLogFormatError(filePath, "event seq is not a non-negative integer");
  }
  if (parsed.data !== undefined && !isPlainObject(parsed.data)) {
    throw new HarnessLogFormatError(filePath, "event data is not a plain object");
  }
  if (parsed.evidence_kind !== undefined && typeof parsed.evidence_kind !== "string") {
    throw new HarnessLogFormatError(filePath, "event evidence_kind is not a string");
  }
  return parsed as unknown as HarnessEvent;
}

function convertLegacyEvent(parsed: Record<string, unknown>): HarnessEvent {
  const event = { ...parsed } as Record<string, unknown>;
  delete event.version;
  delete event.workspace_root;
  return event as unknown as HarnessEvent;
}

async function scanLogFile(filePath: string): Promise<ScanResult> {
  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { format: "none", header: null, events: [], healthy_end_offset: 0, total_bytes: 0, torn_tail: false, degraded: false };
    }
    return {
      format: "error",
      header: null,
      events: [],
      healthy_end_offset: 0,
      total_bytes: 0,
      torn_tail: false,
      degraded: false,
      error: `${code ?? "ERROR"}: ${(error as Error).message}`,
    };
  }

  let cursor = 0;
  let healthyEnd = 0;
  const events: HarnessEvent[] = [];
  let tornTail = false;
  let degraded = false;
  let header: HarnessLogHeader | null = null;
  let format: "legacy" | "v2" = "legacy";
  let expectedSeq = 0;
  let firstLine = true;

  const fail = (message: string, isLast: boolean): void => {
    if (isLast) tornTail = true;
    else degraded = true;
    void message;
  };

  while (cursor < buf.length) {
    const newline = buf.indexOf(10, cursor);
    const isLast = newline === -1;
    const lineEnd = isLast ? buf.length : newline;
    const raw = buf.subarray(cursor, lineEnd).toString("utf-8").trim();
    cursor = isLast ? buf.length : newline + 1;

    if (!raw) continue;
    if (firstLine) {
      firstLine = false;
      try {
        const probe = JSON.parse(raw) as Record<string, unknown>;
        if (probe && typeof probe === "object" && probe.kind === "harness-log") {
          header = parseHeaderLine(raw, filePath);
          format = "v2";
          healthyEnd = cursor;
          continue;
        }
      } catch (error) {
        if (error instanceof HarnessLogFormatError) throw error;
      }
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const event = format === "v2" ? validateEventLine(parsed, filePath) : convertLegacyEvent(parsed);
      if ((event.seq as number) !== expectedSeq) {
        fail(`seq gap at ${event.seq} (expected ${expectedSeq})`, isLast);
        break;
      }
      expectedSeq = (event.seq as number) + 1;
      events.push(event);
      healthyEnd = isLast ? buf.length : cursor;
    } catch (error) {
      if (error instanceof HarnessLogFormatError) throw error;
      fail((error as Error).message, isLast);
      break;
    }
  }

  return {
    format,
    header,
    events,
    healthy_end_offset: healthyEnd,
    total_bytes: buf.length,
    torn_tail: tornTail,
    degraded,
  };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf-8");
  await fs.rename(temp, filePath);
}

function makeHeader(workspaceRoot: string): HarnessLogHeader {
  return {
    kind: "harness-log",
    version: HARNESS_LOG_VERSION,
    workspace_root: path.resolve(workspaceRoot),
    created_at: new Date().toISOString(),
  };
}

async function ensureReady(filePath: string, workspaceRoot: string): Promise<void> {
  const scan = await scanLogFile(filePath);
  if (scan.format === "error") throw new Error(`harness event log unreadable: ${scan.error}`);

  if (scan.format === "none") {
    const headerLine = `${JSON.stringify(makeHeader(workspaceRoot))}\n`;
    await atomicWrite(filePath, headerLine);
    seqCaches.set(filePath, -1);
    healthySizes.set(filePath, Buffer.byteLength(headerLine, "utf-8"));
    return;
  }

  const tailDamage = scan.torn_tail || scan.degraded || scan.healthy_end_offset < scan.total_bytes;
  if (scan.format === "legacy") {
    const lines = [JSON.stringify(makeHeader(workspaceRoot)), ...scan.events.map((event) => JSON.stringify(event))];
    const content = lines.map((line) => `${line}\n`).join("");
    await atomicWrite(filePath, content);
    if (scan.events.length) {
      console.warn(`[harness-events] migrated legacy log to v${HARNESS_LOG_VERSION}: ${scan.events.length} event(s) at ${filePath}`);
    }
    repairCounts.set(filePath, (repairCounts.get(filePath) ?? 0) + 1);
    seqCaches.set(filePath, scan.events.length ? (scan.events.at(-1)!.seq as number) : -1);
    healthySizes.set(filePath, Buffer.byteLength(content, "utf-8"));
    return;
  }

  if (scan.degraded) {
    // Mid-file structural damage: truncating would silently delete every
    // possibly-valid event after the gap. Quarantine the whole file for
    // forensics and start a fresh log instead.
    const quarantined = `${filePath}.corrupt-${Date.now()}`;
    try {
      await fs.rename(filePath, quarantined);
      console.warn(`[harness-events] mid-file damage: log quarantined to ${quarantined}; starting fresh`);
    } catch {
      console.warn(`[harness-events] mid-file damage detected but quarantine rename failed at ${filePath}`);
    }
    const headerLine = `${JSON.stringify(makeHeader(workspaceRoot))}\n`;
    await atomicWrite(filePath, headerLine);
    seqCaches.set(filePath, -1);
    healthySizes.set(filePath, Buffer.byteLength(headerLine, "utf-8"));
    repairCounts.set(filePath, (repairCounts.get(filePath) ?? 0) + 1);
    return;
  }

  seqCaches.set(filePath, scan.events.length ? (scan.events.at(-1)!.seq as number) : -1);
  healthySizes.set(filePath, scan.healthy_end_offset);
  if (tailDamage) {
    await fs.truncate(filePath, scan.healthy_end_offset);
    repairCounts.set(filePath, (repairCounts.get(filePath) ?? 0) + 1);
    console.warn(`[harness-events] truncated damaged tail (${scan.total_bytes - scan.healthy_end_offset} bytes) at ${filePath}`);
  }
}

// Tail damage can appear at any time (crash mid-write, foreign writer), long
// after the cached init promise resolved — re-scan whenever the file size no
// longer matches the last known healthy size.
async function syncIfTailChanged(filePath: string, workspaceRoot: string): Promise<void> {
  const expected = healthySizes.get(filePath);
  let size = -1;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {}
  if (size !== expected) {
    readyChains.delete(filePath);
    await getReady(filePath, workspaceRoot);
  }
}

function getReady(filePath: string, workspaceRoot: string): Promise<void> {
  const existing = readyChains.get(filePath);
  if (existing) return existing;
  const ready = ensureReady(filePath, workspaceRoot).catch((error) => {
    readyChains.delete(filePath);
    throw error;
  });
  readyChains.set(filePath, ready);
  return ready;
}

export async function appendHarnessEvent(workspaceRoot: string, input: HarnessEventInput): Promise<HarnessEvent> {
  const filePath = harnessEventLogPath(workspaceRoot);
  try {
    if (!EVENT_TYPES.has(input.type)) throw new Error(`unknown harness event type: ${input.type}`);
    assertJsonData(input.data, "data", new Set());

    await getReady(filePath, workspaceRoot);
    const previous = appendChains.get(filePath) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => gate);
    appendChains.set(filePath, chain);
    await previous.catch(() => undefined);
    try {
      await syncIfTailChanged(filePath, workspaceRoot);
      const seq = (seqCaches.get(filePath) ?? -1) + 1;
      const event: HarnessEvent = {
        type: input.type,
        seq,
        time: new Date().toISOString(),
        ...(input.task_id ? { task_id: input.task_id } : {}),
        ...(input.goal_id ? { goal_id: input.goal_id } : {}),
        ...(input.evidence_kind ? { evidence_kind: input.evidence_kind } : {}),
        ...(input.project_roots?.length ? { project_roots: input.project_roots.map((root) => path.resolve(root)) } : {}),
        ...(input.id ? { id: input.id } : {}),
        ...(input.causation_id ? { causation_id: input.causation_id } : {}),
        data: input.data,
      };
      const line = JSON.stringify(event);
      const bytes = Buffer.byteLength(line, "utf-8");
      if (bytes > MAX_EVENT_JSON_BYTES) {
        throw new Error(`harness event "${input.type}" is ${bytes} bytes, over the ${MAX_EVENT_JSON_BYTES} limit — slim the event data`);
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${line}\n`, "utf-8");
      seqCaches.set(filePath, seq);
      healthySizes.set(filePath, (healthySizes.get(filePath) ?? 0) + bytes + 1);
      return event;
    } finally {
      release();
      if (appendChains.get(filePath) === chain) appendChains.delete(filePath);
    }
  } catch (error) {
    const failure = writeFailures.get(filePath) ?? { count: 0, last_error: "", last_at: "" };
    failure.count += 1;
    failure.last_error = (error as Error).message;
    failure.last_at = new Date().toISOString();
    writeFailures.set(filePath, failure);
    console.warn(`[harness-events] append failed (#${failure.count}): ${failure.last_error}`);
    throw error;
  }
}

/**
 * Compatibility-mirror entry point: event logging must not break the proven
 * snapshot stores. Failures are counted (visible via getHarnessEventLogHealth),
 * never silent.
 */
export async function appendHarnessEventSafe(workspaceRoot: string, input: HarnessEventInput): Promise<void> {
  try {
    await appendHarnessEvent(workspaceRoot, input);
  } catch {}
}

export interface HarnessEventLogHealth {
  path: string;
  exists: boolean;
  format: "none" | "legacy" | "v2" | "error";
  header_version: number | null;
  events: number;
  last_seq: number;
  torn_tail: boolean;
  degraded: boolean;
  repairs: number;
  dropped_writes: number;
  last_write_error?: string;
  last_write_at?: string;
  error?: string;
}

export async function getHarnessEventLogHealth(workspaceRoot: string): Promise<HarnessEventLogHealth> {
  const filePath = harnessEventLogPath(workspaceRoot);
  const failures = writeFailures.get(filePath);
  const base: HarnessEventLogHealth = {
    path: filePath,
    exists: false,
    format: "none",
    header_version: null,
    events: 0,
    last_seq: -1,
    torn_tail: false,
    degraded: false,
    repairs: repairCounts.get(filePath) ?? 0,
    dropped_writes: failures?.count ?? 0,
    ...(failures?.last_error ? { last_write_error: failures.last_error, last_write_at: failures.last_at } : {}),
  };
  try {
    const scan = await scanLogFile(filePath);
    if (scan.format === "error") {
      return { ...base, exists: true, format: "error", error: scan.error };
    }
    return {
      ...base,
      exists: scan.format !== "none",
      format: scan.format,
      header_version: scan.header?.version ?? null,
      events: scan.events.length,
      last_seq: scan.events.length ? (scan.events.at(-1)!.seq as number) : -1,
      torn_tail: scan.torn_tail,
      degraded: scan.degraded,
    };
  } catch (error) {
    if (error instanceof HarnessLogFormatError) {
      return { ...base, exists: true, format: "error", error: error.message };
    }
    return { ...base, exists: true, format: "error", error: (error as Error).message };
  }
}

/**
 * Incremental tail read: returns every complete event line appended after
 * `fromOffset` (a byte offset previously returned here). Lenient by design —
 * damaged lines are skipped, contiguity is not enforced; the strict reader
 * (readHarnessEvents) remains the authority. `next_offset` always lands on a
 * line boundary; a shrunken log triggers one full rescan (reset=true).
 */
function parseTailBuffer(buf: Buffer, baseOffset: number, filePath: string): { events: HarnessEvent[]; next_offset: number } {
  const lastNewline = buf.lastIndexOf(10);
  if (lastNewline === -1) return { events: [], next_offset: baseOffset };
  const text = buf.subarray(0, lastNewline + 1).toString("utf-8");
  const events: HarnessEvent[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && parsed.kind === "harness-log") continue;
      events.push(validateEventLine(parsed, filePath));
    } catch {
      // Lenient: skip damaged or foreign lines; the tail is an optimization read.
    }
  }
  return { events, next_offset: baseOffset + lastNewline + 1 };
}

export async function readHarnessEventTail(
  workspaceRoot: string,
  fromOffset: number
): Promise<{ events: HarnessEvent[]; next_offset: number; reset: boolean }> {
  const filePath = harnessEventLogPath(workspaceRoot);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return { events: [], next_offset: 0, reset: fromOffset > 0 };
  }
  try {
    const stat = await handle.stat();
    if (fromOffset > stat.size) {
      // Log shrank (repair/quarantine) — one bounded full rescan.
      const full = Buffer.alloc(stat.size);
      if (stat.size > 0) await handle.read(full, 0, stat.size, 0);
      return { ...parseTailBuffer(full, 0, filePath), reset: true };
    }
    if (fromOffset === stat.size) return { events: [], next_offset: fromOffset, reset: false };
    // Read only the tail from the byte offset; UTF-8 continuation bytes never
    // equal 0x0A, so newline scanning stays multi-byte safe.
    const tail = Buffer.alloc(stat.size - fromOffset);
    await handle.read(tail, 0, tail.length, fromOffset);
    return { ...parseTailBuffer(tail, fromOffset, filePath), reset: false };
  } finally {
    await handle.close();
  }
}

/** Repair-generation counter: evidence windows reset when the log is rewritten. */
export function harnessRepairCount(workspaceRoot: string): number {
  return repairCounts.get(harnessEventLogPath(workspaceRoot)) ?? 0;
}

export interface ReadHarnessEventsOptions {
  limit?: number;
  type?: HarnessEventType;
  task_id?: string;
  goal_id?: string;
  project_root?: string;
  from_seq?: number;
}

export async function readHarnessEvents(
  workspaceRoot: string,
  options: ReadHarnessEventsOptions = {}
): Promise<HarnessEvent[]> {
  const filePath = harnessEventLogPath(workspaceRoot);
  const scan = await scanLogFile(filePath);
  if (scan.format === "error") return [];

  const projectRoot = options.project_root ? path.resolve(options.project_root) : undefined;
  const projectKey = projectRoot ? (process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot) : undefined;
  const events: HarnessEvent[] = [];
  for (const event of scan.events) {
    if (options.type && event.type !== options.type) continue;
    if (options.task_id && event.task_id !== options.task_id) continue;
    if (options.goal_id && event.goal_id !== options.goal_id) continue;
    if (options.from_seq !== undefined && (event.seq as number) < options.from_seq) continue;
    if (projectKey && !event.project_roots?.some((root) => {
      const resolved = path.resolve(root);
      return (process.platform === "win32" ? resolved.toLowerCase() : resolved) === projectKey;
    })) continue;
    events.push(event);
  }
  return events.slice(-Math.max(1, Math.min(options.limit ?? 100, 1000)));
}
