"use strict";
// Isolated Electron GPU comparison. No real accounts, MCP, tunnel or installer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");
const repo = path.resolve(__dirname, "../..");
const base = path.join(repo, ".validation", "aura-dynamic-opt-20261105");
const baselineScene = path.join(base, "baseline", "scene.js");
const currentScene = path.join(repo, "desktop", "renderer", "v3", "aura", "scene.js");
const reportPath = path.join(base, "gpu-comparison.json");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "aura-opt-"));
app.setPath("appData", fixture);
app.setPath("userData", path.join(fixture, "web-harness-test"));
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.commandLine.appendSwitch("use-angle", "d3d11");
let win;
const timeout = setTimeout(() => { console.error("GPU_COMPARE_TIMEOUT"); app.exit(1); }, 65000);
async function sourceEval(file) {
  await win.webContents.executeJavaScript(fs.readFileSync(file, "utf8"));
}
async function rendererCase() {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:960px;height:540px;display:block;position:absolute;inset:0;";
  document.body.appendChild(canvas);
  const scene = window.AuraScene.create(canvas);
  if (!scene) throw Error("WebGL not supported for dynamic visual test");
  await Promise.race([
    new Promise(resolve => scene.whenReady(resolve)),
    new Promise((_, reject) => setTimeout(() => reject(Error("Shader timeout")), 20000)),
  ]);
  scene.freeze(9.0);
  const minis = Array.from({length:12}, (_, i) => ({
    x: 85 + (i % 4) * 225,
    y: 80 + Math.floor(i / 4) * 190,
    r: 18, light: i % 3 ? 1 : .3,
    shift: (i % 4) * .14,
    frost: i % 3 === 0 ? .8 : 0,
    flash: i % 2 ? .25 : 0, alpha: 1,
  }));
  const args = { orb: [480, 260, 104, 1], on: 1, active: .6,
    pulse: .25, mood: [.2, .1, .1, 0], dim: 0, night: 0,
    minis, quality: 1 };
  const gl = canvas.getContext("webgl");
  const values = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    if (!scene.draw(args)) throw Error("Draw not ready");
    gl.finish();
    values.push(performance.now() - start);
  }
  scene.draw(args);
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let sum = 0; for(const v of pixels)sum+=v;
  if (sum < pixels.length / 4) throw Error("GPU frame unexpectedly blank");
  const median = [...values].sort((a,b)=>a-b)[values.length>>1];
  const max = Math.max(...values);
  const result = { width: canvas.width, height: canvas.height, medianSyncDrawMs:median,
    maxSyncDrawMs:max, totalPixels:pixels.length / 4, pixelChecksum:sum };
  if (window.baselinePixels) {
    const old = window.baselinePixels;
    if (old.length !== pixels.length) throw Error("Different canvas sizes");
    let channelDiffs = 0, maxChannelDiff = 0, sumChannelDiff = 0, changedPixels = 0;
    for (let i = 0; i < old.length; i += 4) {
      let changed = false;
      for (let c = 0; c < 4; c++) {
        const d = Math.abs(old[i+c] - pixels[i+c]);
        maxChannelDiff = Math.max(maxChannelDiff, d);
        sumChannelDiff += d;
        if (d) { changed = true; channelDiffs++; }
      }
      if (changed) changedPixels++;
    }
    result.diff = { changedPixels, channelDiffs, maxChannelDiff,
      averageChannelError:sumChannelDiff/old.length, changedPixelRate:changedPixels/(old.length/4) };
  } else { window.baselinePixels = pixels; }
  // The same shader must still produce moving hue/noise at another time.
  scene.freeze(10.5);
  scene.draw(args);
  const later = new Uint8Array(pixels.length);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, later);
  let dynamicChangedPixels = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== later[i] || pixels[i+1] !== later[i+1] || pixels[i+2] !== later[i+2]) dynamicChangedPixels++;
  }
  result.dynamicChangedPixels = dynamicChangedPixels;
  if (dynamicChangedPixels < 2000) throw Error("Shader lost animated detail: "+dynamicChangedPixels);
  scene.dispose();
  canvas.remove();
  return result;
}
async function runCase(label) {
  const result = await win.webContents.executeJavaScript("(" + rendererCase.toString() + ")()");
  console.log("AURA_GPU " + label + " " + JSON.stringify(result));
  return result;
}
(async() => {
  await app.whenReady();
  win = new BrowserWindow({width:960,height:540,show:false,
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,
      offscreen:true,backgroundThrottling:false}});
  await win.loadURL("data:text/html;charset=utf-8,<html><body style='margin:0;background:white'></body></html>");
  await sourceEval(baselineScene);
  const before = await runCase("before");
  const pid = win.webContents.getOSProcessId();
  const getMemory = () => {
    const metric = app.getAppMetrics().find(m=>m.pid===pid);
    const info = metric?.memory||{};
    return { privateMiB:typeof info.privateBytes==="number" ? info.privateBytes/1024 : null,
      workingMiB:typeof info.workingSetSize==="number" ? info.workingSetSize/1024 : null };
  };
  const afterBaseline = getMemory();
  await sourceEval(currentScene);
  const after = await runCase("after");
  const afterOpt = getMemory();
  const result = {scope:"isolated-Electron-WebGL", baselineFile:baselineScene, optimizedFile:currentScene,
    devicePixels:before.totalPixels, before, after, afterBaseline, afterOpt,
    medianSpeedup:before.medianSyncDrawMs / after.medianSyncDrawMs,
    note:"Synchronous draw+gl.finish timings are local samples, not system-wide GPU performance; small samples are noisy.",
    passed:true};
  assert.ok(after.diff.averageChannelError < 0.025, "Excessive mean pixel deviation: "+JSON.stringify(after.diff));
  assert.ok(after.diff.maxChannelDiff <= 2, "Unexpected large per-channel visual deviation: "+JSON.stringify(after.diff));
  fs.writeFileSync(reportPath,JSON.stringify(result,null,2));
  console.log("AURA_GPU_COMPARE " + JSON.stringify(result));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
})().catch(error=>{
  console.error("AURA_GPU_COMPARE_FAILED",error.stack||error);
  clearTimeout(timeout);
  try{win?.destroy();}catch(_){}
  app.exit(1);
});
