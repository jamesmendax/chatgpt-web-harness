import { createRelayFixtureScope } from "./relay-fixture-scope.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT)
  : path.join(repoRoot, "dist");
const importDist = (relativePath) => import(pathToFileURL(path.join(distRoot, relativePath)).href);
const testRoot = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(testRoot, "relay-orphan-recovery-"));

const envKeys = [
  "CODEX_HOME",
  "HARNESS_RELAY_ENABLED",
  "HARNESS_COMPANION_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED",
  "HARNESS_DRIVER_ORPHAN_GRACE_MS",
  "HARNESS_COMPANION_TOKEN",
  "GOAL_WATCHDOG_ENABLED",
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.HARNESS_COMPANION_ENABLED = "true";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_DRIVER_ORPHAN_GRACE_MS = "120000";
process.env.HARNESS_COMPANION_TOKEN = "test-only-orphan-recovery-claim-secret-0001";
process.env.GOAL_WATCHDOG_ENABLED = "false";

const { registerGoalTool } = await importDist("tools/goal.js");
const { EffectiveToolRegistry } = await importDist("lib/effective-tool-registry.js");
const { InvocationGateway } = await importDist("lib/invocation-gateway.js");
const { createRuntimeScope, runWithRuntimeScope } = await importDist("lib/runtime-scope.js");
const fixtureScopes = createRelayFixtureScope((await importDist("lib/relay-scope.js")).withRelayGoal);
const relay = fixtureScopes.wrap(await importDist("lib/relay-manager.js"));
const driver = fixtureScopes.wrap(await importDist("lib/driver-lease.js"));
const goals = await importDist("lib/goals.js");
const goalRunStore = await importDist("lib/goal-run-store.js");
const goalRunWeb = await importDist("lib/goal-run-web.js");
const contracts = fixtureScopes.wrap(await importDist("lib/execution-contract.js"));
const workers = fixtureScopes.wrap(await importDist("lib/worker-registry.js"));
const operations = await importDist("lib/operation-journal.js");

function requirementIntent(label) {
  return JSON.stringify({
    intent_revision: 1,
    objective: `Exercise orphan Driver recovery ${label}`,
    scope: ["temporary orphan recovery fixture"],
    out_of_scope: [],
    deliverables: ["orphan recovery assertions"],
    success_criteria: ["stale Driver is recovered without TTL-only authority transfer"],
    constraints: ["temporary fixture only"],
    protected_resources: [],
    known_facts: ["all state is isolated under temporary CODEX_HOME"],
    assumptions: [],
    delegated_decisions: [],
    remaining_nonblocking_uncertainties: [],
    closure_items: [],
    ambiguities: [],
    clarification_round: 0,
    questions_in_round: 0,
    resolution_mode: "none",
  });
}

function scopeFor(workspace, sessionId) {
  return createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId });
}

function requestExtra(sessionId, requestId) {
  return {
    sessionId,
    requestId,
    signal: new AbortController().signal,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  };
}

function makeHarness(workspace, intent) {
  let goalTool;
  registerGoalTool({
    registerTool(name, config, callback) {
      if (name === "goal") goalTool = { config, callback };
    },
  }, workspace);
  assert.ok(goalTool);
  const goalSchema = z.object(goalTool.config.inputSchema);
  const invokeGoal = (sessionId, args) => runWithRuntimeScope(
    scopeFor(workspace, sessionId),
    () => goalTool.callback(goalSchema.parse(args))
  );

  const registry = new EffectiveToolRegistry("full");
  const definition = registry.prepare(
    "write_file",
    { inputSchema: { path: z.string() }, annotations: { readOnlyHint: false } },
    async (args) => ({
      content: [{ type: "text", text: `written:${args.path}` }],
      structuredContent: { marker: args.path },
    })
  );
  assert.ok(definition);
  registry.register(definition);
  const gateway = new InvocationGateway(registry, { workspaceRoot: workspace, projectRoots: [workspace] });
  const write = (sessionId, requestId, file, admittedIntent = intent) => gateway.invoke(
    "write_file",
    [{ path: file, _intent: admittedIntent }, requestExtra(sessionId, requestId)]
  );
  return { invokeGoal, write };
}

async function heartbeat(workspace, lane, tab, url, overrides = {}) {
  return relay.recordRelayLaneHeartbeat(workspace, {
    lane,
    tab_instance_id: tab,
    conversation_url: url,
    adapter_version: "orphan-recovery-test-v1",
    adapter_confidence: "high",
    conversation_surface: "CHAT",
    composer_ready: true,
    generation_active: false,
    connection_interrupted: false,
    tool_inflight_count: 0,
    tool_activity_count: 0,
    activity_revision: 1,
    ...overrides,
  });
}

async function ageLeasePastExpiry(workspace, expiredAgoMs) {
  const file = driver.driverLeasePath(workspace);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const expiresMs = Date.now() - expiredAgoMs;
  state.renewed_at = new Date(expiresMs - 60_000).toISOString();
  state.expires_at = new Date(expiresMs).toISOString();
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function proveSuccessorCapability(workspace, lane, sessionId, label) {
  const registry = await workers.readWorkerRegistry(workspace);
  const worker = workers.workerForLane(registry, lane);
  assert.ok(worker, `expected ${lane} Worker before capability proof`);
  const handoffId = `bootstrap_${label}_${Date.now()}`;
  const ticket = await workers.mintWorkerClaimTicket(workspace, {
    workerId: worker.worker_id,
    handoffId,
    kind: "PROBE",
  });
  const consumed = await workers.consumeWorkerClaimTicket(workspace, {
    workerId: worker.worker_id,
    handoffId,
    token: ticket.token,
    targetSessionId: sessionId,
    kind: "PROBE",
  });
  assert.equal(workers.workerReadyForAuthority(consumed.worker), true, "successor must hold a fresh real-session capability proof");
  return consumed.worker;
}

function errorCode(result) {
  return result.structuredContent?.data?.error_code ?? result.structuredContent?.data?.error;
}

async function createSeededGoal(workspace, sessionId, invokeGoal, write, label) {
  const created = await invokeGoal(sessionId, {
    action: "create",
    objective: `Orphan recovery ${label}`,
    success_criteria: [{ name: "recovery works" }],
    constraints: ["temporary fixture only"],
    current_phase: "source Driver active",
  });
  assert.equal(created.structuredContent.ok, true, JSON.stringify(created.structuredContent));
  const goal = created.structuredContent.data.goal;
  fixtureScopes.set(workspace, goal.id);
  const firstWrite = await write(sessionId, 1, `${label}-seed`);
  assert.equal(firstWrite.structuredContent.marker, `${label}-seed`);
  const lease = await driver.readDriverLease(workspace);
  assert.equal(lease?.owner_session_id, sessionId);
  assert.equal(lease?.epoch, 1);
  assert.equal(lease?.state, "ACTIVE");
  return { goal, lease };
}

try {
  // Scenario 1: fresh explicit takeover. Expiry alone is never authority.
  const workspace1 = path.join(tempRoot, "workspace-fresh");
  await fs.mkdir(workspace1, { recursive: true });
  const A1 = "orphan-fresh-chat-a";
  const B1 = "orphan-fresh-chat-b";
  const intent1 = requirementIntent("fresh");
  const h1 = makeHarness(workspace1, intent1);
  const seeded1 = await createSeededGoal(workspace1, A1, h1.invokeGoal, h1.write, "fresh");
  await heartbeat(workspace1, "A", "fresh-tab-a", "https://chatgpt.com/c/orphan-fresh-a", {
    generation_active: true,
  });
  await heartbeat(workspace1, "B", "fresh-tab-b", "https://chatgpt.com/c/orphan-fresh-b");
  await proveSuccessorCapability(workspace1, "B", B1, "fresh");
  await heartbeat(workspace1, "A", "fresh-tab-a", "https://chatgpt.com/c/orphan-fresh-a", {
    generation_active: false,
    activity_revision: 2,
  });
  assert.equal((await relay.readRelayManagerState(workspace1)).active_lane, "A");

  const firstBind = await h1.invokeGoal(B1, { action: "bind", expected_revision: seeded1.goal.revision });
  assert.equal(firstBind.structuredContent.ok, false);
  assert.equal(firstBind.structuredContent.data.error, "GOAL_TAKEOVER_CONFIRMATION_REQUIRED");
  const takeoverToken = firstBind.structuredContent.data.takeover_token;
  assert.equal(typeof takeoverToken, "string");

  // Expired by only 60s while grace is 120s: still not recoverable.
  await ageLeasePastExpiry(workspace1, 60_000);
  const graceBlocked = await h1.invokeGoal(B1, {
    action: "bind",
    expected_revision: seeded1.goal.revision,
    takeover_token: takeoverToken,
  });
  assert.equal(graceBlocked.structuredContent.ok, false);
  assert.equal(errorCode(graceBlocked), "DRIVER_ORPHAN_RECOVERY_NOT_READY");
  assert.match(JSON.stringify(graceBlocked), /lease_expiry_grace_not_elapsed/);
  assert.equal((await goals.getWorkspaceGoalProjection(workspace1))?.owner_session, A1);
  assert.equal((await driver.readDriverLease(workspace1))?.owner_session_id, A1);

  // Past grace, but the browser still reports generation in progress.
  await ageLeasePastExpiry(workspace1, 180_000);
  await heartbeat(workspace1, "A", "fresh-tab-a", "https://chatgpt.com/c/orphan-fresh-a", {
    generation_active: true,
    activity_revision: 2,
  });
  const busyBlocked = await h1.invokeGoal(B1, {
    action: "bind",
    expected_revision: seeded1.goal.revision,
    takeover_token: takeoverToken,
  });
  assert.equal(busyBlocked.structuredContent.ok, false);
  assert.equal(errorCode(busyBlocked), "DRIVER_ORPHAN_RECOVERY_NOT_READY");
  assert.match(JSON.stringify(busyBlocked), /browser_generation_active/);
  assert.equal((await driver.readDriverLease(workspace1))?.state, "ACTIVE");

  // An idle fresh page does not prove its App binding still works. It is safe as
  // supporting evidence once expiry+grace and explicit takeover are satisfied.
  await heartbeat(workspace1, "A", "fresh-tab-a", "https://chatgpt.com/c/orphan-fresh-a", {
    generation_active: false,
    tool_inflight_count: 0,
    activity_revision: 3,
  });

  // TTL/grace alone still cannot transfer authority on a random mutation.
  const ttlOnlyMutation = await h1.write(B1, 2, "ttl-only-must-not-transfer");
  assert.equal(ttlOnlyMutation.structuredContent.ok, false);
  assert.equal(ttlOnlyMutation.structuredContent.data.error_code, "DRIVER_LEASE_LOST");
  assert.equal((await driver.readDriverLease(workspace1))?.owner_session_id, A1);

  // A durable operation receipt in RECEIVED/EXECUTING means an external side
  // effect may still be unresolved. Even with expiry+grace and a verified
  // successor, recovery must fail closed until that receipt settles.
  let releasePendingEffect;
  const pendingEffectGate = new Promise((resolve) => { releasePendingEffect = resolve; });
  const pendingEffect = operations.executeOperation({
    workspaceRoot: workspace1,
    identity: "orphan-recovery-pending-effect",
    tool: "write_file",
    args: { path: "pending-effect" },
  }, async () => {
    await pendingEffectGate;
    return { content: [{ type: "text", text: "settled" }], structuredContent: { settled: true } };
  });
  for (let i = 0; i < 40; i += 1) {
    const inspections = await operations.listOperationInspections(workspace1, 16);
    if (inspections.some((item) => item.state === "executing")) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const unresolvedBlocked = await h1.invokeGoal(B1, {
    action: "bind",
    expected_revision: seeded1.goal.revision,
    takeover_token: takeoverToken,
  });
  assert.equal(unresolvedBlocked.structuredContent.ok, false);
  assert.equal(errorCode(unresolvedBlocked), "DRIVER_ORPHAN_RECOVERY_NOT_READY");
  assert.match(JSON.stringify(unresolvedBlocked), /unresolved_operation_effects/);
  releasePendingEffect();
  await pendingEffect;

  const recovered = await h1.invokeGoal(B1, {
    action: "bind",
    expected_revision: seeded1.goal.revision,
    takeover_token: takeoverToken,
  });
  assert.equal(recovered.structuredContent.ok, true, JSON.stringify(recovered.structuredContent));
  assert.equal(recovered.structuredContent.data.orphan_recovery, true);
  assert.equal(recovered.structuredContent.data.orphan_recovery_from_already_bound_goal, false);
  const recoveredLease = recovered.structuredContent.data.driver_lease;
  assert.equal(recoveredLease.owner_session_id, B1);
  assert.equal(recoveredLease.epoch, 2);
  assert.equal(recoveredLease.state, "ACTIVE");
  assert.notEqual(recoveredLease.lease_id, seeded1.lease.lease_id);
  assert.equal((await goals.getWorkspaceGoalProjection(workspace1))?.owner_session, B1);

  const inheritedIntent1 = recovered.structuredContent.data.relay_intent_json;
  assert.equal(typeof inheritedIntent1, "string");
  assert.equal(JSON.parse(inheritedIntent1).objective, JSON.parse(intent1).objective);
  const staleA1 = await h1.write(A1, 3, "stale-a-after-orphan");
  assert.equal(staleA1.structuredContent.ok, false);
  assert.equal(staleA1.structuredContent.data.error_code, "DRIVER_LEASE_LOST");
  const liveB1 = await h1.write(B1, 4, "live-b-after-orphan", inheritedIntent1);
  assert.equal(liveB1.structuredContent.marker, "live-b-after-orphan");

  // Lost response/retry after commit is idempotent: no epoch+2 jump.
  const idempotent = await driver.commitDriverOrphanRecovery(workspace1, {
    goalId: seeded1.goal.id,
    sourceSessionId: A1,
    targetSessionId: B1,
    sourceEpoch: 1,
    sourceLeaseId: seeded1.lease.lease_id,
    executionContractHash: seeded1.lease.execution_contract_hash,
    intentRevision: seeded1.lease.intent_revision,
  });
  assert.equal(idempotent.epoch, 2);
  assert.equal(idempotent.lease_id, recoveredLease.lease_id);

  // Scenario 2: reproduce the actual 0.2.8 mismatch (Goal already moved to B,
  // Driver still points to dead A) and repair only Driver authority in place.
  const workspace2 = path.join(tempRoot, "workspace-preexisting-mismatch");
  await fs.mkdir(workspace2, { recursive: true });
  const A2 = "orphan-legacy-chat-a";
  const B2 = "orphan-legacy-chat-b";
  const intent2 = requirementIntent("preexisting-mismatch");
  const h2 = makeHarness(workspace2, intent2);
  const seeded2 = await createSeededGoal(workspace2, A2, h2.invokeGoal, h2.write, "legacy");
  await heartbeat(workspace2, "A", "legacy-tab-a", "https://chatgpt.com/c/orphan-legacy-a", {
    generation_active: true,
  });
  await heartbeat(workspace2, "B", "legacy-tab-b", "https://chatgpt.com/c/orphan-legacy-b");
  await proveSuccessorCapability(workspace2, "B", B2, "legacy");
  await heartbeat(workspace2, "A", "legacy-tab-a", "https://chatgpt.com/c/orphan-legacy-a", {
    generation_active: false,
    activity_revision: 2,
  });
  await ageLeasePastExpiry(workspace2, 180_000);

  // Emulate the old ordinary bind's durable truth migration, deliberately
  // leaving Driver Lease untouched at A epoch 1.
  await contracts.inheritAcceptedExecutionContractState(
    workspace2,
    A2,
    B2,
    seeded2.lease.execution_contract_hash,
    seeded2.lease.intent_revision
  );
  await goalRunStore.rebindGoalRunSession(workspace2, A2, B2);
  const legacyBound = await runWithRuntimeScope(scopeFor(workspace2, B2), async () => {
    const bound = await goals.bindGoalToSession(workspace2, { expectedRevision: seeded2.goal.revision });
    await goalRunWeb.synchronizeCommittedLegacyGoal(workspace2, bound);
    return bound;
  });
  assert.equal(legacyBound.owner_session, B2);
  assert.equal((await driver.readDriverLease(workspace2))?.owner_session_id, A2);
  assert.equal((await driver.readDriverLease(workspace2))?.epoch, 1);

  const repaired = await h2.invokeGoal(B2, { action: "bind" });
  assert.equal(repaired.structuredContent.ok, true, JSON.stringify(repaired.structuredContent));
  assert.equal(repaired.structuredContent.data.orphan_recovery, true);
  assert.equal(repaired.structuredContent.data.orphan_recovery_from_already_bound_goal, true);
  assert.equal(repaired.structuredContent.data.durable_task_rebind.reason, "ALREADY_BOUND");
  assert.equal(repaired.structuredContent.data.durable_task_rebind.migrated, false);
  const repairedLease = repaired.structuredContent.data.driver_lease;
  assert.equal(repairedLease.owner_session_id, B2);
  assert.equal(repairedLease.epoch, 2);
  assert.equal(repairedLease.state, "ACTIVE");
  assert.notEqual(repairedLease.lease_id, seeded2.lease.lease_id);
  assert.equal((await goals.getWorkspaceGoalProjection(workspace2))?.owner_session, B2);

  assert.deepEqual(repairedLease.authority_transition, {
    kind: "ORPHAN_RECOVERY",
    transition_id: null,
    source_epoch: 1,
    source_lease_id: seeded2.lease.lease_id,
    source_session_id: A2,
    target_session_id: B2,
  });
  const repairedLeaseBytes = await fs.readFile(driver.driverLeasePath(workspace2), "utf8");
  const repairRetry = await h2.invokeGoal(B2, { action: "bind", expected_revision: 999 });
  assert.equal(repairRetry.structuredContent.ok, true, JSON.stringify(repairRetry.structuredContent));
  assert.equal(repairRetry.structuredContent.data.result, "ALREADY_BOUND");
  const leaseAfterRetry = await driver.readDriverLease(workspace2);
  assert.equal(leaseAfterRetry.epoch, 2, "ordinary bind retry advanced the repaired Driver epoch");
  assert.equal(leaseAfterRetry.lease_id, repairedLease.lease_id);
  assert.deepEqual(leaseAfterRetry.authority_transition, repairedLease.authority_transition,
    "ordinary bind retry replaced the exact orphan recovery receipt");
  assert.equal(await fs.readFile(driver.driverLeasePath(workspace2), "utf8"), repairedLeaseBytes,
    "ALREADY_BOUND rewrote the repaired Driver lease");

  const inheritedIntent2 = repaired.structuredContent.data.relay_intent_json;
  assert.equal(typeof inheritedIntent2, "string");
  const staleA2 = await h2.write(A2, 3, "legacy-stale-a");
  assert.equal(staleA2.structuredContent.ok, false);
  assert.equal(staleA2.structuredContent.data.error_code, "DRIVER_LEASE_LOST");
  const liveB2 = await h2.write(B2, 4, "legacy-live-b", inheritedIntent2);
  assert.equal(liveB2.structuredContent.marker, "legacy-live-b");

  // Scenario 3: two simultaneous commit retries for the same prepared orphan
  // recovery must converge on exactly one epoch/lease instead of double-bumping.
  const workspace3 = path.join(tempRoot, "workspace-concurrent-commit");
  await fs.mkdir(workspace3, { recursive: true });
  const A3 = "orphan-concurrent-chat-a";
  const B3 = "orphan-concurrent-chat-b";
  const intent3 = requirementIntent("concurrent-commit");
  const h3 = makeHarness(workspace3, intent3);
  const seeded3 = await createSeededGoal(workspace3, A3, h3.invokeGoal, h3.write, "concurrent");
  await ageLeasePastExpiry(workspace3, 180_000);
  const prepared3 = await driver.prepareDriverOrphanRecovery(workspace3, {
    goalId: seeded3.goal.id,
    sourceSessionId: A3,
    targetSessionId: B3,
    explicitTakeoverAuthorized: true,
    observation: {
      lane_observed: true,
      lane_fresh: false,
      generation_active: false,
      tool_inflight_count: 0,
    },
  });
  assert.equal(prepared3.lease.state, "ORPHANED");
  const commitInput3 = {
    goalId: seeded3.goal.id,
    sourceSessionId: A3,
    targetSessionId: B3,
    sourceEpoch: prepared3.source_epoch,
    sourceLeaseId: prepared3.source_lease_id,
    executionContractHash: seeded3.lease.execution_contract_hash,
    intentRevision: seeded3.lease.intent_revision,
  };
  const [concurrentCommitA, concurrentCommitB] = await Promise.all([
    driver.commitDriverOrphanRecovery(workspace3, commitInput3),
    driver.commitDriverOrphanRecovery(workspace3, commitInput3),
  ]);
  assert.equal(concurrentCommitA.epoch, 2);
  assert.equal(concurrentCommitB.epoch, 2);
  assert.equal(concurrentCommitA.lease_id, concurrentCommitB.lease_id);
  assert.equal((await driver.readDriverLease(workspace3))?.lease_id, concurrentCommitA.lease_id);

  console.log(
    "Relay orphan recovery: successor capability gate, grace/browser-busy gates, unresolved-effect barrier, no TTL-only takeover, explicit epoch+1 recovery, stale fencing, idempotent/concurrent commit, and preexisting Goal/Driver mismatch repair passed"
  );
} finally {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}
