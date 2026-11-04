import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "goal-store-boundary-"));
const saved = Object.fromEntries(["CODEX_HOME", "HARNESS_RELAY_ENABLED", "GOAL_WATCHDOG_ENABLED"].map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(temp, "state");
process.env.HARNESS_RELAY_ENABLED = "false";
process.env.GOAL_WATCHDOG_ENABLED = "false";
const goals = await import("../dist/lib/goals.js");
const runs = await import("../dist/lib/goal-run-store.js");
const web = await import("../dist/lib/goal-run-web.js");
const driver = await import("../dist/lib/driver-lease.js");
const { EffectiveToolRegistry } = await import("../dist/lib/effective-tool-registry.js");
const { InvocationGateway } = await import("../dist/lib/invocation-gateway.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace);
const inSession = (sessionId, fn) => runWithRuntimeScope(createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId }), fn);
const input = (objective) => ({ objective, success_criteria: [{ name: objective + " verified", passed: false }] });
const read = (file) => fs.readFile(file, "utf8");
const result = { content: [{ type: "text", text: "fixture read finished" }], structuredContent: { ok: true, tool: "read_text_file", summary: "fixture read finished", data: { path: "fixture.txt" } } };

try {
  const old = await inSession("A", () => goals.createGoal(workspace, input("old")));
  await inSession("A", () => web.ensureGoalRunAuthority(workspace, old));
  const captured = { ...createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId: "A" }), goalId: old.id, goalOwnerSessionId: "A", invocationId: "before-create" };
  const context = { definition: { name: "read_text_file", source: "native" }, scope: captured, rawArgs: {}, callbackArgs: [] };
  const foreign = await inSession("B", () => goals.createGoal(workspace, input("foreign")));
  const foreignLease = await driver.ensureDriverLease(workspace, { goalId: foreign.id, ownerSessionId: "B", executionContractHash: "b".repeat(64), intentRevision: 1 });
  const foreignLeaseBytes = await read(driver.driverLeasePath(workspace, foreign.id));
  const originalRename = fs.rename;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let blocked = false;
  fs.rename = async (source, target) => {
    if (!blocked && path.resolve(String(target)) === path.resolve(runs.goalRunPath(workspace, "A"))) {
      const candidate = JSON.parse(await read(source));
      if (candidate.run.typedEvidence.some((item) => item.id === "tool-before-create")) {
        blocked = true;
        entered();
        await gate;
      }
    }
    return originalRename(source, target);
  };
  let timer, replacement, evidence;
  try {
    evidence = web.appendGoalRunEvidenceToResult(workspace, context, result);
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("evidence commit barrier was not reached")), 5_000); })]);
    clearTimeout(timer);
    let settled = false;
    replacement = inSession("A", () => goals.createGoal(workspace, input("after evidence"))).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "create crossed an evidence commit holding the GoalRun store lock");
  } finally {
    clearTimeout(timer);
    release();
    fs.rename = originalRename;
  }
  const [, next] = await Promise.all([evidence, replacement]);
  const archive = await runs.readArchivedGoalRun(workspace, old.id, "A");
  assert.ok(archive.run.typedEvidence.some((item) => item.id === "tool-before-create"), "create archived an earlier revision and lost the committing proof");
  assert.equal((await runs.readGoalRun(workspace, "A")).run.typedEvidence.length, 0);
  const newRunBytes = await read(runs.goalRunPath(workspace, "A"));
  await web.appendGoalRunEvidenceToResult(workspace, { ...context, scope: { ...captured, invocationId: "old-late-direct-hook" } }, result);
  assert.equal(await read(runs.goalRunPath(workspace, "A")), newRunBytes, "direct evidence hook wrote a prior Goal's result into its successor");

  let releaseEffect, effectStarted;
  const effectGate = new Promise(resolve => { releaseEffect = resolve; });
  const enteredEffect = new Promise(resolve => { effectStarted = resolve; });
  const registry = new EffectiveToolRegistry("full");
  registry.register(registry.prepare("write_file", { inputSchema: {}, annotations: { readOnlyHint: false } }, async () => {
    effectStarted();
    await effectGate;
    return result;
  }));
  const gateway = new InvocationGateway(registry, { workspaceRoot: workspace, projectRoots: [workspace] }, {
    onSuccess: (context, raw) => web.appendGoalRunEvidenceToResult(workspace, context, raw).then(() => raw),
  });
  const intent = JSON.stringify({ intent_revision: 1, objective: "Run isolated Goal effect fixture",
    scope: ["fixture"], out_of_scope: [], deliverables: ["fixture result"], success_criteria: ["complete"],
    constraints: [], protected_resources: [], known_facts: ["isolated"], assumptions: [], delegated_decisions: [],
    remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [], clarification_round: 0,
    questions_in_round: 0, resolution_mode: "none" });
  const running = gateway.invoke("write_file", [{ path: "fixture", _intent: intent },
    { sessionId: "A", requestId: 123, signal: new AbortController().signal }]);
  let effectTimer;
  await Promise.race([enteredEffect, running.then(() => { throw new Error("fixture handler was not entered"); }),
    new Promise((_, reject) => { effectTimer = setTimeout(() => reject(new Error("effect barrier timeout")), 5000); })]);
  clearTimeout(effectTimer);
  const journalBytes = await read(goals.goalCreationJournalPath(workspace, "A"));
  try {
    await assert.rejects(() => inSession("A", () => goals.createGoal(workspace, input("must wait for effect"))), /GOAL_CREATION_EFFECT_BUSY/);
    assert.equal(await read(goals.goalCreationJournalPath(workspace, "A")), journalBytes, "busy effect rejection published a creation transaction");
    assert.equal((await goals.getGoal(workspace, "A")).id, next.id);
    const independent = await inSession("C", () => goals.createGoal(workspace, input("independent owner")));
    const independentNext = await inSession("C", () => goals.createGoal(workspace, input("independent successor")));
    assert.notEqual(independent.id, independentNext.id, "another owner's replacement must not share this effect fence");
  } finally { releaseEffect(); }
  await running;
  const final = await inSession("A", () => goals.createGoal(workspace, input("after effect settled")));
  assert.notEqual(final.id, next.id);
  assert.ok((await runs.readArchivedGoalRun(workspace, next.id, "A")).run.typedEvidence.length > 0,
    "completed effect evidence must remain with the old Goal");
  assert.equal((await runs.readGoalRun(workspace, "A")).run.typedEvidence.length, 0,
    "old effect evidence must not enter the new Goal");
  assert.equal(await read(driver.driverLeasePath(workspace, foreign.id)), foreignLeaseBytes, "superseding A changed B's Driver lease");
  assert.equal((await driver.readDriverLease(workspace, foreign.id)).lease_id, foreignLease.lease_id);
  const readRegistry = new EffectiveToolRegistry("full");
  let releaseRead, readStarted;
  const readGate = new Promise(resolve => { releaseRead = resolve; });
  const enteredRead = new Promise(resolve => { readStarted = resolve; });
  readRegistry.register(readRegistry.prepare("read_text_file", { inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
    readStarted(); await readGate; return result;
  }));
  const readGateway = new InvocationGateway(readRegistry, { workspaceRoot: workspace, projectRoots: [workspace] }, {
    onSuccess: (context, raw) => web.appendGoalRunEvidenceToResult(workspace, context, raw).then(() => raw),
  });
  const readRunning = readGateway.invoke("read_text_file", [{ path: "fixture" },
    { sessionId: "A", requestId: 124, signal: new AbortController().signal }]);
  await enteredRead;
  let afterRead;
  try { afterRead = await inSession("A", () => goals.createGoal(workspace, input("read does not block replacement"))); }
  finally { releaseRead(); }
  await readRunning;
  assert.notEqual(afterRead.id, final.id);
  assert.equal((await runs.readGoalRun(workspace, "A")).run.typedEvidence.length, 0,
    "late read evidence must not enter the new Goal");
  const failingRegistry = new EffectiveToolRegistry("full");
  failingRegistry.register(failingRegistry.prepare("write_file", { inputSchema: {}, annotations: { readOnlyHint: false } }, async () => {
    throw new Error("fixture effect failure");
  }));
  const failingGateway = new InvocationGateway(failingRegistry, { workspaceRoot: workspace, projectRoots: [workspace] });
  await assert.rejects(failingGateway.invoke("write_file", [{ path: "fixture", _intent: intent },
    { sessionId: "A", requestId: 125, signal: new AbortController().signal }]), /fixture effect failure/);
  await assert.rejects(() => inSession("A", () => goals.createGoal(workspace, input("failed effect remains uncertain"))), /GOAL_CREATION_EFFECT_BUSY/);
  console.log("goal-store-boundary: evidence retained, late hook fenced, live non-Relay effect blocks replacement, foreign Driver untouched OK");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
