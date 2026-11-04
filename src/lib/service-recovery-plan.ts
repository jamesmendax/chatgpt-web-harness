import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { serviceRecoverySupervisorPaths, serviceRecoverySupervisorStatus } from "./service-recovery-supervisor.js";
import { requireCommandAllowed } from "./permissions.js";
import { publishRecoveryFile } from "./recovery-atomic-write.js";
import { getRuntimeScope } from "./runtime-scope.js";

export interface DurableRecoveryCommandStep {
  id: string;
  name?: string;
  operation_id: string;
  replay_policy: "safe" | "never";
  command: string;
  cwd?: string;
  timeout_ms?: number;
  side_effect: "none" | "unknown";
  retry_on_nonzero?: boolean;
}

export interface DurableRecoveryPlanSubmission {
  task_id: string;
  steps: DurableRecoveryCommandStep[];
  lease_ms?: number;
  max_automatic_recoveries?: number;
}

export interface DurableRecoveryPlanReceipt {
  version: 2;
  goal_id: string;
  task_id: string;
  plan_path: string;
  receipt_path: string;
  artifact_root: string;
  plan_sha256: string;
  submitted_at: string;
  idempotent: boolean;
  supervisor_running: boolean;
  executor_state?: string;
  operation_ids: string[];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value), null, 2) + "\n";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function safeTaskId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value)) throw new Error("RECOVERY_SUBMISSION_TASK_ID_INVALID");
  return value;
}

/** Capture authority before any await; callers cannot choose a Goal in plan input. */
export function captureDurableRecoveryScope(workspaceRoot: string): Readonly<{ goal_id: string; workspace_root: string }> {
  const scope = getRuntimeScope();
  if (!scope?.goalId) throw new Error("RECOVERY_SUBMISSION_GOAL_SCOPE_REQUIRED");
  durableRecoveryGoalKey(scope.goalId);
  const expected = path.resolve(workspaceRoot);
  const captured = path.resolve(scope.workspaceRoot);
  const sameWorkspace = process.platform === "win32"
    ? expected.toLowerCase() === captured.toLowerCase()
    : expected === captured;
  if (!sameWorkspace) throw new Error("RECOVERY_SUBMISSION_WORKSPACE_SCOPE_MISMATCH");
  return Object.freeze({ goal_id: scope.goalId, workspace_root: expected });
}

/** Filesystem key only; this helper does not grant submission authority. */
export function durableRecoveryGoalKey(goalId: string): string {
  if (typeof goalId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(goalId)) {
    throw new Error("RECOVERY_GOAL_ID_INVALID");
  }
  return sha256(goalId);
}

export function durableRecoveryScopedPaths(workspaceRoot: string, goalId: string, taskId: string) {
  safeTaskId(taskId);
  const paths = serviceRecoverySupervisorPaths(workspaceRoot);
  const goalKey = durableRecoveryGoalKey(goalId);
  return {
    ...paths,
    goalKey,
    goalArtifactRoot: path.join(paths.artifactRoot, "goals", goalKey),
    taskRoot: path.join(paths.artifactRoot, "goals", goalKey, "tasks", taskId),
    planPath: path.join(paths.plansDir, "goals", goalKey, `${taskId}.plan.json`),
    receiptPath: path.join(paths.stateRoot, "submissions", "goals", goalKey, `${taskId}.submission.json`),
  };
}

export function durableRecoveryPlanFingerprint(plan: {
  goal_id: string; task_id: string; artifact_root: string; workspace_root: string; steps: readonly unknown[];
}): string {
  durableRecoveryGoalKey(plan.goal_id);
  return sha256(JSON.stringify(canonicalize({
    goal_id: plan.goal_id,
    task_id: plan.task_id,
    artifact_root: path.resolve(plan.artifact_root),
    workspace_root: path.resolve(plan.workspace_root),
    steps: plan.steps,
  })));
}

function within(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolved);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function atomicCreate(file: string, content: string): Promise<"created" | "same"> {
  if (await publishRecoveryFile(file, content) === "created") return "created";
  const existing = await fs.readFile(file, "utf8");
  if (existing !== content) throw new Error("RECOVERY_SUBMISSION_PLAN_DRIFT");
  return "same";
}

function normalizedPlan(workspaceRoot: string, artifactRoot: string, goalId: string, input: DurableRecoveryPlanSubmission) {
  const taskId = safeTaskId(input.task_id);
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 64) {
    throw new Error("RECOVERY_SUBMISSION_STEPS_INVALID");
  }
  const ids = new Set<string>();
  const operationIds = new Set<string>();
  const steps = input.steps.map((step) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(step.id)) throw new Error("RECOVERY_SUBMISSION_STEP_ID_INVALID");
    if (ids.has(step.id)) throw new Error("RECOVERY_SUBMISSION_STEP_ID_DUPLICATE");
    ids.add(step.id);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(step.operation_id)) throw new Error("RECOVERY_SUBMISSION_OPERATION_ID_INVALID");
    if (operationIds.has(step.operation_id)) throw new Error("RECOVERY_SUBMISSION_OPERATION_ID_DUPLICATE");
    operationIds.add(step.operation_id);
    if (step.replay_policy !== "safe" && step.replay_policy !== "never") throw new Error("RECOVERY_SUBMISSION_REPLAY_POLICY_INVALID");
    if (step.side_effect !== "none" && step.side_effect !== "unknown") throw new Error("RECOVERY_SUBMISSION_SIDE_EFFECT_INVALID");
    if (step.replay_policy === "safe" && step.side_effect !== "none") {
      throw new Error("RECOVERY_SUBMISSION_SAFE_REPLAY_REQUIRES_NO_SIDE_EFFECT");
    }
    if (!step.command?.trim() || step.command.length > 100_000) throw new Error("RECOVERY_SUBMISSION_COMMAND_INVALID");
    requireCommandAllowed(step.command);
    const cwd = path.resolve(step.cwd || workspaceRoot);
    if (!within(workspaceRoot, cwd)) throw new Error("RECOVERY_SUBMISSION_CWD_OUTSIDE_WORKSPACE");
    return {
      id: step.id,
      name: step.name || step.id,
      operation_id: step.operation_id,
      replay_policy: step.replay_policy,
      action: {
        kind: "command",
        command: step.command,
        cwd,
        timeout_ms: Math.max(100, Math.min(Number(step.timeout_ms || 30_000), 300_000)),
        side_effect: step.side_effect,
        retry_on_nonzero: step.retry_on_nonzero === true,
      },
    };
  });
  return {
    version: 2 as const,
    source: "native_web_recovery_submit",
    goal_id: goalId,
    task_id: taskId,
    workspace_root: path.resolve(workspaceRoot),
    artifact_root: path.join(artifactRoot, "tasks", taskId),
    lease_ms: Math.max(250, Math.min(Number(input.lease_ms || 5_000), 60_000)),
    max_automatic_recoveries: Math.max(0, Math.min(Number(input.max_automatic_recoveries ?? 16), 64)),
    steps,
  };
}

function assertReceiptScope(
  receipt: DurableRecoveryPlanReceipt,
  paths: ReturnType<typeof durableRecoveryScopedPaths>,
  goalId: string,
  taskId: string
): void {
  if (!receipt || receipt.version !== 2 || receipt.goal_id !== goalId || receipt.task_id !== taskId ||
      receipt.plan_path !== paths.planPath || receipt.receipt_path !== paths.receiptPath ||
      receipt.artifact_root !== paths.taskRoot || !/^[a-f0-9]{64}$/.test(receipt.plan_sha256)) {
    throw new Error("RECOVERY_SUBMISSION_RECEIPT_SCOPE_MISMATCH");
  }
}

export async function submitDurableRecoveryPlan(
  workspaceRoot: string,
  input: DurableRecoveryPlanSubmission
): Promise<DurableRecoveryPlanReceipt> {
  const scope = captureDurableRecoveryScope(workspaceRoot);
  const paths = durableRecoveryScopedPaths(scope.workspace_root, scope.goal_id, input.task_id);
  const plan = normalizedPlan(scope.workspace_root, paths.goalArtifactRoot, scope.goal_id, input);
  const content = stableJson(plan);
  const planSha256 = sha256(content);
  const status = await serviceRecoverySupervisorStatus(scope.workspace_root);
  if (!status.enabled || (!status.running && !status.guardian_running)) {
    throw new Error("RECOVERY_SUBMISSION_SUPERVISOR_UNAVAILABLE");
  }
  const publication = await atomicCreate(paths.planPath, content);
  const receipt: DurableRecoveryPlanReceipt = {
    version: 2,
    goal_id: scope.goal_id,
    task_id: plan.task_id,
    plan_path: paths.planPath,
    receipt_path: paths.receiptPath,
    artifact_root: plan.artifact_root,
    plan_sha256: planSha256,
    submitted_at: new Date().toISOString(),
    idempotent: publication === "same",
    supervisor_running: status.running,
    ...(status.executor_state ? { executor_state: status.executor_state } : {}),
    operation_ids: plan.steps.map((step) => step.operation_id),
  };
  await fs.mkdir(path.dirname(paths.receiptPath), { recursive: true });
  const receiptContent = stableJson(receipt);
  if (await publishRecoveryFile(paths.receiptPath, receiptContent) === "exists") {
    const existing = JSON.parse(await fs.readFile(paths.receiptPath, "utf8")) as DurableRecoveryPlanReceipt;
    assertReceiptScope(existing, paths, scope.goal_id, plan.task_id);
    if (existing.plan_sha256 !== planSha256) throw new Error("RECOVERY_SUBMISSION_RECEIPT_DRIFT");
    return { ...existing, idempotent: true };
  }
  return receipt;
}

export async function readDurableRecoverySubmission(workspaceRoot: string, taskId: string): Promise<DurableRecoveryPlanReceipt | null> {
  const scope = captureDurableRecoveryScope(workspaceRoot);
  const paths = durableRecoveryScopedPaths(scope.workspace_root, scope.goal_id, taskId);
  let receipt: DurableRecoveryPlanReceipt;
  try {
    receipt = JSON.parse(await fs.readFile(paths.receiptPath, "utf8")) as DurableRecoveryPlanReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
  // Never search legacy task-only paths or adopt another Goal's receipt.
  assertReceiptScope(receipt, paths, scope.goal_id, taskId);
  const content = await fs.readFile(paths.planPath, "utf8");
  const plan = JSON.parse(content);
  if (sha256(content) !== receipt.plan_sha256 || plan?.version !== 2 || plan.goal_id !== scope.goal_id ||
      plan.task_id !== taskId || plan.artifact_root !== paths.taskRoot ||
      plan.workspace_root !== scope.workspace_root) {
    throw new Error("RECOVERY_SUBMISSION_PLAN_DRIFT");
  }
  return receipt;
}