"use strict";
// Runs ONLY the new Portable EXE copied into a unique strict clean-host scope.
// No installer, no account import from real profiles, no cloud and no real audio.
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto"),net=require("node:net");
const {spawn,execFileSync}=require("node:child_process");
const {chromium}=require("playwright-core");
const version=require("../package.json").version,desktop=path.resolve(__dirname,"..");
const src=path.join(desktop,"release-"+version,"ChatGPT Web Harness Isolated-"+version+"-portable.exe");
const runRoot=fs.mkdtempSync(path.join(os.tmpdir(),"harness-clean-host-"));
const scope=path.join(runRoot,"portable"),appData=path.join(scope,"appdata"),userData=path.join(appData,"chatgpt-web-harness-isolated");
const localAppData=path.join(scope,"localappdata"),tmp=path.join(scope,"temp"),workspace=path.join(scope,"workspace");
const token=crypto.randomBytes(32).toString("hex");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function uniqueDirs(){for(const p of [scope,appData,userData,localAppData,tmp,workspace])fs.mkdirSync(p,{recursive:true});}
async function port(){return new Promise((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(e=>e?reject(e):resolve(p));});});}
function cleanEnvironment() {
  const keys=["SystemRoot","WINDIR","ComSpec","PATHEXT","OS","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS","USERPROFILE","HOMEDRIVE","HOMEPATH","USERNAME","USERDOMAIN"];
  const env={};
  for(const k of keys)if(process.env[k])env[k]=process.env[k];
  const sys=process.env.SystemRoot||"C:\\Windows";
  Object.assign(env,{SystemRoot:sys,WINDIR:sys,PATH:[path.join(sys,"System32"),sys,path.join(sys,"System32","WindowsPowerShell","v1.0")].join(";"),
    APPDATA:appData,LOCALAPPDATA:localAppData,TEMP:tmp,TMP:tmp,
    HARNESS_CLEAN_HOST_SCOPE:scope,HARNESS_CLEAN_HOST_TOKEN:token,
    ELECTRON_NO_ATTACH_CONSOLE:"1"});
  return env;
}
async function waitFor(check,label,timeoutMs) {
  const deadline=Date.now()+timeoutMs;let last=null;
  while(Date.now()<deadline){try{const result=await check();if(result)return result;}catch(e){last=e;}await sleep(250);}
  throw Error("Packaged smoke timeout: "+label+(last?" ("+last.message+")":""));
}
function ownedProcessRows() {
  const ps="Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:WH_ACCEPTANCE_USER_DATA) } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress -Depth 2";
  const out=execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",ps],{
    env:{...process.env,WH_ACCEPTANCE_USER_DATA:userData},encoding:"utf8",windowsHide:true,timeout:30000});
  const raw=String(out).trim();if(!raw)return [];
  const parsed=JSON.parse(raw);return parsed==null?[]:Array.isArray(parsed)?parsed:[parsed];
}
function cleanupOwned() {
  // Exact unique marker only. Never enumerate or kill by executable name.
  try {
    const rows=ownedProcessRows();
    for(const row of rows) {
      if(!Number.isSafeInteger(Number(row.ProcessId))||!String(row.CommandLine).includes(userData))continue;
      const cmd="$id=[int]$env:WH_OWN_PID;$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\";if($p -and $p.CommandLine -and $p.CommandLine.Contains($env:WH_ACCEPTANCE_USER_DATA)){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}";
      execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",cmd],{
        env:{...process.env,WH_OWN_PID:String(row.ProcessId),WH_ACCEPTANCE_USER_DATA:userData},
        windowsHide:true,timeout:30000});
    }
  } catch(e){console.error("CLEAN_HOST_CLEANUP_WARNING "+String(e.message).slice(0,300));}
}
(async()=>{
  assert.ok(fs.existsSync(src),"Candidate portable missing");
  uniqueDirs();
  fs.writeFileSync(path.join(scope,".clean-host-fixture.json"),JSON.stringify({schema_version:1,scope,token,created_at:Date.now()})+"\n",{flag:"wx",mode:0o600});
  const candidate=path.join(runRoot,path.basename(src));
  fs.copyFileSync(src,candidate,fs.constants.COPYFILE_EXCL);
  const ports=[await port(),await port(),await port()];
  assert.equal(new Set(ports).size,3);
  fs.writeFileSync(path.join(userData,"config.json"),JSON.stringify({
    version:1,setupDone:false,tunnelId:"",apiKeyEnc:"",workspacePath:workspace,
    mcpPort:ports[0],adminPort:ports[1],tunnelPort:ports[2],
    autoStart:false,minimizeToTray:false,relayEnabled:false,
  },null,2));
  const debugPort=await port(),base="http://127.0.0.1:"+debugPort;
  const env=cleanEnvironment(),args=["--user-data-dir="+userData,"--remote-debugging-port="+debugPort,
    "--remote-debugging-address=127.0.0.1","--disable-gpu","--disable-software-rasterizer"];
  const child=spawn(candidate,args,{cwd:runRoot,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  let childError="",lastLog="";
  child.on("error",e=>{childError=String(e);});
  child.stdout?.on("data",d=>lastLog=(lastLog+String(d)).slice(-10000));
  child.stderr?.on("data",d=>lastLog=(lastLog+String(d)).slice(-10000));
  let browser=null;
  const result={version,fixture:runRoot,portableCandidate:src,startedPid:child.pid,
    checks:[],installerExecuted:false,productionDataTouched:false,cloudAccepted:false};
  function passed(name){result.checks.push(name);console.log("PASS PACKAGED "+name);}
  try {
    await waitFor(async()=>{
      if(childError)throw Error(childError);
      const response=await fetch(base+"/json/version",{signal:AbortSignal.timeout(1200)});
      return response.ok;
    },"actual Portable Electron CDP startup",135000);
    browser=await chromium.connectOverCDP(base,{timeout:30000});
    const page=await waitFor(async()=>browser.contexts().flatMap(ctx=>ctx.pages()).find(p=>p.url().includes("index.html")),"Aura packaged page",30000);
    await page.waitForFunction(()=>window.__harness?.core?.mode==="electron" && !document.body.classList.contains("booting"),{timeout:30000});
    const api=async(method,payload)=>{
      const r=await page.evaluate(({method,payload})=>window.launcher[method](payload),{method,payload});
      assert.equal(r?.ok,true,method+" failed: "+(r?.error||"unknown"));return r.result;
    };
    const info=await api("appInfo");
    assert.equal(info.version,version);
    assert.ok(path.resolve(info.configPath).startsWith(path.resolve(userData)+path.sep),"Packaged app escaped temp account root");
    assert.equal(info.isPackaged,true);
    passed("real portable version and private clean-host config");
    const status=await api("getStatus");
    assert.equal(status.mcp?.managed||false,false);
    assert.equal(status.tunnel?.managed||false,false);
    passed("no automatic MCP/Tunnel or cloud");
    const initial=await api("getNotificationSounds");
    assert.equal(initial.selected,"glass");assert.equal(initial.choices.length,5);
    await api("selectNotificationSound",{id:"bells"});
    await api("setNotificationVolume",{volume:40});
    const settings=await api("getNotificationSounds");
    assert.equal(settings.selected,"bells");assert.equal(settings.volume,40);
    passed("5 built-in sounds, account-owned choice and 40% volume");
    const wav=fs.readFileSync(path.join(desktop,"src","assets","web-harness-digital.wav"));
    const imported=await api("importNotificationAudio",{wavBase64:wav.toString("base64")});
    assert.equal(imported.selected,"custom");
    assert.deepEqual(fs.readFileSync(path.join(userData,"notification-sounds","custom.wav")),wav);
    passed("native packaged IPC custom PCM import and exact account-local bytes");
    const full="oai_conv_12345678"+"f".repeat(24);
    const profiles=path.join(userData,"runtime","profiles");
    fs.mkdirSync(profiles,{recursive:true});
    fs.writeFileSync(path.join(profiles,"conversation-index.json"),JSON.stringify({
      schema:1,nextNumber:2,records:[{id:full,number:1,title:"发行验收会话",alias:"",createdAt:Date.now(),lastAt:Date.now(),pinned:false}]
    }));
    const named=await api("listConversationNames");
    assert.equal(named.length,1);assert.equal(named[0].display,"会话 01「发行验收会话」");
    await page.locator('#nav [data-view="settings"]').click();
    await page.locator('#ch-conversations button').first().click();
    await page.waitForFunction(()=>document.querySelector("#conversation-label-list")?.textContent.includes("发行验收会话"),{timeout:15000});
    const rendered=await page.evaluate(()=>({
      pickerCount:document.querySelector("#sound-choice")?.options.length,
      label:document.querySelector("#conversation-label-list")?.textContent.slice(0,100)
    }));
    assert.equal(rendered.pickerCount,6);
    assert.match(rendered.label,/发行验收会话/);
    passed("full anonymized conversation ID mapped to readable label in packaged Aura");
    const persisted=JSON.parse(fs.readFileSync(path.join(userData,"config.json"),"utf8"));
    assert.equal(persisted.notificationSound,"custom");assert.equal(persisted.notificationVolume,40);
    assert.equal(persisted.apiKeyEnc||"","");
    passed("settings persisted without introducing real credential");
    result.passed=true;
    console.log("FOUR_FIXES_PORTABLE_RESULT "+JSON.stringify(result));
  } finally {
    if(browser)await browser.close().catch(()=>{});
    cleanupOwned();
    try {child.kill();} catch {}
    await sleep(1000);
    const remaining=ownedProcessRows();
    assert.deepEqual(remaining,[],"Clean host candidate left scoped process running; manual cleanup must inspect "+runRoot);
  }
})().catch(error=>{console.error("FOUR_FIXES_PORTABLE_FAILED "+String(error.stack||error).slice(0,3500));process.exitCode=1;});
