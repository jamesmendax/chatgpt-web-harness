import assert from "node:assert/strict";

import {
  advanceGoalRun,
  createGoalRun,
} from "../dist/lib/goal-run-state.js";
import {
  GOAL_RUN_POLICY_MAX_BYTES,
  renderGoalRunPolicy,
  renderGoalRunPolicyText,
} from "../dist/lib/goal-run-policy.js";

const T0 = "2026-08-31T00:00:00.000Z";
const T1 = "2026-08-31T00:00:01.000Z";
const T2 = "2026-08-31T00:00:02.000Z";
const T3 = "2026-08-31T00:00:03.000Z";
const T4 = "2026-08-31T00:00:04.000Z";

function newRun(extra = {}) {
  return createGoalRun({
    runId: "run-policy-001",
    objective: "Render a generic GoalRun policy",
    criteria: [
      { id: "build", description: "Build succeeds" },
      { id: "focused-test", description: "Focused test succeeds" },
    ],
    currentPhase: "implementation",
    nextAction: "Continue with focused tools",
    resumeCursor: "cursor-policy-7",
    now: T0,
    ...extra,
  });
}

function advance(run, event, now) {
  return advanceGoalRun(run, event, { expectedRevision: run.revision, now }).run;
}

function assertBudget(result, max = result.maxBytes) {
  assert.ok(result.bytes <= max, `text exceeded byte budget: ${result.bytes} > ${max}`);
  assert.equal(result.bytes, Buffer.byteLength(result.text, "utf8"));
  assert.equal(result.byteLength, result.bytes);
  assert.equal(result.byteBudget.used, result.bytes);
  assert.equal(result.byteBudget.max, result.maxBytes);
}

function assertBase(result, stateText) {
  assert.ok(result.text.includes(stateText));
  assert.ok(result.text.includes("launch_ack never verifies"));
  assert.ok(result.text.includes("no automatic host wakeup"));
  assertBudget(result);
}

{
  const running = renderGoalRunPolicy(newRun());
  assertBase(running, "state: RUNNING");
  assert.ok(running.text.includes("continue with tools while RUNNING"));
  assert.ok(running.text.includes("user-visible assistant text"));
  assert.ok(running.text.includes("before 300s"));
  assert.ok(running.text.includes("tool cards"));
  assert.equal(renderGoalRunPolicyText(newRun()), running.text);
  assert.equal(running.truncated, false);
}

{
  let run = newRun();
  run = advance(run, {
    type: "wait_tool",
    waitId: "tool-1",
    toolName: "run_command",
    description: "Wait for the focused test",
    timeoutMs: 5_000,
  }, T1);
  const tool = renderGoalRunPolicy(run);
  assertBase(tool, "state: WAITING_TOOL");
  assert.ok(tool.text.includes("resume only when tool run_command returns"));
  assert.ok(tool.text.includes("user-visible assistant text"));

  run = advance(run, { type: "tool_result", waitId: "tool-1", outcome: "succeeded" }, T2);
  run = advance(run, {
    type: "wait_external",
    waitId: "process-1",
    processRef: "build-42",
    description: "Wait for external build",
    timeoutMs: 2_000,
    pollIntervalMs: 250,
  }, T3);
  const external = renderGoalRunPolicy(run);
  assertBase(external, "state: WAITING_EXTERNAL_PROCESS");
  assert.ok(external.text.includes("resume only when external process build-42 is satisfied"));
  assert.ok(external.text.includes("user-visible assistant text"));

  run = advance(run, { type: "external_satisfied", waitId: "process-1" }, T4);
  run = advance(run, {
    type: "wait_user",
    waitId: "user-1",
    requestKey: "approval",
    description: "Wait for approval",
    timeoutMs: 2_000,
  }, T4);
  const user = renderGoalRunPolicy(run);
  assertBase(user, "state: WAITING_USER");
  assert.ok(user.text.includes("resume only after a user response for request approval"));
  assert.ok(!user.text.includes("user-visible assistant text"));
}

{
  let run = newRun();
  run = advance(run, {
    type: "pause",
    code: "operator_pause",
    message: "Pause for inspection",
  }, T1);
  const interrupted = renderGoalRunPolicy(run);
  assertBase(interrupted, "state: INTERRUPTED");
  assert.ok(interrupted.text.includes("resume from cursor cursor-policy-7"));

  run = newRun();
  run = advance(run, {
    type: "pause",
    pauseKind: "no_progress",
    code: "goal_no_progress",
    message: "Exact repeats persisted for thirty minutes",
  }, T1);
  const noProgress = renderGoalRunPolicy(run);
  assertBase(noProgress, "state: NO_PROGRESS_PAUSED");
  assert.ok(noProgress.text.includes("changed recovery condition"));

  run = newRun();
  run = advance(run, {
    type: "record_evidence",
    evidence: { id: "build-e", kind: "deterministic", summary: "Build passed" },
  }, T1);
  run = advance(run, { type: "confirm_criterion", criterionId: "build", evidenceIds: ["build-e"] }, T2);
  run = advance(run, {
    type: "record_evidence",
    evidence: { id: "test-e", kind: "runtime", summary: "Focused test passed" },
  }, T3);
  run = advance(run, { type: "confirm_criterion", criterionId: "focused-test", evidenceIds: ["test-e"] }, T4);
  run = advance(run, { type: "request_finalize" }, T4);
  const ready = renderGoalRunPolicy(run);
  assertBase(ready, "state: READY_TO_FINALIZE");
  assert.ok(ready.text.includes("requires verified criteria"));

  run = advance(run, { type: "complete" }, T4);
  const completed = renderGoalRunPolicy(run);
  assertBase(completed, "state: COMPLETED");
  assert.ok(completed.text.includes("COMPLETED: no continuation"));
}

{
  const policies = [
    {
      name: "build",
      requiredEvidenceKinds: ["deterministic", "runtime", "runtime"],
      notes: "Evidence must be reproducible",
    },
    {
      name: "build",
      requiredEvidenceKinds: ["model_assessed"],
      notes: "This duplicate is ignored",
    },
    {
      name: "release",
      requiredEvidenceKinds: ["launch_ack"],
      notes: "A launch acknowledgement is trace only",
    },
  ];
  const result = renderGoalRunPolicy(newRun(), { policies });
  assert.equal(result.policyCount, 2);
  assert.equal(result.dedupedPolicyCount, 1);
  assert.equal(result.renderedPolicyCount, 2);
  assert.equal(result.omittedPolicyCount, 0);
  assert.equal(result.text.match(/policy build:/g)?.length, 1);
  assert.ok(result.text.includes("launch_ack(trace-only)"));
  assert.ok(result.text.includes("duplicate names removed"));
  assertBudget(result);
}

{
  const longRun = newRun({
    objective: "目标 ".repeat(2_000),
    currentPhase: "阶段 ".repeat(500),
    nextAction: "下一步 ".repeat(500),
    resumeCursor: "游标 ".repeat(500),
  });
  const result = renderGoalRunPolicy(longRun, {
    policies: Array.from({ length: 50 }, (_, index) => ({
      name: `policy-${index}-${"名".repeat(100)}`,
      requiredEvidenceKinds: ["deterministic", "runtime"],
      notes: "说明 ".repeat(500),
    })),
  });
  assert.equal(result.maxBytes, GOAL_RUN_POLICY_MAX_BYTES);
  assert.equal(result.truncated, true);
  assertBudget(result, GOAL_RUN_POLICY_MAX_BYTES);
  assert.ok(result.text.includes("state: RUNNING"));
  assert.ok(result.text.includes("no automatic host wakeup"));
}

{
  const capped = renderGoalRunPolicy(newRun(), {
    maxBytes: 360,
    policies: [{ name: "small", requiredEvidenceKinds: [], notes: "short" }],
  });
  assert.equal(capped.maxBytes, 360);
  assertBudget(capped, 360);
  assert.equal(capped.byteBudget.remaining, capped.maxBytes - capped.bytes);
}

console.log("goal-run-policy: all states, bounded UTF-8 output, policy dedupe, evidence safety, and wakeup wording OK");
