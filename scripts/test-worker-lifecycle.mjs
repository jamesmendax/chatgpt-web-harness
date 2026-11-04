import { createRelayFixtureScope } from "./relay-fixture-scope.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-harness-worker-lifecycle-"));
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HARNESS_COMPANION_TOKEN = "worker-lifecycle-test-token-0123456789";
process.env.HARNESS_DRIVER_ORPHAN_GRACE_MS = "0";
delete process.env.HARNESS_WORKER_CLAIM_TTL_MS;

const fixtureScopes = createRelayFixtureScope((await import("../dist/lib/relay-scope.js")).withRelayGoal);
const workers = fixtureScopes.wrap(await import("../dist/lib/worker-registry.js"));
const driver = fixtureScopes.wrap(await import("../dist/lib/driver-lease.js"));
const handoff = fixtureScopes.wrap(await import("../dist/lib/handoff-store.js"));

try {
  fixtureScopes.set(workspace, "goal_worker_test");
  const first = await workers.requestWorkerProvision(workspace, { lane: "A", goalId: "goal_worker_test", reason: "test" });
  assert.equal(first.created, true);
  assert.equal(first.worker.worker_id, "A:g1");
  assert.equal(first.worker.generation, 1);
  assert.equal(first.worker.state, "REQUESTED");

  const idempotent = await workers.requestWorkerProvision(workspace, { lane: "A", goalId: "goal_worker_test", reason: "retry" });
  assert.equal(idempotent.created, false);
  assert.equal(idempotent.worker.worker_id, "A:g1");

  const ready = await workers.recordWorkerBrowserHeartbeat(workspace, {
    workerId: first.worker.worker_id,
    lane: "A",
    generation: 1,
    provisionId: first.worker.provision_id,
    companionInstanceId: "browser_test",
    tabInstanceId: "tabinst_a_g1",
    conversationUrl: "https://chatgpt.com/c/test-a-g1",
    adapterVersion: "test-adapter",
    adapterConfidence: "high",
    conversationSurface: "CHAT",
    composerReady: true,
    generationActive: false,
    connectionInterrupted: false,
    activityRevision: 1,
  });
  assert.equal(ready.worker.state, "READY_BLANK");
  assert.equal(ready.worker.composer_ready, true);

  const turnTelemetry = {
    workerId: first.worker.worker_id,
    lane: "A",
    generation: 1,
    provisionId: first.worker.provision_id,
    companionInstanceId: "browser_test",
    tabInstanceId: "tabinst_a_g1",
    conversationUrl: "https://chatgpt.com/c/test-a-g1",
    adapterVersion: "test-adapter",
    adapterConfidence: "high",
    conversationSurface: "CHAT",
    composerReady: true,
    generationActive: true,
    connectionInterrupted: true,
    activityRevision: 8,
    turnId: "turn-a-1",
    turnStartedAt: "2026-09-14T10:00:00.000Z",
    stopButtonVisible: true,
    retryVisible: true,
    toolInflightCount: 0,
    assistantTokenRevision: 3,
    feedbackLedger: {
      schema_version: 1,
      turn_id: "turn-a-1",
      turn_started_at_ms: Date.parse("2026-09-14T10:00:00.000Z"),
      observed_at_ms: Date.parse("2026-09-14T10:00:00.002Z"),
      text_revision: 0,
      signals: {
        assistant_text_emitted: { status: "unavailable", source: "host_callback", reason_code: "host_emission_callback_unavailable", event_time_ms: null },
        assistant_text_rendered: { status: "observed", source: "dom_observation", event_time_ms: Date.parse("2026-09-14T10:00:00.001Z"), revision: 0, signature: "5:hello" },
        execution_activity: { status: "observed", source: "dom_mutation_observer", event_time_ms: Date.parse("2026-09-14T10:00:00.001Z"), mutation_revision: 8, execution_revision: 3, generation_active: true, tool_inflight_count: 0, composer_mutations_excluded: true },
        transport_state: { status: "observed", source: "browser_companion_api_ack", state: "online", event_time_ms: Date.parse("2026-09-14T10:00:00.001Z"), revision: 1 },
      },
    },
  };
  const turnFirst = await workers.recordWorkerBrowserHeartbeat(workspace, turnTelemetry);
  assert.equal(turnFirst.worker.turn_id, "turn-a-1");
  assert.equal(turnFirst.worker.feedback_ledger?.turn_id, "turn-a-1");
  assert.equal(turnFirst.worker.feedback_ledger?.signals.assistant_text_emitted.status, "unavailable");
  assert.equal(turnFirst.worker.feedback_ledger?.signals.assistant_text_rendered.received_at_ms !== null, true);
  assert.equal(turnFirst.worker.stable_observation_windows, 0);
  assert.equal(turnFirst.worker.last_dom_activity_at !== null, true);
  assert.equal(turnFirst.worker.last_assistant_token_at !== null, true);
  const turnSecond = await workers.recordWorkerBrowserHeartbeat(workspace, turnTelemetry);
  assert.equal(turnSecond.worker.stable_observation_windows, 1);
  const turnThird = await workers.recordWorkerBrowserHeartbeat(workspace, turnTelemetry);
  assert.equal(turnThird.worker.stable_observation_windows, 2, "two unchanged confirmation windows were not retained");
  const tokenProgress = await workers.recordWorkerBrowserHeartbeat(workspace, {
    ...turnTelemetry,
    assistantTokenRevision: 4,
  });
  assert.equal(tokenProgress.worker.stable_observation_windows, 0, "assistant progress must reset stall confirmation");
  assert.equal(tokenProgress.worker.assistant_token_revision, 4);
  const nextTurn = await workers.recordWorkerBrowserHeartbeat(workspace, {
    ...turnTelemetry,
    turnId: "turn-a-2",
    turnStartedAt: "2026-09-14T10:01:00.000Z",
    activityRevision: 1,
    assistantTokenRevision: 0,
    connectionInterrupted: false,
    retryVisible: false,
    feedbackLedger: {
      ...turnTelemetry.feedbackLedger,
      turn_id: "turn-a-2",
      turn_started_at_ms: Date.parse("2026-09-14T10:01:00.000Z"),
      observed_at_ms: Date.parse("2026-09-14T10:01:00.002Z"),
      text_revision: 0,
      signals: {
        ...turnTelemetry.feedbackLedger.signals,
        assistant_text_rendered: { ...turnTelemetry.feedbackLedger.signals.assistant_text_rendered, event_time_ms: Date.parse("2026-09-14T10:01:00.001Z"), signature: "6:second" },
        execution_activity: { ...turnTelemetry.feedbackLedger.signals.execution_activity, event_time_ms: Date.parse("2026-09-14T10:01:00.001Z"), mutation_revision: 9, execution_revision: 4 },
        transport_state: { ...turnTelemetry.feedbackLedger.signals.transport_state, event_time_ms: Date.parse("2026-09-14T10:01:00.001Z") },
      },
    },
  });
  assert.equal(nextTurn.worker.turn_id, "turn-a-2");
  assert.equal(nextTurn.worker.feedback_ledger?.turn_id, "turn-a-2", "new turns must start a fresh feedback-ledger revision chain");
  assert.equal(nextTurn.worker.feedback_ledger?.text_revision, 0);
  assert.equal(nextTurn.worker.activity_revision, 1, "a new turn must get its own monotonic revision space");
  assert.equal(nextTurn.worker.stable_observation_windows, 0);

  const registryBeforeInvalidLedger = await workers.readWorkerRegistry(workspace);
  await assert.rejects(() => workers.recordWorkerBrowserHeartbeat(workspace, {
    ...turnTelemetry,
    turnId: "turn-a-2",
    turnStartedAt: "2026-09-14T10:01:00.000Z",
    feedbackLedger: {
      ...nextTurn.worker.feedback_ledger,
      observed_at_ms: 1,
      signals: {
        ...nextTurn.worker.feedback_ledger.signals,
        assistant_text_rendered: { ...nextTurn.worker.feedback_ledger.signals.assistant_text_rendered, event_time_ms: 2 },
      },
    },
  }), /VISIBLE_FEEDBACK_LEDGER_INVALID/);
  const registryAfterInvalidLedger = await workers.readWorkerRegistry(workspace);
  assert.equal(registryAfterInvalidLedger.revision, registryBeforeInvalidLedger.revision,
    "an invalid feedback snapshot must not partially advance Worker Registry state");

  const staleOldTurn = await workers.recordWorkerBrowserHeartbeat(workspace, {
    ...turnTelemetry,
    turnId: "turn-a-2",
    turnStartedAt: "2026-09-14T10:01:00.000Z",
  });
  assert.equal(staleOldTurn.worker.feedback_ledger?.turn_id, "turn-a-2",
    "a delayed prior-turn snapshot must never overwrite the current ledger");
  const turnWithoutLedger = await workers.recordWorkerBrowserHeartbeat(workspace, {
    ...turnTelemetry,
    turnId: "turn-a-3",
    turnStartedAt: "2026-09-14T10:02:00.000Z",
    activityRevision: 1,
    assistantTokenRevision: 0,
    feedbackLedger: undefined,
  });
  assert.equal(turnWithoutLedger.worker.turn_id, "turn-a-3");
  assert.equal(turnWithoutLedger.worker.feedback_ledger, undefined,
    "a new turn without a valid snapshot must not retain the previous turn's ledger");

  await assert.rejects(
    () => workers.markWorkerActiveForSession(workspace, first.worker.worker_id, "session_target_1"),
    /WORKER_AUTHORITY_NOT_READY/,
    "browser readiness alone must never grant Driver authority"
  );

  const probeTicket = await workers.mintWorkerClaimTicket(workspace, {
    workerId: first.worker.worker_id,
    handoffId: "bootstrap_worker_lifecycle_0001",
    kind: "PROBE",
  });
  const probeConsumed = await workers.consumeWorkerClaimTicket(workspace, {
    workerId: first.worker.worker_id,
    handoffId: "bootstrap_worker_lifecycle_0001",
    token: probeTicket.token,
    targetSessionId: "session_target_1",
    kind: "PROBE",
  });
  assert.equal(probeConsumed.worker.state, "READY");
  assert.equal(probeConsumed.worker.bound_session_id, "session_target_1");
  assert.equal(workers.workerReadyForAuthority(probeConsumed.worker), true);
  const capabilityAt = probeConsumed.worker.last_capability_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const mcpActivity = await workers.recordWorkerMcpActivityBySession(workspace, "session_target_1");
  assert.ok(mcpActivity, "bound MCP activity did not resolve to its Worker");
  assert.equal(mcpActivity.worker.last_capability_at, capabilityAt, "ordinary MCP activity must not refresh capability proof");
  assert.ok(Date.parse(mcpActivity.worker.last_mcp_seen_at) >= Date.parse(probeConsumed.worker.last_mcp_seen_at));
  assert.equal(await workers.recordWorkerMcpActivityBySession(workspace, "unbound_session"), null);

  const ticket = await workers.mintWorkerClaimTicket(workspace, {
    workerId: first.worker.worker_id,
    handoffId: "hf_worker_lifecycle_0001",
    kind: "HANDOFF",
  });
  assert.ok(ticket.token.length >= 32);
  const claimLifetimeMs = Date.parse(ticket.expires_at) - Date.now();
  assert.ok(claimLifetimeMs > 170_000 && claimLifetimeMs <= 180_000, `default claim lifetime must be about three minutes, got ${claimLifetimeMs}`);
  const verified = await workers.verifyWorkerClaimTicket(workspace, {
    workerId: first.worker.worker_id,
    handoffId: "hf_worker_lifecycle_0001",
    token: ticket.token,
    targetSessionId: "session_target_1",
    kind: "HANDOFF",
  });
  assert.equal(verified.already_consumed, false);

  const consumed = await workers.consumeWorkerClaimTicket(workspace, {
    workerId: first.worker.worker_id,
    handoffId: "hf_worker_lifecycle_0001",
    token: ticket.token,
    targetSessionId: "session_target_1",
    kind: "HANDOFF",
  });
  assert.equal(consumed.already_consumed, false);
  const sameSessionRetry = await workers.consumeWorkerClaimTicket(workspace, {
    workerId: first.worker.worker_id,
    handoffId: "hf_worker_lifecycle_0001",
    token: ticket.token,
    targetSessionId: "session_target_1",
    kind: "HANDOFF",
  });
  assert.equal(sameSessionRetry.already_consumed, true);
  await assert.rejects(
    () => workers.consumeWorkerClaimTicket(workspace, {
      workerId: first.worker.worker_id,
      handoffId: "hf_worker_lifecycle_0001",
      token: ticket.token,
      targetSessionId: "session_target_2",
      kind: "HANDOFF",
    }),
    /WORKER_CLAIM_REPLAY|WORKER_SESSION_MISMATCH/
  );

  const active = await workers.markWorkerActiveForSession(workspace, first.worker.worker_id, "session_target_1");
  assert.equal(active.worker.state, "ACTIVE");
  assert.equal(active.worker.bound_session_id, "session_target_1");
  const expiredCleanup = await workers.clearExpiredWorkerClaims(workspace, Date.parse(ticket.expires_at) + 1);
  assert.equal(expiredCleanup.cleared, 1);
  assert.equal(expiredCleanup.registry.workers[first.worker.worker_id].claim_token_hash, null);
  assert.equal(expiredCleanup.registry.workers[first.worker.worker_id].state, "ACTIVE", "claim cleanup must not change Driver authority");
  assert.equal(expiredCleanup.registry.workers[first.worker.worker_id].last_capability_at, active.worker.last_capability_at);

  const successor = await workers.requestWorkerProvision(workspace, {
    lane: "A",
    goalId: "goal_worker_test",
    reason: "operator_replace",
    forceNew: true,
  });
  assert.equal(successor.created, true);
  assert.equal(successor.worker.worker_id, "A:g2");
  assert.equal(successor.worker.generation, 2);
  assert.equal(successor.registry.lanes.A.next_generation, 3);

  // Regression: a newer failed generation can clear the lane pointer while an
  // older browser-observed Worker is still reusable. Pool repair must attach
  // that durable Worker back to the lane or every automation poll will attempt
  // another provision command (the 2026-09-22 tab-storm failure).
  const detachedWorkspace = path.join(tempRoot, "detached-worker-workspace");
  await fs.mkdir(detachedWorkspace, { recursive: true });
  fixtureScopes.set(detachedWorkspace, "goal_detached_worker");
  const detachedFirst = await workers.requestWorkerProvision(detachedWorkspace, {
    lane: "B",
    goalId: "goal_detached_worker",
    reason: "fixture_first_generation",
  });
  const detachedHeartbeat = {
    workerId: detachedFirst.worker.worker_id,
    lane: "B",
    generation: detachedFirst.worker.generation,
    provisionId: detachedFirst.worker.provision_id,
    companionInstanceId: "fixture-companion",
    tabInstanceId: "fixture-tab-b-g1",
    conversationUrl: "https://chatgpt.com/",
    adapterVersion: "fixture-adapter",
    adapterConfidence: "high",
    composerReady: true,
    generationActive: false,
  };
  const detachedWork = await workers.recordWorkerBrowserHeartbeat(detachedWorkspace, {
    ...detachedHeartbeat,
    conversationSurface: "WORK",
  });
  assert.equal(detachedWork.worker.state, "TAB_CREATED", "Work mode must never become a ready Worker");
  const detachedReady = await workers.recordWorkerBrowserHeartbeat(detachedWorkspace, {
    ...detachedHeartbeat,
    conversationSurface: "CHAT",
  });
  assert.equal(detachedReady.worker.state, "READY_BLANK");
  const detachedReplacement = await workers.requestWorkerProvision(detachedWorkspace, {
    lane: "B",
    goalId: "goal_detached_worker",
    reason: "fixture_replacement",
    forceNew: true,
  });
  assert.equal(detachedReplacement.worker.worker_id, "B:g2");
  await workers.transitionWorker(detachedWorkspace, detachedReplacement.worker.worker_id, "FAILED", {
    detail: "fixture replacement failed before tab creation",
  });
  const emptyLane = await workers.readWorkerRegistry(detachedWorkspace);
  assert.equal(emptyLane.lanes.B.standby_worker_id, null);
  assert.equal(emptyLane.workers[detachedFirst.worker.worker_id].state, "READY_BLANK");
  const reattached = await workers.requestWorkerProvision(detachedWorkspace, {
    lane: "B",
    goalId: "goal_detached_worker",
    reason: "automatic_pool_repair",
  });
  assert.equal(reattached.created, false);
  assert.equal(reattached.worker.worker_id, detachedFirst.worker.worker_id);
  assert.equal(reattached.registry.lanes.B.standby_worker_id, detachedFirst.worker.worker_id,
    "reused Worker was not restored to its lane slot");
  assert.equal(reattached.registry.journal.at(-1).kind, "PROVISION_REATTACHED");

  const legacyWorkspace = path.join(tempRoot, "legacy-workspace");
  await fs.mkdir(legacyWorkspace, { recursive: true });
  fixtureScopes.set(legacyWorkspace, "goal_worker_test");
  const legacy1 = await workers.migrateLegacyLaneWorkers(legacyWorkspace, {
    A: {
      tab_instance_id: "legacy-tab-a",
      conversation_url: "https://chatgpt.com/c/legacy-a",
      adapter_version: "legacy-adapter",
      adapter_confidence: "high",
      composer_ready: false,
      generation_active: true,
      connection_interrupted: false,
      activity_revision: 1,
      last_seen_at: new Date(Date.now() - 1000).toISOString(),
    },
    B: null,
  }, "A");
  assert.equal(legacy1.workers["A:g1"].generation_active, true);
  assert.equal(legacy1.workers["A:g1"].bound_session_id, null);
  const legacy2 = await workers.migrateLegacyLaneWorkers(legacyWorkspace, {
    A: {
      tab_instance_id: "legacy-tab-a",
      conversation_url: "https://chatgpt.com/c/legacy-a",
      adapter_version: "legacy-adapter",
      adapter_confidence: "high",
      composer_ready: true,
      generation_active: false,
      connection_interrupted: false,
      activity_revision: 2,
      last_seen_at: new Date().toISOString(),
    },
    B: null,
  }, "A");
  assert.equal(legacy2.workers["A:g1"].generation_active, false);
  assert.equal(legacy2.workers["A:g1"].composer_ready, true);
  assert.equal(legacy2.workers["A:g1"].bound_session_id, null, "v1 telemetry refresh must never infer MCP authority");

  const now = Date.now();
  const staleLease = {
    schema_version: 1,
    lease_id: "lease_worker_test",
    goal_id: "goal_worker_test",
    owner_session_id: "session_source",
    epoch: 7,
    state: "ACTIVE",
    prepared_handoff_id: null,
    execution_contract_hash: "a".repeat(64),
    intent_revision: 1,
    acquired_at: new Date(now - 30 * 60_000).toISOString(),
    renewed_at: new Date(now - 30 * 60_000).toISOString(),
    expires_at: new Date(now - 10 * 60_000).toISOString(),
    updated_at: new Date(now - 10 * 60_000).toISOString(),
  };
  const observation = {
    lane_observed: true,
    lane_fresh: false,
    generation_active: false,
    tool_inflight_count: 0,
  };
  const noPolicy = driver.assessDriverOrphanRecovery(staleLease, {
    sourceSessionId: "session_source",
    targetSessionId: "session_target",
    explicitTakeoverAuthorized: false,
    observation,
  });
  assert.equal(noPolicy.eligible, false);
  assert.ok(noPolicy.reasons.includes("explicit_takeover_required"));

  const wrongPolicy = driver.assessDriverOrphanRecovery(staleLease, {
    sourceSessionId: "session_source",
    targetSessionId: "session_target",
    explicitTakeoverAuthorized: false,
    authorization: { kind: "RELAY_POLICY", policy_revision: 1, goal_id: "wrong_goal", enabled_at: new Date(now - 60_000).toISOString() },
    observation,
  });
  assert.equal(wrongPolicy.eligible, false);
  assert.ok(wrongPolicy.reasons.includes("explicit_takeover_required"));

  const validPolicy = driver.assessDriverOrphanRecovery(staleLease, {
    sourceSessionId: "session_source",
    targetSessionId: "session_target",
    explicitTakeoverAuthorized: false,
    authorization: { kind: "RELAY_POLICY", policy_revision: 1, goal_id: "goal_worker_test", enabled_at: new Date(now - 60_000).toISOString() },
    observation,
  });
  assert.equal(validPolicy.eligible, true, `expected policy-authorized recovery eligibility, got ${JSON.stringify(validPolicy)}`);

  const generationBusy = driver.assessDriverOrphanRecovery(staleLease, {
    sourceSessionId: "session_source",
    targetSessionId: "session_target",
    explicitTakeoverAuthorized: false,
    authorization: { kind: "RELAY_POLICY", policy_revision: 1, goal_id: "goal_worker_test", enabled_at: new Date(now - 60_000).toISOString() },
    observation: { ...observation, generation_active: true },
  });
  assert.equal(generationBusy.eligible, false);
  assert.ok(generationBusy.reasons.includes("browser_generation_active"));

  fixtureScopes.set(tempRoot, "goal_worker_test");
  const snapshot = await handoff.createHandoffSnapshot(tempRoot, {
    handoff_id: "hf_worker_lifecycle_0002",
    goal_id: "goal_worker_test",
    goal_revision: 12,
    source_session_id: "session_source",
    source_driver_epoch: 7,
    source_worker_id: "A:g1",
    source_generation: 1,
    target_worker_id: "B:g2",
    target_generation: 2,
    current_phase: "worker handoff",
    active_process_refs: ["process:p1"],
    completed_process_refs: ["process:p2"],
    operation_receipt_refs: ["operation:o1:succeeded"],
    pending_delivery_refs: ["command:c1"],
    verified_evidence_refs: ["e1"],
    do_not_repeat: ["operation:o1"],
    execution_contract_hash: "a".repeat(64),
    intent_revision: 1,
    execution_intent_json: "{}",
  });
  assert.equal(snapshot.schema_version, 2);
  assert.equal(snapshot.source_worker_id, "A:g1");
  assert.equal(snapshot.target_worker_id, "B:g2");
  const reread = await handoff.readHandoffSnapshot(tempRoot, snapshot.handoff_id);
  assert.equal(reread.target_generation, 2);
  assert.deepEqual(reread.do_not_repeat, ["operation:o1"]);

  console.log("worker lifecycle P0 tests passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
