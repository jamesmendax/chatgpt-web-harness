import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setup, source, instrument, receipt } from './lib/context-events-test-fixture.mjs';

const { run, workspace } = await setup('context');
const records = [];
const runtime = await source('lib/runtime-scope.ts');
const identities = await source('lib/mcp-request-identity.ts');
const tasks = await source('lib/durable-tasks.ts');
const events = await source('lib/harness-events.ts');
const { module: broker, url: brokerUrl } = await instrument(run, 'context-broker.ts', text => {
  text = text.replace('async function loadCoreState(', 'async function loadCoreStateOriginal(');
  text = text.replace('import { readHarnessEventTail,', 'import { readHarnessEventTail as originalReadHarnessEventTail,');
  return `${text}\nlet auditCoreLoader; let auditTailReader;
    function loadCoreState(...args) { return auditCoreLoader ? auditCoreLoader(...args) : loadCoreStateOriginal(...args); }
    function readHarnessEventTail(...args) { return auditTailReader ? auditTailReader(...args) : originalReadHarnessEventTail(...args); }
    export const auditSetCoreLoader = value => { auditCoreLoader = value; };
    export const auditSetTailReader = value => { auditTailReader = value; };
    export const auditGetCore = getCachedCoreState;
    export const auditRefreshEvidence = refreshEvidenceWindow;
    export const auditStats = () => ({core:coreStateCache.size,evidence:evidenceWindows.size,retained:retainedByWorkspace.size,pending:pendingRetentionResets.size});
    export const auditEvidence = (ws,sid) => evidenceWindows.peek(scopeCacheKey(ws,sid))?.window;
    export const auditRetention = (ws,sid) => retainedByWorkspace.peek(scopeCacheKey(ws,sid))?.snapshot;
  `;
});
const seed = { workspaceRoot: workspace, projectRoots: [workspace], principalId: process.env.HARNESS_ACCOUNT_ID, tunnelProfile: process.env.CHATGPT_TUNNEL_PROFILE };
function scoped(conversation, transport, operation, overrides = {}) {
  const body = { params: { _meta: { 'openai/session': conversation } } };
  return identities.runWithMcpRequestIdentity({}, transport, () => {
    const scope = runtime.createRuntimeScope({ ...seed, ...overrides }, { sessionId: transport, _meta: body.params._meta });
    return runtime.runWithRuntimeScope(scope, () => operation(scope));
  }, body);
}
const toolResult = { content: [{ type: 'text', text: 'fixture result' }] };
const call = (conversation, transport, overrides) => scoped(conversation, transport,
  () => broker.appendHarnessRuntimeContextToResult(workspace, toolResult, { toolName: 'read_file' }), overrides);
const hasSnapshot = result => result.content.some(item => item.text?.includes('HARNESS CONTEXT'));
for (const name of ['a', 'b']) await scoped(name, `old-${name}`, () => tasks.createDurableTask(workspace, { goal: `Task ${name} at ${workspace}`, current_step: `step ${name}` }));
assert.equal(hasSnapshot(await call('a', 'old-a')), true);
assert.equal(hasSnapshot(await call('a', 'new-a')), false, 'trusted identity must dedupe across ordinary transport changes');
assert.equal(hasSnapshot(await call('b', 'old-b')), true);
assert.equal(hasSnapshot(await call('b', 'new-b')), false);
const aId = identities.conversationSessionIdFromMeta({ 'openai/session': 'a' });
broker.resetHarnessSnapshotRetention(workspace, aId, seed);
assert.equal(hasSnapshot(await call('a', 'new-a')), true, 'explicit outside-scope reset must match the trusted namespace');
assert.equal(hasSnapshot(await call('b', 'new-b')), false, 'another conversation must retain dedupe');
records.push({ id: 'trusted-transport-and-explicit-namespace', passed: true });

// Exact manager build/initialize code and real SDK transport, exposed only in
// an isolated transpiled copy. Web-standard Request/Response stays in process;
// the SDK wrapper's internal bridge is test-only, never production wiring.
const { module: managerModule } = await instrument(run, 'mcp-session-manager.ts', text => text
  .replace('from "./context-broker.js"', `from "${brokerUrl}"`)
  .replace(/return\s*\{\s*get\(sessionId: string\)/, 'return {\n    auditBuildSession: buildSession,\n    get(sessionId: string)'));
const manager = managerModule.createSessionManager({ ...seed, workspaceRoots: [workspace], shellTimeout: 1000, port: 0,
  createServer: () => new McpServer({ name: 'bounded-context-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } }) });
const transports = [];
async function initialize(preferred) {
  const session = await manager.auditBuildSession(preferred);
  transports.push(session);
  const response = await session.transport._webStandardTransport.handleRequest(new Request('http://fixture.invalid/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bounded-fixture', version: '1' } } }),
  }));
  assert.equal(response.status, 200);
  await response.text();
  return session.transport.sessionId;
}
try {
  const ordinary = await initialize();
  assert.equal(hasSnapshot(await call('a', ordinary)), false, 'normal manager initialize must preserve trusted conversation retention');
  await initialize('recovered-a');
  assert.equal(hasSnapshot(await call('b', 'unrelated-b')), false, 'recovery intent must not reset another transport');
  assert.equal(hasSnapshot(await call('a', 'recovered-a')), true, 'manager recovery must reset the resolved conversation exactly once');
  assert.equal(hasSnapshot(await call('a', 'recovered-a')), false);
  records.push({ id: 'actual-manager-recovery-binding', initialized: manager.count(), passed: true });
} finally {
  manager.stopCleanup();
  for (const session of transports) await session.server.close();
}

for (const [principalId, tunnelProfile] of [['other-principal', seed.tunnelProfile], [seed.principalId, 'other-tunnel']]) {
  const other = { principalId, tunnelProfile };
  await scoped('a', 'other', () => tasks.createDurableTask(workspace, { goal: `Other namespace ${principalId}/${tunnelProfile}`, current_step: 'other' }), other);
  assert.equal(hasSnapshot(await call('a', 'other', other)), true);
  broker.resetHarnessSnapshotRetention(workspace, aId, seed);
  assert.equal(hasSnapshot(await call('a', 'other', other)), false, 'explicit reset must not cross principal/tunnel');
}
records.push({ id: 'principal-tunnel-isolation', passed: true });

// Evidence still comes from real task-scoped files and retains only matching
// task/project records after a log replacement of the same byte length.
await scoped('a', 'evidence', async scope => {
  const task = await tasks.getDurableTask(workspace, await tasks.getActiveTaskId(workspace, scope.mcpSessionId));
  for (let i = 0; i < 40; i++) await events.appendHarnessEvent(workspace, { type: 'evidence/recorded', task_id: task.id,
    evidence_kind: 'deterministic', project_roots: [workspace], data: { summary: `evidence-${i}` } });
  for (let i = 0; i < 30; i++) await events.appendHarnessEvent(workspace, { type: 'evidence/recorded', task_id: task.id,
    project_roots: [workspace], data: { summary: `untyped-${i}` } });
  const context = await broker.buildHarnessRuntimeContext(workspace);
  assert.deepEqual(context.recent_evidence.map(item => item.summary), Array.from({ length: 5 }, (_, i) => `evidence-${35 + i}`));
  assert.ok(broker.auditEvidence(workspace, scope.mcpSessionId).items.length <= 24);
  const log = events.harnessEventLogPath(workspace);
  const replacement = `${log}.replacement`;
  await fs.writeFile(replacement, (await fs.readFile(log, 'utf8')).replace('evidence-39', 'evidence-99'));
  await fs.rename(replacement, log);
  assert.equal((await broker.buildHarnessRuntimeContext(workspace)).recent_evidence.at(-1).summary, 'evidence-99', 'same-size replacement must rebuild the evidence window');
  await fs.appendFile(log, '{"type":"evidence/recorded","seq":');
  await events.appendHarnessEvent(workspace, { type: 'evidence/recorded', task_id: task.id,
    evidence_kind: 'deterministic', project_roots: [workspace], data: { summary: 'after-repair' } });
  assert.equal((await broker.buildHarnessRuntimeContext(workspace)).recent_evidence.at(-1).summary, 'after-repair');
});
records.push({ id: 'task-evidence-window-replacement-repair', passed: true });

const emptyCore = { goal: null, goalRun: null, goalRunError: null, task: null, activeTaskId: null };
for (let i = 0; i < 20; i++) await scoped(`churn-${i}`, `churn-${i}`, async scope => {
  await broker.appendHarnessRuntimeContextToResult(workspace, toolResult, { toolName: 'agent_status' });
  await broker.auditRefreshEvidence(workspace, scope.mcpSessionId);
  broker.requestHarnessSnapshotRetentionReset(workspace, `pending-${i}`, seed);
});
for (const value of Object.values(broker.auditStats())) assert.ok(value <= 4);
records.push({ id: 'success-cache-cap', stats: broker.auditStats() });

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const pendingCore = deferred(); broker.auditSetCoreLoader(() => pendingCore.promise);
const parallel = Array.from({ length: 20 }, (_, i) => scoped(`parallel-${i}`, `parallel-${i}`,
  () => broker.appendHarnessRuntimeContextToResult(workspace, toolResult, { toolName: 'agent_status' })));
for (const value of Object.values(broker.auditStats())) assert.ok(value <= 4);
pendingCore.resolve(emptyCore); await Promise.all(parallel);
for (const value of Object.values(broker.auditStats())) assert.ok(value <= 4);
broker.auditSetCoreLoader(() => Promise.reject(new Error('fixture failed core')));
await Promise.all(Array.from({ length: 20 }, (_, i) => scoped(`failed-${i}`, `failed-${i}`, async scope => {
  await assert.rejects(broker.auditGetCore(workspace, scope.mcpSessionId), /fixture failed core/);
})));
broker.auditSetCoreLoader(undefined);
assert.equal(broker.auditStats().core, 0);
records.push({ id: 'concurrent-and-failed-core-cap', unique_sessions: 40, stats: broker.auditStats(), passed: true });

const old = deferred(); let first = true;
broker.auditSetCoreLoader(() => first ? (first = false, old.promise) : Promise.resolve(emptyCore));
await scoped('core-race', 'race', async scope => {
  const prior = broker.auditGetCore(workspace, scope.mcpSessionId);
  process.env.HARNESS_STATE_CACHE_TTL_MS = '600000';
  const newer = broker.auditGetCore(workspace, scope.mcpSessionId);
  old.reject(new Error('old load failed'));
  await assert.rejects(prior, /old load failed/);
  await newer;
  assert.equal(broker.auditGetCore(workspace, scope.mcpSessionId), newer, 'stale reject must not evict a newer success');
});
broker.auditSetCoreLoader(undefined);
process.env.HARNESS_STATE_CACHE_TTL_MS = '0';
records.push({ id: 'stale-core-rejection', passed: true });

const late = deferred(); broker.auditSetCoreLoader(() => late.promise);
await scoped('retention-race', 'race', async scope => {
  const pending = broker.appendHarnessRuntimeContextToResult(workspace, toolResult, { toolName: 'agent_status' });
  broker.resetHarnessSnapshotRetention(workspace, scope.mcpSessionId, seed);
  late.resolve(emptyCore);
  await pending;
  assert.equal(broker.auditRetention(workspace, scope.mcpSessionId), undefined, 'late context completion must not resurrect reset retention');
});
broker.auditSetCoreLoader(undefined);
records.push({ id: 'stale-retention-completion', passed: true });

const pendingTail = deferred(); broker.auditSetTailReader(() => pendingTail.promise);
await scoped('evidence-race', 'race', async scope => {
  const pending = broker.auditRefreshEvidence(workspace, scope.mcpSessionId);
  const duplicate = broker.auditRefreshEvidence(workspace, scope.mcpSessionId);
  const others = [];
  for (let i = 0; i < 10; i++) others.push(scoped(`other-evidence-${i}`, 'other', otherScope => broker.auditRefreshEvidence(workspace, otherScope.mcpSessionId)));
  // The artificial tail reader above also delays other keys; release before
  // awaiting those accesses so all completions can be checked together.
  pendingTail.resolve({ events: [], next_offset: 1, reset: false, file_identity: 'fixture' });
  await Promise.all([pending, duplicate, ...others]);
  assert.equal(broker.auditEvidence(workspace, scope.mcpSessionId), undefined);
});
broker.auditSetTailReader(undefined);
records.push({ id: 'stale-evidence-completion', passed: true });

process.env.HARNESS_CONTEXT_CACHE_IDLE_MS = '1';
await new Promise(resolve => setTimeout(resolve, 5));
assert.deepEqual(broker.auditStats(), { core: 0, evidence: 0, retained: 0, pending: 0 });
records.push({ id: 'idle-expiry', passed: true });
await receipt(run, ['src/lib/context-broker.ts', 'src/lib/bounded-context-cache.ts', 'src/lib/mcp-session-manager.ts', 'src/lib/harness-events.ts', 'scripts/test-context-broker-bounded.mjs'], records);
