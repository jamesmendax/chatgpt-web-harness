import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import { redactSensitiveText } from "../lib/activity-log.js";
import {
  getActiveTaskId,
  getDurableTask,
  planActiveDurableTaskSessionRebind,
  recoverGoalTaskSessionRebind,
  runWithActiveDurableTaskSessionRebind,
  updateDurableTask,
} from "../lib/durable-tasks.js";
import { goalWatchdogStatus, startGoalWatchdog, stopGoalWatchdog } from "../lib/goal-watchdog.js";
import {
  createGoal,
  getGoalCreationStatus,
  recoverGoalCreation,
  getGoal,
  GOAL_CONTINUATION_CONTRACT,
  GOAL_GROUNDING_NOTE,
  GOAL_WATCHDOG_POLICY,
  bindGoalToSession,
  getGoalTakeoverCandidate,
  getGoalBindSource,
  goalVisibleToSession,
  goalSummary,
  goalTakeoverToken,
} from "../lib/goals.js";
import {
  confirmGoalRunCriterion,
  ensureGoalRunAuthority,
  synchronizeCommittedLegacyGoal,
  transitionGoalRunLifecycle,
  updateGoalRunDefinition,
} from "../lib/goal-run-web.js";
import { renderGoalRunPolicyText } from "../lib/goal-run-policy.js";
import { goalRunIsTerminal, readGoalRun, rebindGoalRunSession, type GoalRunEnvelope } from "../lib/goal-run-store.js";
import {
  inheritAcceptedExecutionContractState,
  readAcceptedExecutionContractState,
} from "../lib/execution-contract.js";
import {
  activeDriverMutationCount,
  assessDriverOrphanRecovery,
  commitDriverOrphanRecovery,
  prepareDriverOrphanRecovery,
  readDriverLease,
  releaseDriverLease,
  relayEnabled,
} from "../lib/driver-lease.js";
import { boundedGoalRunView, DEFAULT_GOAL_EVIDENCE_PAGE_SIZE, MAX_GOAL_EVIDENCE_PAGE_SIZE } from "../lib/goal-run-view.js";
import { readHandoffSnapshot } from "../lib/handoff-store.js";
import { getRuntimeScope } from "../lib/runtime-scope.js";
import {
  claimRelayAuthorityFromBrowserReceipt,
  getRelayRecoveryCommand,
  claimRelayBootstrapCapability,
  claimRelayBootstrapCapabilityFromBrowserReceipt,
  enqueueRelayRecoveryContinuation,
  markRelayRecoveryCommitted,
  readRelayManagerState,
  recordRelayCapabilityProof,
  recoveryAuthorizationForCommand,
  relayLaneIsFresh,
  relayLaneObservation,
} from "../lib/relay-manager.js";
import {
  consumeWorkerClaimTicket,
  markWorkerActiveForSession,
  readWorkerRegistry,
  recordWorkerCapabilityProofBySession,
  verifyWorkerClaimTicket,
  workerReadyForAuthority,
} from "../lib/worker-registry.js";
import {
  commitRelayHandoff,
  readRelayControlStatus,
  validateRelayBind,
} from "../lib/relay-control.js";
import { listAuthorityBlockingOperationInspections } from "../lib/operation-journal.js";
import { currentRelayGoal, resolveRelayGoalForTransition, withRelayGoalTransition } from "../lib/relay-scope.js";

const actionSchema = z.enum([
  "create",
  "status",
  "probe",
  "reconcile",
  "update",
  "confirm",
  "bind",
  "pause",
  "resume",
  "complete",
  "cancel",
]);

// Explicit cancellation reports whether task cleanup completed. New Goal
// creation uses the recoverable coordinator with its fixed old task identity.
async function cancelStaleDurableTask(workspaceRoot: string, reason: string): Promise<boolean> {
  try {
    const taskId = await getActiveTaskId(workspaceRoot, getRuntimeScope()?.mcpSessionId);
    if (!taskId) return true;
    const task = await getDurableTask(workspaceRoot, taskId);
    if (task.status === "active" || task.status === "blocked") {
      await updateDurableTask(workspaceRoot, taskId, { status: "cancelled", current_step: reason });
    }
    return true;
  } catch (error) {
    console.warn(`[goal] stale durable task cleanup failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

function syncGoalWatchdog(workspaceRoot: string, status: string) {
  const sessionId = getRuntimeScope()?.mcpSessionId;
  if (process.env.GOAL_WATCHDOG_ENABLED === "false") {
    return { ...stopGoalWatchdog(workspaceRoot, sessionId), disabled: true };
  }
  return status === "active"
    ? startGoalWatchdog(workspaceRoot, sessionId)
    : stopGoalWatchdog(workspaceRoot, sessionId);
}

function executionContract(envelope?: GoalRunEnvelope | null): string {
  return GOAL_CONTINUATION_CONTRACT;
}
const criterionSchema = z.object({
  id: z.string().min(1).max(128).optional().describe("For update, the stable criterion ID returned by status; use it to rename an existing unconfirmed criterion."),
  name: z.string().min(1).max(300),
  passed: z.boolean().optional().default(false),
  detail: z.string().max(2000).optional(),
  requires_confirmation: z.boolean().optional(),
  verification: z.object({
    kind: z.enum(["command", "visual", "file_exists"]),
    target: z.string().min(1).max(2000).describe("Absolute test working directory, or visual/file target"),
    command: z.string().min(1).max(2000).optional().describe("Exact verification command for command checks"),
    files: z.array(z.string().min(1).max(2000)).min(1).max(128).optional().describe("Source/test files verified by the command; edits invalidate its evidence"),
  }).optional().describe("Optional verification details; file existence does not prove content or appearance."),
});

export function registerGoalTool(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "goal",
    {
      title: "Goal Mode",
      description:
        "Persistent Goal/GoalRun status, evidence, manual owner-confirmed binding, lifecycle, and watchdog control. Automatic cross-Chat handoff is retired. Create starts a new Goal and replaces this session's active or paused Goal; use resume/update to continue the existing Goal.",
      inputSchema: {
        action: actionSchema,
        objective: z.string().min(1).max(4000).optional(),
        success_criteria: z.array(z.union([criterionSchema, z.string().min(1).max(300).transform(name => ({ name, passed: false }))])).min(1).max(40).optional(),
        constraints: z.array(z.string().min(1).max(1000)).max(24).optional(),
        current_phase: z.string().max(2000).optional(),
        pause_kind: z.enum(["manual", "no_progress"]).optional(),
        expected_revision: z.number().int().positive().optional(),
        criterion: z.string().min(1).max(300).optional(),
        evidence_ids: z.array(z.string().max(128)).max(32).optional(),
        detail: z.string().max(2000).optional(),
        supersede: z.boolean().optional().describe("Compatibility flag for session-less clients; same-session create automatically replaces the prior Goal."),
        takeover_token: z.string().min(16).max(128).optional(),
        target_session_id: z.string().min(1).max(512).optional(),
        goal_id: z.string().min(1).max(128).optional().describe("For cross-session bind, select the exact Goal ID returned by status."),
        handoff_id: z.string().min(8).max(128).optional(),
        evidence_offset: z.number().int().nonnegative().optional().default(0),
        evidence_limit: z.number().int().min(1).max(MAX_GOAL_EVIDENCE_PAGE_SIZE).optional().default(DEFAULT_GOAL_EVIDENCE_PAGE_SIZE),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, objective, success_criteria, constraints, current_phase, pause_kind, expected_revision, criterion, evidence_ids, detail, supersede, takeover_token, target_session_id, goal_id, handoff_id, evidence_offset, evidence_limit }) => {
      if (handoff_id) throw new Error("RELAY_RETIRED: automatic Companion/Worker handoff identifiers are no longer accepted.");
      const executeAction = async () => {
      const mutationOptions = expected_revision === undefined ? undefined : { expectedRevision: expected_revision };
      const view = (envelope: GoalRunEnvelope) => boundedGoalRunView(envelope.run, evidence_offset, evidence_limit);
      try {
        const creation = await getGoalCreationStatus(workspaceRoot);
        if (creation.pending) {
          if (action === "status") {
            return toolResult("goal", {
              action, goal: null, goal_run: null, creation_transaction: creation,
              recovery_required: "Explicit goal(reconcile), or retry the same goal(create), to finish the prepared transaction.",
              watchdog_unchanged: true,
            }, { summary: "Goal creation is pending; status did not mutate or recover it" });
          }
          if (action === "reconcile") {
            if (expected_revision !== creation.new_goal_revision) {
              throw new Error("GOAL_STALE_REVISION: pending creation reconcile requires expected_revision=" + creation.new_goal_revision);
            }
            await recoverGoalCreation(workspaceRoot);
          }
          else if (action !== "create") throw new Error("GOAL_CREATION_PENDING: explicitly reconcile the prepared creation first.");
        }
        // ChatGPT snapshots connector schemas per conversation and can keep an
        // older goal action enum after the server upgrades.  Those schemas
        // already expose status, handoff_id, and takeover_token, so accept the
        // exact bootstrap command through status as a compatibility alias.
        // The one-time claim ticket remains the authority check; arbitrary
        // status calls cannot bind a Worker.
        const bootstrapStatusAlias = action === "status" && handoff_id?.trim().startsWith("bootstrap_worker_");
        const implicitBootstrapStatus = action === "status" && !handoff_id?.trim() && Boolean(currentRelayGoal(workspaceRoot));
        if (bootstrapStatusAlias || implicitBootstrapStatus) {
          const receiptSessionId = getRuntimeScope()?.mcpSessionId;
          if (receiptSessionId) {
            const receipt = await claimRelayBootstrapCapabilityFromBrowserReceipt(
              workspaceRoot,
              receiptSessionId,
              bootstrapStatusAlias ? handoff_id!.trim() : undefined
            );
            if (receipt) {
              return toolResult("goal", {
                action,
                bootstrap_action: "probe",
                compatibility_alias: "status",
                capability_verified: true,
                capability_proof: "authenticated_browser_delivery+fresh_mcp_arrival",
                driver_authority: receipt.driver_adopted,
                goal_id: receipt.command.goal_id,
                worker: {
                  worker_id: receipt.worker.worker_id,
                  lane: receipt.worker.lane,
                  generation: receipt.worker.generation,
                  state: receipt.worker.state,
                  bound_session: true,
                  capability_proved_at: receipt.worker.last_capability_at,
                },
                bootstrap_command_id: receipt.command.command_id,
                instruction: receipt.driver_adopted
                  ? "Browser delivery and current MCP arrival matched the Goal's Driver session. Continue the Goal normally."
                  : "Capability proof recorded. Do not continue this Goal until Relay grants Driver authority through HANDOFF or RECOVERY.",
              }, { summary: `worker capability verified by browser receipt: ${receipt.worker.worker_id}; Driver ${receipt.driver_adopted ? "adopted" : "unchanged"}` });
            }
          }
        }
        if (action === "probe" || bootstrapStatusAlias) {
          const probeSessionId = getRuntimeScope()?.mcpSessionId;
          if (!probeSessionId) throw new Error("RELAY_BOOTSTRAP_SESSION_REQUIRED: capability bootstrap requires an MCP session");
          if (!handoff_id?.trim()) throw new Error("RELAY_BOOTSTRAP_ID_REQUIRED: capability bootstrap requires the bootstrap command id in handoff_id");
          if (!takeover_token?.trim()) throw new Error("WORKER_CLAIM_REQUIRED: explicit capability bootstrap requires the one-time capability token");
          const claimed = await claimRelayBootstrapCapability(
            workspaceRoot,
            handoff_id.trim(),
            takeover_token.trim(),
            probeSessionId
          );
          return toolResult("goal", {
            action,
            bootstrap_action: "probe",
            compatibility_alias: bootstrapStatusAlias ? "status" : null,
            capability_verified: true,
            driver_authority: claimed.driver_adopted,
            goal_id: claimed.command.goal_id,
            worker: {
              worker_id: claimed.worker.worker_id,
              lane: claimed.worker.lane,
              generation: claimed.worker.generation,
              state: claimed.worker.state,
              bound_session: true,
              capability_proved_at: claimed.worker.last_capability_at,
            },
            bootstrap_command_id: claimed.command.command_id,
            instruction: claimed.driver_adopted
              ? "Capability proof matched the current Goal's existing Driver session. Browser Worker authority is active; continue the Goal normally."
              : "Capability proof recorded. Do not continue this Goal until Relay grants Driver authority through HANDOFF or RECOVERY.",
          }, { summary: `worker capability verified: ${claimed.worker.worker_id}; Driver ${claimed.driver_adopted ? "adopted" : "unchanged"}` });
        }
        if (action === "status" && handoff_id?.trim().startsWith("probe_")) {
          const probeSessionId = getRuntimeScope()?.mcpSessionId;
          if (!probeSessionId) {
            throw new Error("RELAY_CAPABILITY_PROBE_SESSION_REQUIRED: goal(status, handoff_id=<probe>) requires an MCP session");
          }
          const probeId = handoff_id.trim();
          await recordRelayCapabilityProof(workspaceRoot, probeId, probeSessionId);
          const proof = await recordWorkerCapabilityProofBySession(workspaceRoot, probeSessionId, probeId);
          if (!proof) {
            throw new Error("RELAY_CAPABILITY_PROBE_WORKER_MISSING: current MCP session is not bound to a provisioned Worker");
          }
        }
        if (action === "create") {
          if (!objective?.trim()) throw new Error("goal action=create requires objective");
          const criteria = success_criteria?.length ? success_criteria : [{ name: objective.trim(), passed: false }];
          const prePassed = criteria.find((candidate) => candidate.passed === true);
          if (prePassed) {
            throw new Error(
              `goal action=create cannot pre-pass criterion "${prePassed.name}"; criteria require typed evidence after the goal starts`
            );
          }
          const goal = await createGoal(workspaceRoot, {
            objective,
            success_criteria: criteria,
            constraints,
            current_phase,
            supersede,
          });
          return withRelayGoalTransition(workspaceRoot, currentRelayGoal(workspaceRoot), goal.id, async () => {
          const envelope = await ensureGoalRunAuthority(workspaceRoot, goal, {
            allowActiveSupersede: true,
          });
          const committedCreation = await getGoalCreationStatus(workspaceRoot);
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult(
            "goal",
            {
              action,
              goal,
              summary: goalSummary(goal),
              creation_transaction: committedCreation,
              ...(committedCreation.previous_goal_id ? { stale_task_cancelled: committedCreation.stale_task_cancelled } : {}),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              goal_run: view(envelope),
              execution_contract: executionContract(envelope),
            },
            { summary: `goal active: ${goal.id}` }
          );
          });
        }

        if (action === "reconcile") {
          const goal = await getGoal(workspaceRoot);
          const sessionId = getRuntimeScope()?.mcpSessionId;
          if (!goal || !goalVisibleToSession(goal, sessionId)) {
            throw new Error("GOAL_RECONCILE_UNAVAILABLE: no owned goal; existing state was preserved");
          }
          if (expected_revision === undefined || expected_revision !== goal.revision) {
            throw new Error(`GOAL_STALE_REVISION: reconcile requires the current stored goal revision ${goal.revision}`);
          }
          const envelope = await ensureGoalRunAuthority(workspaceRoot, goal);
          const current = (await getGoal(workspaceRoot)) ?? goal;
          return toolResult("goal", {
            action, goal: current, goal_run: view(envelope), summary: goalSummary(current),
            watchdog: syncGoalWatchdog(workspaceRoot, current.status),
            watchdog_policy: GOAL_WATCHDOG_POLICY,
            execution_contract: executionContract(envelope),
          }, { summary: "owned GoalRun authority reconciled" });
        }

        if (action === "status") {
          const relay = currentRelayGoal(workspaceRoot)
            ? await readRelayControlStatus(workspaceRoot)
            : { enabled: relayEnabled(), driver_lease: null, prepared_handoff: null, goal_scope: null };
          const goal = await getGoal(workspaceRoot);
          const sessionId = getRuntimeScope()?.mcpSessionId;
          if (goal && !goalVisibleToSession(goal, sessionId)) {
            return toolResult(
              "goal",
              {
                action,
                goal: null,
                goal_run: null,
                summary: null,
                foreign_goal: {
                  goal_id: goal.id,
                  status: goal.status,
                  revision: goal.revision,
                  owner_session_hint: goal.owner_session ? `${goal.owner_session.slice(0, 8)}…` : null,
                  preserved: true,
                  adoption_requires: "Explicit goal(action=bind); do not bind or supersede automatically.",
                },
                watchdog_unchanged: true,
                watchdog_policy: GOAL_WATCHDOG_POLICY,
                relay,
              },
              { summary: "goal belongs to another ChatGPT window and was preserved" }
            );
          }
          if (!goal && sessionId) {
            const takeoverCandidate = await getGoalTakeoverCandidate(workspaceRoot, sessionId);
            if (takeoverCandidate) {
              return toolResult(
                "goal",
                {
                  action,
                  goal: null,
                  goal_run: null,
                  summary: null,
                  takeover_candidate: takeoverCandidate,
                  target_selection_required: true,
                  watchdog: goalWatchdogStatus(workspaceRoot, sessionId),
                  watchdog_unchanged: true,
                  watchdog_policy: GOAL_WATCHDOG_POLICY,
                  relay,
                },
                { summary: "another ChatGPT window owns an active goal; select its exact ID to bind" }
              );
            }
          }
          // Status observes persisted facts. Migration and watchdog lifecycle belong
          // to explicit mutation actions, never to an ordinary status query.
          const storedRevision = goal?.revision;
          const envelope = goal ? await readGoalRun(workspaceRoot, sessionId) : null;
          if (goal && envelope && envelope.run.runId !== goal.id) {
            throw new Error("GOAL_STATUS_IDENTITY_MISMATCH: stored Goal and GoalRun differ; no state changed");
          }
          const parity = envelope?.parity;
          const repairPending = parity !== null && typeof parity === "object" && "repairPending" in parity && parity.repairPending === true;
          // Evidence-only revisions may be ahead of the legacy projection. Keep
          // the existing goal.revision mutation contract; lifecycle truth is goal_run.
          const reconciliationRequired = Boolean(goal && (!envelope || envelope.shadow || repairPending));
          const watchdog = goalWatchdogStatus(workspaceRoot, sessionId);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: envelope ? view(envelope) : null,
              summary: goal ? goalSummary(goal) : null,
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              relay,
              status_read_only: true,
              watchdog_unchanged: true,
              stored_goal_revision: storedRevision ?? null,
              authoritative_revision: envelope?.run.revision ?? null,
              reconciliation_required: reconciliationRequired,
              ...(reconciliationRequired ? { recovery_action: "goal(action=reconcile, expected_revision=stored_goal_revision)" } : {}),
              ...(envelope ? { execution_contract: executionContract(envelope) } : {}),
            },
            { summary: goal ? `goal ${goal.status}: ${goal.id}` : "no goal" }
          );
        }

        if (action === "update") {
          const updated = await updateGoalRunDefinition(workspaceRoot, {
            objective,
            success_criteria,
            constraints,
            current_phase,
          }, expected_revision);
          const goal = updated.goal;
          const envelope = updated.envelope;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: view(envelope),
              summary: goalSummary(goal),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(needsWork
                ? { has_unverified_criteria: true, execution_contract: executionContract(envelope) }
                : {}),
            },
            { summary: `goal updated: ${goal.id}` }
          );
        }

        if (action === "confirm") {
          if (!criterion?.trim()) throw new Error("goal action=confirm requires criterion");
          const confirmed = await confirmGoalRunCriterion(workspaceRoot, {
            criterion,
            evidenceIds: evidence_ids,
            detail,
            expectedRevision: expected_revision,
          });
          const goal = confirmed.goal;
          const envelope = confirmed.envelope;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: view(envelope),
              summary: goalSummary(goal),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(needsWork
                ? { has_unverified_criteria: true, execution_contract: executionContract(envelope) }
                : {}),
            },
            { summary: `criterion confirmed: ${criterion}` }
          );
        }

        if (action === "bind") {
          const targetSession = getRuntimeScope()?.mcpSessionId;
          if (!targetSession) throw new Error("goal(action=bind) requires a ChatGPT session context (none available).");
          const ownedGoal = await getGoal(workspaceRoot, targetSession);
          const selectedGoalId = currentRelayGoal(workspaceRoot);
          if (ownedGoal?.owner_session === targetSession && ["active", "paused"].includes(ownedGoal.status) &&
              selectedGoalId && selectedGoalId !== ownedGoal.id) {
            throw new Error("GOAL_BIND_DESTINATION_CONFLICT: this session already owns another nonterminal Goal.");
          }
          const destinationRun = await readGoalRun(workspaceRoot, targetSession);
          if (selectedGoalId && destinationRun && destinationRun.run.runId !== selectedGoalId && !goalRunIsTerminal(destinationRun)) {
            throw new Error("GOAL_BIND_DESTINATION_CONFLICT: this session contains another nonterminal GoalRun.");
          }

          if (handoff_id?.trim().startsWith("recover_worker_")) {
            const recoveryId = handoff_id.trim();
            let claimToken = takeover_token?.trim();
            if (!claimToken) {
              const browserReceipt = await claimRelayAuthorityFromBrowserReceipt(
                workspaceRoot,
                targetSession,
                recoveryId,
                "RECOVERY"
              );
              claimToken = browserReceipt.internal_claim_token;
            }
            const recovery = await getRelayRecoveryCommand(workspaceRoot, recoveryId);
            const workerId = recovery.worker_id;
            if (!workerId) throw new Error("RELAY_RECOVERY_TARGET_MISSING: recovery command has no target Worker");
            const policyAuthorization = recoveryAuthorizationForCommand(recovery);
            const currentLease = await readDriverLease(workspaceRoot);
            if (!currentLease) throw new Error("DRIVER_RECOVERY_LEASE_MISSING: recovery source Driver lease is missing");
            if (
              currentLease.goal_id !== recovery.goal_id ||
              currentLease.epoch !== recovery.expected_source_driver_epoch ||
              currentLease.lease_id !== recovery.expected_source_lease_id ||
              currentLease.owner_session_id === targetSession
            ) {
              throw new Error("DRIVER_RECOVERY_FENCE_MISMATCH: recovery command no longer matches the exact stale Driver epoch/lease/owner");
            }
            await verifyWorkerClaimTicket(workspaceRoot, {
              workerId,
              handoffId: recovery.command_id,
              token: claimToken,
              targetSessionId: targetSession,
              kind: "RECOVERY",
            });
            const registry = await readWorkerRegistry(workspaceRoot);
            const sourceWorker = recovery.source_worker_id ? registry.workers[recovery.source_worker_id] : null;
            const targetWorker = registry.workers[workerId];
            if (!sourceWorker || sourceWorker.bound_session_id !== currentLease.owner_session_id) {
              throw new Error("RELAY_RECOVERY_SOURCE_MISMATCH: durable source Worker does not map to the current Driver owner");
            }
            if (!targetWorker || targetWorker.lane !== recovery.lane || targetWorker.generation !== recovery.generation || targetWorker.provision_id !== recovery.provision_id) {
              throw new Error("RELAY_RECOVERY_TARGET_MISMATCH: recovery Worker identity no longer matches its command");
            }
            if (!workerReadyForAuthority(targetWorker)) {
              throw new Error("RELAY_RECOVERY_TARGET_NOT_READY: successor requires a formal conversation plus session-bound fresh MCP capability proof before Driver recovery");
            }
            const sourceSeenMs = sourceWorker.last_browser_seen_at ? Date.parse(sourceWorker.last_browser_seen_at) : Number.NaN;
            const sourceObservation = {
              lane_observed: Boolean(sourceWorker.last_browser_seen_at),
              lane_fresh: Number.isFinite(sourceSeenMs) && Date.now() - sourceSeenMs <= 30_000,
              generation_active: sourceWorker.generation_active,
              // Browser DOM is not authoritative for tool execution. Side-effect
              // safety is guarded by the process-local Driver mutation counter.
              tool_inflight_count: 0,
            };
            const sourceMutationCount = activeDriverMutationCount(workspaceRoot, currentLease.lease_id);
            const unresolvedOperations = await listAuthorityBlockingOperationInspections(workspaceRoot, currentLease.acquired_at);
            if (unresolvedOperations.length > 0) {
              throw new Error(`DRIVER_ORPHAN_RECOVERY_NOT_READY: unresolved_operation_effects:${unresolvedOperations.length}`);
            }
            const assessment = assessDriverOrphanRecovery(currentLease, {
              sourceSessionId: currentLease.owner_session_id,
              targetSessionId: targetSession,
              explicitTakeoverAuthorized: false,
              authorization: policyAuthorization,
              observation: sourceObservation,
              activeMutationCount: sourceMutationCount,
            });
            if (!assessment.eligible) {
              throw new Error(`DRIVER_ORPHAN_RECOVERY_NOT_READY: ${assessment.reasons.join(",")}`);
            }

            const goalBeforeRecovery = await getGoal(workspaceRoot, currentLease.owner_session_id);
            if (!goalBeforeRecovery || goalBeforeRecovery.id !== currentLease.goal_id || goalBeforeRecovery.owner_session !== currentLease.owner_session_id) {
              throw new Error("RELAY_RECOVERY_GOAL_OWNER_MISMATCH: Goal owner changed before recovery bind");
            }
            const sourceSessionId = currentLease.owner_session_id;
            await planActiveDurableTaskSessionRebind(workspaceRoot, sourceSessionId, targetSession, currentLease.goal_id);
            const sourceContract = await readAcceptedExecutionContractState(workspaceRoot, sourceSessionId, currentLease.goal_id);
            if (
              !sourceContract ||
              sourceContract.requirement_hash !== currentLease.execution_contract_hash ||
              sourceContract.intent_revision !== currentLease.intent_revision ||
              !sourceContract.canonical_requirement_json
            ) {
              throw new Error("DRIVER_CONTRACT_MISMATCH: recovery source does not have the fenced accepted Execution Contract");
            }
            const inheritedContract = await inheritAcceptedExecutionContractState(
              workspaceRoot,
              sourceSessionId,
              targetSession,
              currentLease.execution_contract_hash,
              currentLease.intent_revision,
              currentLease.goal_id
            );
            await rebindGoalRunSession(workspaceRoot, sourceSessionId, targetSession);
            const prepared = await prepareDriverOrphanRecovery(workspaceRoot, {
              goalId: currentLease.goal_id,
              sourceSessionId,
              targetSessionId: targetSession,
              explicitTakeoverAuthorized: false,
              authorization: policyAuthorization,
              observation: sourceObservation,
            });
            const rebound = await runWithActiveDurableTaskSessionRebind(
              workspaceRoot,
              sourceSessionId,
              targetSession,
              () => bindGoalToSession(workspaceRoot, { expectedRevision: goalBeforeRecovery.revision, expectedGoalId: currentLease.goal_id, sourceSessionId }),
              currentLease.goal_id
            );
            const recoveredLease = await commitDriverOrphanRecovery(workspaceRoot, {
              goalId: rebound.value.id,
              sourceSessionId,
              targetSessionId: targetSession,
              sourceEpoch: prepared.source_epoch,
              sourceLeaseId: prepared.source_lease_id,
              executionContractHash: currentLease.execution_contract_hash,
              intentRevision: currentLease.intent_revision,
            });
            await consumeWorkerClaimTicket(workspaceRoot, {
              workerId,
              handoffId: recovery.command_id,
              token: claimToken,
              targetSessionId: targetSession,
              kind: "RECOVERY",
            });
            await markWorkerActiveForSession(workspaceRoot, workerId, targetSession, `automatic_orphan_recovery:${recovery.command_id}`);
            await markRelayRecoveryCommitted(workspaceRoot, recovery.command_id, targetSession);
            const envelope = await synchronizeCommittedLegacyGoal(workspaceRoot, rebound.value);
            const goal = await getGoal(workspaceRoot);
            if (!goal || goal.id !== rebound.value.id) {
              throw new Error(`GOAL_BIND_PROJECTION_MISSING: synchronized goal ${rebound.value.id} is not readable after recovery bind.`);
            }
            const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
            const needsWork = goal.status === "active" && goal.success_criteria.some((item) => !item.passed);
            const recoveryContinuation = needsWork
              ? await enqueueRelayRecoveryContinuation(workspaceRoot, {
                  recoveryId: recovery.command_id,
                  workerId,
                  goalRevision: goal.revision,
                  instruction: JSON.stringify({
                    objective: goal.objective.slice(0, 2_000),
                    current_phase: goal.current_phase.slice(0, 1_000),
                    pending_criteria: goal.success_criteria
                      .filter((item) => !item.passed)
                      .slice(0, 20)
                      .map((item) => ({ name: item.name.slice(0, 500), detail: (item.detail ?? item.name).slice(0, 1_000) })),
                    constraints: goal.constraints.slice(0, 20).map((item) => item.slice(0, 700)),
                    goal_run_next_action: envelope.run.nextAction?.slice(0, 1_000) ?? null,
                  }),
                })
              : null;
            return toolResult(
              "goal",
              {
                action,
                goal,
                goal_run: view(envelope),
                summary: goalSummary(goal),
                durable_task_rebind: rebound.durable_task_rebind,
                driver_lease: recoveredLease,
                automatic_orphan_recovery: true,
                recovery_id: recovery.command_id,
                worker_id: workerId,
                recovery_continuation_command_id: recoveryContinuation?.command_id ?? null,
                relay_intent_json: inheritedContract.canonical_requirement_json,
                watchdog,
                watchdog_policy: GOAL_WATCHDOG_POLICY,
                ...(needsWork ? { has_unverified_criteria: true, execution_contract: executionContract(envelope) } : {}),
              },
              { summary: `goal recovered on ${workerId}: ${goal.id}` }
            );
          }

          const requestedHandoffId = handoff_id?.trim();
          let relayClaimToken = takeover_token?.trim();
          if (requestedHandoffId && !relayClaimToken) {
            const handoff = await readHandoffSnapshot(workspaceRoot, requestedHandoffId);
            if (handoff?.target_worker_id) {
              const browserReceipt = await claimRelayAuthorityFromBrowserReceipt(
                workspaceRoot,
                targetSession,
                requestedHandoffId,
                "HANDOFF"
              );
              relayClaimToken = browserReceipt.internal_claim_token;
            }
          }
          const relayAuthorization = requestedHandoffId
            ? await validateRelayBind(workspaceRoot, requestedHandoffId, targetSession, relayClaimToken)
            : null;
          const ownedLease = ownedGoal && relayEnabled() ? await readDriverLease(workspaceRoot, ownedGoal.id) : null;
          const needsOwnedOrphanRepair = Boolean(ownedGoal && ownedLease &&
            ownedLease.goal_id === ownedGoal.id && ownedLease.owner_session_id !== targetSession);
          if ((relayAuthorization?.already_bound || (!relayAuthorization && !requestedHandoffId)) &&
              currentRelayGoal(workspaceRoot) === ownedGoal?.id &&
              ownedGoal?.owner_session === targetSession &&
              !needsOwnedOrphanRepair &&
              // The Driver may already own the target while its Resume Bundle
              // is still PREPARED after a crash. Do not early-return before
              // commitRelayHandoff replays the exact missing bundle commit.
              (!relayAuthorization || relayAuthorization.resume_bundle.state === "COMMITTED")) {
            if (relayAuthorization?.already_bound) {
              const inherited = await readAcceptedExecutionContractState(workspaceRoot, targetSession, relayAuthorization.goal.id);
              if (!inherited || inherited.requirement_hash !== relayAuthorization.driver_lease.execution_contract_hash ||
                  inherited.intent_revision !== relayAuthorization.driver_lease.intent_revision || !inherited.canonical_requirement_json) {
                throw new Error("RELAY_EXECUTION_CONTRACT_TARGET_MISSING: bound target is missing the inherited execution contract.");
              }
            }
            const unchanged = await bindGoalToSession(workspaceRoot, { expectedGoalId: ownedGoal.id });
            const durableTaskRebind = await recoverGoalTaskSessionRebind(workspaceRoot, unchanged.id, targetSession);
            const existingRun = await readGoalRun(workspaceRoot, targetSession);
            return toolResult("goal", {
              action, result: "ALREADY_BOUND", already_bound: true, goal: unchanged,
              goal_run: existingRun ? view(existingRun) : null, summary: goalSummary(unchanged),
              durable_task_rebind: durableTaskRebind, watchdog_unchanged: true,
              ...(relayAuthorization ? { relay_handoff: relayAuthorization.handoff, driver_lease: relayAuthorization.driver_lease, relay_takeover: true } : {}),
            }, { summary: "ALREADY_BOUND: Goal already belongs to this ChatGPT session" });
          }
          const takeoverCandidate = relayAuthorization || needsOwnedOrphanRepair
            ? null
            : await getGoalTakeoverCandidate(workspaceRoot, targetSession);
          if (takeoverCandidate && takeoverCandidate.goal_id !== currentRelayGoal(workspaceRoot)) {
            throw new Error("GOAL_BIND_SOURCE_CHANGED: discovery changed after this bind selected its Goal.");
          }
          let ordinaryTakeoverAuthorized = false;
          if (takeoverCandidate) {
            if (!goal_id || goal_id !== takeoverCandidate.goal_id) {
              return toolResult("goal", {
                action, error: "GOAL_BIND_TARGET_REQUIRED", takeover_candidate: takeoverCandidate,
              }, { ok: false, summary: "select the exact Goal ID before binding" });
            }
            if (expected_revision !== takeoverCandidate.revision) {
              return toolResult(
                "goal",
                {
                  action,
                  error: "GOAL_TAKEOVER_REVISION_REQUIRED",
                  takeover_candidate: takeoverCandidate,
                  expected_revision_required: takeoverCandidate.revision,
                },
                { ok: false, summary: "cross-window goal takeover requires the current goal revision" }
              );
            }
            // Legacy takeover_token is accepted but carries no authority.
            ordinaryTakeoverAuthorized = true;
          }

          // Ordinary Goal takeover used to move Goal/GoalRun/task ownership but
          // leave the Relay Driver on the old Chat session. If that old Chat had
          // already lost its App/tool binding, the workspace became permanently
          // fenced. Repair that gap through an explicit ORPHANED stage instead
          // of treating expires_at as autonomous authority transfer.
          let orphanPrepared: Awaited<ReturnType<typeof prepareDriverOrphanRecovery>> | null = null;
          let orphanSourceSession: string | null = null;
          let orphanContractHash: string | null = null;
          let orphanIntentRevision: number | null = null;
          let orphanAlreadyBound = false;
          let orphanIntentJson: string | undefined;
          // Handoff authorization already identifies the authoritative source.
          // Ordinary discovery is checked against the captured action scope.
          const goalBeforeBind = relayAuthorization?.goal ?? (needsOwnedOrphanRepair ? ownedGoal : await getGoalBindSource(workspaceRoot));
          if (goalBeforeBind && goalBeforeBind.id !== currentRelayGoal(workspaceRoot)) {
            throw new Error("GOAL_BIND_SOURCE_CHANGED: the authoritative source differs from this bind's Goal scope.");
          }
          const currentDriverLease = !relayAuthorization && relayEnabled()
            ? await readDriverLease(workspaceRoot)
            : null;
          if (
            !relayAuthorization &&
            goalBeforeBind &&
            currentDriverLease &&
            currentDriverLease.goal_id === goalBeforeBind.id &&
            currentDriverLease.owner_session_id !== targetSession
          ) {
            const sourceSessionId = currentDriverLease.owner_session_id;
            const freshExplicitTakeover = Boolean(
              ordinaryTakeoverAuthorized &&
              takeoverCandidate?.goal_id === goalBeforeBind.id &&
              goalBeforeBind.owner_session === sourceSessionId
            );
            // Recovery from a mismatch already created by an older build is
            // authorized by the durable Goal ownership that was previously
            // moved with a valid takeover token. It still must pass every
            // liveness/fencing gate below.
            orphanAlreadyBound = goalBeforeBind.owner_session === targetSession;
            if (!freshExplicitTakeover && !orphanAlreadyBound) {
              throw new Error("DRIVER_ORPHAN_RECOVERY_UNAUTHORIZED: Goal takeover authorization does not match the stale Driver");
            }

            const manager = await readRelayManagerState(workspaceRoot);
            const activeLaneState = manager.active_lane ? manager.lanes[manager.active_lane] : null;
            const activeLane = relayLaneObservation(activeLaneState);
            const recoveryRegistry = await readWorkerRegistry(workspaceRoot);
            const targetCapabilityWorker = Object.values(recoveryRegistry.workers).find(
              (worker) => worker.bound_session_id === targetSession && workerReadyForAuthority(worker)
            );
            if (!targetCapabilityWorker) {
              throw new Error("DRIVER_ORPHAN_RECOVERY_NOT_READY: successor_capability_not_verified");
            }
            const observation = {
              lane_observed: Boolean(activeLane),
              lane_fresh: relayLaneIsFresh(activeLaneState),
              generation_active: activeLane?.generation_active ?? false,
              tool_inflight_count: activeLane?.tool_inflight_count ?? 0,
            };

            const sourceMutationCount = activeDriverMutationCount(workspaceRoot, currentDriverLease.lease_id);
            const unresolvedOperations = await listAuthorityBlockingOperationInspections(workspaceRoot, currentDriverLease.acquired_at);
            if (unresolvedOperations.length > 0) {
              throw new Error(`DRIVER_ORPHAN_RECOVERY_NOT_READY: unresolved_operation_effects:${unresolvedOperations.length}`);
            }

            if (currentDriverLease.state !== "ORPHANED") {
              const assessment = assessDriverOrphanRecovery(currentDriverLease, {
                sourceSessionId,
                targetSessionId: targetSession,
                explicitTakeoverAuthorized: freshExplicitTakeover || orphanAlreadyBound,
                observation,
                activeMutationCount: sourceMutationCount,
              });
              if (!assessment.eligible) {
                throw new Error(`DRIVER_ORPHAN_RECOVERY_NOT_READY: ${assessment.reasons.join(",")}`);
              }
            }

            // Fail predictable destination conflicts before fencing the stale
            // Driver. The normal bind path repeats this preflight under its task
            // workspace lock, so a later race remains fail-closed and retryable.
            if (!orphanAlreadyBound) {
              await planActiveDurableTaskSessionRebind(workspaceRoot, sourceSessionId, targetSession, currentDriverLease.goal_id);
            }

            let inheritedContract = await readAcceptedExecutionContractState(
              workspaceRoot,
              orphanAlreadyBound ? targetSession : sourceSessionId,
              currentDriverLease.goal_id
            );
            if (
              orphanAlreadyBound &&
              (!inheritedContract ||
                inheritedContract.requirement_hash !== currentDriverLease.execution_contract_hash ||
                inheritedContract.intent_revision !== currentDriverLease.intent_revision ||
                !inheritedContract.canonical_requirement_json)
            ) {
              inheritedContract = await inheritAcceptedExecutionContractState(
                workspaceRoot,
                sourceSessionId,
                targetSession,
                currentDriverLease.execution_contract_hash,
                currentDriverLease.intent_revision,
                currentDriverLease.goal_id
              );
            } else if (!orphanAlreadyBound) {
              if (
                !inheritedContract ||
                inheritedContract.requirement_hash !== currentDriverLease.execution_contract_hash ||
                inheritedContract.intent_revision !== currentDriverLease.intent_revision ||
                !inheritedContract.canonical_requirement_json
              ) {
                throw new Error("DRIVER_CONTRACT_MISMATCH: stale Driver does not have its persisted accepted Execution Contract");
              }
              inheritedContract = await inheritAcceptedExecutionContractState(
                workspaceRoot,
                sourceSessionId,
                targetSession,
                currentDriverLease.execution_contract_hash,
                currentDriverLease.intent_revision,
                currentDriverLease.goal_id
              );
              await rebindGoalRunSession(workspaceRoot, sourceSessionId, targetSession);
            }

            if (
              !inheritedContract ||
              inheritedContract.requirement_hash !== currentDriverLease.execution_contract_hash ||
              inheritedContract.intent_revision !== currentDriverLease.intent_revision ||
              !inheritedContract.canonical_requirement_json
            ) {
              throw new Error("DRIVER_CONTRACT_MISMATCH: orphan recovery target does not hold the stale Driver Execution Contract");
            }

            orphanIntentJson = inheritedContract.canonical_requirement_json;
            orphanSourceSession = sourceSessionId;
            orphanContractHash = currentDriverLease.execution_contract_hash;
            orphanIntentRevision = currentDriverLease.intent_revision;
            orphanPrepared = await prepareDriverOrphanRecovery(workspaceRoot, {
              goalId: goalBeforeBind.id,
              sourceSessionId,
              targetSessionId: targetSession,
              explicitTakeoverAuthorized: freshExplicitTakeover || orphanAlreadyBound,
              observation,
            });
          }

          const sourceSession = relayAuthorization?.handoff.source_session_id ?? goalBeforeBind?.owner_session;
          let boundGoal;
          let durableTaskRebind;
          let relayIntentJson: string | undefined;
          if (orphanPrepared && orphanAlreadyBound && goalBeforeBind) {
            // Compatibility repair for the exact 0.2.8 failure we observed:
            // Goal ownership already moved to this Chat but Driver authority did
            // not. Rebinding the Goal a second time is both unnecessary and
            // rejected by bindGoalToSession because this session already owns a
            // Goal shard. Keep durable Goal/GoalRun truth in place and only
            // finish the fenced Driver recovery below.
            boundGoal = goalBeforeBind;
            durableTaskRebind = await recoverGoalTaskSessionRebind(workspaceRoot, boundGoal.id, targetSession);
          } else if (relayAuthorization?.already_bound) {
            const inherited = await readAcceptedExecutionContractState(workspaceRoot, targetSession, relayAuthorization.goal.id);
            if (
              !inherited ||
              inherited.requirement_hash !== relayAuthorization.driver_lease.execution_contract_hash ||
              inherited.intent_revision !== relayAuthorization.driver_lease.intent_revision ||
              !inherited.canonical_requirement_json
            ) {
              throw new Error(
                "RELAY_EXECUTION_CONTRACT_TARGET_MISSING: bound relay target does not have the inherited canonical Execution Contract"
              );
            }
            relayIntentJson = inherited.canonical_requirement_json;
            boundGoal = relayAuthorization.goal;
            durableTaskRebind = await recoverGoalTaskSessionRebind(workspaceRoot, boundGoal.id, targetSession);
          } else {
            const relayMutationOptions = relayAuthorization
              ? { expectedRevision: relayAuthorization.handoff.goal_revision, expectedGoalId: relayAuthorization.goal.id, sourceSessionId: sourceSession }
              : { ...mutationOptions, expectedGoalId: goalBeforeBind?.id, sourceSessionId: sourceSession };
            // A/B relay alternates between the same two ChatGPT sessions. The
            // standby lane can therefore contain a stale GoalRun shard from a
            // previous epoch. Refresh it from the current Driver before moving
            // Goal ownership so typed evidence/revision truth survives every
            // A -> B -> A cycle instead of being reconstructed from goal.json.
            if (relayAuthorization && sourceSession) {
              const inherited = await inheritAcceptedExecutionContractState(
                workspaceRoot,
                sourceSession,
                targetSession,
                relayAuthorization.driver_lease.execution_contract_hash,
                relayAuthorization.driver_lease.intent_revision,
                relayAuthorization.goal.id
              );
              relayIntentJson = inherited.canonical_requirement_json;
              await rebindGoalRunSession(workspaceRoot, sourceSession, targetSession);
            }
            const rebound = await runWithActiveDurableTaskSessionRebind(
              workspaceRoot,
              sourceSession,
              targetSession,
              () => bindGoalToSession(workspaceRoot, relayMutationOptions),
              goalBeforeBind?.id
            );
            boundGoal = rebound.value;
            durableTaskRebind = rebound.durable_task_rebind;
          }
          const relayDriverLease = relayAuthorization
            ? await commitRelayHandoff(workspaceRoot, relayAuthorization.handoff.handoff_id, targetSession, relayClaimToken)
            : null;
          const orphanDriverLease = orphanPrepared && orphanSourceSession && orphanContractHash && orphanIntentRevision !== null
            ? await commitDriverOrphanRecovery(workspaceRoot, {
                goalId: boundGoal.id,
                sourceSessionId: orphanSourceSession,
                targetSessionId: targetSession,
                sourceEpoch: orphanPrepared.source_epoch,
                sourceLeaseId: orphanPrepared.source_lease_id,
                executionContractHash: orphanContractHash,
                intentRevision: orphanIntentRevision,
              })
            : null;
          const envelope = await synchronizeCommittedLegacyGoal(workspaceRoot, boundGoal);
          const goal = await getGoal(workspaceRoot);
          if (!goal || goal.id !== boundGoal.id) {
            throw new Error(`GOAL_BIND_PROJECTION_MISSING: synchronized goal ${boundGoal.id} is not readable after bind.`);
          }
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          const needsWork = goal.status === "active" && goal.success_criteria.some((criterion) => !criterion.passed);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: view(envelope),
              summary: goalSummary(goal),
              durable_task_rebind: durableTaskRebind,
              ...(relayAuthorization
                ? {
                    relay_handoff: relayAuthorization.handoff,
                    driver_lease: relayDriverLease,
                    relay_takeover: true,
                    relay_intent_json: relayIntentJson,
                  }
                : {}),
              ...(orphanDriverLease
                ? {
                    driver_lease: orphanDriverLease,
                    orphan_recovery: true,
                    orphan_recovery_from_already_bound_goal: orphanAlreadyBound,
                    relay_intent_json: orphanIntentJson,
                  }
                : {}),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              ...(needsWork
                ? { has_unverified_criteria: true, execution_contract: executionContract(envelope) }
                : {}),
            },
            { summary: `goal bound: ${goal.id}` }
          );
        }

        if (action === "pause") {
          const paused = await transitionGoalRunLifecycle(workspaceRoot, "pause", {
            currentPhase: current_phase,
            pauseKind: pause_kind,
            expectedRevision: expected_revision,
          });
          const goal = paused.goal;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult("goal", { action, goal, goal_run: view(paused.envelope), summary: goalSummary(goal), watchdog, watchdog_policy: GOAL_WATCHDOG_POLICY }, { summary: `goal paused: ${goal.id}` });
        }

        if (action === "resume") {
          const resumed = await transitionGoalRunLifecycle(workspaceRoot, "resume", {
            currentPhase: current_phase,
            expectedRevision: expected_revision,
          });
          const goal = resumed.goal;
          const envelope = resumed.envelope;
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult(
            "goal",
            {
              action,
              goal,
              goal_run: view(envelope),
              summary: goalSummary(goal),
              watchdog,
              watchdog_policy: GOAL_WATCHDOG_POLICY,
              execution_contract: executionContract(envelope),
            },
            { summary: `goal active: ${goal.id}` }
          );
        }

        if (action === "complete") {
          const completed = await transitionGoalRunLifecycle(workspaceRoot, "complete", {
            expectedRevision: expected_revision,
            declaration: detail,
          });
          const goal = completed.goal;
          const driverLease = await releaseDriverLease(workspaceRoot, goal.id);
          const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
          return toolResult(
            "goal",
            { action, goal, goal_run: view(completed.envelope), goal_complete: true, completion_basis: completed.envelope.run.completionBasis, unverified_criteria: completed.envelope.run.criteria.filter(item => completed.envelope.run.completionBasis?.unverifiedCriterionIds.includes(item.id)), driver_lease: driverLease, grounding: GOAL_GROUNDING_NOTE, summary: goalSummary(goal), watchdog, watchdog_policy: GOAL_WATCHDOG_POLICY },
            { summary: `Goal ${goal.id} declared complete by model` }
          );
        }

        if (action !== "cancel") throw new Error("GOAL_ACTION_UNSUPPORTED: no state change performed");
        const cancelled = await transitionGoalRunLifecycle(workspaceRoot, "cancel", {
          expectedRevision: expected_revision,
        });
        const goal = cancelled.goal;
        const driverLease = await releaseDriverLease(workspaceRoot, goal.id);
        const staleTaskCancelled = await cancelStaleDurableTask(workspaceRoot, "Cancelled together with the goal");
        const watchdog = syncGoalWatchdog(workspaceRoot, goal.status);
        return toolResult("goal", { action, goal, goal_run: view(cancelled.envelope), driver_lease: driverLease, stale_task_cancelled: staleTaskCancelled, summary: goalSummary(goal), watchdog, watchdog_policy: GOAL_WATCHDOG_POLICY }, { summary: `goal cancelled: ${goal.id}` });
      } catch (error) {
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
        const code = message.match(/^([A-Z][A-Z0-9_]+):/)?.[1] ?? "GOAL_OPERATION_FAILED";
        return toolError("goal", message, {
          action,
          error_code: code,
          failure_layer: "local_goal_handler",
          host_approval_status: "not_observable_from_handler",
          state_may_have_changed: action !== "status",
          recovery: action === "status" ? "Inspect the local state error; do not overwrite or recreate state." : "Read status before any retry; retain the existing goal and evidence.",
        });
      }
      };
      // Resolve the action's exact Goal before entering Relay. Status without
      // an owned Goal must not discover or claim another Goal's Worker.
      const creation = await getGoalCreationStatus(workspaceRoot);
      const owned = creation.pending ? null : await getGoal(workspaceRoot);
      let actionGoalId: string | null | undefined = creation.pending ? creation.new_goal_id : owned?.id;
      if (handoff_id?.trim()) {
        actionGoalId = await resolveRelayGoalForTransition(workspaceRoot, handoff_id.trim());
      } else if (action === "bind" && (!owned || !["active", "paused"].includes(owned.status))) {
        actionGoalId = (await getGoalBindSource(workspaceRoot))?.id;
      }
      return actionGoalId ? withRelayGoalTransition(workspaceRoot, currentRelayGoal(workspaceRoot), actionGoalId, executeAction) : executeAction();
    }
  );
}
