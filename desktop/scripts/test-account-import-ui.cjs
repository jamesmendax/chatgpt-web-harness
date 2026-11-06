"use strict";
// Production main + preload + Aura; only native picker/window/tray are replaced.
const assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path'),net=require('node:net'),Module=require('node:module');
const {EventEmitter}=require('node:events'),electron=require('electron'),{app}=electron;
const desktop=path.resolve(__dirname,'..'), artifacts=require('./lib/test-isolation.cjs').artifactRoot('account-import-ui');fs.mkdirSync(artifacts,{recursive:true});
const fixture=fs.mkdtempSync(path.join(artifacts,'run-')),workspace=path.join(fixture,'workspace'),oldData=path.join(fixture,'Old Harness.exe.data'),oldProfile=path.join(oldData,'appdata','chatgpt-web-harness-isolated');
fs.mkdirSync(workspace);fs.writeFileSync(path.join(workspace,'keep.txt'),'untouched workspace');fs.mkdirSync(oldProfile,{recursive:true});
app.setPath('appData',fixture);app.setPath('userData',path.join(fixture,'isolated'));app.getVersion=()=>require('../package.json').version;app.commandLine.appendSwitch('force-device-scale-factor','1');
let win,resolveWindow,pickerCancelled=false,pickerCalls=0;const ready=new Promise(r=>resolveWindow=r),errors=[],checks=[],screenshots=[];
class Window extends electron.BrowserWindow {constructor(options){super({...options,show:false,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});this.webContents.once('did-finish-load',()=>resolveWindow(this));this.webContents.on('console-message',(_e,level,message)=>{if(level>=3)errors.push(message);});}}
class Tray extends EventEmitter {setToolTip(){}setContextMenu(){}destroy(){}}
const load=Module._load;Module._load=function(request,parent,isMain){if(request==='electron'&&parent?.filename.startsWith(desktop))return {...electron,BrowserWindow:Window,Tray,dialog:{...electron.dialog,showOpenDialog:async()=>{pickerCalls++;return {canceled:pickerCancelled,filePaths:pickerCancelled?[]:[oldData]};},showErrorBox:(title,message)=>errors.push(`${title}: ${message}`)}};return load.call(this,request,parent,isMain);};
require('../src/main');
const pause=ms=>new Promise(r=>setTimeout(r,ms)),js=s=>win.webContents.executeJavaScript(s),click=s=>js(`document.querySelector(${JSON.stringify(s)}).click()`),state=()=>js('window.__harness.core.snapshot()');
async function wait(s,label,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await js(s))return;await pause(80);}throw Error(`Timeout: ${label}`);}
function pass(s){checks.push(s);console.log(`PASS ${s}`);}
async function ports(){const servers=[];try{for(let i=0;i<3;i++){const s=net.createServer();servers.push(s);await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});}return servers.map(s=>s.address().port);}finally{await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));}}
async function openImport(){await click('#account-btn');await click('#btn-account-import');await wait("document.querySelector('#dlg-account-import').open",'import review');}
async function assertTypography() {
  const fonts = await js("({heading:getComputedStyle(document.querySelector('#import-title')).fontFamily,trigger:getComputedStyle(document.querySelector('#import-choice-trigger')).fontFamily,visible:document.querySelector('#import-choice-trigger').checkVisibility(),nativeHidden:document.querySelector('#import-choice').hidden})");
  assert.equal(fonts.trigger, fonts.heading, 'the visible account choice must retain the existing Aura display face');
  assert.equal(fonts.visible, true, 'the themed choice is the visible account control');
  assert.equal(fonts.nativeHidden, true, 'the native select only stores the value');
}
async function pressKey(key) {
  // Trusted Chromium input exercises native dialog dismissal; dispatchEvent would not.
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  const codes={ArrowDown:40,ArrowUp:38,Home:36,End:35,Enter:13,Escape:27,Tab:9};
  const event={key,code:key,windowsVirtualKeyCode:codes[key]};
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...event});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...event});
  await pause(40);
}
async function assertAccountChoice(secondaryId) {
  win.setSize(900,600);
  await js("window.__harness.applyTheme('dark')");
  await pause(650);
  assert.equal(await js("document.querySelector('#import-details').open"),false,'migration detail starts collapsed');
  assert.equal(await js("document.querySelector('#import-summary').checkVisibility()"),false,'technical summary is initially out of the visual flow');
  await js("document.querySelector('#import-choice-trigger').focus()");
  await pressKey('ArrowDown');
  await wait("document.querySelector('#import-choice-list')?.matches(':popover-open')",'themed account choices open');
  const menu=await js("(()=>{const m=document.querySelector('#import-choice-list'),d=document.querySelector('#dlg-account-import'),r=m.getBoundingClientRect(),s=getComputedStyle(m);return {background:s.backgroundColor,dialogBackground:getComputedStyle(d).backgroundColor,color:s.color,dialogColor:getComputedStyle(d).color,font:s.fontFamily,bodyFont:getComputedStyle(document.body).fontFamily,inBounds:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:m.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)),focus:document.activeElement.id,options:m.querySelectorAll('[role=option]').length};})()");
  assert.equal(menu.background,menu.dialogBackground,'dark list uses the same opaque Aura surface as the dialog');
  assert.notEqual(menu.background,'rgb(255, 255, 255)','dark list must not become a native white popup');
  assert.equal(menu.color,menu.dialogColor);
  assert.equal(menu.font,menu.bodyFont,'option text retains the Aura text font');
  assert.equal(menu.inBounds,true,'choice menu remains inside the viewport');
  assert.equal(menu.hit,true,'choice menu is reachable above the dialog/backdrop');
  assert.equal(menu.focus,'import-choice-trigger','keyboard focus stays on the combobox');
  assert.equal(menu.options,2,'both source accounts are available through the actual importer');
  const file=path.join(fixture,'account-choice-dark-900x600.png');
  fs.writeFileSync(file,(await win.capturePage()).toPNG());screenshots.push(file);
  await pressKey('Escape');
  assert.equal(await js("!!document.querySelector('#import-choice-list:popover-open')"),false,'Escape closes the list');
  assert.equal(await js("document.querySelector('#dlg-account-import').open"),true,'Escape must not also dismiss the import dialog');
  assert.equal(await js("document.activeElement.id"),'import-choice-trigger','Escape keeps focus on the choice');
  await pressKey('End');
  await pressKey('Enter');
  assert.equal(await js("document.querySelector('#import-choice').value"),secondaryId,'End and Enter choose the second source account');
  assert.equal(await js("document.querySelector('#import-choice-trigger .choice-value').textContent"),'第二个旧账户');
  assert.match(await js("document.querySelector('#import-summary').textContent"),/尚未完成/,'keyboard selection refreshes the migration review');
  assert.equal(await js("document.querySelector('#dlg-account-import').open"),true,'Enter on the choice must not submit the dialog form');
  await pressKey('Home');
  await pressKey('Enter');
  assert.equal(await js("document.querySelector('#import-choice').value"),'default','Home restores the source used by the real migration assertions');
  await pressKey('ArrowDown');
  await pressKey('Tab');
  assert.equal(await js("!!document.querySelector('#import-choice-list:popover-open')"),false,'Tab closes the list');
  assert.equal(await js("document.querySelector('#dlg-account-import').open"),true,'Tab keeps the review open');
  assert.notEqual(await js("document.activeElement.id"),'import-choice-trigger','Tab moves to the next dialog control');
  pass('real dark account choice supports bounded themed popup, Escape, Home/End selection and Tab without closing the review');
}
async function assertExpandedDetails() {
  const result=await js("(()=>{const details=document.querySelector('#import-details'),body=document.querySelector('#dlg-account-import .import-body'),summary=document.querySelector('#import-summary'),r=body.getBoundingClientRect();return {open:details.open,visible:summary.checkVisibility(),overflow:body.scrollWidth>body.clientWidth+1,escaped:[...summary.children].some(n=>{const x=n.getBoundingClientRect();return x.left<r.left-1||x.right>r.right+1;})};})()");
  assert.equal(result.open,true);assert.equal(result.visible,true);
  assert.equal(result.overflow,false,'expanded migration detail has no horizontal overflow');
  assert.equal(result.escaped,false,'all migration labels and values fit the scroll area');
  await js("document.querySelector('#import-scope').scrollIntoView({block:'end'})");
  const reachable=await js("(()=>{const a=document.querySelector('#import-scope').getBoundingClientRect(),b=document.querySelector('#dlg-account-import .import-body').getBoundingClientRect();return a.bottom<=b.bottom+1&&a.bottom>b.top;})()");
  assert.equal(reachable,true,'the complete migration scope is reachable by scrolling');
}
async function importWithBusyCheck() {
  const during=await js("(()=>{document.querySelector('#import-confirm').click();return {disabled:['#import-choice','#import-choice-trigger','#import-cancel','#import-confirm'].map(s=>document.querySelector(s).disabled),menuOpen:!!document.querySelector('#import-choice-list:popover-open'),dialogOpen:document.querySelector('#dlg-account-import').open};})()");
  assert.deepEqual(during.disabled,[true,true,true,true],'the real import freezes the account choice and both actions before awaiting IPC');
  assert.equal(during.menuOpen,false);assert.equal(during.dialogOpen,true);
}
async function layout(selector,buttons,theme,width,height,captureLabel=''){win.setSize(width,height);await js(`window.__harness.applyTheme(${JSON.stringify(theme)})`);await pause(650);const result=await js(`(()=>{const d=document.querySelector(${JSON.stringify(selector)});return {overflow:document.documentElement.scrollWidth>innerWidth||document.body.scrollWidth>innerWidth||d.scrollWidth>d.clientWidth+1,clipped:${JSON.stringify(buttons)}.filter(s=>{const r=document.querySelector(s).getBoundingClientRect();return r.width<1||r.left<0||r.right>innerWidth||r.top<0||r.bottom>innerHeight;})}})()`);assert.equal(result.overflow,false,`${selector} ${width} overflow`);assert.deepEqual(result.clipped,[],`${selector} ${width} clipped`);const file=path.join(fixture,`${selector.slice(1)}-${theme}-${width}x${height}${captureLabel ? '-' + captureLabel : ''}.png`);fs.writeFileSync(file,(await win.capturePage()).toPNG());screenshots.push(file);}
async function currentConfig(){const info=(await js('window.launcher.appInfo()')).result;return {file:info.configPath,bytes:fs.existsSync(info.configPath)?fs.readFileSync(info.configPath,'utf8'):null};}
let blankCount=0; async function blank(){const name=`另一个空白账户${++blankCount}`;await js(`window.__harness.core.act.createAccount(${JSON.stringify(name)})`);await wait(`window.__harness.core.snapshot().account.name === ${JSON.stringify(name)}`,'blank account');await js(`(()=>{const i=document.querySelector('#f-tunnelId');i.value=${JSON.stringify('tunnel_11111111111111111111111111111111')};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
const deadline=setTimeout(()=>{console.error('FAIL hard deadline');app.exit(1);},120000);
(async()=>{win=await ready;await wait("window.__harness?.core?.mode==='electron'&&!document.body.classList.contains('booting')",'production ready');win.setSize(1120,760);
assert.ok(electron.safeStorage.isEncryptionAvailable());const key='sk-disposable-import-ui-original',p=await ports(),sourceFile=path.join(oldProfile,'config.json');const source={...require('../src/config').DEFAULTS,tunnelId:'tunnel_11111111111111111111111111111111',workspacePath:workspace,mcpPort:p[0],adminPort:p[1],tunnelPort:p[2],setupDone:true,autoStart:true,apiKeyEnc:electron.safeStorage.encryptString(key).toString('base64')};fs.writeFileSync(sourceFile,JSON.stringify(source));const sourceBytes=fs.readFileSync(sourceFile,'utf8'),initial=await state(),before=await currentConfig();
const sourceProfiles=path.join(oldProfile,'runtime','profiles'),sourceSkill=path.join(sourceProfiles,'local-skills','test-migration');
fs.mkdirSync(sourceSkill,{recursive:true});
fs.writeFileSync(path.join(sourceSkill,'SKILL.md'),'---\nname: test-migration\ndescription: synthetic\n---\n');
fs.writeFileSync(path.join(sourceProfiles,'plugins.json'),JSON.stringify({schema_version:2,computer_use:{enabled:false},browser_use:{enabled:false},skills:[{id:'test-migration',source:'installed',enabled:false}]}));
fs.writeFileSync(path.join(sourceProfiles,'mcp-upstream.json'),JSON.stringify({version:1,servers:[{id:'fixture-service',command:'echo',args:['offline-only']}]}));
const secondaryId='a'.repeat(32),secondaryRoot=path.join(oldProfile,'accounts',secondaryId),secondaryFile=path.join(secondaryRoot,'config.json'),registryFile=path.join(oldProfile,'accounts.json');
fs.mkdirSync(secondaryRoot,{recursive:true});
const secondaryBytes=JSON.stringify({...require('../src/config').DEFAULTS,tunnelId:'tunnel_22222222222222222222222222222222',workspacePath:workspace,setupDone:false});
const registryBytes=JSON.stringify({version:1,accounts:[{id:'default',name:'原有测试账户'},{id:secondaryId,name:'第二个旧账户'}]});
fs.writeFileSync(secondaryFile,secondaryBytes);fs.writeFileSync(registryFile,registryBytes);
await openImport();const review=await js("document.querySelector('#import-summary').textContent");for(const port of p)assert.ok(review.includes(String(port)));assert.match(review,/已保存（加密）/);assert.match(review,/已安装 Skills/);assert.match(review,/MCP 服务/);
const scope=await js("document.querySelector('#import-scope').textContent");
assert.match(scope,/账户配置、Skills、MCP、会话标签和提示音/);assert.match(scope,/冲突时停止并保留备份/);
assert.doesNotMatch(review,/sk-disposable/);assert.equal(await js(`document.body.textContent.includes(${JSON.stringify(source.apiKeyEnc)})`),false);
await assertTypography();
await assertAccountChoice(secondaryId);
for(const [w,h] of [[1120,760],[900,600]])for(const theme of ['light','dark']){
  await js("document.querySelector('#import-details').open=false;document.querySelector('#dlg-account-import .import-body').scrollTop=0");
  await layout('#dlg-account-import',['#import-choice-trigger','#import-cancel','#import-confirm'],theme,w,h,'collapsed');
  await click('#import-details > summary');
  await layout('#dlg-account-import',['#import-choice-trigger','#import-cancel','#import-confirm'],theme,w,h,'expanded');
  await assertExpandedDetails();
}
pass('migration details stay collapsed by default and expand without clipping in light/dark at both desktop sizes');
await click('#import-cancel');assert.equal((await state()).selectedId,initial.selectedId);assert.deepEqual(await currentConfig(),before);assert.equal(fs.readFileSync(sourceFile,'utf8'),sourceBytes);pass('real native-picker review shows saved ports and encrypted-key status; cancellation preserves current/source bytes');
pickerCancelled=true;const previousCalls=pickerCalls;await click('#account-btn');await click('#btn-account-import');await pause(250);assert.equal(pickerCalls,previousCalls+1);assert.equal(await js("document.querySelector('#dlg-account-import').open"),false);pickerCancelled=false;
await openImport();await importWithBusyCheck();await wait("!document.querySelector('#dlg-account-import').open",'import complete');const imported=await state(),importedId=imported.selectedId,local=await currentConfig(),saved=JSON.parse(local.bytes);for(const field of ['mcpPort','adminPort','tunnelPort','setupDone','workspacePath','tunnelId'])assert.equal(saved[field],source[field]);assert.equal(saved.autoStart,false);assert.equal(electron.safeStorage.decryptString(Buffer.from(saved.apiKeyEnc,'base64')),key);assert.equal(imported.account.mcp.managed,false);assert.equal(imported.account.tunnel.managed,false);assert.equal(await js("document.querySelector('#f-mcpPort').value"),String(p[0]));assert.equal(await js("document.querySelector('#btn-run-setup').textContent"),'重新检查配置');
const importedRoot=path.dirname(local.file),localProfiles=path.join(importedRoot,'runtime','profiles');
assert.equal(fs.readFileSync(path.join(localProfiles,'local-skills','test-migration','SKILL.md'),'utf8'),fs.readFileSync(path.join(sourceSkill,'SKILL.md'),'utf8'),'Skill file copied by actual Electron importer');
assert.equal(JSON.parse(fs.readFileSync(path.join(localProfiles,'plugins.json'),'utf8')).skills[0].enabled,false,'disabled Skill state preserved');
assert.equal(JSON.parse(fs.readFileSync(path.join(localProfiles,'mcp-upstream.json'),'utf8')).servers[0].id,'fixture-service','MCP upstream transferred');
for(const [w,h] of [[1120,760],[900,600]])for(const theme of ['light','dark'])await layout('#view-settings',['#btn-run-setup'],theme,w,h);pass('actual DPAPI import preserves key/ports/setup completion and disables autostart; settings retain original port and recheck action');
await blank();await wait("!document.querySelector('#setup-reuse').hidden",'reuse guidance');assert.match(await js("document.querySelector('#setup-reuse').textContent"),new RegExp(String(p[0])));await click('#btn-setup-reuse');await wait(`window.__harness.core.snapshot().selectedId===${JSON.stringify(importedId)}`,'reuse switches original');
await blank();await click('#btn-run-setup');await wait("document.querySelector('#dlg-setup').open&&!document.querySelector('#setup-switch-account').hidden",'existing account setup interception');assert.equal(await js("document.querySelector('#setup-title').textContent"),'已有可用的账户配置');assert.equal((await state()).account.mcp.managed,false);assert.equal((await state()).account.tunnel.managed,false);await click('#setup-switch-account');await wait(`window.__harness.core.snapshot().selectedId===${JSON.stringify(importedId)}`,'setup switch original');pass('keyless duplicate Tunnel offers saved-account reuse and setup intercepts before services/key validation');
await blank();
const extraSkill=path.join(sourceProfiles,'local-skills','second-migration-skill');
fs.mkdirSync(extraSkill,{recursive:true});
fs.writeFileSync(path.join(extraSkill,'SKILL.md'),'---\nname: second-migration-skill\ndescription: offline second fixture\n---\n');
const sourcePlugins=path.join(sourceProfiles,'plugins.json');
const extended=JSON.parse(fs.readFileSync(sourcePlugins,'utf8'));
extended.skills.push({id:'second-migration-skill',source:'installed',enabled:true});
fs.writeFileSync(sourcePlugins,JSON.stringify(extended));
const count=(await state()).accounts.length;
await openImport();assert.equal(await js("document.querySelector('#import-confirm').textContent"),'补全已有账户');
await click('#import-confirm');await wait(`!document.querySelector('#dlg-account-import').open&&window.__harness.core.snapshot().selectedId===${JSON.stringify(importedId)}`,'same Tunnel profile complement');
assert.equal((await state()).accounts.length,count);
assert.deepEqual(await currentConfig(),local);
assert.equal(fs.readFileSync(path.join(localProfiles,'local-skills','second-migration-skill','SKILL.md'),'utf8'),fs.readFileSync(path.join(extraSkill,'SKILL.md'),'utf8'));
assert.equal(JSON.parse(fs.readFileSync(path.join(localProfiles,'plugins.json'),'utf8')).skills.length,2);
assert.equal(fs.readFileSync(sourceFile,'utf8'),sourceBytes);
assert.equal(fs.readFileSync(path.join(workspace,'keep.txt'),'utf8'),'untouched workspace');
assert.equal(fs.readFileSync(secondaryFile,'utf8'),secondaryBytes,'the unselected source account stays byte-identical');
assert.equal(fs.readFileSync(registryFile,'utf8'),registryBytes,'the source account registry stays byte-identical');
assert.equal((await state()).account.mcp.managed,false);assert.equal((await state()).account.tunnel.managed,false);
assert.deepEqual(errors,[]);
pass('same Tunnel reimport merges a new Skill into existing identity with original key, ports, MCP and source preserved');
fs.writeFileSync(path.join(fixture,'result.json'),JSON.stringify({ok:true,checks,screenshots,pickerCalls,fixture,safeStorage:'actual Electron safeStorage encrypt/decrypt',importedId},null,2));console.log(`RESULT ${fixture}`);clearTimeout(deadline);app.quit();setTimeout(()=>app.exit(0),1200);
})().catch(async error=>{console.error(error.stack);fs.writeFileSync(path.join(fixture,'failure.json'),JSON.stringify({error:error.stack,checks,errors,screenshots,dom:win?await js('document.body.innerText').catch(()=>''):''},null,2));clearTimeout(deadline);app.exit(1);});




