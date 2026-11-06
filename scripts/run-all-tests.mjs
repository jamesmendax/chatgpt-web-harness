/**
 * Full verification suite for ChatGPT MCP readiness.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "path";
import net from "node:net";
import { fileURLToPath } from "url";
import { assertToolsListBudget } from "./lib/tools-list-budget.mjs";
import { assertTestManifest, fullTests, nodeArgs } from "./active-test-manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

async function isolatedPorts() {
  const reservations = [net.createServer(), net.createServer()];
  try {
    for (const server of reservations) await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    });
    return reservations.map(server => server.address().port);
  } finally {
    await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve))));
  }
}

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs(script), {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code, signal) => (code === 0 ? resolve() : reject(Object.assign(new Error(`${script} exit ${code} signal ${signal}`), { exitCode: code }))));
  });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", () => {
      const fallback = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
      fallback.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
    });
    child.on("close", (code) => (code === 0 ? runNode("scripts/write-build-manifest.mjs").then(resolve, reject) : reject(new Error(`tsc exit ${code}`))));
  });
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout ${url}`);
}

assertTestManifest();
console.log("=== Build ===");
await runBuild();
const unitScripts = fullTests;

console.log("\n=== Unit tests ===");
const failures = [];
for (const script of unitScripts) {
  console.log(`\n--- ${script} ---`);
  try {
    await runNode(script);
    console.log(`TEST_RECEIPT ${JSON.stringify({test: script, exit_code: 0})}`);
  } catch (error) {
    failures.push({ test: script, exit_code: error.exitCode ?? null });
    console.error(String(error));
    console.log(`TEST_RECEIPT ${JSON.stringify(failures.at(-1))}`);
  }
}
if (failures.length) throw new Error(`Active regression failures: ${JSON.stringify(failures)}`);

console.log("\n=== Integration (spawn server) ===");
const [mcpPort, adminPort] = await isolatedPorts();
const integrationPluginFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-harness-test-plugins-"));
const integrationPluginFixturePath = path.join(integrationPluginFixtureRoot, "plugins.json");
await fs.writeFile(integrationPluginFixturePath, JSON.stringify({
  schema_version: 2,
  computer_use: { enabled: false },
  browser_use: { enabled: false },
  skills: [],
}), "utf8");
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    CHATGPT_TOOL_PROFILE: "slim",
    CHATGPT_PLUGINS_CONFIG: integrationPluginFixturePath,
    // The integration server validates generic MCP transport/session behavior.
    // It must not inherit the production Harness's active Relay/Driver state,
    // otherwise mutating fixture calls are correctly fenced as another Chat.
    HARNESS_RELAY_ENABLED: "false",
    HARNESS_RELAY_AUTOMATION_ENABLED: "false",
    HARNESS_COMPANION_ENABLED: "false",
    MCP_SESSION_TTL_MS: "60000",
    MCP_SESSION_CLEANUP_MS: "1000",
    MCP_SESSION_MAX_COUNT: "8",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

try {
  const health = await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  if (health.runtime?.pid !== server.pid) throw new Error("Integration endpoint is not the test-owned MCP process");
  if (health.status !== "ok" || health.toolProfile !== "slim") throw new Error("public health invalid");
  if (health.runtime?.tool_count !== 34) throw new Error(`health runtime tool count invalid: ${health.runtime?.tool_count}`);
  if (health.runtime?.stale_build !== false) throw new Error("temporary server started with stale build");
  if (!/^[a-f0-9]{16}$/.test(health.runtime?.build_id || "")) throw new Error("health runtime build id invalid");
  for (const privateField of ["workspace", "defaultCwd", "mcpEndpoints", "instructions"]) {
    if (privateField in health) throw new Error(`public health leaks ${privateField}`);
  }
  console.log(`OK  public health: profile=${health.toolProfile}, auth=${health.auth}`);

  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (admin.pid !== server.pid) throw new Error("Integration admin endpoint is not the test-owned process");
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

  const preview = await (await fetch(`http://127.0.0.1:${adminPort}/api/instructions/preview`)).json();
  if (!preview.preview?.includes("## Local work")) throw new Error("instructions preview missing agent prompt");
  console.log(`OK  instructions preview ${preview.total_chars} chars`);

  // MCP session + tools/list count
  const initRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no session id");

  const listRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listText = await listRes.text();
  const listJson = JSON.parse(listText);
  const tools = listJson?.result?.tools || [];
  const { bytes } = assertToolsListBudget({ tools }, { label: "HTTP slim tools/list" });
  console.log(`OK  tools/list: ${tools.length} tools, ${bytes} bytes`);
  if (tools.length !== 34) throw new Error(`expected 34 slim tools, got ${tools.length}`);
  for (const name of ["recovery_submit", "recovery_status"]) {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`${name} missing from slim tools/list`);
  }
  if (!tools.some((t) => t.name === "apply_patch")) throw new Error("apply_patch missing");
  if (!tools.some((t) => t.name === "visual_review")) throw new Error("visual_review missing from slim tools/list");
  if (!tools.some((t) => t.name === "goal")) throw new Error("goal missing from slim tools/list");
  if (tools.some((t) => t.name === "open_image")) throw new Error("legacy open_image should be hidden from slim tools/list");
  if (tools.some((t) => t.outputSchema)) throw new Error("slim tools/list repeats generic outputSchema");
  console.log("OK  slim omits repeated generic output schemas");

  // ChatGPT web may initialize a fresh MCP session for each tool call. Verify
  // the server bounds retained sessions without breaking stale-session recovery.
  const retentionSessions = [];
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 100 + i,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "retention-test", version: "1" } },
      }),
    });
    const retentionSid = res.headers.get("mcp-session-id");
    if (!res.ok || !retentionSid) throw new Error(`retention initialize ${i} failed: HTTP ${res.status}`);
    retentionSessions.push(retentionSid);
  }

  const cappedHealth = await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json();
  if (cappedHealth.active_sessions > 8) {
    throw new Error(`session cap failed: ${cappedHealth.active_sessions} active sessions`);
  }
  console.log(`OK  session cap: ${cappedHealth.active_sessions}/8 active`);

  const staleSid = retentionSessions[0];
  const recoveryRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": staleSid,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 200, method: "tools/list", params: {} }),
  });
  if (!recoveryRes.ok) throw new Error(`evicted session recovery failed: HTTP ${recoveryRes.status}`);
  const recoveredHealth = await (await fetch(`http://127.0.0.1:${adminPort}/health`)).json();
  if (recoveredHealth.active_sessions > 8) {
    throw new Error(`session cap exceeded after recovery: ${recoveredHealth.active_sessions}`);
  }
  console.log("OK  evicted session auto-recovery stays within cap");

  process.env.PORT = String(mcpPort);
  await runNode("scripts/test-mcp-session.mjs", {
    PORT: String(mcpPort),
    CHATGPT_PLUGINS_CONFIG: integrationPluginFixturePath,
    HARNESS_RELAY_ENABLED: "false",
    HARNESS_RELAY_AUTOMATION_ENABLED: "false",
    HARNESS_COMPANION_ENABLED: "false",
  });
  console.log("OK  test-mcp-session");
} finally {
  server.kill();
  await fs.rm(integrationPluginFixtureRoot, { recursive: true, force: true });
}

console.log("\n=== ALL TESTS PASSED ===");
