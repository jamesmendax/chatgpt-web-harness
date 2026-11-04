"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),{spawnSync}=require("node:child_process");
const tx=require("../src/account-import-transaction"),modulePath=require.resolve("../src/account-import-transaction");
function fixture(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),"wh-import-crash-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,"runtime","profiles"),{recursive:true});fs.writeFileSync(path.join(root,"config.json"),"old-config");fs.writeFileSync(path.join(root,"runtime","profiles","plugins.json"),"old-plugins");fs.writeFileSync(path.join(root,"accounts.json"),"old-index");return root;}
function crash(root) {
 const code=`const fs=require('node:fs'),path=require('node:path'),tx=require(${JSON.stringify(modulePath)}),root=process.argv[1];const p=path.join(root,'runtime','profiles','plugins.json'),c=path.join(root,'config.json'),i=path.join(root,'accounts.json');const rename=fs.renameSync;fs.renameSync=function(a,b){const r=rename.apply(this,arguments);if(b===p)process.exit(77);return r};tx.commit(root,[{file:c,data:Buffer.from('new-config')},{file:p,data:Buffer.from('new-plugins')},{file:i,data:Buffer.from('new-index')}]);`;
 const child=spawnSync(process.execPath,["-e",code,root],{encoding:"utf8"});assert.equal(child.status,77,child.stderr);
}
test("process crash and second recovery interruption remain retryable",t=>{
 const root=fixture(t);crash(root);const plugin=path.join(root,"runtime","profiles","plugins.json"),cfg=path.join(root,"config.json"),rename=fs.renameSync;
 let hit=false;try {fs.renameSync=function(a,b){if(b===cfg&&!hit){hit=true;const e=Error("denied");e.code="EACCES";throw e;}return rename.apply(this,arguments);};assert.throws(()=>tx.recoverPending(root),/denied/);} finally {fs.renameSync=rename;}
 assert.equal(fs.readFileSync(plugin,"utf8"),"old-plugins");assert.equal(fs.readFileSync(cfg,"utf8"),"new-config");
 assert.equal(tx.recoverPending(root).length,1);assert.equal(fs.readFileSync(cfg,"utf8"),"old-config");assert.equal(fs.readFileSync(path.join(root,"accounts.json"),"utf8"),"old-index");assert.deepEqual(tx.recoverPending(root),[]);
});
test("external edit blocks full recovery before any file is changed",t=>{
 const root=fixture(t);crash(root);const plugin=path.join(root,"runtime","profiles","plugins.json"),cfg=path.join(root,"config.json");fs.writeFileSync(plugin,"external edit");assert.throws(()=>tx.recoverPending(root),/外部修改/);assert.equal(fs.readFileSync(cfg,"utf8"),"new-config");assert.equal(fs.readFileSync(plugin,"utf8"),"external edit");
});
test("legacy journal with unidentifiable changed state is retained",t=>{
 const root=fixture(t),dir=path.join(root,"account-recovery","import-txn-111-1234567890abcdef");fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,"0.bak"),"old-config");fs.writeFileSync(path.join(dir,"journal.json"),JSON.stringify({version:1,root,files:[{rel:"config.json",existed:true,backup:"0.bak",sha256:tx.digest(Buffer.from("old-config"))}]}));fs.writeFileSync(path.join(root,"config.json"),"unknown");assert.throws(()=>tx.recoverPending(root),/旧版不明状态/);assert.equal(fs.readFileSync(path.join(root,"config.json"),"utf8"),"unknown");
});
test("recovery refuses non-regular target and a failed disk write leaves old files",t=>{
 const root=fixture(t),p=path.join(root,"runtime","profiles","plugins.json"),cfg=path.join(root,"config.json"),write=fs.writeFileSync;
 try {fs.writeFileSync=function(file){if(typeof file==="string"&&file.includes(".import-tmp")){const e=Error("disk full");e.code="ENOSPC";throw e;}return write.apply(this,arguments);};assert.throws(()=>tx.commit(root,[{file:cfg,data:Buffer.from("new")}]),/disk full/);} finally {fs.writeFileSync=write;}
 assert.equal(fs.readFileSync(cfg,"utf8"),"old-config");crash(root);fs.unlinkSync(p);fs.mkdirSync(p);assert.throws(()=>tx.recoverPending(root),/不是普通文件/);assert.equal(fs.readFileSync(cfg,"utf8"),"new-config");
});
test("ambiguous lock owner is preserved",t=>{const root=fixture(t),lock=path.join(root,".account-mutation.lock");fs.writeFileSync(lock,"incomplete");assert.throws(()=>tx.recoverPending(root),/不明确/);assert.equal(fs.readFileSync(lock,"utf8"),"incomplete");});
test("hard exit after atomically installing gate is recoverable when owner is dead",t=>{
 const root=fixture(t),code=`const fs=require('node:fs'),tx=require(${JSON.stringify(modulePath)}),root=process.argv[1],link=fs.linkSync;fs.linkSync=function(a,b){const out=link.apply(this,arguments);if(b.endsWith('.account-mutation.gate'))process.exit(77);return out};tx.withLock(root,()=>{});`;
 const child=spawnSync(process.execPath,["-e",code,root],{encoding:"utf8"});assert.equal(child.status,77,child.stderr);const owner=JSON.parse(fs.readFileSync(path.join(root,".account-mutation.gate"),"utf8"));assert.equal(owner.pid,child.pid);assert.deepEqual(tx.recoverPending(root),[]);assert.equal(fs.existsSync(path.join(root,".account-mutation.gate")),false);
});
test("ambiguous gate owner and live gate owner fail closed",t=>{
 const root=fixture(t),gate=path.join(root,".account-mutation.gate");fs.writeFileSync(gate,"invalid");assert.throws(()=>tx.recoverPending(root),/不明确/);assert.equal(fs.readFileSync(gate,"utf8"),"invalid");fs.writeFileSync(gate,JSON.stringify({pid:process.pid}));assert.throws(()=>tx.recoverPending(root),/仍在运行/);assert.equal(fs.existsSync(gate),true);
});
