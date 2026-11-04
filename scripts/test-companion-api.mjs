import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.HARNESS_TEST_RUNTIME_ROOT
  ? path.resolve(process.env.HARNESS_TEST_RUNTIME_ROOT)
  : root;
const distEntry = process.env.HARNESS_TEST_DIST_ROOT
  ? path.join(path.resolve(process.env.HARNESS_TEST_DIST_ROOT), "index.js")
  : path.join(root, "dist", "index.js");
const tmp = path.join(root, ".tool-test-tmp", `companion-api-${process.pid}`);
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(path.join(tmp, "workspace"), { recursive: true });

// Reserve both ephemeral listeners together, instead of guessing a port that
// may already belong to another application on the developer's computer.
const reservations = [];
let mcpPort, adminPort;
try {
  for (let i = 0; i < 2; i++) {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    reservations.push(server);
  }
  [mcpPort, adminPort] = reservations.map(server => server.address().port);
} finally {
  await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
}
const adminToken = "test-admin-token-separate";
const companionToken = "test-companion-token-separate";
const companionInstance = "cpi_test_companion_instance";
const capabilityFile = path.join(tmp, "companion-capability.json");
await fs.writeFile(capabilityFile, JSON.stringify({
  schema_version: 1,
  account_id: "default",
  instance_id: companionInstance,
  token: companionToken,
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
}));
const env = {
  ...process.env,
  PORT: String(mcpPort),
  ADMIN_PORT: String(adminPort),
  ADMIN_TOKEN: adminToken,
  HARNESS_RELAY_ENABLED: "true",
  HARNESS_COMPANION_ENABLED: "true",
  HARNESS_RELAY_AUTOMATION_ENABLED: "false",
  HARNESS_COMPANION_TOKEN: companionToken,
  HARNESS_COMPANION_CAPABILITY_FILE: capabilityFile,
  GOAL_WATCHDOG_ENABLED: "false",
  CHATGPT_TOOL_PROFILE: "slim",
  WORKSPACE_PATH: path.join(tmp, "workspace"),
  CHATGPT_PLUGINS_CONFIG: path.join(tmp, "plugins.json"),
  MCP_UPSTREAM_CONFIG: path.join(tmp, "upstream.json"),
  MCP_SHELL_STATE_DIR: path.join(tmp, "shell-state"),
  CODEX_HOME: path.join(tmp, "codex-home"),
};
const child = spawn(process.execPath, [distEntry], { cwd: runtimeRoot, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });

async function waitFor(url, init = {}, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 503 || log.includes("Admin API:")) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout ${url}\n${log.slice(-3000)}`);
}

async function json(url, init = {}) {
  const response = await waitFor(url, init);
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { response, body };
}

const base = `http://127.0.0.1:${adminPort}/companion/v1`;
const headers = { "x-companion-token": companionToken, "x-companion-instance": companionInstance, "x-relay-goal-id": "companion-api-goal" };

try {
  const gateStatus = await json(`${base}/gate-status`);
  assert.equal(gateStatus.response.status, 200, "safe gate status must not require a Goal or Companion bearer");
  assert.deepEqual(Object.keys(gateStatus.body).sort(), ["gate_status", "ok"]);
  assert.equal(gateStatus.body.ok, true);
  assert.deepEqual(Object.keys(gateStatus.body.gate_status).sort(), ["checked_at", "ready", "reason_code"]);
  assert.equal(gateStatus.body.gate_status.ready, false);
  assert.equal(gateStatus.body.gate_status.reason_code, "RELAY_AUTOMATION_DISABLED");
  assert.ok(Number.isFinite(Date.parse(gateStatus.body.gate_status.checked_at)));
  assert.equal(JSON.stringify(gateStatus.body).includes(companionToken), false);
  assert.equal(JSON.stringify(gateStatus.body).includes("goal_id"), false);

  const discovery = await json(`${base}/status`, { headers: { "x-companion-token": companionToken, "x-companion-instance": companionInstance } });
  assert.equal(discovery.body.discovery_only, true);
  assert.equal(discovery.body.driver, null);
  const noScopeSync = await json(`${base}/sync?companion_instance_id=scope-fixture`, { headers: { "x-companion-token": companionToken, "x-companion-instance": companionInstance } });
  assert.equal(noScopeSync.response.status, 409, "unscoped sync cannot select a Goal automatically");
  const mismatchedScope = await json(`${base}/lanes/A/replace`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ goal_id: "different-goal", reason: "operator_replace" }) });
  assert.equal(mismatchedScope.response.status, 409, "conflicting Goal selectors must fail before a mutation");
  const noToken = await json(`${base}/status`);
  assert.equal(noToken.response.status, 401);
  const wrongToken = await json(`${base}/status`, { headers: { "x-companion-token": "wrong-companion-token-value" } });
  assert.equal(wrongToken.response.status, 401);
  const missingInstance = await json(`${base}/status`, { headers: { "x-companion-token": companionToken } });
  assert.equal(missingInstance.response.status, 401);

  const badOrigin = await json(`${base}/status`, {
    headers: { ...headers, Origin: "https://evil.example" },
  });
  assert.equal(badOrigin.response.status, 403, "ordinary web origins must not reach loopback companion APIs");

  const extensionOrigin = "chrome-extension://abcdefghijklmnoabcdefghijklmnop";
  const preflight = await waitFor(`${base}/lanes/A/heartbeat`, {
    method: "OPTIONS",
    headers: {
      Origin: extensionOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-companion-token,x-companion-instance",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), extensionOrigin);

  const heartbeatA = await json(`${base}/lanes/A/heartbeat`, {
    method: "POST",
    headers: { ...headers, Origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({
      tab_instance_id: "companion-tab-a",
      conversation_url: "https://chatgpt.com/c/fixture-a",
      adapter_version: "fixture-v1",
      adapter_confidence: "high",
      conversation_surface: "CHAT",
      composer_ready: false,
      generation_active: true,
      connection_interrupted: false,
      tool_inflight_count: 1,
      tool_activity_count: 7,
      activity_revision: 4,
      turn_id: "turn-companion-a",
      turn_started_at: "2026-09-14T10:00:00.000Z",
      stop_button_visible: true,
      retry_visible: false,
      assistant_token_revision: 12,
    }),
  });
  assert.equal(heartbeatA.response.status, 200);
  assert.equal(heartbeatA.body.ok, true);
  assert.equal(heartbeatA.body.active_lane, "A");

  const heartbeatB = await json(`${base}/lanes/B/heartbeat`, {
    method: "POST",
    headers: { ...headers, Origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({
      tab_instance_id: "companion-tab-b",
      conversation_url: "https://chatgpt.com/c/fixture-b",
      adapter_version: "fixture-v1",
      adapter_confidence: "medium",
      conversation_surface: "CHAT",
      composer_ready: true,
      generation_active: false,
      connection_interrupted: false,
      tool_inflight_count: 0,
      tool_activity_count: 0,
      activity_revision: 1,
      turn_id: "turn-companion-b",
      turn_started_at: "2026-09-14T10:01:00.000Z",
      stop_button_visible: false,
      retry_visible: false,
      assistant_token_revision: 0,
      feedback_ledger: {
        schema_version: 1,
        turn_id: "turn-companion-b",
        turn_started_at_ms: Date.parse("2026-09-14T10:01:00.000Z"),
        observed_at_ms: Date.parse("2026-09-14T10:01:00.020Z"),
        text_revision: 0,
        signals: {
          assistant_text_emitted: { status: "unavailable", source: "host_callback", reason_code: "host_emission_callback_unavailable", event_time_ms: null },
          assistant_text_rendered: { status: "observed", source: "dom_observation", event_time_ms: Date.parse("2026-09-14T10:01:00.010Z"), revision: 0, signature: "7:answer" },
          execution_activity: { status: "observed", source: "dom_mutation_observer", event_time_ms: Date.parse("2026-09-14T10:01:00.015Z"), mutation_revision: 1, execution_revision: 1, generation_active: false, tool_inflight_count: 0, composer_mutations_excluded: true },
          transport_state: { status: "observed", source: "browser_companion_api_ack", state: "online", event_time_ms: Date.parse("2026-09-14T10:01:00.018Z"), revision: 1 },
        },
      },
    }),
  });
  assert.equal(heartbeatB.response.status, 200);

  const bFeedbackLedger = heartbeatB.body.lane.observation.feedback_ledger;
  assert.equal(bFeedbackLedger?.turn_id, "turn-companion-b");
  const statusBeforeInvalidLedger = await json(`${base}/status`, { headers });
  const invalidLedger = structuredClone(bFeedbackLedger);
  invalidLedger.observed_at_ms += 1;
  invalidLedger.signals.assistant_text_rendered.event_time_ms = invalidLedger.observed_at_ms + 1;
  const invalidLedgerHeartbeat = await json(`${base}/lanes/B/heartbeat`, {
    method: "POST",
    headers: { ...headers, Origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({
      tab_instance_id: "companion-tab-b",
      conversation_url: "https://chatgpt.com/c/fixture-b",
      adapter_version: "fixture-v1",
      conversation_surface: "CHAT",
      composer_ready: true,
      generation_active: false,
      connection_interrupted: false,
      activity_revision: 2,
      turn_id: "turn-companion-b",
      turn_started_at: "2026-09-14T10:01:00.000Z",
      feedback_ledger: invalidLedger,
    }),
  });
  assert.equal(invalidLedgerHeartbeat.response.status, 400);
  const statusAfterInvalidLedger = await json(`${base}/status`, { headers });
  assert.equal(statusAfterInvalidLedger.body.manager.revision, statusBeforeInvalidLedger.body.manager.revision,
    "invalid legacy ledger must not partially advance Relay Manager state");

  const nextLegacyTurn = await json(`${base}/lanes/B/heartbeat`, {
    method: "POST",
    headers: { ...headers, Origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({
      tab_instance_id: "companion-tab-b",
      conversation_url: "https://chatgpt.com/c/fixture-b",
      adapter_version: "fixture-v1",
      conversation_surface: "CHAT",
      composer_ready: true,
      generation_active: false,
      connection_interrupted: false,
      activity_revision: 1,
      turn_id: "turn-companion-b-next",
      turn_started_at: "2026-09-14T10:02:00.000Z",
    }),
  });
  assert.equal(nextLegacyTurn.response.status, 200);
  assert.equal(nextLegacyTurn.body.lane.observation.feedback_ledger, undefined,
    "a new legacy turn without a snapshot must clear the previous turn ledger");
  const delayedOldTurn = await json(`${base}/lanes/B/heartbeat`, {
    method: "POST",
    headers: { ...headers, Origin: extensionOrigin, "content-type": "application/json" },
    body: JSON.stringify({
      tab_instance_id: "companion-tab-b",
      conversation_url: "https://chatgpt.com/c/fixture-b",
      adapter_version: "fixture-v1",
      conversation_surface: "CHAT",
      composer_ready: true,
      generation_active: false,
      connection_interrupted: false,
      activity_revision: 2,
      turn_id: "turn-companion-b-next",
      turn_started_at: "2026-09-14T10:02:00.000Z",
      feedback_ledger: bFeedbackLedger,
    }),
  });
  assert.equal(delayedOldTurn.response.status, 200);
  assert.equal(delayedOldTurn.body.lane.observation.feedback_ledger, undefined,
    "a delayed prior-turn ledger must not be restored by the legacy lane path");

  const status = await json(`${base}/status`, { headers });
  assert.equal(status.response.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.automation_enabled, false);
  assert.equal(status.body.control_plane.state, "IDLE");
  assert.equal(status.body.control_plane.standby_state, "ABSENT");
  assert.equal(status.body.manager.lanes.A.tab_instance_id, "companion-tab-a");
  assert.equal(status.body.manager.lanes.B.tab_instance_id, "companion-tab-b");
  assert.equal(status.body.manager.lanes.A.conversation_surface, "CHAT");
  assert.equal(status.body.manager.lanes.B.conversation_surface, "CHAT");
  assert.equal(status.body.manager.lanes.A.turn_id, "turn-companion-a");
  assert.equal(statusBeforeInvalidLedger.body.manager.lanes.B.feedback_ledger?.turn_id, "turn-companion-b",
    "legacy lane fallback heartbeats must retain the validated feedback ledger");
  assert.equal(statusBeforeInvalidLedger.body.manager.lanes.B.feedback_ledger?.signals.assistant_text_emitted.status, "unavailable");
  assert.equal(status.body.manager.lanes.A.stop_button_visible, true);
  assert.equal(status.body.manager.lanes.A.assistant_token_revision, 12);
  assert.equal(status.body.manager.lanes.A.tool_inflight_count, 1);
  assert.equal(status.body.manager.lanes.A.stable_observation_windows, 0);
  const statusText = JSON.stringify(status.body);
  assert.equal(statusText.includes("execution_contract_hash"), false, "companion status must not expose the Execution Contract hash");
  assert.equal(statusText.includes("owner_session_id"), false, "companion status must not expose ChatGPT session ownership identifiers");
  assert.equal(statusText.includes("bound_session_id"), false, "companion status must not expose Worker session bindings");
  assert.equal(statusText.includes("claim_session_id"), false, "companion status must not expose Worker claim session bindings");
  assert.equal(statusText.includes("claim_token_hash"), false, "companion status must not expose Worker claim token hashes");
  assert.equal(statusText.includes("claim_nonce"), false, "companion status must not expose Worker claim nonces");

  const v2Base = `http://127.0.0.1:${adminPort}/companion/v2`;
  const beforePausedIdentity = await json(`${v2Base}/status`, { headers });
  const pausedIdentity = await json(`${v2Base}/lanes/A/replace`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ reason: "companion_identity_storage_recovery" }),
  });
  assert.equal(pausedIdentity.response.status, 409, "a paused automatic replacement must not be accepted");
  assert.match(pausedIdentity.body.error, /^RELAY_AUTOMATION_PAUSED:/);
  const afterPausedIdentity = await json(`${v2Base}/status`, { headers });
  assert.equal(afterPausedIdentity.body.manager.revision, beforePausedIdentity.body.manager.revision);
  assert.equal(afterPausedIdentity.body.workers.revision, beforePausedIdentity.body.workers.revision,
    "HTTP rejection must happen before Worker mutation");

  const noCommand = await json(`${base}/lanes/B/command?tab_instance_id=companion-tab-b`, { headers });
  assert.equal(noCommand.response.status, 200);
  assert.equal(noCommand.body.command, null);

  // The Companion bearer is intentionally different from ADMIN_TOKEN and must
  // not authorize broad Admin API access.
  const companionAgainstAdmin = await json(`http://127.0.0.1:${adminPort}/health`, { headers });
  assert.equal(companionAgainstAdmin.response.status, 401);
  const adminHealth = await json(`http://127.0.0.1:${adminPort}/health`, { headers: { "x-admin-token": adminToken } });
  assert.equal(adminHealth.response.status, 200);

  const rotatedToken = "rotated-companion-token-separate";
  const rotatedInstance = "cpi_test_companion_rotated";
  await fs.writeFile(capabilityFile, JSON.stringify({
    schema_version: 1,
    account_id: "default",
    instance_id: rotatedInstance,
    token: rotatedToken,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  }));
  const staleCapability = await json(`${base}/status`, { headers });
  assert.equal(staleCapability.response.status, 401, "a rotated bearer must revoke the old Desktop instance immediately");
  const rotatedCapability = await json(`${base}/status`, {
    headers: { "x-companion-token": rotatedToken, "x-companion-instance": rotatedInstance },
  });
  assert.equal(rotatedCapability.response.status, 200);
  await fs.writeFile(capabilityFile, JSON.stringify({
    schema_version: 1,
    account_id: "default",
    instance_id: rotatedInstance,
    token: rotatedToken,
    issued_at: new Date(Date.now() - 120_000).toISOString(),
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  }));
  const expiredCapability = await json(`${base}/status`, {
    headers: { "x-companion-token": rotatedToken, "x-companion-instance": rotatedInstance },
  });
  assert.equal(expiredCapability.response.status, 401);

  console.log("companion-api: separate bearer, extension-only CORS, lane heartbeat, narrow status, empty command polling, and Admin isolation passed");
} finally {
  child.kill();
  await new Promise((resolve) => child.once("close", resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}
