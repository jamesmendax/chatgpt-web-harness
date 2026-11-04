import { currentRelayGoal, requireRelayGoal, withRelayGoal, withResolvedRelayGoal, relayGoalPath, relayScopeKey, readRelayStateText, ensureRelayGoalStorage, resolveRelayGoalForTransition, resolveRelayGoalForSession, listRelayGoalIds } from "./relay-scope.js";
import { getActiveTaskId, getDurableTask, taskHandoff } from "./durable-tasks.js";
import {
  abortDriverHandoff,
  commitDriverHandoff,
  prepareDriverHandoff,
  readDriverLease,
  relayEnabled,
  type DriverLease,
} from "./driver-lease.js";
import { readAcceptedExecutionContractState } from "./execution-contract.js";
import { getGoal, type DurableGoal } from "./goal-state-store.js";
import { readGoalRun } from "./goal-run-store.js";
import { readHandoffSnapshot, type HandoffSnapshot } from "./handoff-store.js";
import { listOperationInspections, listUnresolvedOperationInspections } from "./operation-journal.js";
import { listProcessJournalRecords } from "./process-journal.js";
import {
  createResumeBundle,
  readResumeBundle,
  transitionResumeBundle,
  type ResumeBundle,
} from "./resume-bundle.js";
import {
  consumeWorkerClaimTicket,
  markWorkerActiveForSession,
  verifyWorkerClaimTicket,
  workerReadyForAuthority,
} from "./worker-registry.js";

export interface RelayHandoffWorkerContext {
  readonly source_worker_id?: string | null;
  readonly source_generation?: number | null;
  readonly target_worker_id?: string | null;
  readonly target_generation?: number | null;
  readonly pending_delivery_refs?: readonly string[];
}

export interface RelayControlStatus {
  readonly enabled: boolean;
  readonly driver_lease: DriverLease | null;
  readonly prepared_handoff: HandoffSnapshot | null;
}

export interface PreparedRelayHandoff {
  readonly goal: DurableGoal;
  readonly driver_lease: DriverLease;
  readonly handoff: HandoffSnapshot;
  readonly resume_bundle: ResumeBundle;
}

function requireRelayEnabled(): void {
  if (!relayEnabled()) {
    throw new Error("RELAY_DISABLED: set HARNESS_RELAY_ENABLED=true before using autonomous handoff controls");
  }
}

export async function readRelayControlStatus(workspaceRoot: string, goalId?: string): Promise<RelayControlStatus> {
  if (!relayEnabled()) return { enabled: false, driver_lease: null, prepared_handoff: null };
  return withResolvedRelayGoal(workspaceRoot, goalId, async () => {
  if (!relayEnabled()) {
    return { enabled: false, driver_lease: null, prepared_handoff: null };
  }
  const lease = await readDriverLease(workspaceRoot);
  const handoff = lease?.prepared_handoff_id
    ? await readHandoffSnapshot(workspaceRoot, lease.prepared_handoff_id)
    : null;
  return {
    enabled: true,
    driver_lease: lease,
    prepared_handoff: handoff,
  };
  });
}

async function prepareRelayHandoffScoped(
  workspaceRoot: string,
  sourceSessionId: string,
  targetSessionId?: string,
  workerContext: RelayHandoffWorkerContext = {}
): Promise<PreparedRelayHandoff> {
  requireRelayEnabled();
  if (!sourceSessionId.trim()) {
    throw new Error("RELAY_SESSION_REQUIRED: source ChatGPT session identity is required");
  }
  const normalizedTarget = targetSessionId?.trim() || undefined;
  if (normalizedTarget && sourceSessionId === normalizedTarget) {
    throw new Error("RELAY_TARGET_CONFLICT: target session must differ from the current Driver session");
  }

  const goal = await getGoal(workspaceRoot, sourceSessionId);
  if (goal && goal.id !== requireRelayGoal(workspaceRoot)) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
  if (!goal || goal.status !== "active") {
    throw new Error("RELAY_GOAL_REQUIRED: an active Goal is required before preparing a handoff");
  }
  if (!goal.owner_session || goal.owner_session !== sourceSessionId) {
    throw new Error("DRIVER_LEASE_LOST: only the current Goal owner may prepare a relay handoff");
  }

  const contract = await readAcceptedExecutionContractState(workspaceRoot, sourceSessionId, requireRelayGoal(workspaceRoot));
  if (!contract) {
    throw new Error(
      "RELAY_EXECUTION_CONTRACT_REQUIRED: current Driver has no live accepted Execution Contract; perform a READY side-effect admission before handoff"
    );
  }

  const envelope = await readGoalRun(workspaceRoot, sourceSessionId);
  if (!envelope || envelope.run.runId !== goal.id) {
    throw new Error("RELAY_GOALRUN_REQUIRED: authoritative GoalRun state is unavailable for the active Goal");
  }

  let taskSnapshot: ReturnType<typeof taskHandoff> | null = null;
  const activeTaskId = await getActiveTaskId(workspaceRoot, sourceSessionId);
  if (activeTaskId) {
    try {
      const task = await getDurableTask(workspaceRoot, activeTaskId);
      if (task.goal_id === goal.id && task.owner_session === sourceSessionId) taskSnapshot = taskHandoff(task);
    } catch {
      // Goal/GoalRun remain authoritative. A missing/expired task pointer must
      // not invent task state or prevent a safe handoff snapshot.
      taskSnapshot = null;
    }
  }

  const pendingCriteria = envelope.run.criteria
    .filter((criterion) => !criterion.confirmed)
    .map((criterion) => criterion.description);
  const verifiedEvidence = envelope.run.typedEvidence
    .filter((evidence) => evidence.kind !== "launch_ack")
    .slice(-128)
    .map((evidence) => evidence.id);

  // Handoff snapshots carry opaque references only. Payloads, arguments,
  // credentials and process command text remain in their authoritative stores.
  const processRecords = await listProcessJournalRecords(workspaceRoot, requireRelayGoal(workspaceRoot));
  const activeProcessRefs = processRecords
    .filter((record) => record.state === "running")
    .slice(0, 128)
    .map((record) => `process:${record.id}`);
  const completedProcessRefs = processRecords
    .filter((record) => record.state === "finished")
    .slice(0, 128)
    .map((record) => `process:${record.id}`);
  const [recentOperationReceipts, unresolvedOperationReceipts] = await Promise.all([
    listOperationInspections(workspaceRoot, 256, requireRelayGoal(workspaceRoot)),
    listUnresolvedOperationInspections(workspaceRoot, requireRelayGoal(workspaceRoot)),
  ]);
  const operationReceipts = [...new Map(
    [...unresolvedOperationReceipts, ...recentOperationReceipts].map((operation) => [operation.operation_id, operation])
  ).values()];
  const operationReceiptRefs = operationReceipts.map((operation) => `operation:${operation.operation_id}:${operation.state}`);
  const doNotRepeat = [
    ...operationReceipts
      .filter((operation) => operation.state !== "received")
      .map((operation) => `operation:${operation.operation_id}`),
    ...processRecords
      .filter((record) => record.state === "finished")
      .map((record) => `process:${record.id}`),
  ].slice(0, 128);

  const prepared = await prepareDriverHandoff(workspaceRoot, {
    goalId: goal.id,
    sourceSessionId,
    targetSessionId: normalizedTarget,
    executionContractHash: contract.requirement_hash,
    intentRevision: contract.intent_revision,
    snapshot: {
      goal_revision: goal.revision,
      source_worker_id: workerContext.source_worker_id ?? null,
      source_generation: workerContext.source_generation ?? null,
      target_worker_id: workerContext.target_worker_id ?? null,
      target_generation: workerContext.target_generation ?? null,
      current_phase: envelope.run.currentPhase,
      resume_cursor: envelope.run.resumeCursor,
      next_action: envelope.run.nextAction ?? taskSnapshot?.next_actions?.[0] ?? null,
      completed: taskSnapshot?.done ?? [],
      decisions: taskSnapshot?.decisions ?? [],
      blockers: taskSnapshot?.blockers ?? [],
      pending: pendingCriteria,
      changed_files: taskSnapshot?.changed_files ?? [],
      active_process_refs: activeProcessRefs,
      completed_process_refs: completedProcessRefs,
      operation_receipt_refs: operationReceiptRefs,
      // Browser/transport delivery remains a separate truth domain. The Relay
      // Manager passes its durable command refs when such deliveries already
      // exist; a newly prepared handoff has no activation delivery yet.
      pending_delivery_refs: workerContext.pending_delivery_refs ?? [],
      verified_evidence_refs: verifiedEvidence,
      do_not_repeat: doNotRepeat,
    },
  });
  const resumeBundle = await createResumeBundle(workspaceRoot, prepared.snapshot, envelope.run);

  return {
    goal,
    driver_lease: prepared.lease,
    handoff: prepared.snapshot,
    resume_bundle: resumeBundle,
  };
}

async function validateRelayBindScoped(
  workspaceRoot: string,
  handoffId: string,
  targetSessionId: string,
  workerClaimToken?: string
): Promise<{ goal: DurableGoal; handoff: HandoffSnapshot; resume_bundle: ResumeBundle; already_bound: boolean; driver_lease: DriverLease }> {
  requireRelayEnabled();
  const handoff = await readHandoffSnapshot(workspaceRoot, handoffId);
  if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
  if (handoff.state === "ABORTED") {
    throw new Error("RELAY_HANDOFF_ABORTED: aborted handoffs cannot authorize Goal takeover");
  }
  if (handoff.source_session_id === targetSessionId) {
    throw new Error("RELAY_HANDOFF_SOURCE_RECLAIM: source Driver cannot claim its own prepared handoff");
  }
  if (handoff.target_session_id && handoff.target_session_id !== targetSessionId) {
    throw new Error("RELAY_HANDOFF_TARGET_MISMATCH: handoff is bound to a different ChatGPT session");
  }
  const resumeBundle = await readResumeBundle(workspaceRoot, handoff.handoff_id);
  if (!resumeBundle) {
    throw new Error("RESUME_BUNDLE_MISSING_OR_STALE: durable source-independent resume state is missing");
  }
  const resumeIdentityMatches = Boolean(
    resumeBundle.goal_id === handoff.goal_id &&
    resumeBundle.handoff_id === handoff.handoff_id &&
    resumeBundle.execution_contract_hash === handoff.execution_contract_hash &&
    resumeBundle.source_worker_id === (handoff.source_worker_id ?? null) &&
    resumeBundle.target_worker_id === (handoff.target_worker_id ?? null) &&
    resumeBundle.source_generation === (handoff.source_generation ?? null) &&
    resumeBundle.target_generation === (handoff.target_generation ?? null)
  );
  const resumeStateMatches = handoff.state === "PREPARED"
    ? resumeBundle.state === "PREPARED" && resumeBundle.snapshot_hash === handoff.snapshot_hash
    : handoff.state === "COMMITTED"
      ? resumeBundle.state === "COMMITTED" && resumeBundle.target_session_id === targetSessionId
      : false;
  if (!resumeIdentityMatches) {
    throw new Error("RESUME_BUNDLE_MISSING_OR_STALE: durable source-independent resume state does not match the prepared handoff");
  }
  if (handoff.target_worker_id) {
    if (!workerClaimToken?.trim()) {
      throw new Error("WORKER_CLAIM_REQUIRED: Handoff v2 target Worker requires its one-time claim ticket");
    }
    const claim = await verifyWorkerClaimTicket(workspaceRoot, {
      workerId: handoff.target_worker_id,
      handoffId: handoff.handoff_id,
      token: workerClaimToken,
      targetSessionId,
      kind: "HANDOFF",
    });
    if (!workerReadyForAuthority(claim.worker)) {
      throw new Error("WORKER_AUTHORITY_NOT_READY: handoff target lacks formal conversation/session-bound fresh MCP capability proof");
    }
    if (handoff.target_generation && claim.worker.generation !== handoff.target_generation) {
      throw new Error("WORKER_CLAIM_GENERATION_MISMATCH: Handoff target generation does not match the claimed Worker");
    }
  }

  const candidates = await Promise.all([getGoal(workspaceRoot, targetSessionId), getGoal(workspaceRoot, handoff.source_session_id)]);
  const goal = candidates.find((candidate) => candidate?.id === requireRelayGoal(workspaceRoot)) ?? null;
  if (!goal || goal.id !== handoff.goal_id) {
    throw new Error("RELAY_GOAL_IDENTITY_MISMATCH: handoff does not match the current workspace Goal");
  }
  if (goal.status !== "active") {
    throw new Error(`RELAY_GOAL_NOT_ACTIVE: current Goal status is ${goal.status}`);
  }

  const alreadyBound = goal.owner_session === targetSessionId;
  const lease = await readDriverLease(workspaceRoot);
  if (!lease || lease.goal_id !== handoff.goal_id) {
    throw new Error("RELAY_DRIVER_LEASE_MISSING: prepared handoff has no matching Driver lease");
  }
  if (lease.execution_contract_hash !== handoff.execution_contract_hash) {
    throw new Error("RELAY_EXECUTION_CONTRACT_MISMATCH: handoff and Driver lease contract hashes differ");
  }
  // Driver commit publishes the ACTIVE target lease and COMMITTED handoff
  // snapshot before it publishes the COMMITTED Resume Bundle. A crashed
  // process may leave the *authentic* old bundle at PREPARED. Permit only the
  // exact previously committed Driver transition to finish that publication;
  // this is NOT a new authorization or a broader source/session takeover.
  const receipt = lease.authority_transition;
  const exactCommittedTransition = Boolean(
    alreadyBound &&
    handoff.state === "COMMITTED" &&
    handoff.target_session_id === targetSessionId &&
    lease.state === "ACTIVE" &&
    lease.owner_session_id === targetSessionId &&
    lease.epoch === handoff.source_driver_epoch + 1 &&
    receipt?.kind === "HANDOFF" &&
    receipt.transition_id === handoff.handoff_id &&
    receipt.source_epoch === handoff.source_driver_epoch &&
    receipt.source_session_id === handoff.source_session_id &&
    receipt.target_session_id === targetSessionId
  );
  const pendingExactBundleCommit = Boolean(
    !resumeStateMatches &&
    exactCommittedTransition &&
    resumeBundle.state === "PREPARED" &&
    (resumeBundle.target_session_id === null || resumeBundle.target_session_id === targetSessionId)
  );
  if (!resumeStateMatches && !pendingExactBundleCommit) {
    throw new Error("RESUME_BUNDLE_MISSING_OR_STALE: bundle state is not committed for this exact Driver handoff");
  }
  if (!alreadyBound) {
    if (goal.owner_session !== handoff.source_session_id) {
      throw new Error("RELAY_GOAL_OWNER_MISMATCH: Goal owner changed after handoff preparation");
    }
    if (goal.revision !== handoff.goal_revision) {
      throw new Error(
        `RELAY_GOAL_REVISION_STALE: handoff prepared at Goal revision ${handoff.goal_revision}, current ${goal.revision}`
      );
    }
    if (handoff.state !== "PREPARED") {
      throw new Error(`RELAY_HANDOFF_CONFLICT: Goal is not bound but handoff is ${handoff.state}`);
    }
    if (
      lease.owner_session_id !== handoff.source_session_id ||
      lease.state !== "HANDOFF_PREPARED" ||
      lease.prepared_handoff_id !== handoff.handoff_id
    ) {
      throw new Error("RELAY_DRIVER_LEASE_MISMATCH: current Driver is not the prepared handoff source");
    }
  } else if (handoff.state === "COMMITTED") {
    if (lease.owner_session_id !== targetSessionId || lease.state !== "ACTIVE") {
      throw new Error("RELAY_DRIVER_LEASE_MISMATCH: committed handoff target is not the active Driver");
    }
  }

  return { goal, handoff, resume_bundle: resumeBundle, already_bound: alreadyBound, driver_lease: lease };
}

async function commitRelayHandoffScoped(
  workspaceRoot: string,
  handoffId: string,
  targetSessionId: string,
  workerClaimToken?: string
): Promise<DriverLease> {
  requireRelayEnabled();
  const validated = await validateRelayBind(workspaceRoot, handoffId, targetSessionId, workerClaimToken);
  const lease = await commitDriverHandoff(workspaceRoot, handoffId, targetSessionId);
  if (validated.handoff.target_worker_id) {
    // Authority has already moved through the Driver CAS. Persist the Worker
    // session relation as management-plane truth; same-session retries are
    // idempotent and a different-session replay is rejected.
    await consumeWorkerClaimTicket(workspaceRoot, {
      workerId: validated.handoff.target_worker_id,
      handoffId: validated.handoff.handoff_id,
      token: workerClaimToken!,
      targetSessionId,
      kind: "HANDOFF",
    });
    await markWorkerActiveForSession(workspaceRoot, validated.handoff.target_worker_id, targetSessionId);
  }
  await transitionResumeBundle(workspaceRoot, handoffId, "COMMITTED", targetSessionId);
  return lease;
}

async function abortRelayHandoffScoped(
  workspaceRoot: string,
  handoffId: string,
  sourceSessionId: string
): Promise<DriverLease> {
  requireRelayEnabled();
  const handoff = await readHandoffSnapshot(workspaceRoot, handoffId);
  if (!handoff) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
  if (handoff.source_session_id !== sourceSessionId) {
    throw new Error("DRIVER_LEASE_LOST: only the source Driver may abort its prepared handoff");
  }
  const lease = await abortDriverHandoff(workspaceRoot, handoffId);
  const bundle = await readResumeBundle(workspaceRoot, handoffId);
  if (bundle?.state === "PREPARED") await transitionResumeBundle(workspaceRoot, handoffId, "ABORTED");
  return lease;
}

export function prepareRelayHandoff(...args: Parameters<typeof prepareRelayHandoffScoped>): ReturnType<typeof prepareRelayHandoffScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => prepareRelayHandoffScoped(...args));
}

export function validateRelayBind(...args: Parameters<typeof validateRelayBindScoped>): ReturnType<typeof validateRelayBindScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => validateRelayBindScoped(...args));
}

export function commitRelayHandoff(...args: Parameters<typeof commitRelayHandoffScoped>): ReturnType<typeof commitRelayHandoffScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => commitRelayHandoffScoped(...args));
}

export function abortRelayHandoff(...args: Parameters<typeof abortRelayHandoffScoped>): ReturnType<typeof abortRelayHandoffScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => abortRelayHandoffScoped(...args));
}
