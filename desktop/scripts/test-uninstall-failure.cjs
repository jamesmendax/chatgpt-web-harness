"use strict";
// Component acceptance: execute the complete production main module's real
// registerIpc/wrap and paths.uninstallUserData inside a Node VM. No Electron,
// native installer, service, dialog, shortcut, registry, or OS input is used.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");

const desktop = path.resolve(__dirname, "..");
const repo = path.dirname(desktop);
const mainFile = path.join(desktop, "src", "main.js");
const pathsFile = path.join(desktop, "src", "paths.js");
const requireDesktop = createRequire(mainFile);
const { profile } = requireDesktop("./app-profile");
const ipcSource = requireDesktop("./ipc-source");
const memoryGuard = requireDesktop("./renderer-memory-guard");
const idleWatch = requireDesktop("./idle-watch");
const sourceFiles = [mainFile, pathsFile, path.join(desktop, "src", "app-profile.js"),
  path.join(desktop, "src", "ipc-source.js"), path.join(desktop, "src", "renderer-memory-guard.js"),
  path.join(desktop, "src", "idle-watch.js"), path.join(desktop, "package.json"), __filename];
const hashes = () => sourceFiles.map(file => ({ path: path.relative(repo, file).replaceAll("\\", "/"),
  sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") }));
const before = hashes();
const mainSource = fs.readFileSync(mainFile, "utf8");
const pathsSource = fs.readFileSync(pathsFile, "utf8");
const base = path.resolve(process.env.HARNESS_UNINSTALL_FAILURE_EVIDENCE_DIR ||
  path.join(repo, ".validation", "resume-uninstall-failure-20261106"));
fs.mkdirSync(base, { recursive: true });
const evidence = fs.mkdtempSync(path.join(base, "uninstall-failure-"));
const records = [];
const forbidden = name => () => { throw new Error("Fixture forbids native/unrelated action: " + name); };
const plain = value => JSON.parse(JSON.stringify(value));
function inside(root, file) {
  const relative = path.relative(root, path.resolve(file));
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function fixture(name, { response = 1, invalidPath = false, removeError = false, shutdownError = false, dialogError = false } = {}) {
  const root = path.join(evidence, name);
  const userData = path.join(root, invalidPath ? "not-an-app-profile" : profile.userDataBasenames[0]);
  const runtime = path.join(userData, "runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const marker = path.join(userData, "fixture.txt");
  const markerBytes = Buffer.from("owned uninstall fixture: " + name + " 你好\n");
  fs.writeFileSync(marker, markerBytes);
  const events = [], errors = [], confirmations = [], immediate = [], handlers = new Map();
  const state = { shutdownStarted: false, servicesStopped: false, busy: false, quitCalls: 0, startCalls: 0, removeCalls: 0 };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true,
    getPath: kind => kind === "userData" ? userData : path.join(root, kind),
    getVersion: () => "3.2.0-fixture",
    commandLine: { appendSwitch: (key, value) => events.push(["switch", key, value]) },
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: () => { events.push("ready-deferred"); } }),
    quit: () => {
      // Spy on the handler's quit request; native Electron lifecycle is outside
      // this component test and is not fabricated by emitting app events.
      state.quitCalls++; events.push("quit");
    },
    exit: forbidden("real process exit"),
    setAppUserModelId: forbidden("taskbar identity"),
  });
  const services = new EventEmitter();
  Object.assign(services, {
    note: message => events.push(["note", message]),
    mcp: { isAlive: () => !state.servicesStopped, lines: [] },
    tunnel: { isAlive: () => !state.servicesStopped, lines: [] },
    launcherLines: [],
    shutdown: async () => {
      events.push("shutdown-start"); state.shutdownStarted = true;
      if (shutdownError) throw new Error("owned fixture shutdown failure");
      state.servicesStopped = true; events.push("shutdown-complete");
    },
    collectStatus: async () => ({ busy: state.busy, shuttingDown: state.shutdownStarted }),
    startAll: async () => {
      if (state.shutdownStarted) throw new Error("fixture shutting down");
      state.startCalls++; events.push("start-all"); return { started: true };
    },
  });
  const feeds = new EventEmitter();
  feeds.stop = () => events.push("feeds-stop");
  class FixtureAccounts extends EventEmitter {
    constructor() {
      super(); this.services = services; this.feeds = feeds;
      this.selectedId = "default"; this.currentId = "default";
      this.registry = { accounts: [{ id: "default" }] }; this.instances = new Map();
    }
    run(id, fn) { assert.equal(id, "default", "only fixture account may execute"); return fn(); }
    scope() { return { dataDir: userData }; }
    readConfig() { return { setupDone: false, notificationVolume: 70 }; }
    anyAlive() { return !state.servicesStopped; }
    init() { throw new Error("Fixture forbids account/service startup"); }
  }
  const dialog = {
    showMessageBox: async (_window, options) => {
      events.push("confirmation"); confirmations.push(plain(options));
      if (dialogError) throw new Error("owned fixture confirmation failure");
      return { response };
    },
    showErrorBox: (title, detail) => { events.push("error-dialog"); errors.push({ title, detail }); },
    showOpenDialog: forbidden("native file dialog"),
  };
  const checkRead = file => {
    const resolved = path.resolve(file);
    // paths.canDeleteUserData must inspect real ancestor entries as well as
    // the fixture; no AppData junction or unrelated descendant is traversed.
    assert.ok(inside(root, resolved) || inside(resolved, root), "read outside fixture/ancestors: " + resolved);
    return resolved;
  };
  const io = {
    readFileSync: (file, ...args) => fs.readFileSync(checkRead(file), ...args),
    existsSync: file => fs.existsSync(checkRead(file)),
    lstatSync: file => fs.lstatSync(checkRead(file)),
    rmSync: (file, options) => {
      assert.equal(path.resolve(file), userData, "production removal must target this exact owned data directory");
      assert.equal(options.recursive, true); assert.equal(options.force, true);
      state.removeCalls++; events.push("remove-data");
      assert.equal(state.servicesStopped, true, "data removal occurs after fixture service shutdown");
      if (removeError) throw Object.assign(new Error("owned fixture deletion denied: " + userData), { code: "EPERM" });
      fs.rmSync(userData, options);
    },
  };
  const electron = { app, dialog,
    ipcMain: { handle: (name, handler) => { assert.equal(handlers.has(name), false); handlers.set(name, handler); } },
    BrowserWindow: forbidden("BrowserWindow"), Tray: forbidden("Tray"), Notification: forbidden("Notification"),
    shell: new Proxy({}, { get: (_, key) => forbidden("shell." + String(key)) }),
    clipboard: new Proxy({}, { get: (_, key) => forbidden("clipboard." + String(key)) }),
    powerMonitor: { on: forbidden("powerMonitor registration") },
  };
  const accountContext = { current: () => null, dataDir: value => value,
    assertUnlinked: value => { assert.ok(inside(root, value)); return value; } };
  const common = { electron, path, fs: io, crypto,
    "./app-profile": { profile }, "./account-context": accountContext };
  function evaluate(source, file, mocks, extra = "") {
    const module = { exports: {} };
    const context = {
      Buffer, URL, console, __fixtureWindow: window,
      process: { argv: ["fixture", file], env: { CLC_RUNTIME_DIR: runtime },
        versions: { node: process.versions.node }, platform: process.platform,
        resourcesPath: path.join(root, "resources"), execPath: path.join(root, "fixture.exe") },
      setImmediate: fn => { immediate.push(fn); return immediate.length; },
      setInterval: forbidden("background timer"), clearInterval: () => {},
      setTimeout: forbidden("background timeout"), clearTimeout: () => {},
    };
    const load = request => {
      assert.ok(Object.prototype.hasOwnProperty.call(mocks, request), "Unmocked dependency would escape fixture: " + request);
      return mocks[request];
    };
    vm.runInNewContext("(function(require,module,exports,__filename,__dirname){\n" + source + "\n" + extra + "\n})", context,
      { filename: file, timeout: 1000 })(load, module, module.exports, file, path.dirname(file));
    return module.exports;
  }
  const frame = { url: ipcSource.auraUrl(path.join(desktop, "renderer", "v3", "aura", "index.html")) };
  const contents = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const actualPaths = evaluate(pathsSource, pathsFile, { ...common,
    "./payload-manifest": { validatePayload: forbidden("payload startup") }, "./lazy-browser-runtime": {} });
  const mocks = { ...common,
    "./app-icons": { iconPath: () => null, createTrayIcon: forbidden("tray icon") },
    "./taskbar-identity": { resolveTaskbarAppId: () => "fixture-app", applyTaskbarIdentity: forbidden("taskbar identity") },
    "./isolated-runtime": { initializeIsolatedRuntime: () => ({ notificationAppDataDir: path.join(root, "appData") }) },
    "./idle-notification": { createIdleNotifier: () => ({ dispose: () => events.push("notifier-dispose") }) },
    "./notification-sound": { createNotificationSound: () => ({ dispose: () => events.push("sound-dispose") }), SOUND_CHOICES: [], SOUND_IDS: new Set() },
    "./notification-audio-store": {}, "./notification-identity": {},
    "./paths": actualPaths,
    "./config": { publicView: value => value },
    "./computer-use-runtime": {}, "./tunnel-proxy": {}, "./legacy": {}, "./skills": {}, "./zip-safety": {}, "./shell-util": {},
    "./accounts": { AccountManager: FixtureAccounts },
    "./account-import": { AccountImport: class {} },
    "./conversation-index": { ConversationIndex: class {} },
    "./idle-watch": idleWatch, "./ipc-source": ipcSource, "./renderer-memory-guard": memoryGuard,
  };
  // Evaluate the entire production main module without booting its ready
  // callback, then call its real registration function with a trusted fixture
  // window. The uninstall handler and wrap are neither extracted nor rewritten.
  evaluate(mainSource, mainFile, mocks, "mainWindow = __fixtureWindow; registerIpc();");
  assert.ok(handlers.has("app:uninstall"));
  assert.ok(handlers.size > 30, "real registerIpc registers its full handler set");
  const event = { sender: contents, senderFrame: frame };
  return { root, userData, marker, markerBytes, events, errors, confirmations, state,
    invoke: async (name = "app:uninstall", payload, providedEvent = event) => plain(await handlers.get(name)(providedEvent, payload)),
    flushQuit: () => { assert.equal(immediate.length, 1, "exactly one deferred app.quit"); immediate.shift()(); },
    pendingQuit: () => immediate.length,
  };
}

function component(name, fn) {
  test(name, { timeout: 2000 }, async () => {
    const record = { name, passed: false };
    try { await fn(record); record.passed = true; }
    catch (error) { record.error = error.stack || String(error); throw error; }
    finally { records.push(record); }
  });
}
async function stillUsable(f) {
  const status = await f.invoke("status:get"); assert.equal(status.ok, true);
  assert.equal(status.result.busy, false); assert.equal(status.result.shuttingDown, false);
  const start = await f.invoke("services:startAll"); assert.equal(start.ok, true); assert.equal(start.result.started, true);
  assert.equal(f.state.quitCalls, 0); assert.equal(f.pendingQuit(), 0);
  assert.deepEqual(fs.readFileSync(f.marker), f.markerBytes);
}

component("cancel keeps data and the real IPC wrapper usable without teardown", async record => {
  const f = fixture("cancel", { response: 0 });
  assert.deepEqual(await f.invoke(), { ok: true, result: { canceled: true }, accountId: "default" });
  assert.equal(f.confirmations[0].defaultId, 0); assert.equal(f.confirmations[0].cancelId, 0);
  assert.equal(f.state.shutdownStarted, false); assert.equal(f.state.removeCalls, 0); assert.deepEqual(f.errors, []);
  await stillUsable(f); record.fixture = f.root;
});
component("pre-shutdown path refusal returns an error and leaves subsequent actions usable", async record => {
  const f = fixture("pre-shutdown", { invalidPath: true });
  const result = await f.invoke(); assert.equal(result.ok, false); assert.match(result.error, /userData.*白名单/);
  assert.equal(f.state.shutdownStarted, false); assert.equal(f.state.removeCalls, 0); assert.deepEqual(f.errors, []);
  await stillUsable(f); record.fixture = f.root;
});
component("data deletion failure after shutdown reports the owned manual path and schedules exit", async record => {
  const f = fixture("delete-failure", { removeError: true });
  const result = await f.invoke(); assert.equal(result.ok, true); assert.equal(result.result.partial, true);
  assert.equal(result.result.removed, null); assert.match(result.result.error, /owned fixture deletion denied/);
  assert.equal(f.state.servicesStopped, true); assert.equal(f.state.removeCalls, 1);
  assert.equal(f.events.indexOf("shutdown-complete") < f.events.indexOf("feeds-stop"), true);
  assert.equal(f.events.indexOf("feeds-stop") < f.events.indexOf("remove-data"), true);
  assert.equal(f.errors.length, 1); assert.equal(f.errors[0].title, "部分数据未能删除");
  assert.ok(f.errors[0].detail.includes("退出后可手动删除：\n" + f.userData));
  assert.deepEqual(fs.readFileSync(f.marker), f.markerBytes);
  assert.equal((await f.invoke("status:get")).error, "程序正在退出。");
  f.flushQuit(); assert.equal(f.state.quitCalls, 1); assert.equal(f.state.busy, false); assert.equal(f.pendingQuit(), 0);
  record.fixture = f.root; record.manualPath = f.userData; record.result = result; record.errors = f.errors;
});
component("shutdown failure after teardown starts also exits conservatively without deleting data", async record => {
  const f = fixture("shutdown-failure", { shutdownError: true });
  const result = await f.invoke(); assert.equal(result.ok, true); assert.equal(result.result.partial, true);
  assert.equal(result.result.error, "owned fixture shutdown failure");
  assert.equal(f.state.shutdownStarted, true); assert.equal(f.state.servicesStopped, false); assert.equal(f.state.removeCalls, 0);
  assert.deepEqual(fs.readFileSync(f.marker), f.markerBytes); assert.equal(f.errors.length, 1);
  f.flushQuit(); assert.equal(f.state.quitCalls, 1); assert.equal(f.state.servicesStopped, false);
  record.fixture = f.root; record.result = result;
});
component("normal uninstall removes only the owned fixture after shutdown and exits", async record => {
  const f = fixture("success");
  const result = await f.invoke(); assert.deepEqual(result.result, { removed: f.userData, restartRequired: false });
  assert.equal(result.ok, true); assert.equal(f.state.servicesStopped, true); assert.equal(f.state.removeCalls, 1);
  assert.equal(fs.existsSync(f.userData), false); assert.equal(fs.existsSync(evidence), true);
  assert.deepEqual(f.errors, []); f.flushQuit(); assert.equal(f.state.quitCalls, 1); record.fixture = f.root;
});
component("confirmation failure before teardown returns an error without leaving the app quitting", async record => {
  const f = fixture("confirmation-failure", { dialogError: true });
  const result = await f.invoke(); assert.equal(result.ok, false); assert.equal(result.error, "owned fixture confirmation failure");
  assert.equal(f.state.shutdownStarted, false); assert.equal(f.state.removeCalls, 0);
  await stillUsable(f); record.fixture = f.root;
});
component("untrusted IPC cannot show confirmation or invoke data removal", async record => {
  const f = fixture("untrusted");
  const result = await f.invoke("app:uninstall", undefined, {});
  assert.equal(result.ok, false); assert.equal(result.error, "IPC_SOURCE_REJECTED");
  assert.equal(f.confirmations.length, 0); assert.equal(f.state.shutdownStarted, false); assert.equal(f.state.removeCalls, 0);
  await stillUsable(f); record.fixture = f.root;
});

test.after(() => {
  const after = hashes();
  const stable = JSON.stringify(before) === JSON.stringify(after);
  const passed = stable && records.length === 7 && records.every(record => record.passed);
  fs.writeFileSync(path.join(evidence, "receipt.json"), JSON.stringify({
    test: "uninstall-failure-component-acceptance", passed,
    scope: "Full main module registerIpc/wrap + actual paths helper in a Node VM; fixture app/managers/dialog/fs; no Electron/native uninstall or real file lock",
    source_stable: stable, source: after, records, evidence,
    failure_fixture_data_preserved: true, successful_fixture_data: "owned userData intentionally removed by actual paths helper",
    native_setup_uninstall: "NOT_RUN", actual_windows_file_lock: "NOT_RUN",
  }, null, 2));
  fs.writeFileSync(path.join(base, "latest.json"), JSON.stringify({ receipt: path.join(evidence, "receipt.json"),
    passed, native: false }, null, 2));
  assert.equal(stable, true, "relevant production/test files remain unchanged during acceptance");
  console.log("UNINSTALL_COMPONENT_EVIDENCE " + evidence);
});
