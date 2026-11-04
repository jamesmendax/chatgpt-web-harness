import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const {sourceSignature}=require("../.release-tools/source-signature.cjs");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"release-source-signature-"));
try{
 const trackedFiles=["src/index.ts","browser-companion/content.js","bundled-plugins/browser-use/runtime-lock.json",".release-tools/verify.cjs","scripts/lib/tools-list-budget.mjs",".env.example"];
 for(const rel of trackedFiles){
  const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"initial");
 }
 let previous=sourceSignature(root);
 for(const rel of trackedFiles){
  fs.writeFileSync(path.join(root,rel),"changed "+rel);
  const current=sourceSignature(root);
  assert.notEqual(current.sha256,previous.sha256,rel+" must invalidate release verification");
  assert.ok(current.files.some(row=>row.path===rel));
  previous=current;
 }
 fs.mkdirSync(path.join(root,".harness"),{recursive:true});fs.writeFileSync(path.join(root,".harness","runtime-log.json"),"runtime observation");
 assert.equal(sourceSignature(root).sha256,previous.sha256);
 const cacheFile=path.join(root,".release-tools","cache","browser-use-runtime","fixture.bin");
 fs.mkdirSync(path.dirname(cacheFile),{recursive:true});fs.writeFileSync(cacheFile,"download cache");
 assert.deepEqual(sourceSignature(root),previous,"generated cache creation must not invalidate source verification");
 fs.writeFileSync(cacheFile,"changed download cache");
 assert.deepEqual(sourceSignature(root),previous,"generated cache changes must not invalidate source verification");
 const nestedCache=path.join(root,".release-tools","fixture","cache","release-input.cjs");
 fs.mkdirSync(path.dirname(nestedCache),{recursive:true});fs.writeFileSync(nestedCache,"source despite directory name");
 const withNestedCache=sourceSignature(root);
 assert.notEqual(withNestedCache.sha256,previous.sha256,"only the exact generated cache directory may be excluded");
 assert.ok(withNestedCache.files.some(row=>row.path===".release-tools/fixture/cache/release-input.cjs"));
 console.log(JSON.stringify({test:"release-source-signature",status:"PASS",covered_runtime_inputs:trackedFiles.length,runtime_evidence_excluded:true,exact_generated_cache_excluded:true}));
}finally{fs.rmSync(root,{recursive:true,force:true});}
