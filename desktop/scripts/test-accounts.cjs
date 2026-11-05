"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const src = path.resolve(__dirname, "../src");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(t, timers = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-account-test-"));
  const root = path.join(temp, "userData");
  const docs = path.join(temp, "documents");
  fs.mkdirSync(root); fs.mkdirSync(docs);
  const app = { isPackaged: false, getPath: (name) => name === "documents" ? docs : root, getVersion: () => "test" };
  const electron = { app, safeStorage: {
    isEncryptionAvailable: () => true,
    // Deliberate unit-test fixture, never production encryption or credentials.
    encryptString: (value) => Buffer.from(`test-only:${value}`),
    decryptString: (value) => value.toString().replace(/^test-only:/, ""),
  } };
  const cache = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const real = createRequire(filename);
    const requireHere = (name) => name === "electron" ? electron
      : name.startsWith("./") && !name.endsWith(".json") ? load(real.resolve(name)) : real(name);
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      module, exports: module.exports, require: requireHere, __filename: filename, __dirname: path.dirname(filename),
      process, Buffer, console, URL, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout, setInterval, clearInterval, setImmediate,
    }, { filename });
    return module.exports;
  }
  const context = load(path.join(src, "account-context.js"));
  const paths = load(path.join(src, "paths.js"));
  const config = load(path.join(src, "config.js"));
  const { AccountManager } = load(path.join(src, "accounts.js"));
  let pid = 100;
  class FakeService extends EventEmitter {
    constructor() {
      super(); this.busy = false; this.launcherLines = [];
      this.mcp = { state: "stopped", pid: null, lines: [], isAlive() { return this.state === "running"; } };
      this.tunnel = { state: "stopped", pid: null, lines: [], isAlive() { return this.state === "running"; } };
    }
    note(line) { this.launcherLines.push(line); this.emit("log", { name: "launcher", line }); }
    async startMcp() {
      this.mcp.state = "running"; this.mcp.pid = ++pid;
      await delay(8);
      fs.mkdirSync(paths.logsDir(), { recursive: true });
      fs.appendFileSync(path.join(paths.logsDir(), "ownership.log"), `${context.current().id}\n`);
      this.note(context.current().id); return this.refresh();
    }
    async startTunnel() { this.tunnel.state = "running"; this.tunnel.pid = ++pid; return this.refresh(); }
    async startAll() { await this.startMcp(); await this.startTunnel(); }
    async stopMcp() { this.mcp.state = "stopped"; this.mcp.pid = null; return this.refresh(); }
    async stopTunnel() { this.tunnel.state = "stopped"; this.tunnel.pid = null; return this.refresh(); }
    async stopAll() { await this.stopTunnel(); await this.stopMcp(); }
    async restartMcp() { await this.stopMcp(); await this.startMcp(); }
    async withSetupMcp(fn) { this.busy = true; try { return await fn(); } finally { this.busy = false; } }
    async refresh() { const snapshot = { config: config.publicView(config.load()), mcp: { state: this.mcp.state }, tunnel: { state: this.tunnel.state } }; this.emit("status", snapshot); return snapshot; }
    async shutdown() { await this.stopAll(); }
  }
  class FakeFeeds extends EventEmitter {
    configure(value) { this.value = value; }
    start() { this.running = true; }
    stop() { this.running = false; }
  }
  const manager = new AccountManager({ app, config, paths, makeServices: () => new FakeService(), makeFeeds: () => new FakeFeeds(), portFree: async () => true });
  manager.init();
  t.after(async () => { await manager.shutdownAll(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { manager, context, paths, config, root, docs, temp, app, load, AccountManager };
}

test("default account migration does not rewrite legacy config or create a registry", (t) => {
  const f = fixture(t);
  const legacy = '{ "setupDone": false, "apiKeyEnc": "existing-ciphertext", "mcpPort": 3300 }\n';
  fs.writeFileSync(path.join(f.root, "config.json"), legacy);
  assert.equal(f.manager.selectedId, "default");
  assert.equal(f.manager.run("default", () => f.paths.configPath()), path.join(f.root, "config.json"));
  assert.equal(f.manager.list().accounts[0].config.hasApiKey, true);
  assert.equal(fs.readFileSync(path.join(f.root, "config.json"), "utf8"), legacy);
  assert.equal(fs.existsSync(path.join(f.root, "accounts.json")), false);
});

test("new accounts receive unique names, ports and private data roots, not copied keys", async (t) => {
  const f = fixture(t);
  f.manager.run("default", () => f.config.save({ ...f.config.DEFAULTS, apiKeyEnc: "old-ciphertext", adminTokenEnc: "old-admin", autoStart: true }));
  const a = await f.manager.create({ name: "个人账号 A" });
  const b = await f.manager.create({ name: "Business B" });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.config.mcpPort, b.config.mcpPort);
  assert.notEqual(a.dataDir, b.dataDir);
  const cfg = f.manager.readConfig(b.id);
  assert.equal(cfg.apiKeyEnc, ""); assert.equal(cfg.adminTokenEnc, undefined);
  assert.equal(cfg.setupDone, false); assert.equal(cfg.autoStart, false);
  assert.equal(f.manager.selectedId, "default");
  assert.equal(fs.existsSync(path.join(b.dataDir, "runtime/profiles/plugins.json")), true);
  assert.equal(JSON.stringify(f.manager.list()).includes("old-ciphertext"), false);
});

test("concurrent profile creation is serialized and a failed mutation does not poison the queue", async (t) => {
  const f = fixture(t);
  const result = await Promise.allSettled([f.manager.create({ name: "same" }), f.manager.create({ name: "same" })]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(result.filter((r) => r.status === "rejected").length, 1);
  await f.manager.create({ name: "after-error" });
  assert.equal(f.manager.list().accounts.length, 3);
});

test("configuration rejects cross-account ports, tunnel identity and overlapping workspaces", async (t) => {
  const f = fixture(t);
  const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  const first = f.manager.readConfig(a.id); const second = f.manager.readConfig(b.id);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, adminPort: first.mcpPort }), /端口/);
  first.tunnelId = `tunnel_${"a".repeat(32)}`;
  f.manager.run(a.id, () => f.config.save(first));
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, tunnelId: first.tunnelId }), /Tunnel ID/);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, workspacePath: path.join(first.workspacePath, "nested") }), /工作区/);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, workspacePath: f.root }), /工作区/);
  assert.throws(() => f.manager.validateConfig(b.id, { ...second, tunnelPort: NaN }), /端口/);
});

test("occupied port candidates are skipped without touching the listener", async (t) => {
  const f = fixture(t); const probed = [];
  f.manager.portFree = async (port) => { probed.push(port); return port >= 3410; };
  const a = await f.manager.create({ name: "skip occupied" });
  assert.equal(a.config.mcpPort, 3410);
  assert.ok(probed.includes(3400));
});

test("registry corruption fails closed with original bytes retained", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "accounts.json");
  for (const text of ["{bad", "null", JSON.stringify({ version: 2, accounts: [] })]) {
    fs.writeFileSync(file, text);
    const manager = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths });
    assert.throws(() => manager.init(), /未重置/);
    assert.equal(fs.readFileSync(file, "utf8"), text);
  }
});

test("external registry edits fail CAS instead of being overwritten", async (t) => {
  const f = fixture(t); await f.manager.create({ name: "A" });
  const file = path.join(f.root, "accounts.json"); const external = fs.readFileSync(file, "utf8") + "\n";
  fs.writeFileSync(file, external);
  await assert.rejects(f.manager.rename("default", "renamed"), /其他程序/);
  assert.equal(fs.readFileSync(file, "utf8"), external);
});

test("missing account configuration cannot fall back to another account's default ports", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" });
  fs.unlinkSync(path.join(a.dataDir, "config.json"));
  await assert.rejects(f.manager.select(a.id), /配置缺失/);
  assert.equal(f.manager.selectedId, "default");
});

test("IDs cannot traverse paths and names cannot spoof account identities with bidi controls", async (t) => {
  const f = fixture(t);
  assert.throws(() => f.manager.makeScope("../../elsewhere"), /ID/);
  await assert.rejects(f.manager.create({ name: "A\u202eB" }), /控制字符/);
  await assert.rejects(f.manager.select("f".repeat(32)), /不存在/);
});

test("account data junction is rejected, without accessing or deleting its target", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" });
  const moved = `${a.dataDir}-saved`;
  fs.renameSync(a.dataDir, moved);
  fs.symlinkSync(moved, a.dataDir, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.manager.readConfig(a.id), /junction/);
  fs.unlinkSync(a.dataDir);
  assert.equal(fs.existsSync(path.join(moved, "config.json")), true);
});

test("workspace junction overlap is detected by canonical path, not text prefix", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  fs.mkdirSync(a.config.workspacePath, { recursive: true });
  const alias = path.join(f.docs, "alias-a");
  fs.symlinkSync(a.config.workspacePath, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => f.manager.validateConfig(b.id, { ...f.manager.readConfig(b.id), workspacePath: alias }), /工作区/);
  fs.unlinkSync(alias);
});

test("in-flight service operation, delayed logs and configuration remain bound after UI selection changes", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  const events = []; f.manager.on("log", (entry) => events.push(entry));
  const delayedStart = f.manager.run(a.id, () => f.manager.services.startMcp());
  await f.manager.select(b.id);
  await f.manager.services.startMcp(); await delayedStart;
  assert.equal(fs.readFileSync(path.join(a.dataDir, "logs/ownership.log"), "utf8").trim(), a.id);
  assert.equal(fs.readFileSync(path.join(b.dataDir, "logs/ownership.log"), "utf8").trim(), b.id);
  assert.ok(events.some((e) => e.accountId === a.id && e.line === a.id));
  assert.ok(events.some((e) => e.accountId === b.id && e.line === b.id));
  assert.notEqual(f.manager.instance(a.id).services.mcp.pid, f.manager.instance(b.id).services.mcp.pid);
});

test("stopping one account preserves the other account's services and buffered logs", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  await f.manager.run(a.id, () => f.manager.services.startAll());
  await f.manager.run(b.id, () => f.manager.services.startAll());
  await f.manager.run(a.id, () => f.manager.services.stopAll());
  assert.equal(f.manager.instance(a.id).services.mcp.isAlive(), false);
  assert.equal(f.manager.instance(b.id).services.mcp.isAlive(), true);
  assert.equal(f.manager.instance(b.id).services.tunnel.isAlive(), true);
  assert.throws(() => f.manager.assertStopped(b.id), /先停止/);
  assert.doesNotThrow(() => f.manager.assertStopped(a.id));
});

test("application shutdown stops all owned accounts and prevents subsequent starts", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" }); const b = await f.manager.create({ name: "B" });
  await f.manager.run(a.id, () => f.manager.services.startAll());
  await f.manager.run(b.id, () => f.manager.services.startAll());
  await f.manager.shutdownAll();
  assert.equal(f.manager.anyAlive(), false);
  assert.throws(() => f.manager.run(b.id, () => f.manager.services.startMcp()), /退出/);
});

test("select and rename survive reload without moving existing config", async (t) => {
  const f = fixture(t); const a = await f.manager.create({ name: "A" });
  await f.manager.rename(a.id, "账号 A（工作）"); await f.manager.select(a.id);
  const second = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths });
  second.init();
  assert.equal(second.selectedId, a.id);
  assert.equal(second.record(a.id).name, "账号 A（工作）");
  assert.equal(second.scope(a.id).dataDir, a.dataDir);
});

test("removing selected profile archives owned files, preserves workspaces and surviving profiles across restart", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Remove A" }), b = await f.manager.create({ name: "Keep B" });
  fs.mkdirSync(a.config.workspacePath, { recursive: true });
  const project = path.join(a.config.workspacePath, "project.txt"); fs.writeFileSync(project, "keep workspace");
  const otherConfig = fs.readFileSync(path.join(b.dataDir, "config.json"), "utf8");
  await f.manager.select(a.id);
  const item = f.manager.instance(a.id); item.feeds.start();
  const result = await f.manager.remove(a.id);
  assert.equal(result.removedId, a.id); assert.equal(result.selectedId, "default");
  assert.equal(result.accounts.some(row => row.id === a.id), false);
  assert.equal(result.backup.created, true);
  assert.equal(fs.existsSync(path.join(result.backup.path, "config.json")), true);
  assert.equal(fs.existsSync(path.join(a.dataDir, "config.json")), false);
  assert.equal(fs.readFileSync(project, "utf8"), "keep workspace");
  assert.equal(fs.readFileSync(path.join(b.dataDir, "config.json"), "utf8"), otherConfig);
  assert.equal(item.feeds.running, false); assert.equal(f.manager.instances.has(a.id), false);
  assert.doesNotThrow(() => item.services.emit("status", {}));
  assert.throws(() => f.manager.record(a.id), /移除/);
  const restarted = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths }).init();
  assert.equal(restarted.list().accounts.length, 2); assert.equal(restarted.selectedId, "default");
});

test("historical default can be removed without moving application root, registry, unknown files or other accounts", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Survivor" });
  fs.writeFileSync(path.join(f.root, "config.json"), JSON.stringify({ ...f.config.DEFAULTS, apiKeyEnc: "fixture-secret" }));
  fs.writeFileSync(path.join(f.root, "unrelated.txt"), "preserve");
  fs.mkdirSync(path.join(f.root, "runtime"), { recursive: true }); fs.writeFileSync(path.join(f.root, "runtime", "state"), "owned");
  const result = await f.manager.remove("default");
  assert.equal(result.selectedId, a.id); assert.equal(result.accounts.length, 1);
  assert.equal(fs.readFileSync(path.join(f.root, "unrelated.txt"), "utf8"), "preserve");
  assert.equal(fs.existsSync(path.join(f.root, "accounts.json")), true);
  assert.equal(fs.existsSync(path.join(a.dataDir, "config.json")), true);
  assert.equal(fs.readFileSync(path.join(result.backup.path, "runtime", "state"), "utf8"), "owned");
  const restarted = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths }).init();
  assert.equal(restarted.selectedId, a.id); assert.equal(restarted.list().accounts.length, 1);
});

test("removing last account creates a fresh isolated identity with no copied credentials or automatic services", async (t) => {
  const f = fixture(t);
  f.manager.run("default", () => f.config.save({ ...f.config.DEFAULTS, apiKeyEnc: "fixture-cipher", adminTokenEnc: "fixture-admin", tunnelId: "11111111-1111-4111-8111-111111111111", autoStart: true, setupDone: true }));
  const first = await f.manager.remove("default");
  assert.match(first.selectedId, /^[a-f0-9]{32}$/); assert.notEqual(first.selectedId, "default");
  assert.equal(first.accounts.length, 1);
  const cfg = f.manager.readConfig(first.selectedId);
  assert.equal(cfg.apiKeyEnc, ""); assert.equal(cfg.adminTokenEnc, ""); assert.equal(cfg.tunnelId, "");
  assert.equal(cfg.autoStart, false); assert.equal(cfg.setupDone, false);
  assert.equal(fs.existsSync(path.join(f.root, "config.json")), false);
  const second = await f.manager.remove(first.selectedId);
  assert.notEqual(second.selectedId, first.selectedId); assert.equal(second.accounts.length, 1);
  const restarted = new f.AccountManager({ app: f.app, config: f.config, paths: f.paths }).init();
  assert.equal(restarted.selectedId, second.selectedId);
  assert.equal(restarted.list().accounts[0].config.hasApiKey, false);
});

test("removal refuses running, busy and refreshing accounts without stopping any process", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Busy" });
  const item = f.manager.instance(a.id);
  item.services.busy = true; await assert.rejects(f.manager.remove(a.id), /先停止/); item.services.busy = false;
  item.refreshing = true; await assert.rejects(f.manager.remove(a.id), /先停止/); item.refreshing = false;
  await f.manager.run(a.id, () => item.services.startMcp());
  await assert.rejects(f.manager.remove(a.id), /先停止/);
  assert.equal(item.services.mcp.isAlive(), true); assert.equal(fs.existsSync(path.join(a.dataDir, "config.json")), true);
});

test("failed registry commit restores all archived leaves and selection, then permits a later mutation", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Rollback" });
  await f.manager.select(a.id);
  const original = fs.readFileSync(path.join(a.dataDir, "config.json"), "utf8");
  const registry = fs.readFileSync(path.join(f.root, "accounts.json"), "utf8");
  const rename = fs.renameSync; fs.renameSync = function(src,dst) { if (path.resolve(dst) === path.join(f.root,"accounts.json")) throw new Error("fixture injected commit failure"); return rename.apply(this,arguments); }; t.after(() => { fs.renameSync = rename; });
  await assert.rejects(f.manager.remove(a.id), /injected/);
  assert.equal(fs.readFileSync(path.join(a.dataDir, "config.json"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(f.root, "accounts.json"), "utf8"), registry);
  assert.equal(f.manager.selectedId, a.id);
  fs.renameSync = rename; await f.manager.rename(a.id, "After rollback");
});

test("failed last-account replacement leaves original registry and keys intact", async (t) => {
  const f = fixture(t); f.manager.run("default", () => f.config.save({ ...f.config.DEFAULTS, apiKeyEnc: "fixture-old" }));
  const original = fs.readFileSync(path.join(f.root, "config.json"), "utf8");
  const rename = fs.renameSync; fs.renameSync = function(src,dst) { if (path.resolve(dst) === path.join(f.root,"accounts.json")) throw new Error("fixture last commit failure"); return rename.apply(this,arguments); }; t.after(() => { fs.renameSync = rename; });
  await assert.rejects(f.manager.remove("default"), /last commit/); fs.renameSync = rename;
  assert.equal(f.manager.selectedId, "default"); assert.equal(fs.readFileSync(path.join(f.root, "config.json"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(f.root, "accounts.json")), false);
  assert.equal(fs.readdirSync(path.join(f.root, "accounts")).length, 0);
});

test("archive rejects descendant junctions and recovery ancestry links without touching their targets", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Linked" });
  const outside = path.join(f.temp, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "keep"), "untouched");
  const link = path.join(a.dataDir, "runtime", "external"); fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.manager.remove(a.id), /junction/); fs.unlinkSync(link);
  const recovery = path.join(f.root, "account-recovery"); fs.symlinkSync(outside, recovery, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.manager.remove(a.id), /junction/); fs.unlinkSync(recovery);
  assert.equal(fs.readFileSync(path.join(outside, "keep"), "utf8"), "untouched");
  assert.equal(fs.existsSync(path.join(a.dataDir, "config.json")), true);
});

test("legacy workspace inside an account-owned runtime is preserved by refusing removal", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Legacy overlap" });
  const workspace = path.join(a.dataDir, "runtime", "project"); fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(path.join(workspace, "keep"), "project");
  f.manager.run(a.id, () => f.config.save({ ...f.manager.readConfig(a.id), workspacePath: workspace }));
  await assert.rejects(f.manager.remove(a.id), /工作区/);
  assert.equal(fs.readFileSync(path.join(workspace, "keep"), "utf8"), "project");
});

test("removing an unselected profile preserves selected identity and external registry edits reject removal", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Unselected" }), b = await f.manager.create({ name: "Selected" });
  await f.manager.select(b.id);
  const result = await f.manager.remove(a.id); assert.equal(result.selectedId, b.id);
  const file = path.join(f.root, "accounts.json"), external = fs.readFileSync(file, "utf8") + " "; fs.writeFileSync(file, external);
  await assert.rejects(f.manager.remove(b.id), /其他程序/);
  assert.equal(fs.readFileSync(file, "utf8"), external);
  assert.equal(fs.existsSync(path.join(b.dataDir, "config.json")), true);
});

test("a mid-archive rename failure restores earlier moves without modifying registry", async (t) => {
  const f = fixture(t), a = await f.manager.create({ name: "Partial rollback" });
  const original = fs.readFileSync(path.join(a.dataDir, "config.json"), "utf8");
  const registry = fs.readFileSync(path.join(f.root, "accounts.json"), "utf8");
  const rename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === path.join(a.dataDir, "runtime")) throw new Error("fixture mid-archive failure");
    return rename(source, target);
  };
  try { await assert.rejects(f.manager.remove(a.id), /mid-archive/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(path.join(a.dataDir, "config.json"), "utf8"), original);
  assert.equal(fs.readFileSync(path.join(f.root, "accounts.json"), "utf8"), registry);
  assert.equal(fs.existsSync(path.join(a.dataDir, "runtime")), true);
});

test("last-account allocation failure preserves original bytes and releases the removal guard", async (t) => {
  const f = fixture(t);
  f.manager.run("default", () => f.config.save({ ...f.config.DEFAULTS, apiKeyEnc: "fixture-retain" }));
  const original = fs.readFileSync(path.join(f.root, "config.json"), "utf8");
  f.manager.allocatePorts = async () => { throw new Error("fixture allocation failure"); };
  await assert.rejects(f.manager.remove("default"), /allocation failure/);
  assert.equal(fs.readFileSync(path.join(f.root, "config.json"), "utf8"), original);
  assert.equal(fs.existsSync(path.join(f.root, "accounts.json")), false);
  assert.equal(f.manager.removingIds.size, 0);
  await f.manager.rename("default", "Still usable");
});

test("setup is blocked during last-account allocation, and active setup blocks removal", async (t) => {
  const f = fixture(t), item = f.manager.instance("default");
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const setup = f.manager.run("default", () => item.services.withSetupMcp(() => pending));
  await assert.rejects(f.manager.remove("default"), /先停止/);
  release(); await setup;
  let allocated;
  const allocation = new Promise(resolve => { allocated = resolve; });
  f.manager.allocatePorts = () => allocation;
  const removal = f.manager.remove("default");
  await delay(0);
  assert.throws(() => item.services.withSetupMcp(() => assert.fail("setup must not start")), /正在移除/);
  assert.throws(() => item.services.startMcp(), /正在移除/);
  allocated({ mcpPort: 3400, adminPort: 3401, tunnelPort: 3402 });
  await removal;
  assert.throws(() => item.services.withSetupMcp(() => assert.fail("removed setup must not start")), /移除/);
});

test("setup helper cannot begin during shutdown", async (t) => {
  const f = fixture(t), item = f.manager.instance("default");
  await f.manager.shutdownAll();
  assert.throws(() => item.services.withSetupMcp(() => assert.fail("setup must not start")), /退出/);
});

test("saving stopped configuration tolerates a status poll but still rejects lifecycle and live processes", async t => {
  const f = fixture(t), item = f.manager.instance("default");
  item.refreshing = true;
  assert.throws(() => f.manager.assertStopped(), /先停止/, "destructive account operations retain their refresh fence");
  assert.doesNotThrow(() => f.manager.assertStopped("default", { allowStatusRefresh: true }));
  item.services.busy = true;
  assert.throws(() => f.manager.assertStopped("default", { allowStatusRefresh: true }), /先停止/);
  item.services.busy = false;
  item.services.mcp.state = "running";
  assert.throws(() => f.manager.assertStopped("default", { allowStatusRefresh: true }), /先停止/);
  item.services.mcp.state = "stopped";
  item.services.tunnel.state = "running";
  assert.throws(() => f.manager.assertStopped("default", { allowStatusRefresh: true }), /先停止/);
  item.services.tunnel.state = "stopped";
  item.refreshing = false;
});

test("setup IPC admits a read-only refresh and retains live-service fences", async t => {
  const f = fixture(t), item = f.manager.instance("default"), service = item.services;
  const main = fs.readFileSync(path.join(src, "main.js"), "utf8");
  const serviceSource = fs.readFileSync(path.join(src, "services.js"), "utf8");
  function between(source, start, end) {
    const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
    assert(first >= 0 && last > first && source.indexOf(start, first + start.length) < 0, "Expected unique production section: " + start);
    return source.slice(first, last);
  }
  const wrapSource = between(main, "function wrap(handler) {", "\nfunction registerIpc()");
  const setupSource = between(main, '  ipcMain.handle("setup:run",', '\n  ipcMain.handle("status:get",');
  const busySource = between(serviceSource, "  async withBusy(fn) {", "\n  async waitFor(");
  const realWithBusy = vm.runInNewContext("({" + busySource + "})").withBusy;
  const original = { refresh: service.refresh, collectStatus: service.collectStatus, withBusy: service.withBusy };
  let release;
  const heldRefresh = new Promise(resolve => { release = resolve; });
  const started = [];
  let handler;
  try {
    service.refresh = () => heldRefresh;
    service.collectStatus = async () => ({});
    service.withBusy = realWithBusy;
    const inFlight = f.manager.refreshAll();
    assert.equal(item.refreshing, true, "Real AccountManager.refreshAll should mark the held poll");
    assert.throws(() => f.manager.assertStopped(), /先停止/, "Default destructive-operation fence remains in force");
    vm.runInNewContext(wrapSource + "\n" + setupSource, {
      accounts: f.manager, services: f.manager.services,
      isTrustedIpcSource: () => true, mainWindow: {}, expectedAuraUrl: "fixture", quitting: false,
      runSetup: async payload => { started.push(payload); return { accepted: true }; },
      ipcMain: { handle(name, fn) { assert.equal(name, "setup:run"); handler = fn; } },
    });
    for (const key of ["busy", "mcp", "tunnel"]) {
      if (key === "busy") service.busy = true;
      else service[key].state = "running";
      const denied = await handler({}, { case: key });
      assert.equal(denied.ok, false, key + " must reject setup");
      assert.match(denied.error, /先停止/);
      assert.equal(started.length, 0, key + " must not invoke runSetup");
      if (key === "busy") service.busy = false;
      else service[key].state = "stopped";
    }
    const pendingSetup = handler({}, { case: "read-only-refresh" });
    await delay(0);
    assert.equal(started.length, 1, "A read-only poll must not prevent setup");
    assert.equal(started[0].case, "read-only-refresh");
    assert.equal(service.busy, false, "withBusy releases after the setup function, even while its final refresh waits");
    release();
    const result = await pendingSetup;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.result.accepted, true);
    await inFlight;
    assert.equal(item.refreshing, false);
  } finally {
    release();
    if (f.manager.refreshPromise) await f.manager.refreshPromise;
    service.refresh = original.refresh;
    service.collectStatus = original.collectStatus;
    service.withBusy = original.withBusy;
    service.busy = false;
    service.mcp.state = "stopped";
    service.tunnel.state = "stopped";
  }
});

test("account removal reserves a stopped target until its active status poll completes", async t => {
  const f = fixture(t);
  const workspace = path.join(f.temp, "removal-workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "keep.txt"), "workspace retained");
  f.manager.run("default", () => f.config.save({ ...f.config.load(), workspacePath: workspace }));
  const survivor = await f.manager.create({ name: "survivor" });
  const survivorFile = path.join(survivor.dataDir, "config.json");
  const survivorBytes = fs.readFileSync(survivorFile);
  const registryPath = path.join(f.root, "accounts.json");
  const originalRegistry = fs.readFileSync(registryPath);
  const configPath = path.join(f.root, "config.json");
  const item = f.manager.instance("default");
  const oldRefresh = item.services.refresh;
  let release, refreshCalls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  let observed;
  try {
    item.services.refresh = async () => { refreshCalls++; await hold; return {}; };
    const poll = f.manager.refreshAll();
    assert.equal(item.refreshing, true, "actual refreshAll must hold the target poll");
    const removal = f.manager.remove("default");
    observed = removal.then(value => ({ value }), error => ({ error }));
    await delay(0);
    assert.equal(f.manager.removingIds.has("default"), true, "removal reserves the target while poll is active");
    assert.equal(fs.readFileSync(registryPath).equals(originalRegistry), true, "registry must remain unchanged while waiting");
    assert.equal(fs.existsSync(configPath), true, "target configuration must not be archived during refresh");
    assert.equal(fs.existsSync(path.join(f.root, "account-recovery")), false, "no archive before refresh finishes");
    assert.throws(() => f.manager.run("default", () => f.manager.services.startMcp()), /正在移除/, "target start must be fenced");
    const joinedPoll = f.manager.refreshAll();
    assert.equal(refreshCalls, 1, "no new target poll while the existing batch is active");
    release();
    await poll; await joinedPoll;
    const result = await observed;
    assert.ifError(result.error);
    assert.equal(result.value.removedId, "default");
    assert.equal(result.value.backup.created, true);
    assert.equal(fs.existsSync(path.join(result.value.backup.path, "config.json")), true);
    assert.equal(f.manager.removingIds.has("default"), false);
    assert.equal(fs.readFileSync(survivorFile).equals(survivorBytes), true);
    assert.equal(fs.readFileSync(path.join(workspace, "keep.txt"), "utf8"), "workspace retained");
  } finally {
    release();
    if (observed) await observed;
    if (f.manager.refreshPromise) await f.manager.refreshPromise;
    item.services.refresh = oldRefresh;
  }
});

test("account removal retains busy, running-service and unowned-refresh fences", async t => {
  const f = fixture(t);
  await f.manager.create({ name: "survivor" });
  f.manager.run("default", () => f.config.save(f.config.load()));
  const originalConfig = fs.readFileSync(path.join(f.root, "config.json"));
  const item = f.manager.instance("default"), service = item.services;
  const registryPath = path.join(f.root, "accounts.json");
  const registry = fs.readFileSync(registryPath);
  const configPath = path.join(f.root, "config.json");
  try {
    for (const state of ["busy", "mcp", "tunnel", "unowned-refresh"]) {
      if (state === "busy") service.busy = true;
      else if (state === "unowned-refresh") {
        assert.equal(f.manager.refreshPromise, null);
        item.refreshing = true;
      } else service[state].state = "running";
      await assert.rejects(f.manager.remove("default"), /先停止/, state + " must block removal");
      assert.equal(f.manager.removingIds.has("default"), false, state + " must release reservation");
      assert.equal(fs.readFileSync(registryPath).equals(registry), true, state + " must preserve registry");
      assert.equal(fs.readFileSync(configPath).equals(originalConfig), true);
      assert.equal(fs.existsSync(path.join(f.root, "account-recovery")), false);
      service.busy = false; service.mcp.state = "stopped"; service.tunnel.state = "stopped"; item.refreshing = false;
    }
  } finally {
    service.busy = false; service.mcp.state = "stopped"; service.tunnel.state = "stopped"; item.refreshing = false;
  }
});

for (const interruption of ["busy", "shutdown"]) test("account removal releases its reservation when " + interruption + " occurs while waiting", async t => {
  const f = fixture(t);
  await f.manager.create({ name: "survivor" });
  f.manager.run("default", () => f.config.save(f.config.load()));
  const originalConfig = fs.readFileSync(path.join(f.root, "config.json"));
  const item = f.manager.instance("default"), service = item.services, oldRefresh = service.refresh;
  const registryPath = path.join(f.root, "accounts.json"), registry = fs.readFileSync(registryPath);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let outcome;
  try {
    service.refresh = async () => { await hold; return {}; };
    const poll = f.manager.refreshAll();
    assert.equal(item.refreshing, true);
    outcome = f.manager.remove("default").then(value => ({ value }), error => ({ error }));
    await delay(0);
    assert.equal(f.manager.removingIds.has("default"), true, "target must be reserved while waiting");
    if (interruption === "busy") service.busy = true;
    else f.manager.shuttingDown = true;
    release(); await poll;
    const result = await outcome;
    assert(result.error, "removal must fail rather than archive");
    assert.match(result.error.message, interruption === "busy" ? /先停止/ : /退出/);
    assert.equal(f.manager.removingIds.has("default"), false);
    assert.equal(fs.readFileSync(registryPath).equals(registry), true);
    assert.equal(fs.readFileSync(path.join(f.root, "config.json")).equals(originalConfig), true);
    assert.equal(fs.existsSync(path.join(f.root, "account-recovery")), false);
  } finally {
    release();
    if (outcome) await outcome;
    if (f.manager.refreshPromise) await f.manager.refreshPromise;
    service.refresh = oldRefresh;
    service.busy = false;
    f.manager.shuttingDown = false;
  }
});

test("account removal times out a held status poll without archiving or cancelling it", async t => {
  let fireDeadline, cleared = false;
  const deadlineToken = {};
  const f = fixture(t, {
    setTimeout(fn, ms, ...args) {
      if (ms !== 15000) return setTimeout(fn, ms, ...args);
      assert.equal(fireDeadline, undefined, "one removal deadline");
      fireDeadline = fn;
      return deadlineToken;
    },
    clearTimeout(token) {
      if (token === deadlineToken) { cleared = true; return; }
      clearTimeout(token);
    },
  });
  await f.manager.create({ name: "survivor" });
  f.manager.run("default", () => f.config.save(f.config.load()));
  const originalConfig = fs.readFileSync(path.join(f.root, "config.json"));
  const item = f.manager.instance("default"), service = item.services, oldRefresh = service.refresh;
  const registryPath = path.join(f.root, "accounts.json"), registry = fs.readFileSync(registryPath);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  let outcome;
  try {
    service.refresh = async () => { await hold; return {}; };
    const poll = f.manager.refreshAll();
    assert.equal(item.refreshing, true);
    outcome = f.manager.remove("default").then(value => ({ value }), error => ({ error }));
    await delay(0);
    assert.equal(f.manager.removingIds.has("default"), true);
    assert.equal(typeof fireDeadline, "function", "production 15-second deadline is installed");
    assert.throws(() => f.manager.run("default", () => f.manager.services.startMcp()), /正在移除/);
    fireDeadline();
    const result = await outcome;
    assert(result.error);
    assert.match(result.error.message, /刷新.*未移除/);
    assert.equal(cleared, true, "deadline timer was cleared");
    assert.equal(item.refreshing, true, "timeout must not cancel the active poll");
    assert.equal(f.manager.removingIds.has("default"), false, "timeout releases reservation");
    assert.equal(fs.readFileSync(registryPath).equals(registry), true);
    assert.equal(fs.readFileSync(path.join(f.root, "config.json")).equals(originalConfig), true);
    assert.equal(fs.existsSync(path.join(f.root, "account-recovery")), false);
    release(); await poll;
  } finally {
    release();
    if (outcome) await outcome;
    if (f.manager.refreshPromise) await f.manager.refreshPromise;
    service.refresh = oldRefresh;
  }
});

test("account removal reservation prevents a new target poll during port allocation", async t => {
  const f = fixture(t), item = f.manager.instance("default"), service = item.services;
  f.manager.run("default", () => f.config.save(f.config.load()));
  const oldRefresh = service.refresh, oldPortFree = f.manager.portFree;
  let release, refreshCalls = 0, portCalls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  let outcome;
  try {
    service.refresh = async () => { refreshCalls++; return {}; };
    f.manager.portFree = async () => { portCalls++; await hold; return true; };
    outcome = f.manager.remove("default").then(value => ({ value }), error => ({ error }));
    await delay(0);
    assert(portCalls > 0, "last-account port allocation must be in flight");
    assert.equal(f.manager.removingIds.has("default"), true);
    await f.manager.refreshAll();
    assert.equal(refreshCalls, 0, "reserved target must be skipped by a new refresh batch");
    assert.throws(() => f.manager.run("default", () => f.manager.services.startMcp()), /正在移除/);
    assert.equal(fs.existsSync(path.join(f.root, "config.json")), true);
    assert.equal(fs.existsSync(path.join(f.root, "account-recovery")), false);
    release();
    const result = await outcome;
    assert.ifError(result.error);
    assert.equal(result.value.removedId, "default");
    assert.equal(result.value.backup.created, true);
    assert.equal(f.manager.removingIds.has("default"), false);
  } finally {
    release();
    if (outcome) await outcome;
    service.refresh = oldRefresh;
    f.manager.portFree = oldPortFree;
  }
});
