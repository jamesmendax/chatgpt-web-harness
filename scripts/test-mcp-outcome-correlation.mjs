import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runWithMcpRequestIdentity, getMcpRequestIdentity } from '../dist/lib/mcp-request-identity.js';
import {
  consumeMcpOutcome,
  getMcpOutcomeStoreStats,
  observeMcpInvocationFailure,
  observeMcpToolResult,
  observeMcpFinalOutcome,
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
const capacity = getMcpOutcomeStoreStats().max;
function fill(count, label) {
  const entries = [];
  for (let i = 0; i < count; i++) runWithMcpRequestIdentity({}, label, () => {
    const owner = getMcpRequestIdentity().requestInstanceId;
    observeMcpToolResult({ requestId: i, tool: 'capacity', invocationId: `${label}-${i}`, result: successResult });
    entries.push({ id: i, owner, finish: AsyncLocalStorage.bind(() =>
      observeMcpFinalOutcome({ requestId: i, tool: 'capacity', result: successResult })) });
  });
  return entries;
}
const consume = entry => consumeMcpOutcome(entry.id, 'capacity', entry.owner);
let entries = fill(capacity, 'read-at-capacity');
assert.equal(getMcpOutcomeStoreStats().observations, capacity, 'a stats read must not evict at exact capacity');
assert.equal(consume(entries[0])?.invocation_id, 'read-at-capacity-0');
entries.slice(1).forEach(consume);
entries = fill(capacity, 'final-at-capacity');
const final = entries[0].finish();
assert.equal(final.previous?.invocation_id, 'final-at-capacity-0');
assert.equal(final.outcome.invocation_id, 'final-at-capacity-0');
assert.equal(getMcpOutcomeStoreStats().observations, capacity);
for (const entry of entries) assert.equal(consume(entry)?.invocation_id, `final-at-capacity-${entry.id}`, 'final replacement retains all unrelated observations');
entries = fill(capacity + 1, 'actual-overflow');
assert.equal(getMcpOutcomeStoreStats().observations, capacity);
assert.equal(consume(entries[0]), undefined, 'only an actual overflow evicts the oldest entry');
for (const entry of entries.slice(1)) assert.equal(consume(entry)?.invocation_id, `actual-overflow-${entry.id}`);
const realNow = Date.now;
try {
  let now = realNow();
  Date.now = () => now;
  entries = fill(1, 'expiry-boundary');
  const ttl = getMcpOutcomeStoreStats().ttl_ms;
  now += ttl;
  assert.equal(getMcpOutcomeStoreStats().observations, 1, 'existing inclusive TTL boundary is preserved');
  now++;
  assert.equal(consume(entries[0]), undefined);
} finally { Date.now = realNow; }
assert.equal(getMcpOutcomeStoreStats().observations, 0);
console.log(`mcp-outcome-correlation: request identity, consume-once, capacity ${capacity}, final replacement, overflow and expiry OK`);
