import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tool-test-tmp", "skills-admin-api");
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(path.join(tmp, "workspace"), { recursive: true });
const source = path.join(tmp, "source");
await fs.mkdir(source, { recursive: true });
await fs.writeFile(path.join(source, "SKILL.md"), "---\nname: admin-alias\ndescription: admin API fixture\n---\n# admin\n", "utf8");
const mcpPort = 4700 + Math.floor(Math.random() * 300);
const adminPort = mcpPort + 1;
const token = "test-admin-token";
const env = {
  ...process.env,
  PORT: String(mcpPort),
  ADMIN_PORT: String(adminPort),
  ADMIN_TOKEN: token,
  CHATGPT_TOOL_PROFILE: "slim",
  WORKSPACE_PATH: path.join(tmp, "workspace"),
  CHATGPT_PLUGINS_CONFIG: path.join(tmp, "plugins.json"),
  MCP_UPSTREAM_CONFIG: path.join(tmp, "upstream.json"),
  MCP_SHELL_STATE_DIR: path.join(tmp, "shell-state"),
  CODEX_HOME: path.join(tmp, "codex-home"),
};
const child = spawn(process.execPath, ["dist/index.js"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (chunk) => { log += chunk; });
child.stderr.on("data", (chunk) => { log += chunk; });

async function waitFor(url, init = {}, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.status !== 503) return response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("timeout " + url + "\n" + log.slice(-3000));
}

async function json(url, init = {}) {
  const response = await waitFor(url, init);
  return { response, body: await response.json() };
}

try {
  const unauthenticated = await json("http://127.0.0.1:" + adminPort + "/api/skills");
  assert.equal(unauthenticated.response.status, 401);
  const wrongToken = await json("http://127.0.0.1:" + adminPort + "/api/skills", { headers: { "x-admin-token": "wrong-length-token" } });
  assert.equal(wrongToken.response.status, 401, "wrong-length Admin token must not be accepted");
  const headers = { "x-admin-token": token };
  const health = await json("http://127.0.0.1:" + adminPort + "/health", { headers });
  assert.equal(health.body.name, "codex-mcp-admin");
  const before = await json("http://127.0.0.1:" + adminPort + "/api/skills", { headers });
  assert.equal(before.body.ok, true);
  const relativeSource = await json("http://127.0.0.1:" + adminPort + "/api/skills/install", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ source: "relative/skill", id: "rejected" }),
  });
  assert.equal(relativeSource.response.status, 400, "install source must be absolute");
  const oversized = await fetch("http://127.0.0.1:" + adminPort + "/api/skills/install", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ source, id: "oversized", padding: "x".repeat(6 * 1024 * 1024) }),
  });
  assert.equal(oversized.status, 413, "Admin JSON body limit must reject oversized requests");
  const install = await json("http://127.0.0.1:" + adminPort + "/api/skills/install", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ source, id: "admin-skill" }),
  });
  assert.equal(install.response.status, 201);
  assert.equal(install.body.result.id, "admin-skill");
  assert.ok(install.body.skills.some((skill) => skill.id === "admin-skill"));
  const disabled = await json("http://127.0.0.1:" + adminPort + "/api/skills/admin-skill/enabled", {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.body.result.enabled, false);
  const listed = await json("http://127.0.0.1:" + adminPort + "/api/skills", { headers });
  assert.equal(listed.body.skills.find((skill) => skill.id === "admin-skill")?.enabled, false);
  const removed = await json("http://127.0.0.1:" + adminPort + "/api/skills/admin-skill", { method: "DELETE", headers });
  assert.equal(removed.body.result.removed, true);
  const after = await json("http://127.0.0.1:" + adminPort + "/api/skills", { headers });
  assert.equal(after.body.skills.some((skill) => skill.id === "admin-skill"), false);
  console.log("skills-admin-api: token guard, install/list, enable/disable, delete and isolated paths OK");
} finally {
  child.kill();
  await new Promise((resolve) => child.once("close", resolve));
  await fs.rm(tmp, { recursive: true, force: true });
}
