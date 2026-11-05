"use strict";
// Real main/preload/Aura, disposable profiles and actual local MCP. Doctor output
// alone is replayed to make failure presentation and retry deterministic.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net"), Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron"), { app } = electron;
const desktop = path.resolve(__dirname, "..");
const artifacts = path.resolve(desktop, "../.validation/account-setup-ui");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifacts, "run-")), workspace = path.join(fixture, "workspace");
fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "keep.txt"), "workspace retained");
app.setPath("appData", fixture); app.setPath("userData", path.join(fixture, "isolated"));
app.getVersion = () => require("../package.json").version;
app.commandLine.appendSwitch("force-device-scale-factor", "1");
let resolveWindow, win, client, doctorCalls = 0;
const ready = new Promise(resolve => { resolveWindow = resolve; });
const checks = [], screenshots = [], errors = [];
class Window extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    this.webContents.once("did-finish-load", () => resolveWindow(this));
    this.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
  }
}
class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent?.filename.startsWith(desktop)) return { ...electron, BrowserWindow: Window, Tray,
    dialog: { ...electron.dialog, showErrorBox: (title, message) => errors.push(`${title}: ${message}`) } };
  return load.call(this, request, parent, isMain);
};
const { Services } = require("../src/services");
Services.prototype.downloadTunnelClient = async () => { throw new Error("Fixture forbids downloads"); };
Services.prototype.runDoctor = async function(_cfg, key, progress) {
  assert.ok(this.mcp.isAlive(), "real local MCP must be running during replay");
  doctorCalls++;
  const output = doctorCalls === 1
    ? `CHECK mcp_server_reachable FAIL ECONNREFUSED fixture local refusal apiKey=${key}\nCHECK oauth_metadata FAIL local metadata unavailable\nCHECK optional_web SKIP optional integration absent`
    : "CHECK mcp_server_reachable PASS replay healthy\nCHECK optional_web SKIP optional integration absent";
  progress(output); return { ok: doctorCalls > 1, output };
};
require("../src/main");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = expression => win.webContents.executeJavaScript(expression);
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function wait(expression, label, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await js(expression)) return; await pause(80); }
  throw new Error(`Timeout: ${label}`);
}
function pass(label) { checks.push(label); console.log(`PASS ${label}`); }
async function ports() {
  const servers = [];
  try {
    for (let i = 0; i < 3; i++) { const server = net.createServer(); servers.push(server); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
    return servers.map(server => server.address().port);
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
async function layout(dialog, buttons, theme) {
  await js(`window.__harness.applyTheme(${JSON.stringify(theme)})`); await pause(250);
  const result = await js(`(() => {
    const d = document.querySelector(${JSON.stringify(dialog)});
    return { overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth || d.scrollWidth > d.clientWidth + 1,
      clipped: ${JSON.stringify(buttons)}.filter(s => { const r = document.querySelector(s).getBoundingClientRect(); return r.width < 1 || r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight; }) };
  })()`);
  assert.equal(result.overflow, false, `${dialog} ${theme} horizontal overflow`); assert.deepEqual(result.clipped, []);
  const file = path.join(fixture, `${dialog.slice(1)}-${theme}-1120x760.png`);
  fs.writeFileSync(file, (await win.capturePage()).toPNG()); screenshots.push(file);
}
async function removeDialog() { await click("#account-btn"); await click("#btn-account-remove"); await wait("document.querySelector('#dlg-confirm').open", "remove confirm"); }
async function confirmRemove() {
  await removeDialog(); await click("#confirm-ok"); await wait("document.querySelector('#dlg-info').open", "backup confirmation");
  const text = await js("document.querySelector('#info-kv').textContent");
  const backup = await js("document.querySelector('#info-kv dd.mono').textContent");
  assert.ok(path.resolve(backup).startsWith(path.resolve(fixture) + path.sep)); assert.ok(fs.existsSync(path.join(backup, "config.json"))); assert.match(text, /文件已保留/);
  return backup;
}
async function stop() { if (client) { try { await client.close(); } catch {} client = null; } if (win && !win.isDestroyed()) { try { await js("window.__harness.core.act.stopAll()"); } catch {} } }
const deadline = setTimeout(async () => { console.error("FAIL hard deadline"); await stop(); app.exit(1); }, 180000);
(async () => {
  win = await ready;
  await wait("window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')", "production ready");
  win.setSize(1120, 760);
  assert.match(win.webContents.getURL(), /aura\/index.html\?desktop=1$/);
  const values = { workspacePath: workspace, tunnelId: "tunnel_11111111111111111111111111111111", apiKey: "sk-fixture-account-ui-secret", autoStart: false };
  const p = await ports(); Object.assign(values, { mcpPort: p[0], adminPort: p[1], tunnelPort: p[2] });
  await click('#nav [data-view="settings"]');
  await wait("!!document.querySelector('#f-apiKey')", "settings inputs");
  await js(`(() => { for (const [key,value] of Object.entries(${JSON.stringify(values)})) { const i=document.querySelector('#f-'+key); if (i && i.tagName === 'INPUT') { i.value=value; i.dispatchEvent(new Event('input',{bubbles:true})); } } })()`);
  await click("#btn-run-setup");
  await wait("document.querySelector('#setup-title').textContent === '本机 MCP 未就绪' && !document.querySelector('#setup-done').disabled", "replayed failure");
  const diagnostic = await js("({stage:document.querySelector('#setup-stage').textContent, checks:document.querySelector('#setup-checks').textContent, next:document.querySelector('#setup-next').textContent, collapsed:!document.querySelector('#setup-details').open})");
  assert.match(diagnostic.stage, /检查本机服务与连接配置/);
  assert.doesNotMatch(diagnostic.stage, /LOCAL_MCP_UNREACHABLE/);
  assert.match(diagnostic.checks, /本机 MCP 连接：ECONNREFUSED fixture local refusal/); assert.doesNotMatch(diagnostic.checks, /optional_web/);
  assert.match(diagnostic.next, /MCP.*端口/); assert.equal(diagnostic.collapsed, true);
  await click("#setup-copy"); await pause(100);
  const copied = electron.clipboard.readText(); assert.match(copied, /ECONNREFUSED fixture local refusal/); assert.match(copied, /LOCAL_MCP_UNREACHABLE/); assert.doesNotMatch(copied, /sk-fixture-account-ui-secret/);
  for (const theme of ["light", "dark"]) await layout("#dlg-setup", ["#setup-copy", "#setup-retry", "#setup-done"], theme);
  await click("#setup-details summary"); assert.equal(await js("document.querySelector('#setup-details').open"), true);
  await click("#setup-retry"); await wait("document.querySelector('#setup-title').textContent === '初始化完成' && !document.querySelector('#setup-done').disabled", "replay retry");
  assert.equal(doctorCalls, 2); await click("#setup-done");
  pass("actual MCP setup lease + replayed local-refusal diagnostic, redacted copy, collapsed details, optional SKIP and successful replay retry");
  await js("window.__harness.core.act.startMcp()");
  await wait("window.__harness.core.snapshot().account.mcp.managed", "managed MCP");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  client = new Client({ name: "account-removal-local-acceptance", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${p[0]}/mcp`)));
  const listed = await client.callTool({ name: "list_directory", arguments: { path: workspace } });
  assert.notEqual(listed.isError, true);
  await wait("window.__harness.core.snapshot().activity.length > 0", "actual old-account activity");
  await client.close(); client = null;
  await click("#account-btn"); await click("#btn-account-remove"); await pause(150);
  assert.equal(await js("document.querySelector('#dlg-confirm').open"), false);
  assert.match(await js("document.querySelector('#toast-text').textContent"), /请先停止此账户的 MCP 和隧道/);
  await js("window.__harness.core.act.stopAll()"); await wait("!window.__harness.core.snapshot().account.mcp.managed", "stopped MCP");
  pass("running owned MCP refuses deletion with stop-first guidance and no confirmation");
  const created = await js("window.__harness.core.act.createAccount('保留账户')");
  await wait("document.querySelector('#account-name').textContent === '保留账户'", "new selection");
  const survivor = await js("window.__harness.core.snapshot().selectedId");
  const info = await js("window.launcher.appInfo()");
  const survivorFile = info.result.configPath, survivorBytes = fs.readFileSync(survivorFile, "utf8");
  await js("window.__harness.core.act.selectAccount('default')"); await wait("window.__harness.core.snapshot().selectedId === 'default'", "default selected");
  await wait("window.__harness.core.snapshot().activity.length > 0", "old activity restored before deletion");
  await removeDialog(); assert.match(await js("document.querySelector('#confirm-desc').textContent"), /默认/);
  await click('#dlg-confirm [value="cancel"]'); await pause(100);
  assert.equal(await js("window.__harness.core.snapshot().selectedId"), "default");
  const backup = await confirmRemove();
  assert.equal(fs.readFileSync(survivorFile, "utf8"), survivorBytes); assert.equal(fs.readFileSync(path.join(workspace,"keep.txt"),"utf8"),"workspace retained");
  await wait(`window.__harness.core.snapshot().selectedId === ${JSON.stringify(survivor)}`, "survivor selected");
  assert.equal(await js("window.__harness.core.snapshot().activity.length"), 0);
  for (const theme of ["light", "dark"]) await layout("#dlg-info", ["#btn-copy-info", '#dlg-info [value="ok"]'], theme);
  await click('#dlg-info [value="ok"]');
  pass("default deletion cancellation preserves identity; confirmed removal retains workspace and survivor bytes, shows actual backup, clears prior activity");
  await confirmRemove();
  const state = await js("window.__harness.core.snapshot()"); assert.notEqual(state.selectedId, survivor); assert.notEqual(state.selectedId,"default"); assert.equal(state.accounts.length,1); assert.equal(state.activity.length,0);
  const cfg = (await js("window.launcher.getConfig()")).result;
  assert.equal(cfg.hasApiKey,false); assert.equal(cfg.autoStart,false); assert.equal(cfg.setupDone,false); assert.equal(cfg.tunnelId,"");
  assert.equal(state.account.mcp.managed,false); assert.equal(state.account.tunnel.managed,false);
  pass("last-account UI removal selects fresh blank keyless account with no autostart or prior activity");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(fixture,"result.json"),JSON.stringify({ok:true,checks,screenshots,doctorEvidence:"deterministic output replay; actual local MCP boot and setup lease",backup},null,2));
  console.log(`RESULT ${fixture}`); clearTimeout(deadline); await stop(); app.quit(); setTimeout(()=>app.exit(0),1200);
})().catch(async error => { console.error(error.stack); const dom = win ? await js("document.body.innerText").catch(()=>"") : ""; fs.writeFileSync(path.join(fixture,"failure.json"),JSON.stringify({error:error.stack,checks,errors,screenshots,dom},null,2)); clearTimeout(deadline); await stop(); app.exit(1); });
