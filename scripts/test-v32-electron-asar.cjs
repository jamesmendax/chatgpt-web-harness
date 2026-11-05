// This child test must be launched by run-v32-electron-asar.cjs using the
// verified candidate Electron. Its private fixture is cleaned by the parent
// only after Electron has closed.
const assert = require('node:assert/strict');
const fs = require('original-fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const crypto = require('node:crypto');
(async () => {
  assert(process.versions.electron, 'Must run in the actual packaged Electron runtime');
  const nonce = process.env.HARNESS_V32_ASAR_PARENT_NONCE || '';
  const scope = process.env.HARNESS_V32_ASAR_TMP_ROOT || '';
  assert.match(nonce, /^[a-f0-9]{64}$/, 'Must be launched by the isolated ASAR parent');
  assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'Must run in Electron Node mode');
  assert.ok(scope && path.isAbsolute(scope), 'Parent fixture scope is required');
  assert.equal(path.resolve(os.tmpdir()).toLowerCase(), path.resolve(scope).toLowerCase(), 'Temporary root differs from the parent scope');
  const resources = path.resolve(process.argv[2] || '');
  const archive = path.join(resources, 'app.asar');
  const dist = path.join(resources, 'harness', 'dist');
  assert(fs.statSync(archive).isFile(), 'candidate resources/app.asar missing');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-v32-electron-'));
  process.env.CHECKPOINT_PATH = path.join(tmp, 'checkpoints');
  process.env.CHECKPOINT_MAX_FILE_BYTES = String(fs.statSync(archive).size + 1);
  try {
    const physical = await import(pathToFileURL(path.join(dist, 'lib', 'physical-fs.js')).href);
    const paths = await import(pathToFileURL(path.join(dist, 'lib', 'path-security.js')).href);
    const checkpoint = await import(pathToFileURL(path.join(dist, 'lib', 'checkpoint.js')).href);
    const tooling = await import(pathToFileURL(path.join(dist, 'tools', 'filesystem.js')).href);
    paths.setDefaultCwd(tmp);
    const source = path.join(tmp, '归档 # 100%.asar');
    fs.copyFileSync(archive, source);
    assert(physical.default.statSync(source).isFile());
    assert(require('node:fs').statSync(source).isDirectory(), 'fixture is not being interpreted as a virtual ASAR by Electron');
    const handlers = new Map();
    tooling.registerFilesystemTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, tmp);
    const copy = path.join(tmp, 'copy.asar');
    let result = await handlers.get('copy_file')({ source, destination: copy });
    assert.equal(result.structuredContent.ok, true);
    assert(fs.statSync(copy).isFile());
    result = await handlers.get('delete_file')({ path: copy });
    assert.equal(result.structuredContent.data.deleted, true);
    assert(!fs.existsSync(copy));
    const id = result.structuredContent.data.checkpoint_id;
    assert(id, 'delete did not create a checkpoint');
    const restored = await checkpoint.restoreToCheckpoint(id);
    assert.deepEqual(restored.skipped, []);
    assert(fs.statSync(copy).isFile());
    assert.equal(fs.statSync(source).size, fs.statSync(copy).size);
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, archive, copy_delete_checkpoint_restore: true }));
  } finally {
    // Electron may retain a virtual archive handle until exit. The parent
    // checks the receipt and scope, waits for close, and performs cleanup.
    console.log('V32_FIXTURE_CLEANUP_DEFERRED ' + JSON.stringify({
      tmp, proof: crypto.createHash('sha256').update(nonce).digest('hex'),
    }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
