import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-public-session-"));
const envKeys = ["CODEX_HOME", "GOAL_WATCHDOG_ENABLED", "HARNESS_RELAY_ENABLED", "CHATGPT_TOOL_PROFILE"];
const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(temp, "state");
process.env.GOAL_WATCHDOG_ENABLED = "false";
process.env.HARNESS_RELAY_ENABLED = "false";
process.env.CHATGPT_TOOL_PROFILE = "slim";
const { createMcpServer } = await import("../dist/server-factory.js");
const goals = await import("../dist/lib/goals.js");
const runs = await import("../dist/lib/goal-run-store.js");
const tasks = await import("../dist/lib/durable-tasks.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const { runtimePrincipalId } = await import("../dist/lib/mcp-request-identity.js");
const { accountProjectDir } = await import("../dist/lib/account-project-scope.js");
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace);
const seed = { workspaceRoot: workspace, projectRoots: [workspace], principalId: runtimePrincipalId(workspace), tunnelProfile: process.env.CHATGPT_TUNNEL_PROFILE?.trim() || undefined };
const inSession = (sessionId, fn) => runWithRuntimeScope(createRuntimeScope(seed, { sessionId }), fn);
const stateRoot = inSession("session-A", () => accountProjectDir(path.join(process.env.CODEX_HOME, "projects", crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12))));
const sessionFile = (session, file) => path.join(stateRoot, "sessions", session, file);
const read = (file) => fs.readFile(file, "utf8");
const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "goal-public-session-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const call = async (session, args, name = "goal") => {
  serverTransport.sessionId = session;
  return client.callTool({ name, arguments: args });
};
const ok = (result) => {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result));
  return result.structuredContent.data;
};
const create = (objective) => ({ action: "create", objective, success_criteria: [{ name: objective + " verified", passed: false }] });

await inSession("session-A", async () => { try {
  const first = ok(await call("session-A", create("first task"))).goal;
  const oldTask = ok(await call("session-A", { action: "create", goal: "first task" }, "task_state")).handoff.task_id;
  const paused = ok(await call("session-A", { action: "pause", expected_revision: first.revision })).goal;
  assert.equal(paused.status, "paused");
  const pausedRun = JSON.parse(await read(sessionFile("session-A", "goal-run.json")));
  const secondData = ok(await call("session-A", create("second task")));
  const second = secondData.goal;
  assert.notEqual(second.id, first.id, "same-session create did not replace a paused Goal");
  assert.equal(secondData.stale_task_cancelled, true);
  assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, oldTask))).status, "cancelled");
  assert.deepEqual(await runs.readArchivedGoalRun(workspace, first.id, "session-A"), pausedRun);

  const stableGoal = await read(sessionFile("session-A", "goal.json"));
  const stableRun = await read(sessionFile("session-A", "goal-run.json"));
  const foreign = ok(await call("session-B", create("foreign task"))).goal;
  assert.equal(await read(sessionFile("session-A", "goal.json")), stableGoal, "another Chat's create changed A");
  assert.equal(await read(sessionFile("session-A", "goal-run.json")), stableRun, "another Chat's create changed A evidence");
  const foreignGoal = await read(sessionFile("session-B", "goal.json"));
  const foreignRun = await read(sessionFile("session-B", "goal-run.json"));
  const bound = ok(await call("session-A", { action: "bind", expected_revision: 999 }));
  assert.equal(bound.result, "ALREADY_BOUND", "same owner bind must be a successful no-op even with a stale revision");
  assert.equal(bound.goal.id, second.id, "idempotent bind followed another Goal's global projection");
  const retriedBind = ok(await call("session-A", { action: "bind", expected_revision: 999, takeover_token: "stale-prior-bind-token-00000000000" }));
  assert.equal(retriedBind.result, "ALREADY_BOUND", "ordinary bind retry followed a foreign projection after ownership was already acquired");
  assert.equal(retriedBind.goal.id, second.id);
  assert.equal(await read(sessionFile("session-A", "goal.json")), stableGoal);
  assert.equal(await read(sessionFile("session-A", "goal-run.json")), stableRun);
  assert.equal(await read(sessionFile("session-B", "goal.json")), foreignGoal);
  assert.equal(await read(sessionFile("session-B", "goal-run.json")), foreignRun);

  for (const recoveryAction of ["create", "reconcile"]) {
    const fixedTaskId = ok(await call("session-A", { action: "create", goal: "task before " + recoveryAction }, "task_state")).handoff.task_id;
    const request = create("recover through " + recoveryAction);
    const originalRename = fs.rename;
    let injected = false;
    fs.rename = async (source, target) => {
      if (!injected && path.resolve(String(target)) === path.resolve(sessionFile("session-A", "goal-run.json"))) {
        injected = true;
        throw Object.assign(new Error("public fixture publication failure"), { code: "EACCES" });
      }
      return originalRename(source, target);
    };
    let failed;
    try { failed = await call("session-A", request); } finally { fs.rename = originalRename; }
    assert.equal(injected, true);
    assert.equal(failed.structuredContent?.ok, false, "publication failure was reported as success");
    const pending = await goals.getGoalCreationStatus(workspace, "session-A");
    assert.equal(pending.pending, true);
    assert.equal(pending.previous_task_id, fixedTaskId);
    const before = await Promise.all(["goal.json", "goal-run.json", "goal-create-transaction.json"].map((file) => read(sessionFile("session-A", file))));
    const status = ok(await call("session-A", { action: "status" }));
    assert.equal(status.creation_transaction.pending, true);
    const badRevision = await call("session-A", { action: "reconcile", expected_revision: 999 });
    assert.equal(badRevision.structuredContent?.ok, false);
    const different = await call("session-A", create("different pending request"));
    assert.equal(different.structuredContent?.ok, false, "different create replaced a pending transaction");
    const independentTask = ok(await call("session-A", { action: "create", goal: "independent task during recovery" }, "task_state"));
    assert.equal(independentTask.handoff.status, "active");
    ok(await call("session-A", { action: "cancel", task_id: independentTask.handoff.task_id }, "task_state"));
    const after = await Promise.all(["goal.json", "goal-run.json", "goal-create-transaction.json"].map((file) => read(sessionFile("session-A", file))));
    assert.deepEqual(after, before, "read/error paths mutated a pending Goal transaction");
    const recovered = ok(await call("session-A", recoveryAction === "create"
      ? request : { action: "reconcile", expected_revision: pending.new_goal_revision }));
    assert.equal(recovered.goal.id, pending.new_goal_id, "recovery replaced the prepared Goal identity");
    assert.equal((await goals.getGoalCreationStatus(workspace, "session-A")).pending, false);
    assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, fixedTaskId))).status, "cancelled");
    assert.equal(await tasks.getActiveTaskId(workspace, "session-A"), null);
    assert.equal((await runs.readGoalRun(workspace, "session-A")).run.runId, pending.new_goal_id);
    assert.equal(await read(sessionFile("session-B", "goal.json")), foreignGoal);
    assert.equal(await read(sessionFile("session-B", "goal-run.json")), foreignRun);
  }
  assert.equal((await goals.getGoal(workspace, "session-B")).id, foreign.id);
  for (const failureAt of ["task-owner", "target-pointer"]) {
    const sourceSession = `bind-source-${failureAt}`;
    const targetSession = `bind-target-${failureAt}`;
    const movingGoal = ok(await call(sourceSession, create(`moving ${failureAt}`))).goal;
    const fixedTaskId = ok(await call(sourceSession, { action: "create", goal: `fixed ${failureAt}` }, "task_state")).handoff.task_id;
    const challenge = await call(targetSession, { action: "bind", expected_revision: movingGoal.revision });
    assert.equal(challenge.structuredContent?.data?.error, "GOAL_BIND_TARGET_REQUIRED", JSON.stringify(challenge));
    assert.equal(challenge.structuredContent?.data?.takeover_candidate?.goal_id, movingGoal.id);
    const fixedTaskFile = path.join(tasks.durableTaskDir(workspace), fixedTaskId + ".json");
    const targetPointer = path.join(tasks.durableTaskDir(workspace), `active-task.${targetSession}.json`);
    const journalFile = path.join(tasks.durableTaskDir(workspace), "goal-bind-transactions",
      crypto.createHash("sha256").update(targetSession).digest("hex"), movingGoal.id + ".json");
    const originalRename = fs.rename;
    let injected = false;
    fs.rename = async (source, target) => {
      const wanted = failureAt === "task-owner" ? fixedTaskFile : targetPointer;
      if (!injected && path.resolve(String(target)) === path.resolve(wanted)) {
        injected = true;
        throw Object.assign(new Error(`bind fixture ${failureAt} failure`), { code: "EACCES" });
      }
      return originalRename(source, target);
    };
    let failed;
    try {
      failed = await call(targetSession, { action: "bind", goal_id: movingGoal.id, expected_revision: movingGoal.revision });
    } finally { fs.rename = originalRename; }
    assert.equal(injected, true, "bind did not reach the injected publication boundary");
    assert.equal(failed.structuredContent?.ok, false, "partially committed bind was reported as success");
    const boundGoal = await goals.getGoal(workspace, targetSession);
    assert.equal(boundGoal.id, movingGoal.id, "fixture must fail after Goal ownership publication");
    assert.equal(boundGoal.owner_session, targetSession);
    const pending = JSON.parse(await read(journalFile));
    assert.equal(pending.phase, "prepared");
    assert.equal(pending.task_id, fixedTaskId);
    assert.equal(pending.goal_id, movingGoal.id);
    const fixedTaskBeforeRetry = JSON.parse(await read(fixedTaskFile));
    assert.equal(fixedTaskBeforeRetry.owner_session, failureAt === "task-owner" ? sourceSession : targetSession);
    assert.equal(await tasks.getActiveTaskId(workspace, targetSession), null, "failed pointer publication leaked through the cache");
    const targetGoalBytes = await read(sessionFile(targetSession, "goal.json"));
    const targetRunBytes = await read(sessionFile(targetSession, "goal-run.json"));

    // Source reuse must not redirect the pending migration to its new task.
    const newSourceGoal = ok(await call(sourceSession, create(`new source ${failureAt}`))).goal;
    const newSourceTaskId = ok(await call(sourceSession, { action: "create", goal: `new source task ${failureAt}` }, "task_state")).handoff.task_id;
    const newSourceTaskFile = path.join(tasks.durableTaskDir(workspace), newSourceTaskId + ".json");
    const sourceBeforeRetry = await Promise.all([sessionFile(sourceSession, "goal.json"), sessionFile(sourceSession, "goal-run.json"), newSourceTaskFile].map(read));
    await fs.writeFile(journalFile, JSON.stringify({ ...pending, task_id: newSourceTaskId }));
    try {
      await assert.rejects(inSession(targetSession, () => tasks.recoverGoalTaskSessionRebind(workspace, movingGoal.id, targetSession)), /GOAL_BIND_TASK_GOAL_CONFLICT/);
      assert.equal(await tasks.getActiveTaskId(workspace, targetSession), null, "a mismatched journal task acquired the destination pointer");
      assert.equal(await read(newSourceTaskFile), sourceBeforeRetry[2], "a mismatched journal moved the new Goal's task");
    } finally { await fs.writeFile(journalFile, JSON.stringify(pending)); }
    const retried = ok(await call(targetSession, { action: "bind", goal_id: movingGoal.id, expected_revision: movingGoal.revision }));
    assert.equal(retried.result, "ALREADY_BOUND");
    assert.equal(retried.durable_task_rebind.migrated, true);
    assert.equal(retried.durable_task_rebind.task_id, fixedTaskId);
    const restoredTask = JSON.parse(await read(fixedTaskFile));
    assert.equal(restoredTask.goal_id, movingGoal.id);
    assert.equal(restoredTask.owner_session, targetSession);
    assert.equal(restoredTask.status, "active");
    assert.equal(await tasks.getActiveTaskId(workspace, targetSession), fixedTaskId);
    assert.equal(await tasks.getActiveTaskId(workspace, sourceSession), newSourceTaskId);
    assert.equal(JSON.parse(await read(newSourceTaskFile)).goal_id, newSourceGoal.id);
    assert.deepEqual(await Promise.all([sessionFile(sourceSession, "goal.json"), sessionFile(sourceSession, "goal-run.json"), newSourceTaskFile].map(read)), sourceBeforeRetry);
    assert.equal(await read(sessionFile(targetSession, "goal.json")), targetGoalBytes);
    assert.equal(await read(sessionFile(targetSession, "goal-run.json")), targetRunBytes);
    assert.equal(JSON.parse(await read(journalFile)).phase, "committed");
    const stableTaskBytes = await read(fixedTaskFile);
    assert.equal(ok(await call(targetSession, { action: "bind" })).durable_task_rebind.migrated, false);
    assert.equal(await read(fixedTaskFile), stableTaskBytes, "completed bind retry rewrote the task");
  }
  console.log("goal-public-session: paused replacement, foreign isolation, ALREADY_BOUND, explicit create recovery and fixed-task bind I/O recovery OK");
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
  await fs.rm(temp, { recursive: true, force: true });
} });
