import { getRuntimeScope } from "./runtime-scope.js";
import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import { getAuditPath } from "./audit-path.js";
import type { McpOutcomeObservation } from "./mcp-outcome.js";
import { redactSensitiveText, toolDiagnosticTokens } from "./tool-diagnostics.js";
export { redactSensitiveText } from "./tool-diagnostics.js";
import { getMcpRequestIdentity, resolveMcpConversationIdentity } from "./mcp-request-identity.js";

export type ActivityKind = "tool" | "mcp" | "session" | "system";

export interface ActivityEntry {
  id: string;
  time: string;
  kind: ActivityKind;
  tool?: string;
  action?: string;
  target?: string;
  status?: string;
  duration_ms?: number;
  /** Transport MCP session (Mcp-Session-Id); ChatGPT may re-create it between calls. */
  session_id?: string;
  /** ChatGPT conversation (`oai_conv_…` derived from `openai/session`); absent when the host sent none. */
  conversation_id?: string;
  client?: string;
  summary?: string;
  details?: Record<string, unknown>;
}

const parsedMaxEntries = Number.parseInt(process.env.ACTIVITY_LOG_MAX || "500", 10);
const MAX_ENTRIES = Number.isFinite(parsedMaxEntries)
  ? Math.min(Math.max(parsedMaxEntries, 50), 5000)
  : 500;
const entries: ActivityEntry[] = [];
const listeners = new Set<(entry: ActivityEntry) => void>();

function trimSummary(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

export function summarizeToolArgs(tool: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  if (tool === "run_command" && typeof a.command === "string") {
    return trimSummary(redactSensitiveText(a.command), 120);
  }
  if (typeof a.path === "string") return a.path;
  if (typeof a.server_id === "string" && typeof a.tool === "string") {
    return `${a.server_id} → ${a.tool}`;
  }
  if (typeof a.pattern === "string") return `pattern: ${a.pattern}`;
  if (typeof a.checkpoint_id === "string") return `checkpoint: ${a.checkpoint_id}`;
  if (typeof a.action === "string") return `action: ${a.action}`;

  const keys = Object.keys(a).slice(0, 12);
  return keys.length ? `args: ${keys.join(", ")}` : "";
}

/** Optional user-visible task label, never a copy of arbitrary tool arguments. */
export function conversationTaskTitleHint(tool: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = args as Record<string, unknown>;
  const permitted = tool === "task_create" ||
    ((tool === "task_state" || tool === "goal") && value.action === "create");
  if (!permitted) return undefined;
  const candidate = tool === "goal" ? value.objective : value.goal;
  if (typeof candidate !== "string" || candidate.length > 4000) return undefined;
  const first = candidate.split(/[\n\r]/)[0].normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  if (first.length < 3 || /(?:api[_-]?key|bearer|token|password|secret|密钥|密码)\s*[:=]|https?:\/\/|[A-Za-z]:\\|sk-[a-z0-9]{12,}|@/i.test(first)) return undefined;
  return [...first.replace(/\s+/g, " ")].slice(0, 40).join("");
}

/**
 * Conversation attribution for activity entries. Only the documented ChatGPT
 * conversation identity (`openai/session` request-body metadata) qualifies. The
 * legacy workflow id and transport sessions are left out, so a call without it
 * stays unattributed instead of being pinned to the wrong conversation.
 */
export function activityConversationId(
  body: unknown,
  headers?: Record<string, string | string[] | undefined>
): string | undefined {
  const params = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { params?: { _meta?: unknown } }).params
    : undefined;
  const id = resolveMcpConversationIdentity(params?._meta).conversationSessionId;
  return id?.startsWith("oai_conv_") ? id : undefined;
}

/** Short form shown in log lines (`conv=` + 8 hex); the Desktop feed uses the same rule. */
function shortConversationId(id: string): string {
  return id.replace(/^oai_conv_/, "").slice(0, 8);
}

export function appendActivity(partial: Omit<ActivityEntry, "id" | "time"> & { time?: string }): ActivityEntry {
  const scope = getRuntimeScope();
  const request = getMcpRequestIdentity();
  const scopedDetail = partial.kind === "tool" && scope && !partial.details?.canonical_lifecycle;
  const entry: ActivityEntry = {
    id: randomUUID(),
    time: partial.time ?? new Date().toISOString(),
    ...partial,
    details: {
      runtime_instance_id: scope?.runtimeInstanceId ?? request?.runtimeInstanceId,
      request_instance_id: scope?.requestInstanceId ?? request?.requestInstanceId,
      conversation_continuity: scope?.conversationContinuity ?? request?.continuity ?? "unknown",
      conversation_source: scope?.conversationContinuity === "trusted" ? "openai/session" : request?.source ?? "none",
      ...(scope?.principalId ? { account_id: scope.principalId } : {}),
      ...(scope?.requestId !== undefined ? { rpc_request_id: scope.requestId } : {}),
      ...partial.details,
    },
    ...(scopedDetail ? { details: { ...partial.details,
      runtime_instance_id: scope?.runtimeInstanceId ?? request?.runtimeInstanceId,
      request_instance_id: scope?.requestInstanceId ?? request?.requestInstanceId,
      conversation_continuity: scope?.conversationContinuity ?? request?.continuity ?? "unknown",
      conversation_source: scope?.conversationContinuity === "trusted" ? "openai/session" : request?.source ?? "none",
      account_id: scope.principalId,
      rpc_request_id: scope.requestId,
      invocation_id: scope.invocationId, lifecycle_detail: true } } : {}),
  };

  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();

  writeConsole(entry);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {}
  }
  return entry;
}

export function subscribeActivity(listener: (entry: ActivityEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentActivity(limit = 100, sinceId?: string): ActivityEntry[] {
  const capped = Math.min(Math.max(limit, 1), MAX_ENTRIES);
  if (!sinceId) return [...entries].slice(-capped).reverse();
  const idx = entries.findIndex((e) => e.id === sinceId);
  if (idx < 0) return [...entries].slice(-capped).reverse();
  return entries.slice(idx + 1).reverse();
}

function writeConsole(entry: ActivityEntry): void {
  // conv= is always the last token, so summary text cannot imitate it.
  const sid = (entry.session_id ? ` session=${entry.session_id.slice(0, 8)}` : "") +
    (entry.conversation_id ? ` conv=${shortConversationId(entry.conversation_id)}` : "");
  const call = typeof entry.details?.invocation_id === "string" ? ` call=${entry.details.invocation_id}` : "";
  const diagnostic = toolDiagnosticTokens(entry.details);
  if (entry.kind === "tool" && entry.details?.lifecycle_detail) {
    console.log(`[TOOL DETAIL] ${entry.tool || "unknown"}${call}${sid}`);
    return;
  }
  if (entry.kind === "tool" && entry.details?.canonical_lifecycle) {
    console.log(`[TOOL] [${entry.status}] ${entry.tool} — ${entry.summary} ${entry.duration_ms}ms${diagnostic}${call}${sid}`);
    return;
  }
  const dur = entry.duration_ms != null ? ` ${entry.duration_ms}ms` : "";
  const isError = entry.status === "error" || entry.status === "blocked";

  if (isError) {
    const label =
      entry.tool ? `tools/call ${entry.tool}` : entry.action || entry.kind || "mcp";
    const detail = entry.summary || entry.target || "";
    const http = entry.details?.http_status != null ? ` HTTP ${entry.details.http_status}` : "";
    console.warn(
      `[MCP ERROR]${http} ${label}${detail ? ` — ${detail}` : ""}${dur}${diagnostic}${call}${sid}`
    );
    return;
  }

  const status = entry.status ? ` [${entry.status}]` : "";

  if (entry.kind === "tool" && entry.tool) {
    const extra = entry.summary || entry.target || "";
    console.log(`[TOOL]${status} ${entry.tool}${extra ? ` — ${extra}` : ""}${dur}${call}${sid}`);
    return;
  }

  if (entry.kind === "mcp") {
    const label = entry.tool ? `tools/call ${entry.tool}` : entry.action || "request";
    const extra = entry.summary ? ` — ${entry.summary}` : "";
    const discovery =
      entry.action === "tools/list" && entry.details?.tool_count != null
        ? ` (${entry.details.tool_count} tools)`
        : "";
    console.log(`[MCP]${status} ${label}${discovery}${extra}${dur}${diagnostic}${call}${sid}`);
    return;
  }

  if (entry.kind === "session") {
    const extra = entry.summary ? ` — ${entry.summary}` : "";
    console.log(`[MCP] session ${entry.action || "event"}${extra}${sid}`);
    return;
  }
}

export async function loadAuditHistory(limit = 80): Promise<ActivityEntry[]> {
  const auditPath = getAuditPath();
  try {
    // Read only the tail: this used to load the whole, ever-growing file to
    // return the last 80 lines.
    const handle = await fs.open(auditPath, "r");
    let raw: string;
    try {
      const size = (await handle.stat()).size;
      const length = Math.min(size, Math.max(64 * 1024, limit * 4096));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      raw = buffer.subarray(0, bytesRead).toString("utf8");
      if (length < size) raw = raw.slice(raw.indexOf("\n") + 1);
    } finally { await handle.close(); }
    const lines = raw.trim().split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((line) => {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        return {
          id: randomUUID(),
          time: String(rec.time || new Date().toISOString()),
          kind: "tool" as const,
          tool: String(rec.tool || "unknown"),
          action: String(rec.action || ""),
          target: rec.target ? String(rec.target) : undefined,
          status: rec.status ? String(rec.status) : undefined,
          details: rec.details as Record<string, unknown> | undefined,
          summary: rec.target ? String(rec.target) : undefined,
        };
      } catch {
        return {
          id: randomUUID(),
          time: new Date().toISOString(),
          kind: "system" as const,
          summary: line.slice(0, 200),
        };
      }
    }).reverse();
  } catch {
    return [];
  }
}

export function logMcpHttpEvent(opts: {
  method: string;
  path: string;
  httpStatus: number;
  durationMs: number;
  sessionId?: string;
  rpcMethod?: string;
  tool?: string;
  errorMessage?: string;
  summary?: string;
}): void {
  const transportStatus = opts.httpStatus >= 400 ? "http_error" : "http_success";
  const requestErrorObserved = Boolean(opts.errorMessage);
  const status = transportStatus === "http_error" || requestErrorObserved ? "error" : "transport_ok";
  const rawSummary =
    opts.errorMessage ||
    opts.summary ||
    (transportStatus === "http_error" ? `HTTP ${opts.httpStatus}` : undefined);
  const summary = rawSummary ? trimSummary(redactSensitiveText(rawSummary)) : undefined;

  appendActivity({
    kind: opts.rpcMethod === "initialize" ? "session" : "mcp",
    tool: opts.tool,
    action: opts.rpcMethod || `${opts.method} ${opts.path}`,
    session_id: opts.sessionId,
    client: "chatgpt",
    status,
    duration_ms: opts.durationMs,
    summary,
    details: {
      http_status: opts.httpStatus,
      method: opts.method,
      path: opts.path,
      transport_status: transportStatus,
      rpc_result_status: "unobserved",
      tool_result_status: "unobserved",
      client_delivery: "unknown",
      request_error_observed: requestErrorObserved,
      ...(opts.errorMessage ? { error: redactSensitiveText(opts.errorMessage) } : {}),
    },
  });
}

export function logMcpRequest(
  body: unknown,
  sessionId: string | undefined,
  durationMs: number,
  httpStatus: number,
  errorMessage?: string,
  outcome?: McpOutcomeObservation,
  conversationId?: string,
  requestDetails?: Record<string, unknown>
): void {
  if (typeof body !== "object" || body === null) {
    if (httpStatus >= 400 || errorMessage) {
      logMcpHttpEvent({
        method: "POST",
        path: "/mcp",
        httpStatus,
        durationMs,
        sessionId,
        errorMessage,
      });
    }
    return;
  }
  const rpc = body as { method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
  const transportStatus = httpStatus >= 400 ? "http_error" : "http_success";
  const requestErrorObserved = Boolean(errorMessage);
  const rpcResultStatus = outcome?.rpc_result_status ?? "unobserved";
  const toolResultStatus = outcome?.tool_result_status ?? "unobserved";
  const status =
    transportStatus === "http_error" ||
    requestErrorObserved ||
    rpcResultStatus === "error" ||
    toolResultStatus === "error"
      ? "error"
      : toolResultStatus === "running" || toolResultStatus === "unknown"
        ? toolResultStatus
      : toolResultStatus === "success"
        ? "ok"
        : "transport_ok";
  const argSummary =
    rpc.method === "tools/call" && rpc.params?.name
      ? summarizeToolArgs(rpc.params.name, rpc.params.arguments)
      : undefined;
  const safeError = errorMessage ? trimSummary(redactSensitiveText(errorMessage)) : undefined;
  const failure = outcome?.failure;
  const summary = safeError || (failure
    ? trimSummary(redactSensitiveText([argSummary, failure.error_summary].filter(Boolean).join(" — ")), 400)
    : argSummary);
  const outcomeDetails = {
    ...requestDetails,
    rpc_request_id: (body as { id?: unknown }).id,
    transport_status: transportStatus,
    rpc_result_status: rpcResultStatus,
    tool_result_status: toolResultStatus,
    client_delivery: outcome?.client_delivery ?? "unknown",
    request_error_observed: requestErrorObserved,
    ...(outcome?.invocation_id ? { invocation_id: outcome.invocation_id } : {}),
    ...(outcome?.request_instance_id ? { request_instance_id: outcome.request_instance_id } : {}),
    ...(outcome?.runtime_instance_id ? { runtime_instance_id: outcome.runtime_instance_id } : {}),
    ...(outcome?.observed_at ? { outcome_observed_at: outcome.observed_at } : {}),
    ...(failure ? { ...failure } : {}),
  };

  if (rpc.method === "tools/call" && rpc.params?.name) {
    const tool = rpc.params.name;
    appendActivity({
      kind: "mcp",
      tool,
      action: "tools/call",
      session_id: sessionId,
      conversation_id: conversationId,
      client: "chatgpt",
      status,
      duration_ms: durationMs,
      summary,
      details: {
        http_status: httpStatus,
        ...outcomeDetails,
        ...(status === "ok" && conversationId && conversationTaskTitleHint(tool, rpc.params.arguments)
          ? { conversation_label_hint: conversationTaskTitleHint(tool, rpc.params.arguments) } : {}),
        argument_keys:
          rpc.params.arguments && typeof rpc.params.arguments === "object"
            ? Object.keys(rpc.params.arguments as Record<string, unknown>).slice(0, 24)
            : [],
        ...(safeError ? { error: safeError } : {}),
      },
    });
    return;
  }

  if (rpc.method === "initialize") {
    appendActivity({
      kind: "session",
      action: "initialize",
      session_id: sessionId,
      client: "chatgpt",
      status,
      duration_ms: durationMs,
      summary: safeError,
      details: { http_status: httpStatus, ...outcomeDetails },
    });
    return;
  }

  if (rpc.method === "tools/list") {
    appendActivity({
      kind: "mcp",
      action: "tools/list",
      session_id: sessionId,
      client: "chatgpt",
      status,
      duration_ms: durationMs,
      summary: safeError || (transportStatus === "http_error" ? `HTTP ${httpStatus}` : "discovery"),
      details: { http_status: httpStatus, phase: "connector_discovery", ...outcomeDetails },
    });
    return;
  }

  if (rpc.method && !rpc.method.startsWith("notifications/")) {
    appendActivity({
      kind: "mcp",
      action: rpc.method,
      session_id: sessionId,
      client: "chatgpt",
      status,
      duration_ms: durationMs,
      summary: safeError,
      details: { http_status: httpStatus, ...outcomeDetails },
    });
  }
}

/**
 * A tools/call still in flight reports periodically, so an observer can tell a
 * long-running call apart from a conversation that stopped calling tools.
 */
export function logMcpToolRunning(opts: {
  tool: string;
  elapsedMs: number;
  sessionId?: string;
  conversationId?: string;
  summary?: string;
}): void {
  appendActivity({
    kind: "mcp",
    tool: opts.tool,
    action: "tools/call",
    session_id: opts.sessionId,
    conversation_id: opts.conversationId,
    client: "chatgpt",
    status: "running",
    duration_ms: opts.elapsedMs,
    summary: opts.summary,
    details: { phase: "in_flight" },
  });
}
