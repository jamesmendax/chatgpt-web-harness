"use strict";
// Production Aura + isolated Electron/preload. No real account, tunnel or MCP.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron"), { app } = electron;
const desktop = path.resolve(__dirname, "..");
const out = path.join(desktop, "..", ".validation", "aura-quality-tiers-20261105");
fs.mkdirSync(out, { recursive: true });
const fixture = fs.mkdtempSync(path.join(out, "native-"));
app.setPath("appData", fixture);
app.setPath("userData", path.join(fixture, "chatgpt-web-harness-isolated"));
app.getVersion = () => require("../package.json").version;
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("use-angle", "d3d11");
const errors = [], checks = [], screenshots = [], samples = [], tiers = [];
let win, resolveWindow;
const ready = new Promise(resolve => { resolveWindow = resolve; });
class FixtureWindow extends electron.BrowserWindow {
  constructor(options) {
    super({ ...options, width: 1120, height: 760, show: false,
      webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    this.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(String(message)); });
    this.webContents.once("did-finish-load", () => resolveWindow(this));
  }
}
class FixtureTray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent?.filename.startsWith(desktop)) {
    return { ...electron, BrowserWindow: FixtureWindow, Tray: FixtureTray };
  }
  return originalLoad.call(this, request, parent, isMain);
};
require("../src/main.js");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code);
async function until(code, label, budget = 14000) {
  const end = Date.now() + budget;
  while (Date.now() < end) { if (await evaluate(code)) return; await pause(60); }
  throw Error("Timed out: " + label);
}
function pass(name) { checks.push(name); console.log("PASS " + name); }
function memory(stage) {
  const pid = win.webContents.getOSProcessId();
  const m = app.getAppMetrics().find(item => item.pid === pid)?.memory || {};
  const sample = { stage, at: new Date().toISOString(), pid,
    privateMiB: Number.isFinite(m.privateBytes) ? m.privateBytes / 1024 : null,
    workingMiB: Number.isFinite(m.workingSetSize) ? m.workingSetSize / 1024 : null };
  samples.push(sample); return sample;
}
async function choose(key) {
  await evaluate("document.querySelector('#quality-chips [data-value=" + key + "]').click()");
  await until("window.AuraMemoryGuard.status().selected === '" + key + "' && " +
    (key === "static" ? "window.AuraMemoryGuard.status().resources.live === 0" : "window.AuraMemoryGuard.status().scene?.ready === true"), "tier " + key);
  return evaluate("window.AuraMemoryGuard.status()");
}
async function capture(name) {
  await pause(250);
  const image = await win.webContents.capturePage();
  assert.equal(image.isEmpty(), false);
  const filename = path.join(fixture, name + ".png");
  fs.writeFileSync(filename, image.toPNG()); screenshots.push(filename);
}
// Opt-in source-only real Electron soak, disabled for quick regressions.
const SOAK_MS = Math.max(0, Math.min(600000, Number(process.env.AURA_SOAK_MS) || 0));
const timer = setTimeout(() => {
  fs.writeFileSync(path.join(fixture, "timeout.json"), JSON.stringify({ checks, samples, errors }, null, 2));
  console.error("QUALITY_UI_TIMEOUT " + fixture); app.exit(1);
}, 85000 + SOAK_MS);
(async () => {
  win = await ready;
  await until("window.__harness?.core?.mode === 'electron' && !document.body.classList.contains('booting')", "real Aura ready");
  const info = await evaluate("window.launcher.appInfo()");
  assert.equal(info.ok, true);
  assert.ok(path.resolve(info.result.configPath).startsWith(path.resolve(fixture) + path.sep));
  const serviceState = await evaluate("(()=>{const s=window.__harness.core.snapshot().account;return {mcp:s.mcp.managed,tunnel:s.tunnel.managed};})()");
  assert.equal(serviceState.mcp, false); assert.equal(serviceState.tunnel, false);
  pass("private account only; production backend and tunnel not started");
  await evaluate("window.__harness.setView('settings',{pane:'appearance'})");
  await pause(850);
  const visible = await evaluate("(()=>{const row=document.querySelector('#quality-row');const cs=document.querySelector('#quality-chips');const r=row.getBoundingClientRect();return {text:row.textContent.replace(/\\s/g,''), radios:cs.querySelectorAll('[role=radio]').length, forbidden:row.querySelectorAll('small,.say-help,[title],.description').length, top:r.top,bottom:r.bottom,height:innerHeight, classes:cs.className};})()");
  assert.equal(visible.text, "画质与动效极致高普通节能");
  assert.equal(visible.radios, 4); assert.equal(visible.forbidden, 0);
  assert.ok(visible.top >= 0 && visible.bottom <= visible.height);
  assert.equal(visible.classes, "chips");
  pass("one Aura chips row; exactly title plus four tier names; no explanatory text");
  const curtainRow = await evaluate("(()=>{const r=document.querySelector('#curtain-row'),c=document.querySelector('#curtain-chips');return {text:r.textContent.replace(/\\s/g,''),radios:c.querySelectorAll('[role=radio]').length,forbidden:r.querySelectorAll('small,.say-help,[title],.description').length,classes:c.className,selected:c.querySelector('[aria-checked=true]')?.dataset.value};})()");
  assert.deepEqual([curtainRow.text,curtainRow.radios,curtainRow.forbidden,curtainRow.classes,curtainRow.selected],
    ["动态光幕开启关闭",2,0,"chips","on"]);
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.effective,true);
  pass("independent curtain row uses original Aura chips with only text 开启/关闭; High defaults on");
  await choose("standard");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,false,
    "Standard defaults with no full-screen curtain until explicitly enabled");
  await evaluate("document.querySelector('#curtain-chips [data-value=on]').click()");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,true);
  await choose("high");await choose("ultra");await choose("standard");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,true);
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.effective,true);
  await evaluate("document.querySelector('#curtain-chips [data-value=off]').click()");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,false);
  await choose("ultra");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,false);
  await evaluate("document.querySelector('#curtain-chips [data-value=off]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,true);
  pass("curtain survives quality switches; Standard+curtain works; Ultra+curtain-off works; keyboard controls work");
  const curtainBase=await evaluate("window.AuraMemoryGuard.status().resources");
  for(let i=0;i<100;i++)await evaluate("document.querySelector('#curtain-chips [data-value=" + (i%2?"on":"off") + "]').click()");
  const curtainAfter=await evaluate("window.AuraMemoryGuard.status()");
  assert.equal(curtainAfter.resources.created,curtainBase.created);
  assert.equal(curtainAfter.resources.released,curtainBase.released);
  assert.equal(curtainAfter.resources.live,1);assert.ok(curtainAfter.scheduled<=1);
  assert.equal(curtainAfter.scene.pending,0);
  assert.equal(await evaluate("localStorage.getItem('wh.aura.curtain')"),"on");
  pass("100 real curtain switches preserve exactly one WebGL scene and one frame scheduler");
  await choose("high");
  await evaluate("window.__harness.applyTheme('light')"); await pause(650); await capture("appearance-light");
  await evaluate("window.__harness.applyTheme('dark')"); await pause(650); await capture("appearance-dark");
  pass("light and dark screenshots captured with existing Aura theme");
  // A keyboard action selects a real radio and updates storage immediately.
  await evaluate("document.querySelector('#quality-chips [data-value=high]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  assert.equal(await evaluate("window.AuraMemoryGuard.status().selected"), "standard");
  pass("keyboard navigation selects the next tier");
  for (const key of ["ultra", "high", "standard", "static"]) {
    const first = await choose(key);
    await pause(2200);
    const a = await evaluate("window.AuraMemoryGuard.status()");
    await pause(1100);
    const b = await evaluate("window.AuraMemoryGuard.status()");
    const frames = b.frames - a.frames;
    const max = key === "static" ? 0 : Math.ceil(b.tier.activeFps * 1.1) + 2;
    assert.ok(frames <= max, key + " exceeded its frame budget: " + frames);
    if (key === "static") { assert.equal(frames, 0); assert.equal(b.resources.live, 0); assert.equal(b.scheduled, 0); }
    else {
      assert.equal(b.animated, true); assert.ok(frames > 0, key + " lost animation");
      assert.equal(b.resources.live, 1); assert.ok(b.scheduled <= 1);
      assert.ok(b.scene.pixels <= b.tier.pixels); assert.ok(b.scene.pending <= 1);
    }
    tiers.push({ key, sampleMs: 1100, frames, state: b }); memory(key);
  }
  pass("each tier renders within its own budget; energy-saving owns no WebGL scene or frame task");
  await choose("high");
  const start = await evaluate("window.AuraMemoryGuard.status().resources");
  // Dynamic-to-dynamic switching must reuse one context, not merely dispose later.
  for (let i = 0; i < 80; ++i) await choose(["ultra", "high", "standard"][i % 3]);
  const stable = await evaluate("window.AuraMemoryGuard.status()");
  assert.equal(stable.resources.created, start.created); assert.equal(stable.resources.live, 1);
  assert.ok(stable.scheduled <= 1); pass("80 real dynamic tier changes reuse one context");
  memory("before-static-roundtrips");
  for (let i = 0; i < 24; ++i) {
    const off = await choose("static"); assert.equal(off.resources.created, off.resources.released);
    const on = await choose(["ultra", "high", "standard"][i % 3]);
    assert.equal(on.resources.created - on.resources.released, 1);
    assert.equal(on.resources.live, 1); assert.ok(on.scheduled <= 1);
    await pause(30); // Let old asynchronous webglcontextlost be delivered.
    assert.equal(await evaluate("window.AuraMemoryGuard.status().blocked"), false);
  }
  pass("24 static/dynamic roundtrips balance every scene and reject stale context-loss callbacks");
  const soakSamples = [];
  if (SOAK_MS) {
    // Cycle real dynamic tiers, the curtain switch and the static context
    // release path. No real accounts, services or large memory allocations.
    const started = Date.now();
    let iteration = 0;
    while (Date.now() - started < SOAK_MS) {
      const key = ["ultra", "high", "standard", "ultra", "high", "static"][iteration % 6];
      await choose(key);
      await evaluate("window.__harness.setCurtain(" + (iteration % 2 === 0 ? "true" : "false") + ")");
      await pause(1400);
      const state = await evaluate("window.AuraMemoryGuard.status()");
      const record = memory("soak-" + iteration);
      const gpu = app.getAppMetrics().filter(m => m.type === "GPU")
        .map(m => ({ pid: m.pid, privateMiB: Number.isFinite(m.memory?.privateBytes) ? m.memory.privateBytes / 1024 : null }));
      record.gpu = gpu;
      record.resources = { live: state.resources.live, created: state.resources.created,
        released: state.resources.released, scheduled: state.scheduled, pixels: state.scene?.pixels || 0 };
      record.curtain = state.curtain.effective;
      record.domNodes = await evaluate("document.getElementsByTagName('*').length");
      soakSamples.push(record);
      assert.equal(state.resources.created - state.resources.released, key === "static" ? 0 : 1);
      assert.ok(state.scheduled <= 1, "more than one frame scheduler");
      assert.ok(record.resources.pixels <= state.tier.pixels, "GPU buffer exceeds tier budget");
      assert.ok(record.domNodes < 6000, "unexpected DOM accumulation");
      if (record.privateMiB != null) assert.ok(record.privateMiB < 620,
        "test renderer memory unexpectedly high: " + record.privateMiB + " MiB");
      for (const item of gpu) if (item.privateMiB != null) assert.ok(item.privateMiB < 1024,
        "GPU process unexpectedly high: " + item.privateMiB + " MiB");
      if (++iteration % 20 === 0) console.log("AURA_SOAK_PROGRESS " +
        JSON.stringify({ iteration, elapsedSec: Math.round((Date.now()-started)/1000),
          rendererMiB: record.privateMiB, gpu, resources: record.resources, domNodes: record.domNodes }));
    }
    const valid=soakSamples.filter(r=>Number.isFinite(r.privateMiB));
    assert.ok(valid.length >= 18, "insufficient real renderer memory observations");
    const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
    const slice=Math.max(6,Math.floor(valid.length/4));
    const earlier=median(valid.slice(slice,slice*2).map(r=>r.privateMiB));
    const later=median(valid.slice(-slice).map(r=>r.privateMiB));
    assert.ok(later-earlier < 96, "sustained renderer growth: "+(later-earlier)+" MiB");
    pass("real Electron GPU/renderer soak, bounded GPU buffers and DOM, no cumulative memory growth");
  }
  await evaluate("window.__harness.setCurtain(true)");
  await choose("standard");
  const beforeReload = await evaluate("localStorage.getItem('wh.aura.quality')"); assert.equal(beforeReload, "standard");
  const loaded = new Promise(resolve => win.webContents.once("did-finish-load", resolve));
  win.webContents.reload(); await loaded;
  await until("window.__harness?.core?.mode === 'electron' && window.AuraMemoryGuard.status().scene?.ready", "reload preference");
  assert.equal(await evaluate("window.AuraMemoryGuard.status().selected"), "standard");
  assert.equal((await evaluate("window.AuraMemoryGuard.status()")).curtain.selected,true);
  pass("selection persists through actual renderer reload");
  await evaluate("window.__harness.setView('settings',{pane:'appearance'})"); await pause(700);
  await choose("static");
  await evaluate("document.querySelector('#nav [data-view=workspace]').click()");
  assert.equal(await evaluate("document.body.dataset.view"), "workspace");
  await evaluate("document.querySelector('#nav [data-view=settings]').click()");
  assert.equal(await evaluate("document.body.dataset.view"), "settings");
  pass("static-tier navigation works without an animation loop");
  await choose("ultra"); await evaluate("window.AuraMemoryGuard.reduceLoad()");
  const pressured = await evaluate("window.AuraMemoryGuard.status()");
  assert.equal(pressured.animated, true); assert.ok(pressured.quality <= .7);
  await choose("standard"); await choose("ultra");
  const retained = await evaluate("window.AuraMemoryGuard.status()");
  assert.equal(retained.memoryPressure, true); assert.ok(retained.quality <= .7);
  pass("every dynamic tier preserves the memory-pressure latch across manual changes");
  for (let i = 0; i < 6; ++i) { await pause(800); memory("steady-" + i); }
  const late = samples.filter(x => x.stage.startsWith("steady-") && x.privateMiB !== null);
  if (late.length > 1) assert.ok(late.at(-1).privateMiB - late[0].privateMiB < 64, "unexpected short-window runaway");
  await choose("static");
  const end = await evaluate("window.AuraMemoryGuard.status()");
  assert.equal(end.resources.created, end.resources.released); assert.equal(end.scheduled, 0);
  const report = { passed: true, fixture, checks, tiers, samples, screenshots, errors, soakSamples,
    scope: "source-level real isolated Electron; bounded short test, not hours-long leak proof or packaged release",
    final: end, existingRuntimeModified: false };
  fs.writeFileSync(path.join(fixture, "result.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, "latest-native.json"), JSON.stringify({ fixture, report: path.join(fixture,"result.json"), screenshots, passed: true }, null, 2));
  console.log("QUALITY_NATIVE_PASS " + JSON.stringify({ fixture, checks: checks.length, samples, screenshots }));
  clearTimeout(timer); app.exit(0);
})().catch(error => {
  fs.writeFileSync(path.join(fixture, "failure.json"), JSON.stringify({ error: error.stack || String(error), checks, samples, errors }, null, 2));
  console.error("QUALITY_NATIVE_FAILURE " + fixture + "\n" + (error.stack || error)); clearTimeout(timer); app.exit(1);
});
