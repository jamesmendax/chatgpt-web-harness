import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { assertDistMatches } = createRequire(import.meta.url)('../.release-tools/build-policy.cjs');
// Never delete the shared output, which a live service may use. Compare it to a
// clean isolated compilation and reject leftover files or divergent bytes.
export function assertFreshCheckoutDist(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-clean-dist-'));
  try {
    const fresh = path.join(temp, 'dist');
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '--outDir', fresh], { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Isolated clean compilation failed: ${result.error || result.status}`);
    assertDistMatches(fresh, path.join(root, 'dist'), { packaged: false });
  } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
// Load the compiler output being fingerprinted, never a previous checkout build.
export async function writeBuildManifest(root) {
  const moduleUrl = pathToFileURL(path.join(root,'dist/lib/build-fingerprint.js')).href;
  const { runtimeContent } = await import(moduleUrl);
  const manifest=runtimeContent(root);
  fs.writeFileSync(path.join(root,'dist/build-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return manifest;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const root=process.argv[2]?path.resolve(process.argv[2]):path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  assertFreshCheckoutDist(root);
  const manifest=await writeBuildManifest(root);
  console.log(`Build ${manifest.version} ${manifest.content_sha256.slice(0,16)} (${manifest.files.length} runtime files)`);
}
