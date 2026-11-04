import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-provider-catalog-"));
const config = path.join(tmp, "plugins.json");
const workspace = path.join(tmp, "workspace");
await fs.mkdir(workspace, { recursive: true });
const previousConfig = process.env.CHATGPT_PLUGINS_CONFIG;
const previousProfile = process.env.CHATGPT_TOOL_PROFILE;
process.env.CHATGPT_PLUGINS_CONFIG = config;
process.env.CHATGPT_TOOL_PROFILE = "full";

async function catalog(computer, browser) {
  await fs.writeFile(config, `${JSON.stringify({
    schema_version: 2,
    computer_use: { enabled: computer },
    browser_use: { enabled: browser },
    skills: [],
  })}\n`, "utf8");
  const { createMcpServer } = await import("../dist/server-factory.js");
  const server = createMcpServer(workspace, 30_000, [workspace], false);
  const client = new Client({ name: "provider-catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    const { getRuntimeManifest } = await import("../dist/lib/runtime-manifest.js");
    const manifest = getRuntimeManifest();
    assert.equal(manifest.catalog_source, "registered");
    assert.deepEqual(new Set(manifest.tool_names), names, "runtime catalog must match actual tools/list");
    return names;
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

try {
  const disabled = await catalog(false, false);
  assert.equal(disabled.has("computer_use"), false);
  assert.equal(disabled.has("browser_use_exec"), false);
  assert.equal(disabled.has("browser_use_screenshot"), false);

  const computer = await catalog(true, false);
  assert.equal(computer.has("computer_use"), true);
  assert.equal(computer.has("browser_use_exec"), false);

  const browser = await catalog(false, true);
  assert.equal(browser.has("computer_use"), false);
  assert.equal(browser.has("browser_use_exec"), true);
  assert.equal(browser.has("browser_use_screenshot"), true);

  const both = await catalog(true, true);
  assert.equal(both.has("computer_use"), true);
  assert.equal(both.has("browser_use_exec"), true);
  assert.equal(both.has("browser_use_screenshot"), true);
  console.log("provider-tool-registration: full MCP catalog follows account-scoped Computer/Browser switches without disabled-tool leakage PASS");
} finally {
  if (previousConfig === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG; else process.env.CHATGPT_PLUGINS_CONFIG = previousConfig;
  if (previousProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE; else process.env.CHATGPT_TOOL_PROFILE = previousProfile;
  await fs.rm(tmp, { recursive: true, force: true });
}
