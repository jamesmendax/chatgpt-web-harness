import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { accountProjectDir } from "./account-project-scope.js";
import { BoundedContextCache, boundedCacheEnv } from "./bounded-context-cache.js";

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
  event_count: number;
  last_seq: number;
  healthy_end_offset: number;
  total_bytes: number;
  torn_tail: boolean;
  degraded: boolean;
  ends_with_newline: boolean;
  error?: string;
}

const readyChains = new Map<string, Promise<LogState>>();
const appendChains = new Map<string, Promise<void>>();
const logCacheCapacity = () => boundedCacheEnv("HARNESS_EVENT_CACHE_MAX_ENTRIES", 128, 1, 4096);
const logCacheIdleMs = () => boundedCacheEnv("HARNESS_EVENT_CACHE_IDLE_MS", 30 * 60_000, 1, 7 * 24 * 60 * 60_000);
interface LogState {
  ready: boolean;
  seq: number;
  healthySize: number;
  repairs: number;
  generation: number;
  failure?: { count: number; last_error: string; last_at: string };
}
const logStates = new BoundedContextCache<LogState>(logCacheCapacity, logCacheIdleMs);
let repairGeneration = 0;
function logState(filePath: string): LogState {
  let state = logStates.get(filePath);
  if (!state) {
    state = { ready: false, seq: -1, healthySize: -1, repairs: 0, generation: 0 };
    logStates.set(filePath, state);
  }
  return state;
}

// File size never controls an allocation. Even damaged lines are streamed to
// their boundary without retaining their bytes. UTF-8 is decoded after joining
// a complete bounded line, so characters split across IO chunks stay intact.
const LOG_READ_CHUNK_BYTES = 32 * 1024;
const MAX_LOG_LINE_BYTES = MAX_EVENT_JSON_BYTES + 1024;
interface LogLine { bytes: Buffer; end: number; terminated: boolean; oversized: boolean }
async function* logLines(
  handle: Awaited<ReturnType<typeof fs.open>>, start: number, end: number
): AsyncGenerator<LogLine> {
  const chunk = Buffer.alloc(LOG_READ_CHUNK_BYTES);
  const line = Buffer.alloc(MAX_LOG_LINE_BYTES);
  let position = start;
  let length = 0;
  let oversized = false;
  while (position < end) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - position), position);
    if (!bytesRead) break;
    let cursor = 0;
    while (cursor < bytesRead) {
      const found = chunk.indexOf(10, cursor);
      const newline = found >= 0 && found < bytesRead ? found : -1;
      const stop = newline < 0 ? bytesRead : newline;
      const count = stop - cursor;
      if (!oversized && length + count <= line.length) {
        chunk.copy(line, length, cursor, stop);
        length += count;
      } else oversized = true;
      if (newline >= 0) {
        yield { bytes: line.subarray(0, length), end: position + newline + 1, terminated: true, oversized };
        length = 0;
        oversized = false;
        cursor = newline + 1;
      } else cursor = bytesRead;
    }
    position += bytesRead;
  }
  if (length || oversized) yield { bytes: line.subarray(0, length), end: position, terminated: false, oversized };
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function harnessEventLogPath(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(accountProjectDir(path.join(base, "projects", projectSlug(workspaceRoot))), "harness-events.jsonl");
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

async function scanLogFile(filePath: string, onEvent?: (event: HarnessEvent) => void | Promise<void>): Promise<ScanResult> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { format: "none", header: null, event_count: 0, last_seq: -1, healthy_end_offset: 0, total_bytes: 0, torn_tail: false, degraded: false, ends_with_newline: false };
    }
    return {
      format: "error",
      header: null,
      event_count: 0,
      last_seq: -1,
      healthy_end_offset: 0,
      total_bytes: 0,
      torn_tail: false,
      degraded: false,
      ends_with_newline: false,
      error: `${code ?? "ERROR"}: ${(error as Error).message}`,
    };
  }

  try {
  const totalBytes = (await handle.stat()).size;
  let healthyEnd = 0;
  let eventCount = 0;
  let tornTail = false;
  let degraded = false;
  let header: HarnessLogHeader | null = null;
  let format: "legacy" | "v2" = "legacy";
  let expectedSeq = 0;
  let firstLine = true;
  let endsWithNewline = false;

  const fail = (message: string, isLast: boolean): void => {
    if (isLast) tornTail = true;
    else degraded = true;
    void message;
  };

  for await (const line of logLines(handle, 0, totalBytes)) {
    const isLast = !line.terminated;
    endsWithNewline = line.terminated;
    if (line.oversized) throw new HarnessLogFormatError(filePath,
      `log line exceeds the ${MAX_LOG_LINE_BYTES}-byte bounded reader limit; this may be a valid legacy line, so the log is left untouched`);
    const raw = line.bytes.toString("utf-8").trim();

    if (!raw) continue;
    if (firstLine) {
      firstLine = false;
      try {
        const probe = JSON.parse(raw) as Record<string, unknown>;
        if (probe && typeof probe === "object" && probe.kind === "harness-log") {
          header = parseHeaderLine(raw, filePath);
          format = "v2";
          healthyEnd = line.end;
          continue;
        }
      } catch (error) {
        if (error instanceof HarnessLogFormatError) throw error;
      }
    }

    let accepted: HarnessEvent;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const event = format === "v2" ? validateEventLine(parsed, filePath) : convertLegacyEvent(parsed);
      if ((event.seq as number) !== expectedSeq) {
        fail(`seq gap at ${event.seq} (expected ${expectedSeq})`, isLast);
        break;
      }
      expectedSeq = (event.seq as number) + 1;
      eventCount++;
      healthyEnd = line.end;
      accepted = event;
    } catch (error) {
      if (error instanceof HarnessLogFormatError) throw error;
      fail((error as Error).message, isLast);
      break;
    }
    if (onEvent) await onEvent(accepted!);
  }

  return {
    format,
    header,
    event_count: eventCount,
    last_seq: expectedSeq - 1,
    healthy_end_offset: healthyEnd,
    total_bytes: totalBytes,
    torn_tail: tornTail,
    degraded,
    ends_with_newline: endsWithNewline,
  };
  } finally { await handle.close(); }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf-8");
  await fs.rename(temp, filePath);
}

function noteRepair(state: LogState): void {
  state.repairs++;
  state.generation = ++repairGeneration;
}

async function preserveDamagedTail(filePath: string, from: number, end: number): Promise<void> {
  const archive = `${filePath}.tail-${Date.now()}-${randomUUID()}`;
  const source = await fs.open(filePath, "r");
  let target: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    target = await fs.open(archive, "wx");
    const chunk = Buffer.alloc(LOG_READ_CHUNK_BYTES);
    let offset = from;
    while (offset < end) {
      const { bytesRead } = await source.read(chunk, 0, Math.min(chunk.length, end - offset), offset);
      if (!bytesRead) throw new Error("log changed while preserving damaged tail");
      await target.writeFile(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await source.close();
    await target?.close();
  }
}

async function migrateLegacyLog(filePath: string, workspaceRoot: string, preserveOriginal: boolean): Promise<number> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  const target = await fs.open(temporary, "wx");
  let bytes = 0;
  const write = async (line: string): Promise<void> => {
    await target.writeFile(line, "utf-8");
    bytes += Buffer.byteLength(line, "utf-8");
  };
  try {
    await write(`${JSON.stringify(makeHeader(workspaceRoot))}\n`);
    await scanLogFile(filePath, async event => { await write(`${JSON.stringify(event)}\n`); });
    await target.close();
    if (preserveOriginal) await fs.copyFile(filePath, `${filePath}.legacy-damaged-${Date.now()}-${randomUUID()}`);
    await fs.rename(temporary, filePath);
    return bytes;
  } catch (error) {
    await target.close().catch(() => undefined);
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function makeHeader(workspaceRoot: string): HarnessLogHeader {
  return {
    kind: "harness-log",
    version: HARNESS_LOG_VERSION,
    workspace_root: path.resolve(workspaceRoot),
    created_at: new Date().toISOString(),
  };
}

async function ensureReady(filePath: string, workspaceRoot: string): Promise<LogState> {
  const state = logState(filePath);
  const scan = await scanLogFile(filePath);
  if (scan.format === "error") throw new Error(`harness event log unreadable: ${scan.error}`);

  if (scan.format === "none") {
    const headerLine = `${JSON.stringify(makeHeader(workspaceRoot))}\n`;
    await atomicWrite(filePath, headerLine);
    state.seq = -1;
    state.healthySize = Buffer.byteLength(headerLine, "utf-8");
    state.ready = true;
    return state;
  }

  const tailDamage = scan.torn_tail || scan.degraded || scan.healthy_end_offset < scan.total_bytes;
  if (scan.format === "legacy") {
    const migratedBytes = await migrateLegacyLog(filePath, workspaceRoot, tailDamage);
    if (scan.event_count) {
      console.warn(`[harness-events] migrated legacy log to v${HARNESS_LOG_VERSION}: ${scan.event_count} event(s) at ${filePath}`);
    }
    noteRepair(state);
    state.seq = scan.last_seq;
    state.healthySize = migratedBytes;
    state.ready = true;
    return state;
  }

  if (scan.degraded) {
    // Mid-file structural damage: truncating would silently delete every
    // possibly-valid event after the gap. Quarantine the whole file for
    // forensics and start a fresh log instead.
    const quarantined = `${filePath}.corrupt-${Date.now()}-${randomUUID()}`;
    await fs.rename(filePath, quarantined);
    console.warn(`[harness-events] mid-file damage: log quarantined to ${quarantined}; starting fresh`);
    const headerLine = `${JSON.stringify(makeHeader(workspaceRoot))}\n`;
    await atomicWrite(filePath, headerLine);
    state.seq = -1;
    state.healthySize = Buffer.byteLength(headerLine, "utf-8");
    noteRepair(state);
    state.ready = true;
    return state;
  }

  state.seq = scan.last_seq;
  state.healthySize = scan.healthy_end_offset;
  if (tailDamage) {
    await preserveDamagedTail(filePath, scan.healthy_end_offset, scan.total_bytes);
    await fs.truncate(filePath, scan.healthy_end_offset);
    noteRepair(state);
    console.warn(`[harness-events] truncated damaged tail (${scan.total_bytes - scan.healthy_end_offset} bytes) at ${filePath}`);
  }
  if (!tailDamage && scan.total_bytes > 0 && !scan.ends_with_newline) {
    await fs.appendFile(filePath, "\n", "utf-8");
    state.healthySize++;
  }
  state.ready = true;
  return state;
}

// Tail damage can appear at any time (crash mid-write, foreign writer), long
// after the cached init promise resolved — re-scan whenever the file size no
// longer matches the last known healthy size.
async function syncIfTailChanged(filePath: string, workspaceRoot: string): Promise<LogState> {
  const state = logState(filePath);
  const expected = state.healthySize;
  let size = -1;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {}
  if (!state.ready || size !== expected) {
    state.ready = false;
    return getReady(filePath, workspaceRoot);
  }
  return state;
}

function getReady(filePath: string, workspaceRoot: string): Promise<LogState> {
  const existing = readyChains.get(filePath);
  if (existing) return existing;
  const state = logStates.get(filePath);
  if (state?.ready) return Promise.resolve(state);
  const ready = ensureReady(filePath, workspaceRoot).finally(() => {
    if (readyChains.get(filePath) === ready) readyChains.delete(filePath);
  });
  readyChains.set(filePath, ready);
  return ready;
}

export async function appendHarnessEvent(workspaceRoot: string, input: HarnessEventInput): Promise<HarnessEvent> {
  const filePath = harnessEventLogPath(workspaceRoot);
  try {
    if (!EVENT_TYPES.has(input.type)) throw new Error(`unknown harness event type: ${input.type}`);
    assertJsonData(input.data, "data", new Set());

    const previous = appendChains.get(filePath) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const chain = previous.catch(() => undefined).then(() => gate);
    appendChains.set(filePath, chain);
    await previous.catch(() => undefined);
    try {
      const state = await syncIfTailChanged(filePath, workspaceRoot);
      const seq = state.seq + 1;
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
      state.seq = seq;
      state.healthySize += bytes + 1;
      return event;
    } finally {
      release();
      if (appendChains.get(filePath) === chain) appendChains.delete(filePath);
    }
  } catch (error) {
    const state = logState(filePath);
    const failure = state.failure ?? { count: 0, last_error: "", last_at: "" };
    failure.count += 1;
    failure.last_error = (error as Error).message;
    failure.last_at = new Date().toISOString();
    state.failure = failure;
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
  const state = logStates.get(filePath);
  const failures = state?.failure;
  const base: HarnessEventLogHealth = {
    path: filePath,
    exists: false,
    format: "none",
    header_version: null,
    events: 0,
    last_seq: -1,
    torn_tail: false,
    degraded: false,
    repairs: state?.repairs ?? 0,
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
      events: scan.event_count,
      last_seq: scan.last_seq,
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
 * Incremental tail read: streams complete lines after `fromOffset`, retaining
 * only the requested last matching window (1000 maximum). Lenient by design —
 * damaged lines are skipped, contiguity is not enforced; the strict reader
 * (readHarnessEvents) remains the authority. `next_offset` always lands on a
 * line boundary; a shrunken/replaced log triggers a streaming rescan (reset=true).
 */
export async function readHarnessEventTail(
  workspaceRoot: string,
  fromOffset: number,
  options: ReadHarnessEventsOptions & { file_identity?: string } = {}
): Promise<{ events: HarnessEvent[]; next_offset: number; reset: boolean; file_identity?: string; matched_events: number; windowed: boolean; oversized_lines: number }> {
  const filePath = harnessEventLogPath(workspaceRoot);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return { events: [], next_offset: 0, reset: fromOffset > 0, matched_events: 0, windowed: false, oversized_lines: 0 };
  }
  try {
    const stat = await handle.stat();
    const fileIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    const reset = !Number.isSafeInteger(fromOffset) || fromOffset < 0 || fromOffset > stat.size ||
      Boolean(options.file_identity && options.file_identity !== fileIdentity);
    const start = reset ? 0 : fromOffset;
    let nextOffset = start;
    let matched = 0;
    let oversized = 0;
    const events: HarnessEvent[] = [];
    const matches = eventMatcher(options);
    const limit = eventLimit(options.limit ?? 1000);
    for await (const line of logLines(handle, start, stat.size)) {
      if (!line.terminated) break;
      nextOffset = line.end;
      if (line.oversized) { oversized++; continue; }
      const raw = line.bytes.toString("utf-8").trim();
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed?.kind === "harness-log") continue;
        const event = validateEventLine(parsed, filePath);
        if (!matches(event)) continue;
        matched++;
        if (events.length === limit) events.shift();
        events.push(event);
      } catch {
        // Lenient optimization; strict scan remains the history authority.
      }
    }
    return { events, next_offset: nextOffset, reset, file_identity: fileIdentity, matched_events: matched, windowed: matched > limit, oversized_lines: oversized };
  } finally {
    await handle.close();
  }
}

/** Repair-generation counter: evidence windows reset when the log is rewritten. */
export function harnessRepairCount(workspaceRoot: string): number {
  return logStates.get(harnessEventLogPath(workspaceRoot))?.generation ?? 0;
}

export interface ReadHarnessEventsOptions {
  limit?: number;
  type?: HarnessEventType;
  task_id?: string;
  goal_id?: string;
  project_root?: string;
  from_seq?: number;
  require_evidence_kind?: boolean;
}

function eventLimit(limit?: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit!), 1000)) : 100;
}

function eventMatcher(options: ReadHarnessEventsOptions): (event: HarnessEvent) => boolean {
  const projectRoot = options.project_root ? path.resolve(options.project_root) : undefined;
  const projectKey = projectRoot ? (process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot) : undefined;
  return event => {
    if (options.type && event.type !== options.type) return false;
    if (options.task_id && event.task_id !== options.task_id) return false;
    if (options.goal_id && event.goal_id !== options.goal_id) return false;
    if (options.from_seq !== undefined && event.seq < options.from_seq) return false;
    if (options.require_evidence_kind && !event.evidence_kind) return false;
    if (projectKey && !event.project_roots?.some(root => {
      const resolved = path.resolve(root);
      return (process.platform === "win32" ? resolved.toLowerCase() : resolved) === projectKey;
    })) return false;
    return true;
  };
}

export async function readHarnessEvents(
  workspaceRoot: string,
  options: ReadHarnessEventsOptions = {}
): Promise<HarnessEvent[]> {
  const filePath = harnessEventLogPath(workspaceRoot);
  const events: HarnessEvent[] = [];
  const matches = eventMatcher(options);
  const limit = eventLimit(options.limit);
  const scan = await scanLogFile(filePath, event => {
    if (!matches(event)) return;
    if (events.length === limit) events.shift();
    events.push(event);
  });
  return scan.format === "error" ? [] : events;
}
