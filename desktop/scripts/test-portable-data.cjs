'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {initializeIsolatedRuntime}=require('../src/isolated-runtime');
const {AccountManager}=require('../src/accounts');
const {profile}=require('../src/app-profile');
const {applyTaskbarIdentity,resolveTaskbarAppId}=require('../src/taskbar-identity');
const validationRoot=path.resolve(__dirname,'../../.validation');
fs.mkdirSync(validationRoot,{recursive:true});

function fixture(t){
 const root=fs.mkdtempSync(path.join(validationRoot,'portable-data-'));
 const originalAppData=path.join(root,'existing-appdata'),originalUserData=path.join(originalAppData,'chatgpt-web-harness-isolated');
 fs.mkdirSync(originalUserData,{recursive:true});
 const registry={version:1,revision:0,selectedId:'default',accounts:['default','a'.repeat(32),'b'.repeat(32),'c'.repeat(32)].map((id,i)=>({id,name:'Fixture existing '+i,createdAt:null}))};
 const registryText=JSON.stringify(registry),configText=JSON.stringify({setupDone:true,autoStart:true,apiKeyEnc:'test-only-existing-ciphertext'});
 fs.writeFileSync(path.join(originalUserData,'accounts.json'),registryText);fs.writeFileSync(path.join(originalUserData,'config.json'),configText);
 const executable=path.join(root,'portable','WebHarness.exe');fs.mkdirSync(path.dirname(executable));fs.writeFileSync(executable,'test fixture executable placeholder');
 const paths={appData:originalAppData,userData:originalUserData};
 const appIds=[];
 const app={isPackaged:true,commandLine:{getSwitchValue:()=>''},getPath:name=>paths[name],setPath:(name,value)=>{paths[name]=value;},setAppUserModelId:id=>appIds.push(id)};
 const env={PORTABLE_EXECUTABLE_FILE:executable,PORTABLE_EXECUTABLE_DIR:path.dirname(executable)};
 const manager=()=>new AccountManager({app,config:{},paths:{},makeServices:()=>({}),makeFeeds:()=>({})}).init();
 t.after(()=>{assert.equal(path.dirname(path.resolve(root)),validationRoot);fs.rmSync(root,{recursive:true,force:true});});
 return {root,app,appIds,paths,env,executable,manager,originalUserData,registryText,configText};
}

test('portable startup shows a fresh account despite four existing Windows-profile accounts',t=>{
 const f=fixture(t);const selected=initializeIsolatedRuntime(f.app,{env:f.env});
 assert.deepEqual(f.appIds,[`${profile.appId}.portable`]);
 const runtimeId=resolveTaskbarAppId(profile.appId,{isPackaged:f.app.isPackaged,portableExecutable:f.env.PORTABLE_EXECUTABLE_FILE});
 let details;
 applyTaskbarIdentity({setAppDetails:value=>{details=value;}},{appId:runtimeId,platform:'win32',portableExecutable:f.env.PORTABLE_EXECUTABLE_FILE});
 assert.equal(details.appId,f.appIds[0],'early process and main-window Shell identity must agree');
 assert.equal(f.manager().registry.accounts.length,1,'Portable must not reuse the existing four-account registry');
  assert.equal(f.manager().registry.accounts[0].name,'默认账户');
 assert.equal(selected.userData,path.join(path.dirname(f.executable),'WebHarness.data','appdata','chatgpt-web-harness-isolated'));
 assert.equal(f.paths.sessionData,selected.userData);
 assert.equal(fs.existsSync(path.join(selected.userData,'config.json')),false,'No existing autoStart/key configuration may be copied');
 assert.equal(fs.readFileSync(path.join(f.originalUserData,'accounts.json'),'utf8'),f.registryText);
 assert.equal(fs.readFileSync(path.join(f.originalUserData,'config.json'),'utf8'),f.configText);
});

test('installed startup keeps its existing accounts when there is no portable launcher',t=>{
 const f=fixture(t);initializeIsolatedRuntime(f.app,{env:{}});
 assert.deepEqual(f.appIds,[profile.appId]);
 assert.equal(f.manager().registry.accounts.length,4);assert.equal(f.paths.userData,f.originalUserData);
});

test('a broken portable launcher fails instead of falling back to existing Windows accounts',t=>{
 const f=fixture(t);f.env.PORTABLE_EXECUTABLE_DIR=path.join(f.root,'other');
 assert.throws(()=>initializeIsolatedRuntime(f.app,{env:f.env}),/便携/);
 assert.equal(f.paths.userData,f.originalUserData);
 assert.equal(fs.existsSync(path.join(path.dirname(f.executable),'WebHarness.data')),false);
});

test('same-path binary upgrade keeps data, while rename and side-by-side copy stay isolated',t=>{
 const f=fixture(t);
 const before=initializeIsolatedRuntime(f.app,{env:f.env});
 const marker=path.join(before.userData,'upgrade-marker.json');
 fs.writeFileSync(marker,JSON.stringify({schema:31,value:'preserve'}));
 fs.writeFileSync(f.executable,'new executable bytes at the same stable filename');
 const after=initializeIsolatedRuntime(f.app,{env:f.env});
 assert.equal(after.userData,before.userData);
 assert.equal(JSON.parse(fs.readFileSync(marker)).value,'preserve');
 const renamed=path.join(path.dirname(f.executable),'WebHarness-3.1.exe');
 fs.copyFileSync(f.executable,renamed);
 const separate=initializeIsolatedRuntime(f.app,{env:{PORTABLE_EXECUTABLE_FILE:renamed,PORTABLE_EXECUTABLE_DIR:path.dirname(renamed)}});
 assert.notEqual(separate.userData,before.userData);
 assert.equal(fs.existsSync(path.join(separate.userData,'upgrade-marker.json')),false,'renamed candidate never guesses a source profile to merge');
 const copyDir=path.join(f.root,'second-instance');fs.mkdirSync(copyDir);
 const copied=path.join(copyDir,path.basename(f.executable));fs.copyFileSync(f.executable,copied);
 const parallel=initializeIsolatedRuntime(f.app,{env:{PORTABLE_EXECUTABLE_FILE:copied,PORTABLE_EXECUTABLE_DIR:copyDir}});
 assert.notEqual(parallel.userData,before.userData);
 assert.equal(fs.existsSync(path.join(parallel.userData,'upgrade-marker.json')),false);
 // A binary rollback is not a data rollback; this test deliberately retains schema 31.
 fs.writeFileSync(f.executable,'old executable bytes restored');
 initializeIsolatedRuntime(f.app,{env:f.env});
 assert.equal(JSON.parse(fs.readFileSync(marker)).schema,31);
 assert.equal(fs.readFileSync(path.join(f.originalUserData,'config.json'),'utf8'),f.configText);
});
