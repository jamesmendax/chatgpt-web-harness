import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-run-store");
const codexHome = path.join(tmpRoot, "codex-home");
const workspace = path.join(tmpRoot, "workspace");
const casWorkspace = path.join(tmpRoot, "cas-workspace");
const futureWorkspace = path.join(tmpRoot, "future-workspace");
const semanticWorkspace = path.join(tmpRoot, "semantic-workspace");
const legacyProjectionPath = path.join(tmpRoot, "legacy-projection.json");
const previousCodexHome = process.env.CODEX_HOME;

process.env.CODEX_HOME = codexHome;

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(casWorkspace, { recursive: true });
await fs.mkdir(futureWorkspace, { recursive: true });
await fs.mkdir(semanticWorkspace, { recursive: true });

const {
  advanceGoalRun,
  createGoalRun: createStateGoalRun,
} = await import("../dist/lib/goal-run-state.js");
const {
  GoalRunStoreError,
  GOAL_RUN_REQUIRED_PARITY_MATCHES,
  checkProjectionParity,
  clearProjectionRepairPending,
  createGoalRun,
  goalRunPath,
  importLegacyGoal,
  markProjectionRepairPending,
  openGoalRun,
  openGoalRunStore,
  projectGoalRunToLegacy,
  promoteShadow,
  readGoalRun,
  recordGoalRunProjection,
  replaceGoalRun,
  replaceGoalRunEnvelopeMetadata,
} = await import("../dist/lib/goal-run-store.js");

const T0 = "2026-08-31T00:00:00.000Z";
const T1 = "2026-08-31T00:00:01.000Z";
const T2 = "2026-08-31T00:00:02.000Z";
const T3 = "2026-08-31T00:00:03.000Z";

function newRun(runId, now = T0) {
  return createStateGoalRun({
    runId,
    objective: "Persist and verify a GoalRun",
    criteria: [{ id: "build", description: "Build succeeds" }],
    currentPhase: "implementation",
    nextAction: "Run focused checks",
    resumeCursor: "cursor-1",
    now,
  });
}

function advance(run, event, now) {
  return advanceGoalRun(run, event, { expectedRevision: run.revision, now }).run;
}

function isStoreError(error, code) {
  return error instanceof GoalRunStoreError && error.code === code;
}

function legacyGoal(status, overrides = {}) {
  const completed = status === "completed";
  return {
    version: 1,
    id: `legacy-${status}`,
    revision: 7,
    objective: `Legacy ${status} goal`,
    success_criteria: [
      {
        name: "Build succeeds",
        passed: completed,
        detail: "Build evidence kept verbatim",
        requires_confirmation: true,
      },
      {
        name: "Session survives",
        passed: completed,
        detail: "Session detail kept verbatim",
      },
    ],
    constraints: ["Keep compatibility fields"],
    status,
    current_phase: "legacy-phase",
    owner_session: "session-legacy-42",
    created_at: T0,
    updated_at: T1,
    ...(completed ? { completed_at: T2 } : {}),
    session: { id: "session-legacy-42", note: "unknown session field" },
    evidence_details: { build: { command: "npm run build", exitCode: 0 } },
    unknown_field: { nested: ["preserve", 42, true] },
    ...overrides,
  };
}

try {
  // Legacy status imports are deterministic and do not mutate the fixture.
  const legacyStatusExpectations = {
    active: { state: "RUNNING", stopKind: null, terminal: null, confirmed: false },
    paused: { state: "INTERRUPTED", stopKind: "PAUSE", terminal: false, confirmed: false },
    completed: { state: "COMPLETED", stopKind: null, terminal: null, confirmed: true },
    cancelled: { state: "INTERRUPTED", stopKind: "CANCEL", terminal: true, confirmed: false },
  };
  for (const [status, expectation] of Object.entries(legacyStatusExpectations)) {
    const legacy = legacyGoal(status);
    const fixtureBytes = Buffer.from(`${JSON.stringify(legacy, null, 2)}\n`, "utf-8");
    await fs.writeFile(legacyProjectionPath, fixtureBytes);
    const fixture = JSON.parse(await fs.readFile(legacyProjectionPath, "utf-8"));
    const imported = importLegacyGoal(fixture);
    const repeatedImport = importLegacyGoal(fixture);

    assert.deepEqual(repeatedImport, imported, `${status} import must be deterministic`);
    assert.equal(imported.legacy?.status, status);
    assert.equal(imported.shadow, true);
    assert.equal(imported.run.state, expectation.state);
    assert.equal(imported.run.criteria.every((criterion) => criterion.confirmed), expectation.confirmed);
    assert.equal(imported.run.typedEvidence.length, expectation.confirmed ? 2 : 0);
    if (expectation.stopKind === null) {
      assert.equal(imported.run.stopReason, null);
    } else {
      assert.equal(imported.run.stopReason?.kind, expectation.stopKind);
      assert.equal(imported.run.stopReason?.terminal, expectation.terminal);
    }
    assert.deepEqual(await fs.readFile(legacyProjectionPath), fixtureBytes);
  }

  // The legacy projection roundtrips byte-for-byte through the current APIs.
  const promotionLegacy = legacyGoal("active");
  const promotionFixtureBytes = Buffer.from(`${JSON.stringify(promotionLegacy, null, 2)}\n`, "utf-8");
  await fs.writeFile(legacyProjectionPath, promotionFixtureBytes);
  const promotionFixture = JSON.parse(await fs.readFile(legacyProjectionPath, "utf-8"));
  const importedShadow = importLegacyGoal(promotionFixture);
  const projectedRoundtrip = projectGoalRunToLegacy(importedShadow, promotionFixture);
  assert.deepEqual(projectedRoundtrip, promotionFixture);
  assert.deepEqual(importLegacyGoal(projectedRoundtrip), importedShadow);

  const parityMatched = checkProjectionParity(importedShadow, promotionFixture);
  assert.equal(parityMatched.parity.kind, "projection");
  assert.equal(parityMatched.parity.matchedChecks, GOAL_RUN_REQUIRED_PARITY_MATCHES);
  assert.equal(parityMatched.parity.mismatch, null);

  // A projection mismatch blocks shadow promotion and records the difference.
  const mismatchedLegacy = { ...promotionFixture, objective: "Changed outside the goal-run authority" };
  const mismatched = checkProjectionParity(importedShadow, mismatchedLegacy);
  assert.ok(mismatched.parity.mismatch);
  assert.equal(mismatched.parity.matchedChecks, 0);
  assert.throws(
    () => promoteShadow(mismatched),
    (error) => isStoreError(error, "PROMOTION_BLOCKED")
  );

  // Repair is explicit: pending repair blocks promotion until parity is reverified and cleared.
  const repairPending = markProjectionRepairPending(parityMatched, "Legacy projection needs repair");
  assert.equal(repairPending.parity.repairPending, true);
  assert.equal(repairPending.parity.repairReason, "Legacy projection needs repair");
  assert.throws(
    () => promoteShadow(repairPending),
    (error) => isStoreError(error, "PROMOTION_BLOCKED")
  );
  const repairCleared = clearProjectionRepairPending(repairPending, promotionFixture);
  assert.equal(repairCleared.parity.repairPending, false);
  assert.equal(repairCleared.parity.repairReason, null);
  assert.equal(repairCleared.parity.mismatch, null);
  assert.equal(repairCleared.parity.matchedChecks, GOAL_RUN_REQUIRED_PARITY_MATCHES + 1);

  const promoted = promoteShadow(repairCleared, {
    expectedEnvelopeRevision: repairCleared.envelopeRevision,
    expectedRunRevision: repairCleared.run.revision,
  });
  assert.equal(promoted.shadow, false);
  assert.equal(promoted.authority, "goal-run");
  assert.equal(promoted.legacyProjectionRevision, promoted.run.revision);
  assert.equal(promoted.parity.repairPending, false);
  assert.equal(promoted.parity.mismatch, null);
  assert.deepEqual(await fs.readFile(legacyProjectionPath), promotionFixtureBytes);

  // Roundtrip keeps the complete typed evidence and active wait condition.
  const store = openGoalRunStore(workspace);

  const base = newRun("run-roundtrip");
  const withEvidence = advance(base, {
    type: "record_evidence",
    evidence: {
      id: "build-result",
      kind: "runtime",
      summary: "npm run build exited 0",
      source: "npm run build",
      metadata: { exitCode: 0, verified: true, note: "full evidence payload" },
    },
  }, T1);
  const waiting = advance(withEvidence, {
    type: "wait_external",
    waitId: "process-1",
    processRef: "build-42",
    description: "Wait for the external build process",
    timeoutMs: 5_000,
    pollIntervalMs: 250,
  }, T2);

  const created = await store.create(base);
  assert.deepEqual(Object.keys(created).sort(), [
    "authority",
    "legacyProjectionFingerprint",
    "legacyProjectionRevision",
    "parity",
    "run",
    "schemaVersion",
  ]);
  assert.equal(created.schemaVersion, 1);
  assert.equal(created.authority, "goal-run");
  assert.equal(created.legacyProjectionRevision, null);
  assert.equal(created.legacyProjectionFingerprint, null);
  assert.equal(created.parity, "unverified");

  const createdProjection = projectGoalRunToLegacy(created);
  const projectionRecorded = recordGoalRunProjection(created, createdProjection);
  const metadataPersisted = await replaceGoalRunEnvelopeMetadata(workspace, projectionRecorded, {
    expectedEnvelopeRevision: created.envelopeRevision ?? 1,
    expectedRunRevision: created.run.revision,
  });
  assert.deepEqual(metadataPersisted.run, created.run);
  assert.equal(metadataPersisted.envelopeRevision, (created.envelopeRevision ?? 1) + 1);
  assert.equal(metadataPersisted.parity.mismatch, null);

  await store.replace(withEvidence);
  await store.replace(waiting);
  const roundtrip = await store.read();
  assert.ok(roundtrip);
  assert.deepEqual(roundtrip.run, waiting);
  assert.deepEqual(roundtrip.run.typedEvidence[0], waiting.typedEvidence[0]);
  assert.deepEqual(roundtrip.run.waitCondition, waiting.waitCondition);

  const firstReadBytes = await fs.readFile(goalRunPath(workspace));
  const firstRead = await readGoalRun(workspace);
  const secondRead = await openGoalRun(workspace);
  assert.deepEqual(secondRead, firstRead);
  assert.deepEqual(await store.open(), firstRead);
  assert.deepEqual(await fs.readFile(goalRunPath(workspace)), firstReadBytes);

  // Two revisions derived from the same snapshot race; exactly one CAS wins.
  const casStore = openGoalRunStore(casWorkspace);
  const casBase = newRun("run-cas");
  await casStore.create(casBase);
  const [leftSnapshot, rightSnapshot] = await Promise.all([casStore.read(), casStore.read()]);
  assert.ok(leftSnapshot && rightSnapshot);
  const left = advance(leftSnapshot.run, { type: "phase_update", currentPhase: "left-winner" }, T1);
  const right = advance(rightSnapshot.run, { type: "phase_update", currentPhase: "right-winner" }, T2);
  const raced = await Promise.allSettled([replaceGoalRun(casWorkspace, left), replaceGoalRun(casWorkspace, right)]);
  assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(raced.filter((result) => result.status === "rejected").length, 1);
  const rejectedRace = raced.find((result) => result.status === "rejected");
  assert.ok(rejectedRace && isStoreError(rejectedRace.reason, "CAS_CONFLICT"));
  const casAfterRace = await casStore.read();
  assert.ok(casAfterRace);
  assert.equal(casAfterRace.run.revision, 2);
  await assert.rejects(
    () => replaceGoalRun(casWorkspace, left),
    (error) => isStoreError(error, "CAS_CONFLICT")
  );

  // A future envelope is refused before replacement, so its bytes stay intact.
  const futureStore = openGoalRunStore(futureWorkspace);
  const futureBase = newRun("run-future");
  await futureStore.create(futureBase);
  const futurePath = goalRunPath(futureWorkspace);
  const futureEnvelope = JSON.parse(await fs.readFile(futurePath, "utf-8"));
  futureEnvelope.schemaVersion = 2;
  futureEnvelope.futureField = "must remain";
  await fs.writeFile(futurePath, JSON.stringify(futureEnvelope, null, 2) + "\n", "utf-8");
  const futureBytes = await fs.readFile(futurePath);
  const futureCandidate = advance(futureBase, { type: "phase_update", currentPhase: "must-not-write" }, T3);
  await assert.rejects(() => readGoalRun(futureWorkspace), (error) => isStoreError(error, "FUTURE_VERSION"));
  await assert.rejects(
    () => replaceGoalRun(futureWorkspace, futureCandidate),
    (error) => isStoreError(error, "FUTURE_VERSION")
  );
  assert.deepEqual(await fs.readFile(futurePath), futureBytes);

  // Shape-valid but semantically impossible persisted runs are rejected on read.
  const semanticStore = openGoalRunStore(semanticWorkspace);
  await semanticStore.create(newRun("run-semantic"));
  const semanticPath = goalRunPath(semanticWorkspace);
  const semanticEnvelope = JSON.parse(await fs.readFile(semanticPath, "utf-8"));
  semanticEnvelope.run.state = "COMPLETED";
  semanticEnvelope.run.timestamps.completedAt = T3;
  await fs.writeFile(semanticPath, JSON.stringify(semanticEnvelope, null, 2) + "\n", "utf-8");
  await assert.rejects(
    () => readGoalRun(semanticWorkspace),
    (error) => isStoreError(error, "INVALID_INPUT") && /semantic validation/i.test(error.message)
  );

  console.log("goal-run-store: legacy status imports, deterministic projection parity, repair gating, promotion, envelope roundtrip, serialized CAS, and future-version refusal OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
}
