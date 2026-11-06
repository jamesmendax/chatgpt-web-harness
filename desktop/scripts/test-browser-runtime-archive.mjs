import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {archiveBrowserRuntime,browserRuntimeInventory,resolveLocal7zip} from './lib/browser-runtime-archive.mjs';
import isolation from './lib/test-isolation.cjs';
const desktopRoot=path.resolve(import.meta.dirname,'..'),root=isolation.artifactRoot('browser-runtime-archive');
const source=path.join(root,'source'),staging=path.join(root,'staging'),vendor=path.join(staging,'vendor','browser-use');
const inputs={'python/python.exe':Buffer.from([77,90,0,255,10]),'chrome/chrome-win64/chrome.exe':Buffer.from('MZ-offline-browser'),'site-packages/browser_use/__init__.py':Buffer.from('# retained offline'),'licenses/Python-LICENSE.txt':Buffer.from('license'),'SBOM.spdx.json':Buffer.from('{}'),'provenance.json':Buffer.from('{}'),'site-packages/unicode-测试.txt':Buffer.from('完整离线字节')};
try{
 for(const [name,bytes] of Object.entries(inputs)){const target=path.join(source,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
 fs.cpSync(source,vendor,{recursive:true});
 fs.writeFileSync(path.join(vendor,'debug.log'),'private diagnostic');assert.throws(()=>browserRuntimeInventory(vendor),/cache or private input/);fs.unlinkSync(path.join(vendor,'debug.log'));
 fs.mkdirSync(path.join(vendor,'__pycache__'));assert.throws(()=>browserRuntimeInventory(vendor),/cache or private input/);fs.rmdirSync(path.join(vendor,'__pycache__'));
 const before=browserRuntimeInventory(source),sevenZip=resolveLocal7zip(desktopRoot),manifest=archiveBrowserRuntime(staging,{sevenZip,desktopRoot});
 assert.deepEqual(manifest.files,before);assert.equal(manifest.file_count,Object.keys(inputs).length);assert.equal(fs.existsSync(vendor),false);assert.deepEqual(browserRuntimeInventory(source),before);
 const unpacked=path.join(root,'unpacked');
 const quote=value=>"'"+value.replaceAll("'","''")+"'";
 const extract=`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${quote(path.join(staging,'vendor',manifest.archive))},${quote(unpacked)})`;
 const result=sevenZip?spawnSync(sevenZip,['x',path.join(staging,'vendor',manifest.archive),'-o'+unpacked,'-y'],{encoding:'utf8',windowsHide:true}):spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(extract,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
 assert.deepEqual(browserRuntimeInventory(unpacked),before);assert.equal(fs.existsSync(path.join(unpacked,'browser-use')),false);
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(staging,'vendor',manifest.archive))).digest('hex'),manifest.sha256);
 console.log('PASS offline browser archive round-trips all bytes, Unicode paths and licenses; source remains unchanged; logs/cache are rejected');
}finally{const resolved=path.resolve(root);assert.ok(resolved.split(path.sep).includes('.validation'));fs.rmSync(resolved,{recursive:true,force:true});}
