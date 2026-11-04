// Real packaged Windows acceptance. Never point this at a production installation.
// The isolated product's default data root MUST be absent. Existing data is never adopted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

if(process.platform!=='win32') throw new Error('This acceptance requires Windows');
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(desktop,'..');
const version=JSON.parse(fs.readFileSync(path.join(desktop,'package.json'),'utf8')).version;
const product='ChatGPT Web Harness Isolated';
const release=path.resolve(process.env.ACCEPTANCE_RELEASE_DIR || path.join(desktop,'release'));
const base=path.resolve(process.env.ACCEPTANCE_OUTPUT_DIR || path.join(root,'.codex','packaged-acceptance'));
fs.mkdirSync(base,{recursive:true});
const out=fs.mkdtempSync(path.join(base,'run-'));
const shotDir=path.join(out,'screenshots');fs.mkdirSync(shotDir);
const owner=crypto.randomUUID();
const ps=path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report={version,out,startedAt:new Date().toISOString(),steps:[],screenshots:[],artifacts:[],cloudAccountsVerified:false,passed:false};
const save=()=>fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));
function pass(name,detail={}){report.steps.push({name,passed:true,...detail});save();console.log('PASS '+name);}
function psRead(script){const r=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "+script],{encoding:'utf8',windowsHide:true,timeout:20000});if(r.status!==0)throw new Error('Read-only Windows inspection failed: '+r.stderr);return r.stdout.trim();}
function psJson(script){const t=psRead(script+' | ConvertTo-Json -Depth 7 -Compress');return t?JSON.parse(t):null;}
const asArray=value=>Array.isArray(value)?value:(value?[value]:[]);
function registry(){return asArray(psJson(`@(@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall') | ForEach-Object { $base=$_; Get-ChildItem -LiteralPath $base -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty -LiteralPath $_.PSPath; if($p.DisplayName -like 'ChatGPT Web Harness*'){[pscustomobject]@{key=$base+'\\'+$_.PSChildName;name=$p.DisplayName;location=$p.InstallLocation;uninstall=$p.UninstallString;icon=$p.DisplayIcon;version=$p.DisplayVersion}} } } | Sort-Object key)`));}
const isIsolatedRegistration=row=>row.name===product||row.name.startsWith(product+' ');
function isolatedProcesses(){return asArray(psJson(`@(Get-CimInstance Win32_Process -Filter ${quote("Name = '"+product+".exe'")} | Select-Object ProcessId,ParentProcessId,ExecutablePath)`));}
const appData=psRead("[Environment]::GetFolderPath('ApplicationData')");
const userData=path.join(appData,'chatgpt-web-harness-isolated');
const marker=path.join(userData,'.packaged-acceptance-owner');
const alias=path.join(appData,product);
const installed=path.join(out,'installed');
const installedExe=path.join(installed,product+'.exe');
const shortcuts=[path.join(psRead("[Environment]::GetFolderPath('Desktop')"),product+'.lnk'),path.join(appData,'Microsoft','Windows','Start Menu','Programs',product+'.lnk')];
const env={};
for(const [key,value]of Object.entries(process.env)) if(/^(SystemRoot|windir|ComSpec|PATHEXT|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|ALLUSERSPROFILE|PROGRAMDATA)$/i.test(key))env[key]=value;
env.PATH=path.join(process.env.SystemRoot||'C:\\Windows','System32')+';'+(process.env.SystemRoot||'C:\\Windows')+';'+path.dirname(ps);
const protectedPid=Number(process.env.ACCEPTANCE_PROTECTED_PID||0);
const protectedBefore=protectedPid?psRead(`$p=Get-Process -Id ${protectedPid}; $p.Path+'|'+$p.StartTime.ToUniversalTime().ToString('o')`):null;
const configPaths=['chatgpt-web-harness','ChatGPT Web Harness','chatgpt-local-coder-desktop'].map(n=>path.join(appData,n,'config.json'));
const protectedConfigs=configPaths.map(p=>({path:p,exists:fs.existsSync(p),sha256:fs.existsSync(p)?hash(p):null}));
function assertProtected(){
 if(protectedPid)assert.equal(psRead(`$p=Get-Process -Id ${protectedPid}; $p.Path+'|'+$p.StartTime.ToUniversalTime().ToString('o')`),protectedBefore,'Protected live process changed');
 for(const item of protectedConfigs){assert.equal(fs.existsSync(item.path),item.exists,'Original config existence changed');if(item.exists)assert.equal(hash(item.path),item.sha256,'Original config bytes changed');}
}
async function freePorts(count){const servers=await Promise.all(Array.from({length:count},()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>resolve(s));})));const ports=servers.map(s=>s.address().port);await Promise.all(servers.map(s=>new Promise(r=>s.close(r))));return ports;}
async function waitFor(fn,label,ms=30000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e;}await sleep(400);}throw new Error('Timed out: '+label+(last?' ('+last.message+')':''));}
async function runExe(exe,args,timeout=180000){const child=spawn(exe,args,{cwd:out,env,windowsHide:true,stdio:'ignore'});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned executable timeout: '+path.basename(exe)+' PID '+child.pid)),timeout);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',(code,signal)=>{clearTimeout(timer);code===0?resolve({pid:child.pid,code}):reject(new Error(path.basename(exe)+' exit='+code+' signal='+signal));});});}
let active=null,ownsData=false,installedByTest=false;
async function launch(exe,label){
 assert.equal(isolatedProcesses().length,0,'An isolated instance already exists; do not take it over');
 const [port]=await freePorts(1);
 const stdout=fs.openSync(path.join(out,label+'-stdout.log'),'a');
 const stderr=fs.openSync(path.join(out,label+'-stderr.log'),'a');
 const child=spawn(exe,[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1'],{cwd:out,env,windowsHide:false,stdio:['ignore',stdout,stderr]});
 fs.closeSync(stdout);fs.closeSync(stderr);
 const session={child,browser:null,page:null,label,exe};active=session;
 child.once('error',e=>{session.spawnError=e});
 await waitFor(async()=>{if(session.spawnError)throw session.spawnError;if(child.exitCode!==null)throw new Error('Launcher exited '+child.exitCode);const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1200)});return r.ok;},label+' remote debugging',60000);
 session.browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
 session.page=await waitFor(()=>session.browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('index.html')),label+' renderer');
 await session.page.waitForFunction(()=>Boolean(window.launcher)&&typeof state!=='undefined'&&state.accountId,null,{timeout:30000});
 session.pageErrors=[];session.page.on('pageerror',e=>session.pageErrors.push(String(e)));
 return session;
}
async function call(session,method,payload={}){const r=await session.page.evaluate(async({method,payload})=>window.launcher[method](payload),{method,payload});assert.equal(r?.ok,true,method+': '+r?.error);return r.result;}
async function closeActive(){
 if(!active)return;
 const s=active;
 if(s.page&&!s.page.isClosed()){
  const accounts=await call(s,'listAccounts');
  for(const row of accounts.accounts)await call(s,'stopAll',{_accountId:row.id});
  for(const row of accounts.accounts)await call(s,'saveConfig',{_accountId:row.id,minimizeToTray:false,autoStart:false});
  await s.page.evaluate(()=>window.close()).catch(()=>{});
 }
 await waitFor(()=>isolatedProcesses().length===0,'all owned isolated processes exit',30000);
 if(s.browser)await s.browser.close().catch(()=>{});
 active=null;
}
async function view(s,name){await s.page.locator(`[data-view="${name}"]`).click();await s.page.waitForFunction(n=>document.getElementById('view-'+n).classList.contains('active'),name);}
async function resizeOwnedWindow(s,width,height){
 const script=`$ErrorActionPreference='Stop'; $p=@(Get-Process -Name ${quote(product)} | Where-Object {$_.MainWindowHandle -ne 0}); if($p.Count -ne 1){throw 'Expected exactly one owned candidate window'}; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CandidateWindow { [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int z, uint flags); }'; if(-not [CandidateWindow]::SetWindowPos($p[0].MainWindowHandle,[IntPtr]::Zero,0,0,${width},${height},22)){throw 'Candidate window resize failed'}`;
 const result=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000});
 assert.equal(result.status,0,result.stderr);await sleep(450);
 const bounds=await s.page.evaluate(()=>({width:outerWidth,height:outerHeight,innerWidth,innerHeight}));
 assert.ok(Math.abs(bounds.width-width)<=20,'Unexpected native window width '+JSON.stringify(bounds));
 return bounds;
}
async function screenshot(s,name){await s.page.waitForFunction(()=>document.getElementById('toasts').children.length===0,null,{timeout:15000});await s.page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const file=path.join(shotDir,name+'.png');await s.page.screenshot({path:file});report.screenshots.push({name,path:file,sha256:hash(file)});save();}
async function select(s,id){await s.page.locator('#account-select').selectOption(id);await s.page.waitForFunction(id=>state.accountId===id&&!state.accountSwitching&&document.getElementById('account-select').value===id,id);}
async function health(port){const r=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return r.json();}
async function mcp(port){let sessionId=null,id=1;const send=async(method,params,notify=false)=>{const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};if(sessionId)headers['mcp-session-id']=sessionId;const body={jsonrpc:'2.0',method,params};if(!notify)body.id=id++;const r=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});sessionId=r.headers.get('mcp-session-id')||sessionId;assert.ok(r.ok,'MCP HTTP '+r.status);const text=await r.text();if(notify)return null;const json=text.trim().startsWith('{')?JSON.parse(text):JSON.parse(text.split(/\r?\n/).filter(l=>l.startsWith('data:')).at(-1).slice(5));assert.ok(!json.error,JSON.stringify(json.error));return json.result;};await send('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'packaged-acceptance',version:'1.0.0'}});await send('notifications/initialized',{},true);return{send};}

const registryBefore=registry();
try{
 for(const p of [userData,alias])assert.ok(!fs.existsSync(p),'Existing isolated data is protected; use a clean Windows user for acceptance: '+p);
 assert.equal(isolatedProcesses().length,0,'Existing isolated process must not be changed');
 assert.ok(!registryBefore.some(isIsolatedRegistration),'Existing isolated installation must not be changed');
 for(const p of shortcuts)assert.ok(!fs.existsSync(p),'Existing isolated shortcut must not be changed');
 assertProtected();
 const portable=path.join(release,`${product}-${version}-portable.exe`),setup=path.join(release,`${product}-${version}-setup.exe`);
 for(const file of [portable,setup]){const size=fs.statSync(file).size;assert.ok(size>10000000);assert.equal(fs.readFileSync(file).subarray(0,2).toString(),'MZ');report.artifacts.push({path:file,bytes:size,sha256:hash(file)});}
 pass('Candidate installer and Portable exist, have PE signatures and are version-addressed');
 fs.mkdirSync(userData);fs.writeFileSync(marker,owner,{flag:'wx'});ownsData=true;
 const first=await launch(portable,'portable-first');
 const info=await call(first,'appInfo'),initial=await call(first,'getConfig'),list=await call(first,'listAccounts');
 assert.equal(info.isPackaged,true);assert.equal(info.isolated,true);assert.equal(info.multiAccount,true);assert.equal(info.version,version);
 assert.equal(path.resolve(info.configPath),path.join(userData,'config.json'));assert.equal(initial.setupDone,false);assert.equal(initial.hasApiKey,false);assert.equal(initial.autoStart,false);
 assert.equal(list.accounts.length,1);assert.equal(list.accounts[0].mcp.owned,false);assert.equal(list.accounts[0].tunnel.owned,false);
 assert.ok(!path.resolve(info.codeRoot).startsWith(path.resolve(root)+path.sep),'Packaged runtime must not load from checkout');
 for(const rel of ['dist/index.js','bin/tunnel-client.exe','harness-files.json','node_modules/mcp-sdk/package.json','node_modules/pw/package.json','LICENSE','third-party/tunnel-client/LICENSE','third-party/tunnel-client/NOTICE','third-party/tunnel-client/PROVENANCE.json'])assert.ok(fs.existsSync(path.join(info.codeRoot,rel)),rel+' absent in packaged runtime');
 const catalog=await call(first,'getSkillCatalog');assert.equal(catalog.installed.length,0);assert.equal(catalog.external.length,0);assert.equal(catalog.builtin.length,0);
 pass('Portable fresh run uses bundled runtime, no inherited config/key/Skills or auto-start',{electron:info.electron,node:info.node});
 await view(first,'settings');await screenshot(first,'01-first-run-settings');await view(first,'dashboard');await screenshot(first,'02-first-run-dashboard');
 const ports=await freePorts(6),a={mcpPort:ports[0],adminPort:ports[1],tunnelPort:ports[2]},b={mcpPort:ports[3],adminPort:ports[4],tunnelPort:ports[5]};
 const aWork=path.join(out,'workspace-A'),bWork=path.join(out,'workspace-B');
 const aTunnel='tunnel_'+crypto.randomBytes(16).toString('hex'),bTunnel='tunnel_'+crypto.randomBytes(16).toString('hex');
 let setupResult=await call(first,'runSetup',{...a,workspacePath:aWork,tunnelId:aTunnel,apiKey:'local-acceptance-fixture-A-not-a-cloud-key',skipDoctor:true,autoStart:false,minimizeToTray:false});assert.equal(setupResult.ok,true);
 await first.page.locator('#btn-account-create').click();await first.page.locator('#account-dialog').waitFor({state:'visible'});await screenshot(first,'03-new-account-dialog');
 await first.page.locator('#account-dialog-name').fill('验收账号 B');await first.page.evaluate(()=>document.getElementById('account-dialog-form').requestSubmit());
 await first.page.waitForFunction(()=>state.accountId!=='default');
 const bId=await first.page.evaluate(()=>state.accountId);assert.match(bId,/^[a-f0-9]{32}$/);
 const freshB=await call(first,'getConfig',{_accountId:bId});assert.equal(freshB.hasApiKey,false);assert.equal(freshB.setupDone,false);assert.equal(freshB.autoStart,false);
 await first.page.locator('#btn-account-rename').click();await first.page.locator('#account-dialog-name').fill('独立账号 B');await first.page.evaluate(()=>document.getElementById('account-dialog-form').requestSubmit());await first.page.waitForFunction(()=>document.getElementById('dashboard-account-name').textContent==='独立账号 B');
 setupResult=await call(first,'runSetup',{_accountId:bId,...b,workspacePath:bWork,tunnelId:bTunnel,apiKey:'local-acceptance-fixture-B-not-a-cloud-key',skipDoctor:true,autoStart:false,minimizeToTray:false});assert.equal(setupResult.ok,true);
 await view(first,'settings');await screenshot(first,'04-account-B-settings');
 const conflicts=[{mcpPort:a.mcpPort},{tunnelId:aTunnel},{workspacePath:aWork}];
 for(const conflict of conflicts){const result=await first.page.evaluate(p=>window.launcher.saveConfig(p),{_accountId:bId,...conflict});assert.equal(result.ok,false,'Cross-account conflict was accepted');}
 const stableB=await call(first,'getConfig',{_accountId:bId});assert.equal(stableB.mcpPort,b.mcpPort);assert.equal(stableB.tunnelId,bTunnel);assert.equal(stableB.workspacePath,bWork);
 pass('Real GUI creates, renames and switches private accounts; invalid cross-account configuration is rejected');
 await call(first,'startMcp',{_accountId:'default'});await waitFor(()=>health(a.mcpPort),'account A health');
 await call(first,'startMcp',{_accountId:bId});await waitFor(()=>health(b.mcpPort),'account B health');
 const both=await call(first,'listAccounts');const ar=both.accounts.find(r=>r.id==='default'),br=both.accounts.find(r=>r.id===bId);
 assert.equal(ar.mcp.owned,true);assert.equal(br.mcp.owned,true);assert.ok(ar.mcp.pid>0&&br.mcp.pid>0);assert.notEqual(ar.mcp.pid,br.mcp.pid);assert.equal(ar.tunnel.owned,false);assert.equal(br.tunnel.owned,false);
 await select(first,'default');await health(b.mcpPort);await select(first,bId);await health(a.mcpPort);
 await view(first,'dashboard');await screenshot(first,'05-account-B-running');
 await call(first,'stopMcp',{_accountId:bId});await health(a.mcpPort);assert.equal((await call(first,'listAccounts')).accounts.find(r=>r.id===bId).mcp.owned,false);
 pass('Two real bundled MCP processes run concurrently; switching and stopping B preserve A',{pids:[ar.mcp.pid,br.mcp.pid],ports:[a.mcpPort,b.mcpPort]});
 const fixture=path.join(out,'skill-fixture');fs.mkdirSync(path.join(fixture,'references','a'),{recursive:true});fs.mkdirSync(path.join(fixture,'references','b'),{recursive:true});
 fs.writeFileSync(path.join(fixture,'SKILL.md'),'---\nname: packaged-acceptance\ndescription: A local acceptance fixture for account-isolated installation.\n---\n\n# Packaged acceptance\n\nRead references/a/shared.txt and references/b/shared.txt. PACKAGED_SKILL_MARKER\n');
 fs.writeFileSync(path.join(fixture,'references','a','shared.txt'),'ALPHA_NESTED_FILE\n');fs.writeFileSync(path.join(fixture,'references','b','shared.txt'),'BETA_NESTED_FILE\n');
 await call(first,'installSkill',{_accountId:'default',source:fixture,id:'packaged-acceptance',overwrite:false});
 const ca=await call(first,'getSkillCatalog',{_accountId:'default'}),cb=await call(first,'getSkillCatalog',{_accountId:bId});assert.ok(ca.installed.some(s=>s.id==='packaged-acceptance'));assert.equal(cb.installed.length,0);
 const aRuntime=(await call(first,'appInfo',{_accountId:'default'})).runtimeDir;
 const installedSkill=path.join(aRuntime,'profiles','local-skills','packaged-acceptance');
 assert.equal(fs.readFileSync(path.join(installedSkill,'references','a','shared.txt'),'utf8'),'ALPHA_NESTED_FILE\n');assert.equal(fs.readFileSync(path.join(installedSkill,'references','b','shared.txt'),'utf8'),'BETA_NESTED_FILE\n');
 await call(first,'setSkillEnabled',{_accountId:'default',id:'packaged-acceptance',enabled:false,source:'installed'});await call(first,'setSkillEnabled',{_accountId:'default',id:'packaged-acceptance',enabled:true,source:'installed'});
 const client=await mcp(a.mcpPort);const tools=await client.send('tools/list',{});assert.ok(tools.tools.some(t=>t.name==='load_skill'));
 const loaded=await client.send('tools/call',{name:'load_skill',arguments:{name:'packaged-acceptance'}});assert.notEqual(loaded.isError,true);assert.match(JSON.stringify(loaded),/PACKAGED_SKILL_MARKER/);
 const command=await client.send('tools/call',{name:'run_command',arguments:{command:'node -e "console.log(\'PACKAGED_NODE_OK \' + process.versions.node)"',working_directory:aWork,output_mode:'full'}});assert.notEqual(command.isError,true);
 const commandResult=command.structuredContent||JSON.parse(command.content.find(c=>c.type==='text').text);
 assert.equal(commandResult.ok,true);assert.equal(commandResult.data.exit_code,0);assert.match(commandResult.data.stdout,/^PACKAGED_NODE_OK \d+\.\d+\.\d+/m);
 await select(first,'default');await view(first,'skills');await screenshot(first,'06-account-A-installed-skill');
 pass('Packaged Skills are account-scoped; nested same-name files and real load_skill/node shim work without global Node');
 await view(first,'dashboard');
 const smallBounds=await resizeOwnedWindow(first,900,600);report.minimumWindow=smallBounds;
 assert.equal(await first.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await first.page.locator('#account-select').isVisible(),true);assert.equal(await first.page.locator('#btn-account-create').isVisible(),true);
 await screenshot(first,'07-minimum-window');await resizeOwnedWindow(first,1120,760);
 assert.deepEqual(first.pageErrors,[]);await closeActive();assertProtected();
 pass('Actual packaged narrow window keeps controls visible, has no overflow or renderer exceptions');
 const second=await launch(portable,'portable-restart');const persisted=await call(second,'listAccounts');assert.equal(persisted.accounts.length,2);for(const row of persisted.accounts){assert.equal(row.mcp.owned,false);assert.equal(row.config.setupDone,true);}
 assert.ok((await call(second,'getSkillCatalog',{_accountId:'default'})).installed.some(s=>s.id==='packaged-acceptance'));
 await call(second,'uninstallSkill',{_accountId:'default',id:'packaged-acceptance'});assert.equal((await call(second,'getSkillCatalog',{_accountId:'default'})).installed.length,0);await closeActive();
 pass('Portable restart preserves both configurations without auto-start; Skill uninstall is scoped');
 assert.equal(registry().some(isIsolatedRegistration),false);await runExe(setup,['/S','/D='+installed]);installedByTest=true;assert.ok(fs.existsSync(installedExe));
 const reg=registry().filter(isIsolatedRegistration);assert.equal(reg.length,1);assert.equal(reg[0].name,product+' '+version);assert.equal(reg[0].version,version);
 // NSIS records InstallLocation under its separate install key. The uninstall key
 // must point to this exact owned program through its quoted UninstallString.
 const uninstallMatch=/^"([^"]+\.exe)"(?:\s|$)/i.exec(reg[0].uninstall||'');assert.ok(uninstallMatch,'Missing registered uninstaller path');
 assert.equal(path.resolve(path.dirname(uninstallMatch[1])),path.resolve(installed));assert.ok(fs.existsSync(uninstallMatch[1]));
 if(reg[0].location)assert.equal(path.resolve(reg[0].location),path.resolve(installed));
 assert.ok(String(reg[0].icon||'').toLowerCase().startsWith(installed.toLowerCase()+'\\'),'Registered icon must belong to candidate installation');
 const third=await launch(installedExe,'installed-first');assert.equal((await call(third,'appInfo')).isPackaged,true);assert.equal((await call(third,'listAccounts')).accounts.length,2);
 await call(third,'startMcp',{_accountId:bId});await waitFor(()=>health(b.mcpPort),'installed account B health');await view(third,'dashboard');await screenshot(third,'08-installed-dashboard');await closeActive();
 pass('Real NSIS installer registers only isolated candidate; installed app starts bundled MCP and keeps account data');
 const uninstall=fs.readdirSync(installed).find(n=>/^Uninstall.*\.exe$/i.test(n));assert.ok(uninstall);await runExe(path.join(installed,uninstall),['/S']);installedByTest=false;
 await waitFor(()=>!fs.existsSync(installedExe),'installed program removed');assert.ok(fs.existsSync(path.join(userData,'config.json')),'Silent uninstall must preserve config');
 assert.deepEqual(registry(),registryBefore);for(const p of shortcuts)assert.ok(!fs.existsSync(p),'Isolated shortcut remains');assertProtected();
 pass('Silent uninstall removes only installed candidate and preserves data; original installation and live service unchanged');
 report.passed=true;
}catch(error){report.error=String(error.stack||error);process.exitCode=1;console.error(report.error);}
finally{
 try{
  await closeActive();
  if(installedByTest&&fs.existsSync(installed)){const name=fs.readdirSync(installed).find(n=>/^Uninstall.*\.exe$/i.test(n));if(name)await runExe(path.join(installed,name),['/S']);}
  assertProtected();
  if(ownsData){assert.equal(fs.readFileSync(marker,'utf8'),owner,'Data ownership marker changed; refusing cleanup');if(report.passed)fs.rmSync(userData,{recursive:true,force:false,maxRetries:5,retryDelay:300});else { const archive=path.join(path.dirname(userData),'.packaged-acceptance-failed-'+owner);assert.ok(!fs.existsSync(archive));fs.renameSync(userData,archive);report.failedDataArchive=archive; }}
  report.cleanupPassed=true;
 }catch(error){report.cleanupPassed=false;report.cleanupError=String(error.stack||error);report.passed=false;process.exitCode=1;console.error(report.cleanupError);}
 report.finishedAt=new Date().toISOString();save();
 if(report.passed)fs.writeFileSync(path.join(base,'latest.json'),JSON.stringify(report,null,2));
 console.log('PACKAGED_ACCEPTANCE_RESULT '+JSON.stringify({passed:report.passed,cleanupPassed:report.cleanupPassed,steps:report.steps.length,result:path.join(out,'result.json')}));
}
