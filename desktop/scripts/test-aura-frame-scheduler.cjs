"use strict";
// Execute the real Aura animation/workspace code with a virtual browser clock.
// No copied scheduler, browser process, production IPC or live account data.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const sourceArg = process.argv.indexOf("--source-dir");
const sourceDir = sourceArg < 0 ? path.resolve(__dirname, "../renderer/v3/aura") : path.resolve(process.argv[sourceArg + 1]);
const appSource = fs.readFileSync(path.join(sourceDir, "app.js"), "utf8");
const sceneSource = fs.readFileSync(path.join(sourceDir, "scene.js"), "utf8");
const qualityContext = {};
vm.runInNewContext(fs.readFileSync(path.join(sourceDir, "quality.js"), "utf8"), qualityContext);
const Quality = qualityContext.AuraQuality;
const Motion = require(path.join(sourceDir, "motion.js"));
console.log("Aura source SHA256 " + crypto.createHash("sha256").update(appSource).digest("hex"));
console.log("Scene source SHA256 " + crypto.createHash("sha256").update(sceneSource).digest("hex"));

function section(start, end) {
  const a = appSource.indexOf(start), b = appSource.indexOf(end, a);
  assert.ok(a >= 0 && b > a, "Production source section exists: " + start);
  return appSource.slice(a, b);
}
const runtime = [
  section("  function spring(", "  /* ===================== scene:"),
  section("  const P = ", "  /* ===================== appearance:"),
  appSource.split("\n").find(line => line.startsWith("  const night = ")),
  section("  function presenceTarget()", "  /* ===================== view switching"),
  section("  function liveSentence(", "  function badge("),
  section('  core.on("activity",', "  function placePop("),
  "globalThis.subject = { kick, placePresence, orbLook, renderWorkspace };"
].join("\n");

function clock() {
  let now = 1000, serial = 0;
  const tasks = new Map();
  const add = (kind, fn, delay) => {
    const id = ++serial;
    tasks.set(id, { id, kind, fn, at: now + delay });
    return id;
  };
  return {
    now: () => now,
    raf: fn => add("raf", fn, 1000 / 60),
    timeout: (fn, ms) => add("timeout", fn, Math.max(0, ms || 0)),
    cancel: id => tasks.delete(id),
    pending: () => tasks.size,
    advance(ms) {
      const until = now + ms;
      let steps = 0;
      for (;;) {
        const next = [...tasks.values()].sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next || next.at > until) break;
        assert.ok(++steps < 20000, "Virtual scheduler has a bounded callback count");
        now = next.at; tasks.delete(next.id);
        next.fn(next.kind === "raf" ? now : undefined);
      }
      now = until;
    }
  };
}
function events() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    emit(name, payload) { for (const fn of listeners.get(name) || []) fn(payload); }
  };
}
function harness({ reduced = false, still = false, tier = "high", drawFaults = 0 } = {}) {
  const time = clock(), draws = [], nodes = new Map(), activity = new Map(), rebases = [];
  let faults = drawFaults, scenes = 0, clockBase = time.now();
  const rootClasses = new Set();
  const document = Object.assign(events(), { hidden: false, documentElement: { dataset: {}, classList: {
    add: name => rootClasses.add(name), remove: name => rootClasses.delete(name),
    toggle: (name, on) => (on ? rootClasses.add(name) : rootClasses.delete(name)), contains: name => rootClasses.has(name) } } });
  const windowEvents = events();
  const RM = Object.assign(events(), { matches: reduced });
  const rect = { left: 80, top: 80, width: 160, height: 160, bottom: 240 };
  function element(key) {
    if (!nodes.has(key)) nodes.set(key, {
      dataset: {}, style: {}, hidden: false, isConnected: true, parentElement: document.body,
      offsetParent: {}, offsetLeft: 0, offsetWidth: 20,
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      getBoundingClientRect: () => rect,
      closest: () => null,
      querySelector: selector => element(key + " " + selector)
    });
    return nodes.get(key);
  }
  document.body = element("body");
  const orb = element("small-orb"); orb.dataset.orb = "fixture";
  document.querySelectorAll = selector => selector === "[data-orb]" ? [orb] : [];
  const state = {
    account: {
      name: "Fixture",
      config: { setupDone: true, mcpPort: 3400, workspacePath: "fixture" },
      mcp: { healthy: true, managed: true, state: "running", toolCount: 30 },
      tunnel: { ready: true, state: "running" }
    },
    derived: {
      cloudOnline: true, busy: false,
      mcpBadge: { tone: "ok", text: "Ready" }, tunnelBadge: { tone: "ok", text: "Ready" },
      stages: { cloud: { tone: "ok", label: "Connected" } }, mcp: {}, tunnel: {}
    },
    pending: new Set(), activity: [], info: { isolated: true }
  };
  const ui = { view: "workspace", liveKey: "", lastSig: {} };
  const makeScene = () => ({
    id: ++scenes,
    freeze() {},
    whenReady(fn) { fn(); return () => {}; },
    clock: () => (time.now() - clockBase) / 1000,
    rebase(limit = 0) { if ((time.now() - clockBase) / 1000 <= limit) return false; clockBase = time.now(); rebases.push(limit); return true; },
    draw(value) {
      if (faults > 0) { faults--; throw new Error("fixture draw fault"); }
      draws.push({ at: time.now(), ...value }); return true;
    }
  });
  const scene = makeScene();
  const context = {
    document, RM, ui, scene, console: { error() {} },
    AuraQuality: Quality, AuraMotion: Motion, qualityChoice: tier, graphicsBlocked: false, graphicsBlockedBy: null, closingGraphics: false,
    curtainChoice: null, curtainEnabled: () => tier === "high" || tier === "ultra",
    currentTier: () => Quality.tiers[tier], motionStopped: () => RM.matches || tier === "static",
    sceneOwner: { status: () => ({ live: context.scene ? 1 : 0, created: scenes }), enable: on => on ? makeScene() : null },
    renderGraphicsGuard() {}, cancelSceneReady: null,
    params: new URLSearchParams(still ? "still" : ""),
    requestAnimationFrame: time.raf, cancelAnimationFrame: time.cancel,
    setTimeout: time.timeout, clearTimeout: time.cancel,
    performance: { now: time.now }, Date: { now: () => 1700000000000 + time.now() },
    addEventListener: windowEvents.addEventListener,
    $: element, $$: () => [], innerHeight: 900,
    getComputedStyle: () => ({ opacity: "1" }),
    theme: { choice: "light" }, themeOf: () => "light", themeBar: null,
    text: (el, value) => { el.textContent = String(value); },
    badge() {}, kv() {}, renderHistory() {}, renderSpectrum() {}, refreshSkills() {},
    relative: () => "just now", hms: String,
    core: {
      snapshot: () => state,
      on: (name, fn) => activity.set(name, fn),
      describe: () => ({ verb: "reading" })
    }
  };
  vm.runInNewContext(runtime, context, { filename: "aura-production-frame-sections.js", timeout: 1000 });
  context.subject.placePresence(true); context.subject.kick();
  return {
    time, draws, document, RM, orb, state, subject: context.subject, tier: Quality.tiers[tier],
    memoryGuard: context.AuraMemoryGuard, context, rebases,
    setClock: seconds => { clockBase = time.now() - seconds * 1000; },
    emitActivity: payload => activity.get("activity")(payload)
  };
}

test("memory-warning dynamic GPU budget retains the orb shader and animation", () => {
  const h = harness();
  h.time.advance(8000);
  assert.equal(h.memoryGuard.status().animated, true);
  assert.equal(h.memoryGuard.status().quality, 1);
  const before = h.draws.length;
  assert.equal(h.memoryGuard.reduceLoad(), true);
  assert.equal(h.memoryGuard.status().animated, true, "WebGL must not be disabled at warning");
  assert.equal(h.memoryGuard.status().quality, .7);
  assert.equal(h.memoryGuard.status().memoryPressure, true);
  h.time.advance(200);
  assert.ok(h.draws.length > before, "Real dynamic render must still run after warning");
  assert.equal(h.draws.at(-1).quality, .7);
  h.time.advance(8000);
  const settled = h.draws.length;
  h.time.advance(1000);
  assert.ok(h.draws.length - settled <= h.tier.idleFps, "Memory warning must not create a new busy RAF loop");
});

test("dynamic-quality governor uses discrete levels and a cooldown to avoid buffer thrash", () => {
  let now = 1000;
  const context = { performance: { now: () => now } };
  const source = section("  const QUALITY_LEVELS = ", "  let raf = 0");
  vm.runInNewContext(source + "\nglobalThis.governorForTest = governor;", context, { timeout: 1000 });
  const gov = context.governorForTest;
  for (let i = 0; i < 75; ++i) gov.step(.034);
  assert.equal(gov.q, .85);
  for (let i = 0; i < 75; ++i) gov.step(.034);
  assert.equal(gov.q, .85, "No second canvas resize before four seconds");
  now += 4500;
  for (let i = 0; i < 75; ++i) gov.step(.034);
  assert.equal(gov.q, .7);
  now += 4500;
  for (let i = 0; i < 75; ++i) gov.step(.008);
  assert.equal(gov.q, .85, "Recovery steps once to the next stable resolution");
  gov.reduceLoad();
  assert.equal(gov.q, .7);
  now += 5000;
  for (let i = 0; i < 75; ++i) gov.step(.008);
  assert.equal(gov.q, .7, "Under memory pressure do not re-allocate higher resolution again");
});

test("idle Aura respects the chosen frame budget without lowering quality for deliberate gaps", t => {
  const h = harness();
  h.time.advance(8000);
  const before = h.draws.length;
  h.time.advance(1000);
  const idleFrames = h.draws.length - before;
  assert.ok(idleFrames <= h.tier.idleFps, "Idle drew " + idleFrames + " frames in one second");
  assert.ok(h.time.pending() <= 1, "Only one animation task can be queued");
  h.time.advance(60000);
  assert.equal(h.draws.at(-1).quality, 1, "Idle cadence is not GPU latency");
  t.diagnostic("Idle frames in one second: " + idleFrames);
});

test("real orb changes wake promptly, coalesce wake requests and return to idle", () => {
  const h = harness();
  h.time.advance(8000);
  const before = h.draws.length;
  h.subject.orbLook(h.orb, { light: 1, flash: true });
  for (let i = 0; i < 100; i++) h.subject.kick();
  assert.equal(h.time.pending(), 1, "An idle timer and RAF must not overlap");
  h.time.advance(200);
  assert.ok(h.draws.length - before >= 8, "State transitions keep responsive animation");
  h.time.advance(8000);
  assert.equal(h.orb._o.light, 1);
  assert.equal(h.orb._o.flash, 0);
  const settled = h.draws.length;
  h.time.advance(1000);
  assert.ok(h.draws.length - settled <= h.tier.idleFps, "The transition must finish");
});

for (const wait of [0, 8000]) test("hiding cancels " + (wait ? "idle timers" : "active frames") + " and showing resumes once", () => {
  const h = harness();
  h.time.advance(wait);
  h.document.hidden = true; h.document.emit("visibilitychange");
  assert.equal(h.time.pending(), 0, "Hidden windows must cancel queued animation work");
  const before = h.draws.length;
  for (let i = 0; i < 10; i++) h.subject.kick();
  h.time.advance(10000);
  assert.equal(h.time.pending(), 0);
  assert.equal(h.draws.length, before, "Hidden wake requests must not draw");
  h.document.hidden = false; h.document.emit("visibilitychange");
  assert.equal(h.time.pending(), 1);
  h.time.advance(100);
  assert.ok(h.draws.length > before, "Visible windows must repaint");
});

for (const options of [{ still: true }, { reduced: true }]) test((options.still ? "still" : "reduced motion") + " has a finite transition tail and can be woken again", () => {
  const h = harness(options);
  h.subject.orbLook(h.orb, { light: 1, flash: true });
  h.time.advance(8000);
  assert.equal(h.time.pending(), 0, "Static modes must finish their transition");
  const before = h.draws.length;
  h.time.advance(10000);
  assert.equal(h.draws.length, before);
  h.document.emit("scroll"); h.document.emit("scroll");
  assert.equal(h.time.pending(), 1);
  h.time.advance(8000);
  assert.ok(h.draws.length > before);
  assert.equal(h.time.pending(), 0);
});

test("one-second workspace refreshes do not wake an unchanged scene; changed state still renders", () => {
  const h = harness({ still: true });
  h.subject.renderWorkspace(h.state);
  h.time.advance(8000);
  const before = h.draws.length;
  for (let i = 0; i < 6; i++) {
    h.subject.renderWorkspace(h.state);
    h.time.advance(1000);
  }
  assert.equal(h.draws.length, before, "Clock/status refresh must not restart RAF");
  h.state.derived.cloudOnline = false;
  h.subject.renderWorkspace(h.state);
  h.time.advance(8000);
  assert.ok(h.draws.length > before);
  assert.equal(h.draws.at(-1).on, .55);
  assert.equal(h.time.pending(), 0);
});

test("reduced-motion completion feedback expires even after normal idle frames stop", () => {
  const h = harness({ reduced: true });
  h.time.advance(8000);
  h.emitActivity({ kind: "end", record: { tool: "read_text_file" } });
  h.time.advance(100);
  assert.equal(h.draws.at(-1).active, 1);
  h.time.advance(8000);
  assert.equal(h.draws.at(-1).active, 0, "The finite activity hold must reach its deadline");
  assert.equal(h.time.pending(), 0);
});

test("changing reduced-motion preference stops and resumes decorative idle frames", () => {
  const h = harness();
  h.time.advance(8000);
  h.RM.matches = true; h.RM.emit("change");
  h.time.advance(8000);
  assert.equal(h.time.pending(), 0);
  const before = h.draws.length;
  h.RM.matches = false; h.RM.emit("change");
  h.time.advance(1000);
  assert.ok(h.draws.length > before, "A preference change must wake the scene");
});

test("a throwing frame never wedges the scheduler; three in a row fall back to the static UI", () => {
  const once = harness({ drawFaults: 1 });
  once.time.advance(300);
  assert.ok(once.draws.length > 0, "the frame after a single fault must still draw");
  assert.equal(once.memoryGuard.status().blocked, false);
  assert.equal(once.memoryGuard.status().frameFaults, 0, "a good frame clears the fault streak");
  once.time.advance(8000);
  assert.ok(once.time.pending() <= 1, "fault recovery must not add a second frame task");
  const broken = harness({ drawFaults: 1000 });
  broken.time.advance(3000);
  const state = broken.memoryGuard.status();
  assert.equal(state.blocked, true); assert.equal(state.blockedBy, "frame");
  assert.equal(broken.time.pending(), 0, "a failing scene must not keep a frame task alive");
  assert.equal(broken.draws.length, 0);
});

test("a lost WebGL context is rebuilt; a third loss within ten minutes keeps the static UI", () => {
  const h = harness();
  h.time.advance(1000);
  assert.equal(h.memoryGuard.contextLost(), true);
  let state = h.memoryGuard.status();
  assert.equal(state.blocked, false); assert.equal(state.restorePending, true);
  assert.equal(state.resources.live, 0); assert.equal(h.time.pending(), 1, "only the restore timer remains");
  h.time.advance(2100);
  state = h.memoryGuard.status();
  assert.equal(state.restorePending, false); assert.equal(state.resources.live, 1, "a fresh scene replaces the lost one");
  const before = h.draws.length;
  h.time.advance(500);
  assert.ok(h.draws.length > before, "the rebuilt scene animates");
  h.memoryGuard.contextLost(); h.time.advance(4100);
  assert.equal(h.memoryGuard.status().blocked, false, "a second loss is still rebuilt");
  assert.equal(h.memoryGuard.status().resources.live, 1);
  h.memoryGuard.contextLost();
  state = h.memoryGuard.status();
  assert.equal(state.blocked, true); assert.equal(state.blockedBy, "context"); assert.equal(state.restorePending, false);
  h.time.advance(10000);
  assert.equal(h.time.pending(), 0); assert.equal(h.memoryGuard.status().resources.live, 0);
});

test("float32 shader clocks restart only where the jump cannot be seen", () => {
  const h = harness();
  h.time.advance(5000);
  h.document.hidden = true; h.document.emit("visibilitychange");
  h.time.advance(10 * 60 * 1000);
  h.document.hidden = false; h.document.emit("visibilitychange");
  assert.deepEqual(h.rebases, [], "a short hide keeps the running clock");
  h.document.hidden = true; h.document.emit("visibilitychange");
  h.time.advance(2 * 3600 * 1000);
  h.document.hidden = false; h.document.emit("visibilitychange");
  assert.deepEqual(h.rebases, [3600], "showing the window restarts a clock that ran while unseen");
  assert.ok(h.context.scene.clock() < 1);
  h.time.advance(2000);
  assert.deepEqual(h.rebases, [3600], "visible frames never restart a young clock");
  h.setClock(90000); h.subject.kick(); h.time.advance(100);
  assert.deepEqual(h.rebases, [3600, 86400], "an always-visible window restarts at most once a day");
});

test("the real scene does not retain the previous drawing buffer", () => {
  let attributes;
  const context = { window: {}, document: { documentElement: { classList: { add() {} } } } };
  vm.runInNewContext(sceneSource, context, { filename: "aura-production-scene.js", timeout: 1000 });
  context.window.AuraScene.create({
    getContext(kind, options) { assert.equal(kind, "webgl"); attributes = options; return null; }
  });
  assert.equal(attributes.preserveDrawingBuffer, false);
});
