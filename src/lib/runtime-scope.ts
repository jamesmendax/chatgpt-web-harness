import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import type { RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { GoalEffectLease } from "./goal-effect-scope.js";
import { getMcpRequestIdentity, resolveMcpConversationIdentity, MCP_RUNTIME_INSTANCE_ID } from "./mcp-request-identity.js";

/** Trusted, process-side values used to build one invocation scope. */
export interface RuntimeScopeSeed {
  readonly tunnelProfile?: string;
  readonly principalId?: string;
  /** Server-generated identity for transports that expose no session ID. */
  readonly fallbackSessionId?: string;
  readonly workspaceRoot: string;
  readonly projectRoots: readonly string[];
  readonly deadlineAt?: number;
}

/** The request metadata that is safe and useful at the tool callback boundary. */
export interface RequestContext {
  readonly _meta?: unknown;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
  readonly requestId?: RequestId;
}

/** Per-invocation state shared through the asynchronous call chain. */
export interface RuntimeScope {
  invocationId: string;
  requestInstanceId?: string;
  runtimeInstanceId?: string;
  conversationSessionId?: string;
  conversationContinuity?: "trusted" | "unknown" | "conflict";
  mcpSessionId?: string;
  /** Captured from this session's authoritative Goal, never from tool arguments. */
  goalId?: string;
  goalOwnerSessionId?: string;
  /** Lifecycle snapshot captured by the gateway, not a client argument. */
  goalStatus?: string;
  /** Recheck trusted admission just before a queued provider sends a new effect. */
  beforeDispatch?: () => Promise<void>;
  /** Internal native-process handoff capability; never populated from tool arguments. */
  goalEffectLease?: GoalEffectLease;
  tunnelProfile?: string;
  principalId?: string;
  workspaceRoot: string;
  readonly projectRoots: readonly string[];
  deadlineAt?: number;
  signal?: AbortSignal;
  requestId?: RequestId;
}

const runtimeScopeStorage = new AsyncLocalStorage<RuntimeScope>();

// Process-local evidence, never request fields or serialized diagnostics. A
// dispatch is sticky for this invocation, including later work in failure hooks.
const nativeDispatchedScopes = new WeakSet<RuntimeScope>();
const nativePreDispatchFailures = new WeakMap<Error, { scope: RuntimeScope; invocationId: string }>();

export function markNativeDispatchStarted(): void {
  const scope = getRuntimeScope();
  if (scope) nativeDispatchedScopes.add(scope);
}

export function markNativePreDispatchFailure(error: unknown): void {
  const scope = getRuntimeScope();
  if (scope && error instanceof Error && !nativeDispatchedScopes.has(scope)) {
    nativePreDispatchFailures.set(error, { scope, invocationId: scope.invocationId });
  }
}

export function hasNativePreDispatchFailure(scope: RuntimeScope, error: unknown): boolean {
  if (!(error instanceof Error) || nativeDispatchedScopes.has(scope)) return false;
  const proof = nativePreDispatchFailures.get(error);
  return proof?.scope === scope && proof.invocationId === scope.invocationId;
}

/**
 * Uses the trusted transport session, or this server instance's private fallback.
 * Principal and workspace authority are never derived from request arguments.
 * `projectRoots` is copied and frozen so a caller cannot mutate the scope via
 * the seed array after creation.
 */
export function createRuntimeScope(
  seed: RuntimeScopeSeed,
  requestContext?: RequestContext
): RuntimeScope {
  const identity = getMcpRequestIdentity();
  const conversation = resolveMcpConversationIdentity(requestContext?._meta);
  const invocationId = crypto.randomUUID();
  return {
    invocationId,
    requestInstanceId: identity?.requestInstanceId,
    runtimeInstanceId: identity?.runtimeInstanceId ?? MCP_RUNTIME_INSTANCE_ID,
    conversationSessionId: conversation.conversationSessionId,
    conversationContinuity: conversation.continuity,
    mcpSessionId: conversation.conversationSessionId ?? (conversation.continuity === "conflict"
      ? `unattributed_${invocationId}` : requestContext?.sessionId ?? seed.fallbackSessionId),
    tunnelProfile: seed.tunnelProfile,
    principalId: seed.principalId,
    workspaceRoot: seed.workspaceRoot,
    projectRoots: Object.freeze([...seed.projectRoots]),
    deadlineAt: seed.deadlineAt,
    signal: requestContext?.signal,
    requestId: requestContext?.requestId,
  };
}

/** Runs a synchronous or asynchronous operation with `scope` as its store. */
export function runWithRuntimeScope<T>(scope: RuntimeScope, operation: () => T): T {
  return runtimeScopeStorage.run(scope, operation);
}

/** Returns the scope associated with the current asynchronous execution. */
export function getRuntimeScope(): RuntimeScope | undefined {
  return runtimeScopeStorage.getStore();
}
