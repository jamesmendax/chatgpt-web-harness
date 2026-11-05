"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const code = fs.readFileSync(path.join(__dirname, "../renderer/v3/core/core.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const config = { mcpPort: 3400, tunnelPort: 3401, adminPort: 3402, tunnelId: "tunnel_123456789", hasApiKey: true };
function harness({ search = "?desktop=1", bridge = true, realSim = false, overrides = {} } = {}) {
  const handlers = {}, calls = [], timers = [];
  let selected = "a";
  const accounts = () => ({ selectedId: selected, accounts: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
  const defaults = {
    listAccounts: accounts,
    selectAccount: p => { selected = p.id; return accounts(); },
    getConfig: () => ({ ...config }),
    appInfo: p => ({ accountId: p._accountId, version: "test" }),
    getStatus: p => ({ accountId: p._accountId, mcp: {}, tunnel: {} }),
    getLogs: () => ({ mcp: [], tunnel: [], launcher: [] }),
    getSkillCatalog: () => ({ installed: [], external: [], builtin: [], project: [], computerUse: {}, browserUse: {} }),
    pickSkillZip: () => "C:\\fixtures\\skill.zip",
    inspectSkillSource: () => ({ id: "skill", source: "C:\\fixtures\\extracted", temporary: true, warnings: [] }),
    discardSkillSource: () => true,
    installSkill: () => ({ result: { id: "skill" }, catalog: defaults.getSkillCatalog() }),
    saveConfig: () => ({ ...config }),
    setIdleReminder: p => ({ ...config, idleReminderMinutes: p.minutes }),
    runSetup: () => ({ ok: true, doctor: "passed" }),
    startAll: () => true,
    openLogsFolder: () => true,
    openLogFile: () => true,
    ...overrides
  };
  const launcher = { on: (name, fn) => { handlers[name] = fn; } };
  for (const [name, fn] of Object.entries(defaults)) launcher[name] = async payload => {
    calls.push({ name, payload });
    const result = await fn(payload);
    return { ok: true, result, accountId: payload?._accountId || selected };
  };
  const Sim = { fmt: { hms: n => new Date(n).toTimeString().slice(0, 8), relative: String, duration: String }, derive: a => a, SCENARIOS: [], create: () => ({ on() {}, actions: {}, snapshot: () => ({ account: { config } }) }) };
  const context = { window: { HarnessSim: Sim, ...(bridge ? { launcher } : {}) }, location: { search }, document: { hidden: false }, URLSearchParams, console, setInterval: fn => timers.push(fn), Date };
  if (realSim) vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/shared/sim.js"), "utf8"), context);
  vm.runInNewContext(code, context, { filename: "aura-core.js" });
  return { api: context.window.HarnessCore, calls, timers, emit: (name, data) => handlers[name](data), launcher };
}

test("desktop entry fails visibly without preload; preview remains explicit", async () => {
  await assert.rejects(harness({ bridge: false }).api.start(), /桌面连接未加载/);
  assert.equal((await harness({ bridge: false, search: "?preview=1" }).api.start()).mode, "preview");
  assert.equal((await harness({ search: "?desktop=1&preview=1" }).api.start()).mode, "electron");
});

test("collection timestamps, stderr marker and production activity grammar", () => {
  const { api } = harness();
  const reference = new Date(2026, 10, 1, 0, 5, 0).getTime();
  const old = api.parseLine("mcp", "23:59:00 ! [MCP ERROR] tools/call run_command — denied 27ms session=123", reference);
  assert.equal(old.ts, new Date(2026, 9, 31, 23, 59, 0).getTime());
  assert.equal(old.level, "error");
  assert.equal(old.text.startsWith("[MCP ERROR]"), true);
  const rows = api.activityFromLogs([
    api.parseLine("mcp", "00:01:00   [TOOL] [ok] read_text_file — test.txt 12ms session=123", reference), old,
    api.parseLine("mcp", "[TOOL] [blocked] apply_patch — rejected 1ms"),
    api.parseLine("mcp", "[HARNESS] status=success invocation=I1 tool=read_text_file duration_ms=12")
  ]);
  assert.equal(rows.length, 2, "unattributed transport failures remain logs, not failed tool calls");
  assert.equal(rows[0].tool, "read_text_file");
  assert.equal(rows[0].target, "test.txt");
  assert.equal(rows[0].ms, 12);
  assert.equal(rows[0].endedAt - rows[0].startedAt, 12);
  assert.equal(rows[1].phase, "failed");
  assert.equal(rows[1].ms, 1);
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].tool, "apply_patch");
});

test("conversation tags at the end of production lines keep summaries and durations intact", () => {
  const { api } = harness();
  const rows = api.activityFromLogs([
    api.parseLine("mcp", "14:00:00   [TOOL] [ok] read_text_file — test.txt 12ms session=123 conv=0123abcd"),
    api.parseLine("mcp", "14:00:01 ! [MCP ERROR] HTTP 400 tools/call write_file — denied 27ms session=123 conv=0123abcd"),
    api.parseLine("mcp", "14:00:02   [MCP] [running] tools/call run_command — npm test 60000ms session=123 conv=0123abcd")
  ]);
  assert.equal(rows.length, 1, "uncorrelated HTTP errors and in-flight reports are not extra calls");
  assert.deepEqual([rows[0].target, rows[0].ms], ["test.txt", 12]);
  const correlated = api.activityFromLogs([api.parseLine("mcp", "14:00:01 ! [MCP ERROR] HTTP 400 tools/call write_file — denied 27ms call=call-known session=123 conv=0123abcd")]);
  assert.deepEqual([correlated[0].summary, correlated[0].ms, correlated[0].phase], ["denied", 27, "failed"]);
});

test("legacy HTTP durations are never guessed onto uncorrelated tool records", () => {
  const { api } = harness();
  const reference = new Date(2026, 10, 1, 14, 0, 30).getTime();
  const parse = line => api.parseLine("mcp", line, reference);
  const rows = api.activityFromLogs([
    parse("14:00:00   [TOOL] [ok] run_command — C:/work"),
    parse("14:00:01   [MCP] [ok] tools/call run_command — npm test 500ms 1579ms session=1a2b3c4d conv=0123abcd"),
    parse("14:00:05   [TOOL] [ok] read_text_file — a.txt"),
    parse("14:00:05   [TOOL] [ok] read_text_file — b.txt"),
    parse("14:00:06   [MCP] [transport_ok] tools/call read_text_file — a.txt 8ms session=1a2b3c4d")
  ]);
  assert.equal(rows.length, 3, "completion lines are not extra calls");
  assert.equal(rows[0].ms, null);
  assert.equal(rows[0].endedAt - rows[0].startedAt, 0);
  assert.deepEqual([...rows.slice(1).map(r => r.ms)], [null, null], "two open read_text_file calls: the duration is not guessed");
  assert.equal(api.timedCall("[MCP] [running] tools/call run_command — npm test 60000ms session=1a2b3c4d"), null, "in-flight reports are not completions");
});

test("idle reminder interval saves through its own scoped call and rejects a stale account", async () => {
  const slow = deferred();
  let hold = false;
  const h = harness({ overrides: { setIdleReminder: p => hold ? slow.promise.then(() => ({ ...config, idleReminderMinutes: p.minutes })) : ({ ...config, idleReminderMinutes: p.minutes }) } });
  const core = await h.api.start();
  assert.equal(await core.act.setIdleReminder(15), 15);
  assert.equal(core.snapshot().account.config.idleReminderMinutes, 15);
  assert.deepEqual({ ...h.calls.find(c => c.name === "setIdleReminder").payload }, { minutes: 15, _accountId: "a" });
  assert.equal(h.calls.some(c => c.name === "saveConfig"), false, "does not go through the stop-required settings save");
  hold = true;
  const pending = core.act.setIdleReminder(0), rejected = assert.rejects(pending, e => e.code === "STALE");
  await core.act.selectAccount("b");
  slow.resolve();
  await rejected;
});

test("preview pairs work but ambiguous concurrent results never attach to a guessed call", () => {
  const { api } = harness();
  const parse = line => api.parseLine("mcp", line);
  const rows = api.activityFromLogs([parse("[tool] read_text_file · one"), parse("[result] Completed in 9 ms · done")]);
  assert.equal(rows[0].phase, "done");
  const concurrent = api.activityFromLogs([parse("[tool] read_text_file · one"), parse("[tool] run_command · two"), parse("[result] Failed in 9 ms · denied")]);
  assert.equal(concurrent.filter(r => r.phase === "running").length, 2);
});

test("scoped calls, prepared ZIP source and discard retain original account", async () => {
  const h = harness(), core = await h.api.start();
  assert.equal(h.calls.find(c => c.name === "getConfig").payload._accountId, "a");
  const source = await core.act.inspectSource("zip");
  assert.equal(source.source, "C:\\fixtures\\extracted");
  await core.act.installSkill("skill", source);
  assert.equal(h.calls.find(c => c.name === "installSkill").payload.source, source.source);
  await core.act.selectAccount("b");
  await core.act.discardSource(source);
  assert.equal(h.calls.find(c => c.name === "discardSkillSource").payload._accountId, "a");
  await assert.rejects(core.act.installSkill("skill", source), e => e.code === "STALE");
});

test("catalog refresh shows Skills installed elsewhere, keeps unsaved external drafts, rejects a stale account", async () => {
  let installed = [], hold = false;
  const slow = deferred();
  const catalogOf = () => ({ installed: installed.map(id => ({ id })), external: [{ id: "ext", path: "C:\\skills\\ext\\SKILL.md", enabled: true }], builtin: [], project: [], computerUse: {}, browserUse: {} });
  const h = harness({ overrides: { getSkillCatalog: () => hold ? slow.promise.then(catalogOf) : catalogOf() } });
  const core = await h.api.start();
  installed = ["from-mcp"];
  await core.act.refreshCatalog();
  assert.deepEqual(core.snapshot().catalog.installed.map(x => x.id), ["from-mcp"]);
  core.act.setExternalEnabled("ext", false);
  installed = ["from-mcp", "copied-by-hand"];
  await core.act.refreshCatalog();
  assert.equal(core.snapshot().catalog.installed.length, 2);
  assert.equal(core.snapshot().catalog.external[0].enabled, false, "an unsaved external edit survives a refresh");
  hold = true;
  const pending = core.act.refreshCatalog();
  const switching = core.act.selectAccount("b");
  for (let i = 0; i < 50 && core.snapshot().selectedId !== "b"; i++) await tick();
  assert.equal(core.snapshot().selectedId, "b", "account switch began while the refresh was in flight");
  slow.resolve();
  await assert.rejects(pending, e => e.code === "STALE");
  await switching;
  assert.equal(h.calls.filter(c => c.name === "getSkillCatalog").at(-1).payload._accountId, "b");
});

test("old response rejected even after A to B to A; old setup events filtered", async () => {
  const saved = deferred(), h = harness({ overrides: { saveConfig: () => saved.promise } });
  const core = await h.api.start(), progress = [];
  core.on("setup-progress", p => progress.push(p));
  const save = core.act.saveConfig({ ...config });
  const rejected = assert.rejects(save, e => e.code === "STALE");
  await core.act.selectAccount("b");
  h.emit("setup:progress", { accountId: "a", message: "old" });
  h.emit("setup:progress", null);
  await core.act.selectAccount("a");
  saved.resolve(config);
  await rejected;
  assert.equal(progress.length, 0);
});

test("initial logs merge events once and reconstruct history across midnight", async () => {
  const loaded = deferred(), line = "23:59:00   [TOOL] read_text_file — old.txt 2ms";
  const h = harness({ overrides: { getLogs: () => loaded.promise } });
  const started = h.api.start();
  await tick();
  h.emit("log", [{ accountId: "a", name: "mcp", line }]);
  h.emit("status", { accountId: "a", mcp: { state: "running" }, tunnel: {} });
  loaded.resolve({ mcp: [line], tunnel: [], launcher: [] });
  const core = await started;
  assert.equal(core.snapshot().logs.mcp.length, 1);
  assert.equal(core.snapshot().activity.length, 1);
  assert.equal(core.snapshot().account.mcp.state, "running");
});

test("live production completions notify activity; wrong-account and malformed events ignored", async () => {
  const h = harness(), core = await h.api.start(), events = [];
  core.on("activity", e => events.push(e));
  h.emit("log", [{ accountId: "b", name: "mcp", line: "[TOOL] run_command 5ms" }, null]);
  h.emit("log", { not: "a batch" });
  h.emit("log", [{ accountId: "a", name: "mcp", line: "[TOOL] [ok] run_command — done 5ms" }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "end");
  assert.equal(events[0].record.ms, 5);
});

test("setup failure preserves doctor detail, rejects inner ok:false, never reports success", async () => {
  const h = harness({ overrides: { runSetup: () => ({ ok: false, doctor: "401 fixture", message: "doctor failed" }) } });
  const core = await h.api.start(), progress = [], notices = [];
  core.on("setup-progress", p => progress.push(p));
  core.on("notice", n => notices.push(n));
  await assert.rejects(core.act.runSetup({ ...config }), /doctor failed/);
  assert.equal(progress[0], "doctor：401 fixture");
  assert.equal(notices.some(n => n.message.includes("初始化完成")), false);
  assert.equal(core.snapshot().pending.size, 0);
});

test("setup keeps structured failure and next action even if config refresh also fails", async () => {
  let reads = 0;
  const diagnosis = { ok: false, stage: "doctor", code: "LOCAL_MCP_UNREACHABLE", title: "本机 MCP 未就绪", message: "本机连接被拒绝", nextAction: "检查本机端口后重试", details: "CHECK mcp_server_reachable FAIL connection refused", checks: [{ name: "mcp_server_reachable", status: "FAIL", message: "connection refused" }] };
  const h = harness({ overrides: { getConfig: () => { if (++reads > 1) throw new Error("secondary refresh error"); return { ...config }; }, runSetup: () => diagnosis } });
  const core = await h.api.start();
  await assert.rejects(core.act.runSetup({ ...config }), error => error.code === diagnosis.code && error.stage === "doctor" && error.nextAction === diagnosis.nextAction && error.checks[0].name === "mcp_server_reachable" && error.details === diagnosis.details);
});

test("removing selected account reloads survivor, clears old data and does not attach deleted account scope", async () => {
  const snap = { removedId: "a", selectedId: "b", accounts: [{ id: "b", name: "B" }], backup: { created: true, path: "fixture/recovery" } };
  const h = harness({ overrides: { removeAccount: () => { h.emit("accounts:changed", snap); return snap; } } });
  const core = await h.api.start();
  h.emit("log", [{ accountId: "a", name: "mcp", line: "[TOOL] [ok] read_text_file — private-a.txt 2ms" }]);
  assert.equal(core.snapshot().activity.length, 1);
  const result = await core.act.removeAccount("a");
  assert.equal(result.backup.path, "fixture/recovery");
  assert.equal(core.snapshot().selectedId, "b");
  assert.equal(core.snapshot().activity.length, 0);
  assert.deepEqual({ ...h.calls.find(c => c.name === "removeAccount").payload }, { id: "a" });
  assert.ok(h.calls.some(c => c.name === "getConfig" && c.payload._accountId === "b"));
  h.emit("log", [{ accountId: "a", name: "mcp", line: "[TOOL] [ok] read_text_file — late-a.txt 2ms" }]);
  assert.equal(core.snapshot().activity.length, 0);
});

test("failed account removal preserves current account and releases the selection queue", async () => {
  const h = harness({ overrides: { removeAccount: () => { throw new Error("请先停止账号的 MCP 和隧道"); } } });
  const core = await h.api.start();
  await assert.rejects(core.act.removeAccount("a"), /请先停止/);
  assert.equal(core.snapshot().selectedId, "a");
  await core.act.selectAccount("b");
  assert.equal(core.snapshot().selectedId, "b");
});

test("an existing Tunnel directs to the saved account and port before asking for a key or initializing", async () => {
  const h = harness({ overrides: {
    listAccounts: () => ({ selectedId: "a", accounts: [{ id: "a", name: "空白账户", config: {} }, { id: "b", name: "原账户", config: { ...config, mcpPort: 4567 } }] }),
    getConfig: () => ({ ...config, hasApiKey: false, tunnelId: "" }),
    runSetup: () => assert.fail("existing account must not be reinitialized as a second account")
  } });
  const core = await h.api.start();
  await assert.rejects(core.act.runSetup({ ...config, apiKey: "" }), error => error.code === "EXISTING_ACCOUNT" && error.existingAccountId === "b" && /4567/.test(error.message));
  assert.equal(h.calls.some(call => call.name === "runSetup"), false);
});

test("import reloads an adopted account even when its identity stays the same", async () => {
  let reads = 0;
  const h = harness({ overrides: { getConfig: () => ({ ...config, mcpPort: ++reads > 1 ? 4567 : config.mcpPort }), importAccount: () => ({ accountId: "a", reused: false }) } });
  const core = await h.api.start();
  h.emit("log", [{ accountId: "a", name: "mcp", line: "[TOOL] [ok] read_text_file — before-import.txt 1ms" }]);
  await core.act.importAccount({ token: "fixture-token", sourceId: "default" });
  assert.equal(core.snapshot().account.config.mcpPort, 4567);
  assert.equal(core.snapshot().activity.length, 0);
  assert.deepEqual({ ...h.calls.find(call => call.name === "importAccount").payload }, { token: "fixture-token", sourceId: "default" });
});

test("import inspection cannot open a stale review after the user switches accounts", async () => {
  const later = deferred(), h = harness({ overrides: { inspectAccountImport: () => later.promise } });
  const core = await h.api.start(), inspecting = core.act.inspectAccountImport();
  const rejected = assert.rejects(inspecting, error => error.code === "STALE");
  await core.act.selectAccount("b"); later.resolve({ token: "old-target", accounts: [] }); await rejected;
});

test("poll response cannot overwrite a newer status event or reset account", async () => {
  let count = 0; const poll = deferred();
  const h = harness({ overrides: { getStatus: p => ++count === 1 ? { accountId: p._accountId, mcp: {}, tunnel: {} } : poll.promise } });
  const core = await h.api.start(); let accounts = 0;
  core.on("account", () => accounts++);
  const polling = h.timers[0]();
  h.emit("status", { accountId: "a", mcp: { state: "running" }, tunnel: {} });
  poll.resolve({ accountId: "a", mcp: { state: "stopped" }, tunnel: {} });
  await polling; await tick();
  assert.equal(core.snapshot().account.mcp.state, "running");
  assert.equal(accounts, 0);
});

test("late inspection cleans temporary extraction in its original account", async () => {
  const inspected = deferred(), h = harness({ overrides: { inspectSkillSource: () => inspected.promise } });
  const core = await h.api.start();
  const source = core.act.inspectSource("zip"), rejected = assert.rejects(source, e => e.code === "STALE");
  await tick();
  await core.act.selectAccount("b");
  inspected.resolve({ source: "C:\\fixtures\\late-extracted", temporary: true, id: "skill" });
  await rejected; await tick();
  const discarded = h.calls.find(c => c.name === "discardSkillSource");
  assert.equal(discarded.payload._accountId, "a");
  assert.equal(discarded.payload.source, "C:\\fixtures\\late-extracted");
});

test("busy service belongs to its account and cannot block the next account", async () => {
  const first = deferred(); let starts = 0;
  const h = harness({ overrides: { startAll: () => ++starts === 1 ? first.promise : true } });
  const core = await h.api.start(), notices = [];
  core.on("notice", n => notices.push(n));
  const old = core.act.startAll(), rejected = assert.rejects(old, e => e.code === "STALE");
  assert.equal(core.snapshot().pending.has("startAll"), true);
  await core.act.selectAccount("b");
  assert.equal(core.snapshot().pending.has("startAll"), false);
  await core.act.startAll();
  first.resolve(true);
  await rejected;
  assert.equal(starts, 2);
  assert.equal(notices.filter(n => n.message.includes("请求已处理")).length, 1);
});

const externalStatus = p => ({
  accountId: p._accountId,
  mcp: { state: "stopped", managed: false, external: true, healthy: true, pid: 12001, portOccupiedByUnknown: false, toolCount: 77, toolProfile: "full", build: "external-build" },
  tunnel: { state: "stopped", managed: false, external: true, ready: true, reachable: true, cloudState: "online", lastPollSuccessAt: Date.now() - 5000, pid: 12002, portOccupiedByUnknown: false }
});

test("isolated unconfigured account never inherits external tool count, cloud or readiness", async () => {
  const h = harness({ realSim: true, overrides: {
    appInfo: () => ({ isolated: true, multiAccount: false }), getStatus: externalStatus,
    getConfig: () => ({ ...config, setupDone: false })
  } });
  const core = await h.api.start(), s = core.snapshot();
  assert.equal(s.derived.title, "账户未配置");
  assert.equal(s.derived.cloudOnline, false);
  assert.equal(s.derived.stages.cloud.label, "未连接");
  assert.equal(s.account.mcp.healthy, false);
  assert.equal(s.account.mcp.toolCount, null);
  assert.equal(s.account.mcp.portOccupiedByUnknown, true);
  assert.equal(s.account.mcp.pid, 12001);
  assert.equal(s.account.mcp.observedExternal.toolCount, 77);
  assert.match(s.derived.mcp.source, /外部进程占用/);
  assert.equal(s.account.tunnel.ready, false);
  assert.equal(s.account.tunnel.reachable, false);
  assert.equal(s.account.tunnel.cloudState, "offline");
  assert.equal(s.account.tunnel.lastPollSuccessAt, null);
  assert.equal(s.account.tunnel.pid, 12002);
  assert.equal(s.account.tunnel.portOccupiedByUnknown, true);
  assert.equal(s.account.tunnel.observedExternal.cloudState, "online");
  assert.match(s.derived.tunnel.cloudText, /不计入本账户/);
});

test("configured multi-account profile reports external listeners as port collision", async () => {
  const h = harness({ realSim: true, overrides: {
    appInfo: () => ({ isolated: false, multiAccount: true }), getStatus: externalStatus,
    getConfig: () => ({ ...config, setupDone: true })
  } });
  const core = await h.api.start(), s = core.snapshot();
  assert.equal(s.derived.problem, "port");
  assert.equal(s.derived.title, "监听端口被占用");
  assert.equal(s.derived.tunnelBadge.text, "端口被占用");
  assert.equal(s.derived.mcpBadge.text, "端口被占用");
  assert.equal(s.derived.cloudOnline, false);
});

test("owned managed readiness remains online and unknown listener diagnostics remain visible", async () => {
  const h = harness({ realSim: true, overrides: {
    appInfo: () => ({ isolated: true, multiAccount: true }),
    getConfig: () => ({ ...config, setupDone: true }),
    getStatus: p => { const s = externalStatus(p); s.mcp.managed = true; s.tunnel.managed = true; s.mcp.external = false; s.tunnel.external = false; return s; }
  } });
  const core = await h.api.start();
  assert.equal(core.snapshot().derived.cloudOnline, true);
  assert.equal(core.snapshot().account.mcp.toolCount, 77);
  h.emit("status", { accountId: "a", mcp: { managed: false, healthy: false, portOccupiedByUnknown: true, pid: 13000 }, tunnel: { managed: false, ready: false, reachable: true, portOccupiedByUnknown: true, pid: 13001, authError: { line: "external auth" } } });
  const s = core.snapshot();
  assert.equal(s.derived.cloudOnline, false);
  assert.equal(s.derived.problem, "port");
  assert.equal(s.account.mcp.pid, 13000);
  assert.equal(s.account.tunnel.authError, null);
  assert.equal(s.account.tunnel.observedExternal.authError.line, "external auth");
});

test("launcher log opens folder while MCP and Tunnel use actual log file IPC", async () => {
  const h = harness(), core = await h.api.start();
  await core.act.openLogFile("launcher");
  await core.act.openLogFile("mcp");
  await core.act.openLogFile("tunnel");
  assert.equal(h.calls.filter(c => c.name === "openLogsFolder").length, 1);
  assert.deepEqual(h.calls.filter(c => c.name === "openLogFile").map(c => c.payload.name), ["mcp", "tunnel"]);
});

// Exercise the actual renderer cache seam without launching Electron.
test("recent history refreshes an existing card when its completion duration arrives", async () => {
  const core = await harness().api.start();
  const app = fs.readFileSync(path.join(__dirname, "../renderer/v3/aura/app.js"), "utf8");
  const render = app.slice(app.indexOf("  const outcomeLabel ="), app.indexOf('  core.on("activity"'));
  let rendered = [];
  const context = {
    core, ui: { lastSig: {} }, RM: { matches: true }, Date, Set,
    $: () => ({ replaceChildren: (...nodes) => { rendered = nodes; } }), $$: () => [],
    h: (tag, attrs, ...children) => ({ tag, attrs, children }),
    stamp: String, relative: String, duration: ms => ms == null ? "unrecorded" : `${ms}ms`,
    text() {},
  };
  vm.createContext(context); vm.runInContext(render, context);
  const record = { id: "L1", tool: "run_command", phase: "done", ms: null, startedAt: 10000 };
  const snapshot = { activity: [record], derived: { cloudOnline: true } };
  context.renderHistory(snapshot);
  assert.match(JSON.stringify(rendered), /unrecorded/);
  Object.assign(record, { ms: 1579, startedAt: 8421 });
  context.renderHistory(snapshot);
  assert.match(JSON.stringify(rendered), /1579ms/, "the already displayed card must invalidate its cache");
  assert.equal(rendered[0].attrs.dataset.ts, 8421, "corrected start time reaches the existing history row");
});

function storyHarness() {
  const app = fs.readFileSync(path.join(__dirname, "../renderer/v3/aura/app.js"), "utf8");
  const start = app.indexOf("  function storyItems(entries) {");
  const end = app.indexOf("  const itemLevel", start);
  const context = { HarnessCore: harness().api, runningReport: () => null };
  vm.runInNewContext(app.slice(start, end), context);
  return lines => context.storyItems(lines.map((text, i) => ({ seq: i + 1, ts: 10000 + i, time: "12:00:00", text, level: "info" })));
}

test("canonical diagnostics distinguish input, review and runtime failures without visible token clutter", () => {
  const { api } = harness();
  const rows = api.activityFromLogs([
    api.parseLine("mcp", "[MCP ERROR] HTTP 200 tools/call run_command — Supply missing requirement fields 2ms outcome=needs_input code=REQUIREMENT_CONTRACT_REQUIRED phase=admission started=false retry=retry_with_changed_args call=D1"),
    api.parseLine("mcp", "[tool] tools/call visual_review error 5ms outcome=review_rejected code=VISUAL_CRITIQUE_CONTRADICTION phase=validation started=false retry=refresh_state call=D2 client=chatgpt — Locked quality bar not met"),
    api.parseLine("mcp", "[TOOL] [error] run_command — Command exited with 7 11ms outcome=execution_error code=COMMAND_EXIT_NONZERO phase=execution started=true retry=inspect_original_result call=D3 conv=0123abcd")
  ]);
  assert.deepEqual([...rows.map(r => [r.callId, r.phase, r.ok, r.outcomeKind, r.operationStarted])], [
    ["D1", "failed", false, "needs_input", false],
    ["D2", "failed", false, "review_rejected", false],
    ["D3", "failed", false, "execution_error", true]
  ]);
  assert.equal(rows[0].failurePhase, "admission");
  assert.equal(rows[0].errorCode, "REQUIREMENT_CONTRACT_REQUIRED");
  assert.equal(rows[0].retryPolicy, "retry_with_changed_args");
  assert.equal(rows[1].summary, "Locked quality bar not met");
  assert.equal(rows[2].target, "Command exited with 7");
  for (const row of rows) assert.doesNotMatch(row.summary, /outcome=|started=|retry=/);
});

test("diagnostic-only updates invalidate records and late success clears stale fallback metadata", () => {
  const { api } = harness(), rows = [], changes = [];
  const parse = text => api.parseLine("mcp", text);
  api.activityFromLogs([parse("[MCP ERROR] tools/call run_command — blocked 2ms call=D4")], rows, changes);
  api.activityFromLogs([parse("[MCP ERROR] tools/call run_command — blocked 2ms outcome=blocked code=RI_BLOCKED phase=admission started=false retry=refresh_state call=D4")], rows, changes);
  assert.equal(rows.length, 1); assert.equal(changes.length, 2); assert.equal(rows[0].outcomeKind, "blocked");
  api.activityFromLogs([parse("[TOOL] [ok] run_command — completed 3ms call=D4")], rows, changes);
  assert.equal(rows[0].phase, "done"); assert.equal(rows[0].outcomeKind, undefined); assert.equal(rows[0].operationStarted, undefined);
});

test("summary text and unknown diagnostic values cannot masquerade as a valid outcome", () => {
  const { api } = harness();
  const rows = api.activityFromLogs([
    api.parseLine("mcp", "[TOOL] [error] run_command — echo outcome=needs_input 2ms call=D5"),
    api.parseLine("mcp", "[TOOL] [error] run_command — real error 2ms outcome=success phase=done started=perhaps retry=blind call=D6")
  ]);
  assert.equal(rows[0].outcomeKind, undefined);
  assert.equal(rows[0].summary, "echo outcome=needs_input");
  assert.equal(rows[1].phase, "failed"); assert.equal(rows[1].outcomeKind, undefined); assert.equal(rows[1].operationStarted, undefined);
});

test("narrative updates one canonical call through start, heartbeat, terminal and HTTP diagnostics", () => {
  const items = storyHarness()([
    "[TOOL] [running] read_text_file — a.txt 0ms call=call-a conv=0123abcd",
    "[TOOL] [running] read_text_file — a.txt 200ms call=call-a conv=0123abcd",
    "[TOOL DETAIL] read_text_file call=call-a",
    "[TOOL] [ok] read_text_file — a.txt 450ms call=call-a conv=0123abcd",
    "[MCP] [ok] tools/call read_text_file — a.txt 470ms call=call-a conv=0123abcd",
  ]);
  assert.equal(items.length, 1, "one invocation has one narrative card");
  assert.equal(items[0].callId, "call-a");
  assert.equal(items[0].target, "a.txt");
  assert.equal(items[0].result.ms, 450, "HTTP overhead must not replace canonical elapsed time");
  assert.equal(items[0].result.ok, true);
});

test("narrative keeps concurrent same-tool calls and out-of-order failures correlated", () => {
  const items = storyHarness()([
    "[TOOL] [running] read_text_file — a.txt 0ms call=call-a",
    "[TOOL] [running] read_text_file — b.txt 0ms call=call-b",
    "[TOOL] [error] read_text_file — b.txt 7ms call=call-b",
    "[MCP ERROR] tools/call read_text_file — denied 11ms call=call-b",
    "[TOOL] [ok] read_text_file — a.txt 42ms call=call-a",
    "[MCP] [ok] tools/call read_text_file — a.txt 44ms call=call-a",
  ]);
  assert.equal(items.length, 2);
  const byId = new Map(items.map(item => [item.callId, item]));
  assert.equal(byId.get("call-a").result.ms, 42);
  assert.equal(byId.get("call-b").result.ms, 7);
  assert.equal(byId.get("call-b").result.ok, false);
});

test("canonical live lifecycle correlates parallel same-tool calls and ignores replay across accounts", async () => {
  const h = harness(), core = await h.api.start(), events = [];
  core.on("activity", e => events.push({ kind: e.kind, id: e.record.callId, phase: e.record.phase, ms: e.record.ms }));
  const emit = (line, accountId = "a") => h.emit("log", [{ accountId, name: "mcp", line }]);
  emit("[TOOL] [running] run_command — first 0ms call=I1 session=abc conv=0123abcd");
  emit("[TOOL] [running] run_command — second 0ms call=I2 session=abc conv=0123abcd");
  assert.equal(core.snapshot().activity.filter(r => r.phase === "running").length, 2);
  emit("[TOOL] [ok] run_command — second 7ms call=I2 session=abc conv=0123abcd");
  emit("[TOOL] [error] run_command — first denied 19ms call=I1 session=abc conv=0123abcd");
  emit("[TOOL] [ok] run_command — second 7ms call=I2 session=abc conv=0123abcd");
  emit("[TOOL] [running] run_command — replay 0ms call=I1 session=abc conv=0123abcd");
  emit("[TOOL] [running] run_command — wrong 0ms call=I3", "b");
  const rows = core.snapshot().activity;
  assert.deepEqual([...rows.map(r => [r.callId, r.phase, r.ms])], [["I1", "failed", 19], ["I2", "done", 7]]);
  assert.deepEqual(events, [{kind:"start",id:"I1",phase:"running",ms:0},{kind:"start",id:"I2",phase:"running",ms:0},{kind:"end",id:"I2",phase:"done",ms:7},{kind:"end",id:"I1",phase:"failed",ms:19}]);
  await core.act.selectAccount("b");
  emit("[TOOL] [ok] run_command — late a 9ms call=I1", "a");
  assert.equal(core.snapshot().activity.length, 0);
  emit("[TOOL] [running] run_command — b 0ms call=I1", "b");
  assert.equal(core.snapshot().activity[0].phase, "running", "call IDs remain account scoped");
});

test("canonical stdout and Admin feed describe one lifecycle with exact duration", () => {
  const { api } = harness();
  const rows = api.activityFromLogs([
    api.parseLine("mcp", "[TOOL] [running] read_text_file — a.txt 0ms call=I9 conv=0123abcd"),
    api.parseLine("mcp", "[tool] tools/call read_text_file running 0ms call=I9 client=chatgpt conv=0123abcd — a.txt"),
    api.parseLine("mcp", "[tool] tools/call read_text_file ok 2ms call=I9 client=chatgpt conv=0123abcd — a.txt"),
  ]);
  assert.equal(rows.length, 1); assert.equal(rows[0].ms, 2); assert.equal(rows[0].phase, "done");
  assert.equal(rows[0].target, "a.txt");
});

test("a fast canonical call emits start and end even in one IPC log batch", async () => {
  const h = harness(), core = await h.api.start(), events = [];
  core.on("activity", e => events.push(e.kind));
  h.emit("log", [
    { accountId: "a", name: "mcp", line: "[TOOL] [running] read_text_file — started 0ms call=fast-1" },
    { accountId: "a", name: "mcp", line: "[TOOL DETAIL] [ok] read_text_file — a.txt call=fast-1" },
    { accountId: "a", name: "mcp", line: "[TOOL] [ok] read_text_file — completed 1ms call=fast-1" },
  ]);
  assert.deepEqual(events, ["start", "end"]);
  assert.equal(core.snapshot().activity.length, 1);
  assert.equal(core.snapshot().activity[0].ms, 1);
  assert.equal(core.snapshot().activity[0].phase, "done");
});

test("legacy bridge log callbacks retain completion and preview-pair activity notifications", async () => {
  const h = harness(), core = await h.api.start(), events = [];
  core.on("activity", e => events.push({ kind: e.kind, tool: e.record.tool, phase: e.record.phase, ms: e.record.ms }));
  const emit = line => h.emit("log", [{ accountId: "a", name: "mcp", line }]);
  emit("[TOOL] [ok] read_text_file — legacy.txt 3ms");
  emit("[tool] run_command · npm test");
  emit("[result] Completed in 9 ms · complete");
  assert.deepEqual(events, [{ kind: "end", tool: "read_text_file", phase: "done", ms: 3 }, { kind: "start", tool: "run_command", phase: "running", ms: null }, { kind: "end", tool: "run_command", phase: "done", ms: 9 }]);
});

test("correlated HTTP diagnostics never duplicate or overwrite canonical tool outcomes", async () => {
  const h = harness(), core = await h.api.start(), events = [];
  core.on("activity", e => events.push(e.kind));
  const emit = line => h.emit("log", [{accountId:"a",name:"mcp",line}]);
  emit("[TOOL] [running] run_command — target 0ms call=E1 conv=0123abcd");
  emit("[TOOL] [error] run_command — target 7ms call=E1 conv=0123abcd");
  emit("[MCP ERROR] HTTP 200 tools/call run_command — rejected 11ms call=E1 session=abc conv=0123abcd");
  emit("[MCP] [ok] tools/call run_command — target 12ms call=E1 session=abc conv=0123abcd");
  assert.equal(core.snapshot().activity.length,1);
  assert.equal(core.snapshot().activity[0].ms,7);
  assert.equal(core.snapshot().activity[0].phase,"failed");
  assert.deepEqual(events,["start","end"]);
});

test("exact-ID HTTP fallbacks stay separate and yield to late canonical lifecycle", () => {
  const {api}=harness(), rows=[];
  const parse = text => api.parseLine("mcp",text);
  api.activityFromLogs([parse("[MCP ERROR] HTTP 400 tools/call run_command — denied 9ms call=A1"),parse("[mcp] tools/call run_command ok 11ms call=A2 client=chatgpt — target")],rows);
  assert.deepEqual([...rows.map(r=>[r.callId,r.ms,r.phase,r.transport])],[["A1",9,"failed",true],["A2",11,"done",true]]);
  api.activityFromLogs([parse("[TOOL] [running] run_command — target 0ms call=A1"),parse("[TOOL] [ok] run_command — target 5ms call=A1"),parse("[MCP ERROR] HTTP 400 tools/call run_command — replay 90ms call=A1")],rows);
  assert.equal(rows.length,2); assert.equal(rows[0].ms,5); assert.equal(rows[0].phase,"done"); assert.equal(rows[0].transport,false);
});
