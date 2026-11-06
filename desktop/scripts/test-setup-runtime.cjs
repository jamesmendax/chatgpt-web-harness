"use strict";
// Production IPC + setup lease + the bundled, unmodified tunnel-client doctor.
// A loopback deny proxy prevents control-plane traffic; no Tunnel is started.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net"), Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron"), { app } = electron;
const desktop = path.resolve(__dirname, "..");
const artifacts = require("./lib/test-isolation.cjs").artifactRoot("setup-runtime");
fs.mkdirSync(artifacts, { recursive: true });
const fixture = fs.mkdtempSync(path.join(artifacts, "run-"));
const workspace = path.join(fixture, "workspace");
fs.mkdirSync(workspace);
app.setPath("appData", fixture); app.setPath("userData", path.join(fixture, "isolated"));
app.getVersion = () => require("../package.json").version;
process.env.CODEX_HOME = path.join(fixture, "empty-codex");
fs.mkdirSync(process.env.CODEX_HOME);
let resolveWindow, win, deny, collision, blockedControlPlane = 0;
const ready = new Promise(resolve => { resolveWindow = resolve; });
const checks = [], errors = [], results = [];
class Window extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    this.webContents.once("did-finish-load", () => resolveWindow(this));
  }
}
class Tray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent?.filename.startsWith(desktop)) return { ...electron, BrowserWindow: Window, Tray,
    dialog: { ...electron.dialog, showErrorBox: (title, message) => errors.push(`${title}: ${message}`) } };
  return load.call(this, request, parent, isMain);
};
require("../src/main");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = expression => win.webContents.executeJavaScript(expression);
async function wait(expression, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { if (await js(expression)) return; await pause(80); }
  throw new Error(`Timeout: ${label}`);
}
function listen(server) { return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server.address().port)); }); }
async function ports() {
  const servers = [];
  try { const values = []; for (let i = 0; i < 3; i++) { const server = net.createServer(); servers.push(server); values.push(await listen(server)); } return values; }
  finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
async function cleanup() {
  if (win && !win.isDestroyed()) { try { await js("window.__harness.core.act.stopAll()"); } catch {} }
  for (const server of [deny, collision]) if (server?.listening) await new Promise(resolve => server.close(resolve));
}
function pass(label) { checks.push(label); console.log("PASS " + label); }
const deadline = setTimeout(async () => { console.error("FAIL real setup deadline"); await cleanup(); app.exit(1); }, 180000);
(async () => {
  win = await ready;
  await wait("window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')", "real backend");
  const before = (await js("window.launcher.getConfig()")).result;
  assert.equal(before.setupDone, false); assert.equal(before.hasApiKey, false);
  deny = net.createServer(socket => { blockedControlPlane++; socket.destroy(); });
  const proxyPort = await listen(deny), p = await ports();
  const values = { workspacePath: workspace, tunnelId: "tunnel_11111111111111111111111111111111", apiKey: "sk-fixture-local-initialization", autoStart: false,
    mcpPort: p[0], adminPort: p[1], tunnelPort: p[2], tunnelProxyMode: "custom", tunnelProxyUrl: `http://127.0.0.1:${proxyPort}` };
  const setup = async payload => {
    const envelope = await js(`window.launcher.runSetup(${JSON.stringify(payload)})`);
    assert.equal(envelope.ok, true, envelope.error);
    results.push(envelope.result);
    return envelope.result;
  };
  const fresh = await setup(values);
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.match(fresh.doctor, /CHECK\s+mcp_server_reachable\s+PASS/);
  assert.match(fresh.doctor, /CHECK\s+oauth_metadata\s+PASS/);
  assert.doesNotMatch(JSON.stringify(fresh), /sk-fixture-local-initialization/);
  assert.equal((await js("window.launcher.getConfig()")).result.setupDone, true);
  await wait("!window.__harness.core.snapshot().account.mcp.managed", "temporary MCP cleanup");
  assert.equal(await js("window.__harness.core.snapshot().account.tunnel.managed"), false);
  pass("fresh initialization passes actual bundled doctor only after real local MCP readiness, then cleans temporary services");
  const { apiKey, ...repeat } = values;
  assert.equal((await setup(repeat)).ok, true);
  assert.equal(blockedControlPlane, 0, "doctor preflight must not attempt remote control-plane authentication");
  pass("existing Tunnel can be initialized again using the saved encrypted key, without cloud traffic or a running Tunnel");
  const created = await js("window.launcher.createAccount({name:'初始化冲突验证'})");
  assert.equal(created.ok, true, created.error);
  await js(`window.__harness.core.act.selectAccount(${JSON.stringify(created.result.id)})`);
  const q = await ports();
  collision = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { collision.once("error", reject); collision.listen(q[1], "127.0.0.1", resolve); });
  const conflict = await setup({ ...values, tunnelId: "tunnel_22222222222222222222222222222222", workspacePath: path.join(fixture, "conflict-workspace"), mcpPort: q[0], adminPort: q[1], tunnelPort: q[2] });
  assert.equal(conflict.ok, false); assert.equal(conflict.code, "LOCAL_MCP_PORT_CONFLICT");
  assert.match(conflict.message, new RegExp(String(q[1])));
  assert.equal(collision.listening, true);
  assert.equal((await js("window.launcher.getConfig()")).result.setupDone, false);
  pass("real occupied Admin port reports the exact cause, preserves its external listener and leaves fresh initialization incomplete");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(fixture, "result.json"), JSON.stringify({ ok: true, checks, results, blockedControlPlane, doctorEvidence: "unmodified bundled tunnel-client.exe doctor and production IPC/MCP" }, null, 2));
  console.log("SETUP_RUNTIME " + fixture);
  clearTimeout(deadline); await cleanup(); app.quit(); setTimeout(() => app.exit(0), 1000);
})().catch(async error => {
  console.error(error.stack); fs.writeFileSync(path.join(fixture, "failure.json"), JSON.stringify({ error: error.stack, checks, results, blockedControlPlane, errors }, null, 2));
  clearTimeout(deadline); await cleanup(); app.exit(1);
});
