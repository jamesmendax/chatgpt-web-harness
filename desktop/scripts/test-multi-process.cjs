"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const entry = path.join(repo, "dist", "index.js");
const node = process.env.SystemRoot ? path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe") : process.execPath;
if (!fs.existsSync(entry)) throw new Error(`Missing built MCP entry: ${entry}`);
if (!fs.existsSync(node)) throw new Error(`Missing Node executable: ${node}`);

const artifacts = path.join(repo, ".codex", "isolation", "multi-process");
fs.mkdirSync(artifacts, { recursive: true });
const runRoot = fs.mkdtempSync(path.join(artifacts, "run-"));
const children = [];

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
async function uniquePorts(count) {
  const values = [];
  while (values.length < count) {
    const value = await reservePort();
    if (!values.includes(value)) values.push(value);
  }
  return values;
}
function requestHealth(port, timeout = 700) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.once("timeout", () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.once("error", () => resolve({ ok: false, status: 0 }));
  });
}
async function waitHealth(port, child, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`${label} exited early (${child.exitCode})`);
    const health = await requestHealth(port);
    if (health.ok) return health;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`${label} did not become healthy on ${port}`);
}
function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode != null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      if (child.exitCode == null) child.kill();
    }, 3000);
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    child.kill();
  });
}
function profileEnv(id, mcpPort, adminPort) {
  const root = path.join(runRoot, id);
  const workspace = path.join(root, "workspace");
  const runtime = path.join(root, "runtime");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(runtime, "profiles"), { recursive: true });
  fs.writeFileSync(path.join(runtime, "profiles", "plugins.json"), "{\n  \"plugins\": []\n}\n");
  fs.writeFileSync(path.join(runtime, "profiles", "mcp-upstream.json"), "{\n  \"servers\": []\n}\n");
  const env = { ...process.env };
  for (const key of [
    "ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE", "DOTENV_CONFIG_PATH", "DOTENV_CONFIG_OVERRIDE",
    "OPENAI_TUNNEL_API_KEY", "CONTROL_PLANE_API_KEY", "CONTROL_PLANE_TUNNEL_ID", "RUNTIME_API_KEY",
    "MCP_API_KEY", "AUDIT_LOG_PATH", "CHECKPOINT_PATH", "CODEX_HOME", "MCP_SHELL_STATE_DIR", "CLC_RUNTIME_DIR",
    "CHATGPT_PLUGINS_CONFIG", "MCP_UPSTREAM_CONFIG", "PORT", "ADMIN_PORT", "WORKSPACE_PATH", "MCP_TOKEN", "ADMIN_TOKEN",
  ]) delete env[key];
  Object.assign(env, {
    PORT: String(mcpPort), HOST: "127.0.0.1", ADMIN_PORT: String(adminPort), WORKSPACE_PATH: workspace,
    CHATGPT_TOOL_PROFILE: "slim", FULL_DISK_ACCESS: "false", HARNESS_ACCOUNT_ID: id,
    CLC_RUNTIME_DIR: runtime, CODEX_HOME: path.join(runtime, ".codex"), MCP_SHELL_STATE_DIR: path.join(runtime, ".mcp-state"),
    CHATGPT_PLUGINS_CONFIG: path.join(runtime, "profiles", "plugins.json"), MCP_UPSTREAM_CONFIG: path.join(runtime, "profiles", "mcp-upstream.json"),
    ADMIN_TOKEN: `fixture-admin-${id}`, MCP_TOKEN: `fixture-mcp-${id}`,
  });
  return { env, root, workspace, runtime };
}
function launch(id, mcpPort, adminPort) {
  const profile = profileEnv(id, mcpPort, adminPort);
  const child = spawn(node, [entry], { cwd: profile.runtime, env: profile.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-20000); });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-20000); });
  return { id, mcpPort, adminPort, child, profile, logs: () => ({ stdout, stderr }) };
}

(async () => {
  const [mcpA, adminA, mcpB, adminB] = await uniquePorts(4);
  const a = launch("account-a", mcpA, adminA);
  const b = launch("account-b", mcpB, adminB);
  try {
    await Promise.all([waitHealth(mcpA, a.child, "account-a"), waitHealth(mcpB, b.child, "account-b")]);
    assert.notEqual(a.child.pid, b.child.pid);
    assert.notEqual(a.profile.runtime, b.profile.runtime);
    assert.notEqual(a.profile.workspace, b.profile.workspace);
    assert.equal((await requestHealth(mcpA)).ok, true);
    assert.equal((await requestHealth(mcpB)).ok, true);
    const pidA = a.child.pid; const pidB = b.child.pid;
    await stopChild(a.child);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await requestHealth(mcpA, 250)).ok, false, "stopped account must release its MCP port");
    assert.equal((await requestHealth(mcpB)).ok, true, "stopping one account must not stop the other MCP");
    assert.equal(b.child.exitCode, null, "second MCP process must remain alive");
    await stopChild(b.child);
    const result = {
      passed: true,
      processes: [
        { account: "account-a", pid: pidA, mcpPort: mcpA, adminPort: adminA, runtime: a.profile.runtime, workspace: a.profile.workspace },
        { account: "account-b", pid: pidB, mcpPort: mcpB, adminPort: adminB, runtime: b.profile.runtime, workspace: b.profile.workspace },
      ],
      selectiveStopVerified: true,
      tunnelCloudAuthorizationTested: false,
      note: "Local MCP process/runtime separation only; no real second-account tunnel credential was supplied or exercised.",
    };
    fs.writeFileSync(path.join(artifacts, "multi-process-result.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(`PASS two real MCP processes isolated: ${pidA}@${mcpA}/${adminA} and ${pidB}@${mcpB}/${adminB}`);
    console.log("PASS stopping account-a preserved account-b health");
    console.log("PASS no real tunnel/cloud credential was used");
  } finally {
    await Promise.all(children.map((child) => stopChild(child).catch(() => undefined)));
  }
})().catch((error) => {
  console.error(error.stack || error);
  for (const item of children) {
    if (item.exitCode == null) item.kill();
  }
  process.exit(1);
});
