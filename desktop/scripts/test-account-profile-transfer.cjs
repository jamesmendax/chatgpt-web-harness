"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const transfer=require("../src/account-profile-transfer");
const tx=require("../src/account-import-transaction");
const crypto=require("node:crypto");
const {makeSound}=require("./generate-notification-sounds.cjs");
function fixture(t) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),"wh-profile-transfer-")),source=path.join(base,"source"),target=path.join(base,"target");
 const profiles=path.join(source,"runtime","profiles"),installed=path.join(profiles,"local-skills","alpha");
 fs.mkdirSync(path.join(installed,"scripts"),{recursive:true});fs.mkdirSync(target);
 fs.writeFileSync(path.join(installed,"SKILL.md"),"---\nname: alpha\ndescription: synthetic\n---\n");
 fs.writeFileSync(path.join(installed,"scripts","run.js"),"console.log('test-only');\n");
 fs.writeFileSync(path.join(profiles,"plugins.json"),JSON.stringify({schema_version:2,computer_use:{enabled:false},browser_use:{enabled:true},skills:[{id:"alpha",source:"installed",enabled:false}]}));
 fs.writeFileSync(path.join(profiles,"mcp-upstream.json"),JSON.stringify({version:1,servers:[{id:"synthetic",command:"node",args:["unused"]}]}));
 t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
 return {base,source,target,profiles,installed};
}
test("source inventory migrates complete installed Skill, disabled flag and MCP without missing files",t=>{
 const f=fixture(t),s=transfer.scan(f.source);
 assert.equal(s.summary.installedSkills,1);assert.equal(s.summary.registeredSkills,1);assert.equal(s.summary.mcpServers,1);assert.equal(s.summary.skillFiles,2);
 const p=transfer.makePlan(s,f.target);assert.equal(p.changes.length,4);
 const committed=tx.commit(f.target,[...p.changes,{file:path.join(f.target,"accounts.json"),data:Buffer.from('{"version":1}'),expected:{existed:false}}]);
 assert.ok(fs.existsSync(path.join(committed.recoveryDir,"committed.flag")));
 assert.equal(fs.readFileSync(path.join(f.target,"runtime","profiles","local-skills","alpha","scripts","run.js"),"utf8"),"console.log('test-only');\n");
 const registry=JSON.parse(fs.readFileSync(path.join(f.target,"runtime","profiles","plugins.json"),"utf8"));
 assert.equal(registry.skills[0].enabled,false);assert.equal(registry.browser_use.enabled,true);
 const upstream=JSON.parse(fs.readFileSync(path.join(f.target,"runtime","profiles","mcp-upstream.json"),"utf8"));
 assert.equal(upstream.servers[0].id,"synthetic");
 assert.equal(transfer.makePlan(s,f.target).changes.length,0);
 assert.equal(tx.recoverPending(f.target).length,0);
});
test("source edits after preview fail before target writes",t=>{
 const f=fixture(t),snap=transfer.scan(f.source);
 fs.appendFileSync(path.join(f.installed,"SKILL.md"),"modified");
 assert.throws(()=>transfer.makePlan(snap,f.target),/变化/);
 assert.equal(fs.existsSync(path.join(f.target,"runtime")),false);
});
test("existing user-modified Skill content is never overwritten",t=>{
 const f=fixture(t),dst=path.join(f.target,"runtime","profiles","local-skills","alpha");
 fs.mkdirSync(dst,{recursive:true});fs.writeFileSync(path.join(dst,"SKILL.md"),"custom");
 assert.throws(()=>transfer.makePlan(transfer.scan(f.source),f.target),/冲突/);
 assert.equal(fs.readFileSync(path.join(dst,"SKILL.md"),"utf8"),"custom");
});
test("publishing failure restores original registry and leaves no imported files",t=>{
 const f=fixture(t),original='{"version":1,"selectedId":"default"}';
 fs.writeFileSync(path.join(f.target,"accounts.json"),original);
 const changes=transfer.makePlan(transfer.scan(f.source),f.target).changes;
 const rename=fs.renameSync;
 try {fs.renameSync=function(src,dst){if(path.resolve(dst)===path.join(f.target,"accounts.json"))throw Error("injected publish failure");return rename.apply(this,arguments);};
 assert.throws(()=>tx.commit(f.target,[...changes,{file:path.join(f.target,"accounts.json"),data:Buffer.from("new index")}]),/injected publish failure/);
 } finally {fs.renameSync=rename;}
 assert.equal(fs.readFileSync(path.join(f.target,"accounts.json"),"utf8"),original);
 assert.equal(fs.existsSync(path.join(f.target,"runtime","profiles","plugins.json")),false);
 assert.equal(fs.existsSync(path.join(f.target,"runtime","profiles","local-skills","alpha","SKILL.md")),false);
});
test("pending journal from interrupted publication recovers before normal startup",t=>{
 const f=fixture(t),destination=path.join(f.target,"runtime","profiles","plugins.json"),prior='{"schema_version":2,"skills":[]}';
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,prior);
 const dir=path.join(f.target,"account-recovery","import-txn-111-1234567890abcdef");
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,"0.bak"),prior);
 fs.writeFileSync(path.join(dir,"journal.json"),JSON.stringify({version:2,root:path.resolve(f.target),files:[{rel:path.join("runtime","profiles","plugins.json"),existed:true,backup:"0.bak",sha256:tx.digest(Buffer.from(prior)),newSha256:tx.digest(Buffer.from('{"changed":true}'))}]}));
 fs.writeFileSync(destination,'{"changed":true}');
 assert.deepEqual(tx.recoverPending(f.target),["import-txn-111-1234567890abcdef"]);
 assert.equal(fs.readFileSync(destination,"utf8"),prior);
});
test("a concurrent target edit after backup survives rejected transaction without stale rollback",t=>{
 const f=fixture(t),destination=path.join(f.target,"runtime","profiles","plugins.json");
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 fs.writeFileSync(destination,"original");
 const changedByAnotherWriter="concurrent-update";
 const originalCopy=fs.copyFileSync;
 let injected=false;
 try {
   fs.copyFileSync=function(source,target,flags){
     const result=originalCopy.apply(this,arguments);
     if(!injected && path.resolve(source)===path.resolve(destination) && /0\.bak$/.test(target)){
       injected=true;
       fs.writeFileSync(destination,changedByAnotherWriter);
     }
     return result;
   };
   assert.throws(()=>tx.commit(f.target,[{file:destination,data:Buffer.from("our-new-value")}],
     ()=>{throw Error("publish must not run");}),/预览后发生变化/);
 } finally {fs.copyFileSync=originalCopy;}
 assert.equal(injected,true);
 assert.equal(fs.readFileSync(destination,"utf8"),changedByAnotherWriter);
 assert.deepEqual(tx.recoverPending(f.target),[]);
 assert.equal(fs.readFileSync(destination,"utf8"),changedByAnotherWriter);
});
test("corrupted recovery copy fails before any target is restored, retaining original files and journal",t=>{
 const f=fixture(t),config=path.join(f.target,"config.json");
 const plugins=path.join(f.target,"runtime","profiles","plugins.json");
 fs.mkdirSync(path.dirname(plugins),{recursive:true});
 fs.writeFileSync(config,"current credential");
 fs.writeFileSync(plugins,"current skills");
 const dir=path.join(f.target,"account-recovery","import-txn-222-1234567890abcdef");
 fs.mkdirSync(dir,{recursive:true});
 const ok=Buffer.from("saved skills"),invalid=Buffer.from("corrupted credential");
 fs.writeFileSync(path.join(dir,"0.bak"),invalid);
 fs.writeFileSync(path.join(dir,"1.bak"),ok);
 const sha=s=>crypto.createHash("sha256").update(s).digest("hex");
 fs.writeFileSync(path.join(dir,"journal.json"),JSON.stringify({version:1,root:path.resolve(f.target),files:[
  {rel:"config.json",existed:true,backup:"0.bak",sha256:sha("real credential backup")},
  {rel:path.join("runtime","profiles","plugins.json"),existed:true,backup:"1.bak",sha256:sha(ok)}
 ]}));
 assert.throws(()=>tx.recoverPending(f.target),/备份校验失败/);
 assert.equal(fs.readFileSync(config,"utf8"),"current credential");
 assert.equal(fs.readFileSync(plugins,"utf8"),"current skills");
 assert.equal(fs.existsSync(path.join(dir,"rolled-back.flag")),false);
 assert.equal(fs.existsSync(path.join(dir,"journal.json")),true);
});
test("conversation names and custom selected WAV migrate as owned account attachments without altering source",t=>{
 const f=fixture(t);
 const index=path.join(f.profiles,"conversation-index.json");
 const names={schema:1,nextNumber:2,records:[{id:"oai_conv_"+"a".repeat(32),number:1,
  title:"发行安全检查",alias:"",lastAt:Date.now(),createdAt:Date.now(),pinned:false}]};
 const wav=makeSound("waterdrop"),audio=path.join(f.source,"notification-sounds","custom.wav");
 fs.mkdirSync(path.dirname(audio),{recursive:true});
 fs.writeFileSync(index,JSON.stringify(names));
 fs.writeFileSync(audio,wav);
 const before=fs.readFileSync(audio),scan=transfer.scan(f.source);
 assert.equal(scan.summary.hasCustomAudio,true);assert.equal(scan.summary.hasConversationNames,true);
 const plan=transfer.makePlan(scan,f.target);
 assert.equal(plan.changes.length,6);
 tx.commit(f.target,plan.changes);
 assert.deepEqual(fs.readFileSync(path.join(f.target,"runtime","profiles","conversation-index.json")),fs.readFileSync(index));
 assert.deepEqual(fs.readFileSync(path.join(f.target,"notification-sounds","custom.wav")),wav);
 assert.deepEqual(fs.readFileSync(audio),before);
 assert.equal(transfer.makePlan(scan,f.target).changes.length,0);
});
test("conflicting existing notification WAV refuses overwrite and changed source is detected",t=>{
 const f=fixture(t),audio=path.join(f.source,"notification-sounds","custom.wav");
 fs.mkdirSync(path.dirname(audio),{recursive:true});
 fs.writeFileSync(audio,makeSound("waterdrop"));
 const snapshot=transfer.scan(f.source);
 const dst=path.join(f.target,"notification-sounds","custom.wav");
 fs.mkdirSync(path.dirname(dst),{recursive:true});fs.writeFileSync(dst,makeSound("bells"));
 assert.throws(()=>transfer.makePlan(snapshot,f.target),/拒绝自动覆盖/);
 assert.deepEqual(fs.readFileSync(dst),makeSound("bells"));
 fs.rmSync(dst);
 fs.writeFileSync(audio,makeSound("digital"));
 assert.throws(()=>transfer.makePlan(snapshot,f.target),/预览后变化/);
});

test("target registry edit after merge planning rejects before any writes",t=>{
 const f=fixture(t),p=path.join(f.target,"runtime","profiles","plugins.json");fs.mkdirSync(path.dirname(p),{recursive:true});
 const base={schema_version:2,computer_use:{enabled:false},browser_use:{enabled:false},skills:[]};fs.writeFileSync(p,JSON.stringify(base));
 const plan=transfer.makePlan(transfer.scan(f.source),f.target),edited=JSON.stringify({...base,extra:"external"});fs.writeFileSync(p,edited);
 assert.throws(()=>tx.commit(f.target,plan.changes),/预览后发生变化/);assert.equal(fs.readFileSync(p,"utf8"),edited);
 assert.equal(fs.existsSync(path.join(f.target,"runtime","profiles","local-skills")),false);
});
