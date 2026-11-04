import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  executeOperation,
  inspectOperation,
  listAuthorityBlockingOperationInspections,
  listOperationInspections,
  listUnresolvedOperationInspections,
} from '../dist/lib/operation-journal.js';
import { resilienceDirectory } from '../dist/lib/transport-resilience.js';

// The same test file provides exact-owned child processes for crash/restart.
if (process.argv[2] === '--list-unresolved') {
  const [root] = process.argv.slice(3);
  process.stdout.write(JSON.stringify(await listUnresolvedOperationInspections(root)));
  process.exit(0);
}
if (process.argv[2] === '--child') {
  const [root, identity, mode] = process.argv.slice(3);
  const result = await executeOperation({ workspaceRoot: root, identity, tool: 'fixture', args: { identity } }, async () => {
    await fs.appendFile(path.join(root, 'effects'), identity + '\n');
    if (mode === 'crash') process.exit(27);
    await new Promise(r => setTimeout(r, 80));
    return { content: [{ type: 'text', text: 'original' }] };
  });
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-operation-recovery-'));
const saved = new Map(['CODEX_HOME', 'MCP_OPERATION_JOURNAL_OBSERVE_WAIT_MS', 'MCP_OPERATION_JOURNAL_MAX_ENTRIES', 'MCP_OPERATION_JOURNAL_MAX_RESULT_BYTES'].map(k => [k, process.env[k]]));
process.env.CODEX_HOME = path.join(temp, 'runtime');
process.env.MCP_OPERATION_JOURNAL_OBSERVE_WAIT_MS = '100';
const options = (identity, root = temp) => ({ workspaceRoot: root, identity, tool: 'fixture', args: { identity } });
const value = { content: [{ type: 'text', text: 'original' }] };
const hash = identity => createHash('sha256').update('operation-identity-v1\0').update(identity).digest('hex');
const receiptPath = identity => path.join(resilienceDirectory(temp), 'operations', `operation-${hash(identity)}.json`);
function child(identity, mode = 'normal') {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [import.meta.filename, '--child', temp, identity, mode], {
      env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { p.kill(); reject(Error('owned fixture timeout')); }, 15000);
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
function childListUnresolved(root) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [import.meta.filename, '--list-unresolved', root], {
      env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { p.kill(); reject(Error('owned unresolved-list fixture timeout')); }, 15000);
    p.once('error', e => { clearTimeout(timer); reject(e); });
    p.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}
let count = 0;
async function check(name, run) { await run(); count++; console.log('PASS ' + name); }
try {
  await check('ten concurrent identical operations execute once', async () => {
    let effects = 0;
    const results = await Promise.all(Array.from({ length: 10 }, () => executeOperation(options('ten'), async () => {
      effects++; await new Promise(r => setTimeout(r, 30)); return value;
    })));
    assert.equal(effects, 1);
    for (const result of results) assert.deepEqual(result, value);
  });
  await check('identity mismatch refuses new arguments and tool', async () => {
    for (const delta of [{ args: { changed: true } }, { tool: 'different' }]) {
      const result = await executeOperation({ ...options('ten'), ...delta }, async () => assert.fail('duplicate execution'));
      assert.equal(result.isError, true);
    }
  });
  await check('abort before acceptance is safe to retry', async () => {
    const controller = new AbortController(); controller.abort();
    const result = await executeOperation({ ...options('abort'), signal: controller.signal }, async () => assert.fail('aborted handler ran'));
    assert.equal(result.isError, true);
    assert.equal(await inspectOperation(temp, 'abort'), null);
    assert.deepEqual(await executeOperation(options('abort'), async () => value), value);
  });
  await check('original failure persists without repeated handler execution', async () => {
    const failure = new Error('raw-private-error');
    await assert.rejects(executeOperation(options('failure'), async () => { throw failure; }), e => e === failure);
    const replay = await executeOperation(options('failure'), async () => assert.fail('failure reran'));
    assert.equal(replay.isError, true);
    assert.equal((await inspectOperation(temp, 'failure')).state, 'failed');
    assert.ok(!(await fs.readFile(receiptPath('failure'), 'utf8')).includes('raw-private-error'));
  });
  await check('completed result survives process restart', async () => {
    const first = await child('restart'); assert.equal(first.code, 0, first.err);
    const second = await child('restart'); assert.equal(second.code, 0, second.err);
    assert.deepEqual(JSON.parse(first.out), JSON.parse(second.out));
    assert.equal((await fs.readFile(path.join(temp, 'effects'), 'utf8')).split('\n').filter(s => s === 'restart').length, 1);
  });
  await check('workspace aliases share one durable operation receipt', async () => {
    const realRoot = path.join(temp, 'workspace-real');
    const aliasRoot = path.join(temp, 'workspace-alias');
    await fs.mkdir(realRoot, { recursive: true });
    await fs.symlink(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasOptions = root => ({ workspaceRoot: root, identity: 'workspace-alias', tool: 'fixture', args: { same: true } });
    let effects = 0;
    await executeOperation(aliasOptions(realRoot), async () => { effects++; return value; });
    const replay = await executeOperation(aliasOptions(aliasRoot), async () => { effects++; return value; });
    assert.equal(effects, 1, 'a junction alias must not create a second journal namespace');
    assert.deepEqual(replay, value);
    assert.equal((await inspectOperation(realRoot, 'workspace-alias'))?.operation_id,
      (await inspectOperation(aliasRoot, 'workspace-alias'))?.operation_id);
  });
  await check('crash after effect remains indeterminate and never reexecutes', async () => {
    const first = await child('crash', 'crash'); assert.equal(first.code, 27, first.err);
    const retry = await child('crash'); assert.equal(retry.code, 0, retry.err);
    assert.equal(JSON.parse(retry.out).isError, true);
    const inspection = await inspectOperation(temp, 'crash');
    assert.equal(inspection.state, 'executing');
    assert.ok((await listUnresolvedOperationInspections(temp)).some(item => item.operation_id === hash('crash')));
    const startedMs = Date.parse(inspection.started_at);
    assert.ok((await listAuthorityBlockingOperationInspections(temp, new Date(startedMs - 1).toISOString()))
      .some(item => item.operation_id === hash('crash')), 'current-authority indeterminate effect must block transfer');
    assert.equal((await listAuthorityBlockingOperationInspections(temp, new Date(startedMs + 1).toISOString()))
      .some(item => item.operation_id === hash('crash')), false,
      'dead-owner receipt predating a later authority remains non-replayable without fencing that later authority');
    assert.ok((await listUnresolvedOperationInspections(temp)).some(item => item.operation_id === hash('crash')),
      'retired-authority receipt remains in the durable unresolved/do-not-repeat set');
    assert.equal((await fs.readFile(path.join(temp, 'effects'), 'utf8')).split('\n').filter(s => s === 'crash').length, 1);
  });
  await check('two independent processes cannot duplicate an effect', async () => {
    const results = await Promise.all([child('contended'), child('contended')]);
    for (const result of results) assert.equal(result.code, 0, result.err);
    assert.equal((await fs.readFile(path.join(temp, 'effects'), 'utf8')).split('\n').filter(s => s === 'contended').length, 1);
  });
  await check('corrupt receipt fails closed', async () => {
    await executeOperation(options('corrupt'), async () => value);
    await fs.writeFile(receiptPath('corrupt'), '{broken');
    const result = await executeOperation(options('corrupt'), async () => assert.fail('corrupt record reran'));
    assert.equal(result.isError, true);
    const independent = await executeOperation(options('independent'), async () => value);
    assert.deepEqual(independent, value, 'an unrelated identity remains independently usable');
  });
  await check('structured failure keeps failed outcome when result is not retained', async () => {
    process.env.MCP_OPERATION_JOURNAL_MAX_RESULT_BYTES = '512';
    const operation = options('structured-failure');
    const first = await executeOperation(operation, async () => ({
      content: [{ type: 'text', text: 'x'.repeat(2_000) }],
      structuredContent: { ok: false, detail: 'x'.repeat(2_000) },
    }));
    assert.equal(first.structuredContent?.ok, false);
    const replay = await executeOperation(operation, async () => assert.fail('structured failure reran'));
    assert.equal(replay.isError, true);
    assert.equal(replay.structuredContent?.data?.outcome, 'failed');
    assert.equal((await inspectOperation(temp, 'structured-failure'))?.state, 'failed');
    delete process.env.MCP_OPERATION_JOURNAL_MAX_RESULT_BYTES;
  });
  await check('credentials are absent from structured and text result storage', async () => {
    const data = { password: 'opaque-password-4938', nested: { token: 'opaque-token-3827' } };
    await executeOperation({ ...options('redact'), args: { secret: 'private-argument-7263' } }, async () => ({
      content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
    }));
    const raw = await fs.readFile(receiptPath('redact'), 'utf8');
    for (const secret of ['opaque-password-4938', 'opaque-token-3827', 'private-argument-7263']) assert.ok(!raw.includes(secret));
    assert.equal((await inspectOperation(temp, 'redact')).result_redacted, true);
  });
  await check('capacity exhaustion refuses admission without deleting dedup truth', async () => {
    const root = path.join(temp, 'capacity');
    process.env.MCP_OPERATION_JOURNAL_MAX_ENTRIES = '1';
    assert.deepEqual(await executeOperation(options('one', root), async () => value), value);
    const denied = await executeOperation(options('two', root), async () => assert.fail('capacity overflow executed'));
    assert.equal(denied.isError, true);
    assert.deepEqual(await executeOperation(options('one', root), async () => assert.fail('evicted receipt')), value);
    delete process.env.MCP_OPERATION_JOURNAL_MAX_ENTRIES;
  });
  await check('persistent unresolved index cannot lose an old effect behind 1024 terminal receipts', async () => {
    const root = path.join(temp, 'unresolved-index-window');
    const directory = path.join(resilienceDirectory(root), 'operations');
    await fs.mkdir(directory, { recursive: true });
    const digest = value => createHash('sha256').update(value).digest('hex');
    const toolDigest = digest('fixture-tool');
    const argsDigest = digest('fixture-args');
    const oldId = digest('old-unresolved-effect');
    const receipt = (operationId, state, date) => ({
      version: 1,
      operation_id: operationId,
      identity_sha256: operationId,
      tool: 'fixture',
      tool_sha256: toolDigest,
      args_sha256: argsDigest,
      state,
      created_at: date,
      accepted_at: date,
      ...(state === 'executing' ? { started_at: date } : { finished_at: date }),
      result_redacted: false,
      result_available: false,
    });
    await fs.writeFile(path.join(directory, `operation-${oldId}.json`), JSON.stringify(receipt(oldId, 'executing', new Date(0).toISOString())) + '\n');
    for (let i = 0; i < 1025; i++) {
      const operationId = digest(`terminal-${i}`);
      const date = new Date(1_000 + i).toISOString();
      await fs.writeFile(path.join(directory, `operation-${operationId}.json`), JSON.stringify(receipt(operationId, 'completed', date)) + '\n');
    }
    assert.equal((await listOperationInspections(root, 1024)).some(item => item.operation_id === oldId), false,
      'the legacy bounded view demonstrates the exact unsafe recency window');
    const unresolved = await listUnresolvedOperationInspections(root);
    assert.deepEqual(unresolved.map(item => item.operation_id), [oldId]);
    const indexFile = path.join(directory, '.unresolved-index.json');
    assert.deepEqual(JSON.parse(await fs.readFile(indexFile, 'utf8')).operation_ids, [oldId]);
    const restarted = await childListUnresolved(root);
    assert.equal(restarted.code, 0, restarted.err);
    assert.deepEqual(JSON.parse(restarted.out).map(item => item.operation_id), [oldId]);
    await fs.writeFile(indexFile, '{broken');
    await assert.rejects(listUnresolvedOperationInspections(root), /OPERATION_UNRESOLVED_INDEX_CORRUPT/);
  });
  await check('live or unprovable owners remain authority blockers even when receipts predate authority', async () => {
    const root = path.join(temp, 'authority-owner-liveness');
    const directory = path.join(resilienceDirectory(root), 'operations');
    await fs.mkdir(directory, { recursive: true });
    const digest = value => createHash('sha256').update(value).digest('hex');
    const writeExecuting = async (label, ownerPid) => {
      const operationId = digest(label);
      const date = new Date(Date.now() - 60_000).toISOString();
      await fs.writeFile(path.join(directory, `operation-${operationId}.json`), JSON.stringify({
        version: 1,
        operation_id: operationId,
        identity_sha256: operationId,
        tool: 'fixture',
        tool_sha256: digest('fixture-tool'),
        args_sha256: digest(label + '-args'),
        state: 'executing',
        created_at: date,
        accepted_at: date,
        started_at: date,
        result_redacted: false,
        result_available: false,
        ...(ownerPid === undefined ? {} : { owner_pid: ownerPid }),
      }) + '\n');
      return operationId;
    };
    const liveOwnerId = await writeExecuting('live-owner', process.pid);
    const missingOwnerId = await writeExecuting('missing-owner', undefined);
    const boundary = new Date().toISOString();
    const blockers = await listAuthorityBlockingOperationInspections(root, boundary);
    assert.deepEqual(new Set(blockers.map(item => item.operation_id)), new Set([liveOwnerId, missingOwnerId]));
    assert.equal((await listAuthorityBlockingOperationInspections(root, 'invalid-date')).length, 2,
      'invalid authority boundary must fail closed');
  });
  await check('authority transfer excludes only its own executing receipt', async () => {
    const root = path.join(temp, 'authority-self-receipt');
    await fs.mkdir(root, { recursive: true });
    let signalOtherEntered;
    let releaseOther;
    const otherEntered = new Promise(resolve => { signalOtherEntered = resolve; });
    const otherRelease = new Promise(resolve => { releaseOther = resolve; });
    const other = executeOperation(options('other-inflight', root), async () => {
      signalOtherEntered();
      await otherRelease;
      return value;
    });
    await otherEntered;
    const boundary = new Date(Date.now() - 1_000).toISOString();
    const result = await executeOperation(options('authority-transfer', root), async () => {
      const blockers = await listAuthorityBlockingOperationInspections(root, boundary);
      assert.deepEqual(blockers.map(item => item.operation_id), [hash('other-inflight')],
        'the current transfer receipt must not block itself, while a concurrent effect still blocks');
      return value;
    });
    assert.deepEqual(result, value);
    releaseOther();
    assert.deepEqual(await other, value);
    assert.deepEqual(await listUnresolvedOperationInspections(root), []);
  });
  await check('observe-only never claims or executes missing operation', async () => {
    const result = await executeOperation({ ...options('unseen'), observe: true }, async () => assert.fail('observe executed'));
    assert.equal(result.isError, true);
    assert.equal(await inspectOperation(temp, 'unseen'), null);
  });
  console.log(`operation-recovery: ${count}/${count} PASS; real owned process crash/restart and contention`);
} finally {
  for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fs.rm(temp, { recursive: true, force: true });
}
