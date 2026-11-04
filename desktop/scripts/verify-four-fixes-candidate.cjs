"use strict";
// Read-only audit for an *offline candidate*. This never executes either EXE.
// The host may itself be Electron running as Node. In that case the default
// fs shim exposes *.asar as a virtual directory, hiding the physical archive.
process.noAsar = true;
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const asar=require("@electron/asar");
const desktop=path.resolve(__dirname,"..");
const version=require("../package.json").version;
const release=path.resolve(process.argv[2]||path.join(desktop,"release-"+version));
const old=path.join(desktop,"release","ChatGPT Web Harness Isolated-3.0.3-portable.exe");
const priorSha="8c58244007399abc132b024ed8772c82df4b1577c1715a5fb149f72a66c2bc0c";
function bytes(file){assert.ok(fs.existsSync(file),"Missing: "+file);assert.ok(fs.statSync(file).isFile(),"Not a file: "+file);return fs.readFileSync(file);}
function sha(b){return crypto.createHash("sha256").update(b).digest("hex");}
function pe(file){const buffer=bytes(file);assert.equal(buffer.toString("ascii",0,2),"MZ","Not Windows PE");assert.ok(buffer.length>5*1024*1024,"Truncated installer");return {file,size:buffer.length,sha256:sha(buffer)};}
const oldFile=pe(old);
assert.equal(oldFile.sha256,priorSha,"Existing 3.0.3 portable changed, refuse candidate approval");
const setup=pe(path.join(release,"ChatGPT Web Harness Isolated-"+version+"-setup.exe"));
const portable=pe(path.join(release,"ChatGPT Web Harness Isolated-"+version+"-portable.exe"));
const archive=path.join(release,"win-unpacked","resources","app.asar");
const unpacked=bytes(archive);
// @electron/asar's Windows resolver splits on path.sep, not '/'.
function embedded(rel){return asar.extractFile(archive,path.join(...rel.split("/")));}
const pkg=JSON.parse(embedded("package.json").toString("utf8"));
assert.equal(pkg.version,version);
assert.equal(pkg.name,"chatgpt-web-harness-isolated");
const checks=[
 ["src/accounts.js",["importTransaction.commit","prepareProfile","importTransaction.recoverPending"]],
 ["src/account-import.js",["prepareProfile","legacyCrypto","profileTransfer"]],
 ["src/account-import-transaction.js",["sha256","recoverPending","迁移备份校验失败"]],
 ["src/account-profile-transfer.js",["custom.wav","conversation-index.json","mcp-upstream.json"]],
 ["src/conversation-index.js",["oai_conv_","nextNumber","TTL_MS","AUTO_MAX"]],
 ["src/notification-sound.js",["waterdrop","xylophone","bells","digital"]],
 ["src/notification-audio-store.js",["importCustomWav","validateWav"]],
 ["renderer/v3/aura/app.js",["sound-choice","sound-file","conversation-label-list"]]
];
for(const [rel,phrases] of checks){
 const code=embedded(rel).toString("utf8");
 for(const term of phrases)assert.ok(code.includes(term),"Missing candidate integration: "+rel+" "+term);
}
const sounds=["chime","waterdrop","xylophone","bells","digital"];
const wavs=sounds.map(name=>{
 const file="src/assets/web-harness-"+name+".wav",buffer=embedded(file);
 assert.equal(buffer.toString("ascii",0,4),"RIFF");
 assert.equal(buffer.toString("ascii",8,12),"WAVE");
 return {name,size:buffer.length,sha256:sha(buffer)};
});
assert.equal(new Set(wavs.map(s=>s.sha256)).size,5,"Repeated sound in package");
const runtime=path.join(release,"win-unpacked","resources","harness");
const manifest=JSON.parse(bytes(path.join(runtime,"harness-files.json")).toString("utf8"));
assert.ok(manifest,"Staged runtime manifest missing");
const plugins=JSON.parse(bytes(path.join(runtime,"profiles","plugins.json")).toString("utf8"));
const mcp=JSON.parse(bytes(path.join(runtime,"profiles","mcp-upstream.json")).toString("utf8"));
assert.deepEqual(plugins.skills,[],"Personal installed Skills must never be staged");
assert.deepEqual(mcp.servers,[],"Personal upstream servers must never be staged");
for(const name of ["Local State","accounts.json","config.json","notification-sounds"])assert.equal(fs.existsSync(path.join(runtime,name)),false,"Private data in package: "+name);
const report={result:"offline-package-content-PASS",version,release,setup,portable,oldPortSha256:oldFile.sha256,
 asarBytes:unpacked.length,asarSha256:sha(unpacked),validatedModules:checks.length,
 sounds:wavs,embeddedRuntimeManifest:true,personalProfilesPacked:false,
 installedOrLaunched:false,systemAcceptance:false,cloudAcceptance:false};
console.log(JSON.stringify(report,null,2));
