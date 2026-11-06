"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRendererMemoryGuard, DEFAULTS } = require("../src/renderer-memory-guard");
const { auraUrl, isTrustedIpcSource, installNavigationGuard } = require("../src/ipc-source");
const { EventEmitter } = require("node:events");

function stats(pid, privateMiB, workingMiB = privateMiB) {
  return [{ pid, type: "Tab", memory: { privateBytes: privateMiB * 1024, workingSetSize: workingMiB * 1024 } }];
}

test("a 10 GiB renderer crosses the hard emergency threshold immediately", () => {
  const guard = createRendererMemoryGuard();
  const event = guard.sample(53148, stats(53148, 10314, 9115));
  assert.equal(event.action, "recycle-renderer");
  assert.equal(event.privateMiB, 10314);
  assert.equal(event.workingMiB, 9115);
  assert.equal(guard.sample(53148, stats(53148, 10314)).action, null);
});
test("Electron GPU-process private bytes are monitored independently of renderer private bytes", () => {
  const gpu = createRendererMemoryGuard({ warningMiB: 1024, criticalMiB: 1536, hardMiB: 2048 });
  const metrics = size => [
    { pid: 100, type: "Tab", memory: { privateBytes: 180 * 1024 } },
    { pid: 555, type: "GPU", memory: { privateBytes: size * 1024 } },
  ];
  assert.equal(gpu.sample(555, metrics(430)).action, null);
  assert.equal(gpu.sample(555, metrics(1025)).action, null);
  assert.equal(gpu.sample(555, metrics(1050)).action, "reduce-gpu-load");
  assert.equal(gpu.sample(555, metrics(1540)).action, null);
  assert.equal(gpu.sample(555, metrics(1600)).action, "recycle-renderer");
  assert.equal(gpu.sample(555, metrics(2500)).action, null, "do not restart the GUI indefinitely");
  assert.equal(gpu.sample(556, [{ pid: 556, type: "GPU", memory: { privateBytes: 2500 * 1024 } }]).action, "recycle-renderer");
  assert.equal(gpu.sample(100, metrics(2500)).action, null, "never mistake GPU memory for the renderer PID");
});

test("only the exact current renderer PID and Win32 privateBytes qualify", () => {
  const guard = createRendererMemoryGuard();
  assert.equal(guard.sample(100, stats(29092, 10314)), null);
  assert.equal(guard.sample(100, [{ pid: 100, memory: { workingSetSize: 9_000_000 } }]), null);
  assert.equal(guard.sample(0, stats(0, 10314)), null);
  assert.equal(guard.sample(-1, stats(-1, 10314)), null);
  assert.equal(guard.sample(100, null), null);
  assert.equal(guard.sample(100, stats(100, 471)).action, null);
});

test("brief transient pressure and 471 MiB healthy baseline never recycle UI", () => {
  const guard = createRendererMemoryGuard();
  for (let i = 0; i < 1000; ++i) {
    assert.equal(guard.sample(88, stats(88, 471 + (i % 10))).action, null);
  }
  assert.equal(guard.sample(88, stats(88, 1600)).action, null);
  assert.equal(guard.sample(88, stats(88, 471)).action, null);
});

test("sustained warning reduces GPU load while preserving WebGL; critical recycles once", () => {
  const guard = createRendererMemoryGuard();
  assert.equal(guard.sample(88, stats(88, 768)).action, null);
  assert.equal(guard.sample(88, stats(88, 800)).action, "reduce-gpu-load");
  assert.equal(guard.sample(88, stats(88, 1100)).action, null);
  assert.equal(guard.sample(88, stats(88, 1600)).action, null);
  assert.equal(guard.sample(88, stats(88, 1700)).action, "recycle-renderer");
  assert.equal(guard.sample(88, stats(88, 1900)).action, null);
});

test("a new renderer PID receives a fresh independent safety budget", () => {
  const guard = createRendererMemoryGuard();
  guard.sample(10, stats(10, 10314));
  assert.equal(guard.sample(11, stats(11, 900)).action, null);
  assert.equal(guard.sample(11, stats(11, 900)).action, "reduce-gpu-load");
  assert.equal(guard.sample(10, stats(10, 10314)).action, "recycle-renderer");
});

test("a clean sample breaks consecutive pressure streak", () => {
  const guard = createRendererMemoryGuard();
  assert.equal(guard.sample(90, stats(90, 1500)).action, null);
  assert.equal(guard.sample(90, stats(90, 470)).action, null);
  assert.equal(guard.sample(90, stats(90, 1500)).action, null);
  assert.equal(guard.sample(90, stats(90, 1500)).action, "reduce-gpu-load");
});

test("fail closed on invalid thresholds and undocumented counter shapes", () => {
  assert.throws(() => createRendererMemoryGuard({ warningMiB: 1900, criticalMiB: 800 }));
  const guard = createRendererMemoryGuard();
  assert.equal(guard.sample(100, [{ pid: 100, memory: { privateBytes: NaN } }]), null);
  assert.equal(guard.sample(100, [{ pid: 100, memory: { privateBytes: -42 } }]), null);
  assert.equal(DEFAULTS.hardMiB, 2048);
});

test("dynamic safe-graphics origin retains strict IPC/navigation allow-list", () => {
  const base = auraUrl(path.resolve("fixture", "index.html"));
  const safe = base + "&safeGraphics=1";
  let permitted = base;
  const wc = new EventEmitter();
  const frame = { url: base };
  Object.assign(wc, { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false });
  const window = { isDestroyed: () => false, webContents: wc };
  const event = { sender: wc, senderFrame: frame };
  installNavigationGuard(wc, () => permitted);
  const prevent = url => {
    let blocked = false;
    wc.emit("will-navigate", { url, preventDefault() { blocked = true; } });
    return blocked;
  };
  assert.equal(prevent(base), false);
  assert.equal(prevent(safe), true);
  permitted = safe;
  frame.url = safe;
  assert.equal(prevent(base), true);
  assert.equal(prevent(safe), false);
  assert.equal(prevent(safe + "#attacker"), true);
  assert.equal(prevent(safe + "&extra=1"), true);
  assert.equal(isTrustedIpcSource(event, window, safe), true);
  frame.url = safe + "&sheet=logs";
  assert.equal(isTrustedIpcSource(event, window, safe), true);
  frame.url = safe + "&sheet=attacker";
  assert.equal(isTrustedIpcSource(event, window, safe), false);
});

test("Aura safety hooks are present and protected services are untouched", () => {
  const main = fs.readFileSync(path.resolve(__dirname, "../src/main.js"), "utf8");
  const app = fs.readFileSync(path.resolve(__dirname, "../renderer/v3/aura/app.js"), "utf8");
  const scene = fs.readFileSync(path.resolve(__dirname, "../renderer/v3/aura/scene.js"), "utf8");
  assert.match(main, /getOSProcessId\(\)/);
  assert.match(main, /app\.getAppMetrics\(\)/);
  assert.match(main, /m\?\.type === "GPU"/);
  assert.match(main, /gpuMemoryGuard\.sample/);
  assert.match(main, /forcefullyCrashRenderer\(\)/);
  assert.match(main, /safeGraphics:\s*"1"/);
  assert.match(main, /rendererMemoryTimer = setInterval\(inspectRendererMemory, 3_000\)/);
  assert.match(main, /appendSwitch\("js-flags", "--max-old-space-size=1024"\)/, "renderer V8 heap backstop between samples");
  assert.match(main, /gpuMemoryGuard\.reset\(\)/, "restoring dynamic graphics re-arms the GPU guard");
  assert.match(app, /graphicsBlocked = params\.has\("safeGraphics"\)/);
  assert.match(app, /sceneOwner\.enable\(!graphicsBlocked && qualityChoice !== "static"\)/);
  assert.match(app, /globalThis\.AuraMemoryGuard/);
  assert.match(app, /sceneOwner\.enable\(false\)/);
  assert.match(scene, /WEBGL_lose_context/);
  assert.match(scene, /preserveDrawingBuffer: false/);
  assert.match(app, /LOG_STORY_CAP = 600, LOG_RAW_CAP = 800/);
});
