import assert from "node:assert/strict";
import { getRelayGateStatus, relayAutomationEnabled, relayCompanionEnabled, relayAutoRecoveryEnabled } from "../dist/lib/relay-manager.js";
import { relayEnabled } from "../dist/lib/driver-lease.js";
import { readRelayControlStatus, prepareRelayHandoff } from "../dist/lib/relay-control.js";
import { withRelayGoal } from "../dist/lib/relay-scope.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const keys = [
  "HARNESS_RELAY_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED",
  "HARNESS_COMPANION_ENABLED",
  "HARNESS_RELAY_AUTO_RECOVERY_ENABLED",
];
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const checkedAt = new Date("2026-11-02T18:00:00.000Z");

function setGates({ relay, automation, companion, autoRecovery }) {
  process.env.HARNESS_RELAY_ENABLED = String(relay);
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED = String(automation);
  process.env.HARNESS_COMPANION_ENABLED = String(companion);
  process.env.HARNESS_RELAY_AUTO_RECOVERY_ENABLED = String(autoRecovery);
}

try {
  // Every legacy flag combination must remain disabled, including all-true.
  for (let mask = 0; mask < 16; mask++) {
    const gates = { relay: !!(mask & 1), automation: !!(mask & 2), companion: !!(mask & 4), autoRecovery: !!(mask & 8) };
    setGates(gates);
    const status = getRelayGateStatus(checkedAt);
    assert.deepEqual(Object.keys(status).sort(), ["checked_at", "ready", "reason_code"]);
    assert.equal(status.ready, false);
    assert.equal(status.reason_code, "RELAY_DISABLED");
    assert.equal(status.checked_at, checkedAt.toISOString());
    assert.equal(relayEnabled(), false);
    assert.equal(relayAutomationEnabled(), false);
    assert.equal(relayCompanionEnabled(), false);
    assert.equal(relayAutoRecoveryEnabled(), false);
  }
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-retired-gate-"));
  try {
    assert.deepEqual(await readRelayControlStatus(tmp), { enabled: false, driver_lease: null, prepared_handoff: null });
    await assert.rejects(withRelayGoal(tmp, "retired-goal", () => prepareRelayHandoff(tmp, "owner")), /RELAY_DISABLED/);
    assert.deepEqual(await fs.readdir(tmp), [], "disabled status and handoff must not write workspace state");
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
  console.log("relay-gate-status: all legacy flag combinations and handoff entrypoint remain disabled PASS");
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}