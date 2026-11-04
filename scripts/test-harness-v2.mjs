import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "harness-v2");
const workspace = path.join(tmpRoot, "workspace");
const projectA = path.join(tmpRoot, "project-a");
const projectB = path.join(tmpRoot, "project-b");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.GOAL_STALL_GAP_MS = "25";

await fs.rm(tmpRoot, { recursive: true, force: true });
for (const dir of [workspace, projectA, projectB]) await fs.mkdir(dir, { recursive: true });
await fs.writeFile(path.join(projectA, "package.json"), '{"name":"project-a"}\n', "utf-8");
await fs.writeFile(path.join(projectB, "package.json"), '{"name":"project-b"}\n', "utf-8");

const { extractAbsolutePathsFromText, isPathWithinRoot } = await import("../dist/lib/project-scope.js");
const { createGoal, updateGoal, completeGoal } = await import("../dist/lib/goals.js");
const { createDurableTask, getDurableTask, checkpointDurableTask, recordToolObservation, recordGoalStallTelemetry } = await import("../dist/lib/durable-tasks.js");
const {
  readHarnessEvents,
  appendHarnessEvent,
  appendHarnessEventSafe,
  getHarnessEventLogHealth,
  harnessEventLogPath,
  HarnessLogFormatError,
  HARNESS_LOG_VERSION,
} = await import("../dist/lib/harness-events.js");
const { buildHarnessRuntimeContext, appendHarnessRuntimeContextToResult, resetHarnessSnapshotRetention, formatHarnessRuntimeContext } = await import("../dist/lib/context-broker.js");
const { ensureGoalRunAuthority } = await import("../dist/lib/goal-run-web.js");

try {
  const parsed = extractAbsolutePathsFromText(`修改 ${projectA} 然后继续说明，不要把后面的文字吞进路径`);
  assert.ok(parsed.some((candidate) => path.resolve(candidate) === path.resolve(projectA)), "project path extraction lost the real root");
  assert.ok(!parsed.some((candidate) => candidate.includes("然后继续说明")), "project path extraction swallowed trailing prose");

  // Regression (audit P1-4): Windows path.relative is case-sensitive, so tool
  // arguments with different casing than the project root used to escape the
  // cross-project pollution filter.
  if (process.platform === "win32") {
    const rootMixedCase = projectA[0].toUpperCase() + projectA.slice(1).replace(/[a-z]/g, (ch, i) => (i % 2 === 0 ? ch.toUpperCase() : ch));
    assert.notEqual(rootMixedCase, projectA, "fixture must actually differ in case");
    assert.ok(
      isPathWithinRoot(path.join(rootMixedCase, "src", "app.ts"), projectA),
      "isPathWithinRoot must be case-insensitive on Windows"
    );
  }

  const goal = await createGoal(workspace, {
    objective: `Improve the local project at ${projectA}`,
    success_criteria: [{ name: "fixture passes", passed: false }],
    current_phase: "Inspect project scope",
  });
  await ensureGoalRunAuthority(workspace, goal);
  const task = await createDurableTask(workspace, {
    goal: `Work only inside ${projectA}`,
    current_step: "Run focused checks",
    blocking_checks: [{ name: "fixture", passed: false }],
  });
  assert.equal(task.project_scope_locked, true, "explicit project path did not lock task scope");
  assert.deepEqual(task.project_roots.map((root) => path.resolve(root)), [path.resolve(projectA)]);

  const inScopeFile = path.join(projectA, "src", "app.ts");
  const outOfScopeFile = path.join(projectB, "icon.png");
  await recordToolObservation(
    workspace,
    "apply_patch",
    { path: inScopeFile },
    { structuredContent: { ok: true, tool: "apply_patch", summary: "patched project A", data: { path: inScopeFile } } }
  );
  await recordToolObservation(
    workspace,
    "write_file",
    { path: outOfScopeFile },
    { structuredContent: { ok: true, tool: "write_file", summary: "wrote project B", data: { path: outOfScopeFile } } }
  );
  await recordToolObservation(
    workspace,
    "run_command",
    { command: "npm test", working_directory: projectA },
    { structuredContent: { ok: true, tool: "run_command", summary: "tests passed", data: { command: "npm test", exit_code: 0 } } }
  );

  const observed = await getDurableTask(workspace, task.id);
  assert.ok(observed.changed_files.includes(inScopeFile), "in-scope mutation was not recorded");
  assert.ok(!observed.changed_files.includes(outOfScopeFile), "cross-project mutation polluted active task");

  const events = await readHarnessEvents(workspace, { limit: 100 });
  assert.ok(events.some((event) => event.type === "goal/change" && event.goal_id === goal.id), "goal change was not mirrored to event log");
  assert.ok(events.some((event) => event.type === "task/change" && event.task_id === task.id), "task change was not mirrored to event log");
  assert.ok(events.some((event) => event.type === "tool/observation" && event.task_id === task.id), "tool observation missing from event log");
  assert.ok(events.some((event) => event.type === "evidence/recorded" && event.evidence_kind === "runtime"), "runtime evidence typing missing");
  for (let index = 1; index < events.length; index++) {
    assert.equal(events[index].seq, events[index - 1].seq + 1, "event sequence is not contiguous");
  }

  const contextA = await buildHarnessRuntimeContext(workspace, projectA);
  assert.equal(contextA.task?.task_id, task.id, "Context Broker omitted matching active task");
  assert.equal(contextA.goal?.goal_id, goal.id, "Context Broker omitted matching goal");
  assert.ok(contextA.recent_evidence.some((item) => item.kind === "runtime"), "Context Broker omitted recent runtime evidence");

  const contextB = await buildHarnessRuntimeContext(workspace, projectB);
  assert.equal(contextB.task, undefined, "Context Broker leaked task into another project");
  assert.equal(contextB.goal, undefined, "Context Broker leaked goal into another project");

  const augmented = await appendHarnessRuntimeContextToResult(workspace, {
    content: [{ type: "text", text: "base" }],
    structuredContent: { ok: true, tool: "fixture", summary: "fixture", data: { value: 1 } },
  }, { toolName: "fixture" });
  assert.equal(augmented.structuredContent?.data?.harness_context?.task?.task_id, task.id, "structured harness context missing");
  assert.ok(JSON.stringify(augmented.content).includes("HARNESS CONTEXT"), "text harness context missing");
  assert.ok(
    augmented.content.at(-1)?.text?.includes("MUST_CONTINUE_TO_TOOL"),
    "initial full snapshot injection must end with the imperative continuation tail"
  );

  // --- Context Broker V2: snapshot dedup, change reinjection, cleared state ---
  const baseFixture = () => ({
    content: [{ type: "text", text: "base" }],
    structuredContent: { ok: true, tool: "fixture", summary: "fixture", data: { value: 1 } },
  });
  const second = await appendHarnessRuntimeContextToResult(workspace, baseFixture(), { toolName: "fixture" });
  assert.ok(!JSON.stringify(second.content).includes("HARNESS CONTEXT"), "unchanged state must not re-inject full text");
  assert.equal(second.structuredContent?.data?.harness_context, undefined, "unchanged state must not re-inject structured context");
  assert.ok(
    JSON.stringify(second.content).includes("Your next action must be a tool call"),
    "deduped results must still carry the imperative continuation tail while criteria are unmet"
  );
  assert.ok(JSON.stringify(second.content).includes("Expect no user reply"), "tail must carry the reply-suppression lock");
  assert.ok(JSON.stringify(second.content).includes("MUST_CONTINUE_TO_TOOL"), "tail must carry the continue lock");
  assert.ok(JSON.stringify(second.content).includes("supersedes any"), "tail must state it supersedes generic progress rules");
  assert.ok(JSON.stringify(second.content).includes("shall I continue?"), "tail must enumerate forbidden turn endings");

  // Stall telemetry: goal active + unmet criteria + activity gap > threshold.
  // Low-value calls do not bump task.updated_at, so the gap stays measurable.
  await new Promise((resolve) => setTimeout(resolve, 60));
  await recordGoalStallTelemetry(workspace);
  const stallEvents = await readHarnessEvents(workspace, { type: "goal/stall", limit: 10 });
  assert.ok(stallEvents.length >= 1, "goal/stall event must be recorded after an activity gap");

  // Goal-only workflows (no durable task) must also record stalls.
  const wsGoalOnly = path.join(tmpRoot, "ws-goal-only");
  await fs.mkdir(wsGoalOnly, { recursive: true });
  await createGoal(wsGoalOnly, { objective: "goal-only stall probe", success_criteria: [{ name: "solo", passed: false }] });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await recordGoalStallTelemetry(wsGoalOnly);
  const goalOnlyStalls = await readHarnessEvents(wsGoalOnly, { type: "goal/stall", limit: 5 });
  assert.ok(goalOnlyStalls.length >= 1 && goalOnlyStalls[0].data?.scope === "goal_only", "goal-only stall must be recorded");

  // Goal completion crystallizes the outcome into cross-session MEMORY.md.
  const wsCrystal = path.join(tmpRoot, "ws-crystal");
  await fs.mkdir(wsCrystal, { recursive: true });
  await createGoal(wsCrystal, { objective: "crystallization probe", success_criteria: [{ name: "done", passed: false }] });
  await updateGoal(wsCrystal, { success_criteria: [{ name: "done", passed: true }] });
  await completeGoal(wsCrystal);
  const memoryPath = path.join(
    process.env.CODEX_HOME,
    "projects",
    createHash("sha256").update(path.resolve(wsCrystal)).digest("hex").slice(0, 12),
    "MEMORY.md"
  );
  const memory = await fs.readFile(memoryPath, "utf-8");
  assert.ok(memory.includes("Goal completed") && memory.includes("crystallization probe"), "goal outcome must crystallize into MEMORY.md");

  // Skip tools (remember/agent_status/…) skip the snapshot but must still carry
  // the continuation tail — turn-start preflight and turn-ending calls on them
  // previously had no signal at all.
  const skipToolResult = await appendHarnessRuntimeContextToResult(workspace, {
    content: [{ type: "text", text: "saved" }],
    structuredContent: { ok: true, tool: "remember", summary: "saved to auto memory", data: { saved_to: "MEMORY.md", note: "x" } },
  }, { toolName: "remember" });
  assert.ok(
    JSON.stringify(skipToolResult.content).includes("Your next action must be a tool call"),
    "skip tools must still carry the continuation tail"
  );

  // Real Web regression: goal(create) previously self-signaled only in-band,
  // but ChatGPT still ended the turn immediately after Goal activation. State
  // tools must therefore also END with the imperative continuation tail.
  const goalToolResult = await appendHarnessRuntimeContextToResult(workspace, {
    content: [{ type: "text", text: "goal status" }],
    structuredContent: { ok: true, tool: "goal", summary: "status", data: { goal: { id: "g" } } },
  }, { toolName: "goal" });
  assert.ok(
    goalToolResult.content.at(-1)?.text?.includes("MUST_CONTINUE_TO_TOOL") &&
      goalToolResult.content.at(-1)?.text?.includes("Your next action must be a tool call"),
    "goal results must end with the imperative continuation tail while the Goal is active"
  );

  const taskStateToolResult = await appendHarnessRuntimeContextToResult(workspace, {
    content: [{ type: "text", text: "checkpoint" }],
    structuredContent: { ok: true, tool: "task_state", summary: "checkpoint", data: { task: { id: task.id } } },
  }, { toolName: "task_state" });
  assert.ok(
    taskStateToolResult.content.at(-1)?.text?.includes("MUST_CONTINUE_TO_TOOL") &&
      taskStateToolResult.content.at(-1)?.text?.includes("Your next action must be a tool call"),
    "task_state results must end with the imperative continuation tail while the Goal is active"
  );

  await checkpointDurableTask(workspace, task.id, { current_step: "broker dedup probe" });
  const third = await appendHarnessRuntimeContextToResult(workspace, baseFixture(), { toolName: "fixture" });
  assert.ok(JSON.stringify(third.content).includes("HARNESS CONTEXT"), "state change must re-inject the snapshot");
  assert.ok(JSON.stringify(third.content).includes("supersedes"), "snapshot must carry the supersede header");
  assert.ok(
    third.content.at(-1)?.text?.includes("MUST_CONTINUE_TO_TOOL") && third.content.at(-1)?.text?.includes("Your next action must be a tool call"),
    "changed-state snapshot reinjection must still END with the imperative continuation tail"
  );

  // A new MCP session (new ChatGPT conversation) must get a fresh injection
  // even when process-level state is unchanged.
  const fourth = await appendHarnessRuntimeContextToResult(workspace, baseFixture(), { toolName: "fixture" });
  assert.ok(!JSON.stringify(fourth.content).includes("HARNESS CONTEXT"), "unchanged state stays deduped");
  resetHarnessSnapshotRetention(workspace);
  const fifth = await appendHarnessRuntimeContextToResult(workspace, baseFixture(), { toolName: "fixture" });
  assert.ok(JSON.stringify(fifth.content).includes("HARNESS CONTEXT"), "session reset must re-inject the snapshot");

  // project_context's own project-scoped harness_context must not be overwritten
  // by the workspace-wide broker view.
  const scopedContext = { project_root: projectA, recent_evidence: [] };
  const withOwn = await appendHarnessRuntimeContextToResult(workspace, {
    content: [{ type: "text", text: "base" }],
    structuredContent: { ok: true, tool: "project_context", summary: "bundle", data: { harness_context: scopedContext } },
  }, { toolName: "project_context" });
  assert.equal(withOwn.structuredContent?.data?.harness_context, scopedContext, "existing scoped harness_context must be preserved");

  const wsClear = path.join(tmpRoot, "ws-cleared");
  await fs.mkdir(wsClear, { recursive: true });
  const clearedFirst = await appendHarnessRuntimeContextToResult(wsClear, baseFixture(), { toolName: "fixture" });
  assert.ok(!JSON.stringify(clearedFirst.content).includes("No active goal"), "cleared state must not inject on a fresh process");
  await createGoal(wsClear, { objective: `Clear-state probe ${wsClear}`, success_criteria: [{ name: "probe", passed: false }] });
  const clearedSecond = await appendHarnessRuntimeContextToResult(wsClear, baseFixture(), { toolName: "fixture" });
  assert.ok(JSON.stringify(clearedSecond.content).includes("ACTIVE GOAL"), "goal appearance must inject the snapshot");

  const wsLong = path.join(tmpRoot, "ws-long");
  await fs.mkdir(wsLong, { recursive: true });
  await createGoal(wsLong, { objective: "Long objective: " + "细节".repeat(1500), success_criteria: [{ name: "probe", passed: false }] });
  const longResult = await appendHarnessRuntimeContextToResult(wsLong, baseFixture(), { toolName: "fixture" });
  const longText = JSON.stringify(longResult.content);
  assert.ok(longText.includes("Long objective:"), "long objective must still render (capped)");
  assert.ok(!longText.includes("chars omitted"), "capped objective must keep the snapshot within budget");
  assert.ok(longText.includes("Success criteria:"), "status lines must survive a long objective");
  assert.ok(longText.includes("GOAL CONTINUATION CONTRACT"), "continuation contract must survive a long objective");
  assert.ok(!longText.includes("Remaining: none"), "unmet criteria must never render as 'Remaining: none'");

  // --- Stage 4: structured blocked reason ---
  await checkpointDurableTask(workspace, task.id, {
    current_step: "blocked probe",
    blockers: ["waiting on user"],
    blocked_reason: { code: "user-input-needed", message: "need API key from user" },
  });
  const blockedTask = await getDurableTask(workspace, task.id);
  assert.equal(blockedTask.blocked?.code, "user-input-needed", "blocked_reason must persist");
  const blockedContext = await buildHarnessRuntimeContext(workspace, projectA);
  assert.equal(blockedContext.task?.blocked?.code, "user-input-needed", "harness context must surface the blocked reason");

  let badCodeRejected = false;
  try {
    await checkpointDurableTask(workspace, task.id, { current_step: "bad code", blocked_reason: { code: "Bad Code", message: "x" } });
  } catch (error) {
    badCodeRejected = String(error).includes("lower-kebab");
  }
  assert.ok(badCodeRejected, "invalid blocker code must be rejected");

  await checkpointDurableTask(workspace, task.id, { current_step: "unblocked probe", resolved_blockers: ["waiting on user"] });
  const unblockedTask = await getDurableTask(workspace, task.id);
  assert.equal(unblockedTask.blocked, undefined, "resolved blockers must clear the blocked reason");

  // Heavy schema-legal task text must never push the contract or goal state out
  // of the snapshot (goal block renders first; variable lines are capped).
  await checkpointDurableTask(workspace, task.id, {
    current_step: "heavy probe",
    blockers: ["b".repeat(1000), "c".repeat(1000), "d".repeat(1000)],
    next_actions: ["n".repeat(1000)],
  });
  const heavyText = formatHarnessRuntimeContext(await buildHarnessRuntimeContext(workspace, projectA));
  assert.ok(heavyText.includes("GOAL CONTINUATION CONTRACT"), "contract must survive heavy task text");
  assert.ok(heavyText.includes("ACTIVE GOAL:"), "goal state must survive heavy task text");
  assert.ok(heavyText.includes("Success criteria:"), "criteria line must survive heavy task text");
  await checkpointDurableTask(workspace, task.id, {
    current_step: "heavy probe cleared",
    resolved_blockers: ["b".repeat(1000), "c".repeat(1000), "d".repeat(1000)],
  });

  // --- harness-events v2: header, slimming, contiguity, torn tail, refusals ---
  const logPath = harnessEventLogPath(workspace);
  const header = JSON.parse((await fs.readFile(logPath, "utf-8")).split(/\r?\n/)[0]);
  assert.equal(header.kind, "harness-log", "log must start with a header line");
  assert.equal(header.version, HARNESS_LOG_VERSION, "header version mismatch");
  assert.equal(path.resolve(header.workspace_root), path.resolve(workspace), "header workspace mismatch");

  const longSummary = "x".repeat(600);
  const longCommand = `echo ${"y".repeat(400)}`;
  const manyPaths = Array.from({ length: 15 }, (_, index) => path.join(projectA, `f${index}.ts`));
  await recordToolObservation(
    workspace,
    "run_command",
    { command: longCommand, working_directory: projectA },
    { structuredContent: { ok: true, tool: "run_command", summary: longSummary, data: { command: longCommand, exit_code: 0, paths: manyPaths } } }
  );
  const observations = await readHarnessEvents(workspace, { type: "tool/observation", limit: 1000 });
  const slimBytes = Buffer.byteLength(JSON.stringify(observations.at(-1)), "utf-8");
  assert.ok(slimBytes <= 1250, `slim observation event must stay under 1.2KB, got ${slimBytes} bytes`);
  const taskChanges = await readHarnessEvents(workspace, { type: "task/change", limit: 1000 });
  assert.ok(taskChanges.every((event) => event.data?.operation !== "tool-observation"), "per-observation whole task/change events must be gone");

  const artifactFile = path.join(tmpRoot, "artifact-sample.txt");
  await fs.writeFile(artifactFile, "artifact-content", "utf-8");
  await recordToolObservation(
    workspace,
    "run_command",
    { command: "render fixture", working_directory: projectA },
    { structuredContent: { ok: true, tool: "run_command", summary: "made artifact", data: { command: "render fixture", exit_code: 0, output_path: artifactFile } } }
  );
  const artifactEvents = await readHarnessEvents(workspace, { type: "tool/observation", limit: 1000 });
  const artifactEvent = artifactEvents.find((event) => Array.isArray(event.data?.artifacts) && event.data.artifacts.length);
  assert.ok(artifactEvent, "artifact-bearing observation missing");
  assert.equal(
    artifactEvent.data.artifacts[0].sha256,
    createHash("sha256").update("artifact-content").digest("hex"),
    "artifact sha256 reference mismatch"
  );

  const all = await readHarnessEvents(workspace, { limit: 1000 });
  assert.ok(all.length >= 5, "expected a populated log");
  for (let index = 1; index < all.length; index++) {
    assert.equal(all[index].seq, all[index - 1].seq + 1, "event sequence is not contiguous");
  }
  const health = await getHarnessEventLogHealth(workspace);
  assert.equal(health.format, "v2", "log format must be v2");
  assert.equal(health.last_seq, all.at(-1).seq, "health last_seq mismatch");
  assert.equal(health.events, all.length, "health event count mismatch");
  assert.equal(health.torn_tail, false, "healthy log must not report a torn tail");
  assert.equal(health.dropped_writes, 0, "healthy log must not report dropped writes");

  const fromMid = await readHarnessEvents(workspace, { limit: 1000, from_seq: 3 });
  assert.ok(fromMid.length > 0 && fromMid.every((event) => event.seq >= 3), "from_seq filter failed");

  await fs.appendFile(logPath, '{"type":"tool/observation","seq":999,"time":"20', "utf-8");
  const tornHealth = await getHarnessEventLogHealth(workspace);
  assert.equal(tornHealth.torn_tail, true, "torn tail must be detected");
  const recovered = await appendHarnessEvent(workspace, {
    type: "tool/observation",
    project_roots: [projectA],
    task_id: task.id,
    evidence_kind: "deterministic",
    data: { tool: "fixture", ok: true },
  });
  const repairedHealth = await getHarnessEventLogHealth(workspace);
  assert.equal(repairedHealth.torn_tail, false, "tail must be repaired on next write");
  assert.ok(repairedHealth.repairs >= 1, "repair counter must increment");
  assert.equal(recovered.seq, repairedHealth.last_seq, "seq must continue after tail repair");
  const afterRepair = await readHarnessEvents(workspace, { limit: 1000 });
  for (let index = 1; index < afterRepair.length; index++) {
    assert.equal(afterRepair[index].seq, afterRepair[index - 1].seq + 1, "log must stay contiguous after repair");
  }

  const wsNewer = path.join(tmpRoot, "workspace-newer");
  await fs.mkdir(wsNewer, { recursive: true });
  const newerPath = harnessEventLogPath(wsNewer);
  await fs.mkdir(path.dirname(newerPath), { recursive: true });
  const newerHeader = { kind: "harness-log", version: HARNESS_LOG_VERSION + 1, workspace_root: wsNewer, created_at: new Date().toISOString() };
  const newerEvent = { type: "goal/change", seq: 0, time: new Date().toISOString(), data: {} };
  await fs.writeFile(newerPath, `${JSON.stringify(newerHeader)}\n${JSON.stringify(newerEvent)}\n`, "utf-8");
  await assert.rejects(() => readHarnessEvents(wsNewer, { limit: 10 }), HarnessLogFormatError, "newer-format log must refuse reads");
  await assert.rejects(
    () => appendHarnessEvent(wsNewer, { type: "tool/observation", project_roots: [], data: { tool: "fixture", ok: true } }),
    HarnessLogFormatError,
    "newer-format log must refuse writes"
  );

  const wsLegacy = path.join(tmpRoot, "workspace-legacy");
  await fs.mkdir(wsLegacy, { recursive: true });
  const legacyPath = harnessEventLogPath(wsLegacy);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  const legacyEvent = {
    version: 1,
    seq: 0,
    time: new Date().toISOString(),
    type: "goal/change",
    workspace_root: wsLegacy,
    project_roots: [projectA],
    data: { operation: "create" },
  };
  await fs.writeFile(legacyPath, `${JSON.stringify(legacyEvent)}\n`, "utf-8");
  const legacyRead = await readHarnessEvents(wsLegacy, { limit: 10 });
  assert.equal(legacyRead.length, 1, "legacy log must be readable");
  assert.equal(legacyRead[0].type, "goal/change");
  assert.ok(!("version" in legacyRead[0]), "legacy envelope version must be converted away");
  assert.ok(!("workspace_root" in legacyRead[0]), "legacy envelope workspace_root must be converted away");
  await appendHarnessEvent(wsLegacy, { type: "tool/observation", project_roots: [projectA], data: { tool: "fixture", ok: true } });
  const legacyHealth = await getHarnessEventLogHealth(wsLegacy);
  assert.equal(legacyHealth.format, "v2", "legacy log must migrate to v2 on first write");
  assert.equal(legacyHealth.events, 2, "migration must preserve legacy events");
  assert.equal(legacyHealth.last_seq, 1, "migrated seq must continue the legacy sequence");

  const wsFail = path.join(tmpRoot, "workspace-fail");
  await fs.mkdir(wsFail, { recursive: true });
  const failPath = harnessEventLogPath(wsFail);
  await fs.mkdir(path.dirname(failPath), { recursive: true });
  await fs.mkdir(failPath);
  await appendHarnessEventSafe(wsFail, { type: "tool/observation", project_roots: [], data: { tool: "fixture", ok: true } });
  const failHealth = await getHarnessEventLogHealth(wsFail);
  assert.ok(failHealth.dropped_writes >= 1, "write failures must be counted, not silent");
  assert.ok(failHealth.last_write_error, "last write error must be recorded");

  console.log("harness-v2: project scope isolation, evidence typing, context broker, and harness-events v2 (header/seq/torn-tail/slimming/observability) OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
