import { createRelayFixtureScope } from "./relay-fixture-scope.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT)
  : path.join(root, "dist");
const importDist = (file) => import(pathToFileURL(path.join(distRoot, file)).href);
const testRoot = path.join(root, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(testRoot, "relay-initial-driver-"));
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

const envKeys = ["CODEX_HOME", "HARNESS_RELAY_ENABLED", "HARNESS_COMPANION_ENABLED", "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_RELAY_AUTO_RECOVERY_ENABLED", "HARNESS_COMPANION_TOKEN", "GOAL_WATCHDOG_ENABLED"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.HARNESS_COMPANION_ENABLED = "true";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
process.env.HARNESS_RELAY_AUTO_RECOVERY_ENABLED = "true";
process.env.HARNESS_COMPANION_TOKEN = "test-only-initial-driver-binding-secret";
process.env.GOAL_WATCHDOG_ENABLED = "false";

const fixtureScopes = createRelayFixtureScope((await importDist("lib/relay-scope.js")).withRelayGoal);
const relay = fixtureScopes.wrap(await importDist("lib/relay-manager.js"));
const driver = fixtureScopes.wrap(await importDist("lib/driver-lease.js"));
const workers = fixtureScopes.wrap(await importDist("lib/worker-registry.js"));
const { createRuntimeScope, runWithRuntimeScope } = await importDist("lib/runtime-scope.js");
const { registerGoalTool } = await importDist("tools/goal.js");
const session = "initial-driver-owner-session";
const scope = createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId: session });

let goalTool;
registerGoalTool({ registerTool(name, config, callback) { if (name === "goal") goalTool = { config, callback }; } }, workspace);
const schema = z.object(goalTool.config.inputSchema);
const invokeGoal = (args) => runWithRuntimeScope(scope, () => goalTool.callback(schema.parse(args)));

try {
  const created = await invokeGoal({
    action: "create",
    objective: "Bind the first browser Worker to the current Goal Driver",
    success_criteria: [{ name: "initial Driver binding is proven" }],
    constraints: ["isolated fixture only"],
  });
  const goalId = created.structuredContent.data.goal.id;
  fixtureScopes.set(workspace, goalId);
  await driver.ensureDriverLease(workspace, {
    goalId,
    ownerSessionId: session,
    executionContractHash: "pending",
    intentRevision: 0,
  });

  // Model an authoritative Chat Driver on A and a freshly provisioned standby
  // on B. Both arrive through the same MCP session, reproducing the production
  // condition that previously let a bootstrap receipt steal Driver authority.
  await relay.recordRelayLaneHeartbeat(workspace, {
    lane: "A",
    tab_instance_id: "stale-a-tab",
    conversation_url: "https://chatgpt.com/c/stale-a",
    adapter_version: "test-v1",
    adapter_confidence: "high",
    conversation_surface: "CHAT",
    composer_ready: true,
    generation_active: true,
    connection_interrupted: false,
    activity_revision: 1,
  });
  const replacement = await relay.requestRelayLaneReplacement(workspace, "B", "initial_driver_fixture");
  const heartbeat = (generationActive, turnId = "bootstrap-turn-current-b") => relay.recordRelayLaneHeartbeat(workspace, {
    lane: "B",
    worker_id: replacement.worker.worker_id,
    generation: replacement.worker.generation,
    provision_id: replacement.worker.provision_id,
    companion_instance_id: "fixture-companion",
    tab_instance_id: "current-b-tab",
    conversation_url: "https://chatgpt.com/c/current-b",
    adapter_version: "test-v2",
    adapter_confidence: "high",
    conversation_surface: "CHAT",
    composer_ready: !generationActive,
    generation_active: generationActive,
    connection_interrupted: false,
    activity_revision: generationActive ? 2 : 3,
    turn_id: generationActive ? turnId : null,
    turn_started_at: generationActive ? new Date().toISOString() : null,
    stop_button_visible: generationActive,
  });
  await heartbeat(false);
  const readyRegistry = await workers.readWorkerRegistry(workspace);
  const queued = await relay.enqueueWorkerBootstrapCommand(workspace, {
    worker: readyRegistry.workers[replacement.worker.worker_id],
    registryRevision: readyRegistry.revision,
    goalId,
  });
  assert.match(queued.command_id, /^bootstrap_worker_/);
  const delivery = await relay.claimRelayCommand(workspace, "B", "current-b-tab", replacement.worker.worker_id);
  assert.match(delivery?.message || "", /goal\(action=status, handoff_id=/);
  assert.doesNotMatch(delivery?.message || "", /goal\(action=probe,/);
  assert.doesNotMatch(delivery?.message || "", /takeover_token=/);
  await relay.acknowledgeRelayCommand(workspace, delivery.command_id, "current-b-tab", "sent");
  await assert.rejects(
    () => relay.claimRelayBootstrapCapabilityFromBrowserReceipt(workspace, session, delivery.command_id),
    /BROWSER_RECEIPT_NOT_READY/,
    "an idle browser cannot satisfy capability proof"
  );
  await heartbeat(true);
  const proof = await invokeGoal({ action: "status", handoff_id: delivery.command_id });
  assert.equal(proof.structuredContent.data.capability_verified, true);
  assert.equal(proof.structuredContent.data.compatibility_alias, "status");
  assert.equal(proof.structuredContent.data.driver_authority, false,
    "same-session capability proof must never infer or adopt Driver authority");

  let registry = await workers.readWorkerRegistry(workspace);
  assert.equal(registry.workers[replacement.worker.worker_id].state, "READY");
  assert.equal(registry.workers[replacement.worker.worker_id].bound_session_id, session);
  assert.equal(registry.workers[replacement.worker.worker_id].goal_id, goalId,
    "bootstrap retains its explicit routing Goal without adopting Driver authority");
  assert.equal(registry.workers["A:g1"]?.state, "ACTIVE", "bootstrap retired the real Driver");
  assert.equal((await relay.readRelayManagerState(workspace)).active_lane, "A");
  assert.equal((await driver.readDriverLease(workspace))?.epoch, 1, "capability bootstrap changed the Driver epoch");

  await heartbeat(false);
  const provedRegistry = await workers.readWorkerRegistry(workspace);
  const refresh = await relay.enqueueWorkerBootstrapCommand(workspace, {
    worker: provedRegistry.workers[replacement.worker.worker_id],
    registryRevision: provedRegistry.revision,
    goalId,
  });
  assert.notEqual(refresh.command_id, delivery.command_id, "an ACKED bootstrap must not permanently suppress a later capability refresh");
  const refreshDelivery = await relay.claimRelayCommand(workspace, "B", "current-b-tab", replacement.worker.worker_id);
  await relay.acknowledgeRelayCommand(workspace, refreshDelivery.command_id, "current-b-tab", "sent");
  await heartbeat(true, "bootstrap-turn-current-b-refresh");
  const secondProof = await invokeGoal({ action: "status", handoff_id: refreshDelivery.command_id });
  assert.equal(secondProof.structuredContent.data.capability_verified, true);
  assert.equal(secondProof.structuredContent.data.driver_authority, false);
  registry = await workers.readWorkerRegistry(workspace);
  assert.equal(registry.workers["A:g1"]?.state, "ACTIVE", "repeated bootstrap receipt oscillated Driver authority");
  assert.equal(registry.workers[replacement.worker.worker_id].state, "READY");
  assert.equal((await relay.readRelayManagerState(workspace)).active_lane, "A");
  assert.equal((await driver.readDriverLease(workspace))?.epoch, 1);

  const cancelled = await invokeGoal({ action: "cancel" });
  assert.equal(cancelled.structuredContent.ok, true);
  assert.equal((await driver.readDriverLease(workspace))?.state, "RELEASED", "terminal Goal cleanup must release Driver authority");
  console.log("relay bootstrap authority fence: repeated same-session capability receipts kept A ACTIVE, B READY, and Driver epoch unchanged");
} finally {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}
