import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-run-web");
const workspace = path.join(tmpRoot, "workspace");
const readyWorkspace = path.join(tmpRoot, "ready-workspace");
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(readyWorkspace, { recursive: true });

const { createGoal, writeGoalRunProjection } = await import("../dist/lib/goals.js");
const { advanceGoalRun } = await import("../dist/lib/goal-run-state.js");
const { readGoalRun, replaceGoalRun } = await import("../dist/lib/goal-run-store.js");
const {
  appendGoalRunEvidenceToResult,
  classifyGoalRunToolEvidence,
  recordGoalRunToolFailure,
  synchronizeCommittedLegacyGoal,
  confirmGoalRunCriterion,
  transitionGoalRunLifecycle,
} = await import("../dist/lib/goal-run-web.js");

function context(tool, invocationId) {
  return {
    definition: { name: tool, source: "native" },
    scope: { invocationId },
    rawArgs: {},
    callbackArgs: [],
  };
}

function result(tool, data, ok = true, summary = `${tool}: done`) {
  const payload = { ok, tool, summary, data };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

try {
  const launch = classifyGoalRunToolEvidence(
    context("start_process", "launch-1"),
    result("start_process", { process_id: "p1", running: true })
  );
  assert.equal(launch.kind, "launch_ack");
  assert.equal(launch.verifiesCriterion, false);

  const pending = classifyGoalRunToolEvidence(
    context("process_output", "pending-1"),
    result("process_output", { running: true, exit_code: null })
  );
  assert.equal(pending.kind, "launch_ack");
  assert.equal(pending.verifiesCriterion, false);

  const nestedPending = classifyGoalRunToolEvidence(
    context("process_status", "pending-nested-1"),
    result("process_status", { processes: [{ running: true, exit_code: null }] })
  );
  assert.equal(nestedPending.kind, "launch_ack");
  assert.equal(nestedPending.verifiesCriterion, false);

  const nestedCompleted = classifyGoalRunToolEvidence(
    context("process_status", "completed-nested-1"),
    result("process_status", { processes: [{ running: false, exit_code: 0 }] })
  );
  assert.equal(nestedCompleted.kind, "runtime");
  assert.equal(nestedCompleted.verifiesCriterion, true);

  const completed = classifyGoalRunToolEvidence(
    context("process_output", "completed-1"),
    result("process_output", { running: false, exit_code: 0 })
  );
  assert.equal(completed.kind, "runtime");
  assert.equal(completed.verifiesCriterion, true);

  const failed = classifyGoalRunToolEvidence(
    context("run_command", "failed-1"),
    result("run_command", { exit_code: 1 }, false, "tests failed")
  );
  assert.equal(failed.kind, "runtime");
  assert.equal(failed.verifiesCriterion, false);

  const redacted = classifyGoalRunToolEvidence(
    context("run_command", "secret-1"),
    result("run_command", { exit_code: 1 }, false, "Authorization: Bearer sk-test-secret-value")
  );
  assert.equal(redacted.verifiesCriterion, false);
  assert.equal(redacted.summary.includes("sk-test-secret-value"), false);
  assert.equal(redacted.summary.includes("[redacted]"), true);

  const labeledSecret = classifyGoalRunToolEvidence(
    context("run_command", "labeled-secret-1"),
    result("run_command", { exit_code: 1 }, false, "api_key=super-secret-value")
  );
  assert.equal(labeledSecret.summary.includes("super-secret-value"), false);
  assert.equal(labeledSecret.summary.includes("api_key=[redacted]"), true);

  const deterministic = classifyGoalRunToolEvidence(
    context("read_text_file", "read-1"),
    result("read_text_file", { path: "x.txt" })
  );
  assert.equal(deterministic.kind, "deterministic");
  assert.equal(deterministic.verifiesCriterion, true);

  const visualFail = classifyGoalRunToolEvidence(
    context("visual_review", "visual-1"),
    result("visual_review", { action: "assess", model_visual_assessment: { verdict: "fail" } })
  );
  assert.equal(visualFail.kind, "model_assessed");
  assert.equal(visualFail.verifiesCriterion, false);

  const visualWithoutVerdict = classifyGoalRunToolEvidence(
    context("visual_review", "visual-no-verdict-1"),
    result("visual_review", { action: "assess", model_visual_assessment: { notes: "looks reasonable" } })
  );
  assert.equal(visualWithoutVerdict.verifiesCriterion, false);

  const visualSemanticPassQualityFailed = classifyGoalRunToolEvidence(
    context("visual_review", "visual-quality-failed-1"),
    result("visual_review", {
      action: "assess",
      model_visual_assessment: { verdict: "pass" },
      model_visual_quality_status: "failed",
      model_visual_iteration_ready: false,
    })
  );
  assert.equal(visualSemanticPassQualityFailed.kind, "model_assessed");
  assert.equal(visualSemanticPassQualityFailed.verifiesCriterion, false);

  const visualSemanticPassStillImprovable = classifyGoalRunToolEvidence(
    context("visual_review", "visual-improvable-1"),
    result("visual_review", {
      action: "assess",
      model_visual_assessment: { verdict: "pass" },
      model_visual_quality_status: "improvable",
      model_visual_iteration_ready: false,
    })
  );
  assert.equal(visualSemanticPassStillImprovable.verifiesCriterion, false);

  const visualServerQualityReady = classifyGoalRunToolEvidence(
    context("visual_review", "visual-ready-1"),
    result("visual_review", {
      action: "assess",
      model_visual_assessment: { verdict: "pass" },
      model_visual_quality_status: "ready",
      model_visual_iteration_ready: true,
      model_visual_ready: true,
      machine_ready: true,
      render_status: "clean",
      fresh: true,
      model_visual_quality_gate: { status: "acceptable" },
      model_visual_coverage: { complete: true },
    })
  );
  assert.equal(visualServerQualityReady.kind, "model_assessed");
  assert.equal(visualServerQualityReady.verifiesCriterion, true);

  const visualReadyButStale = classifyGoalRunToolEvidence(
    context("visual_review", "visual-stale-1"),
    result("visual_review", {
      action: "assess",
      model_visual_assessment: { verdict: "pass" },
      model_visual_quality_status: "ready",
      model_visual_iteration_ready: true,
      model_visual_ready: true,
      machine_ready: true,
      render_status: "clean",
      fresh: false,
      model_visual_quality_gate: { status: "acceptable" },
      model_visual_coverage: { complete: true },
    })
  );
  assert.equal(visualReadyButStale.verifiesCriterion, false, "stale visual evidence must not verify a Goal criterion");

  const visualReadyButBlocked = classifyGoalRunToolEvidence(
    context("visual_review", "visual-blocked-1"),
    result("visual_review", {
      action: "assess",
      model_visual_assessment: { verdict: "pass" },
      model_visual_quality_status: "ready",
      model_visual_iteration_ready: true,
      model_visual_ready: false,
      machine_ready: false,
      render_status: "blocked",
      fresh: true,
      model_visual_quality_gate: { status: "acceptable" },
      model_visual_coverage: { complete: true },
    })
  );
  assert.equal(visualReadyButBlocked.verifiesCriterion, false, "machine-blocked visual evidence must not verify a Goal criterion");

  const visualReadyButPartial = classifyGoalRunToolEvidence(
    context("visual_review", "visual-partial-1"),
    result("visual_review", {
      action: "assess",
      model_visual_assessment: { verdict: "pass" },
      model_visual_quality_status: "ready",
      model_visual_iteration_ready: true,
      model_visual_ready: false,
      machine_ready: true,
      render_status: "clean",
      fresh: true,
      model_visual_quality_gate: { status: "acceptable" },
      model_visual_coverage: { complete: false },
    })
  );
  assert.equal(visualReadyButPartial.verifiesCriterion, false, "partial visual coverage must not verify a Goal criterion");

  const stopAck = classifyGoalRunToolEvidence(
    context("stop_process", "stop-1"),
    result("stop_process", { stopped: true, process_id: "p1" })
  );
  assert.equal(stopAck.verifiesCriterion, false);

  const summaryOnly = classifyGoalRunToolEvidence(
    context("run_command", "summary-only-1"),
    result("run_command", undefined, true, "success")
  );
  assert.equal(summaryOnly.verifiesCriterion, false);

  assert.equal(
    classifyGoalRunToolEvidence(context("goal", "goal-1"), result("goal", {})),
    null
  );

  await createGoal(workspace, {
    objective: "Classify Web tool evidence",
    success_criteria: [{ name: "tool result is verified", passed: false }],
  });

  // Projection writes must retain unknown compatibility fields supplied by
  // an older/newer reader instead of silently erasing them.
  const initialGoal = JSON.parse(
    await fs.readFile(
      path.join(
        process.env.CODEX_HOME,
        "projects",
        createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12),
        "goal.json",
      ),
      "utf-8",
    ),
  );
  const compatibilityField = { source: "future-reader", values: ["keep", 7, true] };
  await writeGoalRunProjection(
    workspace,
    {
      ...initialGoal,
      revision: initialGoal.revision + 1,
      current_phase: "compatibility-preservation",
      unknown_compatibility: compatibilityField,
    },
    { expectedCurrentRevision: initialGoal.revision, operation: "test:compatibility-preservation" },
  );
  const projectedRaw = JSON.parse(
    await fs.readFile(
      path.join(
        process.env.CODEX_HOME,
        "projects",
        createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12),
        "goal.json",
      ),
      "utf-8",
    ),
  );
  assert.deepEqual(projectedRaw.unknown_compatibility, compatibilityField);
  // This fixture intentionally performs a legacy-first projection mutation.
  // Its explicit reconciliation must precede observation; the observer must
  // not silently accept a divergent shadow now created by createGoal itself.
  const beforeSync = await appendGoalRunEvidenceToResult(workspace, context("read_text_file", "diverged-before-sync"), result("read_text_file", { path: "fixture.txt" }));
  assert.equal(beforeSync.structuredContent.data.goal_run_evidence, undefined);
  assert.equal((await readGoalRun(workspace)).run.typedEvidence.length, 0, "ordinary observation accepted an unreconciled shadow");
  await synchronizeCommittedLegacyGoal(workspace, projectedRaw);

  const launchContext = context("start_process", "persist-launch");
  const launchResult = await appendGoalRunEvidenceToResult(
    workspace,
    launchContext,
    result("start_process", { process_id: "p2", running: true })
  );
  assert.match(launchResult.content.at(-1).text, /launch_ack only/);
  assert.equal(
    launchResult.structuredContent.data.goal_run_evidence.verifies_criterion,
    false
  );

  const runAfterLaunch = await readGoalRun(workspace);
  assert.equal(runAfterLaunch.shadow, false);
  assert.equal(runAfterLaunch.parity.mismatch, null);
  assert.equal(runAfterLaunch.run.typedEvidence.length, 1);
  assert.equal(runAfterLaunch.run.typedEvidence[0].kind, "launch_ack");
  assert.deepEqual(runAfterLaunch.legacy.unknown_compatibility, compatibilityField);

  const completedContext = context("run_command", "persist-complete");
  const completedResult = await appendGoalRunEvidenceToResult(
    workspace,
    completedContext,
    result("run_command", { command: "npm test", exit_code: 0 }, true, "tests passed")
  );
  assert.match(completedResult.content.at(-1).text, /verification_candidate=true/);

  const runAfterComplete = await readGoalRun(workspace);
  assert.equal(runAfterComplete.run.typedEvidence.length, 2);
  assert.equal(runAfterComplete.run.typedEvidence[1].kind, "runtime");
  assert.equal(runAfterComplete.run.typedEvidence[1].metadata.verifiesCriterion, true);

  await Promise.all([
    appendGoalRunEvidenceToResult(
      workspace,
      context("read_text_file", "parallel-1"),
      result("read_text_file", { path: "one.txt" })
    ),
    appendGoalRunEvidenceToResult(
      workspace,
      context("read_text_file", "parallel-2"),
      result("read_text_file", { path: "two.txt" })
    ),
  ]);
  const afterParallel = await readGoalRun(workspace);
  assert.equal(afterParallel.run.typedEvidence.length, 4);
  assert.ok(afterParallel.run.typedEvidence.some((item) => item.id === "tool-parallel-1"));
  assert.ok(afterParallel.run.typedEvidence.some((item) => item.id === "tool-parallel-2"));

  await recordGoalRunToolFailure(
    workspace,
    context("run_command", "persist-thrown"),
    new Error("handler exploded")
  );
  const afterFailure = await readGoalRun(workspace);
  assert.equal(afterFailure.run.typedEvidence.length, 5);
  assert.equal(afterFailure.run.typedEvidence[4].metadata.ok, false);
  assert.equal(afterFailure.run.typedEvidence[4].metadata.verifiesCriterion, false);

  // A durable READY_TO_FINALIZE run must be completable after a retry. This
  // is the recovery path after a crash between request_finalize and complete.
  const recoveryFile = path.join(readyWorkspace, "recovery-evidence.txt");
  await fs.mkdir(readyWorkspace, { recursive: true });
  await fs.writeFile(recoveryFile, "verified recovery fixture");
  const { verificationFileHash } = await import("../dist/lib/goal-verification.js");
  await createGoal(readyWorkspace, {
    objective: "Complete a recovered GoalRun",
    success_criteria: [{ name: "verification command passed", passed: false, verification: { kind: "file_exists", target: recoveryFile } }],
  });
  await appendGoalRunEvidenceToResult(
    readyWorkspace,
    context("file_info", "ready-evidence"),
    result("file_info", { path: recoveryFile, sha256: await verificationFileHash(recoveryFile) }, true, "recovery fixture exists"),
  );
  await confirmGoalRunCriterion(readyWorkspace, { criterion: "verification command passed", evidenceIds: ["tool-ready-evidence"] });
  const beforeFinalize = await readGoalRun(readyWorkspace);
  assert.ok(beforeFinalize);
  const finalized = advanceGoalRun(
    beforeFinalize.run,
    { type: "request_finalize" },
    { expectedRevision: beforeFinalize.run.revision, now: new Date(Date.now() + 1_000).toISOString() },
  );
  await replaceGoalRun(
    readyWorkspace,
    { ...beforeFinalize, run: finalized.run },
    { expectedRevision: beforeFinalize.run.revision },
  );
  assert.equal((await readGoalRun(readyWorkspace)).run.state, "READY_TO_FINALIZE");
  const recoveredCompletion = await transitionGoalRunLifecycle(readyWorkspace, "complete");
  assert.equal(recoveredCompletion.goal.status, "completed");
  assert.equal((await readGoalRun(readyWorkspace)).run.state, "COMPLETED");

  console.log("goal-run-web: launch, completion, failure, visual, projection, and shadow persistence OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
}
