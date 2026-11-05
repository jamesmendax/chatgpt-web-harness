"use strict";
// Production main + sandboxed preload + Aura. All writes and managed processes
// belong to a disposable fixture; no Tunnel, cloud account, or real user data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const electron = require("electron");
const { app } = electron;
const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const artifacts = path.join(repo, ".validation", "aura-ui");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifacts, "run-"));
const workspace = path.join(fixture, "workspace");
const skillSource = path.join(fixture, "review-skill");
fs.mkdirSync(workspace);
fs.mkdirSync(skillSource);
fs.writeFileSync(path.join(workspace, "fixture.txt"), "Aura local integration fixture\n");
fs.writeFileSync(path.join(skillSource, "SKILL.md"), "---\nname: aura-fixture\ndescription: Local Aura integration fixture.\n---\n\n# Aura fixture\nRead fixture files only.\n");
app.setPath("appData", fixture);
app.setPath("userData", path.join(fixture, "chatgpt-web-harness-isolated"));
app.getVersion = () => require("../package.json").version;
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("use-angle", "d3d11");
// The fixture MCP reports in-flight calls every 300 ms instead of every minute, so one shows up quickly.
process.env.MCP_RUNNING_REPORT_MS = "300";
const uiErrors = [];
const checks = [];
const screenshots = [];
let windowResolve;
const windowReady = new Promise(resolve => { windowResolve = resolve; });
class FixtureWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    this.webContents.on("console-message", (_event, level, message) => { if (level >= 3) uiErrors.push(message); });
    this.webContents.on("did-fail-load", (_event, code, description) => uiErrors.push(`${code}: ${description}`));
    this.webContents.once("did-finish-load", () => windowResolve(this));
  }
}
class FixtureTray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
const notifications = [];
let notificationSounds = 0;
const copiedTexts = [];
let appInfoGate = null;
const fixtureIpcMain = new Proxy(electron.ipcMain, { get(target, property) {
  if (property === "handle") return (channel, handler) => target.handle(channel, channel === "app:info" ? async (...args) => {
    const result = await handler(...args);
    const gate = appInfoGate;
    if (gate) { gate.entered(); await gate.released; }
    return result;
  } : handler);
  const value = target[property];
  return typeof value === "function" ? value.bind(target) : value;
} });
class FixtureNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; }
  show() { notifications.push(this.options); this.emit("show"); }
}
// Keep a handle on main's idle watcher so the test can advance its clock instead of waiting minutes.
const idleModule = require("../src/idle-watch");
let idleWatch = null;
const RealIdleWatch = idleModule.IdleWatch;
idleModule.IdleWatch = class extends RealIdleWatch { constructor(options) { super(options); idleWatch = this; } };
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "./notification-sound" && parent?.filename === path.join(desktop, "src", "main.js")) {
    return { createNotificationSound: () => ({ play: () => { notificationSounds++; return Promise.resolve(true); }, dispose() {} }) };
  }
  if (request === "electron" && parent && parent.filename.startsWith(desktop)) {
    return { ...electron, BrowserWindow: FixtureWindow, Tray: FixtureTray, Notification: FixtureNotification, ipcMain: fixtureIpcMain,
      clipboard: { ...electron.clipboard, writeText: text => copiedTexts.push(text) },
      shell: { ...electron.shell, beep: () => { throw new Error("Default system beep must not be used for reminders"); } },
      dialog: { ...electron.dialog,
        showErrorBox: (title, message) => uiErrors.push(`${title}: ${message}`),
        showOpenDialog: async () => ({ canceled: false, filePaths: [skillSource] }),
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require("../src/main.js");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
let client;
const js = expression => win.webContents.executeJavaScript(expression);
function pass(name) { checks.push(name); console.log(`PASS Aura ${name}`); }
async function waitFor(expression, label, budget = 25000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) { if (await js(expression)) return; await pause(80); }
  if (label === "saved real config") {
    try {
      const diag = await js(`(async () => ({
        selected: window.__harness.core.snapshot().selectedId,
        currentPort: window.__harness.core.snapshot().account.config.mcpPort,
        inputPort: document.querySelector('#f-mcpPort')?.value,
        errorText: document.querySelector('#form-status')?.textContent?.slice(0, 180),
        saveButtonDisabled: document.querySelector('#btn-save-only')?.disabled,
        saveButtonHidden: document.querySelector('#btn-save-only')?.hidden,
        diskPort: (await window.launcher.getConfig()).result?.mcpPort
      }))()`);
      console.error("Aura synthetic settings-save diagnosis:", JSON.stringify(diag));
    } catch (diagnosticError) { console.error("Aura synthetic settings-save diagnosis unavailable", String(diagnosticError)); }
  }
  throw new Error(`Aura UI timeout: ${label}`);
}
async function click(selector) { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); }
async function navigate(view) {
  await click(`#nav [data-view="${view}"]`);
  await waitFor(`document.body.dataset.view === ${JSON.stringify(view)} && !document.getElementById('view-${view}').hidden`, `${view} selected`);
  await pause(400);
}
// Native resize and the view's entrance animation may outlive the click's fixed delay.
async function waitLayout(size, view) {
  const deadline = Date.now() + 8000;
  let last = "", stable = 0, state;
  while (Date.now() < deadline) {
    const outer = win.getSize(), content = win.getContentSize();
    state = await js(`(() => {
      const el = document.getElementById('view-${view}'), r = el.getBoundingClientRect();
      return { inner: [innerWidth, innerHeight], rect: [r.left, r.top, r.right, r.bottom],
        animations: el.getAnimations().filter(a => a.playState === 'running').map(a => ({name: a.animationName, state: a.playState})) };
    })()`);
    state.outer = outer; state.content = content;
    const key = JSON.stringify(state);
    stable = key === last ? stable + 1 : 0; last = key;
    if (outer[0] === size[0] && outer[1] === size[1] &&
        state.inner[0] === content[0] && state.inner[1] === content[1] &&
        state.animations.length === 0 && stable >= 3) return;
    await pause(40);
  }
  console.error("Aura layout stability timeout:", JSON.stringify({size, view, state}));
  await capture(`layout-timeout-${size.join("x")}-${view}`);
  throw new Error(`Aura layout did not settle: ${size} ${view}`);
}
async function capture(name) {
  const file = path.join(fixture, `${name}.png`);
  fs.writeFileSync(file, (await win.capturePage()).toPNG());
  screenshots.push(file);
}
async function reportClipped(size, view, layout, theme) {
  const details = await js(`(() => {
    const selectors = ['#nav', '#account-btn', '#btn-theme', '#view-${view}', '#btn-skills-refresh', '#btn-install-folder', '#btn-install-zip'];
    return {inner: [innerWidth, innerHeight], elements: Object.fromEntries(selectors.map(selector => {
      const el = document.querySelector(selector); if (!el) return [selector, null];
      const r = el.getBoundingClientRect();
      return [selector, {rect: {left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height},
        animations: el.getAnimations().map(a => ({name:a.animationName, state:a.playState, currentTime:a.currentTime}))}];
    }))};
  })()`);
  details.outer = win.getSize(); details.content = win.getContentSize(); details.layout = layout;
  const name = `clipped-${theme}-${size.join("x")}-${view}`;
  fs.writeFileSync(path.join(fixture, name + ".json"), JSON.stringify(details, null, 2));
  console.error("Aura clipped layout:", JSON.stringify(details));
  await capture(name);
}
async function freePorts() {
  const servers = [], ports = [];
  try {
    for (let i = 0; i < 3; i++) {
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      servers.push(server); ports.push(server.address().port);
    }
    return ports;
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
async function cleanup() {
  if (client) { try { await client.close(); } catch {} }
  if (win && !win.isDestroyed()) {
    // This instance owns only fixture services. Stop through the account scope,
    // then let main's normal before-quit path dispose its remaining timers.
    try { await js("window.__harness.core.act.stopAll()"); } catch {}
  }
}
const deadline = setTimeout(async () => { console.error("FAIL Aura UI hard deadline"); await cleanup(); app.exit(1); }, 180000);
(async () => {
  win = await windowReady;
  await waitFor("window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')", "real backend ready");
  assert.match(win.webContents.getURL(), /\/renderer\/v3\/aura\/index\.html\?desktop=1$/);
  assert.equal(await js("typeof window.launcher.getStatus"), "function");
  assert.equal(await js("document.querySelector('#proto').textContent.trim()"), "");
  const initial = await js("window.launcher.getConfig()");
  const info = await js("window.launcher.appInfo()");
  assert.equal(initial.ok, true); assert.equal(initial.result.hasApiKey, false);
  assert.equal(initial.result.setupDone, false); assert.equal(initial.result.autoStart, false);
  assert.ok(path.resolve(info.result.configPath).startsWith(path.resolve(fixture) + path.sep));
  assert.equal(info.result.version, require("../package.json").version);
  const defaultDataDir = path.join(fixture, "chatgpt-web-harness-isolated");
  assert.equal(path.resolve(info.result.accountDataDir), path.resolve(defaultDataDir));
  assert.equal(await js("window.__harness.core.snapshot().account.mcp.managed"), false);
  assert.equal(await js("window.__harness.core.snapshot().derived.cloudOnline"), false, "external listener must not imply this account connected");
  assert.equal(await js("document.querySelector('#btn-external').hidden && document.querySelector('#btn-external').disabled"), true);
  pass("default Aura entry uses real preload, fresh account, no automatic service start or simulated data");

  for (const size of [[1120, 760], [900, 600]]) {
    win.setSize(...size);
    for (const view of ["workspace", "skills", "logs", "settings"]) {
      await navigate(view);
      await waitLayout(size, view);
      const layout = await js(`(() => {
        const selectors = ['#nav', '#account-btn', '#view-${view}'];
        if ('${view}' === 'skills') selectors.push('#btn-install-folder', '#btn-install-zip');
        return { overflow: document.documentElement.scrollWidth > innerWidth, clipped: selectors.filter(selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return r.width < 1 || r.height < 1 || r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1;
        }) };
      })()`);
      assert.equal(layout.overflow, false, `${size} ${view} horizontal overflow`);
      if (layout.clipped.length) await reportClipped(size, view, layout, "day");
      assert.deepEqual(layout.clipped, [], `${size} ${view} clipped controls`);
      await capture(`${size[0]}x${size[1]}-${view}`);
    }
  }
  pass("all four pages render at default and minimum native window sizes without clipped navigation or install actions");
  const navigation = [];
  for (const size of [[1120,760],[900,600]]) {
    win.setSize(...size);
    const result = await require("./aura-navigation-assertions.cjs").assertAuraNavigation({
      js, click, pause,
      wheel: async (x,y,delta) => win.webContents.sendInputEvent({type:"mouseWheel",x,y,deltaX:0,deltaY:-delta,canScroll:true,hasPreciseScrollingDeltas:true}),
    });
    navigation.push({size,...result});
    await capture(`${size[0]}x${size[1]}-settings-wheel`);
  }
  fs.writeFileSync(path.join(fixture,"settings-navigation.json"),JSON.stringify(navigation,null,2));
  pass("settings marker remains fully painted and native wheel/navigation reversals stay synchronized at both window sizes");

  // Night mode: chosen in Settings, persisted in this profile, every page usable at both window sizes.
  win.setSize(1120, 760);
  await navigate("settings");
  await click('#theme-chips [data-value="dark"]');
  await waitFor("document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.themeChoice === 'dark'", "night selected");
  assert.equal(await js("localStorage.getItem('wh.aura.theme')"), "dark");
  const luminance = async selector => js(`(() => { const m = getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${"backgroundColor"}.match(/\\d+(\\.\\d+)?/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; })()`);
  await pause(700);
  assert.ok(await luminance("body") < 0.1, "night paper is dark");
  assert.ok(await js("(() => { const m = getComputedStyle(document.querySelector('.say-line')).color.match(/\\d+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.5; })()"), "night text is light");
  for (const size of [[1120, 760], [900, 600]]) {
    win.setSize(...size);
    for (const view of ["workspace", "skills", "logs", "settings"]) {
      await navigate(view);
      await waitLayout(size, view);
      const layout = await js(`(() => {
        const selectors = ['#nav', '#account-btn', '#btn-theme', '#view-${view}'];
        if ('${view}' === 'skills') selectors.push('#btn-skills-refresh', '#btn-install-folder', '#btn-install-zip');
        return { overflow: document.documentElement.scrollWidth > innerWidth, clipped: selectors.filter(selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return r.width < 1 || r.height < 1 || r.left < -1 || r.right > innerWidth + 1 || r.top < -1 || r.bottom > innerHeight + 1;
        }) };
      })()`);
      assert.equal(layout.overflow, false, `night ${size} ${view} horizontal overflow`);
      if (layout.clipped.length) await reportClipped(size, view, layout, "night");
      assert.deepEqual(layout.clipped, [], `night ${size} ${view} clipped controls`);
      await capture(`night-${size[0]}x${size[1]}-${view}`);
    }
  }
  win.setSize(1120, 760);
  await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
  await waitFor("window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')", "reloaded in night");
  assert.equal(await js("document.documentElement.dataset.theme"), "dark", "night survives a reload");
  await click("#btn-theme");
  await waitFor("document.documentElement.dataset.theme === 'light'", "top-bar toggle returns to day");
  assert.equal(await js("localStorage.getItem('wh.aura.theme')"), "light");
  await js("window.__harness.applyTheme('system')");
  assert.equal(await js("localStorage.getItem('wh.aura.theme')"), null);
  pass("night mode is selectable in Settings and the top bar, persists across reloads, and keeps every page usable");
  win.setSize(1120, 760);
  await navigate("settings");
  await js("document.querySelector('#f-mcpPort').value='0'; document.querySelector('#f-mcpPort').dispatchEvent(new Event('input',{bubbles:true}))");
  await click("#btn-save-only");
  await waitFor("document.querySelector('#form-status').textContent.includes('端口')", "invalid port feedback");
  assert.equal((await js("window.launcher.getConfig()")).result.mcpPort, initial.result.mcpPort);
  await click("#btn-discard");
  const ports = await freePorts();
  await js(`(() => { for (const [key,value] of Object.entries(${JSON.stringify({mcpPort:ports[0],adminPort:ports[1],tunnelPort:ports[2],workspacePath:workspace})})) { const input=document.querySelector('#f-'+key); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
  await click("#btn-save-only");
  await waitFor(`window.__harness.core.snapshot().account.config.mcpPort === ${ports[0]}`, "saved real config");
  assert.equal((await js("window.launcher.getConfig()")).result.workspacePath, workspace);
  pass("settings reject invalid input and persist fixture directory and private ports through real IPC");

  await navigate("workspace");
  await click("#account-btn"); await click("#btn-account-create");
  await waitFor("document.querySelector('#dlg-account').open", "create account dialog");
  await js("document.querySelector('#account-name-input').value='灵光验收账户'; document.querySelector('#account-ok').click()");
  await waitFor("window.__harness.core.snapshot().selectedId !== 'default' && document.querySelector('#account-name').textContent === '灵光验收账户'", "new account selected");
  const secondId = await js("window.__harness.core.snapshot().selectedId");
  const secondDataDir = path.join(defaultDataDir, "accounts", secondId);
  await navigate("settings");
  await waitFor(`document.querySelector('#data-location').value === ${JSON.stringify(secondDataDir)}`, "new account data location");
  assert.equal(await js("document.querySelector('#btn-copy-data-location').disabled"), false);
  await click("#btn-copy-data-location");
  await waitFor("document.querySelector('#toast-text').textContent.includes('数据位置')", "copy data location feedback");
  assert.equal(copiedTexts.at(-1), secondDataDir);
  win.setSize(900, 600);
  assert.equal(await js("document.documentElement.scrollWidth <= innerWidth"), true, "long data path fits minimum window");
  win.setSize(1120, 760);
  await navigate("workspace");
  assert.equal((await js("window.launcher.getConfig()")).result.hasApiKey, false);
  await click("#account-btn"); await click("#btn-account-rename");
  await waitFor("document.querySelector('#dlg-account').open", "rename dialog");
  await js("document.querySelector('#account-name-input').value='灵光验收改名'; document.querySelector('#account-ok').click()");
  await waitFor("document.querySelector('#account-name').textContent === '灵光验收改名'", "renamed account label");
  let gateEntered, gateRelease;
  appInfoGate = { entered: () => gateEntered(), released: new Promise(resolve => { gateRelease = resolve; }) };
  const entered = new Promise(resolve => { gateEntered = resolve; });
  await click("#account-btn"); await click("#account-list button:first-child");
  await entered;
  try {
    assert.equal(await js("window.__harness.core.snapshot().selectedId"), "default");
    assert.equal(await js("document.querySelector('#btn-copy-data-location').disabled"), true, "copy must be disabled while the new account path is loading");
    assert.notEqual(await js("document.querySelector('#data-location').value"), secondDataDir, "previous account path must not remain visible during loading");
  } finally { appInfoGate = null; gateRelease(); }
  await waitFor(`window.__harness.core.snapshot().selectedId === 'default' && window.__harness.core.snapshot().account.config.mcpPort === ${ports[0]}`, "default account restored");
  await waitFor(`document.querySelector('#data-location').value === ${JSON.stringify(defaultDataDir)}`, "default account data location restored");
  await click("#btn-copy-data-location");
  await waitFor("document.querySelector('#toast-text').textContent.includes('数据位置')", "default location copied");
  assert.equal(copiedTexts.at(-1), defaultDataDir);
  pass("in-app account creation, rename and switching preserve separate config and no copied key");

  await navigate("skills");
  await click("#btn-install-folder");
  await waitFor("!document.querySelector('#install-sheet').hidden", "real Skill inspected");
  await js("document.querySelector('#install-id').value='aura-fixture'");
  await click("#btn-install-confirm");
  await waitFor("window.__harness.core.snapshot().catalog.installed.some(x => x.id === 'aura-fixture')", "real Skill installed");
  assert.ok((await js("window.launcher.getSkillCatalog()")).result.installed.some(x => x.id === "aura-fixture"));
  await js("window.__harness.core.act.uninstallSkill('aura-fixture')");
  assert.equal((await js("window.launcher.getSkillCatalog()")).result.installed.length, 0);
  pass("Skill folder inspection, confirmation, install and removal use the real isolated catalog");

  // A Skill written straight into the isolated Skills folder (as ChatGPT's install_skill does) appears on refresh.
  const skillsDir = (await js("window.launcher.getSkillCatalog()")).result.localSkillsDir;
  assert.ok(path.resolve(skillsDir).startsWith(path.resolve(fixture) + path.sep), "refresh fixture stays inside the disposable profile");
  const outside = path.join(skillsDir, "outside-fixture");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: outside-fixture\ndescription: Installed without this window.\n---\n\n# Outside fixture\n");
  await click("#btn-skills-refresh");
  await waitFor("!!document.querySelector('#installed-list [data-row=\"outside-fixture\"]')", "Skill installed outside the window appears after refresh");
  await waitFor("document.querySelector('#toast').classList.contains('show') && document.querySelector('#toast-text').textContent.includes('outside-fixture')", "refresh reports the added Skill");
  fs.rmSync(outside, { recursive: true, force: true });
  await js("window.__harness.refreshSkills()");
  await waitFor("!document.querySelector('#installed-list [data-row=\"outside-fixture\"]')", "Skill removed outside the window disappears after refresh");
  pass("refresh button and automatic re-read show Skills installed or removed outside this window");

  // Mark only this local fixture initialized. No API key or tunnel identity is
  // supplied, and only MCP is started; the Tunnel is never invoked.
  const ready = await js("window.launcher.saveConfig({setupDone:true, autoStart:false})");
  assert.equal(ready.ok, true);
  await js("window.__harness.core.act.selectAccount('default')");
  // A page reload checks that persisted settings bootstrap through real IPC.
  await new Promise(resolve => { win.webContents.once("did-finish-load", resolve); win.webContents.reload(); });
  await waitFor("window.__harness?.core?.mode === 'electron' && window.__harness.core.snapshot().account.config.setupDone", "saved fixture reloaded");
  await click("#row-local");
  await waitFor("!document.querySelector('#pop-local').hidden", "MCP detail");
  await click("#btn-mcp-start");
  await waitFor("window.__harness.core.snapshot().account.mcp.healthy && window.__harness.core.snapshot().account.mcp.managed", "fixture MCP healthy", 50000);
  // The reminder interval saves on its own path, so it can change while this account's MCP runs.
  await navigate("settings");
  assert.equal(await js("document.querySelector('#remind-chips [aria-checked=\"true\"]').dataset.value"), "5");
  await click('#remind-chips [data-value="10"]');
  await waitFor("window.__harness.core.snapshot().account.config.idleReminderMinutes === 10", "ten-minute reminder saved through real IPC");
  assert.equal((await js("window.launcher.getConfig()")).result.idleReminderMinutes, 10);
  await win.webContents.reload();
  await waitFor("window.__harness?.core?.snapshot().account.config.idleReminderMinutes === 10 && !document.body.classList.contains('booting')", "ten-minute reminder survives renderer reload");
  await navigate("settings");
  assert.equal(await js("document.querySelector('#remind-chips [aria-checked=\"true\"]').dataset.value"), "10");
  for (const [width, height] of [[1120, 760], [900, 600]]) {
    win.setSize(width, height);
    await js("document.getElementById('remind-chips').scrollIntoView({block:'center', inline:'nearest', behavior:'instant'})");
    await pause(400);
    assert.equal(await js("[...document.querySelectorAll('#remind-chips button')].length"), 4);
    assert.equal(await js("[...document.querySelectorAll('#remind-chips button')].every(el => { const r=el.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight; })"), true, "all four reminder choices stay visible within the window");
    await capture(width === 1120 ? "ten-minute-reminder" : "ten-minute-reminder-900x600");
  }
  win.setSize(1120, 760);
  pass("ten-minute reminder is selectable, saved through real IPC and retained across reload");
  await click('#remind-chips [data-value="15"]');
  await waitFor("window.__harness.core.snapshot().account.config.idleReminderMinutes === 15", "reminder interval saved while running");
  assert.equal((await js("window.launcher.getConfig()")).result.idleReminderMinutes, 15);
  await js("window.__harness.setReminder(5)");
  assert.equal((await js("window.launcher.getConfig()")).result.idleReminderMinutes, 5);
  await navigate("workspace");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  client = new Client({ name: "aura-local-acceptance", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${ports[0]}/mcp`)));
  const result = await client.callTool({ name: "list_directory", arguments: { path: workspace } });
  assert.notEqual(result.isError, true);
  await waitFor("window.__harness.core.snapshot().activity.some(x => x.tool === 'list_directory' && x.phase === 'done')", "actual MCP tool log reached Aura");
  const failed = await client.callTool({ name: "list_directory", arguments: { path: path.join(workspace, "missing-directory") } });
  assert.equal(failed.isError, true);
  await waitFor("window.__harness.core.snapshot().activity.some(x => x.tool === 'list_directory' && x.phase === 'failed')", "actual failed MCP call reached Aura");
  // Two ChatGPT conversations in this account, told apart by the documented openai/session metadata.
  const hashOf = raw => crypto.createHash("sha256").update("chatgpt-openai-conversation-v1\0").update(raw).digest("hex");
  const shortOf = raw => hashOf(raw).slice(0, 8);
  const fullOf = raw => "oai_conv_" + hashOf(raw).slice(0, 32);
  const conversations = { "aura-conversation-a": shortOf("aura-conversation-a"), "aura-conversation-b": shortOf("aura-conversation-b") };
  for (const raw of Object.keys(conversations)) {
    const tagged = await client.callTool({ name: "list_directory", arguments: { path: workspace }, _meta: { "openai/session": raw } });
    assert.notEqual(tagged.isError, true);
  }
  for (const short of Object.values(conversations)) {
    await waitFor(`window.__harness.core.snapshot().logs.mcp.some(e => / tools\\/call list_directory .* conv=${short}$/.test(e.text))`, `MCP log line carries conversation ${short}`);
  }
  const fullConversations = Object.keys(conversations).map(fullOf);
  await waitFor(`(async () => {
    const r=await window.launcher.listConversationNames();
    return r.ok && ${JSON.stringify(fullConversations)}.every(id => r.result.some(row => row.id === id));
  })()`, "full conversation IDs indexed from authenticated Admin activity", 15000);
  const displayRows=(await js("window.launcher.listConversationNames()")).result;
  const named=fullConversations.map(id => displayRows.find(row => row.id === id));
  assert.equal(new Set(named.map(row=>row.number)).size,2,"separate full identities get separate display numbers");
  for(const row of named) {
    assert.match(row.display,/^会话 \d{2}(?:「.+」| · \d+月\d+日)$/);
    assert.equal(row.display.includes(row.id.slice(9,17)),false,"technical short code never replaces the readable label");
  }
  // The foreground window must not suppress an explicitly configured reminder.
  const watching = win.isVisible() && win.isFocused();
  const fired = idleWatch.tick(Date.now() + 6 * 60_000);
  assert.deepEqual(fired.map(r => r.conversation).sort(), [null, ...fullConversations].sort(), "one reminder per verified full conversation plus untagged calls");
  assert.deepEqual(idleWatch.tick(Date.now() + 7 * 60_000), [], "a gap is reminded once");
  assert.equal(notifications.length, fired.length, `Windows reminders in foreground and background (visible=${win.isVisible()}, focused=${win.isFocused()})`);
  assert.equal(notificationSounds, fired.length, "each due reminder explicitly requests one sound");
  for (const row of named) assert.ok(notifications.some(n => n.title.includes(row.display)), `notification uses readable name for conversation ${row.number}`);
  await waitFor("document.querySelector('#toast-text').textContent.includes('未调用工具')", "in-app reminder toast");
  const launcherLines = (await js("window.launcher.getLogs()")).result.launcher.filter(line => line.includes("[提醒]"));
  assert.equal(launcherLines.length, fired.length);
  for (const row of named) assert.ok(launcherLines.some(line => line.includes(row.display) && line.includes("list_directory") && line.includes("未调用工具")), `launcher log records readable conversation ${row.number}`);
  // A new call re-arms its conversation; a deliberate stop below must clear it.
  await client.callTool({ name: "list_directory", arguments: { path: workspace }, _meta: { "openai/session": "aura-conversation-a" } });
  await waitFor(`window.__harness.core.snapshot().logs.mcp.filter(e => e.text.endsWith("conv=${conversations["aura-conversation-a"]}")).length >= 2`, "re-armed conversation call logged");
  // A call still running reports with its conversation, which keeps that conversation's gap closed.
  const intent = JSON.stringify({
    intent_revision: 1, objective: "Run a short sleep in the disposable Aura fixture to observe in-flight reporting",
    scope: ["disposable fixture workspace"], out_of_scope: ["live MCP, tunnel, accounts"], deliverables: ["one running report"],
    success_criteria: ["the command sleeps briefly and exits"], constraints: ["no file changes"], protected_resources: ["live services"],
    known_facts: ["fixture MCP on private ports"], assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
    closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0, resolution_mode: "none",
  });
  const slowCall = client.callTool({ name: "run_command", arguments: { command: "Start-Sleep -Milliseconds 2400", _intent: intent }, _meta: { "openai/session": "aura-conversation-a" } });
  await waitFor("window.__harness.core.snapshot().activity.some(r => r.tool === 'run_command' && r.phase === 'running' && r.callId)", "real invocation starts an exact-ID activity");
  const slowCallId = await js("window.__harness.core.snapshot().activity.find(r => r.tool === 'run_command' && r.phase === 'running').callId");
  await navigate("logs");
  await waitFor(`document.querySelector('.ev-call.running[data-call="${slowCallId}"] .dur')?.textContent.includes('已运行')`, "one live narrative card shows actual in-flight elapsed time");
  const slow = await slowCall;
  assert.notEqual(slow.isError, true, JSON.stringify(slow.content).slice(0, 600));
  await waitFor(`window.__harness.core.snapshot().logs.mcp.some(e => /^\\[TOOL\\] \\[running\\] run_command .* call=${slowCallId} .*conv=${conversations["aura-conversation-a"]}$/.test(e.text))`, "real invocation carries its call and conversation identities");
  await pause(3200); // two Admin feed polls
  assert.equal(await js("window.__harness.core.snapshot().logs.mcp.filter(e => /^\\[(?:mcp|tool)\\] /.test(e.text)).length"), 0, "a managed MCP's calls are not repeated from the Admin feed");
  await navigate("logs");
  await waitFor("document.querySelector('#log-view .ev-call.done[data-tool=list_directory] .say b')?.textContent === '查看目录' && !!document.querySelector('#log-view .ev-call.failed')", "production cards keep canonical identity and the original narrative labels");
  await waitFor(`!!document.querySelector('.ev-call.done[data-call="${slowCallId}"]')`, "the live card becomes the completion card");
  assert.equal(await js(`document.querySelectorAll('.ev-call[data-call="${slowCallId}"]').length`), 1, "start, heartbeat, completion and HTTP diagnostics stay one card");
  await waitFor(`(() => { const el = document.querySelector('.ev-call.done[data-call="${slowCallId}"]'); return el?.dataset.tool === 'run_command' && /(?:ms|s)/.test(el.querySelector('.dur').textContent) && !/未记录|…/.test(el.querySelector('.dur').textContent); })()`, "production call card shows its exact invocation duration");
  await click('#seg-mode [data-mode="raw"]');
  await waitFor("document.querySelector('#log-view').textContent.includes('[TOOL]') && document.querySelector('#log-view').textContent.includes('[MCP ERROR]')", "raw production logs retained");
  await click('#seg-mode [data-mode="story"]');
  await waitFor("!!document.querySelector('#log-view .ev-call.done')", "narrative restored");
  await pause(3000);
  await capture("real-mcp-activity");
  await client.close(); client = null;
  await navigate("workspace"); await click("#row-local"); await click("#btn-mcp-stop");
  await waitFor("!window.__harness.core.snapshot().account.mcp.managed", "fixture MCP stopped");
  assert.deepEqual(idleWatch.tick(Date.now() + 30 * 60_000), [], "stopping the account clears its pending gaps");
  assert.equal(await js("window.__harness.core.snapshot().account.tunnel.managed"), false);
  pass("real private-port MCP start, local tool call, production activity feed and owned-process stop; no Tunnel or cloud");
  pass("idle reminders from real MCP lines fire once with custom-sound requests and notification test doubles; stop with the account (native audio tested separately)");
  assert.deepEqual(uiErrors.filter(x => !/Content Security Policy/.test(x)), []);
  const gpu = await js("(() => { const gl=document.createElement('canvas').getContext('webgl'); return gl ? {webgl:true, renderer:gl.getParameter(gl.RENDERER)} : {webgl:false}; })()");
  const report = { passed: true, at: new Date().toISOString(), fixture, version: info.result.version, checks, screenshots, gpu, secondAccount: secondId, privatePorts: ports, realMainAndPreload: true, realLocalMcpToolCall: true, idleReminder: { notifications: notifications.length }, tunnelStarted: false, cloudVerified: false, installerExecuted: false, userVisualApproval: false };
  fs.writeFileSync(path.join(artifacts, "latest.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`AURA_UI_COMPLETE ${JSON.stringify({ checks: checks.length, screenshots: screenshots.length, report: path.join(artifacts, 'latest.json') })}`);
  clearTimeout(deadline); await cleanup(); app.quit();
})().catch(async error => {
  clearTimeout(deadline);
  console.error(error.stack || error);
  console.error("Aura UI errors:", JSON.stringify(uiErrors));
  fs.writeFileSync(path.join(fixture, "failure.json"), JSON.stringify({ error: String(error), uiErrors, checks, screenshots }, null, 2));
  await cleanup(); app.exit(1);
});
