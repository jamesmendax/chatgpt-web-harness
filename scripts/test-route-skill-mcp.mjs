import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerContextTools } from "../dist/tools/context.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-route-mcp-"));
const before = { registry: process.env.CHATGPT_PLUGINS_CONFIG, home: process.env.CODEX_HOME };
let client;
let server;
try {
  const work = path.join(root, "work");
  const profiles = path.join(root, "profile");
  const skillId = "ui-ux-pro-max";
  const skillRoot = path.join(profiles, "local-skills", skillId);
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), [
    "---",
    "name: ui-ux-pro-max",
    "description: UI/UX design intelligence for interfaces, app screens, layout and desktop settings.",
    "---",
    "Do not restyle Aura. Inspect existing controls before changing the settings UI.",
  ].join("\n"));
  const configPath = path.join(profiles, "plugins.json");
  const registry = {
    schema_version: 2,
    computer_use: { enabled: false },
    browser_use: { enabled: false },
    skills: [{ id: skillId, source: "installed", enabled: true }],
  };
  fs.writeFileSync(configPath, JSON.stringify(registry));
  process.env.CHATGPT_PLUGINS_CONFIG = configPath;
  process.env.CODEX_HOME = path.join(root, ".codex");
  server = new McpServer({ name: "wh-skill-route-fixture", version: "0.0.1" });
  registerContextTools(server, work);
  client = new Client({ name: "wh-skill-client-fixture", version: "0.0.1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const list = await client.listTools();
  assert.ok(list.tools.some(item => item.name === "route_skills"), "route_skills missing from genuine MCP tool list");
  const args = { task: "请统一原有 Aura 设置 UI 的视觉对齐与间距", phase: "design" };
  const reply = await client.callTool({ name: "route_skills", arguments: args });
  assert.equal(reply.isError, undefined);
  assert.equal(reply.structuredContent?.data?.primary?.id, skillId);
  assert.equal(reply.structuredContent?.data?.loaded_primary?.content_complete, true);
  assert.ok(reply.structuredContent.data.loaded_primary.content.includes("Do not restyle Aura"));
  const denied = await client.callTool({ name: "route_skills", arguments: {
    ...args, task: "不使用任何 Skill，只解释这段代码" } });
  assert.equal(denied.structuredContent?.data?.status, "suppressed");
  registry.skills[0].enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(registry));
  const disabled = await client.callTool({ name: "route_skills", arguments: args });
  assert.notEqual(disabled.structuredContent?.data?.primary?.id, skillId);
  console.log("real MCP in-memory transport: tools/list route_skills, tools/call body, no-Skill, disabled Skill PASS");
} finally {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (before.registry === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
  else process.env.CHATGPT_PLUGINS_CONFIG = before.registry;
  if (before.home === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = before.home;
  fs.rmSync(root, { recursive: true, force: true });
}
