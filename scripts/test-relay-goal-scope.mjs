import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web-harness-relay-goal-scope-"));
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace, { recursive: true });
process.env.CODEX_HOME = path.join(temp, "codex-home");
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.HARNESS_COMPANION_ENABLED = "true";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_TOKEN = "goal-scope-fixture-token-0123456789";
process.env.HARNESS_DRIVER_ORPHAN_GRACE_MS = "0";
const scope = await import("../dist/lib/relay-scope.js");
const driver = await import("../dist/lib/driver-lease.js");
const workers = await import("../dist/lib/worker-registry.js");
const manager = await import("../dist/lib/relay-manager.js");
const handoff = await import("../dist/lib/handoff-store.js");
const resumes = await import("../dist/lib/resume-bundle.js");
const A = "scope-goal-A", B = "scope-goal-B";
const within = (goal, fn, root = workspace) => scope.withRelayGoal(root, goal, fn);
const contract = "c".repeat(64);
const leaseInput = (goal, owner) => ({ goalId: goal, ownerSessionId: owner, executionContractHash: contract, intentRevision: 1 });
const rawLease = (goal, root = workspace) => fs.readFile(driver.driverLeasePath(root, goal), "utf8");
const rawWorkers = (goal, root = workspace) => fs.readFile(workers.workerRegistryPath(root, goal), "utf8");
const rawManager = (goal, root = workspace) => fs.readFile(manager.relayManagerPath(root, goal), "utf8");
const absent = async (file) => assert.rejects(fs.stat(file), { code: "ENOENT" });
async function waitUntil(check) {
  const deadline = Date.now() + 5000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, "bounded condition never became true");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
function heartbeat(worker, goal) {
  return {
    workerId: worker.worker_id, lane: worker.lane, generation: worker.generation,
    provisionId: worker.provision_id, companionInstanceId: "companion-fixture",
    tabInstanceId: "tab-" + goal, conversationUrl: "https://chatgpt.com/c/" + goal,
    adapterVersion: "scope-fixture", adapterConfidence: "high", conversationSurface: "CHAT",
    composerReady: true, generationActive: false, connectionInterrupted: false, activityRevision: 1,
  };
}

try {
  // Even a single possible Goal must not become an implicit authority fallback.
  await assert.rejects(driver.readDriverLease(workspace), /RELAY_GOAL_SCOPE_REQUIRED/);
  await assert.rejects(manager.readRelayManagerState(workspace), /RELAY_GOAL_SCOPE_REQUIRED/);
  assert.throws(() => within(A, () => within(B, () => {})), /SCOPE_MISMATCH/);
  within(A, () => {
    assert.throws(() => scope.withRelayGoalTransition(workspace, B, B, () => {}), /SCOPE_MISMATCH/);
    scope.withRelayGoalTransition(workspace, A, B, () => assert.equal(scope.currentRelayGoal(workspace), B));
    assert.equal(scope.currentRelayGoal(workspace), A);
  });
  const [leaseA, leaseB] = await Promise.all([
    driver.ensureDriverLease(workspace, leaseInput(A, "owner-a")),
    driver.ensureDriverLease(workspace, leaseInput(B, "owner-b")),
  ]);
  assert.notEqual(driver.driverLeasePath(workspace, A), driver.driverLeasePath(workspace, B));
  assert.deepEqual((await scope.listRelayGoalIds(workspace)).sort(), [A, B]);
  const beforeB = await rawLease(B);

  // A's lock and draining count cannot serialize or fence B.
  const releaseA = await driver.enterDriverMutationExecution(workspace, leaseA);
  const prepare = driver.prepareDriverHandoff(workspace, {
    goalId: A, sourceSessionId: "owner-a", executionContractHash: contract, intentRevision: 1,
    snapshot: { goal_revision: 7, current_phase: "VERIFY", next_action: "continue A", do_not_repeat: ["effect-a"] },
  });
  await waitUntil(async () => (await driver.readDriverLease(workspace, A)).state === "DRAINING");
  await assert.rejects(driver.enterDriverMutationExecution(workspace, leaseA), /DRIVER_NOT_ACTIVE/);
  const releaseB = await driver.enterDriverMutationExecution(workspace, leaseB);
  assert.equal(within(B, () => driver.activeDriverMutationCount(workspace, leaseB.lease_id)), 1);
  assert.equal(await rawLease(B), beforeB, "A draining rewrote B's lease");
  releaseB(); releaseA();
  const prepared = await prepare;
  const bundle = await resumes.createResumeBundle(workspace, prepared.snapshot, {
    runId: A, revision: 7, criteria: [{ id: "verified", confirmed: true }],
  });
  assert.equal(bundle.goal_id, A);
  assert.equal(await within(B, () => handoff.readHandoffSnapshot(workspace, prepared.snapshot.handoff_id)), null);
  assert.equal(await scope.resolveRelayGoalForTransition(workspace, prepared.snapshot.handoff_id), A);
  const committed = await Promise.all([
    driver.commitDriverHandoff(workspace, prepared.snapshot.handoff_id, "successor-a"),
    driver.commitDriverHandoff(workspace, prepared.snapshot.handoff_id, "successor-a"),
  ]);
  assert.equal(committed[0].epoch, 2);
  assert.equal(committed[0].lease_id, committed[1].lease_id, "lost ACK minted another lease");
  assert.equal(committed[0].authority_transition.transition_id, prepared.snapshot.handoff_id);
  await assert.rejects(driver.commitDriverHandoff(workspace, prepared.snapshot.handoff_id, "wrong-target"), /TARGET_MISMATCH/);
  await assert.rejects(driver.enterDriverMutationExecution(workspace, leaseA), /DRIVER_LEASE_LOST/);
  assert.equal(await rawLease(B), beforeB, "A handoff changed B");
  const bStillRuns = await driver.enterDriverMutationExecution(workspace, leaseB); bStillRuns();

  // Identical lane/generation names are independent identities.
  const [wa, wb] = await Promise.all([
    workers.requestWorkerProvision(workspace, { lane: "A", goalId: A, reason: "scope-test" }),
    workers.requestWorkerProvision(workspace, { lane: "A", goalId: B, reason: "scope-test" }),
  ]);
  assert.equal(wa.worker.worker_id, "A:g1");
  assert.equal(wb.worker.worker_id, "A:g1");
  assert.equal(wa.worker.goal_id, A); assert.equal(wb.worker.goal_id, B);
  const [readyA, readyB] = await Promise.all([
    within(A, () => workers.recordWorkerBrowserHeartbeat(workspace, heartbeat(wa.worker, A))),
    within(B, () => workers.recordWorkerBrowserHeartbeat(workspace, heartbeat(wb.worker, B))),
  ]);
  const bWorkerBytes = await rawWorkers(B);
  await assert.rejects(within(B, () => workers.recordWorkerBrowserHeartbeat(workspace, heartbeat(wa.worker, A))), /WORKER_IDENTITY_MISMATCH/);
  assert.equal(await rawWorkers(B), bWorkerBytes, "foreign heartbeat changed B");
  const [bootstrapA, bootstrapB] = await Promise.all([
    manager.enqueueWorkerBootstrapCommand(workspace, { worker: readyA.worker, registryRevision: readyA.registry.revision, goalId: A }),
    manager.enqueueWorkerBootstrapCommand(workspace, { worker: readyB.worker, registryRevision: readyB.registry.revision, goalId: B }),
  ]);
  const bManagerBytes = await rawManager(B);
  const deliveryA = await within(A, () => manager.claimRelayCommand(workspace, "A", "tab-" + A, "A:g1"));
  assert.equal(deliveryA.goal_id, A);
  assert.ok(deliveryA.message.includes("handoff_id=" + bootstrapA.command_id), "bootstrap omitted exact command identity");
  assert.equal(await rawManager(B), bManagerBytes, "A claim consumed B's command");
  assert.equal(await scope.resolveRelayGoalForTransition(workspace, bootstrapA.command_id), A);
  assert.equal(await scope.resolveRelayGoalForTransition(workspace, bootstrapB.command_id), B);
  assert.equal(await within(A, () => scope.resolveRelayGoalForTransition(workspace, bootstrapB.command_id)), B,
    "identity discovery must not accidentally enter another Goal's authority scope");
  await assert.rejects(within(B, () => manager.acknowledgeRelayCommand(workspace, bootstrapA.command_id, "tab-" + A, "sent")), /NOT_FOUND/);

  // Same nonce/provision/token bytes do not make a ticket valid in another Goal.
  const ticketA = await within(A, () => workers.mintWorkerClaimTicket(workspace, {
    workerId: "A:g1", handoffId: bootstrapA.command_id, kind: "PROBE",
  }));
  const ra = await workers.readWorkerRegistry(workspace, A);
  const rb = await workers.readWorkerRegistry(workspace, B);
  const forged = { ...rb, workers: { ...rb.workers, "A:g1": { ...ra.workers["A:g1"], goal_id: B } } };
  await fs.writeFile(workers.workerRegistryPath(workspace, B), JSON.stringify(forged, null, 2) + "\n");
  await assert.rejects(within(B, () => workers.verifyWorkerClaimTicket(workspace, {
    workerId: "A:g1", handoffId: bootstrapA.command_id, kind: "PROBE", token: ticketA.token, targetSessionId: "bootstrap-b",
  })), /TOKEN_MISMATCH/);
  await fs.writeFile(workers.workerRegistryPath(workspace, B), bWorkerBytes);

  // Orphan recovery uses the exact predecessor receipt for lost ACK retries.
  const oldB = { ...leaseB, expires_at: new Date(Date.now() - 60000).toISOString() };
  await fs.writeFile(driver.driverLeasePath(workspace, B), JSON.stringify(oldB, null, 2) + "\n");
  await driver.prepareDriverOrphanRecovery(workspace, {
    goalId: B, sourceSessionId: "owner-b", targetSessionId: "successor-b", explicitTakeoverAuthorized: true,
    observation: { lane_observed: true, lane_fresh: false, generation_active: false, tool_inflight_count: 0 },
  });
  const recovery = { goalId: B, sourceSessionId: "owner-b", targetSessionId: "successor-b",
    sourceEpoch: leaseB.epoch, sourceLeaseId: leaseB.lease_id, executionContractHash: contract, intentRevision: 1 };
  const recovered = await driver.commitDriverOrphanRecovery(workspace, recovery);
  const replay = await driver.commitDriverOrphanRecovery(workspace, recovery);
  assert.equal(recovered.lease_id, replay.lease_id);
  assert.equal(recovered.epoch, 2);
  await assert.rejects(driver.commitDriverOrphanRecovery(workspace, { ...recovery, sourceLeaseId: "wrong-predecessor" }), /CONFLICT/);
  await assert.rejects(driver.enterDriverMutationExecution(workspace, leaseB), /DRIVER_LEASE_LOST/);

  // Matching legacy migration preserves fencing and snapshot hashes, under an
  // idempotent migration lock; pure status reads never publish scoped files.
  const legacyWorkspace = path.join(temp, "legacy-workspace");
  await fs.mkdir(legacyWorkspace);
  const legacyRoot = scope.legacyRelayRoot(legacyWorkspace);
  await fs.mkdir(path.join(legacyRoot, "handoffs"), { recursive: true });
  const legacyLease = { ...leaseA, epoch: 11 };
  const legacyRaw = JSON.stringify(legacyLease, null, 2) + "\n";
  await fs.writeFile(path.join(legacyRoot, "driver-lease.json"), legacyRaw);
  const oldRegistry = { ...await workers.readWorkerRegistry(workspace, A) };
  delete oldRegistry.goal_id;
  await fs.writeFile(path.join(legacyRoot, "workers.json"), JSON.stringify(oldRegistry, null, 2) + "\n");
  const snapshotRaw = await fs.readFile(handoff.handoffSnapshotPath(workspace, prepared.snapshot.handoff_id, A), "utf8");
  await fs.writeFile(path.join(legacyRoot, "handoffs", prepared.snapshot.handoff_id + ".json"), snapshotRaw);
  const legacyEvents = JSON.stringify({ event_id: "old-event", worker_id: "A:g1" }) + "\n";
  await fs.writeFile(path.join(legacyRoot, "transitions.ndjson"), legacyEvents);
  assert.equal((await driver.readDriverLease(legacyWorkspace, A)).epoch, 11);
  await absent(scope.relayGoalPath(legacyWorkspace, "scope.json", A));
  await Promise.all([
    within(A, () => scope.ensureRelayGoalStorage(legacyWorkspace), legacyWorkspace),
    within(A, () => scope.ensureRelayGoalStorage(legacyWorkspace), legacyWorkspace),
  ]);
  assert.equal(await rawLease(A, legacyWorkspace), legacyRaw);
  assert.equal(await fs.readFile(handoff.handoffSnapshotPath(legacyWorkspace, prepared.snapshot.handoff_id, A), "utf8"), snapshotRaw);
  assert.equal(await fs.readFile(scope.relayGoalPath(legacyWorkspace, "legacy-transitions.ndjson", A), "utf8"), legacyEvents);
  const marker = await fs.readFile(scope.relayGoalPath(legacyWorkspace, "scope.json", A), "utf8");
  await within(A, () => scope.ensureRelayGoalStorage(legacyWorkspace), legacyWorkspace);
  assert.equal(await fs.readFile(scope.relayGoalPath(legacyWorkspace, "scope.json", A), "utf8"), marker);
  assert.equal(await fs.readFile(path.join(legacyRoot, "driver-lease.json"), "utf8"), legacyRaw, "migration modified legacy source");
  assert.equal(await driver.readDriverLease(legacyWorkspace, B), null);
  await driver.ensureDriverLease(legacyWorkspace, leaseInput(B, "independent-b"));
  assert.equal((await driver.readDriverLease(legacyWorkspace, A)).epoch, 11);

  const uncertainWorkspace = path.join(temp, "uncertain-workspace");
  await fs.mkdir(uncertainWorkspace);
  const uncertainRoot = scope.legacyRelayRoot(uncertainWorkspace);
  await fs.mkdir(uncertainRoot, { recursive: true });
  await fs.writeFile(path.join(uncertainRoot, "driver-lease.json"), legacyRaw);
  const unknownRegistry = { ...oldRegistry, workers: { "A:g1": { ...oldRegistry.workers["A:g1"], goal_id: null } } };
  const unknownBytes = JSON.stringify(unknownRegistry, null, 2) + "\n";
  await fs.writeFile(path.join(uncertainRoot, "workers.json"), unknownBytes);
  await assert.rejects(driver.readDriverLease(uncertainWorkspace, A), /LEGACY_GOAL_UNKNOWN/);
  await assert.rejects(within(A, () => scope.ensureRelayGoalStorage(uncertainWorkspace), uncertainWorkspace), /LEGACY_GOAL_UNKNOWN/);
  await absent(scope.relayGoalPath(uncertainWorkspace, "scope.json", A));
  assert.equal(await fs.readFile(path.join(uncertainRoot, "workers.json"), "utf8"), unknownBytes);

  // Superseding A fences its queued work while B remains byte-for-byte intact.
  const liveB = await Promise.all([rawLease(B), rawWorkers(B), rawManager(B)]);
  await manager.fenceSupersededRelayGoal(workspace, A);
  assert.equal((await driver.readDriverLease(workspace, A)).state, "RELEASED");
  await assert.rejects(driver.enterDriverMutationExecution(workspace, leaseA), /DRIVER_LEASE_LOST/);
  await assert.rejects(driver.ensureDriverLease(workspace, leaseInput(A, "successor-a")), /DRIVER_LEASE_RELEASED/);
  const fencedManager = await manager.readRelayManagerState(workspace, A);
  const fencedWorkers = await workers.readWorkerRegistry(workspace, A);
  assert.ok(fencedManager.fenced_at);
  assert.ok(fencedWorkers.fenced_at);
  assert.equal(fencedWorkers.workers["A:g1"].state, "RETIRED");
  assert.equal(fencedManager.commands.find(command => command.command_id === bootstrapA.command_id).state, "AMBIGUOUS");
  assert.equal(await within(A, () => manager.claimRelayCommand(workspace, "A", "tab-" + A, "A:g1")), null);
  await assert.rejects(workers.requestWorkerProvision(workspace, { goalId: A, lane: "B", reason: "operator_replace" }), /WORKER_GOAL_FENCED/);
  assert.deepEqual(await Promise.all([rawLease(B), rawWorkers(B), rawManager(B)]), liveB);
  const fencedBytes = await Promise.all([rawLease(A), rawWorkers(A), rawManager(A)]);
  await manager.fenceSupersededRelayGoal(workspace, A);
  assert.deepEqual(await Promise.all([rawLease(A), rawWorkers(A), rawManager(A)]), fencedBytes, "supersede retry changed state");

  // Discovery also fails closed if a damaged fixture repeats a command ID in B.
  const originalBManager = await manager.readRelayManagerState(workspace, B);
  await fs.writeFile(manager.relayManagerPath(workspace, B), JSON.stringify({
    ...originalBManager, commands: [...originalBManager.commands, { ...bootstrapA, goal_id: B }],
  }, null, 2) + "\n");
  await assert.rejects(scope.resolveRelayGoalForTransition(workspace, bootstrapA.command_id), /AMBIGUOUS/);
  console.log("PASS relay Goal scope: independent leases, drain, handoff, workers, bootstrap, tickets, orphan retry and legacy migration");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
