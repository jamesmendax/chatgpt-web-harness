import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { durableRecoveryGoalKey } from "../../dist/lib/service-recovery-plan.js";

// Test-only authoring of detached plans. Production submission obtains Goal authority
// from RuntimeScope; fixtures supply an explicit, isolated Goal instead.
export function recoveryFixturePaths({ stateRoot, artifactRoot, goalId, taskId }) {
  const goalKey = durableRecoveryGoalKey(goalId);
  return {
    goalKey,
    taskRoot: path.join(artifactRoot, "goals", goalKey, "tasks", taskId),
    planPath: path.join(stateRoot, "plans", "goals", goalKey, taskId + ".plan.json"),
    receiptPath: path.join(stateRoot, "submissions", "goals", goalKey, taskId + ".submission.json"),
  };
}

export async function writeRecoveryPlanFixture({ stateRoot, artifactRoot, workspaceRoot, goalId, plan: input }) {
  const paths = recoveryFixturePaths({ stateRoot, artifactRoot, goalId, taskId: input.task_id });
  const plan = {
    workspace_root: workspaceRoot,
    artifact_root: paths.taskRoot,
    ...input,
    version: 2,
    goal_id: goalId,
  };
  const content = JSON.stringify(plan, null, 2) + "\n";
  const receipt = {
    version: 2,
    goal_id: goalId,
    task_id: plan.task_id,
    plan_path: paths.planPath,
    receipt_path: paths.receiptPath,
    artifact_root: plan.artifact_root,
    plan_sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    submitted_at: new Date().toISOString(),
    idempotent: false,
    supervisor_running: true,
    operation_ids: plan.steps.map((step) => step.operation_id),
  };
  await fs.mkdir(path.dirname(paths.planPath), { recursive: true });
  await fs.mkdir(path.dirname(paths.receiptPath), { recursive: true });
  await fs.writeFile(paths.planPath, content, { encoding: "utf8", flag: "wx" });
  await fs.writeFile(paths.receiptPath, JSON.stringify(receipt, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  return { plan, receipt, paths };
}