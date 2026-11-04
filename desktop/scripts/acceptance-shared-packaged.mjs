// Shared regression fixtures against the staged packaged runtime. All state is
// test-owned; this does not launch the installer or claim runtime acceptance.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..');
const runtime = path.join(path.resolve(process.env.HARNESS_RELEASE_ROOT), 'win-unpacked/resources/harness');
const env = { ...process.env, HARNESS_TEST_RUNTIME_ROOT: runtime, HARNESS_TEST_DIST_ROOT: path.join(runtime, 'dist') };
const scripts = ['test-packaged-runtime-fingerprint.mjs', 'test-node-repl-lifecycle.mjs', 'test-computer-use-session-persistence.mjs', 'test-browser-use-session-lifecycle.mjs'];
if (process.argv.includes('--providers')) scripts.push('test-computer-use-provider.mjs', 'test-browser-use-provider.mjs');
for (const script of scripts) {
  const result = spawnSync(process.execPath, [path.join(repo, 'scripts', script)], { cwd: repo, env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`${script} failed: ${result.error || result.status}`);
}
console.log(`SHARED_PACKAGED_SAFETY_PASS ${JSON.stringify(scripts)}`);
