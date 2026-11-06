"use strict";
// Isolated native Electron: simulate dangerous process metrics without actually
// allocating RAM, opening the real account or replacing an installed binary.
//   (default)       Renderer private bytes cross warning, then emergency.
//   --gpu-pressure  Electron GPU private bytes cross warning, then emergency.
//   --plain-crash   A renderer exit that is not a memory emergency.
// Every mode then restores dynamic graphics from Settings → Appearance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron");
const { app } = electron;
const desktop = path.resolve(__dirname, "..");
const out = require("./lib/test-isolation.cjs").artifactRoot("renderer-memory-recovery");
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
const hardDeadline = setTimeout(() => { console.error("MEMORY_GUARD_TIMEOUT", fixture); app.exit(1); }, 75000);
(async () => {
  win = await ready;
  const wc = win.webContents;
  await until(() => wc.executeJavaScript("window.__harness?.core?.mode === 'electron'"), "initial UI");
  const oldPid = wc.getOSProcessId();
  const mode = process.argv.includes("--gpu-pressure") ? "gpu" : process.argv.includes("--plain-crash") ? "plain" : "renderer";
  const gpuMode = mode === "gpu";
  const marker = path.join(app.getPath("userData"), "renderer-safe-graphics.json");
  // Metric-only GPU PID, never a process we start or kill. It stays constant,
  // so a GPU guard that is not re-armed on restore stays latched for it.
  const syntheticGpuPid = oldPid + 1000000;
  let syntheticMiB = mode === "plain" ? 300 : gpuMode ? 1100 : 1000, crashes = 0;
  const crashReasons = [];
  wc.on("render-process-gone", (_event, details) => {
    crashes += 1;
    crashReasons.push(details.reason);
    syntheticMiB = 300; // healthy until a phase raises it again
  });
  app.getAppMetrics = () => {
    const pid = wc.getOSProcessId();
    return gpuMode
      ? [{ pid, type: "Tab", memory: { privateBytes: 180 * 1024, workingSetSize: 180 * 1024 } },
         { pid: syntheticGpuPid, type: "GPU", memory: { privateBytes: syntheticMiB * 1024, workingSetSize: 1000 * 1024 } }]
      : [{ pid, type: "Tab", memory: { privateBytes: syntheticMiB * 1024, workingSetSize: 1000 * 1024 } }];
  };
  const guardText = () => wc.executeJavaScript("(()=>{const r=document.querySelector('#graphics-guard-row');return r&&!r.hidden&&r.textContent})()");
  async function restore(label) {
    await wc.executeJavaScript("window.__harness.restoreGraphics()").catch(() => {});
    const url = await until(() => { const value = wc.getURL(); return !value.includes("safeGraphics") && value.includes("desktop=1") && value; }, label + ": dynamic URL");
    await until(() => wc.executeJavaScript("window.__harness?.core?.mode === 'electron' && window.AuraMemoryGuard?.status().blocked === false && window.AuraMemoryGuard.status().resources.live === 1"), label + ": dynamic scene");
    assert.equal(fs.existsSync(marker), false, label + ": restore must clear the static marker");
    assert.equal(await guardText(), false, label + ": the guard row disappears with the static fallback");
    const status = await wc.executeJavaScript("window.launcher.getStatus()");
    assert.equal(status.ok, true, label + ": strict IPC must accept the restored dynamic URL");
    return url;
  }
  let warningApplied = null, recoveredUrl, restoredUrl, rearmedUrl = null, ui, evidence = null;
  if (mode === "plain") {
    // A renderer exit that is not a memory emergency (Task Manager, driver
    // reset, crash) keeps only this session static; later launches stay dynamic.
    wc.forcefullyCrashRenderer();
    recoveredUrl = await until(() => { const url = wc.getURL(); return url.includes("safeGraphics=1") && url; }, "session-only static reload");
    await until(() => wc.executeJavaScript("window.__harness?.core?.mode === 'electron' && !!window.AuraMemoryGuard"), "static UI");
    assert.equal(fs.existsSync(marker), false, "A non-memory renderer exit must not lock later launches into the static UI");
    const state = await wc.executeJavaScript("window.launcher.getGraphicsState()");
    assert.equal(state.ok, true);
    assert.deepEqual([state.result.safe, state.result.persisted], [true, false]);
    assert.match(await until(guardText, "session guard row"), /界面异常退出后/);
    restoredUrl = await restore("plain");
  } else {
    warningApplied = await until(async () => {
      if (crashes) return false;
      return wc.executeJavaScript("(()=>{const s=window.AuraMemoryGuard?.status();return s?.animated===true && s?.memoryPressure===true && s.quality<=.7 && !document.documentElement.classList.contains('no-webgl')})()");
    }, "dynamic WebGL reduced-pixel mode at warning threshold", 14000);
    assert.equal(warningApplied, true, "The warning must keep real GPU animation alive");
    assert.equal(crashes, 0, "Warning must not crash the management window");
    assert.equal(fs.existsSync(marker), false, "A warning must not lock the next normal launch into the static UI");
    syntheticMiB = 2400;
    recoveredUrl = await until(() => { const url = wc.getURL(); return url.includes("safeGraphics=1") && url; }, "exact safe-graphics reload");
    await until(() => wc.executeJavaScript("window.__harness?.core?.mode === 'electron' && !!window.AuraMemoryGuard"), "recovered Electron UI");
    ui = await wc.executeJavaScript("({noWebGL: document.documentElement.classList.contains('no-webgl'), canvasDisabled: document.querySelector('#scene')?.width === 0, account: window.__harness.core.snapshot().account?.name, controls: !!document.querySelector('#nav [data-view=settings]')})");
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
    // Attribution evidence: the warning asks the live renderer (V8 heap, Blink,
    // DOM, scene); the emergency records main-process metrics without waiting.
    const evidenceDir = path.join(app.getPath("userData"), "diagnostics", "renderer-memory");
    const records = await until(() => {
      const rows = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir).filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(fs.readFileSync(path.join(evidenceDir, name), "utf8"))) : [];
      return rows.some(row => row.stage === "warning") && rows.some(row => row.stage === "emergency") && rows;
    }, "warning and emergency evidence files");
    const warningRecord = records.find(row => row.stage === "warning");
    assert.equal(warningRecord.source, gpuMode ? "GPU" : "renderer");
    assert.ok(warningRecord.processes.length >= 1 && Number.isFinite(warningRecord.privateMiB));
    const heap = warningRecord.renderer?.memory?.heap;
    assert.ok(Number.isFinite(heap?.usedHeapSize), "warning evidence attributes the V8 heap: " + JSON.stringify(warningRecord.renderer));
    const heapLimitMiB = heap.heapSizeLimit / 1024;
    assert.ok(heapLimitMiB > 900 && heapLimitMiB < 1400, "the renderer V8 heap is capped near 1 GiB, got " + heapLimitMiB);
    evidence = { files: records.length, heapUsedMiB: Math.round(heap.usedHeapSize / 1024), heapLimitMiB: Math.round(heapLimitMiB),
      blink: warningRecord.renderer.memory.blink, domNodes: warningRecord.renderer.domNodes };
    // The static fallback says why, and the user can undo it.
    assert.match(await until(async () => { const value = await guardText(); return value && value.includes("内存保护") && value; }, "memory guard row"), /重新开启/);
    const state = await wc.executeJavaScript("window.launcher.getGraphicsState()");
    assert.deepEqual([state.result.safe, state.result.persisted, state.result.reason], [true, true, "renderer-memory-emergency"]);
    restoredUrl = await restore(mode);
    // Both guards must be armed again: a second emergency on the same GPU PID
    // (or a new renderer PID) recycles the renderer once more.
    syntheticMiB = 2400;
    rearmedUrl = await until(() => { const url = wc.getURL(); return crashes >= 2 && url.includes("safeGraphics=1") && url; }, "second emergency after restore");
    assert.equal(crashes, 2);
    assert.equal(fs.existsSync(marker), true, "The second emergency persists the static fallback again");
  }
  const report = {
    passed: true, mode, fixture, oldPid, newPid: wc.getOSProcessId(),
    crashes, crashReasons, recoveredUrl, restoredUrl, rearmedUrl, ui, warningApplied, evidence,
    metricSource: gpuMode ? "GPU" : mode === "plain" ? "none (plain renderer exit)" : "Renderer",
    syntheticMetricMiB: mode === "plain" ? { healthy: 300 } : { warning: gpuMode ? 1100 : 1000, critical: 2400 }, actualMemoryAllocatedMiB: 0,
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
