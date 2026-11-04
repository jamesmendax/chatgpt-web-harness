import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=process.env.HARNESS_TEST_RUNTIME_ROOT?path.resolve(process.env.HARNESS_TEST_RUNTIME_ROOT):source;
const pkg=JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8'));
const config=path.join(await fs.mkdtemp(path.join(os.tmpdir(),'packaged-fingerprint-')),'plugins.json');
await fs.writeFile(config,JSON.stringify({schema_version:2,skills:[]}));
process.env.CHATGPT_PLUGINS_CONFIG=config;process.env.HARNESS_APP_VERSION=pkg.version;
const {getRuntimeManifest}=await import(pathToFileURL(path.join(root,'dist/lib/runtime-manifest.js')).href);
const manifest=getRuntimeManifest(true);
assert.equal(manifest.stale_build,false,'final packaged content must match its regenerated build fingerprint');
assert.equal(manifest.fingerprint_status,'verified');
assert.equal(manifest.app_version,pkg.version);assert.equal(manifest.build_version,pkg.version);
await fs.access(path.join(root,'dist/lib/node-repl-worker.js'));
for(const id of ['codex-execution','project-engineering','visual-qa'])await fs.access(path.join(root,'skills',id,'SKILL.md'));
if(process.env.HARNESS_TEST_RUNTIME_ROOT){
 const staged=JSON.parse(await fs.readFile(path.join(root,'harness-version.json'),'utf8'));
 assert.equal(staged.runtime_content_sha256,manifest.content_sha256);
}
console.log('PASS packaged runtime fingerprint, version and REPL worker: '+manifest.build_id);
