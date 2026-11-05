import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goal-work-progress-"));
const previous = {
  codexHome: process.env.CODEX_HOME,
  auditLog: process.env.AUDIT_LOG_PATH,
  watchdog: process.env.GOAL_WATCHDOG_ENABLED,
  profile: process.env.CHATGPT_TOOL_PROFILE,
};
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.AUDIT_LOG_PATH = path.join(tmpRoot, "audit.log");
process.env.GOAL_WATCHDOG_ENABLED = "false";
process.env.CHATGPT_TOOL_PROFILE = "slim";

const {
  advanceGoalWorkHistory,
  GOAL_NO_PROGRESS_REPEAT_WINDOW_MS,
  goalWorkHistoryIsStalled,
  goalWorkObservation,
} = await import("../dist/lib/goal-work-progress.js");
const { createMcpServer } = await import("../dist/server-factory.js");
const { appendHarnessRuntimeContextToResult } = await import("../dist/lib/context-broker.js");
const { createGoal } = await import("../dist/lib/goals.js");
const { ensureGoalRunAuthority } = await import("../dist/lib/goal-run-web.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated Goal progress fixtures",
  scope: ["temporary Goal progress workspace"],
  out_of_scope: [],
  deliverables: ["deterministic Goal progress evidence"],
  success_criteria: ["fixture operations complete without false no-progress escalation"],
  constraints: [],
  protected_resources: [],
  known_facts: ["all mutations are isolated in tmpRoot"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

function resultText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

function data(result) {
  assert.equal(result?.structuredContent?.ok, true, "tool result was not successful");
  return result.structuredContent.data;
}

function syntheticResult(extraData = {}) {
  return {
    content: [{ type: "text", text: "fixture" }],
    structuredContent: {
      ok: true,
      tool: "list_directory",
      summary: "fixture",
      data: { entries: [], count: 0, ...extraData },
    },
  };
}

assert.equal(
  goalWorkObservation("list_directory", {}, syntheticResult()).fingerprint,
  goalWorkObservation("list_directory", {}, syntheticResult({ skill_discovery: { catalog: { catalog_sha256: "changed-hint" } } })).fingerprint,
  "periodic discovery hints must never count as new productive work"
);

function processPoll(startedAt, evidenceId, stdoutChars = 3) {
  return {
    structuredContent: {
      ok: true,
      tool: "process_status",
      summary: "fixture",
      data: {
        processes: [{
          id: "process-1",
          running: true,
          started_at: startedAt,
          stdout_chars: stdoutChars,
          stderr_chars: 0,
        }],
        updated_at: startedAt,
        goal_run_evidence: { evidence_id: evidenceId },
      },
    },
  };
}

function withScope(workspaceRoot, sessionId, fn) {
  const scope = createRuntimeScope(
    { workspaceRoot, projectRoots: [workspaceRoot] },
    { sessionId }
  );
  return runWithRuntimeScope(scope, fn);
}

async function withServer(workspace, sessionId, operation) {
  await fs.mkdir(workspace, { recursive: true });
  const server = createMcpServer(workspace, 30_000, [workspace], true);
  const client = new Client({ name: "goal-work-progress-" + sessionId, version: "1" });
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

async function assertObservationSemantics() {
  const args = { path: "/fixture/empty" };
  const first = goalWorkObservation("list_directory", args, syntheticResult({
    observed_at: "2026-09-13T00:00:00.000Z",
    timestamp: "2026-09-13T00:00:01.000Z",
    goal_run_evidence: { evidence_id: "evidence-a" },
  }));
  const second = goalWorkObservation("list_directory", args, syntheticResult({
    observed_at: "2026-09-13T00:01:00.000Z",
    timestamp: "2026-09-13T00:01:01.000Z",
    goal_run_evidence: { evidence_id: "evidence-b" },
  }));
  assert.ok(first && second, "stable observations were not classified");
  assert.equal(first.fingerprint, second.fingerprint, "timestamps/evidence IDs changed the work fingerprint");

  let repeatedHistory;
  for (let index = 0; index < 13; index += 1) {
    repeatedHistory = advanceGoalWorkHistory(repeatedHistory, first);
  }
  assert.equal(repeatedHistory.repeated, 12, "first observation plus 12 repeats did not reach the bound");
  assert.equal(repeatedHistory.advanced, false, "a repeated read was counted as productive progress");

  const distinct = goalWorkObservation("write_file", { path: "/fixture/new.txt", content: "new" }, syntheticResult({
    path: "/fixture/new.txt",
    sha256: "new-digest",
  }));
  assert.ok(distinct, "distinct write observation was not classified");
  assert.equal(advanceGoalWorkHistory(repeatedHistory, distinct).advanced, true, "new successful work did not advance history");

  const failed = goalWorkObservation("process_output", args, {
    isError: true,
    structuredContent: {
      ok: false,
      tool: "process_output",
      summary: "failed",
      data: { error: "process unavailable", timestamp: "later" },
    },
  });
  assert.ok(failed, "failed observation was unexpectedly discarded");
  assert.equal(failed.productive, false, "failed tool output counted as productive progress");
  assert.equal(advanceGoalWorkHistory(undefined, failed).advanced, false, "failed output advanced history");

  const control = goalWorkObservation("shell_status", {}, syntheticResult({ status: "ready" }));
  assert.ok(control, "control observation was unexpectedly discarded");
  assert.equal(control.productive, false, "a control/status query counted as productive work");

  const pollA = goalWorkObservation("process_status", { id: "process-1" }, processPoll("2026-09-13T00:00:00.000Z", "evidence-a"));
  const pollB = goalWorkObservation("process_status", { id: "process-1" }, processPoll("2026-09-13T00:05:00.000Z", "evidence-b"));
  const pollC = goalWorkObservation("process_status", { id: "process-1" }, processPoll("2026-09-13T00:05:00.000Z", "evidence-b", 4));
  assert.ok(pollA && pollB && pollC, "process poll observations were unexpectedly discarded");
  assert.equal(pollA.fingerprint, pollB.fingerprint, "volatile process timestamps/evidence IDs changed the poll fingerprint");
  assert.notEqual(pollB.fingerprint, pollC.fingerprint, "real process output growth was not visible as new work");

  // Each session owns its own history. This mirrors the broker's keying and
  // prevents one window's repeated read loop from poisoning another window.
  const sessionA = advanceGoalWorkHistory(undefined, first);
  const sessionB = advanceGoalWorkHistory(undefined, first);
  assert.equal(sessionA.repeated, 0);
  assert.equal(sessionB.repeated, 0);
  assert.equal(sessionA.advanced, true);
  assert.equal(sessionB.advanced, true);

  let saturatedHistory;
  for (let index = 0; index < 256; index += 1) {
    saturatedHistory = advanceGoalWorkHistory(saturatedHistory, {
      fingerprint: `saturation-seed-${index}`,
      productive: true,
    });
  }
  assert.equal(saturatedHistory.seen.size, 256, "work history did not reach its bounded capacity");
  const saturatedResult = { fingerprint: "first-result-after-saturation", productive: true };
  saturatedHistory = advanceGoalWorkHistory(saturatedHistory, saturatedResult);
  assert.equal(saturatedHistory.advanced, false, "an untracked saturated result fabricated progress");
  for (let index = 0; index < 12; index += 1) {
    saturatedHistory = advanceGoalWorkHistory(saturatedHistory, saturatedResult);
  }
  assert.equal(saturatedHistory.repeated, 12, "a result first seen after saturation could repeat forever without blocking");
  assert.equal(goalWorkHistoryIsStalled(saturatedHistory), false, "fast post-saturation repeats inferred a timed stall");

  let variedHistory;
  const variedA = { fingerprint: "varied-a", productive: true };
  const variedB = { fingerprint: "varied-b", productive: true };
  for (let index = 0; index < 30; index += 1) {
    variedHistory = advanceGoalWorkHistory(variedHistory, index % 2 === 0 ? variedA : variedB, index * 10 * 60_000);
    assert.equal(variedHistory.repeated, 0, "alternating prior results accumulated an inferred stop streak");
  }
  assert.equal(goalWorkHistoryIsStalled(variedHistory), false, "varied results inferred a timed stall");

  const timedResult = { fingerprint: "timed-exact-repeat", productive: true };
  let timedHistory = advanceGoalWorkHistory(undefined, timedResult, 0);
  timedHistory = advanceGoalWorkHistory(timedHistory, timedResult, GOAL_NO_PROGRESS_REPEAT_WINDOW_MS);
  assert.equal(timedHistory.repeatedForMs, 0, "one delayed repeat inherited idle time as repeat time");
  assert.equal(goalWorkHistoryIsStalled(timedHistory), false, "one delayed repeat inferred a continuous stall");
  timedHistory = advanceGoalWorkHistory(timedHistory, timedResult, (2 * GOAL_NO_PROGRESS_REPEAT_WINDOW_MS) - 1);
  assert.equal(goalWorkHistoryIsStalled(timedHistory), false, "repeat streak blocked before thirty minutes");
  timedHistory = advanceGoalWorkHistory(timedHistory, timedResult, 2 * GOAL_NO_PROGRESS_REPEAT_WINDOW_MS);
  assert.equal(goalWorkHistoryIsStalled(timedHistory), true, "multiple exact repeats lasting thirty minutes did not infer a stall");
}

async function assertSessionBrokerIsolation() {
  const workspace = path.join(tmpRoot, "session-isolation");
  await fs.mkdir(workspace, { recursive: true });
  const goal = await withScope(workspace, "session-A", () =>
    createGoal(workspace, {
      objective: "Window A bounded work",
      success_criteria: [{ name: "A criterion remains unconfirmed" }],
    })
  );
  await withScope(workspace, "session-A", () => ensureGoalRunAuthority(workspace, goal));

  let repeatedObservation;
  for (let index = 0; index < 40; index += 1) {
    const result = await withScope(workspace, "session-A", () =>
      appendHarnessRuntimeContextToResult(
        workspace,
        syntheticResult(),
        { toolName: "list_directory", rawArgs: { path: workspace } }
      )
    );
    assert.doesNotMatch(resultText(result), /GOAL_NO_PROGRESS_BLOCKER/, "fast identical results inferred a timed blocker");
    if (resultText(result).includes("Matching work fingerprint:")) repeatedObservation = result;
  }
  assert.ok(repeatedObservation, "fast repeated work lost its factual observation");
  assert.match(resultText(repeatedObservation), /repeats=\d+, observation_window_ms=\d+/);
  assert.match(resultText(repeatedObservation), /does not prove a stall/);
  assert.doesNotMatch(resultText(repeatedObservation), /GOAL_CHECKPOINT_DUE|GOAL_NO_PROGRESS_BLOCKER|MUST_CONTINUE_TO_TOOL/);
  const otherSessionResult = await withScope(workspace, "session-B", () =>
    appendHarnessRuntimeContextToResult(
      workspace,
      syntheticResult(),
      { toolName: "list_directory", rawArgs: { path: workspace } }
    )
  );
  assert.doesNotMatch(resultText(otherSessionResult), /Matching work fingerprint:|GOAL_NO_PROGRESS_BLOCKER|MUST_CONTINUE_TO_TOOL/, "one session's observation leaked into another session");
}

async function assertDistinctMcpWorkStaysRunning() {
  const workspace = path.join(tmpRoot, "distinct-work");
  await withServer(workspace, "productive-session", async (client) => {
    const created = await client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "Perform distinct bounded file work without confirmation",
        success_criteria: [{ name: "A criterion deliberately remains unconfirmed" }],
      },
    });
    data(created);

    let calls = 0;
    for (let index = 0; index < 11; index += 1) {
      const target = path.join(workspace, "artifact-" + index + ".txt");
      const written = await client.callTool({
        name: "write_file",
        arguments: { path: target, content: "unique-content-" + index, _intent: TEST_INTENT },
      });
      data(written);
      assert.doesNotMatch(resultText(written), /GOAL_NO_PROGRESS_BLOCKER|GOAL_NO_PROGRESS_PAUSE/, "distinct write was mistaken for a repeated stalled result");
      calls += 1;

      const inspected = await client.callTool({
        name: "file_info",
        arguments: { path: target, sha256: true },
      });
      data(inspected);
      assert.doesNotMatch(resultText(inspected), /GOAL_NO_PROGRESS_BLOCKER|GOAL_NO_PROGRESS_PAUSE/, "distinct read was mistaken for a repeated stalled result");
      calls += 1;
    }
    assert.ok(calls > 20, "the productive fixture must exercise more than 20 successful operations");

    const status = await client.callTool({ name: "goal", arguments: { action: "status" } });
    const statusData = data(status);
    assert.equal(statusData.goal.status, "active", "distinct work unexpectedly paused or completed the Goal");
    assert.equal(statusData.goal_run.state, "RUNNING", "distinct work unexpectedly stopped the GoalRun");
    assert.ok(
      statusData.goal_run.criteria.every((criterion) => criterion.confirmed === false),
      "the fixture confirmed a criterion without an explicit confirm action"
    );
  });
}

async function assertRepeatedMcpReadIsReportedAfterThirtyMinutes() {
  const workspace = path.join(tmpRoot, "repeated-work");
  await withServer(workspace, "repeated-session", async (client) => {
    const created = await client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "Bound a repeated empty-directory observation",
        success_criteria: [{ name: "An empty-directory criterion remains unmet" }],
      },
    });
    data(created);
    const realDateNow = Date.now;
    let clock = realDateNow();
    let lastObservation;
    try {
      Date.now = () => clock;
      for (let index = 0; index < 5; index += 1) {
        const result = await client.callTool({
          name: "list_directory",
          arguments: { path: workspace },
        });
        data(result);
        assert.doesNotMatch(resultText(result), /GOAL_NO_PROGRESS_BLOCKER|GOAL_CHECKPOINT_DUE|MUST_CONTINUE_TO_TOOL/, "observations must not impose a blocker or continuation requirement");
        if (index < 4) clock += 10 * 60_000;
        else lastObservation = result;
      }
    } finally {
      Date.now = realDateNow;
    }
    assert.ok(lastObservation, "repeated-result observation was not retained");
    const match = /Matching work fingerprint: repeats=(\d+), observation_window_ms=(\d+)/.exec(resultText(lastObservation));
    assert.ok(match, "the final result omitted the observed repeat count and window");
    assert.ok(Number(match[1]) >= 3 && Number(match[2]) >= GOAL_NO_PROGRESS_REPEAT_WINDOW_MS, "the observed count or window was incorrect");
    assert.match(resultText(lastObservation), /does not prove a stall/);
    const status = data(await client.callTool({name:"goal",arguments:{action:"status"}}));
    assert.equal(status.goal.status, "active", "repeat observations must not pause the Goal");
  });
}

try {
  await assertObservationSemantics();
  await assertSessionBrokerIsolation();
  await assertDistinctMcpWorkStaysRunning();
  await assertRepeatedMcpReadIsReportedAfterThirtyMinutes();
  console.log("goal-work-progress: stable fingerprints, failed/control handling, process poll volatility, session isolation, varied work, and timed repeat observations PASS");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    const envKey = key === "codexHome" ? "CODEX_HOME"
      : key === "auditLog" ? "AUDIT_LOG_PATH"
        : key === "watchdog" ? "GOAL_WATCHDOG_ENABLED" : "CHATGPT_TOOL_PROFILE";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
}
