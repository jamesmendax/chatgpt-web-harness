"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const storage=require("../src/credential-format");
test("legacy untagged encrypted credentials remain understood",()=>{
 const cfg={version:1,apiKeyEnc:"c3ludGhldGlj",adminTokenEnc:""};
 const info=storage.describe(cfg);
 assert.equal(info.schema,0);
 assert.equal(info.legacy,true);
 assert.equal(info.provider,"electron-safe-storage");
});
test("new metadata is version-neutral and does not change ciphertext",()=>{
 const encrypted="c3ludGhldGljLWtleQ==";
 const before={version:1,apiKeyEnc:encrypted,adminTokenEnc:"",autoStart:false};
 const newer=storage.markForSave(before);
 assert.equal(newer.apiKeyEnc,encrypted);
 assert.equal(newer.credentialFormat.schema,1);
 assert.equal(newer.credentialFormat.provider,"electron-safe-storage");
 assert.equal(newer.credentialFormat.scope,"electron-user-data");
 for(const exeRelease of ["3.0.3","3.0.4","4.0.0"]) {
   const cfg={...newer,desktopRelease:exeRelease};
   assert.equal(storage.describe(cfg).schema,1);
   assert.deepEqual(storage.markForSave(cfg).credentialFormat,newer.credentialFormat);
 }
 assert.equal(before.credentialFormat,undefined);
});
test("unknown future encryption provider or descriptor is rejected, not silently rewritten",()=>{
 const defaults={apiKeyEnc:"c3ludGhldGlj",adminTokenEnc:""};
 for(const descriptor of [
   {schema:2,provider:"electron-safe-storage",encoding:"base64",scope:"electron-user-data"},
   {schema:1,provider:"custom-crypto",encoding:"base64",scope:"electron-user-data"},
   {schema:1,provider:"electron-safe-storage",encoding:"hex",scope:"electron-user-data"},
   "v2",
   null
 ]) {
   assert.throws(()=>storage.describe({...defaults,credentialFormat:descriptor}),{code:"UNSUPPORTED_CREDENTIAL_FORMAT"});
   assert.throws(()=>storage.markForSave({...defaults,credentialFormat:descriptor}),{code:"UNSUPPORTED_CREDENTIAL_FORMAT"});
 }
});
test("no key means new metadata is optional and no key is invented",()=>{
 const cfg={apiKeyEnc:"",adminTokenEnc:"",minimizeToTray:true};
 assert.deepEqual(storage.markForSave(cfg),cfg);
});
