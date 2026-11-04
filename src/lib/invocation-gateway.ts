import { appendActivity, redactSensitiveText, summarizeToolArgs } from "./activity-log.js";
import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { guardToolResult, resultByteBudget, recordTransportEvent } from "./transport-resilience.js";
import { observeMcpInvocationFailure, observeMcpToolResult } from "./mcp-outcome.js";
import { toolFailureDiagnostic, type ToolFailureDiagnostic } from "./tool-diagnostics.js";
import { executeOperation } from "./operation-journal.js";
import { toolError } from "./tool-result.js";
import { assertRecoveryIngress } from "./recovery-integrity.js";
import { admitExecutionContract, readAcceptedExecutionContractState } from "./execution-contract.js";
import {
  assertDriverMutationAdmission,
  enterDriverMutationExecution,
  readDriverLease,
  relayEnabled,
  renewDriverLeaseForOwnerActivity,
  type DriverLease,
} from "./driver-lease.js";
import { getGoal } from "./goal-state-store.js";
import { enterGoalEffect } from "./goal-effect-scope.js";
import { parseIntentReference, resolveIntentReference, type IntentReference } from "./intent-contract.js";
import { resolveRelayGoalForSession, withRelayGoal } from "./relay-scope.js";
import { readWorkerRegistry, recordWorkerMcpActivityBySession } from "./worker-registry.js";
import {
  extractIntentArgument,
  invocationRequiresExecutionContract,
  parseRequirementModel,
  requirementInputGuidance,
  REQUIREMENT_READY_SCORE,
} from "./requirement-readiness.js";

import {
  createRuntimeScope,
  runWithRuntimeScope,
  hasNativePreDispatchFailure,
  type RequestContext,
  type RuntimeScope,
  type RuntimeScopeSeed,
} from "./runtime-scope.js";
import {
  conversationSessionIdFromHeaders,
  conversationSessionIdFromMeta,
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
    let sessionGoal: Awaited<ReturnType<typeof getGoal>> = null;
    let creationRecovery = false;
    try {
      if (scope.mcpSessionId) sessionGoal = await getGoal(scope.workspaceRoot, scope.mcpSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^[A-Z][A-Z0-9_]+(?=:|$)/.exec(message)?.[0] ?? "GOAL_AUTHORITY_UNAVAILABLE";
      const action = (extractedIntent.sanitizedArgs as { action?: unknown } | undefined)?.action;
      creationRecovery = code === "GOAL_CREATION_PENDING" && definition.source === "native" &&
        toolName === "goal" && (action === "status" || action === "create" || action === "reconcile");
      if (!creationRecovery) return toolError(toolName, code, {
        error_code: code, retryable: false, detail: message,
        next_action: "Read Goal status and explicitly reconcile its pending lifecycle transaction before new work.",
      });
    }
    scope.goalId = sessionGoal?.id;
    scope.goalOwnerSessionId = sessionGoal?.owner_session;
    scope.goalStatus = sessionGoal?.status;
    let relayGoalId = scope.goalId;
    let relayScopeError: unknown;
    if (!relayGoalId && !creationRecovery && scope.mcpSessionId && relayEnabled()) {
      try {
        // A terminal Worker must remain fenced after its Goal stops steering.
        relayGoalId = await resolveRelayGoalForSession(scope.workspaceRoot, scope.mcpSessionId) ?? undefined;
      } catch (error) { relayScopeError = error; }
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

    const sideEffectingInvocation =
      invocationRequiresExecutionContract(
        toolName,
        definition.config.annotations,
        extractedIntent.sanitizedArgs
      ) && !metadata.observe;
    let admittedDriverLease: DriverLease | null = null;
    let admittedReference: IntentReference | null = null;
    let issuedReference: { reference: IntentReference; expires_at: string } | null = null;

    // All genuinely side-effecting tools are fail-closed until a Requirement
    // Model compiles into a >=95 RRS Execution Contract with zero blockers.
    // Operation observations are read-only recovery, so they may proceed.
    if (sideEffectingInvocation) {
      try {
        if (relayScopeError) throw relayScopeError;
      await inRelayScope(async () => {
        await assertRelayWorkerMutationFence(scope.workspaceRoot, scope.mcpSessionId);
        const workspaceGoal = sessionGoal;
        const canReuseRelayContract =
          extractedIntent.intent === undefined &&
          relayEnabled() &&
          workspaceGoal?.status === "active" &&
          Boolean(workspaceGoal.owner_session) &&
          workspaceGoal.owner_session === scope.mcpSessionId;

        if (canReuseRelayContract) {
          const inherited = await readAcceptedExecutionContractState(scope.workspaceRoot, scope.mcpSessionId, scope.goalId);
          if (!inherited || inherited.readiness_score < REQUIREMENT_READY_SCORE) {
            throw new Error("REQUIREMENT_INHERITED_CONTRACT_MISSING: current Driver has no valid inherited execution contract");
          }
          const driverAdmission = await assertDriverMutationAdmission(scope.workspaceRoot, {
            goalId: workspaceGoal.id,
            goalOwnerSessionId: workspaceGoal.owner_session!,
            callerSessionId: scope.mcpSessionId,
            executionContractHash: inherited.requirement_hash,
            intentRevision: inherited.intent_revision,
          });
          admittedDriverLease = driverAdmission.lease;
        } else {
          admittedReference = parseIntentReference(extractedIntent.intent);
          const accepted = admittedReference
            ? await runWithRuntimeScope(scope, () => resolveIntentReference(scope, admittedReference!))
            : (await runWithRuntimeScope(scope, () => admitExecutionContract(scope.workspaceRoot, scope.mcpSessionId,
                parseRequirementModel(extractedIntent.intent), scope.goalId))).state;
          if (!admittedReference && accepted.scope_binding && accepted.canonical_requirement_json) {
            issuedReference = { reference: { intent_revision: accepted.intent_revision, requirement_hash: accepted.requirement_hash }, expires_at: accepted.expires_at };
          }
          if (workspaceGoal?.status === "active") {
            if (!workspaceGoal.owner_session) {
              if (relayEnabled()) {
                throw new Error("DRIVER_GOAL_UNBOUND: relay-controlled active Goals require an owning ChatGPT session");
              }
            } else {
              const driverAdmission = await assertDriverMutationAdmission(scope.workspaceRoot, {
                goalId: workspaceGoal.id,
                goalOwnerSessionId: workspaceGoal.owner_session,
                callerSessionId: scope.mcpSessionId,
                executionContractHash: accepted.requirement_hash,
                intentRevision: accepted.intent_revision,
              });
              admittedDriverLease = driverAdmission.lease;
            }
          }
        }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = /^[A-Z][A-Z0-9_]+(?=:|$)/.exec(message)?.[0] ?? "REQUIREMENT_ADMISSION_FAILED";
        const driverFailure = errorCode.startsWith("DRIVER_");
        const revisionConflict = errorCode === "INTENT_REVISION_CONFLICT" || errorCode === "STALE_INTENT_REVISION";
        let currentReference: { reference: IntentReference; expires_at: string } | null = null;
        if (revisionConflict) {
          try {
            const accepted = await readAcceptedExecutionContractState(scope.workspaceRoot, scope.mcpSessionId, scope.goalId);
            if (accepted) {
              const reference = { intent_revision: accepted.intent_revision, requirement_hash: accepted.requirement_hash };
              // Return only a reference that resolves in this exact trusted scope.
              await runWithRuntimeScope(scope, () => resolveIntentReference(scope, reference));
              currentReference = { reference, expires_at: accepted.expires_at };
            }
          } catch { /* Optional correction metadata must not replace the original rejection. */ }
        }
        const blocked: CallToolResult = toolError(toolName, errorCode, {
          error_code: errorCode,
          failure_class: driverFailure ? "conflict" : "validation",
          outcome_kind: driverFailure ? "blocked" : "needs_input",
          failure_phase: "admission",
          operation_started: false,
          retryable: false,
          retry_policy: driverFailure ? "refresh_state" : "retry_with_changed_args",
          detail: message,
          ...(!driverFailure ? requirementInputGuidance() : {}),
          ...(currentReference ? { accepted_intent_reference: currentReference } : {}),
          authority: {
            caller_session_id: scope.mcpSessionId ?? null,
            session_goal_id: scope.goalId ?? null,
            relay_goal_id: relayGoalId ?? null,
          },
          next_action:
            driverFailure
              ? "Stop side-effecting work in this Turn. Read Goal/relay status and continue only from the current Driver session/epoch; stale Drivers may keep using read-only discovery."
              : revisionConflict
              ? "The operation has not started. For the same authorized objective and scope, reuse the exact previously accepted _intent or JSON.stringify({reference: accepted_intent_reference.reference}) when returned. Do not rewrite a contract with the same revision. Increase intent_revision only for a material change to the actual user request, scope or constraints; do not invent a change to clear this error."
              : "The operation has not started. Correct _intent using the required fields and actual user request; do not resend unchanged arguments. Use read-only discovery for missing facts. Do not ask the user to approve a concrete action they already authorized.",
        });
        if (currentReference) blocked._meta = { ...blocked._meta, "harness/intent_reference": currentReference };
        observeMcpToolResult({
          requestId: scope.requestId,
          tool: definition.name,
          invocationId: scope.invocationId,
          result: blocked,
        });
        return blocked;
      }
    }

    // Recovery Integrity is independent of Requirement Gate admission. A
    // model-supplied _intent, tool annotation or document READY cannot grant
    // a write; the strict profile requires an operator-signed scoped record.
    // Apply this to *all* effective tools, including upstream and aliases.
    let recoveryPermit: Awaited<ReturnType<typeof assertRecoveryIngress>> = null;
    try {
      recoveryPermit = await assertRecoveryIngress(toolName, definition.source, context.rawArgs, scope, metadata.observe);
      if (recoveryPermit && metadata.id && metadata.id !== recoveryPermit.operationId) {
        throw new Error("RI_BLOCKED: supplied operation metadata conflicts with operator-signed operation ID");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = message.startsWith("RI_RECONCILE_REQUIRED") ? "RI_RECONCILE_REQUIRED" : "RI_BLOCKED";
      const blocked = toolError(toolName, errorCode, {
        error_code: errorCode, failure_class: errorCode === "RI_RECONCILE_REQUIRED" ? "conflict" : "validation", retryable: false,
        outcome_kind: "blocked", failure_phase: "admission", operation_started: false, retry_policy: "refresh_state",
        detail: message, next_action: "Inspect the signed operation's original durable receipt and actual target state. Never blindly repeat its effect.",
      });
      observeMcpToolResult({
        requestId: scope.requestId, tool: definition.name,
        invocationId: scope.invocationId, result: blocked,
      });
      return blocked;
    }

    let effectDispatched = false, effectSettled = false;
    const withDriverExecutionFence = async <T>(operation: () => Promise<T>): Promise<T> => {
      const goalEffect = sideEffectingInvocation && scope.goalId
        ? await enterGoalEffect(scope.workspaceRoot, scope.goalId, scope.goalOwnerSessionId) : undefined;
      const releaseGoal = goalEffect ?? (async (_outcome: "settled" | "uncertain") => {});
      if (definition.source === "native" && definition.name === "start_process") scope.goalEffectLease = goalEffect;
      try {
        if (sideEffectingInvocation && scope.goalId) {
          const currentGoal = await getGoal(scope.workspaceRoot, scope.mcpSessionId);
          if (currentGoal?.id !== scope.goalId || currentGoal.owner_session !== scope.mcpSessionId) {
            throw new Error("GOAL_SCOPE_CHANGED: the session changed Goal after this invocation was admitted");
          }
        }
        if (admittedReference) await runWithRuntimeScope(scope, () => resolveIntentReference(scope, admittedReference!));
        if (!sideEffectingInvocation || !admittedDriverLease) return await operation();
        const release = await inRelayScope(() => enterDriverMutationExecution(scope.workspaceRoot, admittedDriverLease!));
        try { return await operation(); } finally { release(); }
      } finally {
        try { await releaseGoal(!effectDispatched || effectSettled ? "settled" : "uncertain"); }
        catch (error) {
          throw new Error(`GOAL_ADMISSION_RELEASE_UNCERTAIN: effect may have executed; do not replay. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    };

    // Providers may queue or connect after their handler is admitted. The outer
    // fence still owns the whole invocation; this callback prevents a new
    // dispatch after Goal lifecycle or Driver authority changed while waiting.
    // It never reacquires authority or replays an already-dispatched effect.
    scope.beforeDispatch = async () => {
      if (!sideEffectingInvocation) return;
      const currentGoal = await getGoal(scope.workspaceRoot, scope.mcpSessionId);
      if (currentGoal?.id !== sessionGoal?.id ||
          currentGoal?.owner_session !== sessionGoal?.owner_session ||
          currentGoal?.status !== sessionGoal?.status) {
        throw new Error("GOAL_SCOPE_CHANGED: Goal identity, owner or lifecycle changed before provider dispatch");
      }
      await inRelayScope(async () => {
        await assertRelayWorkerMutationFence(scope.workspaceRoot, scope.mcpSessionId);
        if (admittedDriverLease) {
          const release = await enterDriverMutationExecution(scope.workspaceRoot, admittedDriverLease);
          release();
        }
      });
    };

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
      const conversationId = scope.mcpSessionId?.startsWith("oai_conv_") ? scope.mcpSessionId : undefined;
      // Product telemetry retains a bounded, redacted target; debug trace remains argument-free.
      let safeSummary = "";
      try { safeSummary = redactSensitiveText(summarizeToolArgs(definition.name, context.rawArgs)).replace(/\s+/g, " ").trim().slice(0, 160); } catch {}
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const lifecycle = (status: "running" | "ok" | "error", duration: number, failure?: ToolFailureDiagnostic) => {
        if (status !== "running" && heartbeat) clearInterval(heartbeat);
        try { appendActivity({ kind: "tool", action: "tools/call", tool: definition.name, status,
          duration_ms: duration, session_id: identity?.transportSessionId, conversation_id: conversationId,
          summary: failure ? [safeSummary, failure.error_summary].filter(Boolean).join(" — ") : safeSummary || (status === "running" ? "started" : status === "ok" ? "completed" : "failed"),
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
        // Make the first admitted full contract discoverable in both ordinary
        // model-visible content and machine-readable MCP metadata.
        const wireResult = issuedReference ? {
          ...guarded,
          content: [...guarded.content, { type: "text" as const, text: `Accepted _intent reference (expires ${issuedReference.expires_at}): ${JSON.stringify({ reference: issuedReference.reference })}` }],
          _meta: { ...guarded._meta, "harness/intent_reference": issuedReference },
        } : guarded;
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
        lifecycle(failure ? "error" : "ok", elapsedMs(executionStartedAt), failure);
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
    const legacyIdentity = !recoveryPermit && scope.goalId && metadata.id
      ? scopedOperationIdentity(identityNamespace, transport, scope.requestId, metadata.id) : undefined;
    const identity = recoveryPermit?.identity ?? scopedOperationIdentity({
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
        goalId: recoveryPermit ? undefined : scope.goalId, ownerSessionId: scope.goalOwnerSessionId, legacyIdentity,
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

/**
 * Driver fencing must outlive the active Goal projection.  A recovered Goal can
 * complete while an old browser turn is still alive or waiting on a tool
 * approval.  Limiting fencing to `goal.status === active` allowed that stale,
 * terminal Worker to enter a side-effect handler after completion.  Only
 * sessions known to Relay are constrained here; ordinary non-Relay clients
 * retain their existing behavior.
 */
async function assertRelayWorkerMutationFence(workspaceRoot: string, callerSessionId?: string): Promise<void> {
  if (!relayEnabled() || !callerSessionId) return;
  const lease = await readDriverLease(workspaceRoot);
  const registry = await readWorkerRegistry(workspaceRoot);
  const workers = Object.values(registry.workers).filter((worker) => worker.bound_session_id === callerSessionId);

  const terminal = new Set(["DEAD", "FAILED", "RETIRED"]);
  const liveWorkers = workers.filter((worker) => !terminal.has(worker.state));
  if (workers.length > 0 && liveWorkers.length === 0) {
    throw new Error("DRIVER_WORKER_FENCED: this Relay Worker is terminal and cannot perform side effects");
  }

  // A handoff predecessor may have no Worker record. Its durable Driver history
  // still fences it after ownership moves, including after the successor stops.
  if (lease && lease.owner_session_id !== callerSessionId) {
    throw new Error("DRIVER_LEASE_LOST: this Relay session does not own the scoped Driver lease");
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function findRequestContext(callbackArgs: readonly unknown[]): RequestContext | undefined {
  const candidate = callbackArgs[callbackArgs.length - 1];
  if (!isRequestContextLike(candidate)) return undefined;

  return {
    // OpenAI tunnel command dispatch can create a fresh transport-level MCP
    // session for every tool call while keeping one stable workflow request
    // id for the ChatGPT turn/workflow. Goal/task ownership must follow that
    // stable workflow identity rather than the ephemeral transport session.
    // Fall back to the SDK sessionId for ordinary MCP clients.
    sessionId:
      conversationSessionIdFromMeta(candidate._meta) ??
      conversationSessionIdFromHeaders(candidate.requestInfo?.headers) ??
      getMcpRequestIdentity()?.conversationSessionId ??
      (typeof candidate.sessionId === "string" ? candidate.sessionId : undefined),
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
