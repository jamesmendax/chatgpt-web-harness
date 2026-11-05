import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EffectiveToolRegistry } from '../dist/lib/effective-tool-registry.js';
import { InvocationGateway } from '../dist/lib/invocation-gateway.js';
import { createRuntimeScope, runWithRuntimeScope, getRuntimeScope } from '../dist/lib/runtime-scope.js';
import { createGoal, getGoal, getWorkspaceGoalProjection } from '../dist/lib/goals.js';
import { readDriverLease } from '../dist/lib/driver-lease.js';
import { readAcceptedExecutionContractState, inheritAcceptedExecutionContractState } from '../dist/lib/execution-contract.js';
import { listOperationInspections } from '../dist/lib/operation-journal.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-gateway-goal-'));
const saved = new Map(['CODEX_HOME', 'HARNESS_RELAY_ENABLED', 'GOAL_WATCHDOG_ENABLED',
  'HARNESS_COMPANION_ENABLED', 'HARNESS_RELAY_AUTOMATION_ENABLED'].map(key => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(temp, 'runtime');
process.env.HARNESS_RELAY_ENABLED = 'false';
process.env.GOAL_WATCHDOG_ENABLED = 'false';
process.env.HARNESS_COMPANION_ENABLED = 'false';
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = 'false';
const workspace = path.join(temp, 'workspace');
await fs.mkdir(workspace);
const seed = { workspaceRoot: workspace, projectRoots: [workspace], principalId: 'fixture', tunnelProfile: 'test' };
const inSession = (session, fn) => runWithRuntimeScope(createRuntimeScope(seed, { sessionId: session }), fn);
const intent = label => JSON.stringify({
  intent_revision: 1, objective: 'Exercise authorized isolated Goal ' + label,
  scope: ['only this isolated fixture'], out_of_scope: [], deliverables: ['verified fixture response'],
  success_criteria: ['exact session scope preserved'], constraints: [], protected_resources: [],
  known_facts: ['the fixture has no external effects'], assumptions: [], delegated_decisions: [],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [],
  clarification_round: 0, questions_in_round: 0, resolution_mode: 'none',
});
let request = 0;
const extra = (session, operation) => ({
  sessionId: session, requestId: ++request, signal: new AbortController().signal,
  ...(operation ? { _meta: { 'local-coder/operation-id': operation } } : {}),
});
const calls = [];
const registry = new EffectiveToolRegistry('full');
const definition = registry.prepare('write_file', {
  inputSchema: {}, annotations: { readOnlyHint: false },
}, async args => {
  const scope = getRuntimeScope();
  const record = { goal: scope.goalId, owner: scope.goalOwnerSessionId, session: scope.mcpSessionId, label: args.label };
  calls.push(record);
  return { content: [{ type: 'text', text: JSON.stringify(record) }], structuredContent: record };
});
assert.ok(definition);
registry.register(definition);
const gateway = new InvocationGateway(registry, seed);
async function invoke(session, args, operation) {
  const value = await gateway.invoke('write_file', [args, extra(session, operation)]);
  assert.notEqual(value.isError, true, JSON.stringify(value));
  return value.structuredContent;
}

try {
  const a = await inSession('session-A', () => createGoal(workspace, {
    objective: 'Goal A', success_criteria: [{ name: 'A work', passed: false }],
  }));
  const b = await inSession('session-B', () => createGoal(workspace, {
    objective: 'Goal B', success_criteria: [{ name: 'B work', passed: false }],
  }));
  assert.equal((await inSession('session-B', () => getWorkspaceGoalProjection(workspace))).id, b.id, 'fixture must expose B as latest account-local projection');

  const firstA = await invoke('session-A', { label: 'A first', _intent: intent('A') }, 'first');
  assert.equal(firstA.goal, a.id);
  assert.equal(firstA.owner, 'session-A');
  const firstB = await invoke('session-B', { label: 'B first', _intent: intent('B') }, 'first');
  assert.equal(firstB.goal, b.id);
  assert.equal(firstB.owner, 'session-B');
  // The gateway enters before its own AsyncLocal scope. Explicit host session A
  // must win even when a caller happens to have B in an outer asynchronous chain.
  const nestedA = await inSession('session-B', () => invoke('session-A', {
    label: 'A ignores spoofed goal', goal_id: b.id, _intent: '{invalid',
  }, 'inherited-A'));
  assert.equal(nestedA.goal, a.id);
  assert.equal(nestedA.session, 'session-A');
  assert.equal((await invoke('session-B', { label: 'B ignores legacy intent', _intent: '{invalid' }, 'inherited-B')).goal, b.id);

  const before = calls.length;
  const unrelated = await gateway.invoke('write_file', [{
    label: 'C cannot borrow A', goal_id: a.id,
  }, extra('session-C', 'foreign')]);
  assert.notEqual(unrelated.isError, true);
  assert.equal(calls.length, before + 1, 'unrelated session executes without inherited Goal');
  assert.equal(unrelated.structuredContent.goal, undefined);
  assert.equal((await inSession('session-A', () => getGoal(workspace, 'session-A'))).id, a.id);
  assert.equal((await inSession('session-B', () => getGoal(workspace, 'session-B'))).id, b.id);
  assert.equal(await readDriverLease(workspace, a.id), null);
  assert.equal(await readDriverLease(workspace, b.id), null);
  const aReceipts = await listOperationInspections(workspace, 256, a.id);
  const bReceipts = await listOperationInspections(workspace, 256, b.id);
  assert.equal(aReceipts.filter(receipt => receipt.goal_id === a.id).length, 2);
  assert.equal(bReceipts.filter(receipt => receipt.goal_id === b.id).length, 2);
  assert.ok(aReceipts.every(receipt => !receipt.goal_id || receipt.goal_id === a.id));
  assert.ok(bReceipts.every(receipt => !receipt.goal_id || receipt.goal_id === b.id));
  const replacement = await inSession('session-A', () => createGoal(workspace, {
    objective: 'Goal A replacement', success_criteria: [{ name: 'new work', passed: false }],
  }));
  const callsBeforeReplacement = calls.length;
  const staleContract = await gateway.invoke('write_file', [{ label: 'must not inherit old Goal', _intent: '{invalid' }, extra('session-A', 'replacement-stale-reference')]);
  assert.notEqual(staleContract.isError, true);
  assert.equal(staleContract.structuredContent.goal, replacement.id);
  assert.equal(calls.length, callsBeforeReplacement + 1);
  assert.equal((await invoke('session-A', { label: 'replacement fresh intent', _intent: intent('replacement') }, 'replacement-ready')).goal, replacement.id);
  assert.equal((await invoke('session-B', { label: 'B after A replacement' }, 'B-still-owned')).goal, b.id);
  console.log('Gateway Goal isolation: session ownership, spoof resistance, direct execution and scoped receipts passed');
} finally {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
