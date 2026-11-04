import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  executeOperation, inspectOperation, listOperationInspections,
  listUnresolvedOperationInspections, listAuthorityBlockingOperationInspections,
} from '../dist/lib/operation-journal.js';
import { scopedOperationIdentity } from '../dist/lib/mcp-request-identity.js';
import { resilienceDirectory } from '../dist/lib/transport-resilience.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-goal-journal-'));
const saved = new Map(['CODEX_HOME', 'MCP_OPERATION_JOURNAL_OBSERVE_WAIT_MS'].map(key => [key, process.env[key]]));
// This test process has a private runtime; no application state is read or changed.
process.env.CODEX_HOME = path.join(temp, 'runtime');
process.env.MCP_OPERATION_JOURNAL_OBSERVE_WAIT_MS = '20';
const hash = value => createHash('sha256').update(value).digest('hex');
const operationHash = value => createHash('sha256').update('operation-identity-v1\0').update(value).digest('hex');
const result = marker => ({ content: [{ type: 'text', text: marker }] });
const receiptPath = (root, goal, identity) => path.join(resilienceDirectory(root), 'operations',
  ...(goal ? ['goals', hash(goal)] : []), 'operation-' + operationHash(identity) + '.json');
let checks = 0;
async function check(name, action) {
  const root = path.join(temp, String(++checks));
  await fs.mkdir(root, { recursive: true });
  await action(root);
  console.log('PASS ' + name);
}
function latch() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function entered(promise) {
  let timer;
  try { await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('owned fixture did not enter')), 5_000);
  })]); } finally { clearTimeout(timer); }
}
const options = (root, goalId, identity, ownerSessionId = 'owner-one') => ({
  workspaceRoot: root, goalId, ownerSessionId, identity, tool: 'fixture', args: { identity },
});

try {
  await check('same operation ID in two Goals executes independently and deduplicates within each', async root => {
    const effects = { A: 0, B: 0 };
    const values = await Promise.all(['A', 'B'].flatMap(goal => Array.from({ length: 8 }, () =>
      executeOperation(options(root, goal, 'shared-id'), async () => {
        effects[goal]++;
        await new Promise(resolve => setTimeout(resolve, 15));
        return result(goal);
      }))));
    assert.deepEqual(effects, { A: 1, B: 1 });
    assert.equal(values.filter(value => value.content[0].text === 'A').length, 8);
    assert.equal(values.filter(value => value.content[0].text === 'B').length, 8);
    assert.equal((await inspectOperation(root, 'shared-id', 'A')).goal_id, 'A');
    assert.equal((await inspectOperation(root, 'shared-id', 'B')).goal_id, 'B');
    assert.equal(await inspectOperation(root, 'shared-id'), null);
    assert.deepEqual((await listOperationInspections(root, 256, 'A')).map(value => value.goal_id), ['A']);
    assert.deepEqual(new Set((await listOperationInspections(root)).map(value => value.goal_id)), new Set(['A', 'B']));
  });

  await check('explicit operation survives an authorized same-Goal session handoff', async root => {
    const namespace = { principalId: 'local-fixture', tunnelProfile: 'test', goalId: 'goal-A' };
    const first = scopedOperationIdentity({ ...namespace, conversationSessionId: 'old-owner' }, 'transport-1', 1, 'write-once');
    const next = scopedOperationIdentity({ ...namespace, conversationSessionId: 'new-owner' }, 'transport-2', 99, 'write-once');
    assert.equal(first, next);
    assert.notEqual(first, scopedOperationIdentity({ ...namespace, goalId: 'goal-B', conversationSessionId: 'new-owner' }, 'transport-2', 99, 'write-once'));
    assert.notEqual(first, scopedOperationIdentity({ ...namespace, principalId: 'other', conversationSessionId: 'new-owner' }, 'transport-2', 99, 'write-once'));
    let effects = 0;
    const original = await executeOperation(options(root, 'goal-A', first, 'old-owner'), async () => {
      effects++; return result('durable-original');
    });
    const recovered = await executeOperation({ ...options(root, 'goal-A', next, 'new-owner'), observe: true },
      async () => assert.fail('observation replayed the effect'));
    assert.deepEqual(recovered, original);
    assert.equal(effects, 1);
    assert.equal((await inspectOperation(root, first, 'goal-A')).owner_session_id, 'old-owner');
  });

  await check('Goal A unresolved effects cannot fence B; self exclusion also checks Goal', async root => {
    const aStarted = latch(), aRelease = latch(), bStarted = latch(), bRelease = latch();
    const operationA = executeOperation(options(root, 'A', 'other-effect'), async () => {
      aStarted.resolve(); await aRelease.promise; return result('A');
    });
    const operationB = executeOperation(options(root, 'B', 'transfer'), async () => {
      bStarted.resolve(); await bRelease.promise; return result('B');
    });
    try {
      await entered(Promise.all([aStarted.promise, bStarted.promise]));
      const boundary = new Date(Date.now() - 1000).toISOString();
      assert.deepEqual((await listUnresolvedOperationInspections(root, 'A')).map(row => row.goal_id), ['A']);
      const transfer = await executeOperation(options(root, 'A', 'transfer'), async () => {
        const a = await listAuthorityBlockingOperationInspections(root, boundary, 'A');
        const b = await listAuthorityBlockingOperationInspections(root, boundary, 'B');
        assert.deepEqual(a.map(row => row.operation_id), [operationHash('other-effect')]);
        assert.deepEqual(b.map(row => row.operation_id), [operationHash('transfer')]);
        assert.equal(b[0].goal_id, 'B', 'same digest in B must not be excluded as A current invocation');
        return result('transferred');
      });
      assert.deepEqual(transfer, result('transferred'));
    } finally {
      aRelease.resolve(); bRelease.resolve();
      await Promise.all([operationA, operationB]);
    }
    assert.deepEqual(await listAuthorityBlockingOperationInspections(root, new Date().toISOString(), 'B'), []);
  });

  await check('unassigned legacy receipt cannot become a fresh scoped side effect', async root => {
    let effects = 0;
    await executeOperation(options(root, undefined, 'legacy'), async () => { effects++; return result('old'); });
    const blocked = await executeOperation(options(root, 'A', 'legacy'), async () => { effects++; return result('new'); });
    assert.equal(blocked.isError, true);
    assert.match(JSON.stringify(blocked), /OPERATION_LEGACY_SCOPE_UNRESOLVED/);
    const renamed = await executeOperation({ ...options(root, 'A', 'new-key'), legacyIdentity: 'legacy', observe: true },
      async () => assert.fail('legacy observation executed'));
    assert.match(JSON.stringify(renamed), /OPERATION_LEGACY_SCOPE_UNRESOLVED/);
    await assert.rejects(inspectOperation(root, 'legacy', 'A'), /OPERATION_LEGACY_SCOPE_UNRESOLVED/);
    assert.equal(effects, 1);
  });

  await check('unknown legacy ownership stays a barrier even for an old dead owner', async root => {
    const identity = 'unknown-old';
    const id = operationHash(identity);
    const file = receiptPath(root, undefined, identity);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({
      version: 1, operation_id: id, identity_sha256: id,
      tool: 'fixture', tool_sha256: hash('fixture'), args_sha256: hash('{}'),
      state: 'executing', created_at: new Date(0).toISOString(),
      started_at: new Date(0).toISOString(), owner_pid: 2147483647,
      result_redacted: false, result_available: false,
    }));
    for (const goal of ['A', 'B']) {
      const blockers = await listAuthorityBlockingOperationInspections(root, new Date().toISOString(), goal);
      assert.deepEqual(blockers.map(row => row.operation_id), [id]);
      assert.equal(blockers[0].goal_id, undefined);
    }
  });

  await check('receipt copied across Goal directories is rejected rather than replayed', async root => {
    await executeOperation(options(root, 'A', 'copy'), async () => result('A-result'));
    const b = receiptPath(root, 'B', 'copy');
    await fs.mkdir(path.dirname(b), { recursive: true });
    await fs.copyFile(receiptPath(root, 'A', 'copy'), b);
    const blocked = await executeOperation(options(root, 'B', 'copy'), async () => assert.fail('cross-Goal receipt executed'));
    assert.match(JSON.stringify(blocked), /OPERATION_GOAL_SCOPE_MISMATCH/);
    await assert.rejects(listOperationInspections(root, 256, 'B'), /OPERATION_GOAL_SCOPE_MISMATCH/);
  });

  await check('same Goal receipt copied across workspaces cannot authorize replay', async root => {
    const otherRoot = path.join(root, 'another-workspace');
    await fs.mkdir(otherRoot, { recursive: true });
    await executeOperation(options(root, 'A', 'copy-workspace'), async () => result('original'));
    const copied = receiptPath(otherRoot, 'A', 'copy-workspace');
    await fs.mkdir(path.dirname(copied), { recursive: true });
    await fs.copyFile(receiptPath(root, 'A', 'copy-workspace'), copied);
    const blocked = await executeOperation(options(otherRoot, 'A', 'copy-workspace'), async () => assert.fail('foreign workspace executed'));
    assert.match(JSON.stringify(blocked), /OPERATION_WORKSPACE_SCOPE_MISMATCH/);
  });

  await check('invalid Goal provenance never reaches the effect callback', async root => {
    for (const goalId of ['', ' A', 'A\0B', 'x'.repeat(513)]) {
      const blocked = await executeOperation(options(root, goalId, 'invalid'), async () => assert.fail('invalid scope executed'));
      assert.match(JSON.stringify(blocked), /OPERATION_GOAL_INVALID/);
    }
  });
  console.log('Goal operation isolation: ' + checks + '/' + checks + ' checks passed');
} finally {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
