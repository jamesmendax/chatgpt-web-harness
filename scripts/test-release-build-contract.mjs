import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { assertTestManifest, dailyTests, fullTests, historicalTests, nodeArgs, root } from './active-test-manifest.mjs';

const { includeDist, includeDesktop, includeProfile, transformDist, assertDistMatches, readAsarFile } = createRequire(import.meta.url)('../.release-tools/build-policy.cjs');
const { toolchain, assertReceipts } = createRequire(import.meta.url)('../.release-tools/toolchain-receipts.cjs');
const { parseMode, assertBuildMode } = createRequire(import.meta.url)('../.release-tools/candidate-mode.cjs');
const { assertSourceManifest } = createRequire(import.meta.url)('../.release-tools/source-signature.cjs');
const { privateUserProfilePath } = createRequire(import.meta.url)('../.release-tools/source-privacy.cjs');
const profile=(name,separator='\\')=>['C:','Users',name,'AppData','Local'].join(separator);
for(const name of ['Example','Example User'])for(const separator of ['\\','/','\\\\'])assert.equal(privateUserProfilePath.test(profile(name,separator)),true);
for(const name of ['<user>','    <username>    '])for(const separator of ['\\','/','\\\\'])assert.equal(privateUserProfilePath.test(profile(name,separator)),false);
const { expectedRuntimeForTarget } = createRequire(import.meta.url)('../.release-tools/verify-exe-extraction.cjs');
const signedInputs={files:[{path:'src/index.ts',sha256:'first'},{path:'browser-companion/content.js',sha256:'second'}]};
assertSourceManifest(signedInputs,signedInputs.files);
assert.throws(()=>assertSourceManifest(signedInputs,signedInputs.files.slice(0,1)),/omitted participating input: browser-companion\/content.js/);
assert.throws(()=>assertSourceManifest(signedInputs,[signedInputs.files[0],{...signedInputs.files[1],sha256:'stale'}]),/changed participating input/);
assertTestManifest();
for (const test of historicalTests) assert.ok(!fullTests.includes(test) && !dailyTests.includes(test), `retired feature incorrectly active: ${test}`);
for (const test of ['scripts/test-retired-entrypoints.mjs', 'scripts/test-goal-subtask-completion.mjs', 'desktop/scripts/test-relay-retired.cjs']) {
  assert.ok(fullTests.includes(test) && dailyTests.includes(test), `current retirement/shared contract missing: ${test}`);
}
for (const name of [
  'scripts/test-route-skill-loading.mjs', 'scripts/test-route-skill-mcp.mjs',
  'scripts/test-binary-upload-integrity.mjs', 'scripts/test-skill-resources.mjs',
  'scripts/test-v32-execution.ts', 'scripts/test-v32-identity.ts', 'scripts/test-v32-skills.mjs',
  'scripts/test-v32-process.mjs', 'scripts/test-v32-visual.ts', 'scripts/test-result-phases.mjs',
  'scripts/test-retired-relay-compat.mjs', 'scripts/test-goal-run-crossprocess.mjs',
  'desktop/scripts/test-account-profile-transfer.cjs', 'desktop/scripts/test-account-import-transactions.cjs', 'desktop/scripts/test-account-delete-transactions.cjs',
  'desktop/scripts/test-ipc-source.cjs',
]) assert.ok(fullTests.includes(name) && dailyTests.includes(name), `${name} missing from active suites`);
for (const name of ['binary-upload-integrity', 'runtime-race-repairs', 'goal-run-crossprocess', 'result-phases', 'retired-relay-compat']) {
  assert.deepEqual(nodeArgs(`scripts/test-${name}.mjs`).slice(0, 2), ['--import', 'tsx']);
}
for (const name of ['scripts/test-v32-execution.ts', 'scripts/test-v32-identity.ts', 'scripts/test-v32-skills.mjs', 'scripts/test-v32-tooling.ts', 'scripts/test-v32-visual.ts']) {
  assert.deepEqual(nodeArgs(name).slice(0, 2), ['--import', 'tsx']);
  assert.ok(fullTests.includes(name), `3.2 source regression missing: ${name}`);
}
assert.ok(fullTests.includes('scripts/test-v32-checkpoint-concurrency.mjs'));
for (const name of ['scripts/test-requirement-readiness.mjs', 'scripts/test-intent-reference.mjs', 'scripts/test-visual-review.mjs']) {
  assert.ok(historicalTests.includes(name), `retired 3.2 contract lacks historical provenance: ${name}`);
  assert.ok(!fullTests.includes(name) && !dailyTests.includes(name), `retired 3.2 contract is active: ${name}`);
}
assert.equal(includeDist('admin/companion.js'), false);
assert.equal(includeDist('admin/companion.d.ts'), false);
assert.equal(includeDist('admin/companion-helper.js'), true);
assert.equal(includeDesktop('src/companion-runtime.js'), false);
assert.equal(includeDesktop('src/main.js'), true);
assert.match(fs.readFileSync(path.join(root, 'desktop/electron-builder.yml'), 'utf8'), /!src\/companion-\*\.js/);
for (const name of ['local-skills/a/SKILL.md', 'plugins.json', 'mcp-upstream.json.bak', 'private.yaml']) assert.equal(includeProfile(name), false, name);
assert.equal(includeProfile('defaults.json'), true);
assert.equal(parseMode([]), 'final');
assert.equal(parseMode(['--local-development']), 'local-development');
assert.throws(() => parseMode(['--local-development', '--local-development']), /Duplicate/);
const steps = names => names.map(name => ({ name, exit_code: 0, timed_out: false }));
const common = ['build', 'stage', 'portable-template', 'nsis', 'portable', 'retired-package-check', 'shared-packaged-safety'];
const localReport = {
  mode: 'local-development',
  gates: { offline_retired_package: 'passed', shared_packaged_safety: 'passed', benchmark: 'not_run', packaged_runtime: 'not_run', setup_install: 'not_run', clean_windows_machine: 'not_run', real_web: 'not_run' },
  steps: steps(common), packaged_acceptance: false, installer_executed: false, clean_profile_install_acceptance: false, portable_clean_profile_acceptance: false,
};
assertBuildMode(localReport, 'local-development');
assert.throws(() => assertBuildMode(localReport, 'final'), /mode/);
assert.throws(() => assertBuildMode({ ...localReport, gates: { ...localReport.gates, real_web: 'passed' } }, 'local-development'), /not_run/);
assert.throws(() => assertBuildMode({ ...localReport, steps: steps(common.filter(s => s !== 'retired-package-check')) }, 'local-development'), /retired-package-check/);
assert.throws(() => assertBuildMode({ ...localReport, steps: steps([...common, 'clean-host-acceptance']) }, 'local-development'), /Unexpected local-only step/);
const finalReport = { ...localReport, mode: 'final', gates: { ...localReport.gates, benchmark: 'passed', packaged_runtime: 'passed', setup_install: 'passed' }, steps: steps([...common, 'packaged-provider-acceptance', 'clean-host-acceptance']), packaged_acceptance: true, installer_executed: true, clean_profile_install_acceptance: true, portable_clean_profile_acceptance: true };
assertBuildMode(finalReport, 'final');
assert.throws(() => assertBuildMode({ ...finalReport, gates: { ...finalReport.gates, benchmark: 'not_run' } }, 'final'), /passed/);
assert.throws(() => assertBuildMode({ ...finalReport, clean_profile_install_acceptance: false }, 'final'), /true/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-release-contract-'));
try {
  const fresh = path.join(tmp, 'fresh'), packaged = path.join(tmp, 'packaged'), checkout = path.join(tmp, 'checkout');
  const write = (dir, name, data) => { const target = path.join(dir, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, data); };
  const helper=path.join(tmp,'nsis-elevate.exe');fs.writeFileSync(helper,'exact signed-or-unsigned builder helper');
  const helperInput={target:'nsis',path:'resources/elevate.exe',file:helper,bytes:fs.statSync(helper).size,sha256:createHash('sha256').update(fs.readFileSync(helper)).digest('hex')};
  const sharedRuntime=[{path:'resources/app.asar',bytes:3,sha256:'app'}];
  assert.equal(expectedRuntimeForTarget(sharedRuntime,'nsis',[helperInput]).length,2);
  assert.deepEqual(expectedRuntimeForTarget(sharedRuntime,'portable',[helperInput]),sharedRuntime);
  assert.throws(()=>expectedRuntimeForTarget(sharedRuntime,'nsis',[]),/Missing exact NSIS helper receipt/);
  assert.throws(()=>expectedRuntimeForTarget(sharedRuntime,'nsis',[{...helperInput,path:'resources/unknown.exe'}]),/Unreviewed/);
  fs.appendFileSync(helper,'changed');
  assert.throws(()=>expectedRuntimeForTarget(sharedRuntime,'nsis',[helperInput]),/input changed/);
  const archiveSource=path.join(tmp,'asar-source'),archive=path.join(tmp,'nested.asar');
  const nested='renderer/v3/aura/index.html',nestedBytes=Buffer.from('<html>actual nested package fixture</html>');
  write(archiveSource,nested,nestedBytes);
  await createRequire(import.meta.url)('../desktop/node_modules/@electron/asar').createPackage(archiveSource,archive);
  assert.deepEqual(readAsarFile(archive,nested),nestedBytes);
  assert.deepEqual(readAsarFile(archive,nested.replaceAll('/','\\')),nestedBytes);
  assert.throws(()=>readAsarFile(archive,'renderer/v3/aura/missing.html'),/not found/);
  const code = `import x from '@modelcontextprotocol/sdk'; import y from "playwright-core";`;
  write(fresh, 'index.js', code); write(fresh, 'admin/companion.js', 'retired');
  write(packaged, 'index.js', transformDist('index.js', Buffer.from(code)));
  write(checkout, 'index.js', code); write(checkout, 'admin/companion.js', 'retired');
  assertDistMatches(fresh, packaged);
  assertDistMatches(fresh, checkout, { packaged: false });
  write(packaged, 'admin/companion.js', 'retired');
  assert.throws(() => assertDistMatches(fresh, packaged), /inventory/);
  fs.rmSync(path.join(packaged, 'admin/companion.js'));
  write(packaged, 'index.js', code);
  assert.throws(() => assertDistMatches(fresh, packaged), /stale/);
  write(checkout, 'orphan.js', 'old compiled output');
  assert.throws(() => assertDistMatches(fresh, checkout, { packaged: false }), /inventory/);
  const receiptRepo = path.join(tmp, 'receipt-repo');
  for (const name of ['node_modules/typescript/package.json', 'node_modules/typescript/lib/_tsc.js', 'desktop/node_modules/electron-builder/package.json', 'desktop/node_modules/electron-builder/out/cli/cli.js']) write(receiptRepo, name, name);
  write(receiptRepo, 'scripts/active-test-manifest.mjs', 'export const fullTests = ["fixture-a", "fixture-b"];');
  const receiptRows = [{ test: 'fixture-a', exit_code: 0 }, { test: 'fixture-b', exit_code: 0 }];
  const log = path.join(tmp, 'test.log');
  fs.writeFileSync(log, receiptRows.map(row => `TEST_RECEIPT ${JSON.stringify(row)}\n`).join(''));
  const logHash = createHash('sha256').update(fs.readFileSync(log)).digest('hex');
  const report = { mode: 'root', toolchain: toolchain(receiptRepo, process.execPath), results: [{ name: 'root-all', log, log_sha256: logHash, tests: receiptRows }] };
  assertReceipts(report, receiptRepo, process.execPath, 'root');
  assert.throws(() => assertReceipts(report, receiptRepo, process.execPath, 'desktop'), /mode differs/);
  assert.throws(() => assertReceipts({ ...report, results: [{ ...report.results[0], tests: receiptRows.slice(0, 1) }] }, receiptRepo, process.execPath, 'root'), /complete active manifest/);
  fs.appendFileSync(log, 'tampered');
  assert.throws(() => assertReceipts(report, receiptRepo, process.execPath, 'root'), /Test log changed/);
  console.log('release-build-contract: active suites, loader flags, retirement, transforms and stale/orphan dist PASS');
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
