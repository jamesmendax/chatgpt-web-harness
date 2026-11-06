"use strict";
// Real hidden native window: requestAnimationFrame starvation must not gate UI reveal.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),{EventEmitter}=require("node:events");
const electron=require("electron"),{app}=electron;
const desktop=path.resolve(__dirname,".."),out=require("./lib/test-isolation.cjs").artifactRoot("aura-boot");fs.mkdirSync(out,{recursive:true});
const fixture=fs.mkdtempSync(path.join(out,"run-"));
app.setPath("appData",fixture);app.setPath("userData",path.join(fixture,"chatgpt-web-harness-isolated"));app.getVersion=()=>require("../package.json").version;
let resolveWindow,win;const ready=new Promise(resolve=>{resolveWindow=resolve;});
class HiddenWindow extends electron.BrowserWindow{
 constructor(options){super({...options,show:false,paintWhenInitiallyHidden:false,webPreferences:{...options.webPreferences,offscreen:false,backgroundThrottling:true}});this.webContents.once("did-finish-load",()=>resolveWindow(this));}
 show(){} showInactive(){}
}
class FixtureTray extends EventEmitter{setToolTip(){}setContextMenu(){}destroy(){}}
const original=Module._load;
Module._load=function(request,parent,isMain){if(request==="electron"&&parent?.filename.startsWith(desktop))return{...electron,BrowserWindow:HiddenWindow,Tray:FixtureTray};return original.call(this,request,parent,isMain);};
require("../src/main.js");
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const timer=setTimeout(()=>{console.error("AURA_BOOT_DEADLINE",fixture);app.exit(1);},20000);
(async()=>{
 win=await ready;
 await win.webContents.executeJavaScript("window.__bootRafCount=0; requestAnimationFrame(()=>window.__bootRafCount++); window.__bootProbeAt=performance.now()");
 let state;const started=Date.now();
 while(Date.now()-started<7500){state=await win.webContents.executeJavaScript("({hidden:document.hidden,booting:document.body.classList.contains('booting'),mode:window.__harness?.core?.mode,settings:!!document.querySelector('#nav [data-view=settings]'),raf:window.__bootRafCount,elapsed:performance.now()-window.__bootProbeAt})");if(state.mode==="electron"&&!state.booting)break;await pause(100);}
 const info=await win.webContents.executeJavaScript("window.launcher.appInfo()");assert.ok(path.resolve(info.result.configPath).startsWith(path.resolve(fixture)+path.sep));
 const report={fixture,...state,services:await win.webContents.executeJavaScript("(()=>{const a=window.__harness.core.snapshot().account;return{mcp:a.mcp.managed,tunnel:a.tunnel.managed}})()"),passed:false};
 try{
 assert.equal(state.hidden,true,"fixture remains genuinely hidden");assert.equal(state.mode,"electron");assert.equal(state.settings,true);assert.equal(state.raf,0,"hidden native window must demonstrate rAF starvation");assert.equal(state.booting,false,"boot overlay must clear without a rendered animation frame");
 await win.webContents.executeJavaScript("document.querySelector('#nav [data-view=settings]').click()");
 report.settingsWorks=await win.webContents.executeJavaScript("document.body.dataset.view==='settings'&&!document.querySelector('#view-settings').hidden");assert.equal(report.settingsWorks,true);assert.equal(report.services.mcp,false);assert.equal(report.services.tunnel,false);
 const project=path.join(fixture,"workspace");fs.mkdirSync(project);
 const [firstMcp,firstAdmin,firstTunnel,secondMcp,secondAdmin,secondTunnel]=await require("./lib/test-isolation.cjs").privatePorts(6);
 const configReply=await win.webContents.executeJavaScript(`window.launcher.saveConfig(${JSON.stringify({mcpPort:firstMcp,adminPort:firstAdmin,tunnelPort:firstTunnel,workspacePath:project})})`);
 assert.equal(configReply.ok,true,"Synthetic config save failed: "+String(configReply.error||"unknown"));
 const saved=await win.webContents.executeJavaScript("window.launcher.getConfig()");
 assert.equal(saved.result.mcpPort,firstMcp);
 assert.equal(saved.result.workspacePath,project);
 report.syntheticConfigSaveWorks=true;
 await win.webContents.executeJavaScript(`(()=>{for(const [key,value] of Object.entries(${JSON.stringify({mcpPort:secondMcp,adminPort:secondAdmin,tunnelPort:secondTunnel,workspacePath:project})})){const el=document.querySelector('#f-'+key);el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));}document.querySelector('#btn-save-only').click()})()`);
 let last;
 for(let i=0;i<60;i++) {
   last=await win.webContents.executeJavaScript("({port:window.__harness.core.snapshot().account.config.mcpPort,status:document.querySelector('#form-status').textContent,draft:window.__harness.core.snapshot().account.config.workspacePath})");
   if(last.port===secondMcp)break;
   await pause(100);
 }
 assert.equal(last.port,secondMcp,"Aura UI save failed: "+JSON.stringify(last));
 report.syntheticFormSaveWorks=true;
 const audio=await win.webContents.executeJavaScript("window.launcher.getNotificationSounds()");
 assert.equal(audio.ok,true);
 assert.equal(audio.result.choices.length,5);
 assert.equal(audio.result.selected,"glass");
 const selected=await win.webContents.executeJavaScript("window.launcher.selectNotificationSound({id:'waterdrop'})");
 assert.equal(selected.ok,true);
 const volume=await win.webContents.executeJavaScript("window.launcher.setNotificationVolume({volume:40})");
 assert.equal(volume.ok,true);
 const savedAudio=await win.webContents.executeJavaScript("window.launcher.getNotificationSounds()");
 assert.equal(savedAudio.result.selected,"waterdrop");assert.equal(savedAudio.result.volume,40);
 const uiSound=await win.webContents.executeJavaScript("({picker:!!document.querySelector('#sound-choice'), volume:!!document.querySelector('#sound-volume'), count:document.querySelector('#sound-choice')?.options.length})");
 assert.equal(uiSound.picker,true);assert.equal(uiSound.volume,true);assert.equal(uiSound.count,6);
 report.syntheticSoundSettingsWorks=true;
 const wavSource=fs.readFileSync(path.join(desktop,"src","assets","web-harness-digital.wav"));
 const imported=await win.webContents.executeJavaScript(`window.launcher.importNotificationAudio({wavBase64:${JSON.stringify(wavSource.toString("base64"))}})`);
 assert.equal(imported.ok,true,"Synthetic WAV import failed: "+String(imported.error||"unknown"));
 const savedCustom=await win.webContents.executeJavaScript("window.launcher.getNotificationSounds()");
 assert.equal(savedCustom.result.selected,"custom");
 assert.equal(savedCustom.result.hasCustom,true);
 assert.deepEqual(fs.readFileSync(path.join(app.getPath("userData"),"notification-sounds","custom.wav")),wavSource);
 const {ConversationIndex}=require("../src/conversation-index");
 const indexed=new ConversationIndex({rootFor:()=>app.getPath("userData")});
 const fullId="oai_conv_"+"b".repeat(32);
 indexed.observe("default",fullId,{hint:"发行安全检查",tool:"task_create"});
 const seen=await win.webContents.executeJavaScript("window.launcher.listConversationNames()");
 assert.equal(seen.ok,true);assert.equal(seen.result[0].display,"会话 01「发行安全检查」");
 await win.webContents.executeJavaScript("document.querySelector('#ch-conversations button').click()");
 const listed=await win.webContents.executeJavaScript("document.querySelector('#conversation-label-list').textContent");
 assert.match(listed,/发行安全检查/);
 report.syntheticConversationListWorks=true;
 report.syntheticCustomAudioImportWorks=true;report.passed=true;
 }catch(error){report.error=error.stack||String(error);}
 fs.writeFileSync(path.join(fixture,"report.json"),JSON.stringify(report,null,2));console.log("AURA_OCCLUDED_BOOT "+JSON.stringify(report));clearTimeout(timer);app.exit(report.passed?0:1);
})().catch(error=>{console.error(error.stack||error);clearTimeout(timer);app.exit(1);});
