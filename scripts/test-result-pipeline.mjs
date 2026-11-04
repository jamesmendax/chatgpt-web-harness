import assert from "node:assert/strict";

import { WebHarnessResultPipeline } from "../dist/lib/result-pipeline.js";

const context = {
  definition: { name: "fixture_tool" },
  scope: {},
  rawArgs: { value: 7 },
  callbackArgs: [],
};

function toolResult(text) {
  return { content: [{ type: "text", text }] };
}

function unusedOperations() {
  return {
    recordToolObservation() {},
    recordGoalStallTelemetry() {},
    appendGoalRunEvidenceToResult(_context, result) {
      return result;
    },
    appendHarnessRuntimeContextToResult(_context, result) {
      return result;
    },
    appendRepeatGuardReminderToResult(_context, result) {
      return result;
    },
    recordRepeatGuardFailure() {},
    recordGoalRunToolFailure() {},
  };
}

{
  const events = [];
  const original = toolResult("original");
  const withContext = toolResult("with-context");
  const withEvidence = toolResult("with-evidence");
  const final = toolResult("final");
  const pipeline = new WebHarnessResultPipeline({
    ...unusedOperations(),
    recordToolObservation(actualContext, result, error) {
      events.push("observation");
      assert.equal(actualContext, context);
      assert.equal(result, original);
      assert.equal(error, undefined);
    },
    recordGoalStallTelemetry() {
      events.push("stall");
    },
    appendGoalRunEvidenceToResult(actualContext, result) {
      events.push("goal-run-evidence");
      assert.equal(actualContext, context);
      assert.equal(result, original);
      return withEvidence;
    },
    appendHarnessRuntimeContextToResult(actualContext, result) {
      events.push("context");
      assert.equal(actualContext, context);
      assert.equal(result, withEvidence);
      return withContext;
    },
    appendRepeatGuardReminderToResult(actualContext, result) {
      events.push("repeat-reminder");
      assert.equal(actualContext, context);
      assert.equal(result, withContext);
      return final;
    },
  });

  assert.equal(await pipeline.processSuccess(context, original), final);
  assert.deepEqual(events, [
    "observation",
    "stall",
    "goal-run-evidence",
    "context",
    "repeat-reminder",
  ]);
}

{
  const events = [];
  const final = toolResult("suppressed");
  const pipeline = new WebHarnessResultPipeline({
    ...unusedOperations(),
    recordToolObservation() {
      events.push("observation");
      throw new Error("observation failed");
    },
    async recordGoalStallTelemetry() {
      events.push("stall");
      throw new Error("stall failed");
    },
    appendGoalRunEvidenceToResult(_context, result) {
      events.push("goal-run-evidence");
      return result;
    },
    appendHarnessRuntimeContextToResult(_context, result) {
      events.push("context");
      return result;
    },
    appendRepeatGuardReminderToResult() {
      events.push("repeat-reminder");
      return final;
    },
  });

  assert.equal(await pipeline.processSuccess(context, toolResult("base")), final);
  assert.deepEqual(events, [
    "observation",
    "stall",
    "goal-run-evidence",
    "context",
    "repeat-reminder",
  ]);
}

{
  const transformError = new Error("context transform failed");
  const events = [];
  const pipeline = new WebHarnessResultPipeline({
    ...unusedOperations(),
    appendHarnessRuntimeContextToResult() {
      events.push("context");
      throw transformError;
    },
    appendRepeatGuardReminderToResult(_context, result) {
      events.push("repeat-reminder");
      return result;
    },
  });

  const degraded = await pipeline.processSuccess(context, toolResult("base"));
  assert.equal(degraded.isError, undefined);
  assert.deepEqual(degraded.content, toolResult("base").content);
  assert.equal(degraded._meta["harness/postprocessing_warnings"][0].stage, "runtime_context");
  assert.deepEqual(events, ["context", "repeat-reminder"]);
}

{
  const reminderError = new Error("repeat reminder failed");
  const pipeline = new WebHarnessResultPipeline({
    ...unusedOperations(),
    appendRepeatGuardReminderToResult() {
      throw reminderError;
    },
  });

  const degraded = await pipeline.processSuccess(context, toolResult("base"));
  assert.equal(degraded.isError, undefined);
  assert.deepEqual(degraded.content, toolResult("base").content);
  assert.equal(degraded._meta["harness/postprocessing_warnings"][0].stage, "repeat_reminder");
}

{
  const evidenceError = new Error("required evidence persistence failed");
  const pipeline = new WebHarnessResultPipeline({ ...unusedOperations(),
    appendGoalRunEvidenceToResult() { throw evidenceError; } });
  await assert.rejects(pipeline.processSuccess(context, toolResult("effect already returned")), error => error === evidenceError);
}

{
  const handlerError = new Error("handler failed");
  const events = [];
  const pipeline = new WebHarnessResultPipeline({
    ...unusedOperations(),
    async recordToolObservation(actualContext, result, error) {
      events.push("observation");
      assert.equal(actualContext, context);
      assert.equal(result, undefined);
      assert.equal(error, handlerError);
      throw new Error("failure observation failed");
    },
    recordGoalRunToolFailure(actualContext, error) {
      events.push("goal-run-failure");
      assert.equal(actualContext, context);
      assert.equal(error, handlerError);
      throw new Error("failure mirror failed");
    },
    recordRepeatGuardFailure(actualContext) {
      events.push("repeat-failure");
      assert.equal(actualContext, context);
    },
  });

  await pipeline.processFailure(context, handlerError);
  assert.deepEqual(events, ["observation", "goal-run-failure", "repeat-failure"]);
}

{
  const repeatError = new Error("repeat failure failed");
  const pipeline = new WebHarnessResultPipeline({
    ...unusedOperations(),
    recordRepeatGuardFailure() {
      throw repeatError;
    },
  });

  await assert.rejects(
    pipeline.processFailure(context, new Error("handler failed")),
    (error) => error === repeatError
  );
}

console.log(
  "result-pipeline: ordering, chaining, suppression, and failure behavior passed"
);
