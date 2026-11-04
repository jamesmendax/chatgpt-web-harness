import assert from 'node:assert/strict';
import { getRecentActivity, logMcpRequest, logMcpHttpEvent } from '../dist/lib/activity-log.js';

// Pure logging tests: no live Goal, network, shell child, or service lifecycle.
const failures = [];
let passed = 0;
const request = { method: 'tools/call', params: { name: 'fixture_tool', arguments: { action: 'inspect' } } };
const latest = () => getRecentActivity(1)[0];
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failures.push({ name, message: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}

test('HTTP 200 plus explicit request error is not success', () => {
  logMcpRequest(request, 'fixture-session', 2, 200, 'FIXTURE_TOOL_ERROR');
  assert.equal(latest().status, 'error');
  assert.equal(latest().details.http_status, 200);
  assert.equal(latest().details.transport_status, 'http_success');
  assert.equal(latest().details.request_error_observed, true);
});
test('HTTP 200 alone proves transport only, not tool success', () => {
  logMcpRequest(request, 'fixture-session', 2, 200);
  assert.equal(latest().status, 'transport_ok');
  assert.equal(latest().details.tool_result_status, 'unobserved');
  assert.equal(latest().details.client_delivery, 'unknown');
});
test('HTTP failure preserves its own layer', () => {
  logMcpRequest(request, 'fixture-session', 2, 403, 'Fixture HTTP rejection');
  assert.equal(latest().status, 'error');
  assert.equal(latest().details.transport_status, 'http_error');
  assert.equal(latest().details.tool_result_status, 'unobserved');
});
test('explicit observed tool failure is recorded even without error text', () => {
  logMcpRequest(request, 'fixture-session', 2, 200, undefined, { tool_result_status: 'error', rpc_result_status: 'success' });
  assert.equal(latest().status, 'error');
  assert.equal(latest().details.tool_result_status, 'error');
});
test('observed tool success never claims end-client delivery', () => {
  logMcpRequest(request, 'fixture-session', 2, 200, undefined, { tool_result_status: 'success', rpc_result_status: 'success' });
  assert.equal(latest().status, 'ok');
  assert.equal(latest().details.client_delivery, 'unknown');
});
test('HTTP logger uses explicit error and redacts credentials', () => {
  logMcpHttpEvent({ method: 'POST', path: '/mcp', httpStatus: 200, durationMs: 1, errorMessage: 'Authorization: Bearer fixture-secret' });
  assert.equal(latest().status, 'error');
  assert.equal(latest().summary.includes('fixture-secret'), false);
  assert.equal(latest().details.request_error_observed, true);
});
test('null request still records explicit HTTP-200 error', () => {
  const before = latest().id;
  logMcpRequest(null, 'fixture-session', 1, 200, 'Fixture parse error');
  assert.notEqual(latest().id, before);
  assert.equal(latest().status, 'error');
});
test('raw arguments and response contents are not retained', () => {
  logMcpRequest(request, 'fixture-session', 1, 200);
  assert.deepEqual(latest().details.argument_keys, ['action']);
  assert.equal('arguments' in latest().details, false);
  assert.equal('response' in latest().details, false);
});

console.log(JSON.stringify({ suite: 'mcp-outcome-log', passed, failed: failures.length, failures }));
if (failures.length) process.exitCode = 1;
