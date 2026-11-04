import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { EffectiveToolRegistry } from '../dist/lib/effective-tool-registry.js';
import { InvocationGateway } from '../dist/lib/invocation-gateway.js';
import { runWithMcpRequestIdentity } from '../dist/lib/mcp-request-identity.js';
import { toolResult } from '../dist/lib/tool-result.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-stream-survival-'));
const saved = new Map(['CODEX_HOME', 'MCP_RESULT_MAX_BYTES'].map(k => [k, process.env[k]]));
process.env.CODEX_HOME = path.join(temp, 'runtime');
process.env.MCP_RESULT_MAX_BYTES = '32768';
const sessions = new Map();
const effects = new Map();
const gates = new Map();
const completed = new Map();
const received = new Map();
let hooks = 0;
let nextId = 1;
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: 'Exercise isolated stream-survival mutations',
  scope: ['temporary stream-survival fixture'],
  out_of_scope: [], deliverables: ['recovery assertions'],
  success_criteria: ['mutation effects remain exactly-once across stream loss'],
  constraints: [], protected_resources: [], known_facts: ['fixture is isolated'],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: 'none',
});
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(test, label) {
  const deadline = Date.now() + 10000;
  while (!test()) { if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await delay(10); }
}
function createSession() {
  const server = new McpServer({ name: 'stream-fixture', version: '1.0.0' });
  const registry = new EffectiveToolRegistry('full');
  const gateway = new InvocationGateway(registry, { workspaceRoot: temp, projectRoots: [temp] }, {
    onSuccess: (_context, result) => { hooks++; return result; },
  });
  const config = { inputSchema: { key: z.string(), mode: z.string() }, annotations: { readOnlyHint: false } };
  const definition = registry.prepare('fixture_mutation', config, async ({ key, mode }) => {
    effects.set(key, (effects.get(key) ?? 0) + 1);
    await fs.appendFile(path.join(temp, 'effects.txt'), key + '\n');
    if (mode === 'wait') await new Promise(resolve => gates.set(key, resolve));
    const result = toolResult('fixture_mutation', { key, marker: mode === 'large' ? 'x'.repeat(100000) : 'original' },
      { ok: mode !== 'failure' });
    completed.set(key, true);
    return result;
  });
  assert.ok(definition);
  registry.register(definition);
  server.registerTool('fixture_mutation', definition.config, (...args) => gateway.invoke('fixture_mutation', args));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID, enableJsonResponse: true,
    onsessioninitialized: id => sessions.set(id, { server, transport }),
  });
  return { server, transport };
}
const app = express();
app.use(express.json());
app.post('/mcp', async (req, res) => {
  try {
    const key = req.body?.params?.arguments?.key;
    if (key) received.set(key, (received.get(key) ?? 0) + 1);
    let session = sessions.get(req.headers['mcp-session-id']);
    if (!session) { session = createSession(); await session.server.connect(session.transport); }
    await runWithMcpRequestIdentity(req.headers, req.headers['mcp-session-id'], () => session.transport.handleRequest(req, res, req.body));
  } catch { if (!res.headersSent) res.status(500).json({ error: 'fixture transport failure' }); }
});
const listener = http.createServer(app);
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${listener.address().port}/mcp`;
async function post(body, sid) {
  const response = await fetch(url, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26', ...(sid ? { 'mcp-session-id': sid } : {}),
  }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  return { status: response.status, sid: response.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
}
async function initialize() {
  const response = await post({ jsonrpc: '2.0', id: nextId++, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' },
  }});
  assert.equal(response.status, 200);
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, response.sid);
  return response.sid;
}
function body(key, mode = 'normal', observe = false) {
  return { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: {
    name: 'fixture_mutation', arguments: { key, mode, _intent: TEST_INTENT },
    _meta: { 'openai/session': 'stream-survival-fixture', 'local-coder/operation-id': key,
      'local-coder/operation-mode': observe ? 'observe' : 'execute' },
  }};
}
function droppedRequest(request, sid, afterHeaders = false) {
  const req = http.request(url, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26', 'mcp-session-id': sid,
  }});
  req.on('error', () => {});
  let resolveHeaders;
  const headersSeen = new Promise(r => resolveHeaders = r);
  req.on('response', response => { resolveHeaders(); if (afterHeaders) { response.destroy(); req.destroy(); } else response.resume(); });
  req.end(JSON.stringify(request));
  return { req, headersSeen };
}
try {
  const sid = await initialize();
  // The response is dropped at the real HTTP boundary after the mutation ran.
  const lost = droppedRequest(body('lost-result'), sid, true);
  await lost.headersSeen;
  const sid2 = await initialize();
  const recovered = await post(body('lost-result'), sid2);
  assert.equal(recovered.body.result.structuredContent.data.marker, 'original');
  assert.equal(effects.get('lost-result'), 1);
  const hookCount = hooks;
  await post(body('lost-result'), sid2);
  assert.equal(hooks, hookCount, 'recovery must not recreate evidence/hooks');

  const inflight = droppedRequest(body('inflight', 'wait'), sid);
  await until(() => gates.has('inflight'), 'mutation start');
  inflight.req.destroy();
  const retries = Array.from({ length: 10 }, () => post(body('inflight', 'wait'), sid2));
  await until(() => received.get('inflight') === 11, 'all duplicate requests accepted at HTTP boundary');
  const pingStarted = performance.now();
  const ping = await post({ jsonrpc: '2.0', id: nextId++, method: 'ping' }, sid2);
  assert.equal(ping.status, 200);
  assert.ok(performance.now() - pingStarted < 2000, 'control RPC blocked by tool');
  assert.equal(effects.get('inflight'), 1);
  gates.get('inflight')();
  const attached = await Promise.all(retries);
  for (const response of attached) assert.equal(response.body.result.structuredContent.data.key, 'inflight');
  assert.equal(effects.get('inflight'), 1);

  const failed = droppedRequest(body('failed-result', 'failure'), sid, true);
  await failed.headersSeen;
  const failedReplay = await post(body('failed-result', 'failure'), sid2);
  assert.equal(failedReplay.body.result.isError, true);
  assert.equal(effects.get('failed-result'), 1);
  const unseen = await post(body('never-sent', 'normal', true), sid);
  assert.equal(unseen.body.result.isError, true);
  assert.equal(effects.has('never-sent'), false);
  const normal = await post(body('never-sent'), sid);
  assert.equal(normal.body.result.isError, undefined);
  assert.equal(effects.get('never-sent'), 1);
  const large = await post(body('large', 'large'), sid);
  assert.ok(Buffer.byteLength(JSON.stringify(large.body.result)) < 32768);
  assert.equal(large.body.result.structuredContent.data.spill_saved, true);
  const spilled = await fs.readFile(large.body.result.structuredContent.data.full_output_path);
  assert.equal(createHash('sha256').update(spilled).digest('hex'), large.body.result.structuredContent.data.sha256);
  assert.equal(JSON.parse(spilled).structuredContent.data.marker, 'x'.repeat(100000));
  const replayLarge = await post(body('large', 'large'), sid2);
  assert.equal(replayLarge.body.result.structuredContent.data.sha256, large.body.result.structuredContent.data.sha256);
  assert.equal(effects.get('large'), 1);
  console.log('stream-survival HTTP: lost result, 10 duplicate retries, control ping, original failure, observe-only and oversized result passed');
} finally {
  for (const resolve of gates.values()) resolve();
  for (const session of sessions.values()) await session.server.close().catch(() => {});
  listener.closeAllConnections();
  await new Promise(resolve => listener.close(resolve));
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fs.rm(temp, { recursive: true, force: true });
}
// Exercise actual production session-manager recovery/protocol behavior too.
for (const script of ['test-mcp-modern-compat.mjs', 'test-mcp-bridge-integration.mjs']) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], {
      cwd: path.resolve(import.meta.dirname, '..'), env: process.env, windowsHide: true, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(Error(`${script}: exit ${code}`)));
  });
}
console.log('stream-survival: PASS; isolated HTTP fixtures, no live MCP/Tunnel changes');
