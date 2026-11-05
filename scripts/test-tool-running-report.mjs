// A tools/call still in flight reports [running] with its conversation, and stops reporting once it ends.
// Isolated server, temporary workspace and private ports only; no live MCP, tunnel or account.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { conversationSessionIdFromMeta } from "../dist/lib/mcp-request-identity.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Run the real compiled middleware against synchronous completion/error seams.
// HTTP completion/rejection owns no lifecycle timer; the admitted gateway does.
const compiled = await fs.readFile(path.join(root, "dist/index.js"), "utf8");
const middlewareStart = compiled.indexOf("app.use((req, res, next) => {\n    const started = Date.now();");
assert.notEqual(middlewareStart, -1);
const middlewareEnd = compiled.indexOf("\nif (MCP_TOKEN)", middlewareStart);
const reports = [];
let activityMiddleware;
vm.runInNewContext(compiled.slice(middlewareStart, middlewareEnd), {
  app: { use: fn => { activityMiddleware = fn; } }, Date, console,
  MCP_PATHS_SET: new Set(["/mcp"]), TOOL_RUNNING_REPORT_MS: 1000,
  setImmediate, clearImmediate, setInterval, clearInterval,
  activityConversationId: () => undefined, summarizeToolArgs: () => "",
  logMcpToolRunning: report => reports.push(report),
  consumeSessionTransportError() {}, extractRequestId() {}, consumeMcpOutcome() {}, logMcpRequest() {},
  getMcpRequestIdentity: () => ({ requestInstanceId: "middleware-fixture", runtimeInstanceId: "runtime-fixture", continuity: "unknown", source: "none", originalHeaders: {} }),
  runtimePrincipalId: () => "middleware-fixture-account", workspaceRoot: "middleware-fixture-workspace",
});
for (const throws of [false, true]) {
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, statusCode: 200, locals: {} });
  const req = { method: "POST", path: "/mcp", headers: {}, body: { method: "tools/call", params: { name: "run_command" } } };
  const finish = () => { res.writableEnded = true; res.emit("finish"); };
  if (throws) {
    assert.throws(() => activityMiddleware(req, res, () => { throw new Error("dispatch failure"); }), /dispatch failure/);
    finish(); // Express's error handler completes the rejected response.
  } else activityMiddleware(req, res, finish);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reports.length, 0, "synchronous completion/error must cancel the initial running report");
}

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-running-report-"));
// Command logs and requirement contracts go under CODEX_HOME, runtime files (profiles/, audit) under
// the working directory; keep both out of the user's real Codex home and this repository.
const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-running-report-home-"));
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-running-report-runtime-"));
const intent = JSON.stringify({
  intent_revision: 1, objective: "Exercise in-flight tool call reporting on an isolated MCP server",
  scope: ["temporary isolated server and workspace"], out_of_scope: ["live MCP, browser, tunnel"],
  deliverables: ["running report assertions"], success_criteria: ["running lines carry the conversation and stop after the call"],
  constraints: ["temporary files only"], protected_resources: ["live services"],
  known_facts: ["isolated ports are task-owned"], assumptions: [], delegated_decisions: [],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [],
  clarification_round: 0, questions_in_round: 0, resolution_mode: "none",
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return typeof address === "object" && address ? address.port : 0;
}
const port = await freePort();
let adminPort = await freePort();
while (adminPort === port) adminPort = await freePort();
const base = `http://127.0.0.1:${port}`;
let output = "";
const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
  cwd: runtime, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), HOST: "127.0.0.1",
    CODEX_HOME: codexHome, WORKSPACE_PATH: workspace, EXTRA_WORKSPACE_PATHS: "", WORKSPACE_PATHS: "", ALLOWED_WORKSPACE_PATHS: "",
    FULL_DISK_ACCESS: "false", MCP_RUNNING_REPORT_MS: "1000", HARNESS_RECOVERY_SUPERVISOR_ENABLED: "false",
    HARNESS_RELAY_ENABLED: "false", MCP_TOKEN: "" },
});
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lines = (pattern) => output.split(/\r?\n/).filter((line) => pattern.test(line));

async function post(body, sessionId, extraHeaders = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26", ...extraHeaders };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const response = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
const call = (id, command, sessionId, meta, headers) => post({ jsonrpc: "2.0", id, method: "tools/call",
  params: { name: "run_command", arguments: { command, _intent: intent }, ...(meta ? { _meta: meta } : {}) } }, sessionId, headers);
const sleep = (ms) => process.platform === "win32" ? `Start-Sleep -Milliseconds ${ms}` : `sleep ${ms / 1000}`;

try {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    await delay(50);
  }
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "running-report-test", version: "1" } } });
  assert.equal(init.status, 200, init.text);
  const sessionId = init.headers.get("mcp-session-id");
  assert.ok(sessionId, "missing session id");
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

  const conversation = conversationSessionIdFromMeta({ "openai/session": "running-report-fixture" });
  const short = conversation.slice(9, 17);
  const slow = await call(2, sleep(1500), sessionId, { "openai/session": "running-report-fixture" });
  assert.equal(slow.status, 200, slow.text);
  await delay(150);
  const running = lines(/\[TOOL\] \[running\] run_command /);
  assert.ok(running.length >= 2, `expected periodic running reports\n${output}`);
  assert.ok(Number(/ (\d+)ms call=\S+(?: session=\S+)? conv=/.exec(running[0])?.[1]) < 1000, "first running report must precede the periodic heartbeat");
  for (const line of running) assert.match(line, new RegExp(` conv=${short}$`), "running report keeps the conversation");
  const done = lines(/\[MCP\] \[(?:ok|transport_ok)\] tools\/call run_command /);
  assert.equal(done.length, 1, output);
  const canonicalDone = lines(/\[TOOL\] \[ok\] run_command /);
  assert.equal(canonicalDone.length, 1);
  assert.equal(/ call=(\S+)/.exec(done[0])?.[1], / call=(\S+)/.exec(canonicalDone[0])[1], "HTTP success keeps canonical invocation ID");
  assert.equal(/ call=(\S+)/.exec(canonicalDone[0])[1], / call=(\S+)/.exec(running[0])[1]);
  assert.match(done[0], new RegExp(` conv=${short}$`), "completion keeps the conversation");
  await delay(1000);
  assert.equal(lines(/\[TOOL\] \[running\] /).length, running.length, "reports stop once the call ends");

  // Headers and legacy workflow ids cannot establish the trusted body metadata identity.
  await call(3, sleep(10), sessionId, undefined, { "x-openai-session": "running-report-fixture" });
  await call(4, sleep(10), sessionId, undefined, { "x-client-request-id": "wfr_legacyWorkflow9/command_1" });
  await delay(150);
  const finished = lines(/\[MCP\] \[(?:ok|transport_ok)\] tools\/call run_command /);
  assert.equal(finished.length, 3, output);
  assert.doesNotMatch(finished[1], / conv=/);
  assert.doesNotMatch(finished[2], / conv=/);
  const failure=await post({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'read_text_file',arguments:{path:path.join(workspace,'missing-correlation-fixture.txt')},_meta:{'openai/session':'running-report-fixture'}}},sessionId);
  assert.equal(failure.status,200,failure.text);await delay(150);
  const canonicalError=lines(/\[TOOL\] \[error\] read_text_file /),httpError=lines(/\[MCP ERROR\] HTTP 200 tools\/call read_text_file /);
  assert.equal(canonicalError.length,1);assert.equal(httpError.length,1);
  const failureId=/ call=(\S+)/.exec(canonicalError[0])[1];assert.equal(/ call=(\S+)/.exec(httpError[0])?.[1],failureId,'HTTP error keeps exact canonical invocation ID');
  assert.match(httpError[0],new RegExp(' conv='+short+'$'));
  console.log(`tool-running-report: ok (${running.length} running reports; HTTP success/error IDs correlated)`);
} finally {
  child.kill();
  await delay(200);
  for (const dir of [workspace, codexHome, runtime]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
