import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PersistentMcpEventStore } from "../dist/lib/mcp-event-store.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-harness-mcp-event-store-"));
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

function notification(marker) {
  return {
    jsonrpc: "2.0",
    method: "notifications/message",
    params: { level: "info", data: marker },
  };
}

async function nextSseFrame(reader, label, timeoutMs = 3000) {
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`SSE frame timeout: ${label}`)), remaining)),
    ]);
    if (result.done) throw new Error("SSE stream ended before a frame arrived");
    buffered += decoder.decode(result.value, { stream: true });
    const boundary = /\r?\n\r?\n/.exec(buffered);
    if (boundary?.index !== undefined) return buffered.slice(0, boundary.index + boundary[0].length);
  }
  throw new Error(`SSE frame timeout: ${label}`);
}

let listener;
let server;
try {
  const directSession = "raw-session-id-must-not-be-a-filename";
  const direct = new PersistentMcpEventStore({
    workspaceRoot: workspace,
    sessionId: directSession,
    maxEvents: 3,
    maxBytes: 1024 * 1024,
  });
  const first = await direct.storeEvent("stream-a", notification("one"));
  const second = await direct.storeEvent("stream-a", notification("two"));
  await direct.storeEvent("stream-b", notification("other-stream"));
  const fourth = await direct.storeEvent("stream-a", notification("four"));
  assert.equal(await direct.getStreamIdForEventId(first), undefined, "oldest event was not pruned at the configured bound");
  assert.equal(await direct.getStreamIdForEventId(second), "stream-a");

  const reopened = new PersistentMcpEventStore({
    workspaceRoot: workspace,
    sessionId: directSession,
    maxEvents: 3,
    maxBytes: 1024 * 1024,
  });
  const replayed = [];
  const replayStream = await reopened.replayEventsAfter(second, {
    send: async (eventId, message) => replayed.push({ eventId, message }),
  });
  assert.equal(replayStream, "stream-a");
  assert.deepEqual(replayed.map((item) => item.eventId), [fourth]);
  assert.equal(replayed[0].message.params.data, "four");
  const eventFiles = await fs.readdir(path.join(process.env.CODEX_HOME, "chatgpt-local-coder", "mcp-sse-events"), { recursive: true });
  assert.equal(eventFiles.some((name) => String(name).includes(directSession)), false, "raw MCP session id leaked into storage paths");

  const httpSession = "persistent-http-session";
  const httpStore = new PersistentMcpEventStore({ workspaceRoot: path.join(workspace, "http"), sessionId: httpSession });
  server = new McpServer(
    { name: "event-store-fixture", version: "1.0.0" },
    { capabilities: { logging: {} } }
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => httpSession,
    enableJsonResponse: true,
    eventStore: httpStore,
    keepAliveMs: 0,
  });
  await server.connect(transport);

  const app = express();
  app.use(express.json());
  app.all("/mcp", async (req, res) => {
    try { await transport.handleRequest(req, res, req.body); }
    catch (error) {
      if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.name : "fixture" });
    }
  });
  listener = http.createServer(app);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${listener.address().port}/mcp`;
  const protocol = "2025-11-25";
  const baseHeaders = {
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocol,
    "mcp-session-id": httpSession,
  };
  const init = await fetch(url, {
    method: "POST",
    headers: { ...baseHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: protocol, capabilities: {}, clientInfo: { name: "event-replay-test", version: "1" } },
    }),
  });
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("mcp-session-id"), httpSession);
  await init.text();
  const initialized = await fetch(url, {
    method: "POST",
    headers: { ...baseHeaders, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.ok(initialized.ok);
  await initialized.body?.cancel();

  const firstStream = await fetch(url, { headers: { ...baseHeaders, accept: "text/event-stream" } });
  assert.equal(firstStream.status, 200);
  const firstReader = firstStream.body.getReader();
  await server.server.notification(notification("cursor-before-disconnect"));
  const cursorFrame = await nextSseFrame(firstReader, "initial cursor");
  const cursor = /^id: ([^\r\n]+)$/m.exec(cursorFrame)?.[1];
  assert.ok(cursor, `initial SSE notification did not carry a Last-Event-ID cursor: ${cursorFrame}`);
  await firstReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 25));

  await server.server.notification(notification("replay-after-disconnect"));
  const resumed = await fetch(url, {
    headers: { ...baseHeaders, accept: "text/event-stream", "last-event-id": cursor },
  });
  assert.equal(resumed.status, 200);
  const resumedReader = resumed.body.getReader();
  const replayFrame = await nextSseFrame(resumedReader, "replay");
  assert.match(replayFrame, /replay-after-disconnect/);
  assert.match(replayFrame, /^id: /m);
  await resumedReader.cancel();

  console.log("mcp event store: bounded persistence and Last-Event-ID SSE replay passed");
} finally {
  await server?.close().catch(() => undefined);
  if (listener) {
    listener.closeAllConnections();
    await new Promise((resolve) => listener.close(resolve));
  }
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
