#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('Windows packaging requires Windows.');
if (process.versions.electron) throw new Error('Use a standard Node.js executable, not the desktop Electron node.cmd shim.');
const environment = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const requiredTunnel = '00e8385cb2791f0ec5548e2c27030fb6eafa0e727ab54e51790e290dc2f817a0';
if (hash(path.join(root, 'bin/tunnel-client.exe')) !== requiredTunnel) throw new Error('Unexpected source tunnel binary; do not overwrite or unlock any live binary.');
function run(script, args = [], cwd = root) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env: environment, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (exit ${result.status}, signal ${result.signal})`);
}
run('node_modules/typescript/bin/tsc');
run('desktop/scripts/stage-harness.mjs');
if (hash(path.join(root, 'desktop/staging/harness/bin/tunnel-client.exe')) !== requiredTunnel) throw new Error('Staged tunnel hash mismatch.');
run('desktop/scripts/patch-portable-template.mjs');
for (const target of ['nsis', 'portable']) {
  run('node_modules/electron-builder/cli.js', ['--win', target, '--config', 'electron-builder.yml', '--publish=never'], path.join(root, 'desktop'));
}
console.log('Candidate packaging complete. No installer, candidate application or production service was started.');
