"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { createRequire } = require("node:module");
const filename = path.resolve(__dirname, "../src/config.js");
const realRequire = createRequire(filename);
function fixture(read) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, Buffer, process,
    require: name => name === "electron" ? { safeStorage: {} }
      : name === "fs" ? { readFileSync: read }
      : name === "./paths" ? { configPath: () => "fixture-config.json" }
      : realRequire(name),
  }, { filename });
  return module.exports;
}

function bootstrapFixture() {
  const filename = path.resolve(__dirname, "../src/main.js");
  const source = fs.readFileSync(filename, "utf8");
  const start = source.indexOf("async function bootstrap() {");
  const end = source.indexOf("\n/**", start);
  assert.ok(start >= 0 && end > start, "bootstrap function boundary should remain discoverable");
  const events = [];
  let loads = 0;
  let writes = 0;
  let tokenAttempts = 0;
  const context = {
    app: {
      setAppUserModelId: (id) => events.push(["app-id", id]),
      quit: () => events.push("quit"),
    },
    profile: { appId: "test-app" },
    taskbarAppId: "test-app",
    migrateLegacyUserData: () => events.push("migrate"),
    configStore: {
      load: () => {
        loads += 1;
        events.push("load");
        const error = new Error("fixture config unreadable");
        error.code = "CONFIG_READ_FAILED";
        throw error;
      },
      ensureAdminToken: () => { tokenAttempts += 1; },
      save: () => { writes += 1; },
    },
    dialog: {
      showErrorBox: (title, body) => events.push(["dialog", title, body]),
    },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.__bootstrap = bootstrap;`, context, { filename });
  return { bootstrap: context.__bootstrap, events, loads: () => loads, writes: () => writes, tokenAttempts: () => tokenAttempts };
}

test("only absent config receives first-run defaults", () => {
  const config = fixture(() => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); });
  assert.equal(config.load().setupDone, false);
});
test("permission and malformed config failures do not reset user settings", () => {
  for (const read of [
    () => { throw Object.assign(new Error("private details"), { code: "EPERM" }); },
    () => { throw Object.assign(new Error("private details"), { code: "EACCES" }); },
    () => "{broken", () => "null", () => "[]",
  ]) {
    assert.throws(() => fixture(read).load(), error => error.code === "CONFIG_READ_FAILED" && !error.message.includes("private details"));
  }
});
test("valid saved settings retain startup behavior", () => {
  const loaded = fixture(() => JSON.stringify({ setupDone: true, autoStart: true, mcpPort: 49100 })).load();
  assert.equal(loaded.setupDone, true);
  assert.equal(loaded.autoStart, true);
  assert.equal(loaded.mcpPort, 49100);
});

test("legacy Relay flags cannot reactivate retired Companion or leak into current settings", () => {
  const input = { relayEnabled: true, relayAutomationEnabled: true,
    relayAutoRecoveryEnabled: true, setupDone: true, mcpPort: 49100, notificationVolume: 70 };
  const source = JSON.stringify(input);
  const mod = fixture(() => source);
  const loaded = mod.load();
  for (const key of ["relayEnabled", "relayAutomationEnabled", "relayAutoRecoveryEnabled"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(loaded, key), false);
    assert.equal(Object.prototype.hasOwnProperty.call(mod.publicView(loaded), key), false);
  }
  assert.equal(loaded.setupDone, true);
  assert.equal(loaded.notificationVolume, 70);
  assert.equal(loaded.mcpPort, 49100);
  assert.equal(source, JSON.stringify(input), "loading old account must not overwrite its source bytes");
});

test("bootstrap reports unreadable config and exits before token persistence", async () => {
  const fixture = bootstrapFixture();
  await fixture.bootstrap();
  assert.equal(fixture.loads(), 1);
  assert.equal(fixture.writes(), 0);
  assert.equal(fixture.tokenAttempts(), 0);
  assert.deepEqual(fixture.events.map((event) => Array.isArray(event) ? event[0] : event), ["app-id", "migrate", "load", "dialog", "quit"]);
  const dialog = fixture.events.find((event) => Array.isArray(event) && event[0] === "dialog");
  assert.equal(dialog[1], "ChatGPT Web Harness 配置读取失败");
  assert.match(dialog[2], /fixture config unreadable/);
});
