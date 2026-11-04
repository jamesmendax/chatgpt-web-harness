import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-skill-http-functional");
await fs.rm(tmpRoot, { recursive: true, force: true });

const workspace = path.join(tmpRoot, "workspace");
const projectSkillDir = path.join(workspace, ".claude", "skills", "http-project-skill");
const externalSkillDir = path.join(tmpRoot, "open-source-http-skill");
const externalReferenceDir = path.join(externalSkillDir, "references");
const registryPath = path.join(tmpRoot, "plugins.json");
const codexHome = path.join(tmpRoot, "codex-home");
const mcpPort = 4700 + Math.floor(Math.random() * 200);
const adminPort = mcpPort + 1;

await fs.mkdir(projectSkillDir, { recursive: true });
await fs.mkdir(externalReferenceDir, { recursive: true });
await fs.mkdir(codexHome, { recursive: true });
await fs.writeFile(
  path.join(projectSkillDir, "SKILL.md"),
  "---\nname: http-project-skill\ndescription: HTTP project skill fixture\n---\n\nUse the HTTP project workflow.\n"
);
await fs.writeFile(
  path.join(externalSkillDir, "SKILL.md"),
  "---\nname: open-source-http-skill\ndescription: HTTP registered local skill fixture\n---\n\nUse the registered HTTP workflow.\n"
);
await fs.writeFile(path.join(externalReferenceDir, "usage.md"), "HTTP reference contract\n");
await fs.writeFile(
  registryPath,
  JSON.stringify(
    {
      computer_use: { enabled: false },
      skills: [{ name: "open-source-http-skill", path: path.join(externalSkillDir, "SKILL.md"), enabled: true }],
    },
    null,
    2
  )
);

const previous = {
  config: process.env.CHATGPT_PLUGINS_CONFIG,
  codexHome: process.env.CODEX_HOME,
};
process.env.CHATGPT_PLUGINS_CONFIG = registryPath;
process.env.CODEX_HOME = codexHome;

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    WORKSPACE_PATH: workspace,
    CHATGPT_TOOL_PROFILE: "slim",
    GOAL_WATCHDOG_ENABLED: "false",
    MCP_SESSION_TTL_MS: "60000",
    MCP_SESSION_CLEANUP_MS: "1000",
    MCP_SESSION_MAX_COUNT: "8",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (data) => (serverLog += data));
server.stderr?.on("data", (data) => (serverLog += data));

async function waitForHealth() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${mcpPort}/health`);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`temporary MCP server did not become healthy\n${serverLog}`);
}

async function initializeSession(label) {
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: label, version: "1" } },
    }),
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (!response.ok || !sessionId) throw new Error(`initialize failed for ${label}: HTTP ${response.status}`);
  return sessionId;
}

async function rpc(sessionId, id, method, params = {}) {
  const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(JSON.stringify(parsed.error));
  return parsed.result;
}

async function callTool(sessionId, id, name, args) {
  return rpc(sessionId, id, "tools/call", { name, arguments: args });
}

function toolData(result) {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.data;
}

try {
  const health = await waitForHealth();
  assert.equal(health.status, "ok");
  assert.equal(health.runtime?.tool_count, 34);
  assert.equal(health.runtime?.stale_build, false);

  const sessionA = await initializeSession("http-functional-a");
  const sessionB = await initializeSession("http-functional-b");
  const sessionC = await initializeSession("http-functional-c");

  const createdA = toolData(
    await callTool(sessionA, 10, "goal", {
      action: "create",
      objective: "HTTP functional goal A",
      success_criteria: [{ name: "A remains isolated" }],
    })
  );
  const createdB = toolData(
    await callTool(sessionB, 11, "goal", {
      action: "create",
      objective: "HTTP functional goal B",
      success_criteria: [{ name: "B remains isolated" }],
    })
  );
  assert.notEqual(createdA.goal.id, createdB.goal.id);
  assert.equal(createdA.goal.owner_session, sessionA);
  assert.equal(createdB.goal.owner_session, sessionB);

  const statusA = toolData(await callTool(sessionA, 12, "goal", { action: "status" }));
  const statusB = toolData(await callTool(sessionB, 13, "goal", { action: "status" }));
  assert.equal(statusA.goal.objective, "HTTP functional goal A");
  assert.equal(statusB.goal.objective, "HTTP functional goal B");
  assert.notEqual(statusA.goal.id, statusB.goal.id);

  const statusC = toolData(await callTool(sessionC, 14, "goal", { action: "status" }));
  assert.equal(statusC.goal, null);
  assert.equal(statusC.takeover_confirmation_required, true);
  assert.equal(statusC.takeover_candidate.goal_id, createdB.goal.id);

  const firstBind = await callTool(sessionC, 15, "goal", {
    action: "bind",
    expected_revision: createdB.goal.revision,
  });
  assert.equal(firstBind.structuredContent?.ok, false);
  assert.equal(firstBind.structuredContent?.data?.error, "GOAL_TAKEOVER_CONFIRMATION_REQUIRED");
  const token = firstBind.structuredContent?.data?.takeover_token;
  assert.equal(typeof token, "string");

  const rebound = toolData(
    await callTool(sessionC, 16, "goal", {
      action: "bind",
      expected_revision: createdB.goal.revision,
      takeover_token: token,
    })
  );
  assert.equal(rebound.goal.owner_session, sessionC);
  assert.equal(rebound.goal.id, createdB.goal.id);
  assert.equal(rebound.goal.objective, "HTTP functional goal B");

  const statusAAfterBind = toolData(await callTool(sessionA, 17, "goal", { action: "status" }));
  assert.equal(statusAAfterBind.goal.id, createdA.goal.id);
  assert.equal(statusAAfterBind.goal.objective, "HTTP functional goal A");

  const listedSkills = toolData(await callTool(sessionA, 18, "list_skills", {}));
  const projectSkill = listedSkills.skills.find((skill) => skill.name === "http-project-skill");
  const externalSkill = listedSkills.skills.find((skill) => skill.name === "open-source-http-skill");
  assert.equal(projectSkill?.source, "project");
  assert.equal(externalSkill?.source, "external");

  const loadedSkill = toolData(
    await callTool(sessionA, 19, "load_skill", { name: "open-source-http-skill" })
  );
  assert.match(loadedSkill.content, /Use the registered HTTP workflow\./);
  assert.equal(loadedSkill.reference_paths?.length, 1);
  assert.equal(path.basename(loadedSkill.reference_paths[0]), "usage.md");

  console.log(
    `goal-skill-http-functional: real HTTP MCP build=${health.runtime.build_id}, two isolated goals, token-gated takeover, and skill list/load OK`
  );
} finally {
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (previous.config === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
  else process.env.CHATGPT_PLUGINS_CONFIG = previous.config;
  if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous.codexHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
