import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-web-freeze");
const reportedObjective =
  "Goal Continuous Runner 让我们测试一下新版的goal 首先先删掉工作区内有关矢量图测试的文件 再分别生成三版详尽的prompt指导你分别生成三幅矢量图 主题一：鹈鹕骑自行车 主题二：海绵宝宝和派大星抓水母 主题三：秦始皇骑北极熊";
const previous = {
  codexHome: process.env.CODEX_HOME,
  auditLog: process.env.AUDIT_LOG_PATH,
  watchdog: process.env.GOAL_WATCHDOG_ENABLED,
  profile: process.env.CHATGPT_TOOL_PROFILE,
  pluginsConfig: process.env.CHATGPT_PLUGINS_CONFIG,
};

process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.AUDIT_LOG_PATH = path.join(tmpRoot, "audit.log");
process.env.GOAL_WATCHDOG_ENABLED = "false";
process.env.CHATGPT_TOOL_PROFILE = "slim";

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(tmpRoot, { recursive: true });
const pluginsConfigPath = path.join(tmpRoot, "plugins.json");
await fs.writeFile(pluginsConfigPath, JSON.stringify({
  schema_version: 2,
  computer_use: { enabled: false },
  browser_use: { enabled: false },
  skills: [],
}), "utf8");
process.env.CHATGPT_PLUGINS_CONFIG = pluginsConfigPath;

const { createMcpServer } = await import("../dist/server-factory.js");
const { advanceGoalRun } = await import("../dist/lib/goal-run-state.js");
const {
  goalRunPath,
  markProjectionRepairPending,
  projectGoalRunToLegacy,
  readGoalRun,
  replaceGoalRun,
  replaceGoalRunEnvelopeMetadata,
} = await import("../dist/lib/goal-run-store.js");
const { appendGoalRunEvidenceToResult, ensureGoalRunAuthority } = await import("../dist/lib/goal-run-web.js");
const { createDurableTask, recordToolObservation } = await import("../dist/lib/durable-tasks.js");
const { createGoal, getGoal, writeGoalRunProjection } = await import("../dist/lib/goals.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const { appendHarnessRuntimeContextToResult, buildHarnessRuntimeContext } = await import("../dist/lib/context-broker.js");

function resultText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function data(result) {
  assert.equal(result?.structuredContent?.ok, true, `tool failed: ${JSON.stringify(result?.structuredContent)}`);
  return result.structuredContent.data;
}

function assertToolFailed(result, message) {
  assert.equal(result?.structuredContent?.ok, false, message);
}

function invocationContext(tool, scope, rawArgs) {
  return {
    definition: { name: tool, source: "native" },
    scope,
    rawArgs,
    callbackArgs: [rawArgs],
  };
}

async function withServer(workspace, sessionId, operation) {
  await fs.mkdir(workspace, { recursive: true });
  const server = createMcpServer(workspace, 30_000, [workspace], true);
  const client = new Client({ name: `goal-web-freeze-${sessionId}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  serverTransport.sessionId = sessionId;
  try {
    return await operation(client);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

try {
  // Safe reproduction of the reported workflow. It carries the exact three
  // subjects but performs read-only fixture calls; no user vector file is
  // deleted and no image-generation service is invoked.
  const loopWorkspace = path.join(tmpRoot, "loop-workspace");
  await withServer(loopWorkspace, "goal-loop-session", async (client) => {
    const listed = await client.listTools();
    const expectedSlimTools = [
      "read_text_file", "read_file_base64", "file_info", "write_file", "write_file_base64", "save_chatgpt_file",
      "apply_patch", "glob", "grep", "code_intelligence", "list_directory", "run_command", "start_process",
      "process_status", "process_output", "process_input", "stop_process", "git_status", "git_diff", "agent_status",
      "project_context", "remember", "route_skills", "list_skills", "load_skill", "install_skill", "uninstall_skill", "set_skill_enabled",
      "goal", "task_state", "recovery_submit", "recovery_status", "visual_review", "rewind",
    ];
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedSlimTools.sort(), "the 34-tool slim public catalog changed");
    const goalTool = listed.tools.find((tool) => tool.name === "goal");
    assert.ok(goalTool, "goal tool missing");
    const goalProperties = goalTool.inputSchema.properties;
    assert.equal(goalProperties.evidence_ids.type, "array");
    for (const action of ["create", "update", "status", "bind", "resume", "reconcile"]) {
      assert.ok(goalProperties.action.enum.includes(action), `Goal schema lost ${action}`);
    }
    assert.equal(goalProperties.supersede.type, "boolean");
    const recoverySubmit = listed.tools.find((tool) => tool.name === "recovery_submit").inputSchema;
    assert.ok(recoverySubmit.required.includes("task_id") && recoverySubmit.required.includes("steps"));
    const recoveryStep = recoverySubmit.properties.steps.items;
    for (const field of ["id", "operation_id", "replay_policy", "command", "side_effect"]) {
      assert.ok(recoveryStep.required.includes(field), `recovery step schema lost ${field}`);
    }
    assert.deepEqual(recoveryStep.properties.replay_policy.enum, ["safe", "never"]);
    assert.deepEqual(recoveryStep.properties.side_effect.enum, ["none", "unknown"]);
    assert.equal(listed.tools.find((tool) => tool.name === "recovery_status").inputSchema.properties.task_id.type, "string");

    const created = await client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: reportedObjective,
        success_criteria: [
          { name: "仅清理已确认属于本任务的矢量图测试文件" },
          { name: "三版详尽 Prompt 已完成，且 Prompt 只是中间阶段" },
          { name: "鹈鹕骑自行车矢量图已生成并验证" },
          { name: "海绵宝宝和派大星抓水母矢量图已生成并验证" },
          { name: "秦始皇骑北极熊矢量图已生成并验证" },
        ],
        current_phase: "安全识别清理范围",
      },
    });
    data(created);
    assert.ok(resultText(created).includes("MUST_CONTINUE_TO_TOOL"), "new RUNNING Goal lost its continuation signal");

    let blockerResult;
    let readOnlyCalls = 0;
    const realDateNow = Date.now;
    let noProgressClock = realDateNow();
    try {
      Date.now = () => noProgressClock;
      for (; readOnlyCalls < 13; readOnlyCalls += 1) {
        const result = await client.callTool({ name: "list_directory", arguments: { path: loopWorkspace } });
        data(result);
        if (resultText(result).includes("GOAL_NO_PROGRESS_BLOCKER")) {
          blockerResult = result;
          readOnlyCalls += 1;
          break;
        }
        noProgressClock += Math.ceil((30 * 60_000) / 11) + 1;
      }
    } finally {
      Date.now = realDateNow;
    }
    assert.ok(blockerResult, "no-progress Goal loop was not bounded after thirty minutes of exact repeats");
    assert.equal(readOnlyCalls, 13, `timed no-progress blocker fired after an unexpected number of results: ${readOnlyCalls}`);
    assert.ok(!resultText(blockerResult).includes("MUST_CONTINUE_TO_TOOL"), "blocker tail conflicts with a continue lock");
    assert.deepEqual(await fs.readdir(loopWorkspace), [], "safe reproduction unexpectedly changed workspace files");

    const failedPause = await client.callTool({
      name: "goal",
      arguments: { action: "pause", pause_kind: "no_progress", current_phase: "Blocked: no semantic progress", expected_revision: 999_999 },
    });
    assertToolFailed(failedPause, "stale pause fixture unexpectedly succeeded");
    assert.ok(resultText(failedPause).includes("GOAL_NO_PROGRESS_PAUSE_FAILED"), "failed bounded pause invited another retry");
    assert.ok(!resultText(failedPause).includes("Call goal(action=pause"), "failed pause repeated the pause instruction");

    const paused = await client.callTool({
      name: "goal",
      arguments: { action: "pause", pause_kind: "no_progress", current_phase: "Blocked: no semantic progress" },
    });
    assert.equal(data(paused).goal_run.state, "NO_PROGRESS_PAUSED", "no-progress recovery used generic interruption state");
    assert.ok(!resultText(paused).includes("MUST_CONTINUE_TO_TOOL"), "paused Goal retained the execution lock");

    const resumed = await client.callTool({ name: "goal", arguments: { action: "resume" } });
    assert.equal(data(resumed).goal_run.state, "RUNNING", "paused GoalRun did not resume");
    assert.ok(resultText(resumed).includes("MUST_CONTINUE_TO_TOOL"), "resume did not reset the semantic-progress bound");

    // Exercise the real WAITING_USER state behind the Web adapter. Store
    // invalidation must make the very next result state-aware (no 2s stale tail).
    const beforeWait = await readGoalRun(loopWorkspace, "goal-loop-session");
    assert.ok(beforeWait, "GoalRun missing before WAITING_USER transition");
    const waitNow = new Date(Date.parse(beforeWait.run.timestamps.updatedAt) + 1_000).toISOString();
    const waiting = advanceGoalRun(
      beforeWait.run,
      {
        type: "wait_user",
        waitId: "delete-approval",
        requestKey: "confirm-vector-cleanup",
        description: "Confirm the exact vector-test files before destructive cleanup",
        timeoutMs: 60_000,
        nextAction: "Resume cleanup only after matching user approval",
      },
      { expectedRevision: beforeWait.run.revision, now: waitNow }
    );
    await replaceGoalRun(
      loopWorkspace,
      { ...beforeWait, run: waiting.run },
      { expectedRevision: beforeWait.run.revision },
      "goal-loop-session"
    );
    const waitingResult = await client.callTool({ name: "list_directory", arguments: { path: loopWorkspace } });
    const waitingText = resultText(waitingResult);
    assert.ok(waitingText.includes("GOAL_WAITING_USER") && waitingText.includes("YIELD_TO_USER"), "WAITING_USER did not release the Web turn");
    assert.ok(!waitingText.includes("MUST_CONTINUE_TO_TOOL"), "WAITING_USER conflicts with the RUNNING continue lock");
  });

  // Goal-only completion must not demand a non-existent durable task finish.
  const finishWorkspace = path.join(tmpRoot, "goal-only-finish");
  await withServer(finishWorkspace, "goal-finish-session", async (client) => {
    const inspectedFile = path.join(finishWorkspace, "inspection.txt");
    await fs.writeFile(inspectedFile, "finish-chain fixture");
    data(await client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "Verify a goal-only finish chain",
        success_criteria: [{ name: "workspace was inspected", verification: { kind: "file_exists", target: inspectedFile } }],
      },
    }));
    const inspected = data(await client.callTool({ name: "file_info", arguments: { path: inspectedFile, sha256: true } }));
    const evidenceId = inspected.goal_run_evidence?.id;
    assert.ok(evidenceId, "read-only inspection did not expose GoalRun evidence");
    const confirmed = await client.callTool({
      name: "goal",
      arguments: { action: "confirm", criterion: "workspace was inspected", evidence_ids: [evidenceId] },
    });
    const finishText = resultText(confirmed);
    assert.ok(finishText.includes("goal(action=complete)"), "confirmed goal did not request explicit finalization");
    assert.ok(!finishText.includes("task_state(action=complete)"), "goal-only finish invented a durable task completion call");
    data(await client.callTool({ name: "goal", arguments: { action: "complete" } }));
  });

  // Goal completion is only the first half of the finish chain when a durable
  // task is still active. The goal result must carry the one remaining task
  // completion call, and a failed task completion must stop rather than loop.
  const taskFinishWorkspace = path.join(tmpRoot, "goal-task-finish");
  await withServer(taskFinishWorkspace, "goal-task-finish-session", async (client) => {
    const inspectedFile = path.join(taskFinishWorkspace, "inspection.txt");
    await fs.writeFile(inspectedFile, "task finish-chain fixture");
    data(await client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "Complete the Goal and its durable task in order",
        success_criteria: [{ name: "workspace inspected", verification: { kind: "file_exists", target: inspectedFile } }],
      },
    }));
    const task = data(await client.callTool({
      name: "task_state",
      arguments: {
        action: "create",
        goal: "Verify Goal-to-task finish ordering",
        current_step: "Inspect workspace",
        blocking_checks: [{ name: "task finish check", passed: false }],
      },
    }));
    const taskId = task.handoff.task_id;
    const inspected = data(await client.callTool({ name: "file_info", arguments: { path: inspectedFile, sha256: true } }));
    const evidenceId = inspected.goal_run_evidence?.id;
    assert.ok(evidenceId, "task-backed Goal inspection did not expose evidence");
    data(await client.callTool({
      name: "goal",
      arguments: { action: "confirm", criterion: "workspace inspected", evidence_ids: [evidenceId] },
    }));
    const completedGoal = await client.callTool({ name: "goal", arguments: { action: "complete" } });
    data(completedGoal);
    assert.ok(resultText(completedGoal).includes("GOAL_COMPLETED_TASK_PENDING"), "Goal completion dropped the active task finish call");
    assert.ok(resultText(completedGoal).includes("task_state(action=complete)"), "Goal completion did not name the task completion action");
    const failedTaskCompletion = await client.callTool({
      name: "task_state",
      arguments: { action: "complete", task_id: taskId },
    });
    assertToolFailed(failedTaskCompletion, "task with an unmet blocking check unexpectedly completed");
    assert.ok(resultText(failedTaskCompletion).includes("GOAL_COMPLETED_TASK_BLOCKER"), "failed task completion invited a retry loop");
    data(await client.callTool({
      name: "task_state",
      arguments: {
        action: "checkpoint",
        task_id: taskId,
        current_step: "Ready to complete",
        blocking_checks: [{ name: "task finish check", passed: true }],
      },
    }));
    const completedTask = await client.callTool({
      name: "task_state",
      arguments: { action: "complete", task_id: taskId, note: "Goal and task finish ordering verified" },
    });
    assert.equal(data(completedTask).handoff.status, "completed", "durable task did not complete after Goal completion");
    assert.ok(!resultText(completedTask).includes("GOAL_COMPLETED_TASK_PENDING"), "completed task retained a finish-loop instruction");
  });

  // A Task created before the Goal has no Goal binding. It must never be
  // advertised as this Goal's finish chain, even when both share a session.
  const unrelatedWorkspace = path.join(tmpRoot, "unrelated-task-finish");
  await withServer(unrelatedWorkspace, "unrelated-task-session", async (client) => {
    const inspectedFile = path.join(unrelatedWorkspace, "inspection.txt");
    await fs.writeFile(inspectedFile, "unrelated task fixture");
    const prior = data(await client.callTool({ name: "task_state", arguments: {
      action: "create", goal: "Independent prior task", blocking_checks: [{ name: "prior", passed: true }],
    } }));
    data(await client.callTool({ name: "goal", arguments: {
      action: "create", objective: "Finish independent Goal",
      success_criteria: [{ name: "inspected", verification: { kind: "file_exists", target: inspectedFile } }],
    } }));
    const inspected = data(await client.callTool({ name: "file_info", arguments: { path: inspectedFile, sha256: true } }));
    const confirmed = await client.callTool({ name: "goal", arguments: {
      action: "confirm", criterion: "inspected", evidence_ids: [inspected.goal_run_evidence.id],
    } });
    data(confirmed);
    assert.ok(!resultText(confirmed).includes("then task_state(action=complete)"), "unrelated Task was included in Goal finish chain");
    const completed = await client.callTool({ name: "goal", arguments: { action: "complete" } });
    data(completed);
    assert.ok(!resultText(completed).includes("GOAL_COMPLETED_TASK_PENDING"), "unrelated Task was falsely reported as Goal work");
    const rejected = await client.callTool({ name: "task_state", arguments: { action: "complete", task_id: prior.handoff.task_id } });
    assertToolFailed(rejected, "unbound prior Task must not complete against the Goal");
    assert.ok(resultText(rejected).includes("TASK_GOAL_MISMATCH"));
    const priorStatus = data(await client.callTool({ name: "task_state", arguments: { action: "list" } }));
    assert.equal(priorStatus.tasks.find(task => task.task_id === prior.handoff.task_id)?.status, "active", "unrelated Task must remain untouched");
  });

  // A status call from another session is read-only, redacted, and cannot
  // create/promote GoalRun state for the foreign owner.
  const foreignWorkspace = path.join(tmpRoot, "foreign-session");
  await fs.mkdir(foreignWorkspace, { recursive: true });
  const ownerScope = createRuntimeScope(
    { workspaceRoot: foreignWorkspace, projectRoots: [foreignWorkspace] },
    { sessionId: "foreign-owner-session" }
  );
  await runWithRuntimeScope(ownerScope, async () => {
    await createGoal(foreignWorkspace, {
      objective: "PRIVATE FOREIGN GOAL OBJECTIVE",
      success_criteria: [{ name: "owner-only criterion" }],
    });
    await createDurableTask(foreignWorkspace, {
      goal: "PRIVATE OWNER TASK",
      current_step: "Record owner-only evidence",
    });
    await recordToolObservation(
      foreignWorkspace,
      "run_command",
      { command: "npm test" },
      {
        structuredContent: {
          ok: true,
          tool: "run_command",
          summary: "OWNER_ONLY_EVIDENCE",
          data: { command: "npm test", exit_code: 0, stdout: "OWNER_ONLY_EVIDENCE" },
        },
      }
    );
  });
  const ownerContext = await buildHarnessRuntimeContext(foreignWorkspace, undefined, "foreign-owner-session");
  assert.ok(ownerContext.recent_evidence.length > 0, "owner evidence fixture was not recorded");
  await withServer(foreignWorkspace, "foreign-observer-session", async (client) => {
    const status = await client.callTool({ name: "goal", arguments: { action: "status" } });
    const statusData = data(status);
    // Plan A: full session isolation — observer has no shard, sees "no goal"
    assert.equal(statusData.goal, null, "foreign status leaked the full goal");
    assert.equal(statusData.summary, null, "foreign status leaked goal summary");
    assert.equal(statusData.goal_run, null, "foreign status leaked GoalRun state");
    assert.ok(!JSON.stringify(status).includes("PRIVATE FOREIGN GOAL OBJECTIVE"), "foreign objective leaked through status/context");
    assert.deepEqual(statusData.harness_context?.recent_evidence ?? [], [], "foreign status leaked another session's recent evidence");
    assert.equal(await readGoalRun(foreignWorkspace), null, "foreign status created GoalRun state");

    const foreignWrites = [
      { action: "update", objective: "FOREIGN UPDATE" },
      { action: "confirm", criterion: "owner-only criterion", evidence_ids: ["foreign-evidence"] },
      { action: "pause" },
      { action: "resume" },
      { action: "complete" },
      { action: "cancel" },
    ];
    for (const arguments_ of foreignWrites) {
      const mutation = await client.callTool({ name: "goal", arguments: arguments_ });
      assertToolFailed(mutation, `foreign goal(action=${arguments_.action}) unexpectedly succeeded`);
    }
    // Plan A: observer may create its own goal in its own shard — that is legal.
    // The critical invariant is that the owner's shard remains untouched.
    const preserved = await getGoal(foreignWorkspace, "foreign-owner-session");
    assert.equal(preserved?.objective, "PRIVATE FOREIGN GOAL OBJECTIVE", "foreign mutation changed the owner's goal");
    assert.equal(await readGoalRun(foreignWorkspace), null, "foreign mutation created or changed GoalRun state");
  });

  // External-process waits must be both result-aware and bounded. A matching
  // successful terminal status resumes the run, repeated polls hit a hard
  // stop, and the next result after the deadline persists a timeout.
  const externalWorkspace = path.join(tmpRoot, "external-wait");
  await fs.mkdir(externalWorkspace, { recursive: true });
  const externalScope = createRuntimeScope(
    { workspaceRoot: externalWorkspace, projectRoots: [externalWorkspace] },
    { sessionId: "external-wait-session" }
  );
  let externalEnvelope;
  await runWithRuntimeScope(externalScope, async () => {
    const externalGoal = await createGoal(externalWorkspace, {
      objective: "Verify bounded external-process waiting",
      success_criteria: [{ name: "external wait recovered" }],
    });
    externalEnvelope = await ensureGoalRunAuthority(externalWorkspace, externalGoal);
    const externalWait = advanceGoalRun(
      externalEnvelope.run,
      {
        type: "wait_external",
        waitId: "external-success",
        processRef: "fixture-process",
        description: "Wait for the fixture process",
        timeoutMs: 60_000,
        pollIntervalMs: 100,
      },
      { expectedRevision: externalEnvelope.run.revision, now: new Date().toISOString() }
    );
    externalEnvelope = await replaceGoalRun(
      externalWorkspace,
      { ...externalEnvelope, run: externalWait.run },
      { expectedRevision: externalEnvelope.run.revision }
    );
  });
  let pollLimitResult;
  await runWithRuntimeScope(externalScope, async () => {
    for (let index = 0; index < 12; index += 1) {
      pollLimitResult = await appendHarnessRuntimeContextToResult(
        externalWorkspace,
        {
          content: [{ type: "text", text: "fixture poll" }],
          structuredContent: { ok: true, tool: "process_status", summary: "still running", data: {} },
        },
        { toolName: "process_status" }
      );
    }
  });
  assert.ok(resultText(pollLimitResult).includes("GOAL_EXTERNAL_WAIT_POLL_LIMIT"), "external wait polling was not bounded");
  await runWithRuntimeScope(externalScope, () =>
    appendGoalRunEvidenceToResult(
      externalWorkspace,
      invocationContext("process_status", externalScope, { id: "fixture-process" }),
      {
        content: [{ type: "text", text: "fixture process complete" }],
        structuredContent: {
          ok: true,
          tool: "process_status",
          summary: "fixture process complete",
          data: { processes: [{ id: "fixture-process", running: false, exit_code: 0 }] },
        },
      }
    )
  );
  externalEnvelope = await readGoalRun(externalWorkspace, "external-wait-session");
  assert.ok(externalEnvelope, "external GoalRun disappeared after terminal process result");
  assert.equal(externalEnvelope?.run.state, "RUNNING", "matching terminal process result did not resume GoalRun");

  const timeoutWait = advanceGoalRun(
    externalEnvelope.run,
    {
      type: "wait_external",
      waitId: "external-timeout",
      processRef: "fixture-process-timeout",
      description: "Wait for a process that exceeds its deadline",
      timeoutMs: 100,
      pollIntervalMs: 100,
    },
    { expectedRevision: externalEnvelope.run.revision, now: new Date().toISOString() }
  );
  await replaceGoalRun(
    externalWorkspace,
    { ...externalEnvelope, run: timeoutWait.run },
    { expectedRevision: externalEnvelope.run.revision },
    "external-wait-session"
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  await runWithRuntimeScope(externalScope, () =>
    appendGoalRunEvidenceToResult(
      externalWorkspace,
      invocationContext("process_status", externalScope, { id: "fixture-process-timeout" }),
      {
        content: [{ type: "text", text: "fixture process still running" }],
        structuredContent: {
          ok: true,
          tool: "process_status",
          summary: "fixture process still running",
          data: { processes: [{ id: "fixture-process-timeout", running: true, exit_code: null }] },
        },
      }
    )
  );
  const timedOutEnvelope = await readGoalRun(externalWorkspace, "external-wait-session");
  assert.equal(timedOutEnvelope?.run.state, "INTERRUPTED", "expired external wait remained active");
  assert.equal(timedOutEnvelope?.run.stopReason?.kind, "WAIT_TIMEOUT", "expired external wait lost its timeout reason");

  // A crash/failure after the authoritative run commits but before goal.json
  // projects must surface a repair preflight, not a false completion. Status
  // observes the issue; explicit reconciliation repairs and clears the marker.
  const repairWorkspace = path.join(tmpRoot, "projection-repair");
  await fs.mkdir(repairWorkspace, { recursive: true });
  const repairGoal = await createGoal(repairWorkspace, {
    objective: "Repair a committed completion projection",
    success_criteria: [{ name: "completion evidence recorded" }],
  });
  let repairEnvelope = await ensureGoalRunAuthority(repairWorkspace, repairGoal);
  const evidenceTime = new Date(Math.max(Date.now(), Date.parse(repairEnvelope.run.timestamps.updatedAt)) + 1).toISOString();
  const evidenced = advanceGoalRun(
    repairEnvelope.run,
    {
      type: "record_evidence",
      evidence: {
        id: "repair-evidence",
        kind: "deterministic",
        summary: "simulated verified completion evidence",
        source: "fixture",
        metadata: { verifiesCriterion: true },
      },
    },
    { expectedRevision: repairEnvelope.run.revision, now: evidenceTime }
  );
  repairEnvelope = await replaceGoalRun(
    repairWorkspace,
    { ...repairEnvelope, run: evidenced.run },
    { expectedRevision: repairEnvelope.run.revision }
  );
  const confirmedTime = new Date(Date.parse(evidenceTime) + 1).toISOString();
  const confirmed = advanceGoalRun(
    repairEnvelope.run,
    {
      type: "confirm_criterion",
      criterionId: repairEnvelope.run.criteria[0].id,
      evidenceIds: ["repair-evidence"],
    },
    { expectedRevision: repairEnvelope.run.revision, now: confirmedTime }
  );
  repairEnvelope = await replaceGoalRun(
    repairWorkspace,
    { ...repairEnvelope, run: confirmed.run },
    { expectedRevision: repairEnvelope.run.revision }
  );
  const readyTime = new Date(Date.parse(confirmedTime) + 1).toISOString();
  const ready = advanceGoalRun(
    repairEnvelope.run,
    { type: "request_finalize" },
    { expectedRevision: repairEnvelope.run.revision, now: readyTime }
  );
  repairEnvelope = await replaceGoalRun(
    repairWorkspace,
    { ...repairEnvelope, run: ready.run },
    { expectedRevision: repairEnvelope.run.revision }
  );
  const completedTime = new Date(Date.parse(readyTime) + 1).toISOString();
  const completed = advanceGoalRun(
    repairEnvelope.run,
    { type: "complete" },
    { expectedRevision: repairEnvelope.run.revision, now: completedTime }
  );
  repairEnvelope = await replaceGoalRun(
    repairWorkspace,
    { ...repairEnvelope, run: completed.run },
    { expectedRevision: repairEnvelope.run.revision }
  );
  const pendingRepair = markProjectionRepairPending(repairEnvelope, "simulated legacy projection failure");
  await replaceGoalRunEnvelopeMetadata(repairWorkspace, pendingRepair, {
    expectedEnvelopeRevision: repairEnvelope.envelopeRevision ?? 1,
    expectedRunRevision: repairEnvelope.run.revision,
  });
  await writeGoalRunProjection(
    repairWorkspace,
    projectGoalRunToLegacy(pendingRepair, repairGoal),
    { expectedCurrentRevision: repairGoal.revision, operation: "fixture:partial-projection-repair" }
  );
  const repairIssueResult = await appendHarnessRuntimeContextToResult(
    repairWorkspace,
    {
      content: [{ type: "text", text: "fixture" }],
      structuredContent: { ok: true, tool: "fixture", summary: "fixture", data: {} },
    },
    { toolName: "fixture" }
  );
  const repairIssueText = resultText(repairIssueResult);
  assert.ok(repairIssueText.includes("GOAL_RUN_PROJECTION_REPAIR_PENDING"), "repair-pending completion was exposed as complete");
  assert.ok(repairIssueText.includes("GOALRUN_PREFLIGHT_REQUIRED"), "repair-pending completion did not request one status preflight");
  assert.ok(!repairIssueText.includes("GOAL_COMPLETED:"), "repair-pending completion emitted a false terminal signal");
  await withServer(repairWorkspace, "projection-repair-session", async (client) => {
    const observedStatus = data(await client.callTool({ name: "goal", arguments: { action: "status" } }));
    assert.equal(observedStatus.reconciliation_required, true, "status must report pending migration/repair without performing it");
    const repairedStatus = data(await client.callTool({ name: "goal", arguments: { action: "reconcile", expected_revision: observedStatus.stored_goal_revision } }));
    assert.equal(repairedStatus.goal.status, "completed", "explicit reconcile did not repair the completed legacy projection");
    assert.equal(repairedStatus.goal_run.state, "COMPLETED", "reconciliation changed authoritative completion");
  });
  const repairedEnvelope = await readGoalRun(repairWorkspace, "projection-repair-session");
  assert.equal(repairedEnvelope?.parity?.repairPending, false, "verified projection repair left repairPending set");

  // Future/corrupt GoalRun state is a visible stop condition, never a silent
  // fallback to the legacy active Goal's unconditional continuation tail.
  const futureWorkspace = path.join(tmpRoot, "future-goal-run");
  await fs.mkdir(futureWorkspace, { recursive: true });
  const futureGoal = await createGoal(futureWorkspace, {
    objective: "Fail closed on a future GoalRun schema",
    success_criteria: [{ name: "future schema rejected" }],
  });
  await ensureGoalRunAuthority(futureWorkspace, futureGoal);
  const futurePath = goalRunPath(futureWorkspace);
  const futureRaw = JSON.parse(await fs.readFile(futurePath, "utf-8"));
  futureRaw.schemaVersion += 1;
  await fs.writeFile(futurePath, `${JSON.stringify(futureRaw, null, 2)}\n`, "utf-8");
  const futureResult = await appendHarnessRuntimeContextToResult(
    futureWorkspace,
    {
      content: [{ type: "text", text: "fixture" }],
      structuredContent: { ok: true, tool: "fixture", summary: "fixture", data: {} },
    },
    { toolName: "fixture" }
  );
  const futureText = resultText(futureResult);
  assert.ok(futureText.includes("GOALRUN_BLOCKER") && futureText.includes("GOAL_RUN_STATE_UNREADABLE"), "future GoalRun schema failed open");
  assert.ok(!futureText.includes("MUST_CONTINUE_TO_TOOL"), "future GoalRun blocker retained an unconditional continue lock");

  // Risk annotations must stay truthful. Host/app permission decides whether
  // ChatGPT confirms a call; MCP annotations must not be altered to bypass it.
  process.env.CHATGPT_TOOL_PROFILE = "full";
  const riskWorkspace = path.join(tmpRoot, "risk-annotations");
  await withServer(riskWorkspace, "risk-session", async (client) => {
    const listed = await client.listTools();
    const expectedFullTools = [
      "read_text_file", "read_file_base64", "file_info", "write_file", "write_file_base64", "save_chatgpt_file",
      "edit_file", "multi_edit", "apply_patch", "glob", "grep", "code_intelligence",
      "list_directory", "directory_tree", "search_files", "create_directory", "delete_file", "delete_directory",
      "copy_file", "move_file", "replace_regex", "list_allowed_directories", "run_command", "shell_status",
      "shell_reset", "start_process", "process_status", "process_output", "process_input", "stop_process",
      "clear_processes", "node_repl", "ponytail_turn", "open_image", "render_svg", "capture_webpage",
      "visual_review", "goal", "task_state", "task_create", "task_status", "task_update",
      "task_complete", "task_list", "recovery_submit", "recovery_status", "browser_open", "browser_action",
      "browser_close", "git_status", "git_diff", "git_log", "git_add", "git_commit",
      "git_branch", "git_checkout", "git_restore", "git_stash", "git_reset", "git_pull",
      "git_push", "agent_status", "project_context", "remember", "load_path_rules", "route_skills", "list_skills",
      "load_skill", "install_skill", "uninstall_skill", "set_skill_enabled", "rewind",
    ];
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), expectedFullTools.sort(), "the full native catalog without optional providers or an upstream bridge changed");
    const shellStatus = listed.tools.find((tool) => tool.name === "shell_status");
    const shellReset = listed.tools.find((tool) => tool.name === "shell_reset");
    assert.equal(shellStatus.inputSchema.type, "object");
    assert.equal(shellStatus.annotations.readOnlyHint, true);
    assert.equal(shellReset.inputSchema.properties.path.type, "string");
    assert.equal(shellReset.annotations.readOnlyHint, false);
    for (const name of ["delete_file", "delete_directory"]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      assert.equal(tool?.annotations?.destructiveHint, true, `${name} is not marked destructive`);
    }
    assert.equal(
      listed.tools.find((candidate) => candidate.name === "write_file")?.annotations?.destructiveHint,
      true,
      "write_file must advertise that it can overwrite existing state"
    );
    const commandTool = listed.tools.find((candidate) => candidate.name === "run_command");
    assert.equal(commandTool?.annotations?.destructiveHint, true, "run_command must advertise destructive capability");
    assert.equal(commandTool?.annotations?.openWorldHint, true, "run_command must advertise open-world capability");
  });

  console.log(
    "goal-web-freeze: exact vector workflow bounded, WAITING_USER yields, GoalRun errors fail closed, foreign status is redacted, goal-only finish and truthful risk annotations OK"
  );
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("CODEX_HOME", previous.codexHome);
  restore("AUDIT_LOG_PATH", previous.auditLog);
  restore("GOAL_WATCHDOG_ENABLED", previous.watchdog);
  restore("CHATGPT_TOOL_PROFILE", previous.profile);
  restore("CHATGPT_PLUGINS_CONFIG", previous.pluginsConfig);
}
