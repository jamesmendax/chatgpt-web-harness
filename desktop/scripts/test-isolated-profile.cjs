"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { profile, resolveAppProfile } = require("../src/app-profile");
const { launchSpec } = require("./start-isolated.cjs");
const root = path.resolve(__dirname, "../..");

function loadWithElectron(relativeFile, env = {}) {
  const filename = path.resolve(__dirname, relativeFile);
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  const electron = {
    app: { isPackaged: true, getPath: () => path.join(root, ".codex", "no-user-config") },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const context = {
    module, exports: module.exports, __filename: filename, __dirname: path.dirname(filename),
    process: { env, resourcesPath: path.join(root, ".codex", "no-resources"), pid: process.pid },
    require: (request) => request === "electron" ? electron
      : request === "./paths" ? loadWithElectron("../src/paths.js", env) : realRequire(request),
    Buffer, console,
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  return module.exports;
}

test("preview has distinct name, app ID, data allowlist and ports", () => {
  const production = resolveAppProfile({});
  assert.equal(profile.isolated, true);
  assert.notEqual(profile.displayName, production.displayName);
  assert.notEqual(profile.appId, production.appId);
  assert.equal(profile.allowLegacyMigration, false);
  for (const name of profile.userDataBasenames) assert.ok(!production.userDataBasenames.includes(name));
  for (const port of Object.values(profile.defaultPorts)) assert.ok(!Object.values(production.defaultPorts).includes(port));
  assert.equal(new Set(Object.values(profile.defaultPorts)).size, 3);
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.defaultPorts) && Object.isFrozen(profile.userDataBasenames));
});

test("normal profile remains compatible and the variant flag is exact", () => {
  const production = resolveAppProfile({ harnessVariant: "false" });
  assert.equal(production.isolated, false);
  assert.equal(production.allowLegacyMigration, true);
  assert.equal(production.appId, "com.chatgpt-web-harness.desktop");
  assert.deepEqual(production.defaultPorts, { mcpPort: 3000, adminPort: 3001, tunnelPort: 8080 });
});

test("package, lockfile and builder use the same isolated identity", () => {
  const pkg = require("../package.json");
  const lock = require("../package-lock.json");
  const builder = fs.readFileSync(path.join(__dirname, "../electron-builder.yml"), "utf8");
  assert.equal(pkg.name, "chatgpt-web-harness-isolated");
  assert.equal(pkg.harnessVariant, "isolated");
  // Isolation is established by the package/app/data identity, not a prerelease suffix.
  // A stable 0.2.0 release retains the same isolation guarantees as preview builds.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.scripts.acceptance, "node scripts/acceptance-multiaccount.mjs");
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].name, pkg.name);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.ok(builder.includes("appId: " + profile.appId));
  assert.ok(builder.includes("productName: " + profile.displayName));
  assert.ok(builder.includes("shortcutName: " + profile.displayName));
});

test("empty preview config cannot auto-start or borrow stored credentials", () => {
  const config = loadWithElectron("../src/config.js");
  const cfg = config.load();
  assert.equal(cfg.setupDone, false);
  assert.equal(cfg.autoStart, false);
  assert.equal(cfg.workspacePath, "");
  assert.equal(cfg.tunnelId, "");
  assert.equal(cfg.apiKeyEnc, "");
  for (const [key, value] of Object.entries(profile.defaultPorts)) assert.equal(cfg[key], value);
});

test("preview deletion allowlist refuses both production data names", () => {
  const paths = loadWithElectron("../src/paths.js");
  const fixture = path.join(root, ".codex", "no-user-config");
  const runtime = path.join(fixture, "runtime");
  for (const name of profile.userDataBasenames) {
    assert.equal(paths.canDeleteUserData(path.join(fixture, name), runtime, { packaged: true }), true);
  }
  for (const name of resolveAppProfile({}).userDataBasenames) {
    assert.equal(paths.canDeleteUserData(path.join(fixture, name), runtime, { packaged: true }), false);
  }
  assert.equal(paths.canDeleteUserData(path.parse(root).root, runtime, { packaged: true }), false);
});

function runMigration(selectedProfile, fileSystem) {
  const text = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const start = text.indexOf("function migrateLegacyUserData() {");
  const end = text.indexOf("\nfunction wrap(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(text.slice(start, end) + "\nmigrateLegacyUserData();", {
    profile: selectedProfile, fs: fileSystem, path,
    accounts: { currentId: "default" },
    paths: { configPath: () => path.join(root, ".codex", "preview", "config.json") },
    app: { getPath: () => path.join(root, ".codex", "preview") },
    services: { note: () => {} },
  });
}

test("preview skips legacy migration before any filesystem or credential access", () => {
  let accesses = 0;
  runMigration(profile, new Proxy({}, { get() { accesses++; throw new Error("Legacy data touched"); } }));
  assert.equal(accesses, 0);
});

test("normal profile still migrates an existing legacy configuration", () => {
  let copied = false;
  runMigration(resolveAppProfile({}), {
    existsSync: (file) => file.includes("chatgpt-local-coder-desktop"),
    mkdirSync: () => {},
    copyFileSync: (from, to) => {
      assert.equal(path.basename(path.dirname(from)), "chatgpt-local-coder-desktop");
      assert.equal(path.basename(to), "config.json");
      copied = true;
    },
  });
  assert.equal(copied, true);
});

test("launcher pins absolute local runtime and data paths without changing its input", () => {
  const inherited = { CLC_RUNTIME_DIR: "D:/production", ADMIN_TOKEN: "not-a-real-token", mcp_token: "fixture", ELECTRON_RUN_AS_NODE: "1", PATH: "test-path" };
  const spec = launchSpec(root, inherited);
  const relative = path.relative(root, spec.userData);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  assert.equal(spec.env.CLC_RUNTIME_DIR, path.join(spec.userData, "runtime"));
  assert.ok(spec.args.includes("--user-data-dir=" + spec.userData));
  assert.ok(path.isAbsolute(spec.executable) && path.isAbsolute(spec.cwd));
  for (const key of Object.keys(spec.env)) assert.ok(!["admin_token", "mcp_token", "electron_run_as_node"].includes(key.toLowerCase()));
  assert.equal(spec.env.PATH, "test-path");
  assert.equal(inherited.CLC_RUNTIME_DIR, "D:/production");
  assert.equal(inherited.ADMIN_TOKEN, "not-a-real-token");
});


const { isolatedEnvironment, isolatedPaths, initializeIsolatedRuntime } = require("../src/isolated-runtime");

test("inherited dotenv and state path overrides cannot escape the isolated runtime", () => {
  const runtime = path.join(root, ".codex", "boundary-fixture", "runtime");
  const inherited = {
    DOTENV_CONFIG_PATH: "D:/production/.env", dotenv_config_override: "true", DotEnv_Config_Encoding: "utf8",
    AUDIT_LOG_PATH: "D:/production/audit.log", Checkpoint_Path: "D:/production/checkpoints",
    CodeX_Home: "D:/production/codex", MCP_SHELL_STATE_DIR: "D:/production/state",
    CLC_RUNTIME_DIR: "D:/production", ADMIN_TOKEN: "fake-admin", mcp_token: "fake-mcp",
    NODE_OPTIONS: "--require D:/production/inject.cjs", NODE_PATH: "D:/production/modules",
    EXTRA_WORKSPACE_PATHS: "D:/production", WORKSPACE_PATHS: "D:/production", ALLOWED_WORKSPACE_PATHS: "D:/production",
    PATH: "keep-path", HTTPS_PROXY: "http://127.0.0.1:18080",
  };
  const env = isolatedEnvironment(inherited, runtime);
  for (const [key, value] of Object.entries(env)) {
    assert.ok(!key.toUpperCase().startsWith("DOTENV_CONFIG_"));
    assert.ok(!String(value).includes("D:/production"), key);
  }
  assert.equal(env.CLC_RUNTIME_DIR, runtime);
  for (const key of ["AUDIT_LOG_PATH", "CHECKPOINT_PATH", "CODEX_HOME", "MCP_SHELL_STATE_DIR"]) {
    const relative = path.relative(runtime, env[key]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  assert.equal(env.PATH, "keep-path");
  assert.equal(env.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.equal(inherited.ADMIN_TOKEN, "fake-admin");
});

test("direct development and packaged entrypoints reject arbitrary CLI data directories", () => {
  const options = { appData: path.join(root, ".codex", "fake-appdata"), desktopRoot: path.join(root, "desktop") };
  for (const isPackaged of [false, true]) {
    for (const requestedUserData of ["D:/production/ChatGPT Web Harness", "D:/arbitrary/chatgpt-web-harness-isolated", "relative-path"]) {
      assert.throws(() => isolatedPaths({ ...options, isPackaged, requestedUserData }), /隔离版拒绝/);
    }
    const selected = isolatedPaths({ ...options, isPackaged });
    assert.equal(selected.userData, path.join(options.appData, "chatgpt-web-harness-isolated"));
    assert.equal(selected.runtime, path.join(selected.userData, "runtime"));
  }
});

test("only the development launcher may select its repo-local dedicated data root", () => {
  const options = { appData: path.join(root, ".codex", "fake-appdata"), desktopRoot: path.join(root, "desktop") };
  const requestedUserData = launchSpec(root, {}).userData;
  assert.equal(isolatedPaths({ ...options, requestedUserData, isPackaged: false }).userData, requestedUserData);
  assert.throws(() => isolatedPaths({ ...options, requestedUserData, isPackaged: true }), /隔离版拒绝/);
});

function boundaryFixture({ packaged = false, requested = "", linked = false } = {}) {
  const events = [];
  const roots = { appData: path.join(root, ".codex", "fake-appdata") };
  const app = {
    isPackaged: packaged,
    commandLine: { getSwitchValue: () => requested, appendSwitch: (name) => events.push("switch:" + name) },
    getPath: (name) => roots[name],
    setPath: (name, value) => { events.push("setPath:" + name); roots[name] = value; },
    setAppUserModelId: () => events.push("app-id"),
    exit: (code) => events.push("exit:" + code),
    requestSingleInstanceLock: () => { events.push("lock"); throw new Error("TEST_STOP_AT_LOCK"); },
  };
  const io = {
    lstatSync: (file) => {
      events.push("stat");
      assert.ok(!String(file).includes("production"), "must not inspect original data");
      return { isSymbolicLink: () => linked };
    },
    mkdirSync: (file) => {
      events.push("mkdir");
      assert.equal(file, path.join(roots.appData, "chatgpt-web-harness-isolated"));
    },
  };
  const env = { CLC_RUNTIME_DIR: "D:/production", ADMIN_TOKEN: "fake-production-token", DOTENV_CONFIG_PATH: "D:/production/.env" };
  return { events, roots, app, io, env };
}

test("early initialization replaces ambient runtime and fixes sessionData as well as userData", () => {
  const f = boundaryFixture();
  const selected = initializeIsolatedRuntime(f.app, { env: f.env, fs: f.io });
  assert.equal(f.roots.userData, selected.userData);
  assert.equal(f.roots.sessionData, selected.userData);
  assert.equal(f.env.CLC_RUNTIME_DIR, selected.runtime);
  assert.equal(f.env.ADMIN_TOKEN, undefined);
  assert.equal(f.env.DOTENV_CONFIG_PATH, undefined);
  assert.equal(selected.notificationAppDataDir, undefined, "normal launches keep Windows notification registration");
});

test("real main routes fixture notification writes away from the native Windows Known Folder", () => {
  const mainFile = path.join(__dirname, "../src/main.js");
  const source = fs.readFileSync(mainFile, "utf8");
  const boundary = source.indexOf("const taskbarAppId =");
  assert.ok(boundary > 0);
  const nativeAppData = path.join(root, ".validation", "host-known-folder-must-not-write");
  const fixtureAppData = path.join(root, ".validation", "private-notification-fixture");
  const run = initialized => {
    const app = { getPath: name => { assert.equal(name, "appData"); return nativeAppData; } };
    const loader = name => name === "electron" ? { app }
      : name === "./app-profile" ? { profile: { isolated: true } }
      : name === "./isolated-runtime" ? { initializeIsolatedRuntime: () => initialized }
      : name.startsWith("./") ? {} : require(name);
    const wrapper = vm.runInNewContext("(function(require,__dirname){" + source.slice(0, boundary) + "\nreturn notificationAppDataDir;})", {
      process: { argv: ["electron", mainFile] }, console,
    });
    return wrapper(loader, path.dirname(mainFile));
  };
  assert.equal(run({ userData: "ordinary-profile" }), nativeAppData);
  assert.equal(run({ userData: "fixture-profile", notificationAppDataDir: fixtureAppData }), fixtureAppData);
});

test("invalid CLI root and junction ancestors fail before any data creation", () => {
  const rejected = boundaryFixture({ requested: "D:/production/ChatGPT Web Harness" });
  assert.throws(() => initializeIsolatedRuntime(rejected.app, { env: rejected.env, fs: rejected.io }), /隔离版拒绝/);
  assert.deepEqual(rejected.events, []);
  const linked = boundaryFixture({ linked: true });
  assert.throws(() => initializeIsolatedRuntime(linked.app, { env: linked.env, fs: linked.io }), /junction/);
  assert.ok(!linked.events.includes("mkdir"));
});

test("packaged clean-host fixture is marker-gated and scrubs its bootstrap secret", () => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-clean-host-"));
  const scope = path.join(runRoot, "portable");
  const fixtureAppData = path.join(scope, "appdata");
  const requested = path.join(fixtureAppData, "chatgpt-web-harness-isolated");
  const token = "ab".repeat(32);
  fs.mkdirSync(path.join(scope, "temp"), { recursive: true });
  fs.mkdirSync(path.join(scope, "localappdata"), { recursive: true });
  const markerPath = path.join(scope, ".clean-host-fixture.json");
  const writeMarker = (changes = {}) => fs.writeFileSync(markerPath, JSON.stringify({
    schema_version: 1, scope, token, created_at: Date.now(), ...changes,
  }));
  const makeFixture = (changes = {}) => {
    const paths = { appData: path.join(root, ".codex", "real-appdata") };
    const events = [];
    const app = {
      isPackaged: true,
      commandLine: { getSwitchValue: () => changes.requested || requested },
      getPath: (name) => paths[name],
      setPath: (name, value) => { events.push(name); paths[name] = value; },
      setAppUserModelId: () => events.push("app-id"),
    };
    const env = {
      APPDATA: fixtureAppData, LOCALAPPDATA: path.join(scope, "localappdata"),
      TEMP: path.join(scope, "temp"), TMP: path.join(scope, "temp"),
      HARNESS_CLEAN_HOST_SCOPE: scope, HARNESS_CLEAN_HOST_TOKEN: token,
      ...changes.env,
    };
    return { app, env, paths, events };
  };
  try {
    writeMarker();
    for (const changes of [
      { env: { HARNESS_CLEAN_HOST_TOKEN: "cd".repeat(32) } },
      { env: { HARNESS_CLEAN_HOST_SCOPE: "D:/unrelated/portable" } },
      { env: { APPDATA: path.join(scope, "other") } },
      { requested: "D:/production/chatgpt-web-harness-isolated" },
    ]) {
      const f = makeFixture(changes);
      assert.throws(() => initializeIsolatedRuntime(f.app, { env: f.env }), /clean-host/);
      assert.deepEqual(f.events, [], "invalid fixture must fail before changing Electron paths");
    }
    writeMarker({ created_at: Date.now() - 21 * 60_000 });
    const expired = makeFixture();
    assert.throws(() => initializeIsolatedRuntime(expired.app, { env: expired.env }), /clean-host/);
    assert.deepEqual(expired.events, []);

    fs.unlinkSync(markerPath);
    const missing = makeFixture();
    assert.throws(() => initializeIsolatedRuntime(missing.app, { env: missing.env }), /clean-host/);
    assert.deepEqual(missing.events, []);

    writeMarker();
    const linked = makeFixture();
    const linkedFs = {
      lstatSync: (file) => file === scope ? { isSymbolicLink: () => true } : fs.lstatSync(file),
      readFileSync: fs.readFileSync,
      mkdirSync: fs.mkdirSync,
    };
    assert.throws(() => initializeIsolatedRuntime(linked.app, { env: linked.env, fs: linkedFs }), /junction/);
    assert.deepEqual(linked.events, []);

    const accepted = makeFixture();
    const selected = initializeIsolatedRuntime(accepted.app, { env: accepted.env });
    assert.equal(selected.userData, requested);
    assert.equal(selected.notificationAppDataDir, fixtureAppData, "only a verified fixture receives private notification routing");
    assert.equal(accepted.paths.appData, fixtureAppData);
    assert.equal(accepted.paths.userData, requested);
    assert.equal(accepted.paths.sessionData, requested);
    assert.deepEqual(accepted.events.slice(0, 3), ["appData", "userData", "sessionData"]);
    assert.equal(accepted.env.HARNESS_CLEAN_HOST_SCOPE, undefined);
    assert.equal(accepted.env.HARNESS_CLEAN_HOST_TOKEN, undefined);

    const normal = makeFixture({ env: { HARNESS_CLEAN_HOST_SCOPE: "", HARNESS_CLEAN_HOST_TOKEN: "" } });
    assert.throws(() => initializeIsolatedRuntime(normal.app, { env: normal.env }), /隔离版拒绝非专用数据目录/);
    assert.deepEqual(normal.events, []);
  } finally {
    assert.equal(path.resolve(path.dirname(runRoot)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.match(path.basename(runRoot), /^harness-clean-host-[a-z0-9_-]{6,}$/i);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
});

function runMainUntilLock(f) {
  const mainFile = path.join(__dirname, "../src/main.js");
  const realRequire = createRequire(mainFile);
  const mainSource = fs.readFileSync(mainFile, "utf8");
  const module = { exports: {} };
  const loader = (name) => {
    if (name === "electron") return { app: f.app, dialog: { showErrorBox: () => f.events.push("blocked-dialog") } };
    if (name === "./isolated-runtime") return {
      initializeIsolatedRuntime: (app) => initializeIsolatedRuntime(app, { env: f.env, fs: f.io }),
    };
    if (name === "./accounts") return { AccountManager: class {
      constructor() { f.events.push("services"); this.services = {}; this.feeds = {}; }
    } };
    if (name === "./conversation-index") return { ConversationIndex: class {} };
    if (name === "./services") return { Services: class { constructor() { f.events.push("services"); } } };
    if (name === "./feeds") return { ActivityFeeds: class {} };
    if (name === "./ipc-source") return realRequire(name);
    // The main process constructs its real, pure memory guards before the
    // single-instance lock. The isolation boundary fixture must supply that
    // module rather than hiding it behind the catch-all empty stub.
    if (name === "./renderer-memory-guard") return realRequire(name);
    if (name.startsWith("./") && name !== "./app-profile" && name !== "./taskbar-identity" && name !== "./idle-watch") return {};
    return realRequire(name);
  };
  const wrapper = vm.runInNewContext("(function(require,module,exports,__filename,__dirname){" + mainSource + "\n})", { console, process: { env: f.env, argv: ["electron", mainFile] } });
  wrapper(loader, module, module.exports, mainFile, path.dirname(mainFile));
}

test("real main entry initializes isolation before Services and single-instance lock", () => {
  const f = boundaryFixture();
  assert.throws(() => runMainUntilLock(f), /TEST_STOP_AT_LOCK/);
  assert.ok(f.events.indexOf("setPath:userData") < f.events.indexOf("services"));
  assert.ok(f.events.indexOf("setPath:sessionData") < f.events.indexOf("lock"));
  assert.ok(f.events.indexOf("app-id") < f.events.indexOf("lock"));
  // The renderer V8 heap backstop must be set after isolation, before ready.
  assert.ok(f.events.indexOf("setPath:userData") < f.events.indexOf("switch:js-flags"));
  assert.ok(f.events.indexOf("switch:js-flags") >= 0 && f.events.indexOf("switch:js-flags") < f.events.indexOf("lock"));
});

test("both real main entry modes reject original-data CLI before services or locks", () => {
  for (const packaged of [false, true]) {
    const f = boundaryFixture({ packaged, requested: "D:/production/ChatGPT Web Harness" });
    runMainUntilLock(f);
    assert.deepEqual(f.events, ["blocked-dialog", "exit:1"]);
  }
});

test("runtimeDir ignores CLC_RUNTIME_DIR even when internal modules are loaded directly", () => {
  const paths = loadWithElectron("../src/paths.js", { CLC_RUNTIME_DIR: "D:/production" });
  assert.equal(paths.runtimeDir(), path.join(root, ".codex", "no-user-config", "runtime"));
});

test("development deletion also rejects production AppData even with a matching runtime override", () => {
  const paths = loadWithElectron("../src/paths.js");
  for (const name of ["ChatGPT Web Harness", "chatgpt-web-harness-desktop", "chatgpt-local-coder-desktop"]) {
    const target = path.join(root, ".codex", "fake-appdata", name);
    const runtime = path.join(target, "runtime");
    assert.equal(paths.canDeleteUserData(target, runtime, { packaged: false, override: runtime }), false);
  }
});

test("isolated config ignores ambient ADMIN_TOKEN rather than borrowing production auth", () => {
  const config = loadWithElectron("../src/config.js", { ADMIN_TOKEN: "fake-production-token" });
  assert.equal(config.getAdminToken({}), "");
  assert.throws(() => config.ensureAdminToken({}), /隔离版需要可用的系统安全存储/);
});

test("every isolated build command explicitly disables publication", () => {
  const pkg = require("../package.json");
  for (const name of ["dist", "dist:portable", "dist:zip"]) assert.match(pkg.scripts[name], /--publish=never/);
  assert.match(pkg.scripts["start:build"], /start-isolated\.cjs/);
  assert.match(fs.readFileSync(path.join(__dirname, "../electron-builder.yml"), "utf8"), /^publish:\s*null\s*$/m);
});
