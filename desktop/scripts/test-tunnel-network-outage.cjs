"use strict";
// Integration test of the pinned OFFICIAL binary. All HTTP endpoints are
// disposable loopback mocks. No real account, tunnel, key or production port.
// node desktop/scripts/test-tunnel-network-outage.cjs <binary.exe> <report.json>
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TID = "tunnel_00000000000000000000000000000000";
const RID = "req_resilience_fixture_once";
const SHARD = "invalid-fixture-routing-value";

function json(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
}
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port; }
async function body(req) { let text = ""; for await (const chunk of req) { text += chunk; assert.ok(text.length < 65536); } return text ? JSON.parse(text) : null; }
async function close(server) { if (!server?.listening) return; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

async function main() {
  const binary = process.argv[2], reportPath = process.argv[3], expectedShaArg = process.argv[4];
  const responseOutageMs = Number(process.argv[5] || 3000);
  const initialOutageMs = Number(process.argv[6] || 5000);
  assert.ok(binary && reportPath, "Usage: node test-tunnel-network-outage.cjs <binary.exe> <report.json> [expected-sha256] [response-outage-ms] [initial-outage-ms]");
  assert.ok(Number.isInteger(responseOutageMs) && responseOutageMs >= 0 && responseOutageMs <= 120000, "response-outage-ms must be an integer in [0,120000]");
  assert.ok(Number.isInteger(initialOutageMs) && initialOutageMs >= 0 && initialOutageMs <= 60000, "initial-outage-ms must be an integer in [0,60000]");
  const provenance = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../third-party/tunnel-client/PROVENANCE.json"), "utf8"));
  const hash = createHash("sha256").update(fs.readFileSync(binary)).digest("hex");
  const expectedSha = (expectedShaArg || provenance.executable_sha256).toLowerCase();
  assert.match(expectedSha, /^[0-9a-f]{64}$/, "Expected SHA256 must be a 64-character hex digest");
  assert.equal(hash, expectedSha, "Refuse an unverified tunnel executable");
  const versionProbe = spawnSync(binary, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
  assert.equal(versionProbe.status, 0, "Unable to read verified tunnel-client version");
  const binaryVersion = String(versionProbe.stdout || versionProbe.stderr || "").trim();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tunnel-outage-"));
  let child, log = "", delivered = false, issued = false, firstResponseAt = 0;
  const start = Date.now();
  const state = { pollRequests: 0, pollResets: 0, poll503s: 0, responseAttempts: 0,
    responseResets: 0, response503s: 0, localExecutions: 0, responseBodies: [], seenRoutes: [] };
  const errors = [];
  const wrap = handler => (req, res) => Promise.resolve(handler(req, res)).catch(error => {
    errors.push(String(error.stack || error)); if (!res.headersSent) json(res, 500, { error: "fixture assertion failure" }); else res.destroy();
  });
  const mcp = http.createServer(wrap(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(req.url === "/mcp" ? 405 : 404); res.end(); return; }
    const message = await body(req);
    // The real client also sends an empty POST while probing authentication.
    // This is not a dispatched tool operation and must receive a normal 400.
    if (!message || typeof message.method !== "string") { json(res, 400, { error: "JSON-RPC request required" }); return; }
    if (message.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "loopback-only-fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "increment_once", description: "Fixture operation", inputSchema: { type: "object" } }] };
    else if (message.method === "tools/call") {
      assert.equal(message.params.name, "increment_once"); state.localExecutions++;
      result = { content: [{ type: "text", text: "RESULT_ONCE" }] };
    } else result = {};
    json(res, 200, { jsonrpc: "2.0", id: message.id, result });
  }));
  const cp = http.createServer(wrap(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (state.seenRoutes.length < 30) state.seenRoutes.push(req.method + " " + url.pathname);
    if (req.method === "GET" && url.pathname === `/v1/tunnels/${TID}`) {
      json(res, 200, { id: TID, tunnel_id: TID, name: "fixture", display_name: "fixture" }); return;
    }
    if (req.method === "GET" && url.pathname === `/v1/tunnels/${TID}/poll`) {
      state.pollRequests++;
      if (Date.now() - start < initialOutageMs) {
        if (state.pollRequests % 2) { state.poll503s++; json(res, 503, { error: "injected temporary outage" }); }
        else { state.pollResets++; req.socket.destroy(); }
        return;
      }
      if (!issued) {
        issued = true;
        json(res, 200, { commands: [{ request_id: RID, shard_token: SHARD, channel: "main", command_type: "jsonrpc",
          created_at: new Date().toISOString(), headers: {}, jsonrpc: { jsonrpc: "2.0", id: "rpc_fixture_once", method: "tools/call", params: { name: "increment_once", arguments: {} } } }] });
      } else { await delay(200); if (!res.destroyed) { res.writeHead(204); res.end(); } }
      return;
    }
    if (req.method === "POST" && url.pathname === `/v1/tunnels/${TID}/response`) {
      const message = await body(req); state.responseAttempts++; state.responseBodies.push(message);
      assert.equal(message.request_id, RID);
      assert.equal(req.headers["x-tunnel-shard-token"], SHARD);
      assert.equal(message.resp_code, 200, JSON.stringify(message));
      assert.equal(message.resp_json.result.content[0].text, "RESULT_ONCE", JSON.stringify(message));
      if (!firstResponseAt) firstResponseAt = Date.now();
      if (Date.now() - firstResponseAt < responseOutageMs) {
        if (state.responseAttempts % 2) { state.response503s++; json(res, 503, { error: "injected response outage" }); }
        else { state.responseResets++; req.socket.destroy(); }
      } else { delivered = true; json(res, 200, { status: "ok" }); }
      return;
    }
    json(res, 404, { error: "unknown fixture route" });
  }));
  try {
    const mcpPort = await listen(mcp), cpPort = await listen(cp);
    const env = {};
    for (const key of Object.keys(process.env)) if (/^(SystemRoot|ComSpec|WINDIR|PATH|TEMP|TMP|PATHEXT)$/i.test(key)) env[key] = process.env[key];
    env.HOME = env.USERPROFILE = env.XDG_CONFIG_HOME = env.APPDATA = env.LOCALAPPDATA = tmp;
    env.CONTROL_PLANE_API_KEY = "invalid-fixture-not-a-key";
    env.NO_PROXY = "127.0.0.1,localhost";
    const profile = path.join(tmp, "fixture.yaml");
    fs.writeFileSync(profile, [
      "config_version: 1", "control_plane:", `  base_url: http://127.0.0.1:${cpPort}`,
      `  tunnel_id: ${TID}`, "  api_key: env:CONTROL_PLANE_API_KEY", "  poll_timeout: 1000ms", "  poll_deadline_guardrail: 500ms",
      "log:", "  level: info", "  format: json", "health:", "  listen_addr: 127.0.0.1:0",
      "admin_ui:", "  open_browser: false", "mcp:", "  server_urls:", "    - channel: main", `      url: http://127.0.0.1:${mcpPort}/mcp`, "",
    ].join("\n"));
    child = spawn(binary, ["run", "--profile-file", profile], { cwd: tmp, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    child.stdout.on("data", chunk => { log = (log + chunk).slice(-40000); });
    child.stderr.on("data", chunk => { log = (log + chunk).slice(-40000); });
    child.on("error", error => errors.push(String(error)));
    const acceptanceDeadlineMs = Math.max(75000, initialOutageMs + responseOutageMs + 60000);
    while (!delivered && Date.now() - start < acceptanceDeadlineMs) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Fixture binary exited: " + child.exitCode + "\n" + log);
      if (errors.length) throw new Error(errors.join("\n") + "\n" + log);
      await delay(100);
    }
    assert.equal(delivered, true, `No result delivery within ${acceptanceDeadlineMs}ms: ` + JSON.stringify(state) + "\n" + log);
    await delay(400);
    assert.equal(child.exitCode, null); assert.equal(child.pid, pid);
    assert.equal(state.localExecutions, 1, "A response retry must not re-execute the MCP operation");
    assert.ok(state.poll503s >= 1 && state.pollResets >= 1, "Both initial fault types must be exercised");
    assert.ok(state.responseAttempts >= 2 && state.response503s >= 1, "Response upload must be retried");
    assert.equal(errors.length, 0);
    const result = { status: "PASS", recordedAt: new Date().toISOString(), binaryVersion, binarySha256: hash,
      initialOutageWindowMs: initialOutageMs, responseOutageWindowMs: responseOutageMs, elapsedMs: Date.now() - start, pidUnchanged: true,
      localExecutions: state.localExecutions, poll503s: state.poll503s, pollResets: state.pollResets,
      responseAttempts: state.responseAttempts, response503s: state.response503s, responseResets: state.responseResets,
      responseDelivered: delivered, noOperationReplay: true,
      boundary: "Real pinned executable with disposable loopback-only HTTP mocks; not a ChatGPT UI/VPN/end-to-end test." };
    fs.writeFileSync(reportPath, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([exited, delay(3000)]); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    await close(cp); await close(mcp);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });


