import assert from "node:assert/strict";

import {
  GOAL_RUN_MAX_WAIT_MS,
  GoalRunStateError,
  advanceGoalRun,
  createGoalRun,
} from "../dist/lib/goal-run-state.js";

const T0 = "2026-08-31T00:00:00.000Z";
const T1 = "2026-08-31T00:00:01.000Z";
const T2 = "2026-08-31T00:00:02.000Z";
const T3 = "2026-08-31T00:00:03.000Z";
const T4 = "2026-08-31T00:00:04.000Z";
const T5 = "2026-08-31T00:00:05.000Z";

function newRun(criteria = [{ id: "build", description: "Build succeeds" }], extra = {}) {
  return createGoalRun({
    runId: "run-001",
    objective: "Implement and verify the GoalRun state machine",
    criteria,
    currentPhase: "implementation",
    nextAction: "Run focused checks",
    resumeCursor: "cursor-7",
    now: T0,
    ...extra,
  });
}

function advance(run, event, now, expectedRevision = run.revision) {
  return advanceGoalRun(run, event, { expectedRevision, now }).run;
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GoalRunStateError);
    assert.equal(error.code, code);
    return true;
  });
}

// Creation is deterministic, complete in shape, and deeply immutable.
{
  const first = newRun();
  const second = newRun();
  assert.deepEqual(first, second);
  assert.equal(first.revision, 1);
  assert.equal(first.state, "RUNNING");
  assert.equal(first.waitCondition, null);
  assert.equal(first.stopReason, null);
  assert.equal(first.timestamps.createdAt, T0);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.criteria));
  assert.ok(Object.isFrozen(first.criteria[0]));
  assert.ok(Object.isFrozen(first.typedEvidence));
}

// Tool, external-process, and user waits accept only their matching result.
{
  const original = newRun();
  const before = JSON.stringify(original);
  const toolWaitResult = advanceGoalRun(original, {
    type: "wait_tool",
    waitId: "tool-1",
    toolName: "run_command",
    description: "Wait for focused test",
    timeoutMs: 5_000,
  }, { expectedRevision: 1, now: T1 });
  const toolWait = toolWaitResult.run;
  assert.equal(JSON.stringify(original), before, "advance must not mutate its input");
  assert.equal(toolWait.state, "WAITING_TOOL");
  assert.equal(toolWait.waitCondition.kind, "TOOL");
  assert.equal(toolWaitResult.effects[0].type, "WAIT_REGISTERED");
  assert.ok(Object.isFrozen(toolWaitResult.effects));
  assert.ok(Object.isFrozen(toolWaitResult.effects[0]));
  assert.ok(Object.isFrozen(toolWaitResult.effects[0].condition));
  assert.ok(Object.isFrozen(toolWaitResult.effects[0].condition.recovery));
  expectCode(
    () => advanceGoalRun(toolWait, { type: "phase_update", currentPhase: "illegal" }, { now: T2 }),
    "ILLEGAL_TRANSITION"
  );
  expectCode(
    () => advanceGoalRun(toolWait, { type: "tool_result", waitId: "wrong", outcome: "succeeded" }, { now: T2 }),
    "WAIT_MISMATCH"
  );
  let run = advance(toolWait, { type: "tool_result", waitId: "tool-1", outcome: "succeeded" }, T2);
  assert.equal(run.state, "RUNNING");
  assert.equal(run.waitCondition, null);

  run = advance(run, {
    type: "wait_external",
    waitId: "process-1",
    processRef: "build-42",
    description: "Wait for external build",
    timeoutMs: 2_000,
    pollIntervalMs: 250,
  }, T3);
  assert.equal(run.state, "WAITING_EXTERNAL_PROCESS");
  run = advance(run, { type: "external_satisfied", waitId: "process-1" }, T4);
  assert.equal(run.state, "RUNNING");

  run = advance(run, {
    type: "wait_user",
    waitId: "user-1",
    requestKey: "approval",
    description: "Wait for explicit approval",
    timeoutMs: 10_000,
  }, T4);
  assert.equal(run.state, "WAITING_USER");
  run = advance(run, { type: "user_response", waitId: "user-1", summary: "approved" }, T5);
  assert.equal(run.state, "RUNNING");
}

// Wait bounds and polling constraints reject unbounded or incoherent waits.
{
  const run = newRun();
  expectCode(
    () => advanceGoalRun(run, {
      type: "wait_external",
      waitId: "too-long",
      processRef: "p",
      description: "unbounded",
      timeoutMs: GOAL_RUN_MAX_WAIT_MS + 1,
      pollIntervalMs: 100,
    }, { now: T1 }),
    "INVALID_INPUT"
  );
  expectCode(
    () => advanceGoalRun(run, {
      type: "wait_external",
      waitId: "bad-poll",
      processRef: "p",
      description: "bad poll",
      timeoutMs: 500,
      pollIntervalMs: 1_000,
    }, { now: T1 }),
    "INVALID_INPUT"
  );
  expectCode(
    () => advanceGoalRun(run, {
      type: "wait_tool",
      waitId: "bad-recovery",
      toolName: "run_command",
      description: "incomplete recovery",
      timeoutMs: 500,
      recovery: { attempt: 1 },
    }, { now: T1 }),
    "INVALID_INPUT"
  );
}

// launch_ack is trace evidence, never criterion-verifying evidence by itself.
{
  let run = newRun();
  run = advance(run, {
    type: "record_evidence",
    evidence: { id: "launch-1", kind: "launch_ack", summary: "Tool launch accepted" },
  }, T1);
  expectCode(
    () => advanceGoalRun(run, {
      type: "confirm_criterion",
      criterionId: "build",
      evidenceIds: ["launch-1"],
    }, { now: T2 }),
    "UNVERIFIED_EVIDENCE"
  );
  assert.equal(run.criteria[0].confirmed, false);
}

// A typed non-launch result that explicitly failed verification is also not
// criterion evidence (for example, a failed test command or visual verdict).
{
  let run = newRun();
  run = advance(run, {
    type: "record_evidence",
    evidence: {
      id: "runtime-failed",
      kind: "runtime",
      summary: "npm test exited 1",
      metadata: { exitCode: 1, verifiesCriterion: false },
    },
  }, T1);
  expectCode(
    () => advanceGoalRun(run, {
      type: "confirm_criterion",
      criterionId: "build",
      evidenceIds: ["runtime-failed"],
    }, { now: T2 }),
    "UNVERIFIED_EVIDENCE"
  );
}

// Verified evidence confirms criteria; repeated IDs are idempotent, conflicts are not.
{
  let run = newRun();
  const evidenceEvent = {
    type: "record_evidence",
    evidence: {
      id: "runtime-1",
      kind: "runtime",
      summary: "npm run build exited 0",
      source: "npm run build",
      metadata: { exitCode: 0, verified: true },
    },
  };
  run = advance(run, evidenceEvent, T1);
  const duplicate = advanceGoalRun(run, evidenceEvent, { expectedRevision: run.revision, now: T2 });
  assert.equal(duplicate.transition.changed, false);
  assert.equal(duplicate.run.revision, run.revision);
  assert.equal(duplicate.run.typedEvidence.length, 1);
  assert.equal(duplicate.effects[0].type, "NOOP");
  expectCode(
    () => advanceGoalRun(run, {
      type: "record_evidence",
      evidence: { id: "runtime-1", kind: "runtime", summary: "different payload" },
    }, { now: T2 }),
    "EVIDENCE_ID_CONFLICT"
  );
  run = advance(run, {
    type: "confirm_criterion",
    criterionId: "build",
    evidenceIds: ["runtime-1"],
  }, T2);
  assert.equal(run.criteria[0].confirmed, true);
  assert.deepEqual(run.criteria[0].evidenceIds, ["runtime-1"]);
}

// External wait timeout carries deterministic deadline and explicit recovery metadata.
{
  let run = newRun();
  run = advance(run, {
    type: "wait_external",
    waitId: "external-1",
    processRef: "job-9",
    description: "Wait for job",
    timeoutMs: 1_000,
    pollIntervalMs: 100,
  }, T1);
  assert.equal(run.waitCondition.deadlineAt, T2);
  expectCode(
    () => advanceGoalRun(run, { type: "wait_timeout", waitId: "external-1" }, {
      expectedRevision: run.revision,
      now: "2026-08-31T00:00:01.999Z",
    }),
    "WAIT_NOT_EXPIRED"
  );
  run = advance(run, { type: "wait_timeout", waitId: "external-1" }, T2);
  assert.equal(run.state, "INTERRUPTED");
  assert.equal(run.stopReason.kind, "WAIT_TIMEOUT");
  assert.equal(run.stopReason.terminal, false);
  assert.equal(run.waitCondition.status, "TIMED_OUT");
  assert.equal(run.waitCondition.recovery.timedOutAt, T2);
  run = advance(run, { type: "resume", nextAction: "Retry external wait" }, T3);
  assert.equal(run.state, "RUNNING");
  assert.equal(run.waitCondition, null);
  run = advance(run, {
    type: "wait_external",
    waitId: "external-2",
    processRef: "job-9-retry",
    description: "Retry job wait",
    timeoutMs: 1_000,
    pollIntervalMs: 100,
    recovery: { attempt: 1, previousWaitId: "external-1", strategy: "bounded retry" },
  }, T4);
  assert.equal(run.waitCondition.recovery.attempt, 1);
  assert.equal(run.waitCondition.recovery.previousWaitId, "external-1");
  assert.equal(run.waitCondition.recovery.strategy, "bounded retry");
}

// Interruption and resume preserve identity and cursor; CAS protects every mutation.
{
  let run = newRun();
  expectCode(
    () => advanceGoalRun(run, { type: "phase_update", currentPhase: "verification" }, {
      expectedRevision: 99,
      now: T1,
    }),
    "CAS_CONFLICT"
  );
  run = advance(run, {
    type: "phase_update",
    currentPhase: "verification",
    resumeCursor: "cursor-verify",
  }, T1);
  const runId = run.runId;
  const cursor = run.resumeCursor;
  run = advance(run, {
    type: "interrupt",
    code: "transport_reset",
    message: "MCP transport reset",
  }, T2);
  assert.equal(run.state, "INTERRUPTED");
  run = advance(run, { type: "resume" }, T3);
  assert.equal(run.state, "RUNNING");
  assert.equal(run.runId, runId);
  assert.equal(run.resumeCursor, cursor);
}

// Finalization is a distinct gate and completion requires every criterion.
{
  let run = newRun([
    { id: "build", description: "Build succeeds" },
    { id: "test", description: "Focused test succeeds" },
  ]);
  expectCode(
    () => advanceGoalRun(run, { type: "request_finalize" }, { now: T1 }),
    "CRITERIA_UNMET"
  );
  run = advance(run, {
    type: "record_evidence",
    evidence: { id: "build-e", kind: "deterministic", summary: "Build passed" },
  }, T1);
  run = advance(run, { type: "confirm_criterion", criterionId: "build", evidenceIds: ["build-e"] }, T2);
  expectCode(
    () => advanceGoalRun(run, { type: "request_finalize" }, { now: T3 }),
    "CRITERIA_UNMET"
  );
  run = advance(run, {
    type: "record_evidence",
    evidence: { id: "test-e", kind: "model_assessed", summary: "Focused state transitions inspected" },
  }, T3);
  run = advance(run, { type: "confirm_criterion", criterionId: "test", evidenceIds: ["test-e"] }, T4);
  run = advance(run, { type: "request_finalize" }, T4);
  assert.equal(run.state, "READY_TO_FINALIZE");
  run = advance(run, { type: "complete" }, T5);
  assert.equal(run.state, "COMPLETED");
  assert.equal(run.timestamps.completedAt, T5);
  assert.equal(run.nextAction, null);
  expectCode(
    () => advanceGoalRun(run, { type: "phase_update", currentPhase: "too late" }, { now: T5 }),
    "TERMINAL_RUN"
  );
}

// Pause is resumable; cancellation uses the same approved state with a terminal typed reason.
{
  let controlPlane = newRun();
  controlPlane = advance(controlPlane, {
    type: "control_plane_wait",
    message: "Both browser lanes are unavailable",
    currentPhase: "Waiting for browser/MCP control plane",
  }, T1);
  assert.equal(controlPlane.state, "WAITING_CONTROL_PLANE");
  assert.equal(controlPlane.stopReason, null, "control-plane loss is a recoverable wait, not an interruption");
  assert.equal(controlPlane.lease, null, "control-plane wait must not invent or discard unrelated GoalRun state");
  controlPlane = advance(controlPlane, { type: "control_plane_ready" }, T2);
  assert.equal(controlPlane.state, "RUNNING");

  let paused = newRun();
  paused = advance(paused, {
    type: "pause",
    code: "operator_pause",
    message: "Operator requested a pause",
  }, T1);
  assert.equal(paused.state, "INTERRUPTED");
  assert.equal(paused.stopReason.kind, "PAUSE");
  assert.equal(paused.stopReason.terminal, false);
  paused = advance(paused, { type: "resume" }, T2);
  assert.equal(paused.state, "RUNNING");

  let noProgress = newRun();
  noProgress = advance(noProgress, {
    type: "pause",
    pauseKind: "no_progress",
    code: "goal_no_progress",
    message: "Exact repeats persisted for thirty minutes",
  }, T1);
  assert.equal(noProgress.state, "NO_PROGRESS_PAUSED");
  assert.equal(noProgress.stopReason.kind, "PAUSE");
  assert.equal(noProgress.stopReason.code, "goal_no_progress");
  noProgress = advance(noProgress, { type: "resume" }, T2);
  assert.equal(noProgress.state, "RUNNING");

  let cancelled = newRun();
  cancelled = advance(cancelled, {
    type: "cancel",
    code: "operator_cancel",
    message: "Operator cancelled the run",
  }, T1);
  assert.equal(cancelled.state, "INTERRUPTED");
  assert.equal(cancelled.stopReason.kind, "CANCEL");
  assert.equal(cancelled.stopReason.terminal, true);
  assert.equal(cancelled.nextAction, null);
  expectCode(
    () => advanceGoalRun(cancelled, { type: "resume" }, { now: T2 }),
    "TERMINAL_RUN"
  );
  expectCode(
    () => advanceGoalRun(cancelled, {
      type: "record_evidence",
      evidence: { id: "late", kind: "runtime", summary: "too late" },
    }, { now: T2 }),
    "TERMINAL_RUN"
  );
}

console.log("goal-run-state: deterministic creation, legal transitions, evidence gates, bounded waits, control-plane recovery, CAS, finalization, pause, and terminal cancel OK");
