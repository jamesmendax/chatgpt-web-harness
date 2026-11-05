import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { toolFailureDiagnostic, type ToolFailureDiagnostic } from "./tool-diagnostics.js";
import { getMcpRequestIdentity } from "./mcp-request-identity.js";

export type McpRpcResultStatus = "success" | "error" | "unobserved";
export type McpToolResultStatus = "success" | "error" | "running" | "unknown" | "unobserved";

export interface McpOutcomeObservation {
  readonly rpc_result_status: McpRpcResultStatus;
  readonly tool_result_status: McpToolResultStatus;
  readonly client_delivery: "unknown";
  readonly invocation_id?: string;
  readonly observed_at?: string;
  readonly failure?: ToolFailureDiagnostic;
  readonly request_instance_id?: string;
  readonly runtime_instance_id?: string;
}

interface StoredObservation {
  readonly outcome: McpOutcomeObservation;
  readonly stored_at_ms: number;
}

const parsedMax = Number.parseInt(process.env.MCP_OUTCOME_MAX || "512", 10);
const MAX_OBSERVATIONS = Number.isFinite(parsedMax)
  ? Math.min(Math.max(parsedMax, 32), 4096)
  : 512;
const parsedTtl = Number.parseInt(process.env.MCP_OUTCOME_TTL_MS || "300000", 10);
const OUTCOME_TTL_MS = Number.isFinite(parsedTtl)
  ? Math.min(Math.max(parsedTtl, 10_000), 30 * 60_000)
  : 300_000;

const observations = new Map<string, StoredObservation[]>();
let observationCount = 0;

function observationKey(requestId: RequestId | undefined, tool: string, requestInstanceId?: string): string | undefined {
  if (requestId === undefined || requestId === null || !tool) return undefined;
  // RPC ids are only local to one request/transport. Never consume another
  // request's observation just because its RPC id and tool name are identical.
  const owner = requestInstanceId ?? getMcpRequestIdentity()?.requestInstanceId;
  if (!owner) return undefined;
  return JSON.stringify([owner, typeof requestId, requestId, tool]);
}

function prune(now = Date.now()): void {
  for (const [key, queue] of observations) {
    const fresh = queue.filter((entry) => now - entry.stored_at_ms <= OUTCOME_TTL_MS);
    observationCount -= queue.length - fresh.length;
    if (fresh.length > 0) observations.set(key, fresh);
    else observations.delete(key);
  }
  while (observationCount >= MAX_OBSERVATIONS) {
    const firstKey = observations.keys().next().value as string | undefined;
    if (!firstKey) break;
    const queue = observations.get(firstKey);
    if (!queue?.length) {
      observations.delete(firstKey);
      continue;
    }
    queue.shift();
    observationCount--;
    if (queue.length === 0) observations.delete(firstKey);
  }
}

function store(requestId: RequestId | undefined, tool: string, outcome: McpOutcomeObservation): void {
  const key = observationKey(requestId, tool);
  if (!key) return;
  const now = Date.now();
  prune(now);
  const queue = observations.get(key) ?? [];
  const identity = getMcpRequestIdentity();
  queue.push({ outcome: { ...outcome,
    request_instance_id: identity?.requestInstanceId,
    runtime_instance_id: identity?.runtimeInstanceId,
  }, stored_at_ms: now });
  observations.set(key, queue);
  observationCount++;
}

function classifyToolResult(result: CallToolResult): McpToolResultStatus {
  const payload = result.structuredContent?.data;
  if (payload && typeof payload === "object") {
    const kind = (payload as Record<string, unknown>).outcome_kind;
    if (kind === "running" || kind === "unknown") return kind;
  }
  if (result.isError === true) return "error";
  if (result.structuredContent && typeof result.structuredContent === "object") {
    const ok = (result.structuredContent as Record<string, unknown>).ok;
    if (typeof ok === "boolean") return ok ? "success" : "error";
  }
  return "success";
}

export function observeMcpToolResult(opts: {
  requestId?: RequestId;
  tool: string;
  invocationId: string;
  result: CallToolResult;
}): void {
  const failure = toolFailureDiagnostic(opts.result);
  store(opts.requestId, opts.tool, {
    rpc_result_status: "success",
    tool_result_status: classifyToolResult(opts.result),
    client_delivery: "unknown",
    invocation_id: opts.invocationId,
    observed_at: new Date().toISOString(),
    ...(failure ? { failure } : {}),
  });
}

export function observeMcpInvocationFailure(opts: {
  requestId?: RequestId;
  tool: string;
  invocationId: string;
  failure?: ToolFailureDiagnostic;
}): void {
  store(opts.requestId, opts.tool, {
    rpc_result_status: "error",
    tool_result_status: "error",
    client_delivery: "unknown",
    invocation_id: opts.invocationId,
    observed_at: new Date().toISOString(),
    ...(opts.failure ? { failure: opts.failure } : {}),
  });
}

export function consumeMcpOutcome(
  requestId: RequestId | undefined,
  tool: string | undefined,
  requestInstanceId?: string
): McpOutcomeObservation | undefined {
  if (!tool) return undefined;
  const key = observationKey(requestId, tool, requestInstanceId);
  if (!key) return undefined;
  prune();
  const queue = observations.get(key);
  const stored = queue?.shift();
  if (!stored) return undefined;
  observationCount--;
  if (queue?.length === 0) observations.delete(key);
  return stored.outcome;
}

export function getMcpOutcomeStoreStats(): { keys: number; observations: number; max: number; ttl_ms: number } {
  prune();
  return { keys: observations.size, observations: observationCount, max: MAX_OBSERVATIONS, ttl_ms: OUTCOME_TTL_MS };
}
