import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { recoverTask, readRecoveryTask } from "../dist/lib/recovery-engine.js";

import { recoveryFixturePaths, writeRecoveryPlanFixture } from "./lib/recovery-plan-fixture.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError.message}` : ""}`);
}

async function lines(file) {
  try {
    return (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-durable-plan-"));
const workspace = path.join(root, "workspace");
const stateRoot = path.join(root, "state");
const artifactRoot = path.join(root, "artifacts");
const plansDir = path.join(stateRoot, "plans");
const goalId = "recovery-durable-fixture-goal";
const scopedPaths = (taskId) => recoveryFixturePaths({ stateRoot, artifactRoot, goalId, taskId });
const publishPlan = (plan) => writeRecoveryPlanFixture({ stateRoot, artifactRoot, workspaceRoot: workspace, goalId, plan });
await Promise.all([
  fs.mkdir(workspace, { recursive: true }),
  fs.mkdir(plansDir, { recursive: true }),
  fs.mkdir(artifactRoot, { recursive: true }),
]);

const host = spawn(process.execPath, [
  path.join(sourceRoot, "scripts", "service-recovery-host.mjs"),
  "--workspace", workspace,
  "--state-root", stateRoot,
  "--artifact-root", artifactRoot,
  "--launch-token", "phase4-durable-plan-test",
], {
  cwd: sourceRoot,
  env: {
    ...process.env,
    HARNESS_RECOVERY_WORKER_RESTART_BASE_MS: "100",
    HARNESS_RECOVERY_WORKER_RESTART_MAX_MS: "500",
    HARNESS_RECOVERY_WORKER_RESTART_LIMIT: "6",
    HARNESS_RECOVERY_WORKER_STABLE_MS: "1000",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let hostOut = "";
let hostErr = "";
host.stdout.setEncoding("utf8");
host.stderr.setEncoding("utf8");
host.stdout.on("data", (chunk) => { hostOut += chunk; });
host.stderr.on("data", (chunk) => { hostErr += chunk; });

try {
  const hostStatusFile = path.join(stateRoot, "host-status.json");
  await waitFor("initial worker", async () => {
    const status = await readJson(hostStatusFile);
    return status.worker_pid ? status : false;
  });

  const safeTask = "safe-worker-crash";
  const stableOperation = "nlr-20261001-03-op-7f8c2f44-16f1-4a79-a5e7-0c0a8fda8921";
  const safeTaskRoot = scopedPaths(safeTask).taskRoot;
  await publishPlan({
    task_id: safeTask,
    artifact_root: safeTaskRoot,
    lease_ms: 250,
    max_automatic_recoveries: 4,
    steps: [{
      id: "crash-once",
      name: "safe crash once",
      operation_id: stableOperation,
      replay_policy: "safe",
      action: { kind: "crash_worker_once", effect_file: "effects.log", exit_code: 71 },
    }],
  });

  const safeState = await waitFor("same-operation safe recovery", async () => {
    const state = await readRecoveryTask(safeTaskRoot, safeTask);
    return state?.status === "completed" ? state : false;
  });
  assert.equal(safeState.goal_id, goalId);
  assert.equal(safeState.steps[0].receipt.goal_id, goalId);
  assert.equal(safeState.final_receipt.goal_id, goalId);
  assert.equal(safeState.steps[0].operation_id, stableOperation);
  assert.equal(safeState.steps[0].receipt.operation_id, stableOperation);
  assert.equal(safeState.recovery_count >= 1, true);
  assert.deepEqual(await lines(path.join(safeTaskRoot, "effects.log")), [stableOperation]);
  const afterSafe = await readJson(hostStatusFile);
  assert.equal(afterSafe.worker_restart_count >= 1, true);

  const unknownTask = "unknown-effect-crash";
  const unknownOperation = "nlr-20261001-03-unknown-effect";
  const unknownTaskRoot = scopedPaths(unknownTask).taskRoot;
  await publishPlan({
    task_id: unknownTask,
    artifact_root: unknownTaskRoot,
    lease_ms: 250,
    max_automatic_recoveries: 4,
    steps: [{
      id: "unknown-write",
      name: "append then crash",
      operation_id: unknownOperation,
      replay_policy: "never",
      action: { kind: "append_then_crash_once", effect_file: "effects.log", exit_code: 72 },
    }],
  });

  const unknownState = await waitFor("unknown side effect blocks replay", async () => {
    const state = await readRecoveryTask(unknownTaskRoot, unknownTask);
    return state?.status === "blocked" ? state : false;
  });
  assert.equal(unknownState.failure_reason, "unknown_side_effect_result");
  assert.equal(unknownState.steps[0].operation_id, unknownOperation);
  const unknownEffects = await waitFor("unknown effect durable write", async () => {
    const observed = await lines(path.join(unknownTaskRoot, "effects.log"));
    return observed.length === 1 && observed[0] === unknownOperation ? observed : false;
  });
  assert.deepEqual(unknownEffects, [unknownOperation]);

  const approvalTask = "approval-wait";
  const approvalOperation = "nlr-20261001-03-approval-wait";
  const approvalTaskRoot = scopedPaths(approvalTask).taskRoot;
  await publishPlan({
    task_id: approvalTask,
    artifact_root: approvalTaskRoot,
    lease_ms: 250,
    max_automatic_recoveries: 4,
    steps: [{
      id: "await-approval",
      name: "await approval",
      operation_id: approvalOperation,
      replay_policy: "never",
      action: { kind: "approval_wait" },
    }],
  });

  const approvalState = await waitFor("approval wait persists", async () => {
    const state = await readRecoveryTask(approvalTaskRoot, approvalTask);
    return state?.status === "waiting" ? state : false;
  });
  assert.equal(approvalState.steps[0].operation_id, approvalOperation);
  assert.equal(approvalState.steps[0].failure_reason, "approval_pending");
  assert.equal(approvalState.steps[0].attempts.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 650));
  const approvalStillWaiting = await readRecoveryTask(approvalTaskRoot, approvalTask);
  assert.equal(approvalStillWaiting.status, "waiting");
  assert.equal(approvalStillWaiting.steps[0].attempts.length, 1);

  const concurrentRoot = path.join(root, "concurrent");
  await fs.mkdir(concurrentRoot, { recursive: true });
  let entered = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const plan = {
    steps: [{
      id: "only-once",
      name: "only-once",
      operation_id: "concurrent-stable-op",
      replay_policy: "safe",
    }],
  };
  const first = recoverTask({
    workspaceRoot: concurrentRoot,
    taskId: "concurrent-single-executor",
    plan,
    executor: async () => {
      entered += 1;
      await gate;
      return { ok: true };
    },
  });
  await waitFor("first executor entry", () => entered === 1);
  const competing = await recoverTask({
    workspaceRoot: concurrentRoot,
    taskId: "concurrent-single-executor",
    plan,
    executor: async () => {
      entered += 1;
      return { duplicate: true };
    },
  });
  assert.equal(competing.action, "busy");
  assert.equal(entered, 1);
  release();
  const firstResult = await first;
  assert.equal(firstResult.action, "completed");
  assert.equal(entered, 1);

  console.log(JSON.stringify({
    test: "service-recovery-durable-plan",
    status: "PASS",
    stable_operation_id: stableOperation,
    safe_recovery_count: safeState.recovery_count,
    safe_effect_count: (await lines(path.join(safeTaskRoot, "effects.log"))).length,
    unknown_operation_id: unknownOperation,
    unknown_effect_count: unknownEffects.length,
    unknown_failure_reason: unknownState.failure_reason,
    approval_operation_id: approvalOperation,
    approval_attempts: approvalStillWaiting.steps[0].attempts.length,
    approval_status: approvalStillWaiting.status,
    concurrent_executor_entries: entered,
    host_worker_restart_count: (await readJson(hostStatusFile)).worker_restart_count,
  }));
} catch (error) {
  console.error(hostOut);
  console.error(hostErr);
  throw error;
} finally {
  try { host.kill("SIGTERM"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    if (host.exitCode === null) host.kill("SIGKILL");
  } catch {}
  await fs.rm(root, { recursive: true, force: true });
}
