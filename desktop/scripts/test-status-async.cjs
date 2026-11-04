"use strict";
// No Electron, network, AppData, service processes or real termination. All
// dependencies that could leave this test harness are explicitly substituted.
// Run: node --test desktop/scripts/test-status-async.cjs
// Reproduce the read-only snapshot baseline: node desktop/scripts/test-status-async.cjs --baseline
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { performance } = require("node:perf_hooks");

const SRC = path.resolve(__dirname, "../src");
const ROOT = path.resolve(SRC, "../..");
const MCP_PORT = 33991, TUNNEL_PORT = 33992;
const MCP_PID = 41001, TUNNEL_PID = 41002, PARENT_PID = 41003;
const PATTERN = /dist[\\/]index\.js/i;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const forbidden = () => { throw new Error("Unexpected real-world dependency in status test"); };

function load(source, filename, dependencies, globals = {}) {
  const mod = { exports: {} };
  const localRequire = (name) => {
    if (!Object.hasOwn(dependencies, name)) throw new Error("Unmocked dependency: " + name);
    return dependencies[name];
  };
  vm.compileFunction(source, ["require", "module", "exports", "setTimeout", "clearTimeout", "Date"], { filename })(
    localRequire, mod, mod.exports, globals.setTimeout || setTimeout, clearTimeout, globals.Date || Date,
  );
  return mod.exports;
}

function identity(pid = MCP_PID, overrides = {}) {
  return {
    ProcessId: pid, Name: "node.exe", CommandLine: "node D:/fixture/dist/index.js",
    ParentProcessId: 0, CreationDate: "/Date(1788796800000)/", ...overrides,
  };
}

function createStatus(options = {}) {
  const h = {
    calls: [], deadlines: [], now: 1788796900000,
    listeners: new Map([[MCP_PORT, [MCP_PID]]]),
    infos: new Map([[MCP_PID, identity()]]),
    health: null, healthCalls: 0, tunnelCalls: 0,
    tunnelProbe: { reachable: false, ready: false, cloudState: "unknown" },
  };
  h.output = (call) => {
    if (call.command === "netstat") {
      return [...h.listeners].flatMap(([port, pids]) => pids.map((pid) =>
        " TCP 127.0.0.1:" + port + " 0.0.0.0:0 LISTENING " + pid)).join("\r\n");
    }
    assert.equal(call.command, "powershell.exe");
    const info = h.infos.get(call.pid);
    return info ? JSON.stringify(info) : "";
  };
  const childProcess = {
    spawn: forbidden,
    spawnSync: options.spawnSync || forbidden,
    execFile(command, args, settings, callback) {
      const call = {
        command, args, settings, kills: 0,
        pid: command === "powershell.exe" ? Number(/ProcessId=(\d+)/.exec(args.at(-1))?.[1]) : null,
        finish(error = null, out = "") { callback(error, out, ""); },
      };
      h.calls.push(call);
      if (options.onExec) options.onExec(call, h);
      else if (options.delayMs) setTimeout(() => call.finish(null, h.output(call)), options.delayMs);
      else queueMicrotask(() => call.finish(null, h.output(call)));
      return { kill() { call.kills++; } };
    },
  };
  const health = {
    async readLoopback() {
      h.healthCalls++;
      return h.health ? { status: 200, text: JSON.stringify(h.health) } : { error: "fixture-offline" };
    },
    async probeTunnel() { h.tunnelCalls++; return h.tunnelProbe; },
    parseManagedDiagnostic: () => null,
  };
  h.healthModule = health;
  h.status = load(options.source || fs.readFileSync(path.join(SRC, "status.js"), "utf8"), path.join(SRC, "status.js"), {
    child_process: childProcess, "./tunnel-health": health,
  }, {
    Date: class extends Date { static now() { return h.now; } },
    setTimeout(fn, ms) {
      h.deadlines.push(ms);
      return setTimeout(fn, options.deadlineMs === undefined ? ms : Math.min(ms, options.deadlineMs));
    },
  });
  return h;
}

function createServices(h, options = {}) {
  const kills = [], starts = [], releases = [];
  class FakeManaged extends EventEmitter {
    constructor(name) {
      super();
      Object.assign(this, { name, alive: false, state: "stopped", pid: null, lastExit: null, startedAt: null });
    }
    isAlive() { return this.alive; }
    start() { starts.push(this.name); return forbidden(); }
    stop() { return forbidden(); }
  }
  const cfg = { setupDone: true, mcpPort: MCP_PORT, tunnelPort: TUNNEL_PORT, tunnelId: "tunnel_fixture" };
  const paths = Object.fromEntries(["codeRoot", "runtimeDir", "logsDir", "tunnelClientPath", "distEntry"].map((name) =>
    [name, () => path.join(ROOT, "__status_fixture_not_created__", name)]));
  paths.ensureRuntimeDir = forbidden;
  const { Services } = load(options.source || fs.readFileSync(path.join(SRC, "services.js"), "utf8"), path.join(SRC, "services.js"), {
    events: { EventEmitter }, fs: { existsSync: () => false }, path,
    https: { get: forbidden }, child_process: { spawn: forbidden },
    "./processes": {
      ManagedProcess: FakeManaged, sleep: async () => {},
      killTree(pid) {
        kills.push(pid);
        for (const [port, pids] of h.listeners) h.listeners.set(port, pids.filter((item) => item !== pid));
        if (options.onKill) options.onKill(pid, h);
      },
    },
    // Existing cases cover the compatible non-isolated controller; isolated ownership is tested explicitly below.
    "./app-profile": { profile: { isolated: options.isolated === true } },
    "./service-recovery": require("../src/service-recovery"),
    "./account-context": { current: () => options.accountScoped ? { id: "fixture-account" } : null },
    "./companion-runtime": { revoke() {} },
    "./computer-use-runtime": { revoke() {} },
    "./status": options.status || h.status,
    "./tunnel-health": h.healthModule,
    "./harness": { ensureDotEnv: forbidden, mcpSpawnSpec: forbidden, tunnelSpawnSpec: forbidden },
    "./paths": paths,
    "./config": { load: () => ({ ...cfg }), publicView: (value) => ({ ...value }), decryptKey: forbidden },
    "./shell-util": { psQuote: forbidden, runPowershell: forbidden },
  });
  const service = new Services();
  // Exercise the actual production release predicate without sleeping for 10s.
  service.waitFor = async (check) => { const free = await check(); releases.push(free); return free; };
  return { service, cfg, kills, starts, releases };
}

async function baseline() {
  // Only git reads a child process here; status/service commands remain mocks.
  const { execFileSync } = require("node:child_process");
  const revision = "234ee7750c8cce09f8dd83fe9b0239a88cdbd471";
  const source = (file) => execFileSync("git", ["show", revision + ":desktop/src/" + file], {
    cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 5000,
  });
  const cell = new Int32Array(new SharedArrayBuffer(4));
  const commands = [];
  const h = createStatus({ source: source("status.js"), spawnSync(command, args) {
    commands.push(command);
    Atomics.wait(cell, 0, 0, 80);
    return { status: 0, stdout: h.output({ command, pid: Number(/ProcessId=(\d+)/.exec(args.at(-1))?.[1]) }) };
  } });
  h.listeners.set(TUNNEL_PORT, [TUNNEL_PID]);
  h.infos.set(TUNNEL_PID, identity(TUNNEL_PID, { Name: "tunnel-client.exe", CommandLine: "tunnel-client.exe run" }));
  const { service } = createServices(h, { source: source("services.js") });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const start = performance.now();
  try {
    await service.refresh();
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(ticks, 0);
    assert.deepEqual(commands, ["netstat", "powershell.exe", "netstat", "powershell.exe"]);
    assert.ok(elapsedMs >= 300);
    console.log(JSON.stringify({ revision, synchronousProbeMs: 80, elapsedMs, heartbeatTicksDuringPoll: ticks, commands }));
  } finally { clearInterval(timer); }
}

function tests() {
  test("slow process probes leave the main-loop heartbeat responsive", async (t) => {
    const h = createStatus({ delayMs: 80 });
    h.listeners.set(TUNNEL_PORT, [TUNNEL_PID]);
    h.infos.set(TUNNEL_PID, identity(TUNNEL_PID, { Name: "tunnel-client.exe", CommandLine: "tunnel-client.exe run" }));
    const { service } = createServices(h);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const start = performance.now();
    try {
      const result = await service.refresh();
      assert.ok(ticks > 0, "heartbeat must run before the slow snapshot completes");
      assert.equal(result.mcp.externalRecognized, true);
      assert.equal(result.tunnel.externalRecognized, true);
      assert.equal(h.calls.filter((call) => call.command === "netstat").length, 1);
      assert.equal(h.calls.filter((call) => call.command === "powershell.exe").length, 2);
      t.diagnostic("poll=" + Math.round(performance.now() - start) + "ms; 5ms heartbeat ticks=" + ticks + "; async probes=" + h.calls.length);
    } finally { clearInterval(timer); }
  });

  test("concurrent same-port and different-port reads share one netstat, not completed snapshots", async () => {
    const h = createStatus({ delayMs: 10 });
    h.listeners.set(TUNNEL_PORT, [TUNNEL_PID]);
    const results = await Promise.all([h.status.listeningPids(MCP_PORT), h.status.listeningPids(String(MCP_PORT)), h.status.listeningPids(TUNNEL_PORT)]);
    assert.deepEqual(results, [[MCP_PID], [MCP_PID], [TUNNEL_PID]]);
    assert.equal(h.calls.length, 1);
    results[0].push(99);
    h.listeners.set(MCP_PORT, [MCP_PID + 10]);
    assert.deepEqual(await h.status.listeningPids(MCP_PORT), [MCP_PID + 10]);
    assert.equal(h.calls.length, 2);
  });

  test("parallel classifications reuse both netstat and the same PID identity query", async () => {
    const h = createStatus({ delayMs: 5 });
    const owners = await Promise.all(Array.from({ length: 12 }, () => h.status.classifyPortOwner(MCP_PORT, /dist[\\/]index\.js/gi)));
    assert.ok(owners.every((owner) => owner.recognized));
    assert.equal(h.calls.filter((call) => call.command === "netstat").length, 1);
    assert.equal(h.calls.filter((call) => call.command === "powershell.exe").length, 1);
  });

  test("netstat parser handles IPv4/IPv6 duplicates, exact local ports, invalid PIDs and non-listeners", async () => {
    const h = createStatus({ onExec(call) {
      queueMicrotask(() => call.finish(null, [
        " TCP 0.0.0.0:" + MCP_PORT + " 0.0.0.0:0 LISTENING " + MCP_PID,
        " TCP [::]:" + MCP_PORT + " [::]:0 LISTENING " + MCP_PID,
        " TCP 127.0.0.1:9 127.0.0.1:" + MCP_PORT + " ESTABLISHED 9",
        " TCP 127.0.0.1:1" + MCP_PORT + " 0.0.0.0:0 LISTENING 8",
        " TCP 127.0.0.1:" + MCP_PORT + " 0.0.0.0:0 NOT_LISTENING 7",
        " TCP 127.0.0.1:" + MCP_PORT + " 0.0.0.0:0 LISTENING -2",
        " TCP 127.0.0.1:" + MCP_PORT + " 0.0.0.0:0 LISTENING 1.5",
        " UDP 127.0.0.1:" + MCP_PORT + " 0.0.0.0:0 LISTENING 6",
      ].join("\n")));
    } });
    assert.deepEqual(await h.status.listeningPids(MCP_PORT), [MCP_PID]);
  });

  test("probe commands are hidden, bounded, parameterized and never shell-spawned", async () => {
    const h = createStatus();
    await h.status.classifyPortOwner(MCP_PORT, PATTERN);
    for (const call of h.calls) {
      assert.equal(call.settings.windowsHide, true);
      assert.equal(call.settings.encoding, "utf8");
      assert.equal(call.settings.maxBuffer, 1024 * 1024);
      assert.equal(call.settings.shell, undefined);
    }
    assert.deepEqual(h.calls[0].args, ["-ano", "-p", "tcp"]);
    assert.equal(h.calls[0].settings.timeout, 5000);
    assert.equal(h.calls[1].settings.timeout, 8000);
    assert.match(h.calls[1].args.at(-1), /Select-Object ProcessId,Name,CommandLine,ParentProcessId,CreationDate/);
  });

  test("invalid port and PID inputs never launch a query", async () => {
    const h = createStatus();
    for (const port of [0, -1, 65536, 1.5, "1;anything", NaN]) await assert.rejects(h.status.listeningPids(port), { code: "INVALID_PORT" });
    for (const pid of [0, -1, 1.5, 0x100000000, "1;anything", NaN]) assert.equal(await h.status.processInfo(pid), null);
    assert.equal(h.calls.length, 0);
  });

  test("netstat deadline settles without a callback, ignores late partial output, and recovers", async () => {
    const h = createStatus({ deadlineMs: 25, onExec() {} });
    const before = performance.now();
    await assert.rejects(h.status.listeningPids(MCP_PORT), { code: "ETIMEDOUT" });
    assert.ok(performance.now() - before < 1000);
    assert.equal(h.calls[0].kills, 1);
    h.calls[0].finish(null, h.output(h.calls[0]));
    h.listeners.clear();
    const second = h.status.listeningPids(MCP_PORT);
    h.calls[1].finish(null, "");
    assert.deepEqual(await second, []);
    assert.equal(h.calls.length, 2);
  });

  test("PowerShell deadline returns unknown and never caches a late identity", async () => {
    const h = createStatus({ deadlineMs: 25, onExec() {} });
    assert.equal(await h.status.processInfo(MCP_PID), null);
    assert.equal(h.calls[0].kills, 1);
    h.calls[0].finish(null, JSON.stringify(identity()));
    const second = h.status.processInfo(MCP_PID);
    assert.equal(h.calls.length, 2);
    h.calls[1].finish(null, JSON.stringify(identity(MCP_PID, { CommandLine: "unrelated.exe" })));
    assert.equal((await second).CommandLine, "unrelated.exe");
  });

  test("spawn errors, failed exit and output-limit failures cannot turn partial output into ownership", async () => {
    for (const code of ["ENOENT", "EACCES", 1, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
      const h = createStatus({ onExec(call, fixture) { queueMicrotask(() => call.finish(Object.assign(new Error("fixture failure"), { code }), fixture.output(call))); } });
      const owner = await h.status.classifyPortOwner(MCP_PORT, PATTERN);
      assert.equal(owner.pid, null);
      assert.equal(owner.recognized, false);
      assert.equal(owner.error, String(code));
    }
    const h = createStatus({ onExec() { throw new Error("synchronous spawn failure"); } });
    await assert.rejects(h.status.listeningPids(MCP_PORT), /synchronous spawn failure/);
    assert.equal(await h.status.processInfo(MCP_PID), null);
  });

  test("malformed, missing and mismatched CIM responses never identify a process", async () => {
    for (const out of ["", "broken", "null", "[]", "{}", JSON.stringify(identity(MCP_PID + 1))]) {
      const h = createStatus({ onExec(call, fixture) { queueMicrotask(() => call.finish(null, call.command === "netstat" ? fixture.output(call) : out)); } });
      const owner = await h.status.classifyPortOwner(MCP_PORT, PATTERN);
      assert.equal(owner.recognized, false, out);
      assert.equal(owner.error, "process_query_failed", out);
      assert.equal(owner.pid, MCP_PID);
    }
  });

  test("display identities expire after 15s and cannot be changed through a returned object", async () => {
    const h = createStatus();
    const initial = await h.status.processInfo(String(MCP_PID));
    initial.CommandLine = "caller mutation";
    assert.equal((await h.status.processInfo(MCP_PID)).CommandLine, identity().CommandLine);
    assert.equal(h.calls.length, 1);
    h.now += 15000;
    h.infos.set(MCP_PID, identity(MCP_PID, { CommandLine: "new.exe" }));
    assert.equal((await h.status.processInfo(MCP_PID)).CommandLine, "new.exe");
    assert.equal(h.calls.length, 2);
    h.now -= 1;
    await h.status.processInfo(MCP_PID);
    assert.equal(h.calls.length, 3, "clock rollback must expire cached identity");
  });

  test("display cache is bounded rather than growing forever with PID churn", async () => {
    const h = createStatus();
    for (let i = 0; i < 129; i++) {
      h.infos.set(MCP_PID + i, identity(MCP_PID + i));
      await h.status.processInfo(MCP_PID + i);
    }
    assert.equal(h.calls.length, 129);
    await h.status.processInfo(MCP_PID);
    assert.equal(h.calls.length, 130);
  });

  test("fresh identity bypasses cache and in-flight work; stale completion cannot replace it", async () => {
    const h = createStatus({ onExec() {} });
    const old = h.status.processInfo(MCP_PID);
    const fresh = h.status.processInfo(MCP_PID, { fresh: true });
    assert.equal(h.calls.length, 2);
    h.calls[1].finish(null, JSON.stringify(identity(MCP_PID, { CommandLine: "unrelated.exe" })));
    await fresh;
    h.calls[0].finish(null, JSON.stringify(identity()));
    await old;
    assert.equal((await h.status.processInfo(MCP_PID)).CommandLine, "unrelated.exe");
    assert.equal(h.calls.length, 2);
    const newest = h.status.processInfo(MCP_PID, { fresh: true });
    assert.equal(h.calls.length, 3);
    h.calls[2].finish(null, JSON.stringify(identity(MCP_PID, { CommandLine: "latest.exe" })));
    assert.equal((await newest).CommandLine, "latest.exe");
  });

  test("failed fresh identity invalidates old cached and late in-flight recognition", async () => {
    const h = createStatus({ onExec() {} });
    const old = h.status.processInfo(MCP_PID);
    const fresh = h.status.processInfo(MCP_PID, { fresh: true });
    h.calls[1].finish(new Error("permission denied"), JSON.stringify(identity()));
    assert.equal(await fresh, null);
    h.calls[0].finish(null, JSON.stringify(identity()));
    await old;
    const next = h.status.processInfo(MCP_PID);
    assert.equal(h.calls.length, 3);
    h.calls[2].finish(null, "");
    assert.equal(await next, null);
  });

  test("a fresh listener query does not join an earlier poll or lose its single-flight slot", async () => {
    const h = createStatus({ onExec() {} });
    const old = h.status.listeningPids(MCP_PORT);
    const fresh = h.status.listeningPids(MCP_PORT, { fresh: true });
    assert.equal(h.calls.length, 2);
    h.calls[0].finish(null, h.output(h.calls[0]));
    assert.deepEqual(await old, [MCP_PID]);
    const shared = h.status.listeningPids(MCP_PORT);
    assert.equal(h.calls.length, 2);
    h.listeners.clear();
    h.calls[1].finish(null, "");
    assert.deepEqual(await fresh, []);
    assert.deepEqual(await shared, []);
  });

  test("refresh, IPC-like reads and state events share one snapshot and one status emission", async () => {
    const h = createStatus({ delayMs: 10 });
    const { service, cfg } = createServices(h);
    let emitted = 0;
    service.on("status", () => emitted++);
    const one = service.refresh(), two = service.refresh();
    assert.strictEqual(one, two);
    const ipc = service.collectStatus();
    assert.strictEqual(ipc, service.collectStatus());
    service.mcp.emit("state", "stopped");
    const result = await Promise.all([one, two, ipc]);
    assert.strictEqual(result[0], result[2]);
    assert.equal(emitted, 1);
    assert.equal(h.healthCalls, 1);
    assert.equal(h.tunnelCalls, 1);
    cfg.mcpPort++;
    const next = await service.collectStatus();
    assert.notStrictEqual(next, result[0]);
    assert.equal(next.config.mcpPort, MCP_PORT + 1);
    assert.equal(next.mcp.pid, null);
    assert.equal(h.healthCalls, 2);
  });

  test("repeated timer ticks do not overlap slow snapshot work or multiply status events", async () => {
    const h = createStatus({ delayMs: 40 });
    const { service } = createServices(h);
    let requested = 0, emitted = 0;
    const pending = [];
    service.on("status", () => emitted++);
    const first = service.refresh();
    const timer = setInterval(() => { requested++; pending.push(service.refresh()); }, 5);
    try { await first; } finally { clearInterval(timer); }
    await Promise.all(pending);
    assert.ok(requested > 0);
    assert.equal(h.healthCalls, 1);
    assert.equal(h.tunnelCalls, 1);
    assert.equal(emitted, 1);
  });

  test("a config save joining a slow poll cannot publish status for the previous ports", async () => {
    const h = createStatus({ delayMs: 10 });
    const { service, cfg } = createServices(h);
    const seen = [];
    service.on("status", (snapshot) => seen.push(snapshot));
    const old = service.refresh();
    await delay(1);
    cfg.mcpPort++;
    const joined = service.refresh();
    const result = await joined;
    assert.strictEqual(await old, result);
    assert.equal(result.config.mcpPort, MCP_PORT + 1);
    assert.equal(result.mcp.pid, null);
    assert.equal(seen.length, 1);
    assert.equal(h.healthCalls, 2, "one serialized replacement poll for changed inputs");
  });

  test("status flights and the busy lock recover after a failed snapshot", async () => {
    const h = createStatus();
    let attempts = 0, executed = false;
    const { service } = createServices(h, { status: { ...h.status, async probeMcp() {
      if (++attempts === 1) throw new Error("fixture poll failure");
      return null;
    } } });
    await assert.rejects(service.withBusy(async () => { executed = true; }), /fixture poll failure/);
    assert.equal(executed, false);
    assert.equal(service.busy, false);
    await service.refresh();
    assert.equal(service.statusInFlight, null);
    assert.equal(service.refreshInFlight, null);
  });

  test("managed-process state is read again after asynchronous probes settle", async () => {
    const h = createStatus({ delayMs: 10 });
    const { service } = createServices(h);
    const pending = service.collectStatus();
    await delay(1);
    Object.assign(service.mcp, { alive: true, state: "running", pid: 59999 });
    const result = await pending;
    assert.equal(result.mcp.managed, true);
    assert.equal(result.mcp.pid, 59999);
    assert.equal(result.mcp.externalRecognized, false);
  });

  test("a managed exit during a poll cannot relabel its old health response as an external service", async () => {
    const h = createStatus({ delayMs: 10 });
    const { service } = createServices(h);
    Object.assign(service.mcp, { alive: true, state: "running", pid: MCP_PID, startedAt: 123 });
    h.health = { name: "codex-mcp-server", runtime: { pid: MCP_PID } };
    const pending = service.collectStatus();
    await delay(1);
    Object.assign(service.mcp, { alive: false, state: "stopped", pid: null });
    h.health = null;
    h.listeners.clear();
    const result = await pending;
    assert.equal(result.mcp.managed, false);
    assert.equal(result.mcp.external, false);
    assert.equal(result.mcp.pid, null);
    assert.equal(h.healthCalls, 2);
  });

  test("failed port query is explicit in snapshots and prevents both starts", async () => {
    const h = createStatus({ onExec(call) { queueMicrotask(() => call.finish(Object.assign(new Error("netstat failed"), { code: "EACCES" }))); } });
    const { service, starts } = createServices(h);
    const snapshot = await service.collectStatus();
    assert.equal(snapshot.mcp.ownerProbeError, "EACCES");
    assert.equal(snapshot.tunnel.ownerProbeError, "EACCES");
    await assert.rejects(service.startMcp(), /EACCES/);
    await assert.rejects(service.startTunnel(), /EACCES/);
    assert.deepEqual(starts, []);
  });

  test("stopExternal cannot use cached recognized identity or a health-supplied PID", async () => {
    const h = createStatus();
    const { service, kills } = createServices(h);
    await service.collectStatus();
    assert.equal(service.lastStatus.mcp.externalRecognized, true);
    h.infos.set(MCP_PID, identity(MCP_PID, { CommandLine: "unrelated.exe", CreationDate: "/Date(1788796900000)/" }));
    h.health = { name: "codex-mcp-server", runtime: { pid: 987654 } };
    await service.stopExternal();
    assert.deepEqual(kills, []);
    assert.equal(service.busy, false);
  });

  test("stopExternal revalidates changed PID, reused PID, and changed recognition before termination", async () => {
    for (const change of ["pid", "birth", "command", "failure", "extra-listener"]) {
      let checks = 0, changed = false;
      const h = createStatus({ onExec(call, fixture) {
        queueMicrotask(() => {
          if (call.command === "powershell.exe" && call.pid === MCP_PID && ++checks === 3) {
            changed = true;
            if (change === "pid") { fixture.listeners.set(MCP_PORT, [MCP_PID + 1]); fixture.infos.set(MCP_PID + 1, identity(MCP_PID + 1)); }
            if (change === "birth") fixture.infos.set(MCP_PID, identity(MCP_PID, { CreationDate: "/Date(1788796900000)/" }));
            if (change === "command") fixture.infos.set(MCP_PID, identity(MCP_PID, { CommandLine: "unrelated.exe" }));
            if (change === "failure") fixture.infos.delete(MCP_PID);
            if (change === "extra-listener") fixture.listeners.set(MCP_PORT, [MCP_PID, MCP_PID + 1]);
          }
          call.finish(null, fixture.output(call));
        });
      } });
      const { service, kills } = createServices(h);
      await service.stopExternal();
      assert.equal(changed, true, change);
      assert.deepEqual(kills, [], change);
    }
  });

  test("stopExternal refuses ambiguous listeners and missing birth identity", async () => {
    for (const ambiguous of [true, false]) {
      const h = createStatus();
      if (ambiguous) h.listeners.set(MCP_PORT, [MCP_PID, MCP_PID + 1]);
      else h.infos.set(MCP_PID, identity(MCP_PID, { CreationDate: null }));
      const { service, kills } = createServices(h);
      await service.stopExternal();
      assert.deepEqual(kills, []);
    }
  });

  test("stopExternal targets only the twice-verified listener, never a reused parent PID", async () => {
    const h = createStatus();
    h.infos.set(MCP_PID, identity(MCP_PID, { ParentProcessId: PARENT_PID }));
    h.infos.set(PARENT_PID, identity(PARENT_PID, { Name: "powershell.exe", CommandLine: "powershell -File start.ps1", CreationDate: "/Date(1788796990000)/" }));
    const { service, kills, releases } = createServices(h);
    await service.stopExternal();
    assert.deepEqual(kills, [MCP_PID]);
    assert.deepEqual(releases, [true]);
    assert.ok(!h.calls.some((call) => call.pid === PARENT_PID));
    assert.ok(h.calls.filter((call) => call.pid === MCP_PID).length >= 3, "display plus two independent fresh identity reads");
  });

  test("a port reassigned during the final CIM query cannot authorize stopping its former owner", async () => {
    let identityReads = 0;
    const h = createStatus({ onExec(call, fixture) {
      queueMicrotask(() => {
        const out = fixture.output(call);
        if (call.command === "powershell.exe" && ++identityReads === 3) {
          // Display read, first fresh read, then final fresh read. The process
          // remains alive, but no longer owns the user's selected port.
          fixture.listeners.set(MCP_PORT, [MCP_PID + 1]);
          fixture.infos.set(MCP_PID + 1, identity(MCP_PID + 1, { CommandLine: "unrelated.exe" }));
        }
        call.finish(null, out);
      });
    } });
    const { service, kills } = createServices(h);
    await service.stopExternal();
    assert.deepEqual(kills, []);
  });

  test("failure of the final listener check cannot authorize a kill despite valid fresh identity", async () => {
    let identityReads = 0, failed = false;
    const h = createStatus({ onExec(call, fixture) {
      queueMicrotask(() => {
        if (call.command === "powershell.exe") identityReads++;
        if (call.command === "netstat" && identityReads === 3 && !failed) {
          failed = true;
          call.finish(new Error("last listener check failed"), fixture.output(call));
        } else call.finish(null, fixture.output(call));
      });
    } });
    const { service, kills } = createServices(h);
    await service.stopExternal();
    assert.equal(failed, true);
    assert.deepEqual(kills, []);
  });

  test("a failed fresh read cannot fall back to a previously completed recognized identity", async () => {
    const h = createStatus();
    assert.ok(await h.status.processInfo(MCP_PID));
    h.infos.delete(MCP_PID);
    assert.equal(await h.status.processInfo(MCP_PID, { fresh: true }), null);
    h.infos.set(MCP_PID, identity(MCP_PID, { CommandLine: "unrelated.exe" }));
    assert.equal((await h.status.processInfo(MCP_PID)).CommandLine, "unrelated.exe");
    assert.equal(h.calls.length, 3);
  });

  test("stable external Tunnel and MCP are checked independently and stopped in order", async () => {
    const h = createStatus();
    h.listeners.set(TUNNEL_PORT, [TUNNEL_PID]);
    h.infos.set(TUNNEL_PID, identity(TUNNEL_PID, { Name: "tunnel-client.exe", CommandLine: "tunnel-client.exe run" }));
    const { service, kills, releases } = createServices(h);
    await service.stopExternal();
    assert.deepEqual(kills, [TUNNEL_PID, MCP_PID]);
    assert.deepEqual(releases, [true, true]);
  });

  test("unknown query failure cannot authorize external termination or prove release", async () => {
    const failed = createStatus({ onExec(call) { queueMicrotask(() => call.finish(new Error("probe failed"))); } });
    const noStop = createServices(failed);
    await noStop.service.stopExternal();
    assert.deepEqual(noStop.kills, []);
    const h = createStatus();
    let stopped = false;
    const original = h.status.listeningPids;
    const { service, kills, releases } = createServices(h, {
      onKill() { stopped = true; },
      status: { ...h.status, listeningPids(port, options) {
        if (stopped) return Promise.reject(new Error("release query failed"));
        return original(port, options);
      } },
    });
    await service.stopExternal();
    assert.deepEqual(kills, [MCP_PID]);
    assert.deepEqual(releases, [false]);
  });
  test("isolated mode cannot terminate even a stable process matching generic dist/index.js", async () => {
    const h = createStatus();
    h.infos.set(MCP_PID, identity(MCP_PID, { CommandLine: "node X:/unrelated-fixture/dist/index.js" }));
    const { service, kills } = createServices(h, { isolated: true });
    await assert.rejects(service.stopExternal(), /隔离版不接管或终止外部进程/);
    assert.deepEqual(kills, []);
    assert.equal(h.calls.length, 0, "refuse before collecting ownership heuristics");
    assert.equal(service.busy, false);
  });

  test("isolated snapshots never authorize external takeover", async () => {
    const h = createStatus();
    h.health = { name: "codex-mcp-server", runtime: { pid: MCP_PID } };
    h.listeners.set(TUNNEL_PORT, [TUNNEL_PID]);
    h.infos.set(TUNNEL_PID, identity(TUNNEL_PID, { Name: "tunnel-client.exe", CommandLine: "tunnel-client.exe run" }));
    h.tunnelProbe = { reachable: true, ready: true, cloudState: "online" };
    const { service } = createServices(h, { isolated: true });
    const snapshot = await service.refresh();
    assert.equal(snapshot.mcp.externalRecognized, false);
    assert.equal(snapshot.tunnel.externalRecognized, false);
  });

  test("isolated startup refuses a healthy foreign MCP rather than silently reusing it", async () => {
    const h = createStatus();
    h.health = { name: "codex-mcp-server", runtime: { pid: MCP_PID } };
    const { service, kills, starts } = createServices(h, { isolated: true });
    await assert.rejects(service.startMcp(), /隔离版不复用外部 MCP/);
    assert.deepEqual(kills, []);
    assert.deepEqual(starts, []);
  });

  test("isolated startup refuses a ready foreign Tunnel rather than silently reusing it", async () => {
    const h = createStatus();
    h.tunnelProbe = { ready: true, reachable: true };
    const { service, kills, starts } = createServices(h, { isolated: true });
    await assert.rejects(service.startTunnel(), /隔离版不复用外部 Tunnel/);
    assert.deepEqual(kills, []);
    assert.deepEqual(starts, []);
  });

  test("isolated mode can still recognize its own already-managed services", async () => {
    const h = createStatus();
    const { service, kills, starts } = createServices(h, { isolated: true });
    service.mcp.alive = service.tunnel.alive = true;
    await service.startMcp();
    await service.startTunnel();
    assert.deepEqual(kills, []);
    assert.deepEqual(starts, []);
    assert.equal(h.calls.length, 0);
  });

}

if (process.argv.includes("--baseline")) baseline().catch((error) => { console.error(error); process.exitCode = 1; });
else tests();
