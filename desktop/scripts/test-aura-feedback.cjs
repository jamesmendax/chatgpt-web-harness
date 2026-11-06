"use strict";
// Native pixels/uniforms + real private MCP. This is source acceptance, not packaged acceptance.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net"), Module = require("node:module"), { EventEmitter } = require("node:events");
const electron = require("electron"), { app } = electron;
const desktop = path.resolve(__dirname, ".."), repo = path.resolve(desktop, "..");
const out = require("./lib/test-isolation.cjs").artifactRoot("aura-feedback"); fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(out, "run-")), workspace = path.join(fixture, "workspace"); fs.mkdirSync(workspace);
const archiveIndex = process.argv.indexOf("--baseline-archive"), archive = archiveIndex >= 0 ? process.argv[archiveIndex + 1] : null;
let rendererIndex = null;
if (archive) {
  const asar = require("@electron/asar"), prefix = "renderer\\";
  for (const name of asar.listPackage(archive)) {
    const relative = name.replace(/^[/\\]+/, "");
    if (!relative.startsWith(prefix)) continue;
    const stat = asar.statFile(archive, relative); if (stat.files) continue;
    const target = path.resolve(fixture, "baseline", relative);
    assert.ok(target.startsWith(path.resolve(fixture, "baseline") + path.sep));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, asar.extractFile(archive, relative));
  }
  rendererIndex = path.join(fixture, "baseline", "renderer", "v3", "aura", "index.html");
  assert.ok(fs.existsSync(rendererIndex));
}
app.setPath("appData", fixture); app.setPath("userData", path.join(fixture, "chatgpt-web-harness-isolated"));
app.getVersion = () => require("../package.json").version;
app.commandLine.appendSwitch("force-device-scale-factor", "1"); app.commandLine.appendSwitch("use-angle", "d3d11");
let resolveWindow, win, client; const ready = new Promise(resolve => { resolveWindow = resolve; });
class FixtureWindow extends electron.BrowserWindow {
  constructor(options) { super({ ...options, width: 1120, height: 760, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } }); this.webContents.once("did-finish-load", () => resolveWindow(this)); }
  loadFile(file, options) { return super.loadFile(rendererIndex || file, options); }
}
class FixtureTray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent?.filename.startsWith(desktop)) return { ...electron, BrowserWindow: FixtureWindow, Tray: FixtureTray };
  return originalLoad.call(this, request, parent, isMain);
};
require("../src/main.js");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = expression => win.webContents.executeJavaScript(expression);
async function wait(expression, budget = 15000) { const end=Date.now()+budget; while(Date.now()<end) { if(await js(expression)) return; await pause(40); } throw new Error("Timed out: "+expression); }
async function ports() { const servers=[], values=[]; try { for(let i=0;i<3;i++) { const server=net.createServer(); await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);}); servers.push(server);values.push(server.address().port); } return values; } finally { await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve)))); } }
function chroma(image) { const bitmap=image.toBitmap(), {width,height}=image.getSize(); let sum=0,n=0; const band=12; for(let y=0;y<height;y+=2) for(let x=0;x<width;x+=2) { if(x>=band&&x<width-band&&y>=band&&y<height-band) continue; const at=(y*width+x)*4; sum+=Math.max(bitmap[at],bitmap[at+1],bitmap[at+2])-Math.min(bitmap[at],bitmap[at+1],bitmap[at+2]);n++; } return { meanChroma:sum/n,pixels:n,width,height }; }
async function capture(name) { const image=await win.capturePage(); fs.writeFileSync(path.join(fixture,name+".png"),image.toPNG()); return chroma(image); }
async function cleanup() { if(client) try {await client.close();}catch{} if(win&&!win.isDestroyed()) try {await js("window.__harness.core.act.stopAll()");}catch{} }
const deadline=setTimeout(async()=>{console.error("Native feedback deadline",fixture);await cleanup();app.exit(1);},60000);
(async()=>{
 win=await ready; await wait("window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')");
 const privatePorts=await ports();
 const config=await js("window.launcher.saveConfig("+JSON.stringify({setupDone:true,autoStart:false,mcpPort:privatePorts[0],adminPort:privatePorts[1],tunnelPort:privatePorts[2],workspacePath:workspace})+")"); assert.equal(config.ok,true,config.error);
 await js("window.__harness.core.act.startMcp()"); await wait("window.__harness.core.snapshot().account.mcp.healthy && window.__harness.core.snapshot().account.mcp.managed",25000);
 await wait("window.AuraMemoryGuard.status().scene?.ready===true");
 const uniform=()=>js("(()=>{const gl=document.querySelector('#scene').getContext('webgl');const p=gl.getParameter(gl.CURRENT_PROGRAM);const v=gl.getUniform(p,gl.getUniformLocation(p,'uEffects'));return {edge:v[0],resources:window.AuraMemoryGuard.status().resources};})()");
 const startCurtain=await uniform();assert.equal(startCurtain.edge,1,"original High curtain is still enabled");
 await js("window.__harness.setCurtain(false)");await pause(240);
 const disabledCurtain=await uniform();assert.equal(disabledCurtain.edge,0,"curtain must skip shader edge work when off");
 assert.equal(disabledCurtain.resources.created,startCurtain.resources.created,"toggle must not allocate another WebGL context");
 await js("window.__harness.setCurtain(true)");await pause(240);
 const enabledCurtain=await uniform();assert.equal(enabledCurtain.edge,1,"turning curtain on restores the exact original High edge coefficients");
 assert.equal(enabledCurtain.resources.created,startCurtain.resources.created);
 await js("window.__harness.applyTheme?.('light'); window.__harness.setView('workspace'); window.__feedbackEvents=[]; window.__harness.core.on('activity', e=>window.__feedbackEvents.push({kind:e.kind,tool:e.record.tool,phase:e.record.phase,ms:e.record.ms,id:e.record.callId})); window.__feedbackSamples=[]; window.__feedbackSampling=true; (function sample(){const gl=document.querySelector('#scene').getContext('webgl');const p=gl?.getParameter(gl.CURRENT_PROGRAM);if(p){const read=n=>gl.getUniform(p,gl.getUniformLocation(p,n));window.__feedbackSamples.push({at:performance.now(),active:read('uActive'),pulse:read('uPulse'),on:read('uOn')});}if(window.__feedbackSampling)requestAnimationFrame(sample);})()");
 await pause(700); const idle=await capture("idle"); await js("window.__feedbackSamples=[]");
 const {Client}=await import("@modelcontextprotocol/sdk/client/index.js"), {StreamableHTTPClientTransport}=await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
 client=new Client({name:"native-feedback-fixture",version:"1"}); await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:"+privatePorts[0]+"/mcp")));
 const fast=await client.callTool({name:"list_directory",arguments:{path:workspace}}); assert.notEqual(fast.isError,true);
 const intent=JSON.stringify({intent_revision:1,objective:"Verify native feedback using a short sleep in a disposable workspace",scope:["fixture workspace"],out_of_scope:["live services","cloud","user data"],deliverables:["native pixel and uniform metrics"],success_criteria:["short sleep completes"],constraints:["no file changes"],protected_resources:["existing MCP and tunnel"],known_facts:["private fixture ports"],assumptions:[],delegated_decisions:[],remaining_nonblocking_uncertainties:[],closure_items:[],ambiguities:[],clarification_round:0,questions_in_round:0,resolution_mode:"none"});
 const slow=client.callTool({name:"run_command",arguments:{command:process.platform==="win32"?"Start-Sleep -Milliseconds 1800":"sleep 1.8",_intent:intent}});
 await pause(650);const active=await capture("active");const slowResult=await slow;assert.notEqual(slowResult.isError,true,JSON.stringify(slowResult));await pause(500);
 const measured=await js("(()=>{window.__feedbackSampling=false;const samples=window.__feedbackSamples;return{events:window.__feedbackEvents,activity:window.__harness.core.snapshot().activity,maxActive:Math.max(0,...samples.map(s=>s.active)),maxPulse:Math.max(0,...samples.map(s=>s.pulse)),onRange:[Math.min(...samples.map(s=>s.on)),Math.max(...samples.map(s=>s.on))],sampleCount:samples.length,theme:document.documentElement.dataset.theme || 'legacy-light',noWebgl:document.documentElement.classList.contains('no-webgl'),tunnelManaged:window.__harness.core.snapshot().account.tunnel.managed}})()");
 const report={fixture,baselineArchive:archive,privatePorts,idle,active,chromaIncrease:active.meanChroma-idle.meanChroma,...measured,cloudVerified:false,packagedAcceptance:false,userVisualApproval:false};
 const violations=[]; if(!measured.events.some(e=>e.kind==="start"))violations.push("missing real start"); if(!measured.events.some(e=>e.kind==="end"))violations.push("missing real end"); for(const tool of ["list_directory","run_command"])if(!measured.activity.some(r=>r.tool===tool&&r.phase==="done"&&Number.isFinite(r.ms)&&r.ms>=0))violations.push("missing duration: "+tool); if(!(measured.maxActive>.2))violations.push("uActive did not activate"); if(!(measured.maxPulse>0))violations.push("uPulse did not ripple"); if(!(report.chromaIncrease>0))violations.push("edge chroma did not increase"); if(measured.tunnelManaged)violations.push("unexpected tunnel"); report.violations=violations;report.passed=violations.length===0;
 fs.writeFileSync(path.join(fixture,"report.json"),JSON.stringify(report,null,2)); console.log("AURA_NATIVE_FEEDBACK "+JSON.stringify(report));
 clearTimeout(deadline);await cleanup();app.exit(archive?0:report.passed?0:1);
})().catch(async error=>{clearTimeout(deadline);console.error(error.stack||error);fs.writeFileSync(path.join(fixture,"failure.json"),JSON.stringify({error:String(error)},null,2));await cleanup();app.exit(1);});
