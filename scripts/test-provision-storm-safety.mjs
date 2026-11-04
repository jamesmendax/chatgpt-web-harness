import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT)
  : path.join(root, "dist");
const importDist = (relativePath) => import(pathToFileURL(path.join(distRoot, relativePath)).href);
const testRoot = path.join(root, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(testRoot, "provision-storm-safety-"));
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

const envKeys = ["CODEX_HOME", "GOAL_WATCHDOG_ENABLED", "HARNESS_RELAY_ENABLED", "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_COMPANION_ENABLED", "HARNESS_COMPANION_TOKEN"];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.GOAL_WATCHDOG_ENABLED = "false";
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_ENABLED = "true";
process.env.HARNESS_COMPANION_TOKEN = "test-only-provision-storm-secret";

const relay = await importDist("lib/relay-manager.js");
const workers = await importDist("lib/worker-registry.js");
const { withRelayGoal } = await importDist("lib/relay-scope.js");
const { createRuntimeScope, runWithRuntimeScope } = await importDist("lib/runtime-scope.js");
const goalId = "goal_provision_storm";
const sessionId = "provision-storm-fixture-session";
const runtimeScope = Object.assign(createRuntimeScope(
  { workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId }
), { goalId, goalOwnerSessionId: sessionId });

try {
  await runWithRuntimeScope(runtimeScope, () => withRelayGoal(workspace, goalId, async () => {
  const requested = await workers.requestWorkerProvision(workspace, {
    lane: "B",
    goalId,
    reason: "fixture_initial_pool",
  });
  const firstCommand = await relay.enqueueWorkerProvisionCommand(
    workspace,
    requested.worker,
    requested.registry.revision
  );
  const claimed = await relay.claimCompanionCommand(workspace, "fixture-companion");
  assert.equal(claimed?.command_id, firstCommand.command_id);
  const sent = await relay.acknowledgeRelayCommand(
    workspace,
    firstCommand.command_id,
    "fixture-companion",
    "sent"
  );
  assert.equal(sent.state, "SENT");

  await relay.recordRelayLaneHeartbeat(workspace, {
    lane: requested.worker.lane,
    worker_id: requested.worker.worker_id,
    generation: requested.worker.generation,
    provision_id: requested.worker.provision_id,
    companion_instance_id: "fixture-companion",
    tab_instance_id: "fixture-tab-b-g1",
    conversation_url: "https://chatgpt.com/",
    adapter_version: "fixture-adapter-v2",
    adapter_confidence: "high",
    conversation_surface: "CHAT",
    composer_ready: true,
    generation_active: false,
    connection_interrupted: false,
    tool_activity_count: 0,
    activity_revision: 1,
  });
  const acknowledged = await relay.readRelayManagerState(workspace);
  assert.equal(
    acknowledged.commands.find((command) => command.command_id === firstCommand.command_id)?.state,
    "ACKED",
    "browser proof did not make the provision command durably terminal"
  );

  for (let poll = 0; poll < 50; poll += 1) {
    const duplicate = await relay.enqueueWorkerProvisionCommand(
      workspace,
      requested.worker,
      requested.registry.revision
    );
    assert.equal(duplicate.command_id, firstCommand.command_id,
      "an ACKED provision attempt generated a new command id");
  }
  const afterPolls = await relay.readRelayManagerState(workspace);
  const sameAttemptCommands = afterPolls.commands.filter((command) =>
    command.kind === "provision_worker" &&
    command.worker_id === requested.worker.worker_id &&
    command.provision_attempt_id === requested.worker.provision_attempt_id
  );
  assert.equal(sameAttemptCommands.length, 1,
    "repeated automation polls multiplied a completed provision attempt");

  const replacement = await workers.requestWorkerProvision(workspace, {
    lane: "B",
    goalId,
    reason: "fixture_replacement",
    forceNew: true,
  });
  await workers.transitionWorker(workspace, replacement.worker.worker_id, "FAILED", {
    detail: "fixture replacement failed",
  });
  const laneWithoutPointer = await workers.readWorkerRegistry(workspace);
  assert.equal(laneWithoutPointer.lanes.B.standby_worker_id, null);
  assert.equal(laneWithoutPointer.workers[requested.worker.worker_id].state, "READY_BLANK");

  for (let poll = 0; poll < 50; poll += 1) {
    const reused = await workers.requestWorkerProvision(workspace, {
      lane: "B",
      goalId,
      reason: "automatic_pool_repair",
    });
    assert.equal(reused.created, false);
    assert.equal(reused.worker.worker_id, requested.worker.worker_id);
    assert.equal(reused.registry.lanes.B.standby_worker_id, requested.worker.worker_id);
  }
  const afterRepair = await workers.readWorkerRegistry(workspace);
  assert.equal(afterRepair.lanes.B.next_generation, 3,
    "pool repair kept allocating new Worker generations after reattachment");
  assert.equal(Object.keys(afterRepair.workers).length, 2,
    "pool repair multiplied Worker records after reattachment");

  console.log("provision storm safety: ACK durability, detached Worker reattachment, and 50-poll duplicate suppression passed");
  }));
} finally {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
}
