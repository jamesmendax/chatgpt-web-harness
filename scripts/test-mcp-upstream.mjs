import fs from "fs/promises";
import { existsSync } from "node:fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  importCursorMcpConfig,
  loadUpstreamConfig,
  parseClaudeCodeConfig,
  parseMcpServersFile,
  parseOpenCodeConfig,
  saveUpstreamConfig,
} from "../dist/lib/mcp-upstream-config.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { refreshProxiedTools, jsonSchemaToZodShape } from "../dist/lib/mcp-tool-proxy.js";
import { registerMcpBridgeTools } from "../dist/tools/mcp-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp", "mcp-upstream");
// The packaged Harness executes JS in Electron-as-Node mode. Its
// process.execPath points at the Harness EXE, not a stable stdio Node binary;
// the MCP SDK intentionally sanitizes child env and drops ELECTRON_RUN_AS_NODE.
// Use an actual Node binary for both mock transports, as the desktop packager does.
const testNode = [process.env.CHATGPT_WEB_HARNESS_NODE_EXE,
  process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : undefined,
  process.execPath].find((file) => file && /^node(?:\.exe)?$/i.test(path.basename(file)) && existsSync(file));
if (!testNode) throw new Error("A real Node.js executable is required for MCP upstream integration fixtures.");

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function spawnMockHttp(port) {
  return spawn(testNode, [path.join(root, "scripts/mock-http-mcp.mjs")], {
    env: { ...process.env, MOCK_HTTP_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const configPath = path.join(tmpDir, "upstream.json");
process.env.MCP_UPSTREAM_CONFIG = configPath;

await run("overlapping reload and update serialize config mutation and generation", async () => {
  const serializedPath = path.join(tmpDir, "serialized-upstream.json");
  const configFor = (id) => ({
    version: 1,
    servers: [
      {
        id,
        name: id,
        enabled: true,
        transport: "http",
        url: `http://127.0.0.1/${id}`,
        expose: "all",
      },
    ],
  });
  await saveUpstreamConfig(configFor("initial"), serializedPath);
  const manager = new McpUpstreamManager(serializedPath);
  await manager.init();
  await saveUpstreamConfig(configFor("reloaded"), serializedPath);

  const refreshStarted = deferred();
  const releaseRefresh = deferred();
  const refreshSnapshots = [];
  manager.shutdown = async () => {};
  manager.refreshAllProxies = async () => {
    refreshSnapshots.push(manager.getConfig().servers[0]?.id);
    if (refreshSnapshots.length === 1) {
      refreshStarted.resolve();
      await releaseRefresh.promise;
    }
  };

  const reload = manager.reloadConfig();
  await refreshStarted.promise;
  const update = manager.updateConfig(configFor("updated"));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const whileBlocked = await loadUpstreamConfig(serializedPath);
  if (whileBlocked.servers[0]?.id !== "reloaded") {
    releaseRefresh.resolve();
    await Promise.allSettled([reload, update]);
    throw new Error(`update escaped config lock: ${JSON.stringify(whileBlocked)}`);
  }

  releaseRefresh.resolve();
  await Promise.all([reload, update]);
  const persisted = await loadUpstreamConfig(serializedPath);
  if (manager.getConfig().servers[0]?.id !== "updated" || persisted.servers[0]?.id !== "updated") {
    throw new Error("serialized update did not become the final runtime and persisted config");
  }
  if (refreshSnapshots.join(",") !== "reloaded,updated") {
    throw new Error(`unexpected refresh order: ${refreshSnapshots.join(",")}`);
  }
  if (manager.getConfigGeneration() !== 3) {
    throw new Error(`expected config generation 3, got ${manager.getConfigGeneration()}`);
  }
});

await run("jsonSchemaToZodShape respects required fields", async () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
    required: ["a"],
  });
  const aParsed = shape.a.safeParse(undefined);
  const bParsed = shape.b.safeParse(undefined);
  if (aParsed.success) throw new Error("a should be required");
  if (!bParsed.success) throw new Error("b should be optional");
});

await run("jsonSchemaToZodShape preserves union types", async () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { value: { type: ["string", "number", "null"] } },
    required: ["value"],
  });
  if (!shape.value.safeParse("text").success) throw new Error("string branch rejected");
  if (!shape.value.safeParse(42).success) throw new Error("number branch rejected");
  if (!shape.value.safeParse(null).success) throw new Error("null branch rejected");
  if (shape.value.safeParse(true).success) throw new Error("undeclared boolean branch accepted");
});

await run("proxy refresh applies policy on discovery failure, refreshes metadata, and hands over owners", async () => {
  const registered = new Map();
  const fakeServer = {
    registerTool(name, config, callback) {
      if (registered.has(name)) throw new Error(`duplicate registration: ${name}`);
      const handle = {
        config,
        callback,
        remove() {
          if (registered.get(name) === handle) registered.delete(name);
        },
      };
      registered.set(name, handle);
      return handle;
    },
  };

  let configs = [
    { id: "a", name: "A", enabled: true, expose: "all", tool_prefix: "shared" },
    { id: "b", name: "B", enabled: true, expose: "all", tool_prefix: "shared" },
  ];
  const discoveries = new Map([
    ["a", [{ name: "run", description: "version one", inputSchema: { type: "object", properties: {} } }]],
    ["b", [{ name: "run", description: "from B", inputSchema: { type: "object", properties: {} } }]],
  ]);
  const calls = [];
  const fakeManager = {
    listServerConfigs: () => configs,
    async listTools(id) {
      const value = discoveries.get(id);
      if (value instanceof Error) throw value;
      return value ?? [];
    },
    async callTool(id, tool, args) {
      calls.push({ id, tool, args });
      return { content: [{ type: "text", text: id }] };
    },
  };

  await refreshProxiedTools(fakeServer, fakeManager);
  const first = registered.get("shared__run");
  if (!first?.config.description.includes("version one")) throw new Error("initial owner metadata missing");

  discoveries.set("a", [{ name: "run", description: "version two", inputSchema: { type: "object", properties: {} } }]);
  await refreshProxiedTools(fakeServer, fakeManager);
  const refreshed = registered.get("shared__run");
  if (refreshed === first || !refreshed?.config.description.includes("version two")) {
    throw new Error("same-owner metadata remained stale");
  }

  configs = [{ ...configs[0], disabled_tools: ["run"] }, configs[1]];
  discoveries.set("a", new Error("discovery unavailable"));
  await refreshProxiedTools(fakeServer, fakeManager);
  const handedOver = registered.get("shared__run");
  if (!handedOver?.config.description.includes("from B")) {
    throw new Error("disabled failed owner blocked the available replacement owner");
  }
  await handedOver.callback({ payload: true });
  if (calls.at(-1)?.id !== "b") throw new Error(`expected owner B call, got ${JSON.stringify(calls.at(-1))}`);

  configs = [configs[0]];
  await refreshProxiedTools(fakeServer, fakeManager);
  if (registered.has("shared__run")) throw new Error("disabled tool survived failed discovery");
});

await run("proxy refresh forwards signals and rethrows abort reasons", async () => {
  const controller = new AbortController();
  const abortReason = new DOMException("cancel discovery", "AbortError");
  let receivedSignal;
  const fakeServer = {
    registerTool() {
      throw new Error("aborted refresh must not register tools");
    },
  };
  const fakeManager = {
    listServerConfigs: () => [
      { id: "abort", name: "Abort", enabled: true, expose: "all", tool_prefix: "abort" },
    ],
    async listTools(_id, options) {
      receivedSignal = options?.signal;
      controller.abort(abortReason);
      throw abortReason;
    },
  };

  let caught;
  try {
    await refreshProxiedTools(fakeServer, fakeManager, { signal: controller.signal });
  } catch (error) {
    caught = error;
  }
  if (receivedSignal !== controller.signal) throw new Error("refresh did not forward the request signal");
  if (caught !== abortReason) throw new Error(`abort was swallowed or replaced: ${String(caught)}`);
});

await run("mcp_tools reports the resolved runtime proxy owner", async () => {
  const registered = new Map();
  const fakeServer = {
    registerTool(name, config, callback) {
      if (registered.has(name)) throw new Error(`duplicate registration: ${name}`);
      const handle = {
        config,
        callback,
        remove() {
          if (registered.get(name) === handle) registered.delete(name);
        },
      };
      registered.set(name, handle);
      return handle;
    },
  };
  const configs = [
    { id: "a", name: "A", enabled: true, expose: "all", tool_prefix: "shared" },
    { id: "b", name: "B", enabled: true, expose: "all", tool_prefix: "shared" },
  ];
  const tools = [{ name: "run", description: "shared", inputSchema: { type: "object", properties: {} } }];
  const fakeManager = {
    listServerConfigs: () => configs,
    getServerConfig: (id) => configs.find((config) => config.id === id),
    async listTools() {
      return tools;
    },
    async callTool() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    getProxiedToolNames(config, discovered) {
      return discovered.map((tool) => `${config.tool_prefix ?? config.id}__${tool.name}`);
    },
  };

  await refreshProxiedTools(fakeServer, fakeManager);
  registerMcpBridgeTools(fakeServer, fakeManager);
  const callback = registered.get("mcp_tools")?.callback;
  if (!callback) throw new Error("mcp_tools callback was not registered");

  const ownerReport = await callback({ server_id: "a" }, {});
  const ownerData = ownerReport.structuredContent?.data;
  const ownerTool = ownerData?.tools?.[0];
  if (ownerTool?.proxy_owner !== "a" || ownerTool?.proxied_as?.[0] !== "shared__run") {
    throw new Error(`resolved owner missing from owner report: ${JSON.stringify(ownerData)}`);
  }

  const collisionReport = await callback({ server_id: "b" }, {});
  const collisionData = collisionReport.structuredContent?.data;
  const collisionTool = collisionData?.tools?.[0];
  if (collisionTool?.proxy_owner !== "a") {
    throw new Error(`collision owner was not projected: ${JSON.stringify(collisionData)}`);
  }
  if (collisionTool.proxied_as.length !== 0 || collisionData.proxied_tools.length !== 0) {
    throw new Error(`non-owner was reported as proxied: ${JSON.stringify(collisionData)}`);
  }
});

await run("shutdown invalidates pending upstream connections", async () => {
  const manager = new McpUpstreamManager(configPath);
  manager.config = {
    version: 1,
    servers: [{ id: "slow", name: "Slow", enabled: true, transport: "http", url: "http://invalid/mcp", expose: "all" }],
  };
  let release;
  let closeCount = 0;
  const started = new Promise((resolve) => { release = resolve; });
  manager.createTransport = async () => {
    await started;
    return {
      client: { listTools: async () => ({ tools: [] }) },
      transport: { close: async () => { closeCount++; } },
      pid: null,
    };
  };
  const pending = manager.connect("slow").catch((error) => error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shutdown = manager.shutdown();
  release();
  const outcome = await pending;
  await shutdown;
  if (!(outcome instanceof Error) || !outcome.message.includes("superseded")) {
    throw new Error(`pending connection was not invalidated: ${String(outcome)}`);
  }
  if (manager.connections.size !== 0 || closeCount === 0) {
    throw new Error(`connection resurrected after shutdown: connections=${manager.connections.size} closes=${closeCount}`);
  }
});

await run("close-pending connections are not reused and preserve replacement cache", async () => {
  const manager = new McpUpstreamManager(configPath);
  manager.config = {
    version: 1,
    servers: [{ id: "replaceable", name: "Replaceable", enabled: true, transport: "http", url: "http://invalid/mcp", expose: "all" }],
  };

  const releaseOldClose = deferred();
  let oldCloseCalled = false;
  const created = [];
  const discoveryCounts = [];
  manager.createTransport = async () => {
    const index = created.length;
    const client = {
      listTools: async () => {
        discoveryCounts[index] = (discoveryCounts[index] ?? 0) + 1;
        return { tools: [{ name: `tool-${index}` }] };
      },
    };
    const transport = {
      close: async () => {
        if (index === 0) {
          oldCloseCalled = true;
          await releaseOldClose.promise;
        }
      },
    };
    created.push({ client, transport });
    return { client, transport, pid: null };
  };

  let disconnecting;
  try {
    const oldConnection = await manager.connect("replaceable");
    disconnecting = manager.disconnect("replaceable");
    await waitUntil(() => oldCloseCalled);

    const replacement = await manager.connect("replaceable");
    if (replacement === oldConnection) throw new Error("connect reused a connection whose close was pending");
    if (created.length !== 2) throw new Error(`expected a replacement transport, got ${created.length}`);

    releaseOldClose.resolve();
    await disconnecting;

    const replacementDiscoveryCount = discoveryCounts[1];
    const tools = await manager.listTools("replaceable");
    if (manager.connections.get("replaceable") !== replacement) {
      throw new Error("old disconnect removed the replacement connection");
    }
    if (discoveryCounts[1] !== replacementDiscoveryCount) {
      throw new Error("old disconnect removed the replacement tools cache");
    }
    if (tools[0]?.name !== "tool-1") throw new Error(`replacement cache returned unexpected tools: ${JSON.stringify(tools)}`);
  } finally {
    releaseOldClose.resolve();
    if (disconnecting) await disconnecting.catch(() => undefined);
    await manager.shutdown();
  }
});

await run("active upstream operations hold an idle connection lease", async () => {
  const manager = new McpUpstreamManager(configPath);
  manager.config = {
    version: 1,
    servers: [{
      id: "leased",
      name: "Leased",
      enabled: true,
      transport: "http",
      url: "http://invalid/mcp",
      expose: "all",
      idle_timeout_sec: 0.05,
    }],
  };

  const releaseCall = deferred();
  let operationStarted = false;
  let closeCount = 0;
  manager.createTransport = async () => ({
    client: {
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        operationStarted = true;
        await releaseCall.promise;
        return { content: [{ type: "text", text: "done" }] };
      },
    },
    transport: { close: async () => { closeCount++; } },
    pid: null,
  });

  const call = manager.callTool("leased", "slow");
  try {
    await waitUntil(() => operationStarted);
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (closeCount !== 0 || !manager.connections.has("leased")) {
      throw new Error(`idle timer closed an active operation: connections=${manager.connections.size} closes=${closeCount}`);
    }

    releaseCall.resolve();
    await call;
    await waitUntil(() => closeCount === 1);
    if (manager.connections.has("leased")) throw new Error("idle connection remained after the operation lease ended");
  } finally {
    releaseCall.resolve();
    await call.catch(() => undefined);
    await manager.shutdown();
  }
});

await run("save and load upstream config", async () => {
  await saveUpstreamConfig(
    {
      version: 1,
      servers: [
        {
          id: "demo",
          name: "Demo",
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:3999/mcp",
          expose: "all",
        },
      ],
    },
    configPath
  );
  const loaded = await loadUpstreamConfig(configPath);
  if (loaded.servers.length !== 1 || loaded.servers[0].id !== "demo") {
    throw new Error(JSON.stringify(loaded));
  }
});

await run("parse claude code mcp config", async () => {
  const fixture = {
    projects: {
      "/proj": {
        mcpServers: {
          gh: { type: "http", url: "http://127.0.0.1:3100/mcp" },
        },
      },
    },
    mcpServers: {
      local: { command: "node", args: ["srv.js"] },
    },
  };
  const parsed = parseClaudeCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse opencode mcp config", async () => {
  const fixture = {
    mcp: {
      demo: { type: "local", command: ["node", "srv.js"] },
      remote: { type: "remote", url: "http://127.0.0.1:3200/mcp" },
    },
  };
  const parsed = parseOpenCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse and import cursor mcp config", async () => {
  const fixture = {
    mcpServers: {
      unity: { command: "node", args: ["C:/tools/unity.js"], cwd: "C:/game" },
      crawl: { url: "http://127.0.0.1:3100/mcp" },
    },
  };
  const parsed = parseMcpServersFile(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
  const fixturePath = path.join(tmpDir, "cursor-mcp-fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture), "utf-8");
  const result = await importCursorMcpConfig(fixturePath, { merge: true });
  if (!result.imported.includes("unity") || !result.imported.includes("crawl")) {
    throw new Error(JSON.stringify(result.imported));
  }
});

const httpPort = 3901 + Math.floor(Math.random() * 200);
const mockHttp = spawnMockHttp(httpPort);
try {
  await waitForHealth(`http://127.0.0.1:${httpPort}/health`);

  await run("manager connects to http upstream and lists tools", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "all",
          tool_prefix: "mockhttp",
        },
      ],
    });
    const tools = await manager.listTools("mockhttp");
    if (!tools.some((t) => t.name === "add")) throw new Error("add tool missing");
    const raw = await manager.callTool("mockhttp", "add", { a: 2, b: 3 });
    const text = JSON.stringify(raw);
    if (!text.includes("5")) throw new Error(text);
  });

  await run("enabled upstream exposes all tools as prefixed direct tools", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });
    const hub = new McpServer({ name: "test-hub", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    registerMcpBridgeTools(hub, manager);
    const proxied = await refreshProxiedTools(hub, manager);
    if (!proxied.includes("mockhttp__add")) throw new Error(JSON.stringify(proxied));
    const names = manager.getProxiedToolNames(manager.getServerConfig("mockhttp"), await manager.listTools("mockhttp"));
    if (!names.includes("mockhttp__add")) throw new Error(JSON.stringify(names));
  });
} finally {
  mockHttp.kill("SIGTERM");
}

await run("manager connects to stdio mock upstream", async () => {
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  await manager.updateConfig({
    version: 1,
    servers: [
      {
        id: "mockstdio",
        name: "Mock Stdio",
        enabled: true,
        transport: "stdio",
        command: testNode,
        args: [path.join(root, "scripts/mock-stdio-mcp.mjs")],
        expose: "all",
      },
    ],
  });
  const tools = await manager.listTools("mockstdio");
  if (!tools.some((t) => t.name === "echo")) throw new Error(JSON.stringify(tools));
  const raw = await manager.callTool("mockstdio", "echo", { message: "hi" });
  const text = JSON.stringify(raw);
  if (!text.includes("echo:hi")) throw new Error(text);
  await manager.disconnect("mockstdio");
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
