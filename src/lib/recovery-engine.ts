// @ts-nocheck
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readProcessStartIdentity } from "./process-journal.js";
import { writeRecoveryJson } from "./recovery-atomic-write.js";

const VERSION = 1;
const DEFAULT_LEASE_MS = 15_000;
const MAX_AUTOMATIC_RECOVERIES = 16;

export class RecoveryFault extends Error {
  constructor(code, options = {}) {
    super(options.message || code);
    this.name = "RecoveryFault";
    this.code = code;
    this.disposition = options.disposition || classifyRecoveryFault(code);
    this.sideEffect = options.sideEffect || "none";
  }
}

export function classifyRecoveryFault(code) {
  switch (code) {
    case "stream_disconnected":
    case "tool_session_lost":
    case "process_exit":
    case "timeout":
      return "retry";
    case "approval_pending":
      return "wait";
    case "unknown_side_effect":
    default:
      return "block";
  }
}

export async function readRecoveryTask(workspaceRoot, taskId) {
  const statePath = recoveryStatePath(workspaceRoot, taskId);
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function clearRecoveryWait(workspaceRoot, taskId, reason = "external_wait_resolved") {
  const lock = await acquireTaskLock(workspaceRoot, taskId);
  if (!lock) return { action: "busy" };
  try {
    const state = await readRequiredState(workspaceRoot, taskId);
    const step = currentStep(state);
    if (!step || step.status !== "waiting") return { action: "noop", state };
    step.status = "pending";
    step.failure_reason = null;
    appendTimeline(state, "wait_resolved", step, { reason });
    await persistState(workspaceRoot, state);
    return { action: "cleared", state };
  } finally {
    await releaseTaskLock(lock);
  }
}

export async function watchdogRecoverTask(options) {
  return recoverTask(options);
}

export async function recoverTask({
  workspaceRoot,
  taskId,
  plan,
  executor,
  ownerId = `pid:${process.pid}`,
  leaseMs = DEFAULT_LEASE_MS,
  maxAutomaticRecoveries = MAX_AUTOMATIC_RECOVERIES,
}) {
  validateInputs(workspaceRoot, taskId, plan, executor);
  const ownerProcessStartIdentity = await readProcessStartIdentity(process.pid);
  if (!ownerProcessStartIdentity) throw new Error("RECOVERY_OWNER_IDENTITY_UNAVAILABLE");
  const lock = await acquireTaskLock(workspaceRoot, taskId);
  if (!lock) {
    const state = await readRecoveryTask(workspaceRoot, taskId);
    return { action: "busy", state };
  }

  try {
    let state = await readRecoveryTask(workspaceRoot, taskId);
    if (!state) {
      state = createInitialState(taskId, plan);
      appendTimeline(state, "task_initialized", null, { owner_id: ownerId });
      await persistState(workspaceRoot, state);
    } else {
      assertPlanCompatible(state, plan);
      assertReceiptIntegrity(state);
    }

    if (state.status === "completed" || state.status === "blocked") {
      return { action: state.status, state };
    }

    if (!Number.isInteger(maxAutomaticRecoveries) || maxAutomaticRecoveries < 0) {
      throw new Error("RECOVERY_RECOVERY_LIMIT_INVALID");
    }
    const reconciliation = await reconcileInterruptedExecution(state, { ownerId, leaseMs, maxAutomaticRecoveries });
    if (reconciliation.changed) await persistState(workspaceRoot, state);
    if (reconciliation.action === "wait" || reconciliation.action === "block") {
      return { action: reconciliation.action === "block" ? "blocked" : "waiting", state };
    }

    while (state.next_step_index < state.steps.length) {
      const step = state.steps[state.next_step_index];

      if (step.status === "completed") {
        state.next_step_index += 1;
        continue;
      }
      if (step.status === "waiting") {
        state.status = "waiting";
        await persistState(workspaceRoot, state);
        return { action: "waiting", state };
      }
      if (step.status === "blocked") {
        state.status = "blocked";
        await persistState(workspaceRoot, state);
        return { action: "blocked", state };
      }

      const attempt = {
        attempt_id: randomUUID(),
        owner_id: ownerId,
        owner_pid: process.pid,
        owner_process_start_identity: ownerProcessStartIdentity,
        started_at: now(),
        finished_at: null,
        outcome: "executing",
        fault_code: null,
      };
      step.attempts.push(attempt);
      step.status = "executing";
      step.checkpoint = {
        phase: "before",
        confirmed: true,
        at: now(),
        operation_id: step.operation_id,
      };
      step.lease = {
        owner_id: ownerId,
        owner_pid: process.pid,
        owner_process_start_identity: ownerProcessStartIdentity,
        acquired_at: now(),
        heartbeat_at: now(),
        expires_at: new Date(Date.now() + leaseMs).toISOString(),
      };
      state.status = "running";
      appendTimeline(state, "attempt_started", step, { attempt_id: attempt.attempt_id, owner_id: ownerId });
      await persistState(workspaceRoot, state);

      const heartbeat = async (detail = "executor") => {
        step.lease.heartbeat_at = now();
        step.lease.expires_at = new Date(Date.now() + leaseMs).toISOString();
        appendTimeline(state, "heartbeat", step, { attempt_id: attempt.attempt_id, detail });
        await persistState(workspaceRoot, state);
      };

      try {
        const result = await executor({
          task: state,
          step,
          attempt,
          operation_id: step.operation_id,
          heartbeat,
          workspaceRoot,
        });
        const resultJson = JSON.stringify(result ?? null);
        step.receipt = {
          ...(state.goal_id ? { goal_id: state.goal_id } : {}),
          operation_id: step.operation_id,
          status: "completed",
          completed_at: now(),
          attempt_id: attempt.attempt_id,
          result_sha256: sha256(resultJson),
          plan_fingerprint: state.plan_fingerprint,
          spec_fingerprint: step.spec_fingerprint,
        };
        step.checkpoint = {
          phase: "after",
          confirmed: true,
          at: now(),
          operation_id: step.operation_id,
        };
        step.status = "completed";
        step.failure_reason = null;
        step.lease = null;
        attempt.outcome = "completed";
        attempt.finished_at = now();
        state.next_step_index += 1;
        appendTimeline(state, "step_completed", step, { attempt_id: attempt.attempt_id });
        await persistState(workspaceRoot, state);
        continue;
      } catch (error) {
        const fault = normalizeFault(error);
        attempt.finished_at = now();
        attempt.fault_code = fault.code;
        attempt.outcome = fault.disposition === "retry" ? "interrupted" : fault.disposition;
        step.lease = null;

        // An uncertain effect overrides an optimistic replay declaration.
        if (fault.sideEffect === "unknown" || fault.code === "unknown_side_effect") {
          blockStep(state, step, "unknown_side_effect_result");
          appendTimeline(state, "fail_closed", step, { attempt_id: attempt.attempt_id, fault_code: fault.code });
          await persistState(workspaceRoot, state);
          return { action: "blocked", state };
        }

        if (fault.disposition === "retry" && step.replay_policy === "safe") {
          if (state.recovery_count >= maxAutomaticRecoveries) {
            blockStep(state, step, "automatic_recovery_limit_exceeded");
            await persistState(workspaceRoot, state);
            return { action: "blocked", state };
          }
          step.status = "pending";
          step.failure_reason = fault.code;
          state.recovery_count += 1;
          appendTimeline(state, "recoverable_fault", step, {
            attempt_id: attempt.attempt_id,
            fault_code: fault.code,
            recovery_count: state.recovery_count,
          });
          await persistState(workspaceRoot, state);
          continue;
        }

        if (fault.disposition === "wait") {
          step.status = "waiting";
          step.failure_reason = fault.code;
          state.status = "waiting";
          appendTimeline(state, "wait_required", step, {
            attempt_id: attempt.attempt_id,
            fault_code: fault.code,
          });
          await persistState(workspaceRoot, state);
          return { action: "waiting", state };
        }

        const reason =
          fault.code === "unknown_side_effect" || fault.sideEffect === "unknown"
            ? "unknown_side_effect_result"
            : fault.code;
        blockStep(state, step, reason);
        appendTimeline(state, "fail_closed", step, {
          attempt_id: attempt.attempt_id,
          fault_code: fault.code,
          side_effect: fault.sideEffect,
        });
        await persistState(workspaceRoot, state);
        return { action: "blocked", state };
      }
    }

    state.status = "completed";
    state.completed_at = now();
    state.final_receipt = {
      ...(state.goal_id ? { goal_id: state.goal_id } : {}),
      task_id: state.task_id,
      status: "completed",
      completed_at: state.completed_at,
      recovery_count: state.recovery_count,
      operation_ids: state.steps.map((step) => step.operation_id),
      plan_fingerprint: state.plan_fingerprint,
      receipt_sha256: sha256(JSON.stringify(state.steps.map((step) => step.receipt))),
    };
    appendTimeline(state, "task_completed", null, {
      recovery_count: state.recovery_count,
      receipt_sha256: state.final_receipt.receipt_sha256,
    });
    await persistState(workspaceRoot, state);
    return { action: "completed", state };
  } finally {
    await releaseTaskLock(lock);
  }
}

async function reconcileInterruptedExecution(state, { ownerId, leaseMs, maxAutomaticRecoveries }) {
  const step = currentStep(state);
  if (!step) return { action: "continue", changed: false };
  if (step.status !== "executing") return { action: "continue", changed: false };

  const lease = step.lease;
  const ownerAlive = Boolean(
    lease?.owner_pid &&
    await processIdentityMatches(lease.owner_pid, lease.owner_process_start_identity)
  );
  const leaseFresh = Boolean(lease?.expires_at && Date.parse(lease.expires_at) > Date.now());
  if (ownerAlive && leaseFresh) {
    state.status = "waiting";
    appendTimeline(state, "active_lease_observed", step, {
      owner_pid: lease.owner_pid,
      owner_id: lease.owner_id,
    });
    return { action: "wait", changed: true };
  }

  if (step.replay_policy !== "safe") {
    blockStep(state, step, "unknown_side_effect_result");
    appendTimeline(state, "stale_execution_fail_closed", step, {
      prior_owner_pid: lease?.owner_pid ?? null,
      prior_owner_id: lease?.owner_id ?? null,
      new_owner_id: ownerId,
    });
    return { action: "block", changed: true };
  }

  if (state.recovery_count >= maxAutomaticRecoveries) {
    blockStep(state, step, "automatic_recovery_limit_exceeded");
    appendTimeline(state, "recovery_budget_exhausted", step, { recovery_count: state.recovery_count });
    return { action: "block", changed: true };
  }
  const lastAttempt = step.attempts.at(-1);
  if (lastAttempt && lastAttempt.outcome === "executing") {
    lastAttempt.outcome = "interrupted";
    lastAttempt.finished_at = now();
    lastAttempt.fault_code = "process_exit";
  }
  step.status = "pending";
  step.lease = null;
  step.failure_reason = "process_exit";
  state.status = "running";
  state.recovery_count += 1;
  appendTimeline(state, "stale_execution_recovered", step, {
    prior_owner_pid: lease?.owner_pid ?? null,
    prior_owner_id: lease?.owner_id ?? null,
    new_owner_id: ownerId,
    lease_ms: leaseMs,
    recovery_count: state.recovery_count,
  });
  return { action: "continue", changed: true };
}

function createInitialState(taskId, plan) {
  const createdAt = now();
  const steps = plan.steps.map((spec, index) => {
    const id = String(spec.id || `step-${index + 1}`);
    return {
      id,
      name: String(spec.name || id),
      operation_id: spec.operation_id || stableOperationId(taskId, id),
      replay_policy: spec.replay_policy === "never" ? "never" : "safe",
      spec_fingerprint: stepSpecFingerprint(taskId, spec, index),
      status: "pending",
      checkpoint: null,
      attempts: [],
      lease: null,
      receipt: null,
      failure_reason: null,
    };
  });
  return {
    version: VERSION,
    ...(plan.goal_id ? { goal_id: plan.goal_id } : {}),
    task_id: taskId,
    plan_fingerprint: planFingerprint(taskId, plan),
    created_at: createdAt,
    updated_at: createdAt,
    completed_at: null,
    status: "running",
    next_step_index: 0,
    recovery_count: 0,
    steps,
    timeline: [],
    final_receipt: null,
    failure_reason: null,
  };
}

function assertPlanCompatible(state, plan) {
  if (state.version !== VERSION) throw new Error("RECOVERY_STATE_VERSION_MISMATCH");
  if ((state.goal_id ?? null) !== (plan.goal_id ?? null)) throw new Error("RECOVERY_GOAL_SCOPE_MISMATCH");
  if (state.plan_fingerprint !== planFingerprint(state.task_id, plan)) throw new Error("RECOVERY_PLAN_MISMATCH");
  if (state.steps.length !== plan.steps.length) throw new Error("RECOVERY_PLAN_MISMATCH");
  for (let index = 0; index < state.steps.length; index += 1) {
    const existing = state.steps[index];
    const spec = plan.steps[index];
    const id = String(spec.id || `step-${index + 1}`);
    const operationId = spec.operation_id || stableOperationId(state.task_id, id);
    const specFingerprint = stepSpecFingerprint(state.task_id, spec, index);
    if (
      existing.id !== id ||
      existing.operation_id !== operationId ||
      existing.replay_policy !== (spec.replay_policy === "never" ? "never" : "safe") ||
      existing.spec_fingerprint !== specFingerprint
    ) {
      throw new Error("RECOVERY_PLAN_MISMATCH");
    }
  }
}

function assertReceiptIntegrity(state) {
  const completedReceipts = [];
  for (const step of state.steps) {
    if (step.status !== "completed") {
      if (step.receipt != null) throw new Error("RECOVERY_RECEIPT_CORRUPT");
      continue;
    }
    const receipt = step.receipt;
    if (!receipt || typeof receipt !== "object") throw new Error("RECOVERY_RECEIPT_CORRUPT");
    const attemptIds = new Set((step.attempts || []).map((attempt) => attempt?.attempt_id).filter(Boolean));
    if (
      (receipt.goal_id ?? null) !== (state.goal_id ?? null) ||
      receipt.operation_id !== step.operation_id ||
      receipt.status !== "completed" ||
      receipt.plan_fingerprint !== state.plan_fingerprint ||
      receipt.spec_fingerprint !== step.spec_fingerprint ||
      typeof receipt.completed_at !== "string" ||
      !Number.isFinite(Date.parse(receipt.completed_at)) ||
      typeof receipt.attempt_id !== "string" ||
      !attemptIds.has(receipt.attempt_id) ||
      typeof receipt.result_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(receipt.result_sha256) ||
      step.checkpoint?.phase !== "after" ||
      step.checkpoint?.confirmed !== true ||
      step.checkpoint?.operation_id !== step.operation_id
    ) {
      throw new Error("RECOVERY_RECEIPT_CORRUPT");
    }
    completedReceipts.push(receipt);
  }

  if (state.status === "completed") {
    const finalReceipt = state.final_receipt;
    const receiptSha256 = sha256(JSON.stringify(state.steps.map((step) => step.receipt)));
    if (
      !finalReceipt ||
      (finalReceipt.goal_id ?? null) !== (state.goal_id ?? null) ||
      finalReceipt.task_id !== state.task_id ||
      finalReceipt.status !== "completed" ||
      finalReceipt.completed_at !== state.completed_at ||
      finalReceipt.recovery_count !== state.recovery_count ||
      finalReceipt.plan_fingerprint !== state.plan_fingerprint ||
      finalReceipt.receipt_sha256 !== receiptSha256 ||
      JSON.stringify(finalReceipt.operation_ids) !== JSON.stringify(state.steps.map((step) => step.operation_id)) ||
      completedReceipts.length !== state.steps.length
    ) {
      throw new Error("RECOVERY_RECEIPT_CORRUPT");
    }
  } else if (state.final_receipt != null) {
    throw new Error("RECOVERY_RECEIPT_CORRUPT");
  }
}

function validateInputs(workspaceRoot, taskId, plan, executor) {
  if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) throw new Error("RECOVERY_WORKSPACE_INVALID");
  if (!taskId || !/^[A-Za-z0-9._-]{1,160}$/.test(taskId)) throw new Error("RECOVERY_TASK_ID_INVALID");
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) throw new Error("RECOVERY_PLAN_INVALID");
  if (plan.goal_id != null && (typeof plan.goal_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(plan.goal_id))) {
    throw new Error("RECOVERY_GOAL_ID_INVALID");
  }
  if (typeof executor !== "function") throw new Error("RECOVERY_EXECUTOR_INVALID");
  const resolvedWorkspace = path.resolve(workspaceRoot);
  if (plan.workspace_root != null) {
    if (typeof plan.workspace_root !== "string" || !path.isAbsolute(plan.workspace_root)) {
      throw new Error("RECOVERY_PLAN_WORKSPACE_INVALID");
    }
    if (!samePath(resolvedWorkspace, path.resolve(plan.workspace_root))) {
      throw new Error("RECOVERY_PLAN_WORKSPACE_MISMATCH");
    }
  }
  if (plan.allowed_workspaces != null) {
    if (!Array.isArray(plan.allowed_workspaces) || plan.allowed_workspaces.length === 0) {
      throw new Error("RECOVERY_ALLOWED_WORKSPACES_INVALID");
    }
    const allowed = plan.allowed_workspaces.some((candidate) =>
      typeof candidate === "string" && path.isAbsolute(candidate) && samePath(resolvedWorkspace, path.resolve(candidate))
    );
    if (!allowed) throw new Error("RECOVERY_WORKSPACE_NOT_ALLOWED");
  }
  const ids = new Set();
  const operationIds = new Set();
  for (let index = 0; index < plan.steps.length; index += 1) {
    const spec = plan.steps[index];
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("RECOVERY_STEP_INVALID");
    const id = String(spec.id || `step-${index + 1}`);
    if (ids.has(id)) throw new Error("RECOVERY_STEP_ID_DUPLICATE");
    ids.add(id);
    if (spec.replay_policy != null && spec.replay_policy !== "safe" && spec.replay_policy !== "never") {
      throw new Error("RECOVERY_REPLAY_POLICY_INVALID");
    }
    if (spec.operation_id != null && (
      typeof spec.operation_id !== "string" ||
      spec.operation_id.length < 1 ||
      spec.operation_id.length > 256 ||
      !/^[A-Za-z0-9._:-]+$/.test(spec.operation_id)
    )) {
      throw new Error("RECOVERY_OPERATION_ID_INVALID");
    }
    const operationId = spec.operation_id || stableOperationId(taskId, id);
    if (operationIds.has(operationId)) throw new Error("RECOVERY_OPERATION_ID_DUPLICATE");
    operationIds.add(operationId);
  }
}

function normalizeFault(error) {
  if (error instanceof RecoveryFault) return error;
  return new RecoveryFault("unhandled_executor_error", {
    disposition: "block",
    sideEffect: "unknown",
    message: error instanceof Error ? error.message : String(error),
  });
}

function blockStep(state, step, reason) {
  step.status = "blocked";
  step.failure_reason = reason;
  step.lease = null;
  state.status = "blocked";
  state.failure_reason = reason;
}

function currentStep(state) {
  return state.steps[state.next_step_index] || null;
}

function appendTimeline(state, event, step, detail = {}) {
  state.timeline.push({
    at: now(),
    event,
    step_id: step?.id ?? null,
    operation_id: step?.operation_id ?? null,
    ...detail,
  });
}

function stableOperationId(taskId, stepId) {
  return sha256(`recovery-operation-v1\0${taskId}\0${stepId}`);
}

function recoveryDirectory(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), ".recovery-engine");
}

function recoveryStatePath(workspaceRoot, taskId) {
  return path.join(recoveryDirectory(workspaceRoot), `task-${taskId}.json`);
}

function recoveryLockPath(workspaceRoot, taskId) {
  return path.join(recoveryDirectory(workspaceRoot), `task-${taskId}.lock`);
}

async function readRequiredState(workspaceRoot, taskId) {
  const state = await readRecoveryTask(workspaceRoot, taskId);
  if (!state) throw new Error("RECOVERY_STATE_NOT_FOUND");
  return state;
}

async function persistState(workspaceRoot, state) {
  const directory = recoveryDirectory(workspaceRoot);
  await fs.mkdir(directory, { recursive: true });
  state.updated_at = now();
  const target = recoveryStatePath(workspaceRoot, state.task_id);
  await writeRecoveryJson(target, state);
}

async function acquireTaskLock(workspaceRoot, taskId) {
  const directory = recoveryDirectory(workspaceRoot);
  await fs.mkdir(directory, { recursive: true });
  const lockPath = recoveryLockPath(workspaceRoot, taskId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const token = randomUUID();
      const processStartIdentity = await readProcessStartIdentity(process.pid);
      if (!processStartIdentity) {
        await handle.close();
        await fs.unlink(lockPath).catch(() => undefined);
        throw new Error("RECOVERY_LOCK_OWNER_IDENTITY_UNAVAILABLE");
      }
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        process_start_identity: processStartIdentity,
        token,
        acquired_at: now(),
      }), "utf8");
      await handle.sync();
      return { handle, lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      // An empty or corrupt lock may be in the middle of creation. It is
      // never proof of a dead owner and must not be removed by a contender.
      if (!owner?.pid || !owner?.token) return null;
      if (owner?.pid) {
        const identityMatch = await processIdentityMatches(owner.pid, owner.process_start_identity);
        if (identityMatch === true) return null;
        if (identityMatch === null) return null;
      }
      try {
        await fs.unlink(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") return null;
      }
    }
  }
  return null;
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

async function releaseTaskLock(lock) {
  try {
    await lock.handle.close();
  } catch {}
  try {
    const current = await readLockOwner(lock.lockPath);
    if (current?.token === lock.token) await fs.unlink(lock.lockPath);
  } catch {}
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function processIdentityMatches(pid, expectedIdentity) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!expectedIdentity) return isPidAlive(pid) ? null : false;
  const currentIdentity = await readProcessStartIdentity(pid);
  if (currentIdentity) return currentIdentity === expectedIdentity;
  return isPidAlive(pid) ? null : false;
}

function stepSpecFingerprint(taskId, spec, index) {
  const id = String(spec.id || `step-${index + 1}`);
  return sha256(JSON.stringify({
    declared_spec_fingerprint: typeof spec.spec_fingerprint === "string" ? spec.spec_fingerprint : null,
    id,
    name: String(spec.name || id),
    operation_id: spec.operation_id || stableOperationId(taskId, id),
    replay_policy: spec.replay_policy === "never" ? "never" : "safe",
  }));
}

function planFingerprint(taskId, plan) {
  return sha256(JSON.stringify({
    ...(plan.goal_id ? { goal_id: plan.goal_id } : {}),
    task_id: taskId,
    declared_fingerprint: typeof plan.fingerprint === "string" ? plan.fingerprint : null,
    workspace_root: typeof plan.workspace_root === "string" ? normalizePathForFingerprint(plan.workspace_root) : null,
    allowed_workspaces: Array.isArray(plan.allowed_workspaces)
      ? plan.allowed_workspaces.map(normalizePathForFingerprint).sort()
      : null,
    steps: plan.steps.map((spec, index) => stepSpecFingerprint(taskId, spec, index)),
  }));
}

function normalizePathForFingerprint(value) {
  const resolved = path.resolve(String(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normalizePathForFingerprint(left) === normalizePathForFingerprint(right);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function now() {
  return new Date().toISOString();
}
