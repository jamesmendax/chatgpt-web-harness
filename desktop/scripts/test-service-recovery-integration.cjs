"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const accountContext = require("../src/account-context");
const { OwnedServiceRecovery } = require("../src/service-recovery");

function setup(options = {}) {
  const h = { starts: [], stops: [], pid: 60000, timers: new Map(), nextTimer: 0,
    networkOffline: false, portOccupied: false, probeGate: null, notes: [], revocations: [] };
  class FakeProcess extends EventEmitter {
    constructor(name) { super(); Object.assign(this, { name, alive: false, pid: null, startedAt: null, state: "stopped", lastExit: null }); }
    isAlive() { return this.alive; }
    start(spec) { this.alive = true; this.pid = ++h.pid; this.startedAt = Date.now(); this.state = "starting";
      h.starts.push({ name: this.name, pid: this.pid, spec, account: accountContext.current()?.id }); return this.pid; }
    markRunning() { this.state = "running"; }
    async stop() { h.stops.push(this.name); this.alive = false; this.state = "stopped"; this.pid = null; }
    crash() { const startedAt = this.startedAt; this.alive = false; this.pid = null; this.state = "error";
      this.emit("unexpected-exit", { intentional: false, startedAt, code: 1 }); }
  }
  const cfg = { setupDone: true, mcpPort: 39990, adminPort: 39991, tunnelPort: 39992,
    workspacePath: path.join(os.tmpdir(), "resilience-fixture"), toolProfile: "slim", tunnelId: "fixture", tunnelProxyMode: "direct" };
  const status = {
    async probeMcp() { if (h.probeGate) await h.probeGate; return h.service?.mcp.alive ? { runtime: { pid: h.service.mcp.pid, build_id: "fixture" } } : null; },
    async probeTunnel() { return { reachable: !!h.service?.tunnel.alive, ready: !!h.service?.tunnel.alive,
      cloudState: h.networkOffline ? "network_error" : "online", metaError: h.networkOffline ? { code: "network" } : null }; },
    async classifyPortOwner() { return { pid: h.portOccupied ? 123456789 : null, error: null, info: { name: "foreign-fixture" } }; },
  };
  const forbidden = () => { throw new Error("Unexpected external operation"); };
  const deps = {
    events: { EventEmitter }, fs: {
      existsSync: () => options.bundleExists !== false,
      statSync: () => ({ size: options.bundleSize || 31144960 }),
    }, path, child_process: { spawn: forbidden },
    "./processes": { ManagedProcess: FakeProcess, killTree: forbidden, sleep: async () => {} },
    "./service-recovery": { OwnedServiceRecovery }, "./status": status,
    "./tunnel-health": { parseManagedDiagnostic: () => null },
    "./harness": { ensureDotEnv() {}, mcpSpawnSpec: () => ({ kind: "mcp-fixture" }),
      tunnelSpawnSpec: async () => ({ kind: "tunnel-fixture", proxyInfo: { mode: "direct", source: "test" } }) },
    "./paths": { distEntry: () => "fixture-dist", ensureRuntimeDir() {}, async ensureBrowserUseRuntime() {}, tunnelClientPath: () => "fixture-tunnel",
      codeRoot: () => "fixture", runtimeDir: () => "fixture", logsDir: () => "fixture" },
    "./config": { load: () => ({ ...cfg }), publicView: (value) => value, decryptKey: () => "invalid-fixture-not-a-key" },
    "./app-profile": { profile: { isolated: true } }, "./account-context": accountContext, "./shell-util": {},
    "./computer-use-runtime": { revoke: () => h.revocations.push({ provider: "computer-use", account: accountContext.current()?.id || "default" }) },
  };
  const file = path.resolve(__dirname, "../src/services.js");
  const mod = { exports: {} };
  vm.compileFunction(fs.readFileSync(file, "utf8"), ["require", "module", "exports"], { filename: file })(
    (name) => { if (!(name in deps)) throw new Error("Unmocked dependency: " + name); return deps[name]; }, mod, mod.exports);
  h.service = options.accountScope
    ? accountContext.run(options.accountScope, () => new mod.exports.Services())
    : new mod.exports.Services();
  h.cfg = cfg;
  h.service.note = (text) => h.notes.push(text);
  h.service.waitFor = async (check) => check();
  for (const r of Object.values(h.service.recovery)) {
    r.random = () => 0.5;
    r.setTimer = (fn) => { const id = ++h.nextTimer; h.timers.set(id, fn); return id; };
    r.clearTimer = id => h.timers.delete(id);
  }
  h.fire = async () => { const item = h.timers.entries().next().value; assert.ok(item); h.timers.delete(item[0]); await item[1](); };
  return h;
}

test("actual Services wiring recovers only the crashed owned MCP; tunnel PID is unchanged", async () => {
  const h = setup(); await h.service.startAll();
  const oldMcp = h.service.mcp.pid, oldTunnel = h.service.tunnel.pid;
  h.service.mcp.crash(); assert.equal(h.timers.size, 1); await h.fire();
  assert.notEqual(h.service.mcp.pid, oldMcp); assert.equal(h.service.mcp.isAlive(), true);
  assert.equal(h.service.tunnel.pid, oldTunnel);
  assert.deepEqual(h.starts.map(x => x.name), ["mcp", "tunnel", "mcp"]);
  assert.deepEqual(h.stops, []); await h.service.shutdown(); assert.equal(h.timers.size, 0);
});
test("actual Services leaves both PIDs alive across repeated failed cloud health polls", async () => {
  const h = setup(); await h.service.startAll(); const pids = [h.service.mcp.pid, h.service.tunnel.pid];
  h.networkOffline = true;
  for (let i = 0; i < 10; i++) assert.equal((await h.service.collectStatus()).tunnel.cloudState, "network_error");
  assert.deepEqual([h.service.mcp.pid, h.service.tunnel.pid], pids);
  assert.equal(h.timers.size, 0); assert.equal(h.starts.length, 2); assert.equal(h.stops.length, 0);
  h.networkOffline = false; assert.equal((await h.service.collectStatus()).tunnel.cloudState, "online");
  await h.service.shutdown();
});
test("intentional stop cancels a queued recovery", async () => {
  const h = setup(); await h.service.startMcp(); h.service.mcp.crash();
  assert.equal(h.timers.size, 1); await h.service.stopMcp();
  assert.equal(h.timers.size, 0); assert.equal(h.starts.length, 1);
  assert.equal(h.service.recovery.mcp.snapshot().enabled, false);
});
test("stop during async preflight prevents late spawning", async () => {
  const h = setup(); let release; h.probeGate = new Promise(r => { release = r; });
  const pending = h.service.startMcp(); await Promise.resolve(); await h.service.stopMcp();
  h.probeGate = null; release(); await assert.rejects(pending, /cancelled/);
  assert.deepEqual(h.starts, []); assert.equal(h.timers.size, 0);
});
test("changed configuration cannot redirect a queued recovery to another runtime", async () => {
  const h = setup(); await h.service.startMcp(); h.service.mcp.crash(); h.cfg.mcpPort++;
  await h.fire(); assert.equal(h.starts.length, 1);
  assert.equal(h.service.recovery.mcp.snapshot().state, "blocked");
});
test("fresh foreign port ownership blocks restart without takeover or termination", async () => {
  const h = setup(); await h.service.startMcp(); h.service.mcp.crash(); h.portOccupied = true;
  await h.fire(); assert.equal(h.starts.length, 1); assert.equal(h.stops.length, 0);
  assert.equal(h.service.recovery.mcp.snapshot().attempts, 1); await h.service.stopMcp();
});
test("actual recovery startup preserves account A when UI work executes under account B", async () => {
  const h = setup(); const a = { id: "a".repeat(32), dataDir: path.join(os.tmpdir(), "fixture-account-a") };
  const b = { id: "b".repeat(32), dataDir: path.join(os.tmpdir(), "fixture-account-b") };
  await accountContext.run(a, () => h.service.startMcp());
  h.service.mcp.crash(); await accountContext.run(b, () => h.fire());
  assert.deepEqual(h.starts.map(x => x.account), [a.id, a.id]);
  await h.service.shutdown();
});
test("MCP exit and shutdown revoke computer-use capability in the service owner account", async () => {
  const a = { id: "a".repeat(32), dataDir: path.join(os.tmpdir(), "fixture-account-a") };
  const b = { id: "b".repeat(32), dataDir: path.join(os.tmpdir(), "fixture-account-b") };
  const h = setup({ accountScope: a });
  await accountContext.run(a, () => h.service.startMcp());
  accountContext.run(b, () => h.service.mcp.crash());
  assert.deepEqual(h.revocations, [
    { provider: "computer-use", account: a.id },
  ]);
  h.revocations.length = 0;
  await accountContext.run(b, () => h.service.shutdown());
  assert.deepEqual(h.revocations, [
    { provider: "computer-use", account: a.id },
  ]);
});
test("unreadable recovery configuration fails closed rather than crashing a timer", () => {
  const r = new OwnedServiceRecovery({ name: "fixture", isAlive: () => false, isBusy: () => false,
    restart: async () => { throw new Error("must not run"); } });
  r.arm({ valid: () => { throw new Error("fixture config denied"); } });
  assert.doesNotThrow(() => r.onUnexpectedExit());
  assert.equal(r.snapshot().state, "blocked");
});

test("tunnel bootstrap returns the verified bundled executable without a network fallback", async () => {
  const h = setup({ bundleSize: 12345 }); const progress = [];
  assert.equal(await h.service.downloadTunnelClient((item) => progress.push(item)), "fixture-tunnel");
  assert.deepEqual(progress, [{ received: 12345, total: 12345 }]);
});

test("missing bundled tunnel executable fails closed instead of silently downloading an older client", async () => {
  const h = setup({ bundleExists: false });
  await assert.rejects(h.service.downloadTunnelClient(), /不会自动下载旧版客户端/);
});

test("a stale tunnel authentication error does not block recovery once a later poll succeeded", async () => {
  const h = setup(); await h.service.startAll();
  h.service.tunnelDiagnostics.push({ kind: "authError", at: Date.now() - 60_000 });
  h.service.notePollSuccess(Date.now() - 1_000);
  h.service.tunnel.crash();
  assert.equal(h.timers.size, 1, "recovery must be scheduled after the credentials were proven");
  await h.fire(); assert.equal(h.service.tunnel.isAlive(), true);
  // An authentication error newer than every successful poll still blocks automatic restarts.
  h.service.tunnelDiagnostics.push({ kind: "authError", at: Date.now() + 1 });
  h.service.tunnel.crash();
  assert.equal(h.timers.size, 0);
  await h.service.shutdown();
});
test("an MCP child that dies before it is healthy fails at once and frees the start slot", async () => {
  const h = setup();
  h.service.waitFor = Object.getPrototypeOf(h.service).waitFor; // the real loop; sleep is a no-op here
  const start = h.service.mcp.start.bind(h.service.mcp);
  h.service.mcp.start = (spec) => { const pid = start(spec); h.service.mcp.alive = false; h.service.mcp.state = "error"; return pid; };
  const started = Date.now();
  await assert.rejects(h.service.startMcp(), /就绪前退出/);
  assert.ok(Date.now() - started < 3_000, "no 45 s wait for a dead child");
  assert.equal(h.service.startingServices.size, 0);
  await h.service.shutdown();
});
test("stopAll and shutdown still stop MCP and revoke its capabilities when the tunnel refuses to exit", async () => {
  const refuse = async () => { throw new Error("tunnel did not exit"); };
  const h = setup(); await h.service.startAll();
  const stop = h.service.tunnel.stop.bind(h.service.tunnel);
  h.service.tunnel.stop = refuse;
  await assert.rejects(h.service.stopAll(), /tunnel did not exit/);
  assert.equal(h.service.mcp.isAlive(), false, "stopAll stopped MCP");
  h.service.tunnel.stop = stop; await h.service.shutdown();
  const g = setup(); await g.service.startAll();
  const gStop = g.service.tunnel.stop.bind(g.service.tunnel);
  g.service.tunnel.stop = refuse;
  const revoked = g.revocations.length;
  await assert.rejects(g.service.shutdown(), /tunnel did not exit/);
  assert.equal(g.service.mcp.isAlive(), false, "shutdown stopped MCP");
  assert.ok(g.revocations.length > revoked, "shutdown revoked MCP capabilities");
  await gStop();
});
