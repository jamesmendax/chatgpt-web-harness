/**
 * Isolated HTTP and background-entry regression for the RI preview.
 * All network listeners use loopback ephemeral ports; all write-capable routes
 * are exercised only while cwd is a disposable fixture. No live service.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { startAdminServer } from "../dist/admin/server.js";
import { createAdminRouter } from "../dist/admin/routes.js";
import { createCompanionRouter } from "../dist/admin/companion.js";
import { startRelayAutomation } from "../dist/lib/relay-manager.js";
import { startServiceRecoverySupervisor, stopServiceRecoverySupervisor } from "../dist/lib/service-recovery-supervisor.js";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ri-non-mcp-"));
const oldCwd = process.cwd();
const keys = [
  "HARNESS_RECOVERY_SCOPE_MODE", "HARNESS_RECOVERY_ISOLATED",
  "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_RECOVERY_SUPERVISOR_ENABLED",
  "ADMIN_TOKEN", "HARNESS_COMPANION_TOKEN", "RI_TEST_ENV_MUTATION",
];
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const servers = [];
let oauthCalls = 0, adminStatusCalls = 0;
const manager = {
  listStatuses: async () => { adminStatusCalls++; return []; },
  finishOAuth: async () => { oauthCalls++; return { tool_count: 1 }; },
  getConfig: () => ({ version: 1, servers: [] }),
  getConfigPath: () => path.join(directory, "mcp-upstream.json"),
};
async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const opened = app.listen(0, "127.0.0.1");
    opened.once("listening", () => resolve(opened));
    opened.once("error", reject);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const closeServer = server => new Promise((resolve, reject) =>
  server.close(error => error ? reject(error) : resolve()));
async function responseAt(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  let json;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}
const denied = (res, label) => {
  assert.equal(res.status, 423, `${label} unexpectedly reached its handler: ${JSON.stringify(res)}`);
  assert.equal(res.json?.error, "RI_NON_MCP_BLOCKED", label);
};
const checks = [];
try {
  process.chdir(directory);
  process.env.HARNESS_RECOVERY_SCOPE_MODE = "scoped_write_v1";
  process.env.HARNESS_RECOVERY_ISOLATED = "1";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
  process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED = "false";
  delete process.env.ADMIN_TOKEN;
  delete process.env.HARNESS_COMPANION_TOKEN;
  delete process.env.RI_TEST_ENV_MUTATION;

  const full = startAdminServer({
    host: "127.0.0.1", port: 0, mcpPort: 0, pid: process.pid, manager,
    workspaceRoot: directory, sessionCount: () => 0,
  });
  servers.push(full);
  if (!full.listening) await new Promise(resolve => full.once("listening", resolve));
  const base = `http://127.0.0.1:${full.address().port}`;

  // HTTPS OAuth redirect and Companion sync/claim paths use GET yet mutate.
  // The guard must run before localhost auth, OAuth or Goal/Worker selection.
  denied(await responseAt(`${base}/oauth/callback/mock-provider?code=fixture-code&state=fixture-state`), "GET OAuth callback");
  denied(await responseAt(`${base}/companion/v2/sync?goal_id=fixture-goal&companion_instance_id=fixture-companion`), "GET Companion sync claim");
  denied(await responseAt(`${base}/companion/v1/lanes/A/command?goal_id=fixture-goal&tab_instance_id=fixture-tab`), "GET Companion relay command claim");
  denied(await responseAt(`${base}/companion/v2/workers/fixture/command?goal_id=fixture-goal&tab_instance_id=fixture-tab`), "GET Companion worker command claim");
  denied(await responseAt(`${base}/companion/v1/gate-status`), "GET companion diagnostic");
  denied(await responseAt(`${base}/api/config/env`, "PUT", { values: { RI_TEST_ENV_MUTATION: "unsafe" } }), "PUT admin environment");
  denied(await responseAt(`${base}/companion/v1/commands/fixture/ack`, "POST", { status: "sent" }), "POST relay ack");
  denied(await responseAt(`${base}/companion/v1/lanes/A/replace`, "POST", { reason: "operator_replace" }), "POST worker replacement");
  assert.equal(oauthCalls, 0);
  assert.equal(adminStatusCalls, 0);
  assert.equal(process.env.RI_TEST_ENV_MUTATION, undefined);
  await assert.rejects(() => fs.readFile(path.join(directory, ".env")), { code: "ENOENT" });
  checks.push("real Admin server denies OAuth GET, Companion GET claims/POST and config PUT before effects");

  // Direct-router consumers must not bypass the full server's top-level guard.
  const app = express();
  app.use(express.json());
  app.use("/admin", createAdminRouter(manager, {
    mcpPort: 0, pid: process.pid, sessionCount: () => 0, workspaceRoot: directory,
  }));
  app.use("/companion", createCompanionRouter(directory));
  const direct = await listen(app);
  denied(await responseAt(`${direct}/admin/health`), "direct Admin router health GET");
  denied(await responseAt(`${direct}/admin/api/config/env`, "PUT", { values: { RI_TEST_ENV_MUTATION: "unsafe" } }), "direct Admin router config PUT");
  denied(await responseAt(`${direct}/companion/gate-status`), "direct Companion router status GET");
  denied(await responseAt(`${direct}/companion/sync?companion_instance_id=fixture`), "direct Companion router sync GET");
  assert.equal(adminStatusCalls, 0);
  assert.equal(process.env.RI_TEST_ENV_MUTATION, undefined);
  checks.push("direct Admin and Companion router constructors enforce the same strict fence");

  // Neither a disabled launcher nor a start/stop entry may be taken over by
  // the strict preview. Using disabled fixture flags keeps the RED baseline
  // side-effect-free (no intervals or detached process).
  assert.throws(() => startRelayAutomation(directory), /RI_NON_MCP_BLOCKED/);
  await assert.rejects(() => startServiceRecoverySupervisor(directory), /RI_NON_MCP_BLOCKED/);
  await assert.rejects(() => stopServiceRecoverySupervisor(directory), /RI_NON_MCP_BLOCKED/);
  checks.push("relay automation and service recovery supervisor entry points deny strict mode");

  // Explicitly enabled flags must not change the result: guard precedes the
  // timer and detached guardian spawn, not merely the disabled fallback.
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "true";
  process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED = "true";
  assert.throws(() => startRelayAutomation(directory), /RI_NON_MCP_BLOCKED/);
  await assert.rejects(() => startServiceRecoverySupervisor(directory), /RI_NON_MCP_BLOCKED/);
  await assert.rejects(() => stopServiceRecoverySupervisor(directory), /RI_NON_MCP_BLOCKED/);
  checks.push("enabled background operations are fenced before timer or detached-process launch");

  // When RI is off, retain the original read and OAuth callback behavior;
  // the preview guard must not alter default service semantics.
  process.env.HARNESS_RECOVERY_SCOPE_MODE = "off";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
  process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED = "false";
  const liveStatus = await responseAt(`${base}/health`);
  assert.equal(liveStatus.status, 200, JSON.stringify(liveStatus));
  const liveOAuth = await responseAt(`${base}/oauth/callback/mock-provider?code=fixture-code&state=fixture-state`);
  assert.equal(liveOAuth.status, 200, JSON.stringify(liveOAuth));
  assert.equal(oauthCalls, 1);
  const companionStatus = await responseAt(`${base}/companion/v1/gate-status`);
  assert.equal(companionStatus.status, 200, JSON.stringify(companionStatus));
  const directHealth = await responseAt(`${direct}/admin/health`);
  assert.equal(directHealth.status, 200, JSON.stringify(directHealth));
  const directCompanion = await responseAt(`${direct}/companion/gate-status`);
  assert.equal(directCompanion.status, 200, JSON.stringify(directCompanion));
  const ordinaryAdminWrite = await responseAt(`${base}/api/config/env`, "PUT", {
    values: { RI_TEST_ENV_MUTATION: "allowed-in-default-off-mode" },
  });
  assert.equal(ordinaryAdminWrite.status, 200, JSON.stringify(ordinaryAdminWrite));
  assert.equal(process.env.RI_TEST_ENV_MUTATION, "allowed-in-default-off-mode");
  assert.match(await fs.readFile(path.join(directory, ".env"), "utf8"), /RI_TEST_ENV_MUTATION=allowed-in-default-off-mode/);
  const ordinaryRelayStopper = startRelayAutomation(directory);
  assert.equal(typeof ordinaryRelayStopper, "function");
  ordinaryRelayStopper();
  const ordinarySupervisor = await startServiceRecoverySupervisor(directory);
  assert.equal(ordinarySupervisor.enabled, false);
  assert.equal(ordinarySupervisor.running, false);
  checks.push("default-off Admin, direct router, Companion and OAuth behavior remains available");

  // In a shared server booted with RI off, the Admin config setter must NOT
  // change protected control variables at runtime. Otherwise strict mode
  // could be turned on after the only full-server startup refusal already ran,
  // leaving previously launched background effects outside the new fence.
  for (const key of [
    "HARNESS_RECOVERY_SCOPE_MODE", "harness_recovery_scope_mode",
    "HARNESS_RECOVERY_ISOLATED", "HARNESS_RECOVERY_HMAC_KEY",
    "HARNESS_RECOVERY_GRANT_FILE", "HARNESS_RECOVERY_HEAD_PATH",
    "HARNESS_RECOVERY_ATTESTATION_FILE",
  ]) {
    const attempt = await responseAt(`${base}/api/config/env`, "PUT", {
      values: { [key]: key.toLowerCase().includes("scope_mode") ? "scoped_write_v1" : "fixture-invalid-control" },
    });
    assert.equal(attempt.status, 409, `Admin accepted protected RI control ${key}: ${JSON.stringify(attempt)}`);
    assert.equal(attempt.json?.error, "RI_CONTROL_PLANE_IMMUTABLE");
  }
  assert.equal(process.env.HARNESS_RECOVERY_SCOPE_MODE, "off");
  assert.equal(process.env.HARNESS_RECOVERY_HMAC_KEY, prior.HARNESS_RECOVERY_HMAC_KEY);
  assert.doesNotMatch(await fs.readFile(path.join(directory, ".env"), "utf8"), /HARNESS_RECOVERY_SCOPE_MODE|harness_recovery_scope_mode|HARNESS_RECOVERY_HMAC_KEY/);
  checks.push("Admin cannot activate RI or replace operator controls after full-server startup");

  // Unknown strict-mode values fail closed rather than selecting an
  // accidentally permissive HTTP profile.
  process.env.HARNESS_RECOVERY_SCOPE_MODE = "unexpected-mode";
  denied(await responseAt(`${base}/oauth/callback/mock-provider?code=fixture-code`), "invalid-mode OAuth");
  denied(await responseAt(`${direct}/admin/health`), "invalid-mode direct Admin");
  assert.equal(oauthCalls, 1);
  checks.push("unknown strict-mode configuration fails closed");

  console.log(`Recovery non-MCP ingress PASS: ${checks.length} groups`);
  for (const check of checks) console.log(`  PASS ${check}`);
} finally {
  for (const server of servers.reverse()) await closeServer(server).catch(() => undefined);
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(oldCwd);
  await fs.rm(directory, { recursive: true, force: true });
}
