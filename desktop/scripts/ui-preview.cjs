"use strict";
/** Safe design preview: real renderer + unchanged production preload; in-memory IPC fixtures only.
 * Never imports main.js, starts services, opens real credentials or modifies account data.
 * Run Aura: node desktop/scripts/run-electron.cjs desktop/scripts/ui-preview.cjs --aura
 * Capture: add --capture-dir=PATH (implies --aura and --test; writes only PNG evidence).
 * The no-flag renderer stays legacy-compatible for the existing preview test drivers.
 */
const { app, BrowserWindow, ipcMain, Menu, session } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const pkg = require("../package.json");
const arg = name => process.argv.find(x => x.startsWith(name + "="))?.slice(name.length + 1);
const captureDir = arg("--capture-dir") ? path.resolve(arg("--capture-dir")) : null;
const test = process.argv.includes("--test") || Boolean(captureDir);
const aura = process.argv.includes("--aura") || Boolean(captureDir);
const rendererFile = path.resolve(__dirname, aura ? "../renderer/v3/aura/index.html" : "../renderer/index.html");
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-harness-ui-preview-"));
app.setPath("userData", fixtureDir);
app.setName("Web Harness — Isolated Design Preview");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", arg("--scale") || "1");
let win, selected = "preview-main", scenario = arg("--scenario") || "waiting", failNext = null, sequence = 0;
let releaseInitialization;
const initialization = new Promise(resolve => { releaseInitialization = resolve; });
const holdInitialization = process.argv.includes("--hold-init");
const calls = [], configById = new Map(), catalogById = new Map(), logsById = new Map();
const conversationsById = new Map(), customAudioById = new Map(), importReviews = new Map();
const soundChoices = [
  ["glass", "琉璃三连", "web-harness-chime.wav"], ["waterdrop", "水滴双音", "web-harness-waterdrop.wav"],
  ["xylophone", "木琴轻敲", "web-harness-xylophone.wav"], ["bells", "清亮风铃", "web-harness-bells.wav"],
  ["digital", "电子短讯", "web-harness-digital.wav"]
].map(([id, name, file]) => ({ id, name, file }));
const clone = value => JSON.parse(JSON.stringify(value));
const time = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const accounts = [{ id: "preview-main", name: "Personal workspace" }, { id: "preview-lab", name: "实验室 · Lab" }];
const baseConfig = index => ({ setupDone: true, hasApiKey: true, workspacePath: index ? "D:\\Projects\\research-lab" : "D:\\Projects\\web-harness", mcpPort: 3400 + index * 10, adminPort: 3401 + index * 10, tunnelPort: 3402 + index * 10, tunnelId: "tunnel_preview_" + (index ? "research" : "personal") + "_not_a_real_tunnel", toolProfile: "full", tunnelProxyMode: "auto", tunnelProxyUrl: "", relayEnabled: false, relayAutomationEnabled: false, relayAutoRecoveryEnabled: false, autoStart: false, minimizeToTray: true, idleReminderMinutes: 5, notificationSound: "glass", notificationVolume: 100 });
function initialCatalog() { return { computerUse: { enabled: true, available: true }, browserUse: { enabled: true, available: true, runtimeReady: true }, configPath: "D:\\Preview\\profiles\\plugins.json", installed: [
  { id: "code-review", version: "1.2.0", description: "审查代码质量、测试覆盖与潜在回归，让每一次提交更可靠。", path: "D:\\Preview\\skills\\code-review\\SKILL.md", enabled: true },
  { id: "release-checklist", version: "1.0.3", description: "把构建、版本和发布检查整理为可重复执行的工作流。", path: "D:\\Preview\\skills\\release-checklist\\SKILL.md", enabled: false }
], external: [{ id: "team-conventions", description: "团队工程规范与协作约定，直接引用现有工作区文件。", path: "D:\\Projects\\shared\\team-conventions\\SKILL.md", enabled: true }], project: [{id: "project-context", source: "project", description: "项目目录中发现的上下文与操作指引。", path: "D:\\Projects\\web-harness\\skills\\project-context\\SKILL.md", enabled: true}], builtin: [{id: "browser-use", description: "在隔离会话中执行浏览器操作。", version: "bundled", path: "bundled-plugins/browser-use/SKILL.md", enabled:true}] }; }
function initialAuraLogs(accountId, now = Date.now()) {
  const stamp = at => {
    const date = new Date(at);
    return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
  };
  const line = (ago, text) => stamp(now - ago) + " " + text;
  // Synthetic canonical pairs exercise the real renderer without invoking a tool.
  const samples = [
    { ago: 50000, tool: "project_context", target: "演示项目", ms: 18 },
    { ago: 42000, tool: "run_command", target: "演示命令", ms: 2,
      diagnostic: "outcome=needs_input code=REQUIREMENT_CONTRACT_REQUIRED phase=admission started=false retry=retry_with_changed_args" },
    { ago: 34000, tool: "visual_review", target: "演示界面", ms: 11,
      diagnostic: "outcome=review_rejected code=VISUAL_CRITIQUE_CONTRADICTION phase=validation started=false retry=refresh_state" },
    { ago: 26000, tool: "write_file", target: "演示草稿", ms: 3,
      diagnostic: "outcome=blocked code=RI_BLOCKED phase=admission started=false retry=refresh_state" },
    { ago: 18000, tool: "run_command", target: "演示检查脚本", ms: 267,
      diagnostic: "outcome=execution_error code=COMMAND_EXIT_NONZERO phase=execution started=true retry=inspect_original_result" },
    { ago: 10000, tool: "read_text_file", target: "演示项目说明.md", ms: 24 }
  ];
  const mcp = [line(55000, "[preview] 隔离预览：以下均为合成演示记录")];
  samples.forEach((sample, index) => {
    const callId = accountId + "-demo-" + (index + 1);
    mcp.push(line(sample.ago + sample.ms, "[TOOL] [running] " + sample.tool + " — " + sample.target + " 0ms call=" + callId));
    mcp.push(line(sample.ago, "[TOOL] [" + (sample.diagnostic ? "error" : "ok") + "] " + sample.tool + " — " + sample.target + " " + sample.ms + "ms" + (sample.diagnostic ? " " + sample.diagnostic : "") + " call=" + callId));
  });
  return { mcp,
    tunnel: [line(55000, "[tunnel] Local upstream configured (preview)"), line(54000, "[readyz] Local MCP fixture ready"), line(8000, "[poll] ok · simulated cloud acknowledgement")],
    launcher: [line(55000, "[preview] ISOLATED FIXTURE — no real services or accounts"), line(54000, "[account] Selected " + accountId + " (synthetic)")]
  };
}
function initialLogs(accountId) {
  if (aura) return initialAuraLogs(accountId);
  return { mcp: [
  "10:42:08 [runtime] MCP server initialized · profile=full",
  "10:42:08 [tools] Registered 77 tools from local providers",
  "10:42:09 [HTTP] Listening on 127.0.0.1:3400",
  "10:42:09 [session] New workspace session established",
  "10:42:12 [tool] read_text_file · src/lib/runtime-scope.ts",
  "10:42:12 [result] Completed in 18ms · 142 lines returned",
  "10:42:14 [HTTP] GET /health 200 2ms",
  "10:42:16 [tool] project_context · source inventory",
  "10:42:16 [result] 8 matching files · 3.2 KB returned",
  "10:42:21 [warning] Workspace index is refreshing; cached results remain available",
  "10:42:22 [index] Workspace index ready · 440 files",
  "10:42:24 [runtime] Waiting for the next tool invocation"
], tunnel: ["10:42:08 [tunnel] Local upstream configured", "10:42:09 [readyz] Local MCP connection ready", "10:42:10 [poll] Waiting for cloud acknowledgement", "10:42:11 [route] Outbound requests use system proxy"], launcher: ["10:42:06 [preview] ISOLATED FIXTURE — no real services or accounts", "10:42:07 [account] Selected Personal workspace"] }; }
function initialConversations(accountId) {
  return ["界面修复", "发布前检查", ""].map((title, index) => ({
    id: "oai_conv_" + crypto.createHash("sha256").update(accountId + ":" + index).digest("hex").slice(0, 32),
    number: index + 1, title, alias: "", pinned: index === 0,
    createdAt: Date.now() - (index + 1) * 3600000, lastAt: Date.now() - index * 60000,
    lastTool: ["read_text_file", "run_command", "visual_review"][index]
  }));
}
function conversationView(row) {
  const title = row.alias || row.title;
  return { number: row.number, id: row.id, title,
    display: "会话 " + String(row.number).padStart(2, "0") + (title ? "「" + title + "」" : " · 11月4日"),
    source: row.alias ? "manual" : row.title ? "task" : "number", pinned: row.pinned, lastAt: row.lastAt, lastTool: row.lastTool };
}
function seedPreferences(id, { empty = false, custom = false } = {}) {
  conversationsById.set(id, empty ? [] : initialConversations(id));
  customAudioById.set(id, custom);
}
for (let i=0;i<accounts.length;i++) {
  const id = accounts[i].id;
  configById.set(id, baseConfig(i)); catalogById.set(id, initialCatalog()); logsById.set(id, initialLogs(id));
  seedPreferences(id, { custom: i === 0 });
}
function inspectImport(id) {
  importReviews.clear();
  const token = crypto.randomBytes(24).toString("hex");
  const entries = [
    { sourceId: "legacy-studio", name: "Design Studio", workspacePath: "D:\\Preview\\Studio", tunnelId: "fixture_studio_not_a_real_tunnel", installedSkills: 12, registeredSkills: 4, mcpServers: 2, hasCustomAudio: true, hasConversationNames: true, soundChoice: "custom", soundVolume: 65 },
    { sourceId: "legacy-personal", name: "Personal workspace", workspacePath: "D:\\Preview\\Personal", tunnelId: configById.get("preview-main")?.tunnelId, installedSkills: 34, registeredSkills: 34, mcpServers: 0, existingAccountId: "preview-main", warning: "此账户已存在，将补全缺少的配置。", hasCustomAudio: false, hasConversationNames: false, soundChoice: "glass", soundVolume: 100 },
    { sourceId: "legacy-research", name: "研究与创作 · Research", workspacePath: "D:\\Preview\\Research", tunnelId: "fixture_research_not_a_real_tunnel", installedSkills: 8, registeredSkills: 3, mcpServers: 1, hasCustomAudio: false, hasConversationNames: true, soundChoice: "bells", soundVolume: 80 }
  ].map((row, index) => ({ mcpPort: 8300 + index * 10, adminPort: 8301 + index * 10, tunnelPort: 8302 + index * 10, setupDone: true, hasApiKey: true, skillFiles: row.installedSkills * 2, hasProviderSettings: true, ...row }));
  const result = { token, sourceFolder: "D:\\Preview\\WebHarness-3.0.2-portable.data\\appdata\\chatgpt-web-harness-isolated", accounts: entries };
  importReviews.set(token, { accountId: id, createdAt: Date.now(), result });
  return clone(result);
}
function snapshot(id = selected) {
  const config = clone(configById.get(id));
  const mcp = { managed:true, healthy:true, state:"running", pid:41008, build:"99260423a505d197", toolCount:77, toolProfile:config.toolProfile, staleBuild:false, auth:"none" };
  const tunnel = { managed:true, ready:true, reachable:true, state:"running", pid:41012, cloudState:"unknown", proxyRoute:{mode:"proxy",url:"http://127.0.0.1:7890",source:"system"} };
  if (scenario === "online") { tunnel.cloudState="online"; tunnel.lastPollSuccessAt=Date.now(); }
  if (scenario === "stopped" || id === "preview-lab") { Object.assign(mcp,{managed:false,healthy:false,state:"stopped",pid:null,toolCount:null,build:null}); Object.assign(tunnel,{managed:false,ready:false,reachable:false,state:"stopped",pid:null}); }
  if (scenario === "starting") { Object.assign(mcp,{managed:true,healthy:false,state:"starting",pid:null,toolCount:null}); Object.assign(tunnel,{ready:false,state:"starting"}); }
  if (scenario === "stopping") { mcp.state="stopping"; tunnel.state="stopping"; }
  if (scenario === "auth-error") { tunnel.authError={line:"HTTP 401 · fixture credential rejected"}; tunnel.cloudState="error"; }
  if (scenario === "network-error") { tunnel.metaError={line:"poll failed; backing off: unexpected EOF"}; tunnel.cloudState="error"; }
  if (scenario === "stale") { tunnel.cloudState="stale"; tunnel.lastPollSuccessAt=Date.now()-180000; }
  if (scenario === "crashed") { Object.assign(mcp,{managed:false,healthy:false,state:"error",pid:null}); Object.assign(tunnel,{managed:false,ready:false,reachable:false,state:"error",pid:null}); }
  if (scenario === "port-conflict") { Object.assign(mcp,{managed:false,healthy:false,state:"stopped",pid:null,portOccupiedByUnknown:true}); }
  if (scenario === "unconfigured") { config.setupDone=false; config.hasApiKey=false; config.tunnelId=""; config.workspacePath=""; Object.assign(mcp,{managed:false,healthy:false,state:"stopped",pid:null,toolCount:null}); Object.assign(tunnel,{managed:false,ready:false,reachable:false,state:"stopped",pid:null}); }
  if (scenario === "long-path") { config.workspacePath="D:\\工程与研究\\" + "very-long-workspace-segment\\".repeat(8); config.tunnelId="tunnel_"+"long-identifier-".repeat(6); }
  return { accountId:id,at:Date.now(),config,mcp,tunnel,busy:["starting","stopping"].includes(scenario),paths:{codeRoot:path.resolve(__dirname,"../.."),runtimeDir:fixtureDir} };
}
function accountSnapshot() { return {selectedId:selected,maxAccounts:16,securityBoundary:"隔离预览：测试数据，不是系统安全沙箱。",accounts:accounts.map(a=>{const s=snapshot(a.id);return {...a,config:s.config,dataDir:fixtureDir,mcp:{owned:s.mcp.managed},tunnel:{owned:s.tunnel.managed}}})}; }
function send(channel,payload) { if(win && !win.isDestroyed()) win.webContents.send(channel,clone(payload)); }
function publish() { send("status",snapshot()); send("accounts:changed",accountSnapshot()); }
function addLog(name,line,id=selected) { const lines=logsById.get(id)[name]; lines.push(line); if(lines.length>3000)lines.splice(0,lines.length-3000); send("log",[{accountId:id,name,line}]); }
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function handle(channel, payload = {}) {
  payload = payload || {};
  const id = payload._accountId || selected;
  if (!configById.has(id)) throw new Error("Unknown fixture account");
  const cfg=configById.get(id), catalog=catalogById.get(id);
  const safePayload={...payload}; if ("apiKey" in safePayload) safePayload.apiKey="[fixture-redacted]";
  if ("wavBase64" in safePayload) safePayload.wavBase64="[fixture-audio omitted]";
  calls.push({channel,accountId:id,payload:safePayload,at:Date.now()});
  if (failNext === channel) { failNext=null; throw new Error("预览注入的操作失败：请检查配置后重试。"); }
  switch(channel) {
    case "accounts:list": return accountSnapshot();
    case "accounts:select": { if(!accounts.some(a=>a.id===payload.id))throw new Error("账户不存在"); selected=payload.id; return accountSnapshot(); }
    case "accounts:create": { if(!payload.name?.trim())throw new Error("名称不能为空");const aid=crypto.randomBytes(16).toString("hex");accounts.push({id:aid,name:payload.name.trim()});configById.set(aid,{...baseConfig(accounts.length),hasApiKey:false,setupDone:false,workspacePath:"",tunnelId:""});catalogById.set(aid,initialCatalog());logsById.set(aid,{mcp:[],tunnel:[],launcher:[]});seedPreferences(aid,{empty:true});return {id:aid}; }
    case "accounts:rename": { const a=accounts.find(a=>a.id===payload.id);if(!a||!payload.name?.trim())throw new Error("名称不能为空");a.name=payload.name.trim();return accountSnapshot(); }
    case "accounts:remove": {
      const index = accounts.findIndex(a => a.id === payload.id);
      if (index < 0 || accounts.length === 1) throw new Error("无法移除此账户");
      accounts.splice(index, 1);
      for (const map of [configById, catalogById, logsById, conversationsById, customAudioById]) map.delete(payload.id);
      if (selected === payload.id) selected = accounts[0].id;
      return accountSnapshot();
    }
    case "accounts:inspectImport": return inspectImport(id);
    case "accounts:import": {
      const review = importReviews.get(payload.token); importReviews.delete(payload.token);
      if (!review || review.accountId !== id || Date.now() - review.createdAt > 600000) throw new Error("导入预览已失效，请重新选择。");
      const row = review.result.accounts.find(a => a.sourceId === payload.sourceId);
      if (!row) throw new Error("请选择预览中的账户。");
      const existing = accounts.find(a => a.id === row.existingAccountId);
      if (existing) return { accountId: existing.id, reused: true, profileFiles: 0 };
      const aid = crypto.randomBytes(16).toString("hex");
      accounts.push({ id: aid, name: row.name });
      configById.set(aid, { ...baseConfig(accounts.length), workspacePath: row.workspacePath, tunnelId: row.tunnelId,
        mcpPort: row.mcpPort, adminPort: row.adminPort, tunnelPort: row.tunnelPort,
        notificationSound: row.soundChoice, notificationVolume: row.soundVolume, autoStart: false });
      catalogById.set(aid, initialCatalog()); logsById.set(aid, initialLogs(aid));
      seedPreferences(aid, { empty: !row.hasConversationNames, custom: row.hasCustomAudio });
      return { accountId: aid, reused: false, profileFiles: row.skillFiles };
    }
    case "app:info": if (holdInitialization) await initialization; return {name:"ChatGPT Web Harness Isolated",version:pkg.version,isPreview:true,isolated:true,multiAccount:true,isPackaged:false,encryptionAvailable:true,legacyKeys:[],legacyTunnelId:"",legacyWorkspace:"",runtimeDir:fixtureDir,accountDataDir:path.join(fixtureDir,"accounts",id)};
    case "config:get": return snapshot(id).config;
    case "config:setIdleReminder":
      if (![0, 5, 10, 15].includes(payload.minutes)) throw new Error("请选择有效的提醒时间。");
      cfg.idleReminderMinutes = payload.minutes; send("accounts:changed", accountSnapshot()); return clone(cfg);
    case "notification:sounds": return { choices: clone(soundChoices), selected: cfg.notificationSound, volume: cfg.notificationVolume, hasCustom: customAudioById.get(id) === true };
    case "notification:selectSound":
      if (!soundChoices.some(s => s.id === payload.id) && payload.id !== "custom") throw new Error("未知提示音");
      if (payload.id === "custom" && !customAudioById.get(id)) throw new Error("请先导入自定义音频。");
      cfg.notificationSound = payload.id; send("accounts:changed", accountSnapshot()); return { selected: payload.id };
    case "notification:setVolume":
      if (!Number.isInteger(payload.volume) || payload.volume < 0 || payload.volume > 100) throw new Error("通知音量必须为 0–100");
      cfg.notificationVolume = payload.volume; send("accounts:changed", accountSnapshot()); return { volume: payload.volume };
    case "notification:preview":
      if (!soundChoices.some(s => s.id === payload.id) && !(payload.id === "custom" && customAudioById.get(id))) throw new Error("提示音不可用");
      return { played: true, simulated: true }; // Never invoke an OS audio player.
    case "notification:importAudio": {
      if (typeof payload.wavBase64 !== "string" || !payload.wavBase64 || payload.wavBase64.length > 700000) throw new Error("无效的预览音频");
      customAudioById.set(id, true); cfg.notificationSound = "custom";
      send("accounts:changed", accountSnapshot()); return { selected: "custom", simulated: true };
    }
    case "conversations:list": return conversationsById.get(id).map(conversationView);
    case "conversations:rename": {
      const row = conversationsById.get(id).find(r => r.id === payload.id);
      if (!row) throw new Error("未找到这个账号中的会话记录。");
      if (typeof payload.alias !== "string" || [...payload.alias.trim()].length > 40) throw new Error("备注名称需在 40 字以内。");
      row.alias = payload.alias.trim(); return conversationView(row);
    }
    case "conversations:pin": {
      const row = conversationsById.get(id).find(r => r.id === payload.id);
      if (!row) throw new Error("未找到这个账号中的会话记录。");
      row.pinned = payload.enabled === true; return conversationView(row);
    }
    case "conversations:clearInactive": {
      const before = conversationsById.get(id), after = before.filter(r => r.pinned);
      conversationsById.set(id, after); return { removed: before.length - after.length, remaining: after.length };
    }
    case "status:get": return snapshot(id);
    case "logs:get": return clone(logsById.get(id));
    case "logs:clear": logsById.get(id)[payload.name]=[]; return {};
    case "skills:catalog": await wait(50); return clone(catalog);
    case "config:save": {
      const ports=[payload.mcpPort,payload.adminPort,payload.tunnelPort];
      if(ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||new Set(ports).size!==3)throw new Error("端口必须为 1024–65535 的不同整数。");
      for(const key of Object.keys(cfg)) if(key in payload && key!=="hasApiKey")cfg[key]=payload[key];
      if(payload.apiKey)cfg.hasApiKey=true; publish(); return clone(cfg);
    }
    case "setup:run": send("setup:progress",{accountId:id,stage:"doctor-line",message:"隔离预览：模拟配置校验，不连接外部服务。"}); await wait(250); cfg.setupDone=true; return {ok:true,doctor:"Fixture validation complete"};
    case "skills:setEnabled": { const row=catalog[payload.source]?.find(s=>s.id===payload.id);if(!row)throw new Error("Skill不存在");row.enabled=payload.enabled; return {catalog:clone(catalog)}; }
    case "skills:setComputerUse": catalog.computerUse.enabled=payload.enabled;return {catalog:clone(catalog)};
    case "skills:setBrowserUse": catalog.browserUse.enabled=payload.enabled;return {catalog:clone(catalog)};
    case "skills:save": catalog.external=payload.registrations.map(s=>({...s,description:"已保存的外部 Skill（预览）"}));catalog.computerUse.enabled=payload.computerUseEnabled;catalog.browserUse.enabled=payload.browserUseEnabled;return {catalog:clone(catalog)};
    case "skills:pickFile": return "D:\\Preview\\new-skill\\SKILL.md";
    case "skills:pickFolder": case "skills:pickZip": return "preview-source-token";
    case "skills:inspectSource": return {source:payload.source,root:"D:\\Preview\\downloaded-skill",skillPath:"D:\\Preview\\downloaded-skill\\SKILL.md",id:"new-workflow",description:"隔离预览的安装确认流程，不会写入真实 Skill 目录。",version:"1.0.0",warnings:["预览模式：不会运行依赖安装。"],aliases:["workflow"]};
    case "skills:discardSource": return {};
    case "skills:install": catalog.installed.push({id:payload.id,enabled:true,version:"1.0.0",description:"从预览安装流程添加",path:"D:\\Preview\\skills\\"+payload.id+"\\SKILL.md"});return {catalog:clone(catalog),result:{id:payload.id}};
    case "skills:uninstall": catalog.installed=catalog.installed.filter(s=>s.id!==payload.id);return {catalog:clone(catalog)};
    case "profiles:reset": catalog.external=[];return {catalog:clone(catalog)};
    case "dialog:pickFolder": return "D:\\Preview\\selected-workspace";
    case "relay:companionInfo": return {extensionAvailable:true,extensionDir:"D:\\Preview\\browser-companion",companionApi:"http://127.0.0.1:0/preview-only"};
    case "relay:copyCompanionToken": throw new Error("隔离预览不提供或复制真实凭据。");
    case "app:uninstall": return {canceled:true};
    case "services:stopExternal": throw new Error("隔离预览禁止接管外部进程。");
    case "services:startAll": case "mcp:start": case "mcp:restart": case "tunnel:start": scenario="starting";publish();await wait(400);scenario="online";publish();addLog("launcher",`${time()} [preview] Start action simulated; no process created`);return {};
    case "services:stopAll": case "mcp:stop": case "tunnel:stop": scenario="stopping";publish();await wait(400);scenario="stopped";publish();addLog("launcher",`${time()} [preview] Stop action simulated; no process terminated`);return {};
    case "clipboard:copy": global.__previewClipboard=String(payload.text || "");send("notice",{accountId:id,message:"隔离预览已记录复制内容；未改写系统剪贴板。",level:"info"});return {};
    case "shell:openExternal": case "shell:openLogs": case "shell:openRuntime": case "logs:openFile": case "relay:openCompanionFolder": send("notice",{accountId:id,message:"隔离预览已记录打开请求；未访问真实文件或外部网页。",level:"info"});return {};
    default: throw new Error("Preview IPC is not implemented: " + channel);
  }
}
const preloadSource=fs.readFileSync(path.resolve(__dirname,"../src/preload.js"),"utf8");
for(const match of preloadSource.matchAll(/invoke\("([^"]+)"\)/g)) ipcMain.handle(match[1],async(event,payload)=>{
  if(!win || event.sender!==win.webContents)return {ok:false,error:"Untrusted preview sender"};
  const accountId=payload?._accountId || selected;
  try { return {ok:true,result:await handle(match[1],payload),accountId}; } catch(err) { return {ok:false,error:err.message,accountId}; }
});
global.__uiPreview={
  releaseInitialization(){releaseInitialization();},
  scenario(name){scenario=name;publish();return snapshot();},
  fail(channel){failNext=channel;},
  append(name,lines,id=selected){for(const line of lines)addLog(name,line,id);},
  calls(){return clone(calls);},
  snapshot,accountSnapshot,
  emptySkills(){catalogById.set(selected,{...initialCatalog(),installed:[],external:[],project:[],builtin:[]});},
  longAccount(){accounts[0].name="非常长的工作账户名称 · International Engineering & Research Team";send("accounts:changed",accountSnapshot());},
  fixtureDir,
  fixturePreferences(id=selected){return {sounds:{selected:configById.get(id).notificationSound,volume:configById.get(id).notificationVolume,hasCustom:customAudioById.get(id)},conversations:conversationsById.get(id).map(conversationView)};}
};

// Opt-in renderer evidence. All interaction remains inside this fixture window.
async function captureAura() {
  fs.mkdirSync(captureDir, { recursive: true });
  const captured = [];
  const sourceFiles = ["renderer/v3/aura/index.html", "renderer/v3/aura/app.js", "renderer/v3/aura/aura.css",
    "renderer/v3/core/core.js", "src/preload.js", "scripts/ui-preview.cjs"];
  const sourceHashes = () => sourceFiles.map(file => ({ file: "desktop/" + file,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(path.resolve(__dirname, "..", file))).digest("hex") }));
  const before = sourceHashes();
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const waitFor = async (code, label, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(code)) return;
      await wait(100);
    }
    throw new Error("Preview capture timed out: " + label);
  };
  const settle = async () => {
    await evaluate("document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))");
    await wait(350);
  };
  const click = async selector => {
    await evaluate("(() => { const el=document.querySelector(" + JSON.stringify(selector) + "); if(!el)throw new Error('Missing capture target'); if(el.disabled)throw new Error('Disabled capture target'); el.click(); })()");
    await settle();
  };
  const closeDialogs = () => evaluate("document.querySelectorAll('dialog[open]').forEach(d=>d.close());document.querySelectorAll('[popover]').forEach(p=>{if(p.matches(':popover-open'))p.hidePopover();})");
  const navigate = async name => {
    // Use the same navigation controls and route state as the production Aura UI.
    await click('#nav [data-view="' + name + '"]');
    await waitFor("document.body.dataset.view === " + JSON.stringify(name) +
      " && !document.querySelector(" + JSON.stringify("#view-" + name) + ").hidden" +
      " && !document.querySelector(" + JSON.stringify("#view-" + name) + ").classList.contains('entering')", name + " route");
    // Hidden capture windows do not run the focus-triggered catalog refresh.
    if (name === "skills") await evaluate("window.__harness.refreshSkills()");
    const scrollTarget = { skills: "#sk-scroll", logs: "#log-view", settings: "#setup-form" }[name];
    if (scrollTarget) await evaluate("document.querySelector(" + JSON.stringify(scrollTarget) + ").scrollTo({top:0,behavior:'instant'})");
    await settle();
  };
  const chapter = async id => {
    await evaluate("(() => { window.__harness.setView('settings'); const form=document.querySelector('#setup-form'), target=document.querySelector(" + JSON.stringify("#ch-" + id) + "); if(!form||!target)throw new Error('Missing settings chapter'); form.scrollTo({top:form.scrollTop+target.getBoundingClientRect().top-form.getBoundingClientRect().top-4,behavior:'instant'}); })()");
    await settle();
  };
  const shot = async name => {
    await settle();
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error("Empty preview screenshot: " + name);
    const file = path.join(captureDir, name + ".png");
    fs.writeFileSync(file, image.toPNG());
    captured.push({ name, file, pixelSize: image.getSize(), viewport: await evaluate("({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme})") });
  };
  const openImport = async () => {
    if (!await evaluate("document.querySelector('#account-btn').getAttribute('aria-expanded')==='true'")) await click("#account-btn");
    await click("#btn-account-import");
    await waitFor("document.querySelector('#dlg-account-import').open && document.querySelector('#import-choice').options.length===3", "account import");
    await settle();
  };
  try {
    await waitFor("Boolean(window.__harness && !document.body.classList.contains('booting'))", "Aura boot", 20000);
    win.webContents.setZoomFactor(1);
    for (const theme of ["dark", "light"]) {
      await closeDialogs(); win.setContentSize(1440, 900); await settle();
      await evaluate("window.__harness.applyTheme(" + JSON.stringify(theme) + ")");
      for (const view of ["workspace", "skills", "logs", "settings"]) {
        await navigate(view);
        await shot(theme + "-1440x900-" + (view === "settings" ? "settings-top" : view));
      }
      await chapter("reminder");
      await waitFor("Boolean(document.querySelector('#sound-choice-trigger'))", "sound picker");
      await shot(theme + "-1440x900-reminder");
      await click("#sound-choice-trigger");
      await waitFor("document.querySelector('#sound-choice-trigger').getAttribute('aria-expanded')==='true'", "sound options");
      await shot(theme + "-1440x900-sound-options");
      await click("#sound-choice-trigger");
      await chapter("conversations"); await click("#btn-manage-conversations");
      await waitFor("document.querySelector('#dlg-conversations').open && document.querySelectorAll('#conversation-label-list input').length===3", "conversation list");
      await shot(theme + "-1440x900-conversations"); await closeDialogs();
      await chapter("maintenance"); await shot(theme + "-1440x900-maintenance");
      await click("#data-details summary"); await shot(theme + "-1440x900-data-details");
      await click("#data-details summary");
      await openImport(); await shot(theme + "-1440x900-import");
      await click("#import-choice-trigger"); await shot(theme + "-1440x900-import-options");
      await click("#import-choice-trigger");
      win.setContentSize(900, 600); await settle(); await shot(theme + "-900x600-import");
      await click("#import-choice-trigger"); await shot(theme + "-900x600-import-options");
      await click("#import-choice-trigger"); await click("#import-details summary");
      await shot(theme + "-900x600-import-details");
    }
    const after = sourceHashes();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Renderer sources changed during capture; repeat on the settled source.");
    const result = { status: "CAPTURED", renderer: rendererFile, scenario, fixtureDir, sources: after, screenshots: captured,
      servicesStarted: false, realConfigurationRead: false, audioPlayed: false,
      note: "Actual Aura + production preload with in-memory IPC; screenshots require visual inspection." };
    fs.writeFileSync(path.join(captureDir, "capture-result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log("PREVIEW_CAPTURED " + JSON.stringify({ output: captureDir, scenario, screenshots: captured.length }));
  } catch (error) {
    fs.writeFileSync(path.join(captureDir, "capture-result.json"), JSON.stringify({ status: "FAILED", error: error.stack || String(error), screenshots: captured, sources: before }, null, 2) + "\n");
    throw error;
  }
}

app.whenReady().then(async()=>{
  // Every preview request is local; no HTTP/HTTPS network is permitted.
  session.defaultSession.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},(_details,callback)=>callback({cancel:true}));
  win=new BrowserWindow({width:1440,height:900,useContentSize:true,show:!test,backgroundColor:"#101318",title:"Web Harness — 隔离设计预览",webPreferences:{preload:path.resolve(__dirname,"../src/preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:test}});
  win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
  win.webContents.on("will-navigate",e=>e.preventDefault());
  const names={waiting:"等待云端确认",online:"已连接",stopped:"未启动",starting:"启动中",stopping:"停止中","auth-error":"凭据失败","network-error":"网络失败",stale:"轮询过期",crashed:"异常退出","port-conflict":"端口冲突",unconfigured:"未配置","long-path":"长路径"};
  if(!test) Menu.setApplicationMenu(Menu.buildFromTemplate([{label:"预览场景（仅测试数据）",submenu:Object.entries(names).map(([name,label])=>({label,click:()=>global.__uiPreview.scenario(name)}))},{label:"窗口",submenu:[{role:"reload"},{role:"toggleDevTools"},{role:"close"}]}])); else Menu.setApplicationMenu(null);
  await win.loadFile(rendererFile);
  if(!test)win.show();
  if(!test) setInterval(()=>{sequence++;addLog("mcp",`${time()} [preview] Live fixture event ${sequence} · no production activity`);},4000).unref();
  console.log("PREVIEW_READY " + JSON.stringify({fixtureDir,renderer:rendererFile,scenario,servicesStarted:false,realConfigurationRead:false}));
  if (captureDir) { releaseInitialization(); await captureAura(); app.quit(); }
}).catch(error => { console.error(error.stack || error); process.exitCode = 1; app.quit(); });
app.on("window-all-closed",()=>app.quit());
