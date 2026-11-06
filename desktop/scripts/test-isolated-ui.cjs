"use strict";
// Real Electron main/preload/renderer, hidden window, disposable data and no Tunnel.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron");
const { app } = electron;
// An Electron script entrypoint otherwise reports the Electron version; use the
// same package metadata as a normal desktop-folder launch for the UI fixture.
app.getVersion = () => require("../package.json").version;
const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const artifacts = require("./lib/test-isolation.cjs").artifactRoot("isolated-ui");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifacts, "ui-run-"));
if (!path.resolve(fixture).startsWith(path.resolve(artifacts) + path.sep)) throw new Error("Unsafe UI fixture");
const userData = path.join(fixture, "chatgpt-web-harness-isolated");
fs.mkdirSync(userData, { recursive: true });
app.setPath("appData", fixture);
app.setPath("userData", userData);
assert.equal(fs.existsSync(path.join(userData, "config.json")), false, "fresh UI fixture must not seed a legacy default config before real AccountManager initialization");
assert.equal(fs.existsSync(path.join(userData, "accounts.json")), false, "fresh UI fixture must not synthesize an account registry");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");
// Deliberately inject synthetic legacy overrides; the real main entry must scrub them.
const protectedFixture = path.join(fixture, "production-sentinel");
fs.mkdirSync(protectedFixture);
fs.writeFileSync(path.join(protectedFixture, ".env"), "ADMIN_TOKEN=fake-parent-token\nISOLATION_SENTINEL=must-not-load\n");
process.env.CLC_RUNTIME_DIR = protectedFixture;
process.env.ADMIN_TOKEN = "fake-parent-token";
process.env.MCP_TOKEN = "fake-parent-mcp-token";
process.env.DOTENV_CONFIG_PATH = path.join(protectedFixture, ".env");
process.env.DOTENV_CONFIG_OVERRIDE = "true";
process.env.AUDIT_LOG_PATH = path.join(protectedFixture, "audit.log");
process.env.CHECKPOINT_PATH = path.join(protectedFixture, "checkpoints");
process.env.CODEX_HOME = path.join(protectedFixture, ".codex");
process.env.MCP_SHELL_STATE_DIR = path.join(protectedFixture, "state");
const legacy = path.join(fixture, "chatgpt-local-coder-desktop");
fs.mkdirSync(legacy);
fs.writeFileSync(path.join(legacy, "config.json"), JSON.stringify({
  setupDone: true, autoStart: true, workspacePath: "DO-NOT-MIGRATE",
  apiKeyEnc: "fixture-not-a-real-key", tunnelId: "tunnel_" + "b".repeat(32),
}));
const uiErrors = [];
let windowResolve;
const windowReady = new Promise((resolve) => { windowResolve = resolve; });
class HiddenWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true } });
    this.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) uiErrors.push(message);
    });
    this.webContents.on("did-fail-load", (_event, code, description) => uiErrors.push(code + ":" + description));
    this.webContents.once("did-finish-load", () => windowResolve(this));
  }

}
class HiddenTray extends EventEmitter {
  setToolTip() {} setContextMenu() {} destroy() {}
}
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent && parent.filename.startsWith(desktop)) {
    return { ...electron, BrowserWindow: HiddenWindow, Tray: HiddenTray,
      dialog: { ...electron.dialog, showErrorBox: (title, body) => { uiErrors.push(title + ": " + body); } },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require("../src/main.js");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(win, expression, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await pause(50);
  }
  throw new Error("UI timeout: " + label);
}
const timeout = setTimeout(() => { console.error("FAIL isolated UI hard deadline"); app.exit(1); }, 60000);
(async () => {
  const win = await windowReady;
  await waitFor(win, "window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')", "Aura backend initialized");
  assert.match(win.webContents.getURL(), /\/renderer\/v3\/aura\/index\.html\?desktop=1$/);
  const js = expression => win.webContents.executeJavaScript(expression);
  const info = await js("window.launcher.appInfo()");
  const config = await js("window.launcher.getConfig()");
  assert.equal(info.ok, true); assert.equal(config.ok, true);
  assert.equal(info.result.name, "ChatGPT Web Harness Isolated");
  assert.equal(info.result.isolated, true);
  assert.equal(path.resolve(info.result.configPath), path.join(userData, "config.json"));
  assert.equal(path.resolve(info.result.runtimeDir), path.join(userData, "runtime"));
  assert.deepEqual(info.result.legacyKeys, []);
  assert.equal(info.result.legacyTunnelId, ""); assert.equal(info.result.legacyWorkspace, "");
  assert.equal(config.result.setupDone, false); assert.equal(config.result.autoStart, false);
  assert.equal(config.result.workspacePath, ""); assert.equal(config.result.hasApiKey, false);
  const initialPorts = require("./lib/test-isolation.cjs").initialPorts();
  assert.deepEqual([config.result.mcpPort, config.result.adminPort, config.result.tunnelPort], initialPorts);
  assert.deepEqual(require("../src/config").DEFAULTS.mcpPort, 3300, "production default remains independently asserted");
  const takeover = await js("window.launcher.stopExternal()");
  assert.equal(takeover.ok, false); assert.match(takeover.error, /隔离版不接管或终止外部进程/);
  assert.equal(await js("document.querySelector('#btn-external').hidden && document.querySelector('#btn-external').disabled"), true);
  assert.equal(await js("window.__harness.core.snapshot().account.mcp.managed"), false);
  const initialAccounts = await js("window.launcher.listAccounts()");
  assert.equal(initialAccounts.result.selectedId, "default"); assert.equal(initialAccounts.result.accounts.length, 1);
  assert.equal(initialAccounts.result.accounts[0].name, "默认账户");
  assert.equal(initialAccounts.result.accounts[0].config.hasApiKey, false);
  assert.equal(initialAccounts.result.accounts[0].mcp.owned, false);
  assert.equal(initialAccounts.result.accounts[0].tunnel.owned, false);
  await js("window.__harness.core.act.createAccount('第二账号验收')");
  const secondId = await js("window.__harness.core.snapshot().selectedId");
  assert.match(secondId, /^[a-f0-9]{32}$/);
  const secondConfig = await js("window.launcher.getConfig()");
  const secondAccounts = await js("window.launcher.listAccounts()");
  assert.equal(secondConfig.result.setupDone, false); assert.equal(secondConfig.result.hasApiKey, false);
  const secondPorts = [secondConfig.result.mcpPort, secondConfig.result.adminPort, secondConfig.result.tunnelPort];
  const base = secondPorts[0];
  assert.ok(Number.isInteger(base) && base >= 3400 && base < 4400 && base % 10 === 0);
  assert.deepEqual(secondPorts, [base, base + 1, base + 2]);
  assert.ok(secondPorts.every(port => ![3300, 3301, 8380].includes(port)));
  assert.equal(secondAccounts.result.accounts.length, 2);
  const secondRow = secondAccounts.result.accounts.find(row => row.id === secondId);
  assert.equal(path.resolve(secondRow.dataDir), path.join(userData, "accounts", secondId));
  assert.match(secondAccounts.result.securityBoundary, /不是 Windows 用户或系统安全沙箱/);
  await js(`window.__harness.core.act.renameAccount(${JSON.stringify(secondId)}, '第二账号（验收）')`);
  assert.equal(await js("window.__harness.core.snapshot().account.name"), "第二账号（验收）");
  await js("window.__harness.core.act.selectAccount('default')");
  const returnedConfig = await js("window.launcher.getConfig()");
  assert.deepEqual([returnedConfig.result.mcpPort, returnedConfig.result.adminPort, returnedConfig.result.tunnelPort], initialPorts);
  assert.equal(returnedConfig.result.hasApiKey, false);
  for (const key of ["DOTENV_CONFIG_PATH", "DOTENV_CONFIG_OVERRIDE", "ADMIN_TOKEN", "MCP_TOKEN"]) assert.equal(process.env[key], undefined);
  assert.equal(process.env.CLC_RUNTIME_DIR, path.join(userData, "runtime"));
  assert.equal(process.env.CODEX_HOME, path.join(userData, "runtime", ".codex"));
  assert.deepEqual(fs.readdirSync(protectedFixture), [".env"]);
  assert.match(fs.readFileSync(path.join(protectedFixture, ".env"), "utf8"), /ISOLATION_SENTINEL=must-not-load/);
  const stored = JSON.parse(fs.readFileSync(info.result.configPath, "utf8"));
  assert.ok(stored.adminTokenEnc);
  assert.notEqual(electron.safeStorage.decryptString(Buffer.from(stored.adminTokenEnc, "base64")), "fake-parent-token");
  const legacyAfter = JSON.parse(fs.readFileSync(path.join(legacy, "config.json"), "utf8"));
  assert.equal(legacyAfter.workspacePath, "DO-NOT-MIGRATE"); assert.equal(legacyAfter.apiKeyEnc, "fixture-not-a-real-key");
  const catalog = await js("window.launcher.getSkillCatalog()");
  assert.equal(catalog.ok, true); assert.equal(catalog.result.installed.length, 0); assert.equal(catalog.result.external.length, 0);
  if (info.result.isPackaged) assert.equal(catalog.result.builtin.length, 0); else assert.ok(Array.isArray(catalog.result.builtin));
  win.setSize(900, 600); await pause(150);
  assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
  assert.deepEqual(uiErrors.filter(error => !/Content Security Policy/.test(error)), []);
  fs.writeFileSync(path.join(artifacts, "isolated-ui-result.json"), JSON.stringify({
    passed: true, renderer: "aura", configPath: info.result.configPath, runtimeDir: info.result.runtimeDir,
    managedServiceAutoStart: false, externalTakeoverRejected: true, inheritedOverridesScrubbed: true,
    protectedFixtureUnchanged: true, freshBeforeMain: { configExisted: false, registryExisted: false },
    initialAccountName: initialAccounts.result.accounts[0].name,
    multiAccount: { secondId, ports: secondPorts, noCopiedApiKey: true, returnedToDefault: true }
  }, null, 2));
  console.log("PASS real Aura Electron main/preload isolation, inherited override scrubbing, protected legacy data and separate accounts");
  clearTimeout(timeout); app.quit();
})().catch(error => {
  clearTimeout(timeout); console.error(error.stack || error); console.error("UI errors:", JSON.stringify(uiErrors)); app.exit(1);
});
