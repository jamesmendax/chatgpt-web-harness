import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-create-transaction-"));
const saved = { codex: process.env.CODEX_HOME, watchdog: process.env.GOAL_WATCHDOG_ENABLED };
process.env.CODEX_HOME = path.join(temp, "state");
process.env.GOAL_WATCHDOG_ENABLED = "false";
const goals = await import("../dist/lib/goals.js");
const runs = await import("../dist/lib/goal-run-store.js");
const tasks = await import("../dist/lib/durable-tasks.js");
const web = await import("../dist/lib/goal-run-web.js");
const { advanceGoalRun } = await import("../dist/lib/goal-run-state.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace);
const inSession = (sessionId, fn) => runWithRuntimeScope(createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId }), fn);
const input = (objective) => ({ objective, success_criteria: [{ name: objective + " accepted", passed: false }] });
const stateRoot = path.join(process.env.CODEX_HOME, "projects", crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12));
const sessionFile = (session, file) => path.join(stateRoot, "sessions", session, file);
const bytes = (file) => fs.readFile(file, "utf8");

try {
  const old = await inSession("session-A", () => goals.createGoal(workspace, input("old objective")));
  await inSession("session-A", () => web.ensureGoalRunAuthority(workspace, old));
  const oldTask = await inSession("session-A", async () => {
    const task = await tasks.createDurableTask(workspace, { goal: "old objective" });
    return tasks.checkpointDurableTask(workspace, task.id, { next_actions: ["OLD_NEXT_ACTION_MUST_NOT_LEAK"] });
  });
  await inSession("session-A", async () => {
    const envelope = await runs.readGoalRun(workspace);
    const next = advanceGoalRun(envelope.run, {
      type: "record_evidence",
      evidence: { id: "retained-evidence", kind: "deterministic", summary: "fixture proof retained across replacement", source: "transaction-test", metadata: { verifiesCriterion: true } },
    }, { expectedRevision: envelope.run.revision, now: new Date(Date.parse(envelope.run.timestamps.updatedAt) + 10).toISOString() });
    await runs.replaceGoalRun(workspace, { ...envelope, run: next.run }, { expectedRevision: envelope.run.revision });
  });
  const beforeRun = await bytes(sessionFile("session-A", "goal-run.json"));
  const beforeGoal = await bytes(sessionFile("session-A", "goal.json"));
  await assert.rejects(() => inSession("session-A", () => goals.createGoal(workspace, input("   "))), /objective/i);
  assert.equal(await bytes(sessionFile("session-A", "goal.json")), beforeGoal, "invalid input cancelled the old Goal");
  assert.equal(await bytes(sessionFile("session-A", "goal-run.json")), beforeRun, "invalid input modified old evidence");

  const foreign = await inSession("session-B", () => goals.createGoal(workspace, input("foreign objective")));
  await inSession("session-B", () => web.ensureGoalRunAuthority(workspace, foreign));
  const foreignTask = await inSession("session-B", () => tasks.createDurableTask(workspace, { goal: "foreign objective" }));
  const foreignGoalBytes = await bytes(sessionFile("session-B", "goal.json"));
  const foreignRunBytes = await bytes(sessionFile("session-B", "goal-run.json"));
  const next = await inSession("session-A", () => goals.createGoal(workspace, input("new objective")));
  assert.notEqual(next.id, old.id);
  assert.deepEqual(next.success_criteria.map((x) => x.name), ["new objective accepted"]);
  assert.equal(await bytes(sessionFile("session-B", "goal.json")), foreignGoalBytes);
  assert.equal(await bytes(sessionFile("session-B", "goal-run.json")), foreignRunBytes);
  assert.equal((await inSession("session-B", () => tasks.getDurableTask(workspace, foreignTask.id))).status, "active");
  assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, oldTask.id))).status, "cancelled");
  assert.equal(await tasks.getActiveTaskId(workspace, "session-A"), null);
  const archived = await runs.readArchivedGoalRun(workspace, old.id, "session-A");
  assert.deepEqual(archived, JSON.parse(beforeRun), "old GoalRun/evidence archive changed or is incomplete");
  assert.equal((await runs.readGoalRun(workspace, "session-A")).run.typedEvidence.length, 0, "old evidence leaked into new Goal");

  const stableGoal = await bytes(sessionFile("session-A", "goal.json"));
  const stableRun = await bytes(sessionFile("session-A", "goal-run.json"));
  const same = await inSession("session-A", () => goals.bindGoalToSession(workspace, { expectedRevision: next.revision }));
  assert.equal(same.id, next.id);
  assert.equal(await bytes(sessionFile("session-A", "goal.json")), stableGoal, "idempotent bind rewrote Goal");
  assert.equal(await bytes(sessionFile("session-A", "goal-run.json")), stableRun, "idempotent bind rewrote GoalRun");

  // Fail an actual publication, then recover the durable transaction. The
  // public read path reports pending and must not silently perform the write.
  const interruptedTask = await inSession("session-A", () => tasks.createDurableTask(workspace, { goal: "new objective" }));
  const originalRename = fs.rename;
  let failed = false;
  fs.rename = async (source, target) => {
    if (!failed && path.resolve(String(target)) === path.resolve(sessionFile("session-A", "goal-run.json"))) {
      failed = true;
      throw Object.assign(new Error("fixture publication failure"), { code: "EACCES" });
    }
    return originalRename(source, target);
  };
  try {
    await assert.rejects(() => inSession("session-A", () => goals.createGoal(workspace, input("recovered objective"))), /fixture publication failure|IO_ERROR/);
  } finally { fs.rename = originalRename; }
  const pending = await inSession("session-A", () => goals.getGoalCreationStatus(workspace));
  assert.equal(pending.pending, true);
  const journalBefore = await bytes(goals.goalCreationJournalPath(workspace, "session-A"));
  await assert.rejects(() => goals.getGoal(workspace, "session-A"), /GOAL_CREATION_PENDING/);
  assert.equal(await bytes(goals.goalCreationJournalPath(workspace, "session-A")), journalBefore, "status/read mutated pending creation");
  const repaired = await inSession("session-A", () => goals.recoverGoalCreation(workspace));
  assert.equal(repaired.id, pending.new_goal_id, "recovery minted a second Goal identity");
  assert.equal((await inSession("session-A", () => goals.getGoalCreationStatus(workspace))).pending, false);
  assert.equal((await inSession("session-A", () => tasks.getDurableTask(workspace, interruptedTask.id))).status, "cancelled");
  assert.equal((await runs.readGoalRun(workspace, "session-A")).run.runId, repaired.id);
  assert.equal((await goals.getGoal(workspace, "session-A")).id, repaired.id);
  assert.equal(await bytes(sessionFile("session-B", "goal.json")), foreignGoalBytes, "recovery touched another session");

  // A terminal destination may be replaced during adoption, but active
  // destinations and mismatched same-revision run contents remain protected.
  await inSession("session-C", async () => {
    const g = await goals.createGoal(workspace, input("terminal destination"));
    await web.ensureGoalRunAuthority(workspace, g);
    await web.transitionGoalRunLifecycle(workspace, "cancel");
  });
  await inSession("session-B", () => web.updateGoalRunDefinition(workspace, { current_phase: "publish B for explicit bind" }));
  const bCurrent = await goals.getGoal(workspace, "session-B");
  const adopted = await inSession("session-C", () => goals.bindGoalToSession(workspace, { expectedRevision: bCurrent.revision }));
  assert.equal(adopted.id, bCurrent.id);
  assert.equal(adopted.owner_session, "session-C");
  await assert.rejects(() => inSession("session-A", () => goals.bindGoalToSession(workspace, { expectedGoalId: adopted.id, expectedRevision: adopted.revision })), /already owns|CONFLICT/);
  assert.equal((await goals.getGoal(workspace, "session-A")).id, repaired.id);
  // A validated handoff source is explicit. An unrelated later create may
  // update the compatibility projection without redirecting this bind.
  const exactSource = await inSession("session-D", () => goals.createGoal(workspace, input("exact source")));
  await inSession("session-D", () => web.ensureGoalRunAuthority(workspace, exactSource));
  const independent = await inSession("session-E", () => goals.createGoal(workspace, input("independent projection")));
  const independentBytes = await bytes(sessionFile("session-E", "goal.json"));
  const sourceRemove = fs.rm;
  fs.rm = async (target, options) => {
    if (path.resolve(String(target)) === path.resolve(sessionFile("session-D", "goal.json"))) {
      throw Object.assign(new Error("fixture source deletion failure"), { code: "EACCES" });
    }
    return sourceRemove(target, options);
  };
  let exactBound;
  try {
    exactBound = await inSession("session-F", () => goals.bindGoalToSession(workspace, {
      sourceSessionId: "session-D", expectedGoalId: exactSource.id, expectedRevision: exactSource.revision,
    }));
  } finally { fs.rm = sourceRemove; }
  assert.equal(exactBound.id, exactSource.id, "binding followed the unrelated global projection");
  assert.equal(await goals.getGoal(workspace, "session-D"), null, "failed cleanup restored the old owner's authority");
  assert.equal((await goals.getGoal(workspace, "session-E")).id, independent.id);
  assert.equal(await bytes(sessionFile("session-E", "goal.json")), independentBytes);
  await assert.rejects(() => inSession("session-D", () => goals.updateGoal(workspace, { objective: "old owner mutation" })), /No goal/);
  console.log("goal-create-transaction: input validation, automatic session replacement, evidence archive, task isolation, interrupted recovery and bind safeguards OK");
} finally {
  if (saved.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.codex;
  if (saved.watchdog === undefined) delete process.env.GOAL_WATCHDOG_ENABLED; else process.env.GOAL_WATCHDOG_ENABLED = saved.watchdog;
  await fs.rm(temp, { recursive: true, force: true });
}
