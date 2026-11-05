import { appendActivity, redactSensitiveText, summarizeToolArgs } from "./activity-log.js";
import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { guardToolResult, resultByteBudget, recordTransportEvent } from "./transport-resilience.js";
import { observeMcpInvocationFailure, observeMcpToolResult } from "./mcp-outcome.js";
import { toolFailureDiagnostic, type ToolFailureDiagnostic } from "./tool-diagnostics.js";
import { executeOperation } from "./operation-journal.js";
import { toolError } from "./tool-result.js";
import { relayEnabled, renewDriverLeaseForOwnerActivity } from "./driver-lease.js";
import { getGoal } from "./goal-state-store.js";
import { resolveRelayGoalForSession, withRelayGoal } from "./relay-scope.js";
import { recordWorkerMcpActivityBySession } from "./worker-registry.js";
import { extractIntentArgument } from "./requirement-readiness.js";

import {
  createRuntimeScope,
  runWithRuntimeScope,
  hasNativePreDispatchFailure,
  type RequestContext,
  type RuntimeScope,
  type RuntimeScopeSeed,
} from "./runtime-scope.js";
import {
  getMcpRequestIdentity,
  operationRequestMetadata,
  scopedOperationIdentity,
} from "./mcp-request-identity.js";
import type {
  EffectiveToolDefinition,
  EffectiveToolRegistry,
  ToolSource,
} from "./effective-tool-registry.js";

export interface InvocationContext {
  readonly definition: EffectiveToolDefinition;
  readonly scope: RuntimeScope;
  readonly rawArgs: unknown;
  readonly callbackArgs: readonly unknown[];
}

export type InvocationSuccessHook = (
  context: InvocationContext,
  result: CallToolResult
) => CallToolResult | Promise<CallToolResult>;

export type InvocationFailureHook = (
  context: InvocationContext,
  error: unknown
) => void | Promise<void>;

export type InvocationTraceStatus = "start" | "success" | "failure";
export type InvocationErrorCategory = "handler" | "success_hook";

/** Bounded trace data; arguments, results, error text, and auth data are absent. */
export interface InvocationTraceRecord {
  readonly invocationId: string;
  readonly tool: string;
  readonly source: ToolSource;
  readonly sessionId?: string;
  readonly requestId?: RequestId;
  readonly deadlineAt?: number;
  readonly aborted: boolean;
  readonly durationMs: number;
  readonly status: InvocationTraceStatus;
  readonly errorCategory?: InvocationErrorCategory;
  readonly handlerEntered?: boolean;
  readonly handlerReturned?: boolean;
  readonly postprocessingCompleted?: boolean;
  readonly reconciliationNeeded?: boolean;
}

export type InvocationTraceCallback = (
  record: InvocationTraceRecord
) => void | Promise<void>;

export interface InvocationGatewayOptions {
  readonly onSuccess?: InvocationSuccessHook;
  readonly onFailure?: InvocationFailureHook;
  readonly trace?: InvocationTraceCallback;
}

/** Executes every registered tool through one scope-aware invocation path. */
export class InvocationGateway {
  private readonly registry: EffectiveToolRegistry;
  private readonly scopeSeed: RuntimeScopeSeed;
  private readonly onSuccess?: InvocationSuccessHook;
  private readonly onFailure?: InvocationFailureHook;
  private readonly trace?: InvocationTraceCallback;

  constructor(
    registry: EffectiveToolRegistry,
    scopeSeed: RuntimeScopeSeed,
    options: InvocationGatewayOptions = {}
  ) {
    this.registry = registry;
    this.scopeSeed = scopeSeed;
    this.onSuccess = options.onSuccess;
    this.onFailure = options.onFailure;
    this.trace = options.trace;
  }

  /**
   * Invokes a tool with the exact callback argument list supplied by the SDK.
   * The request extra is read from the final callback argument and reduced to
   * the minimal request context before creating the runtime scope.
   */
  async invoke(
    toolName: string,
    callbackArgs: readonly unknown[]
  ): Promise<CallToolResult>;
  async invoke(toolName: string, ...callbackArgs: unknown[]): Promise<CallToolResult>;
  async invoke(toolName: string, ...callbackArguments: unknown[]): Promise<CallToolResult> {
    const definition = this.registry.get(toolName);
    if (!definition) throw new Error(`Tool ${toolName} not found`);

    // Accept both an already-collected SDK argument list and direct varargs so
    // a wrapper can preserve the callback's original arity and ordering.
    const callbackArgs =
      callbackArguments.length === 1 && Array.isArray(callbackArguments[0])
        ? (callbackArguments[0] as readonly unknown[])
        : callbackArguments;
    const extractedIntent = extractIntentArgument(callbackArgs[0]);
    const handlerCallbackArgs = [...callbackArgs];
    if (handlerCallbackArgs.length > 0) handlerCallbackArgs[0] = extractedIntent.sanitizedArgs;
    const requestContext = findRequestContext(callbackArgs);
    const scope = createRuntimeScope(this.scopeSeed, requestContext);
    // This runs before runWithRuntimeScope: pass the trusted session explicitly.
    // The workspace projection is discovery data and cannot authorize this call.
    // Goal state supplies context only; a damaged or pending historical Goal
    // must not prevent an unrelated new operation from executing.
    let sessionGoal: Awaited<ReturnType<typeof getGoal>> = null;
    try {
      if (scope.mcpSessionId) sessionGoal = await runWithRuntimeScope(scope, () => getGoal(scope.workspaceRoot, scope.mcpSessionId));
    } catch { /* Keep execution available when historical context is unavailable. */ }
    scope.goalId = sessionGoal?.id;
    scope.goalOwnerSessionId = sessionGoal?.owner_session;
    scope.goalStatus = sessionGoal?.status;
    let relayGoalId = scope.goalId;
    if (!relayGoalId && scope.mcpSessionId && relayEnabled()) {
      try {
        // A terminal Worker must remain fenced after its Goal stops steering.
        relayGoalId = await resolveRelayGoalForSession(scope.workspaceRoot, scope.mcpSessionId) ?? undefined;
      } catch { /* relay metadata is optional */ }
    }
    const inRelayScope = <T>(operation: () => T): T => relayGoalId
      ? withRelayGoal(scope.workspaceRoot, relayGoalId, operation)
      : operation();
    const context: InvocationContext = {
      definition,
      scope,
      // `_intent` is Harness control-plane metadata. Never expose it to tool
      // handlers, repeat fingerprints, Goal evidence or operation identity.
      rawArgs: extractedIntent.sanitizedArgs,
      callbackArgs: Object.freeze(handlerCallbackArgs),
    };
    const startedAt = Date.now();

    // Browser telemetry is diagnostic; this process-side timestamp is the
    // authoritative signal that the bound Chat still reached the MCP runtime.
    if (scope.mcpSessionId) {
      await inRelayScope(() => recordWorkerMcpActivityBySession(scope.workspaceRoot, scope.mcpSessionId!)).catch(() => null);
      await inRelayScope(() => renewDriverLeaseForOwnerActivity(scope.workspaceRoot, scope.mcpSessionId!)).catch(() => null);
    }

    const extra = handlerCallbackArgs[handlerCallbackArgs.length - 1];
    const requestExtra = isRequestContextLike(extra) ? extra : undefined;
    let metadata: ReturnType<typeof operationRequestMetadata>;
    try { metadata = operationRequestMetadata(requestExtra?._meta); }
    catch { return toolError(toolName, "INVALID_OPERATION_METADATA"); }

    // Execution no longer depends on intent, Goal/Driver admission, or legacy
    // recovery grants. Concrete resources and the operation journal retain their
    // own locks and duplicate protection.
    let effectDispatched = false, effectSettled = false;
    const withDriverExecutionFence = async <T>(operation: () => Promise<T>): Promise<T> => operation();

    const executeOnce = () => runWithRuntimeScope(scope, () => inRelayScope(async () => {
      await this.emitTrace({
        invocationId: scope.invocationId,
        tool: definition.name,
        source: definition.source,
        sessionId: scope.mcpSessionId,
        requestId: scope.requestId,
        deadlineAt: scope.deadlineAt,
        aborted: scope.signal?.aborted ?? false,
        durationMs: 0,
        status: "start",
      });

      const identity = getMcpRequestIdentity();
      const conversationId = scope.conversationContinuity === "trusted" ? scope.conversationSessionId : undefined;
      // Product telemetry retains a bounded, redacted target; debug trace remains argument-free.
      let safeSummary = "";
      try { safeSummary = redactSensitiveText(summarizeToolArgs(definition.name, context.rawArgs)).replace(/\s+/g, " ").trim().slice(0, 160); } catch {}
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const lifecycle = (status: "running" | "ok" | "error" | "unknown", duration: number, failure?: ToolFailureDiagnostic) => {
        if (status !== "running" && heartbeat) clearInterval(heartbeat);
        try { appendActivity({ kind: "tool", action: "tools/call", tool: definition.name, status,
          duration_ms: duration, session_id: identity?.transportSessionId, conversation_id: conversationId,
          summary: failure ? [safeSummary, failure.error_summary].filter(Boolean).join(" — ") : safeSummary || (status === "running" ? "started" : status === "ok" ? "completed" : status === "unknown" ? "outcome unknown" : "failed"),
          details: { invocation_id: scope.invocationId, canonical_lifecycle: true, ...(failure ? { ...failure } : {}) } }); } catch {}
      };
      const executionStartedAt = Date.now();
      lifecycle("running", 0);
      const intervalMs = Math.min(600_000, Math.max(200, Number.parseInt(process.env.MCP_RUNNING_REPORT_MS || "60000", 10) || 60000));
      heartbeat = setInterval(() => lifecycle("running", elapsedMs(executionStartedAt)), intervalMs);
      heartbeat.unref();
      let failureCategory: InvocationErrorCategory = "handler";
      let handlerEntered = false, handlerReturned = false;
      try {
        handlerEntered = true;
        effectDispatched = true;
        const rawResult = await definition.execute(handlerCallbackArgs, scope);
        handlerReturned = true;
        failureCategory = "success_hook";
        const protectedResult = await guardToolResult(context, rawResult, {
          stage: "handler", budget: Math.max(16 * 1024, resultByteBudget() - 64 * 1024),
        });
        failureCategory = "success_hook";
        const result = this.onSuccess
          ? await this.onSuccess(context, protectedResult)
          : protectedResult;
        const guarded = await guardToolResult(context, result, { stage: "wire", compactDuplicates: true,
          budget: Math.max(16 * 1024, resultByteBudget() - 1024) });
        const wireResult = guarded;
        observeMcpToolResult({
          requestId: scope.requestId,
          tool: definition.name,
          invocationId: scope.invocationId,
          result: wireResult,
        });

        await this.emitTrace({
          invocationId: scope.invocationId,
          tool: definition.name,
          source: definition.source,
          sessionId: scope.mcpSessionId,
          requestId: scope.requestId,
          deadlineAt: scope.deadlineAt,
          aborted: scope.signal?.aborted ?? false,
          durationMs: elapsedMs(startedAt),
          status: "success",
          handlerEntered, handlerReturned, postprocessingCompleted: true, reconciliationNeeded: false,
        });
        const failure = toolFailureDiagnostic(wireResult);
        const lifecycleStatus = failure?.outcome_kind === "running" ? "running"
          : failure?.outcome_kind === "unknown" ? "unknown" : failure ? "error" : "ok";
        lifecycle(lifecycleStatus, elapsedMs(executionStartedAt), failure);
        // Only an acknowledged native host handoff may end the submission
        // reservation. The separate managed reservation survives until child close.
        // This line remains after all result guards, success hooks and trace hooks.
        effectSettled = definition.name !== "start_process" ||
          (definition.source === "native" && scope.goalEffectLease?.managedProcessConfirmed() === true);
        return wireResult;
      } catch (error) {
        let failureHookHandled = false;
        let notDispatched = definition.source === "native" && definition.name === "computer_use" &&
          !handlerReturned && hasNativePreDispatchFailure(scope, error);
        if (notDispatched) {
          // Keep the Goal reservation through failure processing as well. A hook
          // may dispatch work or replace the error; neither can retain this proof.
          failureHookHandled = true;
          try { await this.onFailure?.(context, error); }
          catch (hookError) { error = hookError; notDispatched = false; }
          if (notDispatched) notDispatched = hasNativePreDispatchFailure(scope, error);
        }
        await recordTransportEvent(scope.workspaceRoot, {
          invocation_id: scope.invocationId, tool: definition.name, session_id: scope.mcpSessionId ?? null,
          request_id: scope.requestId ?? null, outcome: "invocation_failed", duration_ms: elapsedMs(startedAt),
          category: failureCategory, aborted: scope.signal?.aborted ?? false,
        }).catch(() => undefined);
        await this.emitTrace({
          invocationId: scope.invocationId,
          tool: definition.name,
          source: definition.source,
          sessionId: scope.mcpSessionId,
          requestId: scope.requestId,
          deadlineAt: scope.deadlineAt,
          aborted: scope.signal?.aborted ?? false,
          durationMs: elapsedMs(startedAt),
          status: "failure",
          errorCategory: failureCategory,
          // This observer runs before final proof validation. Keep its trace
          // conservative; the observer itself may enter a native dispatch.
          handlerEntered, handlerReturned, postprocessingCompleted: false,
          reconciliationNeeded: handlerEntered,
        });

        // All awaited callbacks have finished. Only now may an invocation-local
        // proof determine the wire/lifecycle outcome and release the reservation.
        if (notDispatched) notDispatched = hasNativePreDispatchFailure(scope, error);
        let localRejection = notDispatched ? toolError(toolName, error instanceof Error ? error.message : String(error), {
          error_code: "COMPUTER_USE_NOT_DISPATCHED", failure_class: "validation",
          outcome_kind: "blocked", failure_phase: "validation", operation_started: false,
          retry_policy: "refresh_state", handler_entered: handlerEntered, handler_returned: false,
          postprocessing_completed: true, reconciliation_needed: false, retryable: false,
        }) : undefined;
        const executionFailure = () => toolFailureDiagnostic(toolError(toolName, error instanceof Error ? error.message : String(error), {
          outcome_kind: "execution_error", failure_phase: handlerReturned ? "postprocessing" : "execution",
          ...(!handlerEntered ? { operation_started: false } : handlerReturned ? { operation_started: true } : {}),
          retry_policy: "inspect_original_result",
          ...(handlerReturned ? { error_code: "RESULT_POSTPROCESSING_FAILED" } : {}),
        }));
        let failure = localRejection ? toolFailureDiagnostic(localRejection) : executionFailure();
        lifecycle("error", elapsedMs(executionStartedAt), failure);
        if (localRejection && !hasNativePreDispatchFailure(scope, error)) {
          // Activity subscribers run synchronously and may invalidate the proof.
          // Correct this invocation once; sticky dispatch can never become local again.
          localRejection = undefined;
          failure = executionFailure();
          lifecycle("error", elapsedMs(executionStartedAt), failure);
        }

        if (localRejection && hasNativePreDispatchFailure(scope, error)) {
          effectSettled = true;
          observeMcpToolResult({ requestId: scope.requestId, tool: definition.name,
            invocationId: scope.invocationId, result: localRejection });
          return localRejection;
        }
        observeMcpInvocationFailure({ requestId: scope.requestId, tool: definition.name,
          invocationId: scope.invocationId, failure });

        if (handlerReturned) {
          // The handler has already returned; failure to record/format its result
          // cannot undo its effects or justify replaying the invocation.
          return toolError(toolName, "RESULT_POSTPROCESSING_FAILED", {
            error_code: "RESULT_POSTPROCESSING_FAILED", handler_entered: true,
            outcome_kind: "execution_error", failure_phase: "postprocessing", operation_started: true,
            retry_policy: "inspect_original_result",
            handler_returned: true, postprocessing_completed: false,
            reconciliation_needed: true, retryable: false,
            next_action: "Inspect the original operation receipt, task state and external artifacts before any further action; do not blindly repeat the operation.",
          });
        }
        if (!failureHookHandled && this.onFailure) await this.onFailure(context, error);
        // If onFailure throws, this throw is not reached, so JavaScript keeps
        // its normal replacement-error semantics instead of masking the hook.
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    }));

    // SDK validation and registration admission already happened. Recovery may
    // return an existing outcome but must never re-enter the handler or hooks.
    const transport = getMcpRequestIdentity()?.transportSessionId ??
      (typeof requestExtra?.sessionId === "string" ? requestExtra.sessionId : undefined);
    const identityNamespace = {
      principalId: scope.principalId, tunnelProfile: scope.tunnelProfile,
      conversationSessionId: scope.mcpSessionId,
    };
    const legacyIdentity = scope.goalId && metadata.id
      ? scopedOperationIdentity(identityNamespace, transport, scope.requestId, metadata.id) : undefined;
    const identity = scopedOperationIdentity({
      ...identityNamespace, goalId: scope.goalId,
    }, transport, scope.requestId, metadata.id);
    if ((metadata.id || metadata.observe) && !identity) return toolError(toolName, "OPERATION_SCOPE_REQUIRED");
    // Ordinary read-only control calls remain live observations. Clients that
    // omit identity cannot gain cross-session duplicate protection by guessing
    // from tool arguments: identical commands can be intentional new work.
    if (!identity || (definition.config.annotations?.readOnlyHint === true && !metadata.id)) {
      return withDriverExecutionFence(executeOnce);
    }
    return withDriverExecutionFence(() => runWithRuntimeScope(scope, async () => {
      let entered = false;
      const result = await executeOperation({
        workspaceRoot: scope.workspaceRoot, identity, tool: toolName,
        goalId: scope.goalId, ownerSessionId: scope.goalOwnerSessionId, legacyIdentity,
        args: context.rawArgs, signal: scope.signal, observe: metadata.observe,
      }, () => { entered = true; return executeOnce(); });
      // A replay/observation is still a tool response for this RPC. It does not
      // rerun result hooks (including evidence creation) from the first call.
      if (!entered) observeMcpToolResult({
        requestId: scope.requestId, tool: toolName,
        invocationId: scope.invocationId, result,
      });
      return result;
    }));
  }

  private async emitTrace(record: InvocationTraceRecord): Promise<void> {
    if (!this.trace) return;
    try {
      await this.trace(record);
    } catch {
      // Trace observers are diagnostic only and cannot affect tool behavior.
    }
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function findRequestContext(callbackArgs: readonly unknown[]): RequestContext | undefined {
  const candidate = callbackArgs[callbackArgs.length - 1];
  if (!isRequestContextLike(candidate)) return undefined;

  return {
    // Pass the raw metadata to the shared identity resolver in createRuntimeScope.
    sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : undefined,
    _meta: candidate._meta,
    signal: candidate.signal as AbortSignal | undefined,
    requestId: isRequestId(candidate.requestId) ? candidate.requestId : undefined,
  };
}

function isRequestContextLike(value: unknown): value is {
  sessionId?: unknown;
  signal?: unknown;
  requestId?: unknown;
  _meta?: unknown;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
} {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "signal" in record && "requestId" in record;
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}
