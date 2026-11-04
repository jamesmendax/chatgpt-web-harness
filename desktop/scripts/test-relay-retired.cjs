"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const desktopRoot = path.resolve(__dirname, "..");
const root = path.resolve(desktopRoot, "..");
const harnessSource = fs.readFileSync(path.join(desktopRoot, "src", "harness.js"), "utf8");
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "wh-relay-retired-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "account");
  const runtimeDir = path.join(dataDir, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const flagged = {
    ...process.env,
    HARNESS_RELAY_ENABLED: "true",
    "hARnEsS_ReLaY_aUtOmAtIoN_eNaBlEd": "true",
    "hArNeSs_CoMpAnIoN_ToKeN": "synthetic-never-forward",
    HARNESS_COMPANION_INSTANCE_ID: "legacy-test-only",
    "hARnEsS_CoMpAnIoN_cApAbIlItY_fIlE": "synthetic-never-forward",
  };
  const conf = {
    relayEnabled: true,
    relayAutomationEnabled: true,
    relayAutoRecoveryEnabled: true,
    mcpPort: 54321,
    adminPort: 54322,
    tunnelPort: 54323,
    workspacePath: path.join(temp, "workspace"),
    tunnelId: "tunnel_" + "0".repeat(32),
    toolProfile: "slim",
    adminTokenEnc: "",
  };
  let companionRequired = false;
  let computerUsed = 0;
  const stubPaths = {
    runtimeDir: () => runtimeDir,
    configPath: () => path.join(dataDir, "config.json"),
    distEntry: () => path.join(temp, "unused-harness-entry.js"),
    tunnelProfilePath: () => path.join(runtimeDir, "tunnel-profile.yaml"),
    tunnelClientPath: () => path.join(temp, "unused-tunnel.exe"),
    computerUseCapabilityPath: () => path.join(dataDir, "computer-use", "capability.json"),
  };
  const mod = { exports: {} };
  const filename = path.join(desktopRoot, "src", "harness.js");
  const real = createRequire(filename);
  const localProcess = {
    env: flagged, pid: process.pid, platform: "win32", execPath: process.execPath,
  };
  vm.runInNewContext(harnessSource, {
    module: mod, exports: mod.exports, Buffer, console,
    process: localProcess,
    require(id) {
      if (id === "./paths") return stubPaths;
      if (id === "./config") return { ensureAdminToken: () => "synthetic-admin-test-token", save() { throw Error("No real config save allowed"); } };
      if (id === "./app-profile") return { profile: { isolated: true } };
      if (id === "./account-context") return { current: () => null };
      if (id === "./isolated-runtime") return { isolatedEnvironment: env => ({ ...env }) };
      if (id === "./tunnel-proxy") return {
        resolveTunnelProxy: async () => ({ mode: "direct" }), applyTunnelProxy: () => {},
      };
      if (id === "./computer-use-runtime") return { prepare: () => {
        computerUsed++; return { enabled: false };
      } };
      if (id.includes("companion")) { companionRequired = true; throw Error("Companion must not be loaded"); }
      return real(id);
    },
  }, { filename });
  return { module: mod.exports, temp, conf, computerUsed: () => computerUsed,
    companionRequired: () => companionRequired };
}

test("old Relay config and mixed-case environment cannot revive Companion in new MCP or tunnel", async t => {
  const { module: harness, conf, computerUsed, companionRequired, temp } = fixture(t);
  const mcp = harness.mcpSpawnSpec(conf);
  assert.equal(mcp.env.CHATGPT_TOOL_PROFILE, "slim");
  assert.equal(mcp.env.PORT, "54321");
  assert.equal(mcp.env.ADMIN_PORT, "54322");
  assert.equal(mcp.env.ADMIN_TOKEN, "synthetic-admin-test-token");
  assert.equal(computerUsed(), 1, "normal Computer Use preparation must remain");
  const tunnel = await harness.tunnelSpawnSpec(conf, "synthetic-tunnel-test-key");
  assert.equal(tunnel.env.OPENAI_TUNNEL_API_KEY, "synthetic-tunnel-test-key");
  assert.equal(tunnel.env.CONTROL_PLANE_TUNNEL_ID, conf.tunnelId);
  for (const child of [mcp, tunnel]) {
    const keys = Object.keys(child.env).map(k => k.toUpperCase());
    assert.ok(!keys.some(k => k.startsWith("HARNESS_RELAY_") || k.startsWith("HARNESS_COMPANION_")),
      "retired flags must never propagate, even under Windows mixed-case names");
  }
  assert.equal(companionRequired(), false);
  assert.equal(fs.existsSync(path.join(temp, "account", "browser-companion")), false);
});
test("new desktop source and release configuration omit Companion bootstrap while keeping browser provider", () => {
  const builder = fs.readFileSync(path.join(desktopRoot, "electron-builder.yml"), "utf8");
  const main = fs.readFileSync(path.join(desktopRoot, "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(desktopRoot, "src", "preload.js"), "utf8");
  const paths = fs.readFileSync(path.join(desktopRoot, "src", "paths.js"), "utf8");
  const aura = fs.readFileSync(path.join(desktopRoot, "renderer", "v3", "aura", "app.js"), "utf8");
  const server = fs.readFileSync(path.join(root, "src", "admin", "server.ts"), "utf8");
  const launcher = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");
  assert.ok(!builder.includes('to: "browser-companion"'));
  assert.ok(builder.includes('"!src/companion-*.js"'));
  assert.ok(!main.includes('ipcMain.handle("relay:'));
  assert.ok(!preload.includes('invoke("relay:'));
  assert.ok(!aura.includes('chapter("relay"'));
  assert.ok(!paths.includes("materializeBrowserCompanion"));
  assert.ok(!server.includes('app.use("/companion/v'));
  assert.ok(!launcher.includes("startRelayAutomation"));
  assert.ok(paths.includes("browserUseRuntimeReady"), "Browser Use must remain");
  assert.ok(paths.includes("computerUseCapabilityPath"), "Computer Use must remain");
});
