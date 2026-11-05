import assert from 'node:assert/strict';
import { runWithMcpRequestIdentity, getMcpRequestIdentity } from '../dist/lib/mcp-request-identity.js';
import {
  consumeMcpOutcome,
  getMcpOutcomeStoreStats,
  observeMcpInvocationFailure,
  observeMcpToolResult,
} from '../dist/lib/mcp-outcome.js';

const successResult = {
  content: [{ type: 'text', text: '{"ok":true}' }],
  structuredContent: { ok: true, data: { secret_payload: 'must-not-be-retained-by-outcome-store' } },
};
const failureResult = {
  content: [{ type: 'text', text: '{"ok":false}' }],
  structuredContent: { ok: false, data: { error: 'fixture failure' } },
  isError: true,
};

runWithMcpRequestIdentity({}, 'transport-fixture', () => {
observeMcpToolResult({ requestId: 7, tool: 'fixture_tool', invocationId: 'inv-success', result: successResult });
observeMcpToolResult({ requestId: 7, tool: 'fixture_tool', invocationId: 'inv-failure-result', result: failureResult });
observeMcpInvocationFailure({ requestId: 7, tool: 'fixture_tool', invocationId: 'inv-throw' });

const statsBefore = getMcpOutcomeStoreStats();
assert.equal(statsBefore.observations, 3);
assert.ok(statsBefore.max >= 32);
assert.ok(statsBefore.ttl_ms >= 10_000);

const first = consumeMcpOutcome(7, 'fixture_tool');
assert.deepEqual(first, {
  rpc_result_status: 'success',
  tool_result_status: 'success',
  client_delivery: 'unknown',
  invocation_id: 'inv-success',
  observed_at: first.observed_at,
  request_instance_id: getMcpRequestIdentity().requestInstanceId,
  runtime_instance_id: getMcpRequestIdentity().runtimeInstanceId,
});
assert.match(first.observed_at, /^\d{4}-\d{2}-\d{2}T/);
assert.equal(JSON.stringify(first).includes('secret_payload'), false);

const second = consumeMcpOutcome(7, 'fixture_tool');
assert.equal(second.rpc_result_status, 'success');
assert.equal(second.tool_result_status, 'error');
assert.equal(second.client_delivery, 'unknown');
assert.equal(second.invocation_id, 'inv-failure-result');

const third = consumeMcpOutcome(7, 'fixture_tool');
assert.equal(third.rpc_result_status, 'error');
assert.equal(third.tool_result_status, 'error');
assert.equal(third.client_delivery, 'unknown');
assert.equal(third.invocation_id, 'inv-throw');

assert.equal(consumeMcpOutcome(7, 'fixture_tool'), undefined);
assert.equal(getMcpOutcomeStoreStats().observations, 0);

});
observeMcpToolResult({ requestId: 7, tool: 'fixture_tool', invocationId: 'unattributed', result: successResult });
assert.equal(consumeMcpOutcome(7, 'fixture_tool'), undefined, 'unattributed observations cannot be matched globally');
await Promise.all(['left', 'right'].map(name => runWithMcpRequestIdentity({}, 'shared-transport', async () => {
  observeMcpToolResult({ requestId: 7, tool: 'fixture_tool', invocationId: name, result: successResult });
  await new Promise(resolve => setTimeout(resolve, name === 'left' ? 12 : 1));
  assert.equal(consumeMcpOutcome(7, 'fixture_tool').invocation_id, name, 'same RPC id and tool cannot consume another request');
})));
assert.equal(getMcpOutcomeStoreStats().observations, 0);
console.log('mcp-outcome-correlation: request-instance isolation, typed RPC IDs, consume-once and metadata-only storage OK');