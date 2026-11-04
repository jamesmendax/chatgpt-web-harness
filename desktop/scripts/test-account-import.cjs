"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const { createRequire } = require("node:module");
const src = path.resolve(__dirname, "../src");
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-import-test-")), root = path.join(temp,"target"), docs = path.join(temp,"docs"), source = path.join(temp,"source"), workspace = path.join(temp,"old-workspace");
  for (const dir of [root,docs,source,workspace]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(workspace,"keep"),"source workspace");
  const app = { getPath: name => name === "documents" ? docs : root, isPackaged:false, getVersion:()=>"test" };
  const electron = {app, safeStorage:{isEncryptionAvailable:()=>true, encryptString:value=>Buffer.from(`fixture:${value}`), decryptString:bytes=>{const text=bytes.toString(); if(!text.startsWith("fixture:"))throw Error("different user");return text.slice(8);} }};
  const cache = new Map();
  function load(file) {
    file=path.resolve(file); if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);const real=createRequire(file);
    vm.runInNewContext(fs.readFileSync(file,"utf8"),{module,exports:module.exports,require:name=>name==="electron"?electron:name.startsWith("./")&&!name.endsWith(".json")?load(real.resolve(name)):real(name),__dirname:path.dirname(file),__filename:file,process,Buffer,URL,console,setTimeout,clearTimeout,setInterval,clearInterval},{filename:file});return module.exports;
  }
  const config=load(path.join(src,"config.js")), context=load(path.join(src,"account-context.js")), paths=load(path.join(src,"paths.js"));
  const {AccountManager}=load(path.join(src,"accounts.js")), {AccountImport}=load(path.join(src,"account-import.js"));
  const manager=new AccountManager({app,config,paths,portFree:async()=>true}).init(), importer=new AccountImport({
    accounts:manager,config,legacyCrypto:{decryptFromSource:async({apiKeyEnc,adminTokenEnc})=>({
      apiKey:config.decryptKey({apiKeyEnc}),
      adminToken:adminTokenEnc?config.decryptAdminToken({adminTokenEnc}):""
    })}
  });
  const cfg={...config.DEFAULTS,tunnelId:"tunnel_11111111111111111111111111111111",apiKeyEnc:config.encryptKey("fixture-original-key"),adminTokenEnc:config.encryptKey("fixture-original-admin"),workspacePath:workspace,setupDone:true,autoStart:true,mcpPort:3300,adminPort:3301,tunnelPort:8380,unknownSecret:"never-copy"};
  const sourceFile=path.join(source,"config.json");fs.writeFileSync(sourceFile,JSON.stringify(cfg));
  const inspect=()=>importer.inspect(source), complete=preview=>importer.complete({token:preview.token,sourceId:preview.accounts[0].sourceId});
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  return {temp,root,source,sourceFile,workspace,cfg,manager,config,context,paths,importer,inspect,complete};
}
function seedProfile(f) {
  const root=path.join(f.source,"runtime","profiles"),skill=path.join(root,"local-skills","fixture-migrate");
  fs.mkdirSync(skill,{recursive:true});
  const content="---\nname: fixture-migrate\ndescription: offline migration-only fixture\n---\n# Fixture Skill\n";
  fs.writeFileSync(path.join(skill,"SKILL.md"),content);
  fs.writeFileSync(path.join(root,"plugins.json"),JSON.stringify({schema_version:2,computer_use:{enabled:false},browser_use:{enabled:false},skills:[{id:"fixture-migrate",source:"installed",enabled:false}]}));
  fs.writeFileSync(path.join(root,"mcp-upstream.json"),JSON.stringify({version:1,servers:[{id:"offline-mcp",command:"node",args:["--version"]}]}));
  const index={schema:1,nextNumber:2,records:[{id:"oai_conv_"+"a".repeat(32),number:1,title:"迁移资料",alias:"",createdAt:Date.now(),lastAt:Date.now(),pinned:false}]};
  fs.writeFileSync(path.join(root,"conversation-index.json"),JSON.stringify(index));
  const audio=path.join(f.source,"notification-sounds","custom.wav"),wav=require("./generate-notification-sounds.cjs").makeSound("waterdrop");
  fs.mkdirSync(path.dirname(audio),{recursive:true});fs.writeFileSync(audio,wav);
  const originals=new Map();
  for(const file of [path.join(skill,"SKILL.md"),path.join(root,"plugins.json"),path.join(root,"mcp-upstream.json"),path.join(root,"conversation-index.json"),audio])
    originals.set(file,fs.readFileSync(file));
  return {content,wav,originals};
}
test("blank adoption preserves exact ports, encrypted key, setup completion, source/workspace and recovery copy",async t=>{
  const f=fixture(t);f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS,minimizeToTray:false}));
  const previous=fs.readFileSync(path.join(f.root,"config.json"),"utf8"), source=fs.readFileSync(f.sourceFile,"utf8");
  const preview=f.inspect();assert.equal(JSON.stringify(preview).includes(f.cfg.apiKeyEnc),false);assert.equal(JSON.stringify(preview).includes("fixture-original-key"),false);
  const result=await f.complete(preview);assert.equal(result.accountId,"default");assert.equal(result.reused,false);
  const cfg=f.manager.readConfig("default");assert.equal(cfg.mcpPort,3300);assert.equal(cfg.adminPort,3301);assert.equal(cfg.tunnelPort,8380);assert.equal(cfg.setupDone,true);assert.equal(cfg.autoStart,false);assert.equal(f.config.decryptAdminToken(cfg),"fixture-original-admin");assert.equal(cfg.unknownSecret,undefined);assert.equal(f.config.decryptKey(cfg),"fixture-original-key");
  assert.equal(cfg.credentialFormat.schema,1);assert.equal(cfg.credentialFormat.provider,"electron-safe-storage");
  assert.equal(fs.readFileSync(f.sourceFile,"utf8"),source);assert.equal(fs.readFileSync(path.join(f.workspace,"keep"),"utf8"),"source workspace");
  const recovery=path.join(f.root,"account-recovery"),dir=path.join(recovery,fs.readdirSync(recovery)[0]);
  const journal=JSON.parse(fs.readFileSync(path.join(dir,"journal.json"),"utf8"));
  const saved=journal.files.find(row=>row.rel==="config.json");
  assert.equal(fs.readFileSync(path.join(dir,saved.backup),"utf8"),previous);
  assert.equal(fs.readFileSync(path.join(dir,"committed.flag"),"utf8"),"committed\n");
});
test("same Tunnel reuses existing identity without overwriting local key or ports, even when source key unreadable",async t=>{
  const f=fixture(t);f.manager.run("default",()=>f.config.save({...f.cfg,apiKeyEnc:f.config.encryptKey("local-key"),mcpPort:5500,adminPort:5501,tunnelPort:5502}));
  fs.writeFileSync(f.sourceFile,JSON.stringify({...f.cfg,apiKeyEnc:"unreadable"}));const bytes=fs.readFileSync(path.join(f.root,"config.json"),"utf8");
  const preview=f.inspect();assert.equal(preview.accounts[0].existingAccountId,"default");const result=await f.complete(preview);assert.equal(result.reused,true);assert.equal(result.accountId,"default");assert.equal(fs.readFileSync(path.join(f.root,"config.json"),"utf8"),bytes);
});
test("nonblank target adds unique UUID with source ports and preserves current config",async t=>{
  const f=fixture(t);f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS,apiKeyEnc:f.config.encryptKey("other"),mcpPort:5600,adminPort:5601,tunnelPort:5602}));
  const previous=fs.readFileSync(path.join(f.root,"config.json"),"utf8");const result=await f.complete(f.inspect());assert.match(result.accountId,/^[a-f0-9]{32}$/);assert.equal(f.manager.readConfig(result.accountId).mcpPort,3300);assert.equal(fs.readFileSync(path.join(f.root,"config.json"),"utf8"),previous);
});
test("configured port collision and physically occupied ports refuse without changing source or target",async t=>{
  const f=fixture(t);f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS,apiKeyEnc:f.config.encryptKey("other")}));
  await assert.rejects(f.complete(f.inspect()),/端口.*重复/);assert.equal(f.manager.list().accounts.length,1);
  f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS}));f.manager.portFree=async()=>false;
  await assert.rejects(f.complete(f.inspect()),/端口.*占用/);assert.equal(f.manager.readConfig("default").apiKeyEnc,"");
});
test("source edit and consumed token fail closed",async t=>{
  const f=fixture(t),p=f.inspect();fs.appendFileSync(f.sourceFile," ");await assert.rejects(f.complete(p),/发生变化/);assert.throws(()=>f.complete(p),/失效/);assert.equal(f.manager.readConfig("default").apiKeyEnc,"");
});
test("account switch or target configuration change invalidates reviewed import",async t=>{
  const f=fixture(t),p=f.inspect();await f.manager.create({name:"another"});const other=f.manager.list().accounts[1].id;await f.manager.select(other);await assert.rejects(f.complete(p),/当前账户或配置/);
  const next=f.inspect();f.manager.run(other,()=>f.config.save({...f.manager.readConfig(other),minimizeToTray:false}));await assert.rejects(f.complete(next),/当前账户或配置/);
});
test("unreadable key fails without claiming user change, never blank-success",async t=>{
  const f=fixture(t);fs.writeFileSync(f.sourceFile,JSON.stringify({...f.cfg,apiKeyEnc:"unreadable"}));await assert.rejects(f.complete(f.inspect()),/旧版密钥解密失败/);assert.equal(f.manager.readConfig("default").apiKeyEnc,"");
});
test("source junction ancestry and source config links are refused without target access",t=>{
  const f=fixture(t),link=path.join(f.temp,"linked");fs.symlinkSync(f.source,link,process.platform==="win32"?"junction":"dir");assert.throws(()=>f.importer.inspect(link),/junction/);fs.unlinkSync(link);
  fs.renameSync(f.sourceFile,path.join(f.source,"real.json"));fs.symlinkSync(f.workspace,f.sourceFile,process.platform==="win32"?"junction":"dir");assert.throws(()=>f.inspect(),/junction/);
});
test("registry publication failure restores adoption bytes and leaves registry unchanged",async t=>{
  const f=fixture(t);f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS}));const file=path.join(f.root,"config.json"),old=fs.readFileSync(file,"utf8");const rename=fs.renameSync;t.after(()=>{fs.renameSync=rename;});fs.renameSync=function(src,dst){if(path.resolve(dst)===path.join(f.root,"accounts.json"))throw Error("injected registry failure");return rename.apply(this,arguments);};
  await assert.rejects(f.complete(f.inspect()),/injected registry/);assert.equal(fs.readFileSync(file,"utf8"),old);assert.equal(fs.existsSync(path.join(f.root,"accounts.json")),false);assert.equal(f.manager.removingIds.size,0);
});
test("portable bounded known path finds registry profiles and exposes blank entries without importing them",async t=>{
  const f=fixture(t),profile=path.join(f.temp,"portable","Web Harness 3.0.data","appdata","chatgpt-web-harness-isolated"),id="a".repeat(32);fs.mkdirSync(path.join(profile,"accounts",id),{recursive:true});fs.copyFileSync(f.sourceFile,path.join(profile,"accounts",id,"config.json"));fs.writeFileSync(path.join(profile,"config.json"),JSON.stringify(f.config.DEFAULTS));fs.writeFileSync(path.join(profile,"accounts.json"),JSON.stringify({version:1,accounts:[{id:"default",name:"blank"},{id,name:"old"}]}));
  const p=f.importer.inspect(path.join(f.temp,"portable"));assert.equal(p.accounts.length,2);assert.equal(p.accounts[0].hasApiKey,false);assert.match(p.accounts[0].warning,/不完整/);const result=await f.importer.complete({token:p.token,sourceId:id});assert.equal(f.manager.readConfig(result.accountId).setupDone,true);
});

test("actual portable .data, appdata and direct profile selections all locate the same profile",async t=>{
  const f=fixture(t),data=path.join(f.temp,"Old Harness.exe.data"),profile=path.join(data,"appdata","chatgpt-web-harness-isolated");
  fs.mkdirSync(profile,{recursive:true});fs.copyFileSync(f.sourceFile,path.join(profile,"config.json"));
  fs.mkdirSync(path.join(profile,"runtime"));fs.writeFileSync(path.join(profile,"runtime","checkpoint.json"),"private runtime");
  for(const folder of [data,path.join(data,"appdata"),profile]) assert.equal(f.importer.inspect(folder).sourceFolder,profile);
  const result=await f.complete(f.importer.inspect(data));
  assert.equal(result.accountId,"default");assert.equal(fs.existsSync(path.join(f.root,"runtime","checkpoint.json")),false);
  assert.equal(fs.readFileSync(path.join(profile,"runtime","checkpoint.json"),"utf8"),"private runtime");
});

test("portable ambiguity refuses selection and linked portable ancestry is refused",t=>{
  const f=fixture(t),portable=path.join(f.temp,"portable");fs.mkdirSync(portable);
  for(const stem of ["first","second"]){const profile=path.join(portable,`${stem}.data`,"appdata","chatgpt-web-harness-isolated");fs.mkdirSync(profile,{recursive:true});fs.copyFileSync(f.sourceFile,path.join(profile,"config.json"));}
  assert.throws(()=>f.importer.inspect(portable),/多个/);
  fs.symlinkSync(f.source,path.join(portable,"linked.data"),process.platform==="win32"?"junction":"dir");
  assert.throws(()=>f.importer.inspect(portable),/junction/);
});

test("source edit during asynchronous port checks aborts before target write",async t=>{
  const f=fixture(t),before=fs.existsSync(path.join(f.root,"config.json"));let changed=false;
  f.manager.portFree=async()=>{if(!changed){changed=true;fs.appendFileSync(f.sourceFile," ");}return true;};
  await assert.rejects(f.complete(f.inspect()),/发生变化/);assert.equal(fs.existsSync(path.join(f.root,"config.json")),before);assert.equal(f.manager.list().accounts.length,1);
});

test("the actual import button path commits source Skills/MCP, disabled state, conversation labels and custom WAV together",async t=>{
 const f=fixture(t),p=seedProfile(f);
 fs.writeFileSync(f.sourceFile,JSON.stringify({...f.cfg,notificationSound:"custom",notificationVolume:40}));
 const result=await f.complete(f.inspect());
 assert.equal(result.accountId,"default");assert.equal(result.reused,false);
 assert.ok(result.profileFiles>=5,"profiles must be committed, not merely scanned");
 const cfg=f.manager.readConfig(result.accountId);
 assert.equal(cfg.notificationSound,"custom");assert.equal(cfg.notificationVolume,40);
 const target=path.join(f.root,"runtime","profiles");
 assert.equal(fs.readFileSync(path.join(target,"local-skills","fixture-migrate","SKILL.md"),"utf8"),p.content);
 assert.equal(JSON.parse(fs.readFileSync(path.join(target,"plugins.json"),"utf8")).skills[0].enabled,false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(target,"mcp-upstream.json"),"utf8")).servers[0].id,"offline-mcp");
 assert.equal(JSON.parse(fs.readFileSync(path.join(target,"conversation-index.json"),"utf8")).records[0].title,"迁移资料");
 assert.deepEqual(fs.readFileSync(path.join(f.root,"notification-sounds","custom.wav")),p.wav);
 for(const [file,bytes] of p.originals)assert.deepEqual(fs.readFileSync(file),bytes,"source profile unchanged");
});

test("a same Tunnel account completes missing profiles without replacing existing keys, ports, or account identity; repeating is idempotent",async t=>{
 const f=fixture(t),p=seedProfile(f),local={...f.cfg,mcpPort:5500,adminPort:5501,tunnelPort:5502,apiKeyEnc:f.config.encryptKey("my-existing-key"),notificationSound:"digital",notificationVolume:25};
 f.manager.run("default",()=>f.config.save(local));
 fs.writeFileSync(f.sourceFile,JSON.stringify({...f.cfg,apiKeyEnc:"unreadable",notificationSound:"custom"}));
 const before=fs.readFileSync(path.join(f.root,"config.json"));
 const first=await f.complete(f.inspect());
 assert.equal(first.reused,true);assert.equal(first.accountId,"default");assert.ok(first.profileFiles>=5);
 assert.deepEqual(fs.readFileSync(path.join(f.root,"config.json")),before);
 assert.equal(f.config.decryptKey(f.manager.readConfig("default")),"my-existing-key");
 assert.deepEqual(fs.readFileSync(path.join(f.root,"notification-sounds","custom.wav")),p.wav);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"runtime","profiles","plugins.json"),"utf8")).skills[0].enabled,false);
 const again=await f.complete(f.inspect());
 assert.equal(again.reused,true);assert.equal(again.profileFiles,0);
 assert.equal(f.manager.list().accounts.length,1);
 assert.deepEqual(fs.readFileSync(path.join(f.root,"config.json")),before);
});

test("same Tunnel with conflicting user Skill rejects entire profile transfer, leaving user key and source untouched",async t=>{
 const f=fixture(t),p=seedProfile(f);
 f.manager.run("default",()=>f.config.save({...f.cfg,apiKeyEnc:f.config.encryptKey("local-secret")}));
 const target=path.join(f.root,"runtime","profiles","local-skills","fixture-migrate","SKILL.md");
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,"custom user edit");
 const original=fs.readFileSync(path.join(f.root,"config.json"));
 await assert.rejects(f.complete(f.inspect()),/冲突/);
 assert.equal(fs.readFileSync(target,"utf8"),"custom user edit");
 assert.deepEqual(fs.readFileSync(path.join(f.root,"config.json")),original);
 assert.equal(fs.existsSync(path.join(f.root,"runtime","profiles","mcp-upstream.json")),false);
 for(const [file,bytes] of p.originals)assert.deepEqual(fs.readFileSync(file),bytes);
});

test("same Tunnel refuses to change live managed account when migration requires new files",async t=>{
 const f=fixture(t);seedProfile(f);
 f.manager.run("default",()=>f.config.save({...f.cfg,apiKeyEnc:f.config.encryptKey("existing")}));
 f.manager.instances.set("default",{refreshing:false,services:{busy:false,mcp:{isAlive:()=>true},tunnel:{isAlive:()=>false}}});
 await assert.rejects(f.complete(f.inspect()),/先停止账号/);
 assert.equal(fs.existsSync(path.join(f.root,"runtime","profiles","plugins.json")),false);
});

test("a failed registry publication rolls back source profiles, credential config and all newly copied attachments",async t=>{
 const f=fixture(t),p=seedProfile(f);
 const original=fs.readFileSync(f.sourceFile);
 f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS,minimizeToTray:false}));
 const old=fs.readFileSync(path.join(f.root,"config.json"));
 const rename=fs.renameSync;t.after(()=>{fs.renameSync=rename;});fs.renameSync=function(src,dst){if(path.resolve(dst)===path.join(f.root,"accounts.json"))throw Error("synthetic publication failure");return rename.apply(this,arguments);};
 await assert.rejects(f.complete(f.inspect()),/synthetic publication failure/);
 assert.deepEqual(fs.readFileSync(path.join(f.root,"config.json")),old);
 assert.equal(fs.existsSync(path.join(f.root,"runtime","profiles","plugins.json")),false);
 assert.equal(fs.existsSync(path.join(f.root,"notification-sounds","custom.wav")),false);
 assert.deepEqual(fs.readFileSync(f.sourceFile),original);
 for(const [file,bytes] of p.originals)assert.deepEqual(fs.readFileSync(file),bytes);
});

test("AccountManager initialization recovers a pending import transaction before reading account registry",t=>{
 const f=fixture(t),cfgFile=path.join(f.root,"config.json"),prior=fs.readFileSync(f.sourceFile);
 fs.writeFileSync(cfgFile,prior);
 const recovery=path.join(f.root,"account-recovery","import-txn-111-1234567890abcdef");
 fs.mkdirSync(recovery,{recursive:true});
 fs.writeFileSync(path.join(recovery,"0.bak"),prior);
 fs.writeFileSync(path.join(recovery,"journal.json"),JSON.stringify({version:2,root:path.resolve(f.root),files:[{rel:"config.json",existed:true,backup:"0.bak",sha256:require("../src/account-import-transaction").digest(prior),newSha256:require("../src/account-import-transaction").digest(Buffer.from("partial interruption"))}]}));
 fs.writeFileSync(cfgFile,"partial interruption");
 const restarted=new f.manager.constructor({app:f.manager.app,config:f.config,paths:f.paths,portFree:async()=>true}).init();
 assert.equal(restarted.readConfig("default").tunnelId,f.cfg.tunnelId);
 assert.deepEqual(fs.readFileSync(cfgFile),prior);
 assert.equal(fs.readFileSync(path.join(recovery,"rolled-back.flag"),"utf8"),"rolled-back\n");
});
test("same-Tunnel async credential preparation cannot overwrite edits after profile planning",async t=>{
 const f=fixture(t);seedProfile(f);
 f.manager.run("default",()=>f.config.save({...f.config.DEFAULTS,tunnelId:f.cfg.tunnelId,apiKeyEnc:"",setupDone:true}));
 const target=path.join(f.root,"runtime","profiles","plugins.json");fs.mkdirSync(path.dirname(target),{recursive:true});
 const baseline={schema_version:2,computer_use:{enabled:false},browser_use:{enabled:false},skills:[]};fs.writeFileSync(target,JSON.stringify(baseline));
 const transfer=require("../src/account-profile-transfer"),snap=transfer.scan(f.source),edited=JSON.stringify({...baseline,externalEdit:true});
 const targetConfig=JSON.stringify(f.manager.readConfig("default"));
 await assert.rejects(f.manager.importConfiguration({name:"fixture",tunnelId:f.cfg.tunnelId,targetId:"default",targetConfig,sourceFiles:[f.sourceFile],verify:()=>{},
  prepareProfile:async dir=>transfer.makePlan(snap,dir),prepare:async()=>{fs.writeFileSync(target,edited);return {...f.cfg,credentialFormat:require("../src/credential-format").CURRENT};}}),/预览后发生变化/);
 assert.equal(fs.readFileSync(target,"utf8"),edited);assert.equal(f.manager.readConfig("default").apiKeyEnc,"");
});
