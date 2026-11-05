"use strict";
// Isolated native Electron: simulate dangerous process metrics without actually
// allocating RAM, opening the real account or replacing an installed binary.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron");
const { app } = electron;
const desktop = path.resolve(__dirname, "..");
const out = path.join(desktop, "..", ".validation", "aura-memory-defense-20261105", "fixtures");
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(out, "run-"));
app.setPath("appData", fixture);
app.setPath("userData", path.join(fixture, "chatgpt-web-harness-isolated"));
app.getVersion = () => require("../package.json").version;
let win, resolveWindow;
const ready = new Promise(resolve => { resolveWindow = resolve; });
class TestWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, paintWhenInitiallyHidden: false });
    this.webContents.once("did-finish-load", () => resolveWindow(this));
  }
  show() {}
  showInactive() {}
}
class TestTray extends EventEmitter {
  setToolTip() {}
  setContextMenu() {}
  destroy() {}
}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron" && parent?.filename.startsWith(desktop)) {
    return { ...electron, BrowserWindow: TestWindow, Tray: TestTray };
  }
  return origLoad.call(this, request, parent, isMain);
};
require("../src/main.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, budget = 16000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (_) {}
    await sleep(180);
  }
  throw new Error("Timeout waiting for " + label);
}
const hardDeadline = setTimeout(() => { console.error("MEMORY_GUARD_TIMEOUT", fixture); app.exit(1); }, 28000);
(async () => {
  win = await ready;
  const wc = win.webContents;
  await until(() => wc.executeJavaScript("window.__harness?.core?.mode === 'electron'"), "initial UI");
  const oldPid = wc.getOSProcessId();
  const gpuMode = process.argv.includes("--gpu-pressure");
  const syntheticGpuPid = oldPid + 1000000; // metric-only PID, never a process we start or kill
  let simulated = true, syntheticMiB = gpuMode ? 1100 : 1000, crashes = 0, crashReason = null;
  wc.on("render-process-gone", (_event, details) => {
    simulated = false;
    crashes += 1;
    crashReason = details.reason;
  });
  const getRealMetrics = app.getAppMetrics.bind(app);
  app.getAppMetrics = () => simulated
    ? gpuMode
      ? [{ pid: oldPid, type: "Tab", memory: { privateBytes: 180 * 1024, workingSetSize: 180 * 1024 } },
         { pid: syntheticGpuPid, type: "GPU", memory: { privateBytes: syntheticMiB * 1024, workingSetSize: 1000 * 1024 } }]
      : [{ pid: oldPid, type: "Tab", memory: { privateBytes: syntheticMiB * 1024, workingSetSize: 1000 * 1024 } }]
    : getRealMetrics();
  const warningApplied = await until(async () => {
    if (crashes) return false;
    return wc.executeJavaScript("(()=>{const s=window.AuraMemoryGuard?.status();return s?.animated===true && s?.memoryPressure===true && s.quality<=.7 && !document.documentElement.classList.contains('no-webgl')})()");
  }, "dynamic WebGL reduced-pixel mode at warning threshold", 14000);
  assert.equal(warningApplied, true, "The warning must keep real GPU animation alive");
  assert.equal(crashes, 0, "Warning must not crash the management window");
  assert.equal(fs.existsSync(path.join(app.getPath("userData"), "renderer-safe-graphics.json")), false,
    "A warning must not lock the next normal launch into the static UI");
  syntheticMiB = 2400;
  const recoveredUrl = await until(() => {
    const url = wc.getURL();
    return url.includes("safeGraphics=1") && url;
  }, "exact safe-graphics reload");
  await until(() => wc.executeJavaScript("window.__harness?.core?.mode === 'electron' && !!window.AuraMemoryGuard"), "recovered Electron UI");
  const ui = await wc.executeJavaScript("({noWebGL: document.documentElement.classList.contains('no-webgl'), canvasDisabled: document.querySelector('#scene')?.width === 0, account: window.__harness.core.snapshot().account?.name, controls: !!document.querySelector('#nav [data-view=settings]')})");
  const marker = path.join(app.getPath("userData"), "renderer-safe-graphics.json");
  const savedSafeMode = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(savedSafeMode.schema, 1);
  assert.equal(savedSafeMode.enabled, true, "Cold starts must retain the GPU fallback");
  const ipc = await wc.executeJavaScript("window.launcher.getStatus()");
  assert.equal(crashes, 1);
  assert.equal(ui.noWebGL, true);
  assert.equal(ui.controls, true);
  assert.equal(ipc.ok, true, "Strict IPC must work after safe-graphics navigation");
  const after = await wc.executeJavaScript("document.querySelector('#nav [data-view=settings]').click();document.body.dataset.view");
  assert.equal(after, "settings");
  const report = {
    passed: true, fixture, oldPid, newPid: wc.getOSProcessId(),
    crashes, crashReason, recoveredUrl, ui, warningApplied, metricSource: gpuMode ? "GPU" : "Renderer",
    syntheticMetricMiB: { warning: gpuMode ? 1100 : 1000, critical: 2400 }, actualMemoryAllocatedMiB: 0,
    existingAccountsOrServicesTouched: false
  };
  fs.writeFileSync(path.join(fixture, "result.json"), JSON.stringify(report, null, 2));
  console.log("MEMORY_GUARD_NATIVE_ACCEPTANCE " + JSON.stringify(report));
  clearTimeout(hardDeadline);
  app.exit(0);
})().catch(error => {
  console.error("MEMORY_GUARD_NATIVE_FAILURE", error.stack || String(error));
  clearTimeout(hardDeadline);
  app.exit(1);
});
