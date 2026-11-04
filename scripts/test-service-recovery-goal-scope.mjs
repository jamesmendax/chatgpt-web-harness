import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-goal-scope-"));
const workspace = path.join(root, "workspace");
const stateRoot = path.join(root, "state");
const artifactRoot = path.join(root, "artifacts");
await fs.mkdir(workspace, { recursive: true });
Object.assign(process.env, {
  HARNESS_RECOVERY_SUPERVISOR_ENABLED: "true",
  HARNESS_RECOVERY_SUPERVISOR_STATE_DIR: stateRoot,
  HARNESS_RECOVERY_ARTIFACT_ROOT: artifactRoot,
  CODEX_HOME: path.join(root, "codex-home"),
  HARNESS_RECOVERY_WORKER_RESTART_BASE_MS: "100",
  HARNESS_RECOVERY_WORKER_RESTART_MAX_MS: "500",
  HARNESS_RECOVERY_WORKER_RESTART_LIMIT: "2",
});
const { recoveryFixturePaths, writeRecoveryPlanFixture } = await import("./lib/recovery-plan-fixture.mjs");
const {
  submitDurableRecoveryPlan, readDurableRecoverySubmission, durableRecoveryPlanFingerprint,
} = await import("../dist/lib/service-recovery-plan.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const { startServiceRecoverySupervisor, stopServiceRecoverySupervisor } = await import("../dist/lib/service-recovery-supervisor.js");
const { recoverTask, readRecoveryTask } = await import("../dist/lib/recovery-engine.js");
const { registerRecoveryTools } = await import("../dist/tools/recovery.js");

const goalA = "recovery-goal-A";
const goalB = "recovery-goal-B";
const taskId = "same-task";
const operationId = "same:stable:operation";
const checks = [];
let started = false;
function scopeFor(goalId, scopedWorkspace = workspace) {
  const scope = createRuntimeScope({ workspaceRoot: scopedWorkspace, projectRoots: [scopedWorkspace] }, { sessionId: "session-" + goalId });
  scope.goalId = goalId;
  scope.goalOwnerSessionId = scope.mcpSessionId;
  return scope;
}
function scoped(goalId, fn) { return runWithRuntimeScope(scopeFor(goalId), fn); }
function input(command = "echo scoped-output", id = taskId) {
  return {
    task_id: id, lease_ms: 250, max_automatic_recoveries: 0,
    steps: [{ id: "only", operation_id: operationId, replay_policy: "safe", command, side_effect: "none" }],
  };
}
async function readJson(file) { return JSON.parse(await fs.readFile(file, "utf8")); }
async function exists(file) { return fs.access(file).then(() => true, () => false); }
async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error(label + " timeout" + (last ? ": " + last.message : ""));
}
async function summary(goalId, id) {
  const status = await readJson(path.join(stateRoot, "worker-status.json"));
  return status.summaries?.find((entry) => (entry.goal_id ?? null) === goalId && entry.task_id === id);
}
async function output(taskRoot) {
  const directory = path.join(taskRoot, "command-output");
  const names = await fs.readdir(directory);
  return (await Promise.all(names.map((name) => fs.readFile(path.join(directory, name), "utf8")))).join("\n");
}
const callbacks = new Map();
registerRecoveryTools({ registerTool(name, _definition, handler) { callbacks.set(name, handler); } }, workspace);
const statusTool = (goalId, id) => scoped(goalId, () => callbacks.get("recovery_status")({ task_id: id }));

try {
  await assert.rejects(submitDurableRecoveryPlan(workspace, input()), /GOAL_SCOPE_REQUIRED/);
  await assert.rejects(readDurableRecoverySubmission(workspace, taskId), /GOAL_SCOPE_REQUIRED/);
  await assert.rejects(runWithRuntimeScope(scopeFor(undefined), () => submitDurableRecoveryPlan(workspace, input())), /GOAL_SCOPE_REQUIRED/);
  await assert.rejects(runWithRuntimeScope(scopeFor(goalA, root), () => submitDurableRecoveryPlan(workspace, input())), /WORKSPACE_SCOPE_MISMATCH/);
  const unscopedStatus = await callbacks.get("recovery_status")({ task_id: taskId });
  assert.equal(unscopedStatus.structuredContent.ok, false);
  assert.match(unscopedStatus.structuredContent.data.error, /GOAL_SCOPE_REQUIRED/);
  assert.equal(await exists(path.join(stateRoot, "plans")), false, "unauthorized scope must fail before publishing any plan");
  checks.push("submission and status require trusted Goal/workspace scope");

  const legacyTask = "legacy-unassigned";
  const legacyTaskRoot = path.join(artifactRoot, "tasks", legacyTask);
  const legacyPlanPath = path.join(stateRoot, "plans", legacyTask + ".plan.json");
  const legacyReceiptPath = path.join(stateRoot, "submissions", legacyTask + ".submission.json");
  await fs.mkdir(path.dirname(legacyPlanPath), { recursive: true });
  await fs.mkdir(path.dirname(legacyReceiptPath), { recursive: true });
  const legacyContent = JSON.stringify({
    version: 1, task_id: legacyTask, workspace_root: workspace, artifact_root: legacyTaskRoot,
    steps: [{ id: "unknown", operation_id: "legacy-operation", replay_policy: "never", action: { kind: "append", text: "must-not-run" } }],
  });
  await fs.writeFile(legacyPlanPath, legacyContent);
  await fs.writeFile(legacyReceiptPath, JSON.stringify({ task_id: legacyTask, artifact_root: legacyTaskRoot }));
  assert.equal(await scoped(goalA, () => readDurableRecoverySubmission(workspace, legacyTask)), null);

  const pending = await writeRecoveryPlanFixture({
    stateRoot, artifactRoot, workspaceRoot: workspace, goalId: goalA,
    plan: { task_id: "missing-receipt", steps: [{ id: "one", operation_id: "pending-op", replay_policy: "never", action: { kind: "append" } }] },
  });
  await fs.unlink(pending.paths.receiptPath);
  const tampered = await writeRecoveryPlanFixture({
    stateRoot, artifactRoot, workspaceRoot: workspace, goalId: goalA,
    plan: { task_id: "tampered-goal", steps: [{ id: "one", operation_id: "tampered-op", replay_policy: "never", action: { kind: "append" } }] },
  });
  await fs.writeFile(tampered.paths.planPath, JSON.stringify({ ...tampered.plan, goal_id: goalB }));
  const crossArtifact = await writeRecoveryPlanFixture({
    stateRoot, artifactRoot, workspaceRoot: workspace, goalId: goalA,
    plan: {
      task_id: "cross-artifact",
      artifact_root: recoveryFixturePaths({ stateRoot, artifactRoot, goalId: goalB, taskId: "cross-artifact" }).taskRoot,
      steps: [{ id: "one", operation_id: "cross-op", replay_policy: "never", action: { kind: "append" } }],
    },
  });

  started = true;
  const supervisor = await startServiceRecoverySupervisor(workspace);
  assert.equal(supervisor.running, true);
  const legacySummary = await waitFor("legacy plan blocked", () => summary(null, legacyTask));
  assert.equal(legacySummary.action, "blocked");
  assert.match(legacySummary.error, /LEGACY_SCOPE_UNASSIGNED/);
  assert.equal(await exists(legacyTaskRoot), false);
  assert.equal(await fs.readFile(legacyPlanPath, "utf8"), legacyContent);
  const pendingSummary = await waitFor("unreceipted plan blocked", () => summary(goalA, "missing-receipt"));
  assert.equal(pendingSummary.action, "blocked");
  assert.match(pendingSummary.error, /SUBMISSION_RECEIPT_MISSING/);
  assert.equal(await exists(pending.paths.taskRoot), false);
  const tamperedSummary = await waitFor("copied Goal plan rejected", () => summary(goalB, "tampered-goal"));
  assert.match(tamperedSummary.error, /GOAL_SCOPE_PATH_MISMATCH/);
  assert.equal(await exists(tampered.paths.taskRoot), false);
  const crossSummary = await waitFor("cross-Goal artifact rejected", () => summary(goalA, "cross-artifact"));
  assert.match(crossSummary.error, /ARTIFACT_GOAL_SCOPE_MISMATCH/);
  assert.equal(await exists(crossArtifact.plan.artifact_root), false);
  checks.push("legacy, unreceipted, copied Goal and cross-Goal artifact plans never execute");

  // Mutating the caller's scope after entry simulates another invocation becoming
  // current while supervisor status is awaited. The durable plan must retain A.
  const mutableScope = scopeFor(goalA);
  const submissionA = runWithRuntimeScope(mutableScope, () => submitDurableRecoveryPlan(workspace, { ...input("echo GOAL-A"), goal_id: goalB }));
  mutableScope.goalId = goalB;
  const receiptA = await submissionA;
  const receiptB = await scoped(goalB, () => submitDurableRecoveryPlan(workspace, input("echo GOAL-B")));
  const onlyA = await scoped(goalA, () => submitDurableRecoveryPlan(workspace, input("echo A-ONLY", "only-A")));
  assert.equal(receiptA.goal_id, goalA, "caller input or a later scope change must not replace captured Goal");
  assert.equal(receiptB.goal_id, goalB);
  assert.notEqual(receiptA.plan_path, receiptB.plan_path);
  assert.notEqual(receiptA.receipt_path, receiptB.receipt_path);
  assert.notEqual(receiptA.artifact_root, receiptB.artifact_root);
  assert.notEqual(receiptA.plan_sha256, receiptB.plan_sha256);
  const originalReceipt = await fs.readFile(receiptA.receipt_path, "utf8");
  const repeatA = await scoped(goalA, () => submitDurableRecoveryPlan(workspace, input("echo GOAL-A")));
  assert.equal(repeatA.idempotent, true);
  assert.equal(repeatA.submitted_at, receiptA.submitted_at);
  assert.equal(repeatA.plan_sha256, receiptA.plan_sha256);
  assert.equal(await fs.readFile(receiptA.receipt_path, "utf8"), originalReceipt);
  const planA = await readJson(receiptA.plan_path);
  assert.equal(planA.goal_id, goalA);
  assert.notEqual(
    durableRecoveryPlanFingerprint(planA),
    durableRecoveryPlanFingerprint({ ...planA, goal_id: goalB }),
    "Goal identity must independently change the plan fingerprint"
  );
  assert.equal((await scoped(goalA, () => readDurableRecoverySubmission(workspace, taskId))).goal_id, goalA);
  assert.equal((await scoped(goalB, () => readDurableRecoverySubmission(workspace, taskId))).goal_id, goalB);
  const absentB = await statusTool(goalB, "only-A");
  assert.equal(absentB.structuredContent.ok, true);
  assert.equal(absentB.structuredContent.data.receipt, null);
  assert.equal(absentB.structuredContent.data.execution, null);
  checks.push("same task and operation IDs coexist; scope is captured once; receipts remain immutable");

  const completed = await Promise.all([receiptA, receiptB, onlyA].map((receipt) => waitFor("scoped command completion", async () => {
    const state = await readRecoveryTask(receipt.artifact_root, receipt.task_id);
    return state?.status === "completed" ? state : false;
  })));
  for (let index = 0; index < completed.length; index++) {
    const expectedGoal = index === 1 ? goalB : goalA;
    assert.equal(completed[index].goal_id, expectedGoal);
    assert.equal(completed[index].steps[0].receipt.goal_id, expectedGoal);
    assert.equal(completed[index].final_receipt.goal_id, expectedGoal);
    assert.equal(completed[index].steps[0].attempts.length, 1);
  }
  assert.match(await output(receiptA.artifact_root), /GOAL-A/);
  assert.doesNotMatch(await output(receiptA.artifact_root), /GOAL-B/);
  assert.match(await output(receiptB.artifact_root), /GOAL-B/);
  const statusA = await statusTool(goalA, taskId);
  const statusB = await statusTool(goalB, taskId);
  assert.equal(statusA.structuredContent.data.execution.goal_id, goalA);
  assert.equal(statusB.structuredContent.data.execution.goal_id, goalB);
  checks.push("detached execution and status retain each Goal across concurrent submissions");

  await stopServiceRecoverySupervisor(workspace);
  started = false;
  await fs.writeFile(receiptA.receipt_path, JSON.stringify({ ...receiptA, goal_id: goalB }));
  await assert.rejects(scoped(goalA, () => readDurableRecoverySubmission(workspace, taskId)), /RECEIPT_SCOPE_MISMATCH/);
  await fs.writeFile(receiptA.receipt_path, originalReceipt);
  const stateFile = path.join(receiptA.artifact_root, ".recovery-engine", "task-" + taskId + ".json");
  const originalState = await fs.readFile(stateFile, "utf8");
  const forged = JSON.parse(originalState);
  forged.steps[0].receipt.goal_id = goalB;
  await fs.writeFile(stateFile, JSON.stringify(forged));
  const corruptStatus = await statusTool(goalA, taskId);
  assert.equal(corruptStatus.structuredContent.ok, false);
  assert.match(corruptStatus.structuredContent.data.error, /EXECUTION_GOAL_SCOPE_MISMATCH/);
  await fs.writeFile(stateFile, originalState);
  checks.push("status rejects substituted submission or execution receipts");

  const engineRoot = path.join(root, "engine-scoped");
  const enginePlan = { goal_id: goalA, steps: [{ id: "one", operation_id: operationId, replay_policy: "safe" }] };
  let executions = 0;
  const engineOptions = { workspaceRoot: engineRoot, taskId, plan: enginePlan, executor: async () => ({ executions: ++executions }) };
  const engineResult = await recoverTask(engineOptions);
  assert.equal(engineResult.state.goal_id, goalA);
  assert.equal(engineResult.state.steps[0].receipt.goal_id, goalA);
  assert.equal(engineResult.state.final_receipt.goal_id, goalA);
  await assert.rejects(recoverTask({ ...engineOptions, plan: { ...enginePlan, goal_id: goalB } }), /GOAL_SCOPE_MISMATCH/);
  assert.equal(executions, 1);
  const engineStateFile = path.join(engineRoot, ".recovery-engine", "task-" + taskId + ".json");
  const engineState = await readJson(engineStateFile);
  await fs.writeFile(engineStateFile, JSON.stringify({
    ...engineState, steps: [{ ...engineState.steps[0], receipt: { ...engineState.steps[0].receipt, goal_id: goalB } }],
  }));
  await assert.rejects(recoverTask(engineOptions), /RECEIPT_CORRUPT/);
  await fs.writeFile(engineStateFile, JSON.stringify({ ...engineState, final_receipt: { ...engineState.final_receipt, goal_id: goalB } }));
  await assert.rejects(recoverTask(engineOptions), /RECEIPT_CORRUPT/);
  assert.equal(executions, 1);
  const genericOptions = {
    workspaceRoot: path.join(root, "engine-generic"), taskId,
    plan: { steps: enginePlan.steps }, executor: async () => ({ generic: true }),
  };
  const generic = await recoverTask(genericOptions);
  assert.equal(generic.action, "completed");
  assert.equal(Object.hasOwn(generic.state, "goal_id"), false);
  assert.equal(Object.hasOwn(generic.state.steps[0].receipt, "goal_id"), false);
  assert.equal((await recoverTask(genericOptions)).action, "completed");
  await assert.rejects(recoverTask({ ...genericOptions, plan: enginePlan }), /GOAL_SCOPE_MISMATCH/);
  checks.push("engine enforces scoped receipts and preserves unscoped generic compatibility");

  console.log(JSON.stringify({ test: "service-recovery-goal-scope", status: "PASS", checks }, null, 2));
} finally {
  if (started) await stopServiceRecoverySupervisor(workspace).catch(() => {});
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}