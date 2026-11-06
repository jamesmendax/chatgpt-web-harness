"use strict";
// 无界面冒烟测试：electron scripts/smoke.js
// 在临时 userData 与测试端口上验证：配置加密存储、MCP 子进程启动/健康/停止、状态聚合、日志缓冲。
// This regression never reads legacy credentials or probes a live service.
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHash } = require("crypto");
const { pathToFileURL } = require("url");
const { privatePorts } = require("./lib/test-isolation.cjs");
if (process.env.SMOKE_TUNNEL_DOCTOR === "1") throw new Error("Credential-backed tunnel doctor is separate acceptance; it cannot run inside desktop smoke.");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clc-smoke-"));
app.setPath("userData", tmp);
// 运行目录也指向临时目录，避免测试写入仓库 profiles/。
process.env.CLC_RUNTIME_DIR = path.join(tmp, "runtime");

const results = [];
let ownedServices;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const paths = require("../src/paths");
  const configStore = require("../src/config");
  const { profile: appProfile } = require("../src/app-profile");
  const { Services } = require("../src/services");
  const status = require("../src/status");

  check("userData 隔离", app.getPath("userData") === tmp, tmp);
  const isolatedDeleteRoot = path.join(tmp, "delete-fixture", appProfile.userDataBasenames[0]);
  const isolatedRuntime = path.join(isolatedDeleteRoot, "runtime");
  fs.mkdirSync(isolatedRuntime, { recursive: true });
  check("卸载删除路径仅允许隔离运行目录", paths.canDeleteUserData(isolatedDeleteRoot, isolatedRuntime, { packaged: false, override: isolatedRuntime }) === true);
  const packagedAllowed = path.join(tmp, appProfile.userDataBasenames[0]);
  const packagedProductName = path.join(tmp, appProfile.displayName);
  const packagedArbitrary = path.join(tmp, "other");
  let packagedError = "";
  try {
    await paths.uninstallUserData({ userData: packagedArbitrary, runtime: isolatedRuntime, packaged: true });
  } catch (error) {
    packagedError = String(error?.message || error);
  }
  check(
    "打包版 userData 仅接受应用目录白名单",
    paths.canDeleteUserData(packagedAllowed, isolatedRuntime, { packaged: true }) === true &&
      paths.canDeleteUserData(packagedProductName, isolatedRuntime, { packaged: true }) === true &&
      paths.canDeleteUserData(packagedArbitrary, isolatedRuntime, { packaged: true }) === false &&
      /白名单/.test(packagedError),
    packagedError
  );
  check("卸载删除拒绝目录根与越界", paths.canDeleteUserData(path.parse(tmp).root, isolatedRuntime, { packaged: true }) === false && paths.canDeleteUserData(packagedArbitrary, isolatedRuntime, { packaged: false, override: isolatedRuntime }) === false);
  const deleteOutside = path.join(tmp, "delete-outside");
  fs.mkdirSync(deleteOutside, { recursive: true });
  const deleteLink = path.join(isolatedDeleteRoot, "linked-outside");
  fs.symlinkSync(deleteOutside, deleteLink, "junction");
  check("卸载删除拒绝 reparse 点", paths.canDeleteUserData(deleteLink, isolatedRuntime, { packaged: false, override: isolatedRuntime }) === false);
  fs.unlinkSync(deleteLink);
  fs.writeFileSync(path.join(isolatedDeleteRoot, "delete-marker.txt"), "isolated\n", "utf8");
  const uninstallOrder = [];
  const removedUserData = await paths.uninstallUserData({
    userData: isolatedDeleteRoot,
    runtime: isolatedRuntime,
    packaged: false,
    override: isolatedRuntime,
    stopExternal: async () => uninstallOrder.push("stopExternal"),
    shutdown: async () => uninstallOrder.push("shutdown"),
    stopFeeds: () => uninstallOrder.push("stopFeeds"),
  });
  check(
    "便携版隔离卸载实际停止并删除 userData",
    removedUserData === path.resolve(isolatedDeleteRoot) &&
      uninstallOrder.join(",") === "stopExternal,shutdown,stopFeeds" &&
      !fs.existsSync(isolatedDeleteRoot),
    `${removedUserData}; order=${uninstallOrder.join(",")}`
  );
  paths.ensureRuntimeDir();

  // 1. 配置与密钥加密
  const cfg = configStore.load();
  check("第三方机器无开发机工作区默认", configStore.DEFAULTS.workspacePath === "");
  cfg.tunnelId = "tunnel_" + "a".repeat(32);
  cfg.apiKeyEnc = configStore.encryptKey("sk-smoke-not-a-real-key");
  cfg.workspacePath = path.join(tmp, "ws");
  [cfg.mcpPort, cfg.adminPort, cfg.tunnelPort] = await privatePorts(3);
  cfg.setupDone = true;
  fs.mkdirSync(cfg.workspacePath, { recursive: true });
  configStore.save(cfg);
  const reloaded = configStore.load();
  check("safeStorage 加解密往返", configStore.decryptKey(reloaded) === "sk-smoke-not-a-real-key");
  check("config.json 不含明文密钥", !fs.readFileSync(paths.configPath(), "utf8").includes("sk-smoke"));
  check("publicView 不泄露密文", !("apiKeyEnc" in configStore.publicView(reloaded)) && configStore.publicView(reloaded).hasApiKey === true);
  check("publicView 不泄露 Admin token 字段", !("adminTokenEnc" in configStore.publicView(reloaded)) && !("adminToken" in configStore.publicView(reloaded)));

  // 2. 隧道 profile 生成
  const harness = require("../src/harness");
  const previousAdminToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "smoke-admin-token";
  // Isolated builds ignore ambient Admin tokens; explicitly encrypt this fake fixture.
  reloaded.adminTokenEnc = configStore.encryptKey("smoke-admin-token");
  configStore.save(reloaded);
  const profile = harness.writeTunnelProfile(reloaded);
  const yaml = fs.readFileSync(profile, "utf8");
  check("launcher.yaml 生成", yaml.includes(`tunnel_id: ${cfg.tunnelId}`) && yaml.includes(`127.0.0.1:${cfg.tunnelPort}`) && yaml.includes(`http://127.0.0.1:${cfg.mcpPort}/mcp`) && yaml.includes("env:OPENAI_TUNNEL_API_KEY"), profile);
  const mcpSpec = harness.mcpSpawnSpec(reloaded);
  check(
    "MCP 环境边界与显式运行目录",
    !("OPENAI_TUNNEL_API_KEY" in mcpSpec.env) &&
      !("CONTROL_PLANE_API_KEY" in mcpSpec.env) &&
      mcpSpec.env.ADMIN_TOKEN === "smoke-admin-token" &&
      mcpSpec.env.CHATGPT_PLUGINS_CONFIG === path.join(paths.runtimeDir(), "profiles", "plugins.json") &&
      mcpSpec.env.MCP_UPSTREAM_CONFIG === path.join(paths.runtimeDir(), "profiles", "mcp-upstream.json") &&
      mcpSpec.env.MCP_SHELL_STATE_DIR === path.join(paths.runtimeDir(), ".mcp-state") &&
      mcpSpec.env.ELECTRON_RUN_AS_NODE === "1" && mcpSpec.env.PORT === String(cfg.mcpPort)
  );
  const previousMcpToken = process.env.MCP_TOKEN;
  const previousMcpApiKey = process.env.MCP_API_KEY;
  process.env.MCP_TOKEN = "smoke-mcp-token";
  process.env.MCP_API_KEY = "smoke-mcp-api-key";
  const tunnelSpec = await harness.tunnelSpawnSpec(reloaded, "smoke-tunnel-api-key", "doctor");
  check(
    "Tunnel 子进程不继承 Admin/MCP secrets",
    !("ADMIN_TOKEN" in tunnelSpec.env) && !("MCP_TOKEN" in tunnelSpec.env) && !("MCP_API_KEY" in tunnelSpec.env) &&
      tunnelSpec.env.OPENAI_TUNNEL_API_KEY === "smoke-tunnel-api-key" && tunnelSpec.env.CONTROL_PLANE_API_KEY === "smoke-tunnel-api-key",
    "只保留 Tunnel 自身认证变量"
  );
  if (previousMcpToken === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = previousMcpToken;
  if (previousMcpApiKey === undefined) delete process.env.MCP_API_KEY;
  else process.env.MCP_API_KEY = previousMcpApiKey;
  const { ActivityFeeds } = require("../src/feeds");
  const feedProbe = new ActivityFeeds();
  feedProbe.configure({ adminPort: cfg.adminPort, tunnelPort: cfg.tunnelPort, adminToken: "smoke-admin-token" });
  check("桌面活动源配置 Admin token", feedProbe.adminToken === "smoke-admin-token", "活动请求使用内存 header，不写入 URL");

  // Skills / plugin registry
  const skills = require("../src/skills");
  const skillDir = path.join(tmp, "registered-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: smoke-skill\ndescription: Smoke skill description\n---\n# Smoke skill\n", "utf8");
  const savedSkills = await skills.save({
    workspacePath: cfg.workspacePath,
    registrations: [{ name: "smoke-skill", path: path.join(skillDir, "SKILL.md"), enabled: true }],
    computerUseEnabled: false,
    browserUseEnabled: false,
  });
  const skillCatalog = await skills.catalog(cfg.workspacePath);
  check(
    "Skill 注册表保存与读取",
    savedSkills.ok === true &&
      skillCatalog.registered.length === 1 &&
      skillCatalog.registered[0].name === "smoke-skill" &&
      skillCatalog.registered[0].enabled === true &&
      skillCatalog.registered[0].description === "Smoke skill description",
    skillCatalog.registered[0] ? `name=${skillCatalog.registered[0].name} path=${skillCatalog.registered[0].path}` : "no registered skill"
  );
  check("Computer Use 默认关闭", skillCatalog.computerUse.enabled === false);
  check("Browser Use 默认关闭且内置运行时就绪", skillCatalog.browserUse.enabled === false && skillCatalog.browserUse.available === true && skillCatalog.browserUse.runtimeReady === true);

  const installedSource = path.join(tmp, "installed-source");
  fs.mkdirSync(installedSource, { recursive: true });
  fs.writeFileSync(path.join(installedSource, "SKILL.md"), "---\nname: smoke-installed-alias\n---\n# installed\n", "utf8");
  const installedResult = await skills.install({ source: installedSource, id: "smoke-installed" });
  const installedCatalog = await skills.catalog(cfg.workspacePath);
  check("统一 installer 安装并发现", installedResult.id === "smoke-installed" && installedCatalog.installed.some((skill) => skill.id === "smoke-installed"));
  await skills.setEnabled({ id: "smoke-installed", source: "installed", enabled: false });
  const disabledCatalog = await skills.catalog(cfg.workspacePath);
  check("统一 installer 即时禁用", disabledCatalog.installed.some((skill) => skill.id === "smoke-installed" && skill.enabled === false));

  // 3. MCP 启动 / 健康 / 状态 / 停止
  // The Tunnel fixture is a child process serving loopback only. It supplies
  // readiness and a synthetic on-demand 401 diagnostic without cloud traffic.
  const tunnelFixture = `
    const http = require('http');
    const startedAt = new Date().toISOString();
    const server = http.createServer((req, res) => {
      if (req.url === '/readyz') return res.end('ready');
      if (req.url === '/api/status') return res.end(JSON.stringify({client_instance_id:'smoke-fixture', control_plane_tunnel_id:process.argv[2], started_at:startedAt}));
      if (req.url === '/api/logs') return res.end(JSON.stringify({events:[]}));
      if (req.url === '/metrics') return res.end('');
      if (req.url === '/emit-401') {
        console.log('component=controlplane msg="poll failed; backing off" status_code=401 error_code=invalid_api_key');
        return res.end('emitted');
      }
      res.writeHead(404).end();
    });
    server.listen(Number(process.argv[3]), '127.0.0.1', () => {
      console.log('mock tunnel loopback ready');
    });
  `;
  const tunnelFixturePath = path.join(tmp, "mock-tunnel.cjs");
  fs.writeFileSync(tunnelFixturePath, tunnelFixture);
  harness.tunnelSpawnSpec = async () => ({
    command: process.execPath, args: [tunnelFixturePath, cfg.tunnelId, String(cfg.tunnelPort)], cwd: tmp,
    env: { SystemRoot: process.env.SystemRoot, ELECTRON_RUN_AS_NODE: "1" },
    proxyInfo: { mode: "direct", source: "loopback-fixture" },
  });
  const services = ownedServices = new Services();
  const logs = [];
  services.on("log", (e) => logs.push(e));
  const before = await status.probeMcp(cfg.mcpPort);
  if (before) throw new Error("Private smoke port was acquired by another process; refusing to interact with its MCP");
  check("独立测试端口空闲", !before, String(cfg.mcpPort));
  await services.startAll().catch((err) => {
    console.log("startAll 本地模拟认证失败:", err.message.slice(0, 120));
  });
  if (services.tunnel.isAlive()) await fetch(`http://127.0.0.1:${cfg.tunnelPort}/emit-401`);
  const health = await status.probeMcp(cfg.mcpPort);
  if (health && health.runtime?.pid !== services.mcp.pid) throw new Error("MCP health does not belong to this smoke child");
  // Compare the actual registered catalog with the slim profile from the same
  // runtime payload. The release verification separately checks payload provenance.
  const { SLIM_CHATGPT_TOOLS } = await import(pathToFileURL(path.join(path.dirname(paths.distEntry()), "lib", "tool-profile.js")).href);
  const expectedTools = [...SLIM_CHATGPT_TOOLS].sort();
  const expectedHash = createHash("sha256").update(expectedTools.join("\n")).digest("hex");
  let listedTools = [];
  if (health) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "desktop-smoke", version: "1.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${cfg.mcpPort}/mcp`)));
      listedTools = (await client.listTools()).tools.map(tool => tool.name).sort();
    } finally { await client.close(); }
  }
  check("MCP 健康", Boolean(health) && expectedTools.includes("route_skills") && health.runtime?.tool_count === expectedTools.length && health.runtime?.tool_profile === "slim" && health.runtime?.tool_manifest_hash === expectedHash && JSON.stringify(listedTools) === JSON.stringify(expectedTools), health ? `pid=${health.runtime.pid} build=${health.runtime.build_id} tools=${health.runtime.tool_count}/${expectedTools.length} listed=${listedTools.length} catalog=${health.runtime.catalog_source} hash=${health.runtime.tool_manifest_hash}` : "no health");
  let snap = await services.collectStatus();
  // Readiness precedes the asynchronous invalid-credential response. Wait for
  // that diagnostic instead of assuming it arrived in the first snapshot.
  const authDeadline = Date.now() + 15_000;
  while (!snap.tunnel.authError && Date.now() < authDeadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    snap = await services.collectStatus();
  }
  check("状态聚合: MCP managed", snap.mcp.managed === true && snap.mcp.healthy === true && snap.mcp.pid === services.mcp.pid);
  // The mock emits a 401 after local readiness; this does not test cloud auth.
  check(
    "本地模拟 401 被识别为认证失败（不谎报在线）",
    Boolean(snap.tunnel.authError),
    `ready=${snap.tunnel.ready} authError=${snap.tunnel.authError ? "yes" : "no"} metaError=${snap.tunnel.metaError ? "yes" : "no"}`
  );
  check("MCP 日志已捕获", logs.some((e) => e.name === "mcp" && /Codex MCP Server|Runtime build/.test(e.line)));
  check("Tunnel 日志已捕获", logs.some((e) => e.name === "tunnel"));
  await services.stopAll();
  const after = await status.probeMcp(cfg.mcpPort);
  check("MCP 已停止且端口释放", !after && (await status.listeningPids(cfg.mcpPort)).length === 0);
  check("Tunnel 已停止且端口释放", (await status.listeningPids(cfg.tunnelPort)).length === 0);
  check("日志文件落盘", fs.existsSync(path.join(paths.logsDir(), "mcp.log")));

  fs.writeFileSync(path.join(paths.runtimeDir(), "profiles", "mcp-upstream.json"), JSON.stringify({ version: 1, servers: [{ id: "smoke-server", type: "stdio", command: "node" }] }, null, 2));
  const beforeResetSkill = fs.readFileSync(path.join(paths.runtimeDir(), "profiles", "local-skills", "smoke-installed", "SKILL.md"), "utf8");
  const reset = paths.resetRuntimeProfiles();
  const resetPlugins = JSON.parse(fs.readFileSync(reset.plugins, "utf8"));
  const resetUpstream = JSON.parse(fs.readFileSync(reset.upstream, "utf8"));
  const resetBackupExists = fs.readdirSync(path.dirname(reset.plugins)).some((name) => /^plugins\.json\.reset-.*\.bak$/.test(name));
  check("profiles reset 只重置配置", resetPlugins.schema_version === 2 && resetPlugins.skills.length === 0 && resetUpstream.servers.length === 0 && fs.readFileSync(path.join(paths.runtimeDir(), "profiles", "local-skills", "smoke-installed", "SKILL.md"), "utf8") === beforeResetSkill && resetBackupExists);

  if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
  else process.env.ADMIN_TOKEN = previousAdminToken;

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (err) {
    console.log(`（临时目录未能删除，可忽略: ${err.code}）`);
  }
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(() => main().catch(async (err) => {
  console.error("SMOKE ERROR", err);
  if (ownedServices) await ownedServices.shutdown().catch(error => console.error("SMOKE owned-child cleanup failed", error));
  app.exit(2);
}));
