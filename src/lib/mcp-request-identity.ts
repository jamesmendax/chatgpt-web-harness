import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

export interface McpRequestIdentity {
  readonly conversationSessionId?: string;
  readonly transportSessionId?: string;
  readonly requestInstanceId: string;
  readonly runtimeInstanceId: string;
  readonly originalHeaders: Readonly<HeaderBag>;
  readonly continuity: "trusted" | "unknown" | "conflict";
  readonly source: "openai/session" | "none" | "conflict";
}

type HeaderValue = string | string[] | undefined;
type HeaderBag = Record<string, HeaderValue>;

const requestIdentityStorage = new AsyncLocalStorage<McpRequestIdentity>();
export const MCP_RUNTIME_INSTANCE_ID = randomUUID();

/** Account namespace is local launcher configuration, never request metadata. */
export function runtimePrincipalId(workspaceRoot: string): string {
  const account = process.env.HARNESS_ACCOUNT_ID?.trim();
  if (account && /^[A-Za-z0-9_-]{1,128}$/.test(account)) return account;
  const location = process.env.CHATGPT_PLUGINS_CONFIG || workspaceRoot;
  return "local_" + createHash("sha256").update(process.platform === "win32" ? location.toLowerCase() : location).digest("hex").slice(0, 32);
}

/**
 * Resolve a stable ChatGPT conversation identity from trusted host metadata.
 * OpenAI documents `openai/session` as an anonymized conversation id for
 * correlating tool calls in the same ChatGPT session. We derive a local opaque
 * id so the raw host value is never persisted in Goal/Task state paths.
 */
export function conversationSessionIdFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const raw = (meta as Record<string, unknown>)["openai/session"];
  return typeof raw === "string" && raw.trim() ? deriveConversationSessionId(raw) : undefined;
}

/** Legacy headers have no verified conversation semantics. Keep the API for old callers. */
export function conversationSessionIdFromHeaders(_headers: HeaderBag | undefined): string | undefined {
  return undefined;
}

export function resolveMcpConversationIdentity(meta?: unknown): Pick<McpRequestIdentity, "conversationSessionId" | "continuity" | "source"> {
  const inherited = requestIdentityStorage.getStore();
  const supplied = conversationSessionIdFromMeta(meta);
  if (inherited?.continuity === "conflict" ||
      (supplied && inherited?.conversationSessionId && supplied !== inherited.conversationSessionId)) {
    return { continuity: "conflict", source: "conflict" };
  }
  const conversationSessionId = supplied ?? inherited?.conversationSessionId;
  return conversationSessionId
    ? { conversationSessionId, continuity: "trusted", source: "openai/session" }
    : { continuity: "unknown", source: "none" };
}

/** Capture protocol headers once, before recovery mutates them; credentials are excluded. */
export function snapshotMcpRequestHeaders(headers: HeaderBag | undefined): Readonly<HeaderBag> {
  const snapshot: HeaderBag = {};
  for (const name of ["accept", "content-type", "mcp-session-id", "mcp-protocol-version"]) {
    const value = headers && headerValue(headers, name);
    if (value !== undefined) snapshot[name] = value;
  }
  return Object.freeze(snapshot);
}

export function runWithMcpRequestIdentity<T>(
  headers: HeaderBag | undefined,
  transportSessionId: string | undefined,
  operation: () => T,
  body?: unknown
): T {
  const inherited = requestIdentityStorage.getStore();
  const meta = body && typeof body === "object" && !Array.isArray(body)
    ? (body as { params?: { _meta?: unknown } }).params?._meta : undefined;
  const identity: McpRequestIdentity = Object.freeze({
    ...resolveMcpConversationIdentity(meta),
    transportSessionId,
    requestInstanceId: inherited?.requestInstanceId ?? randomUUID(),
    runtimeInstanceId: inherited?.runtimeInstanceId ?? MCP_RUNTIME_INSTANCE_ID,
    originalHeaders: inherited?.originalHeaders ?? snapshotMcpRequestHeaders(headers),
  });
  return requestIdentityStorage.run(identity, operation);
}

export function getMcpRequestIdentity(): McpRequestIdentity | undefined {
  return requestIdentityStorage.getStore();
}

/** A client must retain this key before sending a mutation to recover across sessions. */
export function operationRequestMetadata(meta: unknown): { id?: string; observe: boolean } {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return { observe: false };
  const record = meta as Record<string, unknown>;
  const id = record["local-coder/operation-id"];
  const mode = record["local-coder/operation-mode"];
  if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
    throw new Error("INVALID_OPERATION_ID");
  }
  if (mode !== undefined && mode !== "execute" && mode !== "observe") throw new Error("INVALID_OPERATION_MODE");
  if (mode === "observe" && !id) throw new Error("OPERATION_ID_REQUIRED");
  return { id: id as string | undefined, observe: mode === "observe" };
}

/** Typed RPC IDs are session-local, never conversation-global. */
export function scopedOperationIdentity(
  namespace: { principalId?: string; tunnelProfile?: string; conversationSessionId?: string; goalId?: string },
  transportSessionId: string | undefined,
  requestId: string | number | undefined,
  explicitId?: string
): string | undefined {
  const owner = namespace.conversationSessionId || transportSessionId;
  if (!owner) return undefined;
  const request = explicitId !== undefined
    ? namespace.goalId ? ["goal-explicit", namespace.goalId, explicitId] : ["explicit", owner, explicitId]
    : transportSessionId && requestId !== undefined
      ? ["rpc", transportSessionId, typeof requestId, requestId]
      : undefined;
  if (!request) return undefined;
  return createHash("sha256").update(JSON.stringify([
    "local-coder-operation-v1", namespace.principalId ?? "local", namespace.tunnelProfile ?? "default", request,
  ])).digest("hex");
}

function deriveConversationSessionId(raw: string): string {
  const digest = createHash("sha256")
    .update("chatgpt-openai-conversation-v1\0")
    .update(raw.trim())
    .digest("hex")
    .slice(0, 32);
  return `oai_conv_${digest}`;
}

function headerValue(headers: HeaderBag, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.find((item) => typeof item === "string");
  }
  return undefined;
}
