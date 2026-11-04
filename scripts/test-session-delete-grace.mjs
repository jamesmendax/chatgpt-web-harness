import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-delete-grace-"));
const testIntent = JSON.stringify({
  intent_revision: 1, objective: "Exercise isolated MCP DELETE grace without touching live services",
  scope: ["temporary isolated server and workspace"], out_of_scope: ["live MCP, browser, tunnel"],
  deliverables: ["DELETE grace transport assertions"],
  success_criteria: ["in-flight handler survives, deleted session cannot be revived, stale ID recovers after drain"],
  constraints: ["temporary files only"], protected_resources: ["live services"],
  known_facts: ["isolated ports are task-owned"], assumptions: [], delegated_decisions: [],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [],
  clarification_round: 0, questions_in_round: 0, resolution_mode: "none"
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const port = await freePort();
let adminPort = await freePort();
while (adminPort === port) adminPort = await freePort();
const base = "http://127.0.0.1:" + port;
let output = "";
const child = spawn(process.execPath, ["dist/index.js"], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), HOST: "127.0.0.1",
    WORKSPACE_PATH: workspace, EXTRA_WORKSPACE_PATHS: "", WORKSPACE_PATHS: "", ALLOWED_WORKSPACE_PATHS: "",
    FULL_DISK_ACCESS: "false", MCP_SESSION_RECOVERY: "true", MCP_SESSION_DELETE_GRACE_MS: "150",
    MCP_SESSION_CLEANUP_MS: "1000", HARNESS_RECOVERY_SUPERVISOR_ENABLED: "false", HARNESS_RELAY_ENABLED: "false", MCP_TOKEN: "" }
});
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitHealth() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try { const response = await fetch(base + "/health"); if (response.ok) return; } catch {}
    await delay(40);
  }
  throw new Error("isolated MCP server did not become healthy\n" + output);
}
async function post(body, sessionId) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(base + "/mcp", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, headers: response.headers, text, json };
}
async function initialize() {
  const response = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "delete-grace-test", version: "1" } } });
  assert.equal(response.status, 200, response.text);
  const sessionId = response.headers.get("mcp-session-id"); assert.ok(sessionId, "missing session id");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return sessionId;
}
try {
  console.log("stage:wait-health");
  await waitHealth();
  console.log("stage:initialize");
  const sessionId = await initialize();
  console.log("stage:initialized " + sessionId);
  const command = JSON.stringify(process.execPath) + " -e \"setTimeout(()=>process.stdout.write('handler-finished'),450)\"";
  const longCall = post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_command", arguments: { command, _intent: testIntent } } }, sessionId);
  await delay(75);
  console.log("stage:delete");
  const deleted = await fetch(base + "/mcp", { method: "DELETE", headers: { accept: "application/json, text/event-stream", "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" }, signal: AbortSignal.timeout(5000) });
  const deleteText = await deleted.text();
  assert.ok([200, 202].includes(deleted.status), "DELETE HTTP " + deleted.status + ": " + deleteText);
  console.log("stage:deleted status=" + deleted.status);
  console.log("stage:during-grace");
  const duringGrace = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, sessionId);
  assert.equal(duringGrace.status, 404, "request after DELETE revived/cancelled grace: " + duringGrace.status + " " + duringGrace.text.slice(0, 300));
  console.log("stage:during-grace-status=" + duringGrace.status);
  const original = await longCall;
  assert.equal(original.status, 200, "in-flight handler lost across DELETE: " + original.status + " " + original.text.slice(0, 500));
  assert.match(original.text, /handler-finished/, "in-flight handler did not complete after DELETE");
  console.log("stage:inflight-complete");
  await delay(220);
  console.log("stage:stale-recover");
  const recovered = await post({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, sessionId);
  assert.equal(recovered.status, 200, "stale session did not recover after drained DELETE: " + recovered.status + " " + recovered.text.slice(0, 500));
  assert.ok(output.includes("Session recovered: " + sessionId), "server never entered stale-session recovery after DELETE grace\n" + output.slice(-3000));
  console.log("session-delete-grace: in-flight survival, no post-DELETE revival, stale-ID recovery PASS");
} finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(1500).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); })]);
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  await fs.rm(workspace, { recursive: true, force: true });
}
