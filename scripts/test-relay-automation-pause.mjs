import { createRelayFixtureScope } from "./relay-fixture-scope.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = process.env.HARNESS_TEST_BROWSER_COMPANION_ROOT
  ? path.resolve(process.env.HARNESS_TEST_BROWSER_COMPANION_ROOT)
  : path.join(root, "browser-companion");
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT)
  : path.join(root, "dist");
const source = await fs.readFile(path.join(extensionRoot, "service-worker.js"), "utf8");
const start = source.indexOf("function planIdentityRecovery(");
const end = source.indexOf("function workerBindingMatchesTab(", start);
assert.ok(start >= 0 && end > start, "identity planner boundary missing");
const sandbox = { Date, Set };
vm.createContext(sandbox);
vm.runInContext(
  "const IDENTITY_STALE_MS = 45000; const IDENTITY_RETRY_MS = 300000;\n" + source.slice(start, end),
  sandbox
);
const now = Date.parse("2026-09-30T14:37:44.000Z");
const staleStatus = {
  automation_enabled: true,
  goal_id: "pause-fixture-goal",
  driver: { goal_id: "pause-fixture-goal", state: "ACTIVE" },
  control_plane: { state: "WAITING_CONTROL_PLANE", active_lane: "B", standby_lane: "A", standby_worker_id: "A:g24" },
  manager: { lanes: { A: { replacement_worker_id: "A:g24" } } },
  workers: { workers: { "A:g24": { state: "READY_BLANK", generation: 24, last_browser_seen_at: "2026-09-30T13:00:00.000Z" } } },
};
const results = [];
async function check(name, action) {
  try {
    await action();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, message: String(error.message).split("\n")[0] });
  }
}
for (const flag of [false, undefined, null, "true"]) {
  await check("client identity recovery requires positive automation: " + String(flag), () => {
    assert.equal(
      sandbox.planIdentityRecovery({ ...staleStatus, automation_enabled: flag }, {}, null, now),
      null,
      "paused or unknown automation must not request a replacement"
    );
  });
}
await check("enabled stale identity still recovers", () => {
  assert.equal(sandbox.planIdentityRecovery(staleStatus, {}, null, now)?.lane, "A");
});

const testBase = path.join(root, ".tool-test-tmp");
await fs.mkdir(testBase, { recursive: true });
const temporaryDirectory = await fs.mkdtemp(path.join(testBase, "automation-pause-"));
const envKeys = ["CODEX_HOME", "HARNESS_RELAY_ENABLED", "HARNESS_COMPANION_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_COMPANION_TOKEN"];
const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
Object.assign(process.env, {
  CODEX_HOME: path.join(temporaryDirectory, "fixture-codex-home"),
  HARNESS_RELAY_ENABLED: "true",
  HARNESS_COMPANION_ENABLED: "true",
  HARNESS_RELAY_AUTOMATION_ENABLED: "false",
  HARNESS_COMPANION_TOKEN: "test-only-pause-fixture",
});
try {
  const fixtureScopes = createRelayFixtureScope((await import(pathToFileURL(path.join(distRoot, "lib/relay-scope.js")).href)).withRelayGoal);
  const relay = fixtureScopes.wrap(await import(pathToFileURL(path.join(distRoot, "lib/relay-manager.js")).href));
  const workers = fixtureScopes.wrap(await import(pathToFileURL(path.join(distRoot, "lib/worker-registry.js")).href));
  let workspaceIndex = 0;
  async function workspace() {
    const result = path.join(temporaryDirectory, "workspace-" + workspaceIndex++);
    await fs.mkdir(result, { recursive: true });
    fixtureScopes.set(result, "pause-fixture-goal");
    return result;
  }
  async function snapshot(directory) {
    // Empty read projections manufacture an observed-at timestamp on each read.
    // Compare durable bytes/existence instead, so clock movement cannot mimic a write.
    const states = await Promise.all([
      relay.relayManagerPath(directory),
      workers.workerRegistryPath(directory),
    ].map(async file => {
      try { return await fs.readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }));
    return JSON.stringify(states);
  }
  const automaticReasons = ["companion_identity_storage_recovery", "automatic_pool_repair",
    "automatic_orphan_recovery", "risk_handoff_standby_unavailable"];
  for (const reason of automaticReasons) {
    await check("paused automatic replacement rejected before mutation: " + reason, async () => {
      const directory = await workspace();
      process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
      const before = await snapshot(directory);
      await assert.rejects(relay.requestRelayLaneReplacement(directory, "A", reason),
        /RELAY_AUTOMATION_PAUSED/, "automatic replacement must be denied before state creation");
      assert.equal(await snapshot(directory), before, "denied automatic request changed state");
    });
  }
  for (const reason of automaticReasons) {
    await check("queued automatic provision withheld while paused: " + reason, async () => {
      const directory = await workspace();
      process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
      const requested = await workers.requestWorkerProvision(directory, { lane: "A", reason });
      const command = await relay.enqueueWorkerProvisionCommand(directory, requested.worker, requested.registry.revision);
      process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
      const before = await snapshot(directory);
      assert.equal(await relay.claimCompanionCommand(directory, "pause-fixture"), null,
        "queued automatic provision escaped the pause gate");
      assert.equal(await snapshot(directory), before, "paused command polling mutated state");
      process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
      const claimed = await relay.claimCompanionCommand(directory, "pause-fixture");
      assert.equal(claimed?.command_id, command.command_id, "resume allocated a different command");
      assert.equal(claimed?.claim_count, 1);
    });
  }
  await check("already claimed automatic provision cannot be reclaimed after pause", async () => {
    const directory = await workspace();
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
    const requested = await workers.requestWorkerProvision(directory,
      { lane: "A", reason: "companion_identity_storage_recovery" });
    const command = await relay.enqueueWorkerProvisionCommand(directory, requested.worker, requested.registry.revision);
    assert.equal((await relay.claimCompanionCommand(directory, "pause-fixture"))?.command_id, command.command_id);
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
    const before = await snapshot(directory);
    assert.equal(await relay.claimCompanionCommand(directory, "pause-fixture"), null,
      "same-claimant replay escaped the pause gate");
    assert.equal(await snapshot(directory), before);
  });
  await check("explicit operator replacement still works while automation is paused", async () => {
    const directory = await workspace();
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
    const requested = await relay.requestRelayLaneReplacement(directory, "A", "operator_replace_from_companion");
    assert.equal((await relay.claimCompanionCommand(directory, "pause-fixture"))?.command_id, requested.command.command_id);
  });
  await check("unknown queued provision origin fails closed while paused", async () => {
    const directory = await workspace();
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
    const requested = await workers.requestWorkerProvision(directory, { lane: "A", reason: "operator_replace" });
    await relay.enqueueWorkerProvisionCommand(directory,
      { ...requested.worker, worker_id: "A:g99", generation: 99 },
      requested.registry.revision);
    const before = await snapshot(directory);
    assert.equal(await relay.claimCompanionCommand(directory, "pause-fixture"), null);
    assert.equal(await snapshot(directory), before);
  });
  await check("enabled automatic replacement still works", async () => {
    const directory = await workspace();
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
    const requested = await relay.requestRelayLaneReplacement(directory, "A", "companion_identity_storage_recovery");
    assert.equal((await relay.claimCompanionCommand(directory, "pause-fixture"))?.command_id, requested.command.command_id);
  });
  for (const kind of ["retire_worker", "close_retired_worker"]) {
    await check("cleanup command remains claimable while paused: " + kind, async () => {
      const directory = await workspace();
      process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
      const requested = await workers.requestWorkerProvision(directory, { lane: "A", reason: "automatic_pool_repair" });
      const automatic = await relay.enqueueWorkerProvisionCommand(directory, requested.worker, requested.registry.revision);
      const manager = await relay.readRelayManagerState(directory);
      const cleanup = { ...automatic, command_id: kind + "_pause_fixture", kind };
      // This is only a synthetic queue in the unique fixture directory.
      await fs.writeFile(relay.relayManagerPath(directory),
        JSON.stringify({ ...manager, commands: [...manager.commands, cleanup] }));
      assert.equal((await relay.claimCompanionCommand(directory, "pause-fixture"))?.command_id, cleanup.command_id);
      const after = await relay.readRelayManagerState(directory);
      assert.equal(after.commands.find(command => command.command_id === automatic.command_id)?.state, "PENDING");
    });
  }
} finally {
  for (const key of envKeys) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  const resolvedFixture = await fs.realpath(temporaryDirectory);
  const resolvedBase = await fs.realpath(testBase);
  assert.equal(path.dirname(resolvedFixture), resolvedBase, "refusing fixture cleanup outside exact test base");
  assert.ok(path.basename(resolvedFixture).startsWith("automation-pause-"));
  await fs.rm(resolvedFixture, { recursive: true, force: true });
}
const failed = results.filter(result => !result.passed);
console.log(JSON.stringify({ suite: "relay-automation-pause", checks: results.length,
  passed: results.length - failed.length, failed: failed.length, results }, null, 2));
if (failed.length) process.exitCode = 1;
