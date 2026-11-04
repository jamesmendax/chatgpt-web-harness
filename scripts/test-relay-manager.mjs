import { createRelayFixtureScope } from "./relay-fixture-scope.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const tempRoot = await fs.mkdtemp(path.join(testRoot, "relay-manager-"));
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

const envKeys = [
  "CODEX_HOME",
  "HARNESS_RELAY_ENABLED",
  "HARNESS_COMPANION_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED",
  "HARNESS_RELAY_AUTO_RECOVERY_ENABLED",
  "HARNESS_RELAY_RISK_THRESHOLD",
  "HARNESS_RELAY_CAPABILITY_PROBE_TIMEOUT_MS",
  "HARNESS_RELAY_CAPABILITY_FRESH_MS",
  "HARNESS_RELAY_BROWSER_DELIVERY_RETRY_MS",
  "HARNESS_RELAY_REPLACEMENT_PROGRESS_TIMEOUT_MS",
  "HARNESS_DRIVER_ORPHAN_GRACE_MS",
  "HARNESS_COMPANION_TOKEN",
  "GOAL_WATCHDOG_ENABLED",
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.HARNESS_COMPANION_ENABLED = "true";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
process.env.HARNESS_RELAY_AUTO_RECOVERY_ENABLED = "true";
process.env.HARNESS_RELAY_RISK_THRESHOLD = "50";
process.env.HARNESS_RELAY_CAPABILITY_PROBE_TIMEOUT_MS = "100";
process.env.HARNESS_RELAY_CAPABILITY_FRESH_MS = "1000";
process.env.HARNESS_RELAY_BROWSER_DELIVERY_RETRY_MS = "1000";
process.env.HARNESS_DRIVER_ORPHAN_GRACE_MS = "0";
process.env.HARNESS_COMPANION_TOKEN = "test-only-relay-manager-claim-secret-0001";
process.env.GOAL_WATCHDOG_ENABLED = "false";

const { registerGoalTool } = await importDist("tools/goal.js");
const { EffectiveToolRegistry } = await importDist("lib/effective-tool-registry.js");
const { InvocationGateway } = await importDist("lib/invocation-gateway.js");
const { createRuntimeScope, runWithRuntimeScope } = await importDist("lib/runtime-scope.js");
const { childProcessEnv } = await importDist("lib/child-env.js");
const fixtureScopes = createRelayFixtureScope((await importDist("lib/relay-scope.js")).withRelayGoal);
const relay = fixtureScopes.wrap(await importDist("lib/relay-manager.js"));
const driver = fixtureScopes.wrap(await importDist("lib/driver-lease.js"));
const handoffs = fixtureScopes.wrap(await importDist("lib/handoff-store.js"));
const workers = fixtureScopes.wrap(await importDist("lib/worker-registry.js"));
const goalRuns = await importDist("lib/goal-run-store.js");

const A = "relay-manager-chat-a";
const B = "relay-manager-chat-b";
const TAB_A = "tab-instance-a";
const TAB_A2 = "tab-instance-a-g2";
const TAB_B = "tab-instance-b";
const TAB_B2 = "tab-instance-b-g2";

function scopeFor(sessionId) {
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

function requirementIntent() {
  return JSON.stringify({
    intent_revision: 1,
    objective: "Exercise autonomous relay manager",
    scope: ["temporary relay manager fixture"],
    out_of_scope: [],
    deliverables: ["relay manager assertions"],
    success_criteria: ["standby lane receives one idempotent command"],
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

let goalTool;
registerGoalTool({
  registerTool(name, config, callback) {
    if (name === "goal") goalTool = { config, callback };
  },
}, workspace);
assert.ok(goalTool);
const goalSchema = z.object(goalTool.config.inputSchema);
const invokeGoal = (sessionId, args) => runWithRuntimeScope(scopeFor(sessionId), () => goalTool.callback(goalSchema.parse(args)));

const registry = new EffectiveToolRegistry("full");
let writes = 0;
const definition = registry.prepare(
  "write_file",
  { inputSchema: { path: z.string() }, annotations: { readOnlyHint: false } },
  async (args) => {
    writes += 1;
    return { content: [{ type: "text", text: `written:${args.path}` }], structuredContent: { marker: args.path } };
  }
);
assert.ok(definition);
registry.register(definition);
const gateway = new InvocationGateway(registry, { workspaceRoot: workspace, projectRoots: [workspace] });
const write = (sessionId, requestId, file, intent = requirementIntent()) => gateway.invoke(
  "write_file",
  [{ path: file, _intent: intent }, requestExtra(sessionId, requestId)]
);
const writeWithoutIntent = (sessionId, requestId, file) => gateway.invoke(
  "write_file",
  [{ path: file }, requestExtra(sessionId, requestId)]
);

async function heartbeat(lane, tab, url, overrides = {}) {
  return relay.recordRelayLaneHeartbeat(workspace, {
    lane,
    tab_instance_id: tab,
    conversation_url: url,
    adapter_version: "test-adapter-v1",
    adapter_confidence: "high",
    conversation_surface: "CHAT",
    composer_ready: true,
    generation_active: false,
    connection_interrupted: false,
    tool_activity_count: 0,
    activity_revision: 1,
    ...overrides,
  });
}

async function heartbeatWorker(worker, tab, url, overrides = {}) {
  return relay.recordRelayLaneHeartbeat(workspace, {
    lane: worker.lane,
    worker_id: worker.worker_id,
    generation: worker.generation,
    provision_id: worker.provision_id,
    tab_instance_id: tab,
    conversation_url: url,
    adapter_version: "test-adapter-v2",
    adapter_confidence: "high",
    conversation_surface: "CHAT",
    composer_ready: true,
    generation_active: false,
    connection_interrupted: false,
    tool_activity_count: 0,
    activity_revision: 1,
    ...overrides,
  });
}

async function ageDriverLeasePastExpiry(expiredAgoMs = 2_000) {
  const file = driver.driverLeasePath(workspace);
  const state = JSON.parse(await fs.readFile(file, "utf8"));
  const expiresMs = Date.now() - expiredAgoMs;
  state.renewed_at = new Date(expiresMs - 60_000).toISOString();
  state.expires_at = new Date(expiresMs).toISOString();
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function proveWorkerCapability(workerId, sessionId, label) {
  const registry = await workers.readWorkerRegistry(workspace);
  const worker = registry.workers[workerId];
  assert.ok(worker, `expected Worker ${workerId} for capability proof`);
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
  assert.equal(workers.workerReadyForAuthority(consumed.worker), true);
  return consumed.worker;
}

async function proveLaneCapability(lane, sessionId, label) {
  const registry = await workers.readWorkerRegistry(workspace);
  const worker = workers.workerForLane(registry, lane);
  assert.ok(worker, `expected ${lane} Worker for capability proof`);
  return proveWorkerCapability(worker.worker_id, sessionId, label);
}

try {
  const created = await invokeGoal(A, {
    action: "create",
    objective: "Autonomous dual Chat A/B relay manager test",
    success_criteria: [{ name: "relay manager works" }],
    constraints: ["temporary fixture only"],
    current_phase: "A active",
  });
  assert.equal(created.structuredContent.ok, true);
  const goalId = created.structuredContent.data.goal.id;
  fixtureScopes.set(workspace, goalId);

  const missingInitialContract = await writeWithoutIntent(A, "missing-initial-contract", "must-not-run");
  assert.equal(missingInitialContract.structuredContent.ok, false);
  assert.equal(missingInitialContract.structuredContent.data.error_code, "REQUIREMENT_INHERITED_CONTRACT_MISSING");
  assert.equal(writes, 0, "a source Driver without an admitted contract entered the handler");

  const firstWrite = await write(A, 1, "seed");
  assert.equal(firstWrite.structuredContent.marker, "seed");
  assert.equal(writes, 1);
  assert.equal((await driver.readDriverLease(workspace))?.owner_session_id, A);

  const unboundControl = await relay.readRelayControlPlaneProjection(workspace);
  assert.equal(unboundControl.state, "WAITING_CONTROL_PLANE");
  assert.equal(unboundControl.standby_state, "ABSENT");
  assert.equal((await goalRuns.readGoalRun(workspace, A))?.run.state, "RUNNING", "initial pool provisioning must not pause a Goal before a control plane has ever been established");

  // A is the live current lane but its browser reports Connection interrupted.
  // B is independently healthy and has an idle composer, so automation may
  // prepare the two-phase handoff without asking the user to type "continue".
  await heartbeat("A", TAB_A, "https://chatgpt.com/c/test-a", {
    generation_active: true,
    connection_interrupted: true,
    stop_button_visible: true,
    retry_visible: true,
    turn_id: "turn-a-delivery-timeout",
    turn_started_at: new Date(Date.now() - 10_000).toISOString(),
    assistant_token_revision: 4,
    activity_revision: 10,
    tool_activity_count: 0,
  });
  await heartbeat("B", TAB_B, "https://chatgpt.com/c/test-b");
  const initialBWorker = await proveLaneCapability("B", B, "initial-b");
  const bTurnStartedAtMs = Date.now() - 1_000;
  const bFeedbackLedger = {
    schema_version: 1,
    turn_id: "turn-b-feedback-ledger",
    turn_started_at_ms: bTurnStartedAtMs,
    observed_at_ms: bTurnStartedAtMs + 20,
    text_revision: 0,
    signals: {
      assistant_text_emitted: { status: "unavailable", source: "host_callback", reason_code: "host_emission_callback_unavailable", event_time_ms: null },
      assistant_text_rendered: { status: "observed", source: "dom_observation", event_time_ms: bTurnStartedAtMs + 10, revision: 0, signature: "7:answer" },
      execution_activity: { status: "observed", source: "dom_mutation_observer", event_time_ms: bTurnStartedAtMs + 15, mutation_revision: 2, execution_revision: 1, generation_active: false, tool_inflight_count: 0, composer_mutations_excluded: true },
      transport_state: { status: "observed", source: "browser_companion_api_ack", state: "online", event_time_ms: bTurnStartedAtMs + 18, revision: 1 },
    },
  };
  await heartbeatWorker(initialBWorker, TAB_B, "https://chatgpt.com/c/test-b", {
    turn_id: "turn-b-feedback-ledger",
    turn_started_at: new Date(bTurnStartedAtMs).toISOString(),
    assistant_token_revision: 0,
    feedback_ledger: bFeedbackLedger,
  });
  const ledgerProjected = await relay.readRelayManagerState(workspace);
  assert.equal(ledgerProjected.lanes.B.observation.feedback_ledger?.turn_id, "turn-b-feedback-ledger",
    "the normalized Worker feedback ledger must reach the Relay lane observation");
  assert.equal(ledgerProjected.lanes.B.observation.feedback_ledger?.signals.assistant_text_emitted.status, "unavailable");

  const interruptedWithStandby = await relay.readRelayControlPlaneProjection(workspace);
  assert.equal(interruptedWithStandby.state, "RECOVERING");
  assert.equal(interruptedWithStandby.standby_state, "READY_STANDBY");

  let assessment = relay.assessRelayTurnRisk(
    await driver.readDriverLease(workspace),
    (await relay.readRelayManagerState(workspace)).lanes.A
  );
  assert.equal(assessment.should_handoff, false);
  assert.equal(assessment.web_turn.candidate, true);
  assert.equal(assessment.web_turn.stable_across_two_windows, false);
  const firstStallWindow = await relay.evaluateRelayAutomation(workspace);
  assert.equal(firstStallWindow.action, "blocked");
  assert.match(firstStallWindow.detail, /two stable observation windows/);

  await heartbeat("A", TAB_A, "https://chatgpt.com/c/test-a", {
    generation_active: true,
    connection_interrupted: true,
    stop_button_visible: true,
    retry_visible: true,
    turn_id: "turn-a-delivery-timeout",
    turn_started_at: new Date(Date.now() - 10_000).toISOString(),
    assistant_token_revision: 4,
    activity_revision: 10,
  });
  const secondStallWindow = await relay.evaluateRelayAutomation(workspace);
  assert.equal(secondStallWindow.action, "blocked");
  assert.match(secondStallWindow.detail, /two stable observation windows/);

  await heartbeat("A", TAB_A, "https://chatgpt.com/c/test-a", {
    generation_active: true,
    connection_interrupted: true,
    stop_button_visible: true,
    retry_visible: true,
    turn_id: "turn-a-delivery-timeout",
    turn_started_at: new Date(Date.now() - 10_000).toISOString(),
    assistant_token_revision: 4,
    activity_revision: 10,
  });
  assessment = relay.assessRelayTurnRisk(
    await driver.readDriverLease(workspace),
    (await relay.readRelayManagerState(workspace)).lanes.A
  );
  assert.equal(assessment.should_handoff, true);
  assert.equal(assessment.score, 100, "a delivery timeout may trigger relay only after two stable structured observations");
  assert.ok(assessment.reasons.includes("web_turn_composite_stall"));
  const structuredObservation = (await relay.readRelayManagerState(workspace)).lanes.A.observation;
  const inflightBlocked = relay.assessWebTurnStall({
    ...structuredObservation,
    tool_inflight_count: 1,
  }, Date.now(), null);
  assert.equal(inflightBlocked.should_recover, false, "browser-visible tool activity must block stream recovery");
  const oldActivity = new Date(Date.now() - 60_000).toISOString();
  const budgetStall = relay.assessWebTurnStall({
    ...structuredObservation,
    connection_interrupted: false,
    retry_visible: false,
    tool_inflight_count: 0,
    last_dom_activity_at: oldActivity,
    last_assistant_token_at: oldActivity,
    last_mcp_activity_at: oldActivity,
    turn_started_at: oldActivity,
  }, Date.now(), 30_000);
  assert.equal(budgetStall.should_recover, true, "an explicitly calibrated inactivity budget must use the same two-window composite gate");

  const prepared = await relay.evaluateRelayAutomation(workspace);
  assert.equal(prepared.action, "prepared");
  assert.equal(prepared.target_lane, "B");
  assert.match(prepared.handoff_id, /^hf_/);
  assert.match(prepared.command_id, /^relay_/);
  assert.equal((await driver.readDriverLease(workspace))?.state, "HANDOFF_PREPARED");

  const stateAfterPrepare = await relay.readRelayManagerState(workspace);
  const queued = stateAfterPrepare.commands.find((item) => item.command_id === prepared.command_id);
  assert.equal(queued?.state, "PENDING");
  assert.equal(queued?.lane, "B");
  assert.ok(queued?.message.includes(`goal(action=bind, handoff_id=${prepared.handoff_id})`));
  assert.ok(queued?.message.includes("relay_intent_json"));

  const claim = await relay.claimRelayCommand(workspace, "B", TAB_B, "B:g1");
  assert.equal(claim?.command_id, prepared.command_id);
  assert.equal(claim?.state, "CLAIMED");
  const repeatedClaim = await relay.claimRelayCommand(workspace, "B", TAB_B, "B:g1");
  assert.equal(repeatedClaim?.command_id, prepared.command_id, "lost command poll ACK should return the same claim to the same tab");
  assert.equal(repeatedClaim?.claim_count, 1, "same-tab repoll must not increment command delivery attempts");
  assert.equal(await relay.claimRelayCommand(workspace, "B", "different-live-tab", "B:g1"), null, "another tab must not steal an active claim");

  const sent = await relay.acknowledgeRelayCommand(workspace, prepared.command_id, TAB_B, "sent");
  assert.equal(sent.state, "SENT");

  const bound = await invokeGoal(B, { action: "bind", handoff_id: prepared.handoff_id });
  assert.equal(bound.structuredContent.ok, true);
  assert.equal(bound.structuredContent.data.driver_lease.owner_session_id, B);
  assert.equal(bound.structuredContent.data.driver_lease.epoch, 2);
  const relayIntentB = bound.structuredContent.data.relay_intent_json;
  assert.equal(typeof relayIntentB, "string");
  assert.equal(JSON.parse(relayIntentB).intent_revision, 1);
  assert.equal((await handoffs.readHandoffSnapshot(workspace, prepared.handoff_id))?.state, "COMMITTED");

  const reconciled = await relay.evaluateRelayAutomation(workspace);
  assert.equal(reconciled.action, "reconciled");
  const stateAfterCommit = await relay.readRelayManagerState(workspace);
  assert.equal(stateAfterCommit.active_lane, "B");
  assert.equal(stateAfterCommit.commands.find((item) => item.command_id === prepared.command_id)?.state, "ACKED");
  assert.equal((await relay.readRelayControlPlaneProjection(workspace)).state, "DEGRADED_REDUNDANCY", "a healthy Driver remains runnable while its new standby is being replenished");

  const stale = await write(A, 2, "stale-a");
  assert.equal(stale.structuredContent.ok, false);
  assert.equal(stale.structuredContent.data.error_code, "DRIVER_LEASE_LOST");
  const live = await write(B, 3, "live-b", relayIntentB);
  assert.equal(live.structuredContent.marker, "live-b");

  // Prewarm a *new* A generation before B becomes unhealthy. The retired/old
  // A:g1 is historical authority and must never be "re-proved" as a successor.
  // This models the production requirement that rotation uses a fresh Worker
  // conversation which is already browser+MCP capability ready before failure.
  const replaceA = await relay.requestRelayLaneReplacement(workspace, "A", "relay-manager-prewarm-reverse");
  assert.equal(replaceA.worker.worker_id, "A:g2");
  assert.equal(replaceA.worker.generation, 2);
  await heartbeatWorker(replaceA.worker, TAB_A2, "https://chatgpt.com/c/test-a-g2");
  const readyA2 = await proveWorkerCapability(replaceA.worker.worker_id, A, "reverse-a-g2");
  assert.equal(readyA2.worker_id, replaceA.worker.worker_id);
  assert.equal(readyA2.state, "READY");
  const prewarmReconciled = await relay.evaluateRelayAutomation(workspace);
  assert.equal(prewarmReconciled.action, "reconciled");
  assert.equal(prewarmReconciled.target_worker_id, "A:g2");
  const afterPrewarm = await workers.readWorkerRegistry(workspace);
  assert.equal(afterPrewarm.workers["A:g1"]?.state, "RETIRED");
  assert.equal(afterPrewarm.workers["A:g2"]?.state, "READY");
  const redundantAfterPrewarm = await relay.readRelayControlPlaneProjection(workspace);
  assert.equal(redundantAfterPrewarm.state, "ACTIVE");
  assert.equal(redundantAfterPrewarm.standby_state, "READY_STANDBY");

  // Reverse direction: B becomes unhealthy, prewarmed A:g2 is the healthy
  // standby. If Browser Companion cannot send the wake message, FAILED is
  // reconciled by aborting the prepared handoff and restoring B on the same epoch.
  // Companion cannot send the wake message, FAILED is reconciled by aborting
  // the prepared handoff and restoring B on the same epoch.
  await heartbeat("B", TAB_B, "https://chatgpt.com/c/test-b", {
    generation_active: true,
    connection_interrupted: true,
    tool_activity_count: 90,
    activity_revision: 2,
  });

  const reverse = await relay.evaluateRelayAutomation(workspace);
  assert.equal(reverse.action, "prepared");
  assert.equal(reverse.target_lane, "A");
  assert.equal(reverse.target_worker_id, "A:g2");
  const reverseClaim = await relay.claimRelayCommand(workspace, "A", TAB_A2, "A:g2");
  assert.equal(reverseClaim?.command_id, reverse.command_id);
  await relay.acknowledgeRelayCommand(workspace, reverse.command_id, TAB_A2, "failed", "simulated composer failure");
  const rollback = await relay.evaluateRelayAutomation(workspace);
  assert.equal(rollback.action, "reconciled");
  const restored = await driver.readDriverLease(workspace);
  assert.equal(restored?.owner_session_id, B);
  assert.equal(restored?.epoch, 2);
  assert.equal(restored?.state, "ACTIVE");
  assert.equal((await handoffs.readHandoffSnapshot(workspace, reverse.handoff_id))?.state, "ABORTED");

  // A failed wake must not poison the lane.  With A still healthy, the next
  // automation pass may prepare a fresh B -> A handoff and complete it.
  const reverseRetry = await relay.evaluateRelayAutomation(workspace);
  assert.equal(reverseRetry.action, "prepared");
  assert.equal(reverseRetry.target_lane, "A");
  assert.equal(reverseRetry.target_worker_id, "A:g2");
  assert.notEqual(reverseRetry.handoff_id, reverse.handoff_id);
  const retryClaim = await relay.claimRelayCommand(workspace, "A", TAB_A2, "A:g2");
  assert.equal(retryClaim?.command_id, reverseRetry.command_id);
  assert.match(retryClaim?.message ?? "", new RegExp(`goal\\(action=bind, handoff_id=${reverseRetry.handoff_id}\\)`));
  assert.doesNotMatch(retryClaim?.message ?? "", /takeover_token=/);
  await relay.acknowledgeRelayCommand(workspace, reverseRetry.command_id, TAB_A2, "sent");
  await heartbeatWorker(replaceA.worker, TAB_A2, "https://chatgpt.com/c/test-a-g2", {
    composer_ready: false,
    generation_active: true,
    connection_interrupted: false,
    turn_id: `handoff-${reverseRetry.handoff_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: true,
    activity_revision: 5,
  });
  const rebound = await invokeGoal(A, {
    action: "bind",
    handoff_id: reverseRetry.handoff_id,
  });
  assert.equal(rebound.structuredContent.ok, true, JSON.stringify(rebound.structuredContent));
  assert.equal(rebound.structuredContent.data.driver_lease.owner_session_id, A);
  assert.equal(rebound.structuredContent.data.driver_lease.epoch, 3);
  const relayIntentA = rebound.structuredContent.data.relay_intent_json;
  assert.equal(typeof relayIntentA, "string");
  assert.equal(relayIntentA, relayIntentB, "the exact admitted _intent must survive B -> A relay without being regenerated from prose");
  assert.equal((await handoffs.readHandoffSnapshot(workspace, reverseRetry.handoff_id))?.state, "COMMITTED");
  const reverseReconciled = await relay.evaluateRelayAutomation(workspace);
  assert.equal(reverseReconciled.action, "reconciled");
  assert.equal((await relay.readRelayManagerState(workspace)).active_lane, "A");
  const staleB = await write(B, 4, "stale-b");
  assert.equal(staleB.structuredContent.ok, false);
  assert.equal(staleB.structuredContent.data.error_code, "DRIVER_LEASE_LOST");
  const liveA = await write(A, 5, "live-a-again", relayIntentA);
  assert.equal(liveA.structuredContent.marker, "live-a-again");

  // Source-dead recovery: the active source Chat A:g2 does not answer any
  // health probe and performs no final handoff Turn. A fresh B:g2 is prewarmed
  // first, then Relay Manager must move the *same* Goal only after expiry,
  // failed capability proof, exact epoch/lease fencing and successor proof.
  const replaceB = await relay.requestRelayLaneReplacement(workspace, "B", "source-dead-prewarm");
  assert.equal(replaceB.worker.worker_id, "B:g2");
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2");
  const blankStandby = await relay.readRelayControlPlaneProjection(workspace);
  assert.equal(blankStandby.state, "DEGRADED_REDUNDANCY");
  assert.equal(blankStandby.standby_state, "PREWARMING", "READY_BLANK must never count as a capability-ready standby");

  await heartbeatWorker(replaceA.worker, TAB_A2, "https://chatgpt.com/c/test-a-g2", {
    generation_active: true,
    connection_interrupted: true,
    activity_revision: 3,
  });
  const waitingPass = await relay.evaluateRelayAutomation(workspace);
  assert.equal(waitingPass.action, "blocked");
  assert.equal((await relay.readRelayControlPlaneProjection(workspace)).state, "WAITING_CONTROL_PLANE");
  assert.equal((await goalRuns.readGoalRun(workspace, A))?.run.state, "WAITING_CONTROL_PLANE", "loss of both usable lanes must be recoverable control-plane wait, not INTERRUPTED");

  // Make A's previous capability proof definitely stale while keeping B's
  // browser observation fresh. Only after that do we prove B's real MCP path.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const bootstrapDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(bootstrapDelivery?.command_id, waitingPass.command_id);
  assert.match(bootstrapDelivery?.message ?? "", /goal\(action=status, handoff_id=/);
  assert.doesNotMatch(bootstrapDelivery?.message ?? "", /takeover_token=/);
  await relay.acknowledgeRelayCommand(workspace, bootstrapDelivery.command_id, TAB_B2, "sent");
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: false,
    generation_active: true,
    turn_id: `bootstrap-${bootstrapDelivery.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: true,
    activity_revision: 2,
  });
  const bootstrapProof = await invokeGoal(B, { action: "status", handoff_id: bootstrapDelivery.command_id });
  assert.equal(bootstrapProof.structuredContent.data.capability_verified, true);
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: true,
    generation_active: false,
    turn_id: `bootstrap-${bootstrapDelivery.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: false,
    activity_revision: 3,
  });
  const readyB2 = (await workers.readWorkerRegistry(workspace)).workers[replaceB.worker.worker_id];
  assert.equal(readyB2.state, "READY");
  const bPrewarmReconciled = await relay.evaluateRelayAutomation(workspace);
  assert.equal(bPrewarmReconciled.action, "reconciled");
  assert.equal(bPrewarmReconciled.target_worker_id, "B:g2");
  assert.equal((await goalRuns.readGoalRun(workspace, A))?.run.state, "RUNNING", "capability-proved standby must automatically resume WAITING_CONTROL_PLANE");

  // Once a standby has a durable formal-Chat/MCP binding, ordinary idle
  // polling must not send a new bootstrap Turn every time the short transfer
  // freshness window expires. Recovery/handoff performs one just-in-time
  // proof before authority moves.
  await heartbeatWorker(replaceA.worker, TAB_A2, "https://chatgpt.com/c/test-a-g2", {
    generation_active: false,
    connection_interrupted: false,
    activity_revision: 6,
  });
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const quietEstablishedStandby = await relay.evaluateRelayAutomation(workspace);
  assert.equal(quietEstablishedStandby.action, "idle",
    "an established idle standby must not receive periodic bootstrap spam after capability freshness expires");

  // Capability freshness expires during long Goals. An ACKED bootstrap must
  // allow the already-bound standby to prove the same MCP session again; it
  // must never be mistaken for an initial unbound Worker only.
  const beforeRefresh = (await workers.readWorkerRegistry(workspace)).workers["B:g2"];
  const failedRefresh = await relay.enqueueWorkerBootstrapCommand(workspace, {
    worker: beforeRefresh,
    registryRevision: (await workers.readWorkerRegistry(workspace)).revision,
    goalId,
  });
  const failedRefreshDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(failedRefreshDelivery?.command_id, failedRefresh.command_id);
  await relay.acknowledgeRelayCommand(workspace, failedRefresh.command_id, TAB_B2, "failed", "fixture plugin selection failure");
  const suppressedRefresh = await relay.enqueueWorkerBootstrapCommand(workspace, {
    worker: beforeRefresh,
    registryRevision: (await workers.readWorkerRegistry(workspace)).revision,
    goalId,
  });
  assert.equal(suppressedRefresh.command_id, failedRefresh.command_id,
    "a failed browser delivery must be reused during the retry cooldown instead of creating command churn");
  assert.equal(await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2"), null,
    "a terminal delivery in cooldown must not be reactivated");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const refreshQueued = await relay.enqueueWorkerBootstrapCommand(workspace, {
    worker: beforeRefresh,
    registryRevision: (await workers.readWorkerRegistry(workspace)).revision,
    goalId,
  });
  assert.notEqual(refreshQueued.command_id, failedRefresh.command_id,
    "a safe failed-before-activation delivery may create one new attempt after the retry cooldown");
  const refreshDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(refreshDelivery?.command_id, refreshQueued.command_id);
  await relay.acknowledgeRelayCommand(workspace, refreshQueued.command_id, TAB_B2, "sent");
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: false,
    generation_active: true,
    turn_id: `refresh-${refreshQueued.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: true,
    activity_revision: 4,
  });
  const refreshProof = await invokeGoal(B, { action: "status", handoff_id: refreshQueued.command_id });
  assert.equal(refreshProof.structuredContent.data.capability_verified, true);
  assert.equal(refreshProof.structuredContent.data.bootstrap_command_id, refreshQueued.command_id);
  const afterRefresh = (await workers.readWorkerRegistry(workspace)).workers["B:g2"];
  assert.equal(afterRefresh.bound_session_id, B);
  assert.equal(afterRefresh.claim_consumed_at !== null, true);
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: true,
    generation_active: false,
    turn_id: `refresh-${refreshQueued.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: false,
    activity_revision: 5,
  });
  await heartbeatWorker(replaceA.worker, TAB_A2, "https://chatgpt.com/c/test-a-g2", {
    generation_active: false,
    connection_interrupted: false,
    activity_revision: 6,
  });

  // Ordinary owner MCP activity must renew the advisory Driver deadline and
  // prevent a live long-running Chat from being mistaken for an orphan merely
  // because ten wall-clock minutes elapsed.
  await ageDriverLeasePastExpiry();
  await workers.recordWorkerMcpActivityBySession(workspace, A);
  const renewedByActivity = await driver.renewDriverLeaseForOwnerActivity(workspace, A);
  assert.equal(renewedByActivity?.owner_session_id, A);
  assert.equal(renewedByActivity?.epoch, 3);
  assert.ok(Date.parse(renewedByActivity.expires_at) > Date.now());
  assert.equal(await driver.renewDriverLeaseForOwnerActivity(workspace, B), null,
    "a standby/stale session must never renew the active Driver");
  const liveOwnerPass = await relay.evaluateRelayAutomation(workspace);
  assert.notEqual(liveOwnerPass.command_id?.startsWith("health_probe_") ?? false, true,
    "fresh owner MCP activity must not launch orphan probing");
  await workers.transitionWorker(workspace, "A:g2", "SUSPECT", { detail: "owner-activity-restore-regression" });
  await workers.recordWorkerMcpActivityBySession(workspace, A, new Date(Date.now() + 10).toISOString());
  const restoredOwnerPass = await relay.evaluateRelayAutomation(workspace);
  assert.equal(restoredOwnerPass.action, "reconciled");
  assert.equal((await workers.readWorkerRegistry(workspace)).workers["A:g2"]?.state, "ACTIVE");

  // Let both MCP capability proofs expire while browser heartbeats remain
  // fresh. Recovery must probe the expired source before generic standby
  // prewarm gets a chance to enqueue another bootstrap and starve recovery.
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  await ageDriverLeasePastExpiry();
  const expiredLease = await driver.readDriverLease(workspace);
  assert.equal(expiredLease?.owner_session_id, A);
  assert.equal(expiredLease?.epoch, 3);

  const probeIssued = await relay.evaluateRelayAutomation(workspace);
  assert.equal(probeIssued.action, "blocked");
  assert.match(probeIssued.command_id ?? "", /^health_probe_/);
  assert.equal(probeIssued.target_worker_id, "A:g2");
  // Deliberately never claim/ACK the probe: this is the source Chat losing its
  // App/tool binding completely, not a cooperative handoff failure.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const recoveryBootstrap = await relay.evaluateRelayAutomation(workspace);
  assert.equal(recoveryBootstrap.action, "blocked");
  assert.match(recoveryBootstrap.command_id ?? "", /^bootstrap_worker_/);
  assert.equal(recoveryBootstrap.target_worker_id, "B:g2");
  const recoveryBootstrapDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(recoveryBootstrapDelivery?.command_id, recoveryBootstrap.command_id);
  await relay.acknowledgeRelayCommand(workspace, recoveryBootstrap.command_id, TAB_B2, "sent");
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: false,
    generation_active: true,
    turn_id: `recovery-bootstrap-${recoveryBootstrap.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: true,
    activity_revision: 6,
  });
  const recoveryCapabilityProof = await invokeGoal(B, { action: "status", handoff_id: recoveryBootstrap.command_id });
  assert.equal(recoveryCapabilityProof.structuredContent.data.capability_verified, true);
  assert.equal(recoveryCapabilityProof.structuredContent.data.bootstrap_command_id, recoveryBootstrap.command_id);
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: true,
    generation_active: false,
    turn_id: `recovery-bootstrap-${recoveryBootstrap.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: false,
    activity_revision: 7,
  });

  const recoveryPrepared = await relay.evaluateRelayAutomation(workspace);
  assert.equal(recoveryPrepared.action, "prepared");
  assert.match(recoveryPrepared.command_id ?? "", /^recover_worker_/);
  assert.equal(recoveryPrepared.target_worker_id, "B:g2");
  const sourceBeforeRecovery = (await workers.readWorkerRegistry(workspace)).workers["A:g2"];
  assert.equal(sourceBeforeRecovery?.state, "ORPHAN_CANDIDATE");

  const recoveryDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(recoveryDelivery?.command_id, recoveryPrepared.command_id);
  assert.match(recoveryDelivery?.message ?? "", /automatic ORPHAN recovery/);
  assert.match(recoveryDelivery?.message ?? "", new RegExp(`goal\\(action=bind, handoff_id=${recoveryPrepared.command_id}\\)`));
  assert.doesNotMatch(recoveryDelivery?.message ?? "", /takeover_token=/);
  await relay.acknowledgeRelayCommand(workspace, recoveryPrepared.command_id, TAB_B2, "sent");
  await heartbeatWorker(replaceB.worker, TAB_B2, "https://chatgpt.com/c/test-b-g2", {
    composer_ready: false,
    generation_active: true,
    connection_interrupted: false,
    turn_id: `recovery-${recoveryPrepared.command_id}`,
    turn_started_at: new Date().toISOString(),
    stop_button_visible: true,
    activity_revision: 4,
  });
  const recovered = await invokeGoal(B, {
    action: "bind",
    handoff_id: recoveryPrepared.command_id,
  });
  assert.equal(recovered.structuredContent.ok, true, JSON.stringify(recovered.structuredContent));
  assert.equal(recovered.structuredContent.data.automatic_orphan_recovery, true);
  assert.equal(recovered.structuredContent.data.driver_lease.owner_session_id, B);
  assert.equal(recovered.structuredContent.data.driver_lease.epoch, 4);
  const recoveryIntentB = recovered.structuredContent.data.relay_intent_json;
  assert.equal(recoveryIntentB, relayIntentA, "source-dead recovery must inherit the exact admitted _intent from durable state");
  assert.equal(recovered.structuredContent.data.goal.id, goalId, "recovery must continue the same durable Goal, never create a replacement Goal");

  const continuationDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(continuationDelivery?.kind, "resume_goal", "committed recovery must wake the new Driver in a separate continuation turn");
  assert.equal(continuationDelivery?.command_id, recovered.structuredContent.data.recovery_continuation_command_id);
  assert.match(continuationDelivery?.message ?? "", /Driver recovery is committed/);
  assert.match(continuationDelivery?.message ?? "", /pending_criteria/);
  assert.match(continuationDelivery?.message ?? "", /omit _intent/);
  assert.doesNotMatch(continuationDelivery?.message ?? "", /using the relay_intent_json/);
  assert.doesNotMatch(continuationDelivery?.message ?? "", /goal\(action=bind/,
    "post-recovery continuation must not ask the already-bound Driver to bind again");
  await relay.acknowledgeRelayCommand(workspace, continuationDelivery.command_id, TAB_B2, "failed", "fixture delivery failure");
  const retriedContinuation = await relay.enqueueRelayRecoveryContinuation(workspace, {
    recoveryId: recoveryPrepared.command_id,
    workerId: "B:g2",
    goalRevision: recovered.structuredContent.data.goal.revision,
    instruction: "Retry the still-pending Goal work after a failed browser delivery.",
  });
  assert.notEqual(retriedContinuation.command_id, continuationDelivery.command_id,
    "a terminal continuation delivery must create a new physical command attempt");
  assert.equal(retriedContinuation.handoff_id, continuationDelivery.handoff_id,
    "delivery retries must retain the stable logical continuation identity");
  assert.notEqual(retriedContinuation.marker, continuationDelivery.marker,
    "an old transcript turn must never be able to prove a continuation retry was delivered");
  assert.match(retriedContinuation.marker ?? "", new RegExp(retriedContinuation.command_id));
  assert.doesNotMatch(retriedContinuation.message ?? "", new RegExp(continuationDelivery.command_id));
  const retriedContinuationDelivery = await relay.claimRelayCommand(workspace, "B", TAB_B2, "B:g2");
  assert.equal(retriedContinuationDelivery?.command_id, retriedContinuation.command_id);
  await relay.acknowledgeRelayCommand(workspace, retriedContinuation.command_id, TAB_B2, "sent");

  const deadAWrite = await write(A, 6, "dead-a-after-auto-recovery");
  assert.equal(deadAWrite.structuredContent.ok, false);
  assert.equal(deadAWrite.structuredContent.data.error_code, "DRIVER_WORKER_FENCED");
  const recoveredBWrite = await writeWithoutIntent(B, 7, "recovered-b-same-goal");
  assert.equal(recoveredBWrite.structuredContent.marker, "recovered-b-same-goal");
  const afterRecoveryRegistry = await workers.readWorkerRegistry(workspace);
  assert.equal(afterRecoveryRegistry.workers["B:g2"]?.state, "ACTIVE");
  assert.equal(afterRecoveryRegistry.workers["A:g2"]?.state, "DEAD");

  // A replacement which never produces a browser heartbeat must not occupy
  // replacement_worker_id forever. The automation pass first leaves a fresh
  // request alone, then terminalizes it after the progress timeout and creates
  // exactly one next generation without moving Driver authority.
  process.env.HARNESS_RELAY_REPLACEMENT_PROGRESS_TIMEOUT_MS = "100";
  const wedgedReplacement = await relay.requestRelayLaneReplacement(workspace, "A", "stale-replacement-regression");
  assert.equal(wedgedReplacement.worker.worker_id, "A:g3");
  const freshReplacementPass = await relay.evaluateRelayAutomation(workspace);
  assert.equal(freshReplacementPass.action, "provisioned");
  assert.equal(freshReplacementPass.target_worker_id, "A:g3", "a fresh replacement must receive its grace period");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const recoveredReplacementPass = await relay.evaluateRelayAutomation(workspace);
  assert.equal(recoveredReplacementPass.action, "provisioned");
  assert.equal(recoveredReplacementPass.target_worker_id, "A:g4", "timed-out replacement must be replaced by the next generation");
  const afterReplacementRecovery = await workers.readWorkerRegistry(workspace);
  assert.equal(afterReplacementRecovery.workers["A:g3"]?.state, "FAILED");
  assert.equal(afterReplacementRecovery.workers["A:g3"]?.death_reason, "replacement_progress_timeout");
  assert.equal(afterReplacementRecovery.workers["A:g4"]?.state, "REQUESTED");
  const managerAfterReplacementRecovery = await relay.readRelayManagerState(workspace);
  assert.equal(managerAfterReplacementRecovery.lanes.A.replacement_worker_id, "A:g4");
  assert.equal((await driver.readDriverLease(workspace))?.owner_session_id, B, "stale replacement recovery must not move Driver authority");

  // A browser turn can remain alive behind an approval dialog after the new
  // Driver completes the Goal. Fencing must follow the terminal Worker/active
  // lease, not disappear merely because the compatibility Goal projection is
  // now completed.
  const goalProject = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12);
  const globalGoalFile = path.join(process.env.CODEX_HOME, "projects", goalProject, "goal.json");
  const completedProjection = JSON.parse(await fs.readFile(globalGoalFile, "utf8"));
  completedProjection.status = "completed";
  completedProjection.completed_at = new Date().toISOString();
  completedProjection.updated_at = completedProjection.completed_at;
  completedProjection.revision += 1;
  await fs.writeFile(globalGoalFile, `${JSON.stringify(completedProjection, null, 2)}\n`, "utf8");
  const writesBeforeCompletedFence = writes;
  const staleAfterCompletion = await write(A, 8, "dead-a-after-goal-completion");
  assert.equal(staleAfterCompletion.structuredContent.ok, false);
  assert.equal(staleAfterCompletion.structuredContent.data.error_code, "DRIVER_WORKER_FENCED");
  assert.equal(writes, writesBeforeCompletedFence, "terminal source Worker entered a handler after Goal completion");
  const ownerAfterCompletion = await write(B, 9, "current-b-after-goal-completion", recoveryIntentB);
  assert.equal(ownerAfterCompletion.structuredContent.marker, "current-b-after-goal-completion");

  // Companion bearer material must never leak into arbitrary MCP-launched child
  // commands, independently of the Admin token hygiene that already existed.
  process.env.HARNESS_COMPANION_TOKEN = "fixture-secret-not-for-child";
  assert.equal(childProcessEnv().HARNESS_COMPANION_TOKEN, undefined);

  console.log("Relay manager: cooperative A->B->fresh A:g2 rotation plus source-dead A:g2->B:g2 automatic ORPHAN recovery, capability proof, same-Goal continuity, epoch fencing, lost-ACK safety, and secret stripping passed");
} finally {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  delete process.env.HARNESS_COMPANION_TOKEN;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
