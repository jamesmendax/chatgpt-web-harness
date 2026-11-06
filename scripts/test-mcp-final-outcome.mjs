import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-final-outcome-'));
const dist = path.resolve(process.env.HARNESS_TEST_DIST_ROOT || path.join(repo, 'dist'));
Object.assign(process.env, {
  CODEX_HOME: path.join(fixture, 'codex'), AUDIT_LOG_PATH: path.join(fixture, 'audit.log'),
  CHECKPOINT_PATH: path.join(fixture, 'checkpoints'),
  CHATGPT_PLUGINS_CONFIG: path.join(fixture, 'plugins.json'),
  MCP_UPSTREAM_CONFIG: path.join(fixture, 'upstream.json'), CHATGPT_TOOL_PROFILE: 'full',
});
await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG, JSON.stringify({ schema_version: 2,
  skills: [], computer_use: { enabled: false }, browser_use: { enabled: false } }));
await fs.writeFile(process.env.MCP_UPSTREAM_CONFIG, '{"version":1,"servers":[]}');
const load = name => import(pathToFileURL(path.join(dist, name)).href);
const { createMcpServer } = await load('server-factory.js');
const { runWithMcpRequestIdentity, getMcpRequestIdentity } = await load('lib/mcp-request-identity.js');
const { consumeMcpOutcome, getMcpOutcomeStoreStats, observeMcpToolResult, observeMcpFinalOutcome } = await load('lib/mcp-outcome.js');
const { getRecentActivity } = await load('lib/activity-log.js');
const server = createMcpServer(fixture, 5000, [fixture]);
let executions = 0;
server.registerTool('fixture__final', {
  inputSchema: { n: z.number() }, outputSchema: { n: z.number() },
  annotations: { readOnlyHint: true },
}, async ({ n }) => {
  executions++;
  await new Promise(resolve => setTimeout(resolve, n === 1 ? 5 : 1));
  return { content: [{ type: 'text', text: 'fixture' }],
    structuredContent: { n: n === 2 ? 'SECRET_OUTPUT_NOT_FOR_LOGS' : n } };
});
server.registerTool('fixture__throw', {
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => { throw new Error('isolated handler failure'); });
server.registerTool('fixture__error', {
  inputSchema: {}, annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: 'isolated tool error result' }], isError: true }));

// Actual SDK Protocol/Server/McpServer dispatch through a memory-only transport.
// No HTTP listener, shell, browser, native input or real account is involved.
const pending = new Map();
const transport = {
  sessionId: 'final-outcome-fixture',
  async start() {},
  async close() { this.onclose?.(); },
  async send(message) {
    if (!('id' in message)) return;
    const waiter = pending.get(JSON.stringify([typeof message.id, message.id]));
    assert.ok(waiter, 'response belongs to a pending fixture request');
    const identity = getMcpRequestIdentity();
    const outcome = consumeMcpOutcome(message.id, waiter.tool, identity?.requestInstanceId);
    waiter.resolve({ message, outcome, requestInstanceId: identity?.requestInstanceId });
    pending.delete(JSON.stringify([typeof message.id, message.id]));
  },
};
await server.connect(transport);
let nextId = 0;
async function call(name, args, meta, id = ++nextId) {
  const request = { jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } };
  let timer;
  const response = new Promise((resolve, reject) => {
    pending.set(JSON.stringify([typeof id, id]), { tool: name, resolve, reject });
    timer = setTimeout(() => reject(new Error('SDK fixture response timeout')), 5000);
    runWithMcpRequestIdentity({}, transport.sessionId, () => transport.onmessage(request), request);
  });
  try { return await response; } finally { clearTimeout(timer); }
}
const results = [];
try {
  const good = await call('fixture__final', { n: 1 });
  assert.equal(good.message.result.isError, undefined);
  assert.equal(good.outcome.tool_result_status, 'success');
  assert.equal(good.outcome.client_delivery, 'unknown');
  const successfulCanonical = getRecentActivity(500).filter(entry =>
    entry.details?.invocation_id === good.outcome.invocation_id && entry.details?.canonical_lifecycle && entry.status !== 'running');
  assert.equal(successfulCanonical.length, 1, 'ordinary success has exactly one canonical completion: ' + JSON.stringify(successfulCanonical));
  assert.equal(successfulCanonical[0].status, 'ok');
  results.push('successful wire result');
  const thrown = await call('fixture__throw', {});
  assert.equal(thrown.message.result.isError, true);
  assert.equal(thrown.outcome.rpc_result_status, 'success');
  assert.equal(thrown.outcome.tool_result_status, 'error');
  assert.equal(thrown.outcome.client_delivery, 'unknown');
  assert.equal(thrown.outcome.request_instance_id, thrown.requestInstanceId);
  assert.equal(consumeMcpOutcome(thrown.message.id, 'fixture__throw', thrown.requestInstanceId), undefined);
  const thrownCanonical = getRecentActivity(500).filter(entry =>
    entry.details?.invocation_id === thrown.outcome.invocation_id && entry.details?.canonical_lifecycle && entry.status !== 'running');
  assert.equal(thrownCanonical.length, 1, 'handler failure has exactly one canonical completion: ' + JSON.stringify(thrownCanonical));
  assert.equal(thrownCanonical[0].status, 'error');
  results.push('handler throw keeps one canonical error despite SDK RPC result conversion');
  const returnedError = await call('fixture__error', {});
  assert.equal(returnedError.outcome.tool_result_status, 'error');
  assert.equal(returnedError.outcome.rpc_result_status, 'success');
  const returnedCanonical = getRecentActivity(500).filter(entry =>
    entry.details?.invocation_id === returnedError.outcome.invocation_id && entry.details?.canonical_lifecycle && entry.status !== 'running');
  assert.equal(returnedCanonical.length, 1, 'returned tool error has one canonical completion');
  assert.equal(returnedCanonical[0].status, 'error');
  results.push('returned isError result keeps one canonical error');
  for (const [name, args, meta, phase] of [
    ['fixture__final', { n: 'SECRET_INPUT_NOT_FOR_LOGS' }, undefined, 'validation'],
    ['fixture__missing', {}, undefined, 'validation'],
    ['fixture__final', { n: 2 }, undefined, 'postprocessing'],
    ['fixture__final', { n: 3 }, { 'local-coder/operation-id': 'invalid id' }, 'validation'],
    ['fixture__final', [], undefined, 'validation'],
  ]) {
    const { message, outcome } = await call(name, args, meta);
    assert.ok(message.error || message.result.isError);
    assert.equal(outcome.tool_result_status, 'error');
    assert.equal(outcome.rpc_result_status, message.error ? 'error' : 'success');
    assert.equal(outcome.failure.failure_phase, phase);
    assert.equal(outcome.client_delivery, 'unknown');
    assert.equal(consumeMcpOutcome(message.id, name, outcome.request_instance_id), undefined,
      'no provisional success remains after consuming final result');
    assert.equal(JSON.stringify(outcome).includes('SECRET_'), false);
    const canonical = getRecentActivity(500).find(entry => entry.details?.invocation_id === outcome.invocation_id && entry.details?.canonical_lifecycle);
    assert.equal(canonical.status, 'error', 'visible lifecycle ends at actual SDK outcome');
    results.push(name + ':' + phase + ':' + outcome.rpc_result_status);
  }
  assert.equal(executions, 2, 'invalid requests never execute the fixture handler');
  const [left, right] = await Promise.all([
    call('fixture__final', { n: 1 }, undefined, 77),
    call('fixture__final', { n: 2 }, undefined, '77'),
  ]);
  assert.equal(left.outcome.tool_result_status, 'success');
  assert.equal(right.outcome.tool_result_status, 'error');
  assert.notEqual(left.requestInstanceId, right.requestInstanceId);
  assert.equal(getMcpOutcomeStoreStats().observations, 0);
  results.push('concurrent typed RPC ids and request instances');
  runWithMcpRequestIdentity({}, 'replacement-fixture', () => {
    observeMcpToolResult({ requestId: 1, tool: 'replacement', invocationId: 'original', result: { content: [] } });
    observeMcpToolResult({ requestId: 1, tool: 'replacement', invocationId: 'original', result: { content: [], isError: true } });
    observeMcpFinalOutcome({ requestId: 1, tool: 'replacement', result: { content: [], isError: true } });
    assert.equal(consumeMcpOutcome(1, 'replacement').tool_result_status, 'error');
    assert.equal(consumeMcpOutcome(1, 'replacement'), undefined);
  });
  results.push('journal replacement consumes once');
  console.log(JSON.stringify({ suite: 'mcp-final-outcome', passed: results.length, results }));
} finally {
  await server.close();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith('mcp-final-outcome-'));
  await fs.rm(fixture, { recursive: true, force: true });
}
