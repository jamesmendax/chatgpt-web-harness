import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runtime = process.env.HARNESS_TEST_SOURCE === '1' ? '../src/' : '../dist/';
const suffix = process.env.HARNESS_TEST_SOURCE === '1' ? '.ts' : '.js';
const { writeTextFileCas, writeFileBytesCas, readFileForEdit } = await import(runtime + 'lib/safe-text-write' + suffix);
const { mutateUpstreamConfig, loadUpstreamConfig } = await import(runtime + 'lib/mcp-upstream-config' + suffix);
const { McpUpstreamManager } = await import(runtime + 'lib/mcp-upstream-manager' + suffix);

const sha = value => createHash('sha256').update(value).digest('hex');
const self = fileURLToPath(import.meta.url);
const serverConfig = id => ({ id, name: id, enabled: false, transport: 'http', url: 'http://127.0.0.1:1', expose: 'none' });
if (process.argv[2] === '--child') {
  const [, , , mode, file, value] = process.argv;
  try {
    if (mode === 'cas') await writeTextFileCas(file, value, { expectedSha256: sha('base') });
    else if (mode === 'create') await writeTextFileCas(file, value, { createOnly: true });
    else if (mode === 'crash-lock') await writeTextFileCas(file, value, {
      expectedSha256: sha('base'),
      beforePublish: async () => { process.exit(27); },
    });
    else await mutateUpstreamConfig(latest => ({ version: 1, servers: [...latest.servers, serverConfig(value)] }), file);
    process.exit(0);
  } catch (error) {
    if (error.message.startsWith('WRITE_CONFLICT:')) process.exit(12);
    throw error;
  }
}

const fixtureBase = path.resolve(process.env.HARNESS_TEST_TMP_ROOT || path.join(path.dirname(self), '../.validation/safe-text-write'));
await fs.mkdir(fixtureBase, { recursive: true });
const fixture = await fs.mkdtemp(path.join(fixtureBase, 'wh-cas-concurrency-'));
function child(mode, file, value) {
  const processHandle = spawn(process.execPath, [...process.execArgv, self, '--child', mode, file, value], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = '';
  processHandle.stderr.on('data', d => { error += d; });
  const timer = setTimeout(() => processHandle.kill(), 15000);
  return new Promise((resolve, reject) => {
    processHandle.once('error', reject);
    processHandle.once('close', code => { clearTimeout(timer); [0, 12, 27].includes(code) ? resolve(code) : reject(new Error(`child ${code}: ${error}`)); });
  });
}
try {
  const encodedTarget = path.join(fixture, 'encoded.txt');
  const oldBytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00]);
  const newBytes = Buffer.from([0xff, 0xfe, 0x42, 0x00, 0x0a, 0x00]);
  await fs.writeFile(encodedTarget, oldBytes);
  const revision = await readFileForEdit(encodedTarget);
  await writeFileBytesCas(encodedTarget, newBytes, { expectedRevision: revision.revision });
  assert.deepEqual(await fs.readFile(encodedTarget), newBytes, 'byte publisher does not transcode a UTF-16 BOM');
  await assert.rejects(writeFileBytesCas(encodedTarget, oldBytes, { expectedRevision: revision.revision }), /WRITE_CONFLICT/);
  const fresh = await readFileForEdit(encodedTarget);
  await assert.rejects(writeFileBytesCas(encodedTarget, oldBytes, { expectedRevision: fresh.revision,
    beforeCommit: () => fs.writeFile(encodedTarget, Buffer.from('external-before-rename')) }), /WRITE_CONFLICT/);
  assert.equal(await fs.readFile(encodedTarget, 'utf8'), 'external-before-rename', 'commit hook is followed by a fresh CAS check');
  if (process.platform === 'win32') {
    const rename = fs.rename;
    const retryTarget = path.join(fixture, 'sharing-retry.txt');
    const changedTarget = path.join(fixture, 'sharing-external.txt');
    const blockedTarget = path.join(fixture, 'sharing-blocked.txt');
    const denied = () => Object.assign(new Error('Fixture sharing violation'), { code: 'EPERM' });
    try {
      await fs.writeFile(retryTarget, 'base');
      let attempts = 0;
      fs.rename = async (from, to) => {
        if (to === retryTarget && ++attempts <= 2) throw denied();
        return rename(from, to);
      };
      await writeTextFileCas(retryTarget, 'recovered', { expectedSha256: sha('base') });
      assert.equal(attempts, 3, 'transient sharing failure retries the same atomic publication');
      assert.equal(await fs.readFile(retryTarget, 'utf8'), 'recovered');

      await fs.writeFile(changedTarget, 'base');
      fs.rename = async (from, to) => {
        if (to === changedTarget) { await fs.writeFile(to, 'external'); throw denied(); }
        return rename(from, to);
      };
      await assert.rejects(writeTextFileCas(changedTarget, 'ours', { expectedSha256: sha('base') }), /WRITE_CONFLICT/);
      assert.equal(await fs.readFile(changedTarget, 'utf8'), 'external', 'retry must not replace an intervening external edit');

      await fs.writeFile(blockedTarget, 'base'); attempts = 0;
      fs.rename = async (from, to) => { if (to === blockedTarget) { attempts++; throw denied(); } return rename(from, to); };
      await assert.rejects(writeTextFileCas(blockedTarget, 'ours', { expectedSha256: sha('base') }), error => error.code === 'EPERM');
      assert.ok(attempts > 1 && attempts <= 10, 'persistent sharing failures remain bounded');
      assert.equal(await fs.readFile(blockedTarget, 'utf8'), 'base', 'a failed publication preserves the existing file');
    } finally { fs.rename = rename; }
  }
  const target = path.join(fixture, 'target.txt');
  await fs.writeFile(target, 'base');
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => child('cas', target, `writer-${i}`)));
  assert.equal(results.filter(code => code === 0).length, 1, 'only one process may consume a SHA revision');
  const createTarget = path.join(fixture, 'create.txt');
  const creators = await Promise.all(Array.from({ length: 5 }, (_, i) => child('create', createTarget, `create-${i}`)));
  assert.equal(creators.filter(code => code === 0).length, 1, 'create-only is no-clobber across processes');

  const alias = path.join(fixture, 'alias');
  const real = path.join(fixture, 'real');
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(real, 'value.txt'), 'base');
  const aliases = await Promise.all([child('cas', path.join(alias, 'value.txt'), 'alias'), child('cas', path.join(real, 'value.txt'), 'real')]);
  assert.equal(aliases.filter(code => code === 0).length, 1, 'canonical aliases share the same revision lock');
  await assert.rejects(writeTextFileCas(target, 'ours', { beforePublish: () => fs.writeFile(target, 'external') }), /WRITE_CONFLICT/);
  assert.equal(await fs.readFile(target, 'utf8'), 'external');
  await assert.rejects(writeTextFileCas(target, 'ours', { beforePublish: async () => { throw new Error('checkpoint failure'); } }), /checkpoint failure/);
  assert.equal(await fs.readFile(target, 'utf8'), 'external');
  const invalidShaTarget = path.join(fixture, 'invalid-sha.txt');
  await fs.writeFile(invalidShaTarget, 'base');
  let invalidShaHookCalled = false;
  await assert.rejects(writeTextFileCas(invalidShaTarget, 'must-not-write', {
    expectedSha256: '',
    beforePublish: async () => { invalidShaHookCalled = true; },
  }), /Invalid expected_sha256/);
  assert.equal(invalidShaHookCalled, false, 'invalid CAS tokens fail before the mutation hook');
  assert.equal(await fs.readFile(invalidShaTarget, 'utf8'), 'base');

  const crashedWriterTarget = path.join(fixture, 'crashed-writer.txt');
  await fs.writeFile(crashedWriterTarget, 'base');
  assert.equal(await child('crash-lock', crashedWriterTarget, 'never-published'), 27);
  const recoveredCrash = await writeTextFileCas(crashedWriterTarget, 'recovered', { expectedSha256: sha('base') });
  assert.equal(recoveredCrash.sha256, sha('recovered'), 'a lock owned by a provably dead writer must be reclaimed');
  assert.equal(await fs.readFile(crashedWriterTarget, 'utf8'), 'recovered');

  // 0.2.9-rc.4 and older wrote zero-byte locks. Reclaim those only when an
  // old lock has an exact PID-bearing temp and that PID is provably dead.
  const legacyTarget = path.join(fixture, 'legacy-crashed-writer.txt');
  await fs.writeFile(legacyTarget, 'base');
  const canonicalLegacyTarget = await fs.realpath(legacyTarget);
  const legacyKey = process.platform === 'win32' ? canonicalLegacyTarget.toLowerCase() : canonicalLegacyTarget;
  const legacyLock = path.join(path.dirname(canonicalLegacyTarget), `.cas-${sha(legacyKey)}.lock`);
  const impossiblePid = 2147483647;
  const legacyTemp = `${canonicalLegacyTarget}.${impossiblePid}.${randomUUID()}.cas-tmp`;
  await fs.writeFile(legacyLock, '');
  await fs.writeFile(legacyTemp, 'uncommitted');
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(legacyLock, old, old);
  await fs.utimes(legacyTemp, old, old);
  await writeTextFileCas(legacyTarget, 'legacy-recovered', { expectedSha256: sha('base') });
  assert.equal(await fs.readFile(legacyTarget, 'utf8'), 'legacy-recovered');
  await assert.rejects(fs.access(legacyLock), error => error?.code === 'ENOENT');
  await assert.rejects(fs.access(legacyTemp), error => error?.code === 'ENOENT');

  const config = path.join(fixture, 'config.json');
  const mutations = await Promise.all(Array.from({ length: 6 }, (_, i) => child('config', config, `server-${i}`)));
  assert.ok(mutations.every(code => code === 0));
  assert.equal((await loadUpstreamConfig(config)).servers.length, 6, 'concurrent additions survive');
  const manager = new McpUpstreamManager(config);
  await manager.init();
  await mutateUpstreamConfig(latest => ({ version: 1, servers: [...latest.servers, serverConfig('external')] }), config);
  await manager.upsertServer(serverConfig('manager'));
  assert.equal((await loadUpstreamConfig(config)).servers.length, 8, 'stale manager must preserve external additions');
  assert.equal(await manager.removeServer('server-0'), true);
  assert.ok((await loadUpstreamConfig(config)).servers.some(row => row.id === 'external'));
  await manager.shutdown();
  await fs.writeFile(config, '{broken');
  await assert.rejects(mutateUpstreamConfig(latest => latest, config), SyntaxError);
  assert.equal(await fs.readFile(config, 'utf8'), '{broken', 'corrupt config is never reset');
  const leftovers = (await fs.readdir(fixture, { recursive: true })).filter(name => /\.cas-tmp$|\.lock$/.test(name));
  assert.deepEqual(leftovers, []);
  console.log('safe-text-write: cross-process CAS/create-only, canonical alias, external change, failed checkpoint, concurrent config merge, stale manager and corrupt config PASS');
} finally {
  assert.ok(path.dirname(path.resolve(fixture)) === fixtureBase && path.basename(fixture).startsWith('wh-cas-concurrency-'));
  await fs.rm(fixture, { recursive: true, force: true });
}
