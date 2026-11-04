import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = process.cwd();
const hostHome = process.env.USERPROFILE || process.env.HOME;
const localAppData = process.env.LOCALAPPDATA;
assert.ok(hostHome && localAppData, "Windows host profile locations are required");
const hostCodexHome = path.join(hostHome, ".codex");
const hostCuaRuntime = path.join(localAppData, "OpenAI", "Codex", "runtimes", "cua_node");
const skillRoot = path.join(hostCodexHome, "plugins", "cache", "openai-bundled", "computer-use");
await fs.access(skillRoot);
await fs.access(hostCuaRuntime);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-computer-use-session-"));
const workspace = path.join(tmp, "workspace");
const isolatedCodexHome = path.join(tmp, "isolated-account", ".codex");
const registryPath = path.join(tmp, "isolated-account", "profiles", "plugins.json");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(isolatedCodexHome, { recursive: true });
await fs.mkdir(path.dirname(registryPath), { recursive: true });

const keys = ["CHATGPT_PLUGINS_CONFIG", "CODEX_HOME", "HARNESS_COMPUTER_USE_CODEX_HOME", "HARNESS_COMPUTER_USE_RUNTIME_ROOT", "CHATGPT_TOOL_PROFILE"];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
Object.assign(process.env, {
  CHATGPT_PLUGINS_CONFIG: registryPath,
  CODEX_HOME: isolatedCodexHome,
  HARNESS_COMPUTER_USE_CODEX_HOME: hostCodexHome,
  HARNESS_COMPUTER_USE_RUNTIME_ROOT: hostCuaRuntime,
  CHATGPT_TOOL_PROFILE: "full",
});

async function withFreshServer(enabled, verify) {
  await fs.writeFile(registryPath, JSON.stringify({ schema_version: 2, computer_use: { enabled }, skills: [] }, null, 2) + "\n", "utf8");
  const { createMcpServer } = await import("../dist/server-factory.js");
  const server = createMcpServer(workspace, 30_000, [workspace], true);
  const client = new Client({ name: `computer-use-${enabled ? "enabled" : "disabled"}-fixture`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  serverTransport.sessionId = `computer-use-${enabled ? "enabled" : "disabled"}-fresh-session`;
  try { await verify(client); } finally { await client.close().catch(() => {}); await server.close().catch(() => {}); }
}

try {
  const isolatedBundle = path.join(isolatedCodexHome, "plugins", "cache", "openai-bundled", "computer-use");
  assert.equal(await fs.stat(isolatedBundle).then(() => true).catch(() => false), false, "fixture CODEX_HOME must not contain Computer Use");

  await withFreshServer(true, async (client) => {
    const listed = await client.callTool({ name: "list_skills", arguments: {} });
    const skills = listed.structuredContent?.data?.skills ?? [];
    const computer = skills.find((skill) => skill.id === "computer-use" || skill.name === "computer-use");
    assert.equal(computer?.source, "computer-use", "fresh enabled MCP did not discover host Computer Use");
    assert.ok(path.resolve(computer.path).toLowerCase().startsWith(path.resolve(hostCodexHome).toLowerCase()));

    const loaded = await client.callTool({ name: "load_skill", arguments: { name: "computer-use" } });
    assert.equal(loaded.structuredContent?.ok, true, "fresh enabled MCP could not load Computer Use Skill");
    assert.equal(loaded.structuredContent?.data?.skill?.source, "computer-use");

    const status = await client.callTool({ name: "node_repl", arguments: { action: "status" } });
    assert.equal(status.structuredContent?.ok, true);
    assert.equal(status.structuredContent?.data?.computer_use_available, true,
      `fresh enabled MCP could not load host CUA runtime: ${status.structuredContent?.data?.computer_use_error || "unknown"}`);
  });

  await withFreshServer(false, async (client) => {
    const listed = await client.callTool({ name: "list_skills", arguments: {} });
    const skills = listed.structuredContent?.data?.skills ?? [];
    assert.equal(skills.some((skill) => skill.id === "computer-use" || skill.name === "computer-use"), false,
      "fresh disabled MCP must exclude Computer Use from active Skill list");
    const status = await client.callTool({ name: "node_repl", arguments: { action: "status" } });
    assert.equal(status.structuredContent?.data?.computer_use_available, false);
    assert.match(status.structuredContent?.data?.computer_use_error || "", /disabled/i);
  });

  console.log("COMPUTER_USE_NEW_SESSION_RUNTIME_PASS");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
