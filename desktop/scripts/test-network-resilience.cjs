"use strict";
// No live account, production port, real credential or external service is used.
// Build first: npm run build
// Run: node --test desktop/scripts/test-network-resilience.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { OwnedServiceRecovery } = require("../src/service-recovery");
const accountContext = require("../src/account-context");
const ROOT = path.resolve(__dirname, "../..");
const SRC = path.resolve(__dirname, "../src");

function load(file, dependencies, globals = {}) {
  const mod = { exports: {} };
  vm.compileFunction(fs.readFileSync(file, "utf8"), ["require", "module", "exports", "process"], { filename: file })(
    (name) => { if (!(name in dependencies)) throw new Error("Unmocked dependency: " + name); return dependencies[name]; },
    mod, mod.exports, globals.process || process,
  );
  return mod.exports;
}
const forbidden = () => { throw new Error("Unexpected real-world side effect"); };
function harnessModule() {
  return load(path.join(SRC, "harness.js"), {
    fs: {}, crypto: require("node:crypto"), path, "./paths": {}, "./config": {}, "./app-profile": { profile: {} },
    "./account-context": { current: () => null }, "./isolated-runtime": {}, "./tunnel-proxy": {},
    "./companion-runtime": {}, "./computer-use-runtime": {}, "../package.json": { version: "fixture" },
  });
}
function clock() {
  return {
    now: 100000, seq: 0, queue: new Map(), delays: [],
    set(fn, ms) { const id = ++this.seq; this.queue.set(id, { fn, ms }); this.delays.push(ms); return id; },
    clear(id) { this.queue.delete(id); },
    async fire() { const item = this.queue.entries().next().value; assert.ok(item, "Expected a pending timer");
      this.queue.delete(item[0]); this.now += item[1].ms; await item[1].fn(); },
  };
}
function fixture(overrides = {}) {
  const c = clock();
  const f = { c, alive: false, busy: false, blocked: false, calls: 0, notes: [] };
  f.r = new OwnedServiceRecovery({ name: "fixture", now: () => c.now,
    setTimer: (fn, ms) => c.set(fn, ms), clearTimer: (id) => c.clear(id), random: () => 0.5,
    isAlive: () => f.alive, isBusy: () => f.busy, isBlocked: () => f.blocked,
    note: (text) => f.notes.push(text), restart: async (guard) => { assert.equal(guard(), true); f.calls++; f.alive = true; },
    ...overrides });
  return f;
}

for (const spelling of ["Path", "PATH", "pAtH"]) {
  test("preserves inherited Windows " + spelling + " without duplicate aliases", () => {
    const env = { [spelling]: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd", OTHER: "preserved" };
    harnessModule().prependWindowsPath(env, "D:\\fixture node-bin");
    assert.deepEqual(Object.keys(env).filter(k => k.toUpperCase() === "PATH"), ["PATH"]);
    assert.equal(env.PATH, "D:\\fixture node-bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd");
    assert.equal(env.OTHER, "preserved");
  });
}
test("ambiguous aliases preserve Node's effective first sorted spelling and no empty cwd entries", () => {
  const env = { Path: "wrong", PATH: "effective;;" };
  harnessModule().prependWindowsPath(env, "shim");
  assert.deepEqual(env, { PATH: "shim;effective" });
});
test("no inherited PATH is handled without an empty search-directory entry", () => {
  const env = {};
  harnessModule().prependWindowsPath(env, "shim");
  assert.deepEqual(env, { PATH: "shim" });
});
test("real Windows child can find taskkill after mixed-case PATH normalization", { skip: process.platform !== "win32" }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
  env.Path = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
  harnessModule().prependWindowsPath(env, "D:\\nonexistent-fixture-shim");
  const result = spawnSync(process.execPath, ["-e", "const r=require('node:child_process').spawnSync('taskkill',['/?'],{stdio:'ignore'}); if(r.error) throw r.error; process.exit(r.status);"], { env, timeout: 5000, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});

test("unarmed or intentionally stopped services never auto-start", async () => {
  const f = fixture(); f.r.onUnexpectedExit(); assert.equal(f.c.queue.size, 0);
  f.r.arm(); f.r.onUnexpectedExit({ intentional: true }); assert.equal(f.c.queue.size, 0);
  f.r.onUnexpectedExit(); f.r.disarm(); assert.equal(f.c.queue.size, 0); assert.equal(f.calls, 0);
});
test("actual exit triggers one bounded restart despite duplicate notifications", async () => {
  const f = fixture(); f.r.arm();
  for (let i = 0; i < 50; i++) f.r.onUnexpectedExit();
  assert.equal(f.c.queue.size, 1); assert.equal(f.c.delays[0], 1000);
  await f.c.fire(); assert.equal(f.calls, 1); assert.equal(f.r.snapshot().state, "monitoring");
  assert.equal(f.c.queue.size, 0);
});
test("brief health/network failures cannot restart a living service", () => {
  const f = fixture(); f.alive = true; f.r.arm();
  f.r.onUnexpectedExit(); f.r.schedule(); assert.equal(f.c.queue.size, 0); assert.equal(f.calls, 0);
});
test("busy startup slot defers without consuming retries", async () => {
  const f = fixture(); f.r.arm(); f.busy = true; f.r.onUnexpectedExit();
  await f.c.fire(); assert.equal(f.calls, 0); assert.equal(f.r.attempts, 0); assert.equal(f.c.queue.size, 1);
  f.busy = false; await f.c.fire(); assert.equal(f.calls, 1);
});
test("repeated failed restarts use exponential backoff and open the five-attempt circuit", async () => {
  let attempts = 0;
  const f = fixture({ restart: async () => { attempts++; throw new Error("fixture failure"); } });
  f.r.arm(); f.r.onUnexpectedExit();
  for (let i = 0; i < 5; i++) await f.c.fire();
  assert.equal(attempts, 5); assert.deepEqual(f.c.delays, [1000, 2000, 4000, 8000, 16000]);
  assert.equal(f.c.queue.size, 0); assert.equal(f.r.state, "blocked");
  assert.equal(f.r.reason, "retry_budget_exhausted");
});
test("jitter stays within bounds and successful brief launches do not reset crash budget", async () => {
  const f = fixture({ random: () => 1 }); f.r.arm(); f.r.onUnexpectedExit();
  assert.equal(f.c.delays[0], 1200); await f.c.fire();
  f.alive = false; f.r.onUnexpectedExit({ startedAt: f.c.now - 500 });
  assert.equal(f.c.delays[1], 2400);
});
test("sustained stable uptime resets the crash budget", async () => {
  const f = fixture(); f.r.arm(); f.r.onUnexpectedExit(); await f.c.fire();
  f.c.now += 61000; f.alive = false;
  f.r.onUnexpectedExit({ startedAt: f.c.now - 61000 });
  assert.equal(f.r.attempts, 0); assert.equal(f.c.delays.at(-1), 1000);
  f.r.disarm();
});
test("config changes and authentication failures block recovery before any spawn", async () => {
  const f = fixture(); let valid = true; f.r.arm({ valid: () => valid }); f.r.onUnexpectedExit(); valid = false;
  await f.c.fire(); assert.equal(f.calls, 0); assert.equal(f.r.state, "blocked");
  const g = fixture(); g.r.arm(); g.blocked = true; g.r.onUnexpectedExit();
  assert.equal(g.calls, 0); assert.equal(g.r.reason, "authentication_or_shutdown");
});
test("stop during an in-flight recovery invalidates the guard and prevents late restart", async () => {
  let release; let spawned = 0;
  const f = fixture({ restart: async (guard) => { await new Promise(r => { release = r; }); if (guard()) spawned++; } });
  f.r.arm(); f.r.onUnexpectedExit(); const pending = f.c.fire();
  await Promise.resolve(); f.r.disarm(); release(); await pending;
  assert.equal(spawned, 0); assert.equal(f.c.queue.size, 0); assert.equal(f.r.state, "disabled");
});
test("recovery re-enters the captured immutable account, not the selected UI account", async () => {
  const scope = { id: "a".repeat(32), dataDir: path.join(os.tmpdir(), "fixture-account-a") };
  let seen;
  const f = fixture({ restart: async () => { seen = accountContext.current().id; f.alive = true; } });
  f.r.arm({ run: fn => accountContext.run(scope, fn) });
  f.r.onUnexpectedExit();
  await accountContext.run({ id: "b".repeat(32), dataDir: path.join(os.tmpdir(), "fixture-account-b") }, () => f.c.fire());
  assert.equal(seen, scope.id);
});

function fakeProcesses() {
  const children = [];
  const module = load(path.join(SRC, "processes.js"), {
    child_process: { spawn() {
      const child = new EventEmitter(); child.pid = 999999; child.exitCode = null; child.signalCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.exitCode = 1; child.emit("exit", 1, null); return true; };
      children.push(child); return child;
    }, spawnSync: () => ({ error: new Error("fixture taskkill missing") }) },
    events: { EventEmitter }, fs: {}, path, "./paths": {},
  });
  const proc = new module.ManagedProcess("fixture"); proc.writeLog = () => {};
  const spec = { command: "fixture-only", args: [], env: {}, cwd: "." };
  return { proc, children, spec };
}
test("ManagedProcess emits a single owned unexpected-exit event and ignores stale callbacks", () => {
  const { proc, children, spec } = fakeProcesses(); const events = [];
  proc.on("unexpected-exit", event => events.push(event));
  proc.start(spec); const old = children[0]; old.exitCode = 1; old.emit("exit", 1, null);
  assert.equal(events.length, 1); assert.equal(events[0].intentional, false);
  proc.start(spec); old.emit("exit", 1, null); old.emit("error", new Error("late stale error"));
  assert.equal(proc.child, children[1]); assert.equal(events.length, 1);
});
test("ManagedProcess intentional stop and missing taskkill fallback do not schedule recovery", async () => {
  const { proc, spec } = fakeProcesses(); let events = 0;
  proc.on("unexpected-exit", () => events++); proc.start(spec); await proc.stop(100);
  assert.equal(events, 0); assert.equal(proc.isAlive(), false); assert.equal(proc.lastExit.intentional, true);
});

for (const missingTaskkill of [false, true]) {
  test("real timeout cleanup survives truncated PATH" + (missingTaskkill ? " and unavailable taskkill executable" : ""), { skip: process.platform !== "win32" }, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cleanup-test-"));
    try {
      const env = { ...process.env, CODEX_HOME: path.join(tmp, "codex") };
      for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH" || key.startsWith("ELECTRON_")) delete env[key];
      env.PATH = tmp;
      const moduleUrl = pathToFileURL(path.join(ROOT, "dist/lib/persistent-shell.js")).href;
      const code = `import assert from 'node:assert/strict';
        import cp from 'node:child_process';
        import {syncBuiltinESMExports} from 'node:module';
        if (${missingTaskkill}) {
          const originalSpawn = cp.spawn;
          cp.spawn = (command, args, options) => originalSpawn(
            command.toLowerCase().endsWith('taskkill.exe') ? ${JSON.stringify(path.join(tmp, "missing-taskkill.exe"))} : command,
            args, options);
          syncBuiltinESMExports();
        }
        const {execInShellSession} = await import(${JSON.stringify(moduleUrl)});
        const result = await execInShellSession('Start-Sleep -Seconds 2', process.cwd(), 200);
        assert.equal(result.timed_out, true); assert.equal(result.exit_code, null);
        const next = await execInShellSession('Write-Output AFTER_TIMEOUT', process.cwd(), 5000);
        assert.equal(next.exit_code, 0); assert.match(next.stdout, /AFTER_TIMEOUT/);
        console.log('HOST_SURVIVED_AND_NEXT_COMMAND_PASSED');`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
        env, cwd: tmp, timeout: 12000, encoding: "utf8", windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      // The nested process performs the timeout + follow-up assertions before
      // exiting 0. Under Electron/Windows test chaining its final console line
      // can occasionally be lost when stdio handles are torn down, so exit 0 is
      // the authoritative assertion rather than a redundant stdout sentinel.
      // The missing-taskkill case monkey-patches taskkill.exe to a nonexistent
      // executable. Reaching exit 0 after the timeout and follow-up command is
      // therefore itself proof that the owned-child fallback recovered. The
      // diagnostic line is advisory and can be dropped by nested Windows stdio
      // teardown, so it must not be a release-blocking assertion.
    } finally {
      // Windows can keep a just-terminated PowerShell/pipe handle alive for a
      // few scheduler ticks after spawnSync returns. The product assertion is
      // already complete above; make fixture cleanup tolerate that OS delay
      // instead of turning an EPERM on temp removal into a false test failure.
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      } catch (error) {
        if (!error || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error;
        console.warn(`[cleanup] deferred temp removal: ${error.code}`);
      }
    }
  });
}
