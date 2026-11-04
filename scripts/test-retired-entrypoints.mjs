import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-retired-entrypoints-"));
const keys = ["ADMIN_TOKEN", "CODEX_HOME", "HARNESS_RELAY_ENABLED", "HARNESS_RELAY_AUTOMATION_ENABLED",
  "HARNESS_COMPANION_ENABLED", "HARNESS_RELAY_AUTO_RECOVERY_ENABLED", "HARNESS_RECOVERY_SCOPE_MODE"];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let server;
try {
  process.env.CODEX_HOME = path.join(temp, "state");
  const token = randomBytes(24).toString("hex");
  process.env.ADMIN_TOKEN = token;
  delete process.env.HARNESS_RECOVERY_SCOPE_MODE;
  for (const key of keys.filter(key => /RELAY|COMPANION/.test(key))) process.env[key] = "true";
  const { startRelayAutomation, evaluateRelayAutomation } = await import("../dist/lib/relay-manager.js");
  const { withRelayGoal } = await import("../dist/lib/relay-scope.js");
  const originalInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setInterval = (...args) => { timers++; return originalInterval(...args); };
  try {
    const stop = startRelayAutomation(temp);
    assert.equal(timers, 0, "legacy flags cannot start provisioning timers");
    stop();
    const result = await withRelayGoal(temp, "retired-fixture-goal", () => evaluateRelayAutomation(temp));
    assert.equal(result.enabled, false);
    assert.equal(result.action, "disabled");
    assert.deepEqual(await fs.readdir(temp), [], "retired automation cannot create worker or browser state");
  } finally { globalThis.setInterval = originalInterval; }

  const { startAdminServer } = await import("../dist/admin/server.js");
  server = startAdminServer({ host: "127.0.0.1", port: 0, mcpPort: 0, pid: process.pid,
    workspaceRoot: temp, sessionCount: () => 0, manager: { listStatuses: async () => [] } });
  if (!server.listening) await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "x-admin-token": token, "content-type": "application/json" };
  const health = await fetch(base + "/health", { headers });
  assert.equal(health.status, 200, "valid Admin auth must reach the current router");
  assert.equal((await health.json()).name, "codex-mcp-admin");
  assert.equal((await fetch(base + "/companion/v1/heartbeat")).status, 401, "auth still runs first");
  for (const endpoint of ["/companion/v1", "/companion/v1/heartbeat", "/companion/v1/claim", "/companion/v2/heartbeat", "/companion/v2/commands/claim"]) {
    for (const method of ["GET", "POST"]) {
      const response = await fetch(base + endpoint, { headers, method, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 404, `${method} ${endpoint} with valid auth must be absent, not merely auth-blocked`);
      await response.text();
    }
  }
  console.log("retired-entrypoints: legacy flags create no automation timer/state; authenticated current Admin confirms Companion v1/v2 absent PASS");
} finally {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
