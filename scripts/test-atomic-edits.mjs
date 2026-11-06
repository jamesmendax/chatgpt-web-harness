// Real filesystem tool callbacks and checkpoint store in an owned fixture.
// Faults affect only this fixture's temp/rename operations; no real disk-loss test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.resolve(process.env.HARNESS_TEST_TMP_ROOT || path.join(repo, '.validation', 'atomic-edits'));
await fs.mkdir(base, { recursive: true });
const root = await fs.mkdtemp(path.join(base, 'atomic-edits-'));
const output = process.env.HARNESS_ATOMIC_EDIT_REPORT;
Object.assign(process.env, { CODEX_HOME: path.join(root, 'codex'), CHECKPOINT_PATH: path.join(root, 'checkpoints'),
  CHECKPOINT_ENABLED: 'true', AUDIT_LOG_PATH: path.join(root, 'audit.log'), MCP_SHELL_STATE_DIR: path.join(root, 'shell') });
const runtime = process.env.HARNESS_TEST_SOURCE === '1' ? '../src/' : '../dist/';
const suffix = process.env.HARNESS_TEST_SOURCE === '1' ? '.ts' : '.js';
const load = name => import(runtime + name + suffix);
const { registerFilesystemTools } = await load('tools/filesystem');
const { setDefaultCwd, setAllowedRoots, setFullDiskAccess } = await load('lib/path-security');
const { readFileForEdit, writeFileBytesCas } = await load('lib/safe-text-write');
const { applyMultiFilePatch } = await load('lib/patch');
setDefaultCwd(root); setAllowedRoots([root]); setFullDiskAccess(false);
const handlers = new Map();
registerFilesystemTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, root);
const checks = [], failures = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function test(name, fn) {
  try { await fn(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ name, error: error.stack || String(error) }); console.error('FAIL ' + name + '\n' + (error.stack || error)); }
}
const tools = ['edit_file', 'multi_edit', 'replace_regex', 'apply_patch'];
function request(tool, file, dryRun = false) {
  const common = { path: file, dry_run: dryRun };
  if (tool === 'edit_file') return { ...common, old_text: 'OLD', new_text: 'NEW', replace_all: false };
  if (tool === 'multi_edit') return { ...common, edits: [{ old_text: 'OLD', new_text: 'MID' }, { old_text: 'MID', new_text: 'NEW' }] };
  if (tool === 'replace_regex') return { ...common, pattern: 'OLD', replacement: 'NEW', flags: 'g' };
  return { ...common, patch: '@@\n head\n-你好 OLD\n+你好 NEW\n tail\n' };
}
function encoded(encoding, marker) {
  const text = 'head\r\n你好 ' + marker + '\r\ntail\r\n';
  if (encoding === 'utf8') return Buffer.from(text, 'utf8');
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  return Buffer.concat([Buffer.from('head\r\n'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from(' ' + marker + '\r\ntail\r\n')]);
}
try {
  for (const tool of tools) for (const encoding of ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'gbk']) {
    await test(tool + ' preserves exact ' + encoding + ' bytes and checkpoint', async () => {
      const file = path.join(root, tool + '-' + encoding + '.txt'), before = encoded(encoding, 'OLD'), expected = encoded(encoding, 'NEW');
      await fs.writeFile(file, before); await fs.chmod(file, 0o755);
      const mode = (await fs.stat(file)).mode;
      const result = await handlers.get(tool)(request(tool, file));
      assert.equal(result.structuredContent.ok, true);
      assert.deepEqual(await fs.readFile(file), expected);
      assert.equal((await fs.stat(file)).mode, mode, 'mode is preserved after rename');
      const id = result.structuredContent.data.checkpoint_id; assert.ok(id, 'existing checkpoint is retained');
      const checkpointDir = path.join(root, 'checkpoints', 'data', id);
      const checkpoint = JSON.parse(await fs.readFile(path.join(checkpointDir, 'manifest.json'), 'utf8'));
      const entries = checkpoint.version === 2 ? (await fs.readFile(path.join(checkpointDir, 'entries.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) : checkpoint.files;
      const saved = entries.find(item => item.path === file); assert.ok(saved);
      const savedBytes = saved.blob ? await fs.readFile(path.join(root, 'checkpoints', 'data', id, saved.blob)) : Buffer.from(saved.content, saved.encoding === 'base64' ? 'base64' : 'utf8');
      assert.deepEqual(savedBytes, before, 'checkpoint contains exact pre-edit bytes');
    });
  }
  for (const tool of tools) {
    await test(tool + ' dry run keeps bytes and file identity unchanged', async () => {
      const file = path.join(root, tool + '-dry.txt'), before = encoded('gbk', 'OLD');
      await fs.writeFile(file, before); const original = await fs.stat(file);
      await handlers.get(tool)(request(tool, file, true));
      assert.deepEqual(await fs.readFile(file), before);
      assert.equal((await fs.stat(file)).ino, original.ino);
    });
    await test(tool + ' failed atomic publication leaves original intact', async () => {
      const file = path.join(root, tool + '-rename-fault.txt'), before = encoded('utf16be', 'OLD');
      await fs.writeFile(file, before); const rename = fs.rename;
      fs.rename = async (from, to) => {
        if (path.resolve(to) === path.resolve(file) && String(from).endsWith('.cas-tmp')) {
          assert.deepEqual(await fs.readFile(file), before, 'original remains intact right up to publication');
          assert.deepEqual(await fs.readFile(from), encoded('utf16be', 'NEW'));
          throw Object.assign(new Error('owned fixture rename failure'), { code: 'EIO' });
        }
        return rename(from, to);
      };
      try { await assert.rejects(handlers.get(tool)(request(tool, file)), /owned fixture rename failure/); }
      finally { fs.rename = rename; }
      assert.deepEqual(await fs.readFile(file), before);
    });
    await test(tool + ' external edit during checkpoint is not overwritten', async () => {
      const file = path.join(root, tool + '-external.txt'), before = encoded('gbk', 'OLD'), external = encoded('utf8', 'EXTERNAL');
      await fs.writeFile(file, before); const copyFile = fs.copyFile; let changed = false;
      fs.copyFile = async (...args) => {
        const result = await copyFile(...args);
        if (!changed && path.resolve(String(args[0])) === path.resolve(file)) {
          changed = true; await fs.writeFile(file, external);
        }
        return result;
      };
      try { await assert.rejects(handlers.get(tool)(request(tool, file)), /WRITE_CONFLICT/); }
      finally { fs.copyFile = copyFile; }
      assert.equal(changed, true); assert.deepEqual(await fs.readFile(file), external);
    });
  }
  await test('a partial temporary write failure cannot truncate the original', async () => {
    const file = path.join(root, 'partial-temp.txt'), before = encoded('utf8bom', 'OLD'); await fs.writeFile(file, before);
    const snapshot = await readFileForEdit(file), open = fs.open;
    fs.open = async (...args) => {
      const handle = await open(...args);
      if (!String(args[0]).startsWith(file + '.') || !String(args[0]).endsWith('.cas-tmp')) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === 'writeFile') return async bytes => { await target.writeFile(bytes.subarray(0, 7)); throw Object.assign(new Error('owned fixture short write failure'), { code: 'ENOSPC' }); };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    };
    try { await assert.rejects(writeFileBytesCas(file, encoded('utf8bom', 'NEW'), { expectedRevision: snapshot.revision }), /short write failure/); }
    finally { fs.open = open; }
    assert.deepEqual(await fs.readFile(file), before);
  });
  await test('identical decoded text with a different byte encoding still conflicts', async () => {
    const file = path.join(root, 'byte-cas.txt'), original = encoded('gbk', 'OLD'), external = encoded('utf8', 'OLD'); await fs.writeFile(file, original);
    const snapshot = await readFileForEdit(file);
    await assert.rejects(writeFileBytesCas(file, encoded('gbk', 'NEW'), { expectedRevision: snapshot.revision, beforeCommit: () => fs.writeFile(file, external) }), /WRITE_CONFLICT/);
    assert.deepEqual(await fs.readFile(file), external);
  });
  await test('replacement inode with identical bytes is not consumed', async () => {
    const file = path.join(root, 'identity-cas.txt'), before = encoded('utf8', 'OLD'); await fs.writeFile(file, before);
    const snapshot = await readFileForEdit(file);
    await assert.rejects(writeFileBytesCas(file, encoded('utf8', 'NEW'), { expectedRevision: snapshot.revision, beforeCommit: async () => {
      await fs.rename(file, file + '.displaced'); await fs.writeFile(file, before);
    } }), /WRITE_CONFLICT/);
    assert.deepEqual(await fs.readFile(file), before); assert.deepEqual(await fs.readFile(file + '.displaced'), before);
  });
  await test('prepared byte tampering is rejected before replacing the original', async () => {
    const file = path.join(root, 'prepared-cas.txt'), before = encoded('utf8', 'OLD'); await fs.writeFile(file, before);
    const snapshot = await readFileForEdit(file);
    await assert.rejects(writeFileBytesCas(file, encoded('utf8', 'NEW'), { expectedRevision: snapshot.revision, beforeCommit: async () => {
      const stage = (await fs.readdir(root)).find(name => name.startsWith('prepared-cas.txt.') && name.endsWith('.cas-tmp')); assert.ok(stage);
      await fs.writeFile(path.join(root, stage), 'tampered');
    } }), /WRITE_CONFLICT/);
    assert.deepEqual(await fs.readFile(file), before);
  });
  await test('failed publication cleans only the temporary inode it created', async () => {
    const file = path.join(root, 'replaced-stage.txt'), before = encoded('utf8', 'OLD'); await fs.writeFile(file, before);
    const snapshot = await readFileForEdit(file); let stage;
    await assert.rejects(writeFileBytesCas(file, encoded('utf8', 'NEW'), { expectedRevision: snapshot.revision, beforeCommit: async () => {
      const name = (await fs.readdir(root)).find(name => name.startsWith('replaced-stage.txt.') && name.endsWith('.cas-tmp')); assert.ok(name);
      stage = path.join(root, name); await fs.rename(stage, stage + '.displaced'); await fs.writeFile(stage, 'external-stage');
    } }), /WRITE_CONFLICT/);
    assert.deepEqual(await fs.readFile(file), before);
    assert.equal(await fs.readFile(stage, 'utf8'), 'external-stage', 'failure does not delete a replacement staging inode');
    assert.deepEqual(await fs.readFile(stage + '.displaced'), encoded('utf8', 'NEW'));
    await fs.unlink(stage); // This test deliberately created and verified the replacement.
  });
  await test('an exclusive temporary open failure cannot delete the competing file', async () => {
    const file = path.join(root, 'stage-open-conflict.txt'), before = encoded('utf8', 'OLD'); await fs.writeFile(file, before);
    const snapshot = await readFileForEdit(file), open = fs.open; let stage;
    fs.open = async (...args) => {
      if (String(args[0]).startsWith(file + '.') && String(args[0]).endsWith('.cas-tmp') && args[1] === 'wx') {
        stage = String(args[0]); await fs.writeFile(stage, 'competing-stage');
        throw Object.assign(new Error('owned fixture staging creator won'), { code: 'EEXIST' });
      }
      return open(...args);
    };
    try { await assert.rejects(writeFileBytesCas(file, encoded('utf8', 'NEW'), { expectedRevision: snapshot.revision }), /staging creator won/); }
    finally { fs.open = open; }
    assert.deepEqual(await fs.readFile(file), before); assert.equal(await fs.readFile(stage, 'utf8'), 'competing-stage');
    await fs.unlink(stage); // This test created the competing file in the owned fixture.
  });
  await test('two concurrent tools cannot consume the same byte revision', async () => {
    const file = path.join(root, 'concurrent.txt'); await fs.writeFile(file, encoded('utf8', 'OLD'));
    const results = await Promise.allSettled([handlers.get('edit_file')(request('edit_file', file)), handlers.get('multi_edit')(request('multi_edit', file))]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.deepEqual(await fs.readFile(file), encoded('utf8', 'NEW'));
  });
  await test('multi-file patch creation, update and move use byte publication', async () => {
    const source = path.join(root, 'move-source.txt'); await fs.writeFile(source, encoded('gbk', 'OLD')); await fs.chmod(source, 0o755);
    const mode = (await fs.stat(source)).mode;
    const result = await handlers.get('apply_patch')({ path: root, dry_run: false, patch: '*** Begin Patch\n*** Update File: move-source.txt\n*** Move to: move-target.txt\n@@\n-你好 OLD\n+你好 NEW\n*** Add File: created.txt\n+created\n*** End Patch' });
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
    assert.deepEqual(await fs.readFile(path.join(root, 'move-target.txt')), encoded('gbk', 'NEW'));
    assert.equal((await fs.stat(path.join(root, 'move-target.txt'))).mode, mode);
    await assert.rejects(fs.access(source), error => error.code === 'ENOENT');
    assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'created\n');
  });
  await test('canonical alias move does not reacquire its own lock or unlink the target', async () => {
    const real = path.join(root, 'real-dir'), alias = path.join(root, 'alias-dir'); await fs.mkdir(real); await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const source = path.join(real, 'alias.txt'); await fs.writeFile(source, encoded('utf8', 'OLD'));
    const result = await handlers.get('apply_patch')({ path: root, dry_run: false, patch: '*** Begin Patch\n*** Update File: real-dir/alias.txt\n*** Move to: alias-dir/alias.txt\n@@\n-你好 OLD\n+你好 NEW\n*** End Patch' });
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
    assert.deepEqual(await fs.readFile(source), encoded('utf8', 'NEW'));
  });
  if (process.platform === 'win32') await test('Windows case-only move preserves bytes and changes the directory entry case', async () => {
    const source = path.join(root, 'case-source.txt'); await fs.writeFile(source, encoded('utf16be', 'OLD'));
    const results = await applyMultiFilePatch('*** Begin Patch\n*** Update File: case-source.txt\n*** Move to: CASE-SOURCE.txt\n@@\n-你好 OLD\n+你好 NEW\n*** End Patch', { base_dir: root });
    assert.equal(results[0].ok, true, JSON.stringify(results));
    assert.deepEqual(await fs.readFile(path.join(root, 'CASE-SOURCE.txt')), encoded('utf16be', 'NEW'));
    const names = await fs.readdir(root); assert.ok(names.includes('CASE-SOURCE.txt')); assert.ok(!names.includes('case-source.txt'));
  });
  await test('opposite concurrent moves acquire their two locks in the same order', async () => {
    const left = path.join(root, 'opposite-a.txt'), right = path.join(root, 'opposite-b.txt');
    await fs.writeFile(left, 'left\n'); await fs.writeFile(right, 'right\n');
    const open = fs.open, arrived = new Set(); let release;
    const barrier = new Promise(resolve => { release = resolve; });
    fs.open = async (...args) => {
      const file = path.resolve(String(args[0]));
      if (args[1] === 'r' && [left, right].includes(file) && !arrived.has(file)) {
        arrived.add(file); if (arrived.size === 2) release(); await barrier;
      }
      return open(...args);
    };
    const move = (from, to) => '*** Begin Patch\n*** Update File: ' + path.basename(from) + '\n*** Move to: ' + path.basename(to) + '\n*** End Patch';
    let results;
    try { results = (await Promise.all([applyMultiFilePatch(move(left, right), { base_dir: root }), applyMultiFilePatch(move(right, left), { base_dir: root })])).flat(); }
    finally { fs.open = open; }
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.ok(results.some(result => !result.ok && /WRITE_CONFLICT/.test(result.error)), JSON.stringify(results));
    assert.ok(results.every(result => !/WRITE_LOCK_BUSY/.test(result.error || '')), JSON.stringify(results));
    const survivor = results.find(result => result.ok).moved_to;
    assert.equal(await fs.readFile(survivor, 'utf8'), survivor === right ? 'left\n' : 'right\n');
  });
  await test('a source change after destination publication is preserved and the move reports failure', async () => {
    const source = path.join(root, 'late-source.txt'), target = path.join(root, 'late-target.txt'); await fs.writeFile(source, 'original\n');
    const results = await applyMultiFilePatch('*** Begin Patch\n*** Update File: late-source.txt\n*** Move to: late-target.txt\n*** End Patch', {
      base_dir: root, before_commit: async file => { if (file === source) await fs.writeFile(source, 'external\n'); }
    });
    assert.equal(results[0].ok, false); assert.match(results[0].error, /WRITE_CONFLICT/);
    assert.equal(await fs.readFile(source, 'utf8'), 'external\n'); assert.equal(await fs.readFile(target, 'utf8'), 'original\n');
  });
  const leftovers = (await fs.readdir(root, { recursive: true })).filter(name => /\.cas-tmp$|\.lock$/.test(name));
  assert.deepEqual(leftovers, [], 'failed stages and owned locks are cleaned up');
  if (output) await fs.writeFile(output, JSON.stringify({ passed: failures.length === 0, checks, failures, fixtureRoot: root, sourceMode: process.env.HARNESS_TEST_SOURCE === '1', testCount: checks.length + failures.length }, null, 2));
  console.log('atomic-edits: ' + checks.length + ' passed, ' + failures.length + ' failed');
  if (failures.length) process.exitCode = 1;
} finally {
  assert.equal(path.dirname(path.resolve(root)), base); assert.ok(path.basename(root).startsWith('atomic-edits-'));
  await fs.rm(root, { recursive: true, force: true });
}
