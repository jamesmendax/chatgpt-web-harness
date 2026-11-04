import assert from 'node:assert/strict';
import {
  buildServerDiscoverFallback,
  isServerDiscoverRequest,
} from '../dist/lib/mcp-modern-compat.js';

const discover = {
  jsonrpc: '2.0',
  id: 7,
  method: 'server/discover',
  params: {
    protocolVersion: '2026-07-28',
    clientInfo: { name: 'tunnel-client', version: '0.0.14' },
  },
};

assert.equal(isServerDiscoverRequest(discover), true);
assert.deepEqual(buildServerDiscoverFallback(discover), {
  jsonrpc: '2.0',
  id: 7,
  error: { code: -32601, message: 'Method not found' },
});
assert.equal(isServerDiscoverRequest({ ...discover, method: 'initialize' }), false);
assert.equal(isServerDiscoverRequest([{ ...discover }]), false);
assert.equal(isServerDiscoverRequest(null), false);

// Missing/invalid JSON-RPC ids remain safe and spec-shaped.
assert.deepEqual(buildServerDiscoverFallback({ jsonrpc: '2.0', method: 'server/discover' }), {
  jsonrpc: '2.0',
  id: null,
  error: { code: -32601, message: 'Method not found' },
});

console.log('mcp-modern-compat: 5/5 passed');

// An unsupported header is not protocol negotiation: reject it before any
// session is created or loopback recovery request is dispatched.
const { createSessionManager } = await import('../dist/lib/mcp-session-manager.js');
const manager = createSessionManager({
  workspaceRoot: process.cwd(), workspaceRoots: [process.cwd()], shellTimeout: 5, port: 0,
  createServer: () => { throw new Error('server factory should not be called for unsupported protocol'); },
});
let status;
let response;
const res = {
  locals: {},
  status(value) { status = value; return this; },
  json(value) { response = value; return this; },
};
const handled = await manager.tryRecoverStale('protocol-rejection-fixture', {
  headers: { 'mcp-protocol-version': 'not-a-supported-protocol' }, path: '/mcp',
}, res, { jsonrpc: '2.0', id: 'protocol-check', method: 'ping' });
assert.equal(handled, true);
assert.equal(status, 400);
assert.equal(response.id, 'protocol-check');
assert.equal(response.error.code, -32600);
assert.equal(manager.count(), 0);
assert.equal(manager.get('protocol-rejection-fixture'), undefined);
manager.stopCleanup();
console.log('mcp-protocol-rejection: 6 assertions passed; no session created');
