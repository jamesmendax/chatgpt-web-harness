/** Isolated real-HTTP/SDK regression against the already compiled dist. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wh-session-lifecycle-"));
process.env.CODEX_HOME = path.join(root, "codex-home");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
process.env.MCP_SESSION_DELETE_GRACE_MS = "0";
process.env.MCP_SSE_EVENT_STORE_ENABLED = "false";
process.env.MCP_SESSION_MAX_COUNT = "4";
process.env.MCP_SESSION_TTL_MS = "60000";
process.env.MCP_SESSION_CLEANUP_MS = "1000";

const [{ default: express }, { McpServer }, { InitializeRequestSchema }, { createSessionManager, isInitializeRequest }, { getUpstreamManager }] = await Promise.all([
  import("express"),
  import("@modelcontextprotocol/sdk/server/mcp.js"),
  import("@modelcontextprotocol/sdk/types.js"),
  import("../dist/lib/mcp-session-manager.js"),
  import("../dist/lib/mcp-upstream-manager.js"),
]);
const upstream = getUpstreamManager();
const registered = new Set();
const register = upstream.registerMcpServer.bind(upstream);
const unregister = upstream.unregisterMcpServer.bind(upstream);
upstream.registerMcpServer = (server) => { registered.add(server); register(server); };
upstream.unregisterMcpServer = (server) => { registered.delete(server); unregister(server); };

let releaseSlow;
let signalSlow;
const slowStarted = new Promise((resolve) => { signalSlow = resolve; });
const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
let failConnect = false;
let failInitializeHandler = false;
let failedServer;
let failedTransportClosed = false;
const config = {
  workspaceRoot: root, workspaceRoots: [root], shellTimeout: 1000, port: 0,
  createServer: () => {
    const server = new McpServer({ name: "isolated-test", version: "1.0.0" });
    server.registerTool("slow", { description: "test drain" }, async () => {
      signalSlow();
      await slowGate;
      return { content: [{ type: "text", text: "completed" }] };
    });
    if (failConnect) {
      failedServer = server;
      const connect = server.connect.bind(server);
      server.connect = async (transport) => {
        const close = transport.close.bind(transport);
        transport.close = async () => { failedTransportClosed = true; return close(); };
        if (failConnect === "before") throw new Error("injected connect failure before attachment");
        await connect(transport);
        throw new Error("injected connect failure after transport attachment");
      };
    }
    if (failInitializeHandler) {
      server.server.setRequestHandler(InitializeRequestSchema, async () => {
        throw new Error("injected initialize handler failure");
      });
    }
    upstream.registerMcpServer(server);
    return server;
  },
};
const manager = createSessionManager(config);
const app = express();
let rejectRecoveryInit = false;
app.use(express.json());
app.all("/mcp", async (req, res, next) => {
  try {
    const sid = req.headers["mcp-session-id"];
    const session = sid && manager.get(sid);
    if (session) return await manager.handleExisting(session, req, res, req.body);
    if (rejectRecoveryInit && sid && isInitializeRequest(req.body)) {
      req.headers.accept = "*/*";
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "accept") req.rawHeaders[i + 1] = "*/*";
      }
    }
    if (isInitializeRequest(req.body)) return await manager.createNew(req, res, req.body);
    if (sid && await manager.tryRecoverStale(sid, req, res, req.body)) return;
    manager.sendSessionNotFound(res, req.body?.id ?? null);
  } catch (error) { next(error); }
});
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));
const server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
config.port = server.address().port;
const url = `http://127.0.0.1:${config.port}/mcp`;
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fixture", version: "1" },
} };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
async function post(body, sid, overrides = {}) {
  const response = await fetch(url, { method: "POST", headers: { ...headers,
    ...(sid ? { "mcp-session-id": sid, "mcp-protocol-version": "2025-03-26" } : {}), ...overrides },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}
async function initialize() {
  const { response, json } = await post(init);
  assert.equal(response.status, 200, JSON.stringify(json));
  const sid = response.headers.get("mcp-session-id");
  assert.ok(sid);
  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sid)).response.status, 202);
  return sid;
}
async function eventually(fn) {
  const deadline = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for cleanup");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
let streamController;
try {
  failConnect = "before";
  assert.equal((await post(init)).response.status, 500);
  failConnect = false;
  assert.equal(registered.size, 0, "a failed connect must unregister its server");
  assert.equal(failedTransportClosed, true, "a partially connected transport must close");
  assert.equal(failedServer.isConnected(), false, "the SDK server must detach its failed transport");
  assert.equal(manager.count(), 0);

  // This uses a valid initialize request but injects a handler exception after
  // the SDK has assigned a session id. Record the actual SDK behavior without
  // treating that outcome as equivalent to a pre-session HTTP rejection.
  failInitializeHandler = true;
  const applicationError = await post(init);
  failInitializeHandler = false;
  const errorSid = applicationError.response.headers.get("mcp-session-id");
  assert.equal(applicationError.response.status, 200);
  assert.ok(applicationError.json.error);
  assert.ok(errorSid);
  assert.ok(manager.get(errorSid));
  assert.equal((await post({ jsonrpc: "2.0", id: 9, method: "ping" }, errorSid)).response.status, 200);
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": errorSid } });
  await eventually(() => registered.size === 0);

  const sid = await initialize();
  const active = manager.get(sid).server;
  assert.equal(registered.size, 1);
  failConnect = "after";
  failedTransportClosed = false;
  assert.equal((await post(init)).response.status, 500);
  failConnect = false;
  assert.equal(registered.size, 1, "failed connect must not unregister the active session");
  assert.ok(registered.has(active));
  assert.equal(failedTransportClosed, true);
  assert.equal(failedServer.isConnected(), false);
  const slow = post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "slow", arguments: {} } }, sid);
  await slowStarted;
  streamController = new AbortController();
  const slowStream = await fetch(url, { headers: { accept: "text/event-stream", "mcp-session-id": sid,
    "mcp-protocol-version": "2025-03-26" }, signal: streamController.signal });
  assert.equal(slowStream.status, 200);
  let streamFinished = false;
  const streamDrained = (async () => {
    const reader = slowStream.body.getReader();
    while (!(await reader.read()).done) { /* consume SSE frames until close */ }
    streamFinished = true;
  })();
  void streamDrained.catch(() => undefined);
  const rejected = await Promise.all(Array.from({ length: 12 }, () => post(init, undefined, { accept: "*/*" })));
  assert.ok(rejected.every(({ response }) => response.status === 406));
  assert.equal(registered.size, 1, "rejected initializes must unregister their own instances");
  assert.ok(registered.has(active));
  assert.equal(manager.count(), 1);
  const ping = await post({ jsonrpc: "2.0", id: 3, method: "ping" }, sid);
  assert.equal(ping.response.status, 200);
  assert.ok(ping.json.result);
  const deleted = await fetch(url, { method: "DELETE", headers: { "mcp-session-id": sid } });
  assert.equal(deleted.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(registered.has(active), "DELETE must not dispose an in-flight tool");
  assert.equal(streamFinished, false, "DELETE must keep the stream until the accepted tool drains");
  assert.equal((await post({ jsonrpc: "2.0", id: 4, method: "ping" }, sid)).response.status, 404);
  releaseSlow();
  assert.match(JSON.stringify((await slow).json), /completed/);
  await eventually(() => !registered.has(active));
  await Promise.race([streamDrained, new Promise((_, reject) => setTimeout(() => reject(new Error("DELETE did not close GET")), 3000))]);

  const streamingSid = await initialize();
  streamController = new AbortController();
  const stream = await fetch(url, { headers: { accept: "text/event-stream", "mcp-session-id": streamingSid,
    "mcp-protocol-version": "2025-03-26" }, signal: streamController.signal });
  assert.equal(stream.status, 200);
  assert.equal((await post(init, undefined, { accept: "*/*" })).response.status, 406);
  assert.equal((await post({ jsonrpc: "2.0", id: 5, method: "ping" }, streamingSid)).response.status, 200);
  assert.ok(manager.get(streamingSid));
  manager.get(streamingSid).lastAccessedAt = Date.now() - 61_000;
  manager.startCleanup();
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.ok(manager.get(streamingSid), "TTL must retain an open GET session");
  const otherSessions = [];
  for (let i = 0; i < 4; i++) otherSessions.push(await initialize());
  assert.ok(manager.get(streamingSid), "LRU must retain an open GET session");
  assert.ok(manager.count() <= 4);
  for (const other of otherSessions) {
    if (manager.get(other)) await fetch(url, { method: "DELETE", headers: { "mcp-session-id": other } });
  }
  await eventually(() => manager.count() === 1);
  streamController.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  streamController = new AbortController();
  const reconnected = await fetch(url, { headers: { accept: "text/event-stream", "mcp-session-id": streamingSid,
    "mcp-protocol-version": "2025-03-26" }, signal: streamController.signal });
  assert.equal(reconnected.status, 200, "a transient GET disconnect must permit reconnect");
  const reconnectedDrained = (async () => {
    const reader = reconnected.body.getReader();
    while (!(await reader.read()).done) { /* consume SSE frames until close */ }
  })();
  void reconnectedDrained.catch(() => undefined);
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": streamingSid } });
  await eventually(() => manager.count() === 0);
  await Promise.race([reconnectedDrained, new Promise((_, reject) => setTimeout(() => reject(new Error("DELETE did not close reconnected GET")), 3000))]);

  const stale = "00000000-0000-4000-8000-000000000099";
  rejectRecoveryInit = true;
  const failedRecovery = await post({ jsonrpc: "2.0", id: 8, method: "ping" }, stale);
  assert.equal(failedRecovery.response.status, 404);
  assert.equal(registered.size, 0, "a rejected pending recovery must be unregistered");
  assert.equal(manager.count(), 0);
  rejectRecoveryInit = false;
  const recovered = await Promise.all([6, 7].map((id) => post({ jsonrpc: "2.0", id, method: "ping" }, stale)));
  assert.ok(recovered.every(({ response, json }) => response.status === 200 && json.result));
  assert.ok(manager.get(stale));
  assert.equal(registered.size, 1);
  await fetch(url, { method: "DELETE", headers: { "mcp-session-id": stale } });
  await eventually(() => registered.size === 0 && manager.count() === 0);
  console.log("PASS rejected initialize and failed recovery cleanup; active tool, DELETE drain, GET stream, and concurrent recovery");
} finally {
  releaseSlow();
  streamController?.abort();
  manager.stopCleanup();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const realRoot = await fs.realpath(root);
  const realTmp = await fs.realpath(os.tmpdir());
  const normalizePath = (value) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
  if (normalizePath(path.dirname(realRoot)) !== normalizePath(realTmp) ||
      !path.basename(realRoot).startsWith("wh-session-lifecycle-")) {
    throw new Error(`refusing to remove unexpected test directory: ${realRoot}`);
  }
  await fs.rm(realRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
