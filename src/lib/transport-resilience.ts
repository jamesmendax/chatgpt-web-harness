import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InvocationContext } from "./invocation-gateway.js";

// Budget the serialized MCP result, including text/structured duplication and
// Base64 image data. 6 MiB leaves room for the tunnel envelope and its encoding
// below the 10 MiB rejection observed in the deployed control plane.
export const MAX_SERIALIZED_RESULT_BYTES = 6 * 1024 * 1024;
export const DEFAULT_SYNC_COMMAND_MS = 90_000;
export const RESPONSE_RESERVE_MS = 15_000;
let synchronousQueue: Promise<unknown> = Promise.resolve();

// A queue timeout must not allow a command to execute later, after its caller
// has gone away. Only queue waiting is rejected here; the operation receives
// the remaining budget and owns cancellation of its own child process.
export function withSynchronousCommandSlot<T>(operation: (remainingMs: number) => Promise<T>, budgetMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted || budgetMs <= 0) return Promise.reject(new Error("COMMAND_NOT_STARTED: no execution budget"));
  const started = performance.now();
  let cancelled = false;
  let entered = false;
  let timer: ReturnType<typeof setTimeout>;
  let rejectWait: (reason: Error) => void = () => {};
  const abort = () => {
    if (entered) return;
    cancelled = true;
    rejectWait(new Error("COMMAND_NOT_STARTED: queue cancelled or budget expired"));
  };
  const waiting = new Promise<never>((_resolve, reject) => {
    rejectWait = reject;
    timer = setTimeout(abort, budgetMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
  const execution = synchronousQueue.catch(() => {}).then(async () => {
    const remaining = Math.floor(budgetMs - (performance.now() - started));
    if (cancelled || signal?.aborted || remaining <= 0) throw new Error("COMMAND_NOT_STARTED: queue cancelled or budget expired");
    entered = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    return operation(remaining);
  });
  synchronousQueue = execution.catch(() => {});
  return Promise.race([execution, waiting]).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  });
}
const MIN_RESULT_BUDGET = 16 * 1024;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const journalQueues = new Map<string, Promise<void>>();

export function resultByteBudget(): number {
  const value = Number(process.env.MCP_RESULT_MAX_BYTES);
  return Number.isFinite(value) && value >= MIN_RESULT_BUDGET
    ? Math.min(MAX_SERIALIZED_RESULT_BYTES, Math.floor(value))
    : MAX_SERIALIZED_RESULT_BYTES;
}

export function synchronousCommandBudget(configuredMs: number, deadlineAt?: number, now = Date.now()): number {
  const configured = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : DEFAULT_SYNC_COMMAND_MS;
  const remaining = deadlineAt === undefined ? Infinity : deadlineAt - now - RESPONSE_RESERVE_MS;
  return Math.max(0, Math.floor(Math.min(configured, DEFAULT_SYNC_COMMAND_MS, remaining)));
}

export function resilienceDirectory(workspaceRoot: string): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const slug = createHash("sha256").update(path.resolve(workspaceRoot).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(home, "transport-resilience", slug);
}

// No arguments, tool output, credentials, headers or raw exception messages in
// telemetry. Serialize rotation per workspace; retain only current + one old log.
export async function recordTransportEvent(workspaceRoot: string, event: Record<string, unknown>): Promise<void> {
  const dir = resilienceDirectory(workspaceRoot);
  const previous = journalQueues.get(dir) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "events.jsonl");
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size >= MAX_JOURNAL_BYTES) {
      await fs.rm(file + ".1", { force: true });
      await fs.rename(file, file + ".1");
    }
    await fs.appendFile(file, JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  }).catch(() => { /* Diagnostics cannot fail a successful operation. */ });
  journalQueues.set(dir, next);
  await next;
  if (journalQueues.get(dir) === next) journalQueues.delete(dir);
}

function compactDuplicateText(result: CallToolResult): CallToolResult {
  const structured = result.structuredContent;
  if (!structured || typeof structured.tool !== "string" || typeof structured.ok !== "boolean") return result;
  const expected = JSON.stringify(structured, null, 2);
  if (Buffer.byteLength(expected, "utf8") < 64 * 1024) return result;
  // Only compact the known, exact duplicate of our own envelope. Never discard
  // upstream/proxy text, image blocks, annotations, resources or arbitrary data.
  let changed = false;
  const content = result.content.map((item) => {
    if (item.type !== "text" || item.text !== expected) return item;
    changed = true;
    return { ...item, text: JSON.stringify({ ok: structured.ok, tool: structured.tool,
      summary: structured.summary, data: { full_result_in: "structuredContent", duplicate_text_omitted: true } }) };
  });
  return changed ? { ...result, content } : result;
}

// Spilled results are each over 6 MiB and were never deleted. The model reads
// them right after the call; keep a week, and at most the newest 40.
const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SPILL_MAX_FILES = 40;
async function pruneSpilledResults(dir: string): Promise<void> {
  try {
    const now = Date.now();
    const files = (await Promise.all((await fs.readdir(dir)).filter((name) => name.endsWith(".json"))
      .map(async (name) => ({ file: path.join(dir, name), mtime: (await fs.stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 }))))
      .sort((a, b) => b.mtime - a.mtime);
    for (const [index, entry] of files.entries()) {
      if (index >= SPILL_MAX_FILES - 1 || now - entry.mtime > SPILL_RETENTION_MS) await fs.rm(entry.file, { force: true }).catch(() => undefined);
    }
  } catch { /* pruning never blocks the spill */ }
}

export interface GuardOptions {
  budget?: number;
  stage?: "handler" | "wire";
  compactDuplicates?: boolean;
}

export async function guardToolResult(context: InvocationContext, input: CallToolResult, options: GuardOptions = {}): Promise<CallToolResult> {
  const budget = Math.min(MAX_SERIALIZED_RESULT_BYTES, Math.max(MIN_RESULT_BUDGET, options.budget ?? resultByteBudget()));
  const stage = options.stage || "wire";
  let result = input;
  let serialized: string;
  try {
    result = options.compactDuplicates ? compactDuplicateText(input) : input;
    serialized = JSON.stringify(result);
  }
  catch {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false,
      tool: context.definition.name, error: "RESULT_SERIALIZATION_FAILED",
      operation_may_have_completed: true, action: "Inspect task state and artifacts before retrying any side effect." }) }] };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  const common = { invocation_id: context.scope.invocationId, tool: context.definition.name,
    session_id: context.scope.mcpSessionId ?? null, request_id: context.scope.requestId ?? null,
    stage, result_bytes: bytes, budget_bytes: budget, duplicated_text_compacted: result !== input,
    deadline_known: context.scope.deadlineAt !== undefined,
    deadline_remaining_ms: context.scope.deadlineAt === undefined ? null : Math.max(0, context.scope.deadlineAt - Date.now()),
    aborted: context.scope.signal?.aborted ?? false };
  if (bytes <= budget) {
    if (stage === "wire") await recordTransportEvent(context.scope.workspaceRoot, { ...common, outcome: result.isError ? "tool_error" : "returned_to_mcp" });
    return result;
  }
  const dir = path.join(resilienceDirectory(context.scope.workspaceRoot), "results");
  const file = path.join(dir, randomUUID() + ".json");
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  let saved = false;
  try {
    await fs.mkdir(dir, { recursive: true });
    await pruneSpilledResults(dir);
    await fs.writeFile(file, serialized, { flag: "wx", mode: 0o600 });
    saved = true;
  } catch { /* Never claim that a failed spill is recoverable from this file. */ }
  await recordTransportEvent(context.scope.workspaceRoot, { ...common, outcome: "oversize_result_blocked", spill_saved: saved, sha256 });
  const payload = { ok: false, tool: context.definition.name,
    summary: "Tool executed, but its result exceeded the safe transport budget. Do not repeat side effects.",
    data: { error: "RESULT_PAYLOAD_TOO_LARGE", operation_may_have_completed: true,
      original_is_error: input.isError === true, serialized_bytes: bytes, budget_bytes: budget,
      spill_saved: saved, ...(saved ? { full_output_path: file, sha256 } : {}),
      next_action: saved ? "Use bounded reads of full_output_path, or inspect original artifact paths. For images, return smaller previews and complete all required visual coverage. Do not confirm acceptance from this placeholder." : "Spill failed. Inspect existing task records and artifacts; do not blindly rerun a mutating tool.",
      verifies_criterion: false } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
