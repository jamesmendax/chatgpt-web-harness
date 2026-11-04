import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-create-fault-matrix-"));
const savedEnv = Object.fromEntries([
  "CODEX_HOME", "GOAL_WATCHDOG_ENABLED", "HARNESS_RELAY_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_COMPANION_ENABLED",
].map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(temp, "state");
process.env.GOAL_WATCHDOG_ENABLED = "false";
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_ENABLED = "false";

const goals = await import("../dist/lib/goals.js");
const runs = await import("../dist/lib/goal-run-store.js");
const tasks = await import("../dist/lib/durable-tasks.js");
const relay = await import("../dist/lib/relay-manager.js");
const driver = await import("../dist/lib/driver-lease.js");
const { ensureGoalRunAuthority } = await import("../dist/lib/goal-run-web.js");
const { withRelayGoal, legacyRelayRoot } = await import("../dist/lib/relay-scope.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");

const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace, { recursive: true });
const projectSlug = crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12);
const stateRoot = path.join(process.env.CODEX_HOME, "projects", projectSlug);
const sessionFile = (session, file) => path.join(stateRoot, "sessions", session, file);
const taskFile = (id) => path.join(tasks.durableTaskDir(workspace), `${id}.json`);
const journalFile = (session = "session-A") => goals.goalCreationJournalPath(workspace, session);
const read = (file) => fs.readFile(file, "utf8");
const input = (objective) => ({ objective, success_criteria: [{ name: `${objective} verified`, passed: false }] });
const inSession = (session, fn) => runWithRuntimeScope(
  createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId: session }), fn,
);
const relayState = (goalId) => withRelayGoal(workspace, goalId, () => relay.readRelayManagerState(workspace));
const seedOldLease = async (goalId) => {
  const lease = await driver.ensureDriverLease(workspace, {
    goalId, ownerSessionId: "session-A", executionContractHash: "a".repeat(64), intentRevision: 1,
  });
  assert.equal((await driver.readDriverLease(workspace, goalId)).state, "ACTIVE");
  return lease;
};

function injectRenameFailure(target, predicate, { afterCommit = false } = {}) {
  const original = fs.rename;
  let injected = false;
  fs.rename = async (source, destination) => {
    if (!injected && path.resolve(String(destination)) === path.resolve(target) && await predicate(source)) {
      injected = true;
      if (afterCommit) await original(source, destination);
      throw Object.assign(new Error("A0.3 injected journal boundary failure"), { code: "EACCES" });
    }
    return original(source, destination);
  };
  return { restore: () => { fs.rename = original; }, get injected() { return injected; } };
}

function recoverInFreshProcess(session) {
  const source = [
    'import { createRuntimeScope, runWithRuntimeScope } from "./dist/lib/runtime-scope.js";',
    'import { recoverGoalCreation } from "./dist/lib/goals.js";',
    'const workspace = process.env.A0_MATRIX_WORKSPACE;',
    `const session = ${JSON.stringify(session)};`,
    'const scope = createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId: session });',
    'const goal = await runWithRuntimeScope(scope, () => recoverGoalCreation(workspace));',
    'process.stdout.write(JSON.stringify({ id: goal?.id ?? null }));',
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1_000_000,
    env: { ...process.env, A0_MATRIX_WORKSPACE: workspace },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return JSON.parse(child.stdout).id;
}

try {
  const foreign = await inSession("session-B", () => goals.createGoal(workspace, input("foreign owner remains isolated")));
  await assert.rejects(fs.stat(legacyRelayRoot(workspace)), { code: "ENOENT" },
    "ordinary Goal creation must not create retired Relay state");
  assert.equal((await runs.readGoalRun(workspace, "session-B"))?.run.runId, foreign.id);
  const foreignTask = await inSession("session-B", () => tasks.createDurableTask(workspace, { goal: "foreign task remains active" }));
  const foreignBytes = await Promise.all([
    sessionFile("session-B", "goal.json"),
    sessionFile("session-B", "goal-run.json"),
    taskFile(foreignTask.id),
  ].map(read));

  const phases = [
    { phase: "prepared", durable: "prepared", afterCommit: true },
    { phase: "archived", durable: "prepared" },
    { phase: "relay_fenced", durable: "archived", restart: true },
    { phase: "task_cancelled", durable: "relay_fenced" },
    { phase: "goal_published", durable: "task_cancelled" },
    { phase: "run_published", durable: "goal_published" },
    { phase: "committed", durable: "run_published" },
  ];

  for (const scenario of phases) {
    const old = await inSession("session-A", () => goals.createGoal(workspace, input(`old phase ${scenario.phase}`)));
    await inSession("session-A", () => ensureGoalRunAuthority(workspace, old));
    const oldRun = await runs.readGoalRun(workspace, "session-A");
    assert.equal(oldRun?.run.runId, old.id);
    const oldTask = await inSession("session-A", () => tasks.createDurableTask(workspace, { goal: `old task ${scenario.phase}` }));
    await seedOldLease(old.id);
    const replacement = input(`replacement phase ${scenario.phase}`);
    const hook = injectRenameFailure(journalFile(), async (source) => {
      const value = JSON.parse(await read(source));
      return value.phase === scenario.phase;
    }, { afterCommit: scenario.afterCommit === true });
    try {
      await assert.rejects(
        () => inSession("session-A", () => goals.createGoal(workspace, replacement)),
        /A0\.3 injected journal boundary failure/,
      );
    } finally { hook.restore(); }
    assert.equal(hook.injected, true, `journal phase ${scenario.phase} was not reached`);

    const pending = JSON.parse(await read(journalFile()));
    assert.equal(pending.phase, scenario.durable, `${scenario.phase} must leave the last durable phase intact`);
    assert.equal(pending.previous_goal.id, old.id);
    assert.equal(pending.previous_task_id, oldTask.id);
    assert.ok(pending.new_goal.id);
    if (scenario.phase === "prepared") {
      const before = await read(journalFile());
      await assert.rejects(
        () => inSession("session-A", () => goals.createGoal(workspace, input("different fingerprint must not replace pending"))),
        /GOAL_CREATION_PENDING/,
      );
      assert.equal(await read(journalFile()), before, "different fingerprint mutated the pending transaction");
    }
    if (scenario.phase === "relay_fenced") {
      assert.ok((await relayState(old.id)).fenced_at, "Relay fence must be durable before restart recovery");
    }

    const recoveredId = scenario.phase === "prepared"
      ? (await inSession("session-A", () => goals.createGoal(workspace, replacement))).id
      : scenario.restart
        ? recoverInFreshProcess("session-A")
        : (await inSession("session-A", () => goals.recoverGoalCreation(workspace)))?.id;
    assert.equal(recoveredId, pending.new_goal.id, `${scenario.phase} recovery minted a different Goal identity`);
    const recovered = JSON.parse(await read(sessionFile("session-A", "goal.json")));
    const currentRun = await runs.readGoalRun(workspace, "session-A");
    assert.equal(recovered.id, pending.new_goal.id);
    assert.equal(currentRun?.run.runId, recovered.id, "Goal and GoalRun identity diverged after recovery");
    assert.equal(JSON.parse(await read(journalFile())).phase, "committed");
    assert.deepEqual(await runs.readArchivedGoalRun(workspace, old.id, "session-A"), oldRun,
      "the exact previous GoalRun evidence must be archived and retained");
    assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, oldTask.id))).status, "cancelled");
    await assert.rejects(
      () => fs.access(path.join(tasks.durableTaskDir(workspace), "active-task.session-A.json")),
      (error) => error?.code === "ENOENT",
      "recovery must remove the durable active-task pointer even when another process has a stale cache",
    );
    assert.ok((await relayState(old.id)).fenced_at, "superseded Relay must remain fenced");
    assert.equal((await driver.readDriverLease(workspace, old.id)).state, "RELEASED",
      "superseded legacy lease must remain revoked");
    assert.deepEqual(await Promise.all([
      sessionFile("session-B", "goal.json"),
      sessionFile("session-B", "goal-run.json"),
      taskFile(foreignTask.id),
    ].map(read)), foreignBytes, "foreign-session Goal/GoalRun/Task bytes changed during recovery");
    assert.equal(JSON.parse(await read(journalFile())).new_goal.id, recovered.id);
  }

  // Archive succeeds and Relay is fenced, but durable Task cancellation fails
  // before the journal advances. Recovery must finish that exact transaction.
  const old = await inSession("session-A", () => goals.createGoal(workspace, input("archive before task-cancel failure")));
  await inSession("session-A", () => ensureGoalRunAuthority(workspace, old));
  const oldRun = await runs.readGoalRun(workspace, "session-A");
  const oldTask = await inSession("session-A", () => tasks.createDurableTask(workspace, { goal: "task cancellation failure fixture" }));
  await seedOldLease(old.id);
  const taskFailure = injectRenameFailure(taskFile(oldTask.id), async () => true);
  try {
    await assert.rejects(
      () => inSession("session-A", () => goals.createGoal(workspace, input("recover after task cancel failure"))),
      /A0\.3 injected journal boundary failure/,
    );
  } finally { taskFailure.restore(); }
  assert.equal(taskFailure.injected, true);
  assert.equal(JSON.parse(await read(journalFile())).phase, "relay_fenced");
  assert.deepEqual(await runs.readArchivedGoalRun(workspace, old.id, "session-A"), oldRun);
  assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, oldTask.id))).status, "active",
    "the injected Task write failure must leave the old Task active until recovery");
  assert.ok((await relayState(old.id)).fenced_at, "Relay must remain fenced while Task cancellation is pending");
  assert.equal((await driver.readDriverLease(workspace, old.id)).state, "RELEASED");
  const recovered = await inSession("session-A", () => goals.recoverGoalCreation(workspace));
  assert.ok(recovered?.id);
  assert.equal((await runs.readGoalRun(workspace, "session-A")).run.runId, recovered.id);
  assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, oldTask.id))).status, "cancelled");
  assert.deepEqual(await Promise.all([
    sessionFile("session-B", "goal.json"),
    sessionFile("session-B", "goal-run.json"),
    taskFile(foreignTask.id),
  ].map(read)), foreignBytes, "archive/task-cancel recovery changed foreign-session state");

  console.log("goal-create-fault-matrix: 7 journal phase boundaries, post-Relay-fence fresh-process recovery, archive-success/task-cancel-failure, Goal/GoalRun parity, stable journal identity, and foreign-session byte isolation PASS");
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
