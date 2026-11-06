// Real Windows helper + fresh MCP registrations. Only read-only status,
// target metadata and close are requested; native screenshot/input acceptance
// lives in test-computer-use-native-input.mjs and is never part of this suite.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import isolation from "../desktop/scripts/lib/test-isolation.cjs";

if (process.argv.includes("--native-input")) throw new Error("Use test-computer-use-native-input.mjs for separately authorized native input acceptance");
if (process.platform !== "win32") throw new Error("Computer Use provider integration requires Windows; no silent skip is permitted");
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.resolve(process.env.HARNESS_TEST_RUNTIME_ROOT || sourceRoot);
const distRoot = path.resolve(process.env.HARNESS_TEST_DIST_ROOT || path.join(sourceRoot, "dist"));
const tmp = isolation.artifactRoot("computer-use-provider");
const helper = path.join(runtimeRoot, "bundled-plugins", "computer-use", "windows-action.ps1");
const capabilityFile = path.join(tmp, "account", "capability.json"), auditLog = path.join(tmp, "account", "computer-use.audit.jsonl");
const token = crypto.randomBytes(32).toString("base64url"), accountId = "a".repeat(32);
const instanceId = "cui_" + crypto.randomBytes(16).toString("hex");
const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(helper)).digest("hex");
function record(expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()) {
  return { schema_version: 1, provider: "computer-use", account_id: accountId, instance_id: instanceId,
    token, issued_at: new Date().toISOString(), expires_at: expiresAt, helper_sha256: helperSha256 };
}
const environment = {
  HARNESS_COMPUTER_USE_CAPABILITY_FILE: capabilityFile, HARNESS_COMPUTER_USE_HELPER: helper,
  HARNESS_COMPUTER_USE_HELPER_SHA256: helperSha256, HARNESS_COMPUTER_USE_TOKEN: token,
  HARNESS_COMPUTER_USE_INSTANCE_ID: instanceId, HARNESS_COMPUTER_USE_AUDIT_LOG: auditLog, HARNESS_ACCOUNT_ID: accountId,
  CODEX_HOME: path.join(tmp, "runtime"), AUDIT_LOG_PATH: path.join(tmp, "harness.audit.jsonl"),
  MCP_SHELL_STATE_DIR: path.join(tmp, "shell"), MCP_UPSTREAM_CONFIG: path.join(tmp, "upstream.json"),
  CHATGPT_PLUGINS_CONFIG: path.join(tmp, "plugins.json"), CHATGPT_TOOL_PROFILE: "full",
  HARNESS_RELAY_ENABLED: "false", HARNESS_RELAY_AUTOMATION_ENABLED: "false", HARNESS_COMPANION_ENABLED: "false", GOAL_WATCHDOG_ENABLED: "false",
};
const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
await fs.mkdir(path.dirname(capabilityFile), { recursive: true });
await fs.writeFile(capabilityFile, JSON.stringify(record()));
await fs.writeFile(environment.CHATGPT_PLUGINS_CONFIG, JSON.stringify({ schema_version: 2, computer_use: { enabled: true }, browser_use: { enabled: false }, skills: [] }));
await fs.writeFile(environment.MCP_UPSTREAM_CONFIG, JSON.stringify({ version: 1, servers: [] }));
Object.assign(process.env, environment);
const transports = new Set(), checks = [];
let calls = 0;
try {
  const { createMcpServer } = await import(pathToFileURL(path.join(distRoot, "server-factory.js")).href);
  const conversation = "read-only-computer-use-" + crypto.randomUUID();
  async function execute(request, conversationId = conversation) {
    // An allow-list at the test dispatch boundary prevents accidental additions
    // of any screenshot, mouse, keyboard, application-selection or window-list call.
    assert.ok(["status", "select_target", "close"].includes(request.action));
    if (request.action === "select_target") assert.ok(request.target === "desktop" || request.hwnd === "0");
    const server = createMcpServer(tmp, 30_000, [tmp], false);
    const client = new Client({ name: "read-only-computer-use", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = crypto.randomUUID(); transports.add(serverTransport.sessionId); calls++;
    try {
      await server.connect(serverTransport); await client.connect(clientTransport);
      const result = await client.callTool({ name: "computer_use", arguments: request, _meta: { "openai/session": conversationId } });
      if (result.isError || result.structuredContent?.ok !== true) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Computer Use failed");
      return result.structuredContent.data;
    } finally { await client.close().catch(() => {}); await server.close().catch(() => {}); }
  }
  const status = await execute({ action: "status" });
  assert.equal(status.provider, "harness-windows-native"); assert.equal(status.protocol_version, 1);
  assert.equal(status.helper_version, "1.0.0"); assert.ok(status.provider_instance_id);
  assert.equal(status.selected_target, null); assert.ok(status.desktop.width > 0 && status.desktop.height > 0);
  checks.push("real pinned Windows helper status and capability");
  await execute({ action: "select_target", target: "desktop" });
  const retained = await execute({ action: "status" });
  assert.equal(retained.provider_instance_id, status.provider_instance_id);
  assert.deepEqual(retained.selected_target, { kind: "desktop" });
  assert.equal((await execute({ action: "status" }, conversation + "-other")).selected_target, null);
  assert.deepEqual((await execute({ action: "status" })).selected_target, { kind: "desktop" });
  await assert.rejects(() => execute({ action: "select_target", target: "window", hwnd: "0" }), /window/i);
  assert.equal((await execute({ action: "status" })).selected_target, null);
  checks.push("selection persists across fresh transports, stays conversation-scoped and clears on failed retarget");
  await execute({ action: "select_target", target: "desktop" });
  assert.equal((await execute({ action: "close" })).closed, true);
  assert.equal((await execute({ action: "status" })).selected_target, null);
  const marker = "private-audit-marker-" + crypto.randomUUID();
  await execute({ action: "status", text: marker });
  const audit = await fs.readFile(auditLog, "utf8");
  assert.ok(!audit.includes(marker)); assert.ok(!audit.includes(token)); assert.match(audit, /"redacted":true/);
  checks.push("close clears selection and text metadata is redacted from audit");
  await fs.writeFile(capabilityFile, JSON.stringify(record(new Date(Date.now() - 1000).toISOString())));
  await assert.rejects(() => execute({ action: "status" }), /expired/);
  await fs.writeFile(capabilityFile, JSON.stringify(record()));
  process.env.HARNESS_COMPUTER_USE_TOKEN = crypto.randomBytes(32).toString("base64url");
  await assert.rejects(() => execute({ action: "status" }), /token mismatch/); process.env.HARNESS_COMPUTER_USE_TOKEN = token;
  process.env.HARNESS_ACCOUNT_ID = "b".repeat(32);
  await assert.rejects(() => execute({ action: "status" }), /account mismatch/); process.env.HARNESS_ACCOUNT_ID = accountId;
  process.env.HARNESS_COMPUTER_USE_HELPER_SHA256 = "0".repeat(64);
  await assert.rejects(() => execute({ action: "status" }), /integrity check/);
  checks.push("expired capability, wrong token, account and helper hash fail closed");
  assert.equal(transports.size, calls); assert.ok(calls >= 15);
  await fs.writeFile(path.join(tmp, "result.json"), JSON.stringify({ passed: true, checks, freshTransports: calls,
    coverage: "real Windows helper status and MCP/provider integration", nativeInputAcceptance: "NOT_RUN", osInputSent: false, screenshotsTaken: false }, null, 2));
  console.log("computer-use-provider: real helper status, fresh MCP selection/capability isolation, close and redacted audit PASS; native input acceptance NOT_RUN");
} finally {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
