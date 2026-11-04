/**
 * Deterministic Browser Use lifecycle regression. Real MCP registration is used;
 * connection creation/disposal are mocked, so no browser or desktop process runs.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.HARNESS_TEST_DIST_ROOT ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT) : path.join(root, "dist");
const reportIndex = process.argv.indexOf("--report");
const reportPath = reportIndex >= 0 ? path.resolve(process.argv[reportIndex + 1]) : undefined;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-browser-lifecycle-"));
const workspace = path.join(tmp, "workspace");
const otherWorkspace = path.join(tmp, "other-workspace");
const runtimeRoot = path.join(tmp, "vendor", "browser-use");
const runtimeLock = path.join(tmp, "bundled-plugins", "browser-use", "runtime-lock.json");
const environment = {
  CODEX_HOME: path.join(tmp, "codex-runtime"),
  AUDIT_LOG_PATH: path.join(tmp, "audit.jsonl"),
  MCP_SHELL_STATE_DIR: path.join(tmp, "shell"),
  MCP_UPSTREAM_CONFIG: path.join(tmp, "upstream.json"),
  CHATGPT_PLUGINS_CONFIG: path.join(tmp, "plugins.json"),
  CHATGPT_TOOL_PROFILE: "full",
  HARNESS_RELAY_ENABLED: "false",
  HARNESS_RELAY_AUTOMATION_ENABLED: "false",
  HARNESS_COMPANION_ENABLED: "false",
  GOAL_WATCHDOG_ENABLED: "false",
  HARNESS_BROWSER_USE_RUNTIME_ROOT: runtimeRoot,
  HARNESS_BROWSER_USE_RUNTIME_LOCK: runtimeLock,
  HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256: "",
  HARNESS_BROWSER_USE_DATA_DIR: path.join(tmp, "browser-data"),
  HARNESS_BROWSER_USE_AUDIT_LOG: path.join(tmp, "browser.audit.jsonl"),
  HARNESS_BROWSER_USE_HEADLESS: "true",
  HARNESS_ACCOUNT_ID: "browser-fixture-account",
};
const previousEnv = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
const checks = [];
const connections = new Set();
const mockedProviders = new Set();
const registries = new Set();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
let providerPrototype, originalCreate, originalDispose;
let failed, beforeVersions, afterVersions;
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const scope = (key, binding = "goal-a") => ({ key: sha(key), binding: sha(binding) });
const textResult = (value) => ({ content: [{ type: "text", text: "FAKE_BROWSER " + JSON.stringify(value) }] });
const resultData = (result) => {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const text = result.content?.find((item) => item.type === "text" && item.text.startsWith("FAKE_BROWSER "))?.text;
  assert.ok(text, JSON.stringify(result));
  return JSON.parse(text.slice("FAKE_BROWSER ".length));
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out: " + label)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function mark(name, operation) {
  await operation();
  checks.push({ name, passed: true });
  console.log("PASS " + name);
}
async function versions() {
  const files = [
    ["source", root, "src/lib/provider-scope.ts"],
    ["source", root, "src/lib/browser-use-provider.ts"],
    ["source", root, "src/lib/browser-use-registry.ts"],
    ["source", root, "src/tools/browser-use.ts"],
    ["test", root, "scripts/test-browser-use-session-lifecycle.mjs"],
    ["compiled", dist, "lib/provider-scope.js"],
    ["compiled", dist, "lib/browser-use-provider.js"],
    ["compiled", dist, "lib/browser-use-registry.js"],
    ["compiled", dist, "tools/browser-use.js"],
  ];
  return Promise.all(files.map(async ([kind, base, relative]) => {
    const bytes = await fs.readFile(path.join(base, relative));
    return { kind, path: relative, bytes: bytes.length, sha256: sha(bytes) };
  }));
}
const intent = JSON.stringify({
  intent_revision: 1, objective: "Exercise isolated mocked Browser Use session lifetime and isolation",
  scope: [tmp, "Mocked browser connections through real MCP registration"],
  out_of_scope: ["Live desktop/browser input", "Host services", "User data", "Non-fixture Goals"],
  deliverables: ["Regression assertions"],
  success_criteria: ["Trusted conversation retains browser state across fresh MCP transports with correct isolation"],
  constraints: ["No native process invocation", "Only owned temporary fixture state"],
  protected_resources: ["Host desktop", "Unrelated Goals and accounts"],
  known_facts: ["All browser connection responses in this process are mocked"],
  assumptions: [], delegated_decisions: ["Fixture implementation"],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [],
  clarification_round: 0, questions_in_round: 0, resolution_mode: "none",
});

try {
  const provenance = {
    schema_version: 1, browser_use: { version: "0.13.10", commit: "fixture" },
    browser_harness: { version: "0.1.13", commit: "fixture" },
    python: { version: "fixture" }, chrome_for_testing: { version: "fixture" },
    wheels: [], telemetry_default: "disabled", critical_files: {},
  };
  for (const dir of [workspace, otherWorkspace, path.join(runtimeRoot, "python"),
    path.join(runtimeRoot, "chrome", "chrome-win64"), path.join(runtimeRoot, "site-packages"), path.dirname(runtimeLock)]) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const file of [path.join(runtimeRoot, "python", "python.exe"), path.join(runtimeRoot, "chrome", "chrome-win64", "chrome.exe")]) {
    await fs.writeFile(file, "not executable: deterministic fixture only");
  }
  await fs.writeFile(path.join(runtimeRoot, "provenance.json"), JSON.stringify(provenance));
  await fs.writeFile(runtimeLock, JSON.stringify(provenance));
  environment.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = sha(await fs.readFile(runtimeLock));
  Object.assign(process.env, environment);
  await fs.writeFile(environment.CHATGPT_PLUGINS_CONFIG, JSON.stringify({
    schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: true }, skills: [],
  }));
  const { BrowserUseProvider } = await import(pathToFileURL(path.join(dist, "lib", "browser-use-provider.js")).href);
  const { BrowserUseRegistry, disposeBrowserUseProvider } = await import(pathToFileURL(path.join(dist, "lib", "browser-use-registry.js")).href);
  const { createMcpServer } = await import(pathToFileURL(path.join(dist, "server-factory.js")).href);
  beforeVersions = await versions();
  providerPrototype = BrowserUseProvider.prototype;
  originalCreate = providerPrototype.createConnection;
  originalDispose = providerPrototype.disposeConnection;
  let generation = 0;
  providerPrototype.createConnection = async function () {
    mockedProviders.add(this);
    const state = { id: ++generation, value: null, directory: this.options.dataDirectory, effects: 0, closed: 0 };
    this.fixtureState = state;
    return {
      chrome: { exitCode: null, signalCode: null }, chromePid: 900000 + generation,
      transport: { pid: 910000 + generation }, provenance, cdpPort: 0, daemonStarted: false,
      state,
      client: { callTool: async ({ name, arguments: args }) => {
        if (name === "browser_exec" && args.code === "upstream-error") {
          return { isError: true, content: [{ type: "text", text: "fixture upstream failure" }], structuredContent: { reason: "fixture-error" } };
        }
        if (name === "browser_exec" && args.code.startsWith("set:")) state.value = args.code.slice(4);
        const result = textResult(state);
        if (name === "browser_screenshot") result.content.push({ type: "image", data: png, mimeType: "image/png" });
        return result;
      } },
    };
  };
  providerPrototype.disposeConnection = async function (connection) { connection.state.closed++; };
  async function connect(conversation, base = workspace) {
    const server = createMcpServer(base, 30_000, [base], false);
    const client = new Client({ name: "browser-lifecycle-fixture", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.sessionId = "transport-" + crypto.randomUUID();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const handle = {
      server, client,
      call: (name, args = {}) => client.callTool({
        name, arguments: { ...args, _intent: intent }, _meta: { "openai/session": conversation },
      }),
      close: async () => {
        await disposeBrowserUseProvider(server);
        await client.close();
        await server.close();
        connections.delete(handle);
      },
    };
    connections.add(handle);
    return handle;
  }

  await mark("mcp_cross_transport_state_and_teardown", async () => {
    const first = await connect("same-conversation");
    const selected = resultData(await first.call("browser_use_exec", { code: "set:persistent-marker" }));
    await first.close();
    const second = await connect("same-conversation");
    const observed = resultData(await second.call("browser_use_screenshot"));
    assert.equal(observed.id, selected.id);
    assert.equal(observed.value, "persistent-marker");
    assert.equal(observed.closed, 0);
    assert.equal(observed.directory, selected.directory);
    await second.close();
  });
  await mark("mcp_conversation_workspace_isolation", async () => {
    const own = await connect("same-conversation");
    const foreign = await connect("other-conversation");
    const other = await connect("same-conversation", otherWorkspace);
    const a = resultData(await own.call("browser_use_screenshot"));
    const b = resultData(await foreign.call("browser_use_screenshot"));
    const c = resultData(await other.call("browser_use_screenshot"));
    assert.equal(b.value, null); assert.equal(c.value, null);
    assert.equal(new Set([a.id, b.id, c.id]).size, 3);
    assert.equal(new Set([a.directory, b.directory, c.directory]).size, 3);
    for (const item of [a, b, c]) assert.ok(item.directory.includes(path.join("sessions", "")));
    await own.close(); await foreign.close(); await other.close();
  });

  await mark("mcp_output_envelope_preserves_images_and_upstream_errors", async () => {
    const handle = await connect("protocol-envelope");
    const executed = await handle.call("browser_use_exec", { code: "set:protocol-marker" });
    assert.equal(executed.structuredContent.ok, true);
    assert.equal(executed.structuredContent.tool, "browser_use_exec");
    const screenshot = await handle.call("browser_use_screenshot");
    assert.equal(screenshot.structuredContent.ok, true);
    assert.equal(screenshot.structuredContent.tool, "browser_use_screenshot");
    assert.equal(screenshot.content.find((item) => item.type === "image")?.data, png);
    assert.equal(resultData(screenshot).value, "protocol-marker");
    const error = await handle.call("browser_use_exec", { code: "upstream-error" });
    assert.equal(error.isError, true);
    assert.equal(error.structuredContent.ok, false);
    assert.equal(error.structuredContent.tool, "browser_use_exec");
    assert.equal(error.structuredContent.data.upstream_result.reason, "fixture-error");
    assert.ok(error.content.some((item) => item.type === "text" && item.text === "fixture upstream failure"));
    await handle.close();
  });

  function mockRegistry(overrides = {}) {
    const made = [];
    let now = 0, identity = "provision-a", provisioningError;
    const config = {
      createProvider: ({ dataDirectory }) => {
        const provider = {
          id: made.length + 1, dataDirectory, value: null, closed: 0, events: [],
          async call(tool, args) {
            assert.equal(this.closed, 0);
            this.events.push("call:" + String(args.code ?? tool));
            if (args.started) args.started.resolve();
            if (args.gate) await args.gate.promise;
            if (args.code?.startsWith("set:")) this.value = args.code.slice(4);
            return textResult({ id: this.id, directory: dataDirectory, value: this.value });
          },
          async status() { return { id: this.id, closed: this.closed }; },
          async close() { this.events.push("close"); this.closed++; },
        };
        made.push(provider); return provider;
      },
      provisioning: () => {
        if (provisioningError) throw new Error(provisioningError);
        return { dataRoot: path.join(tmp, "mock-data"), identity };
      },
      now: () => now, idleTimeoutMs: 100, sweepIntervalMs: 60_000, maxEntries: 4,
      ...overrides,
    };
    const registry = new BrowserUseRegistry(config);
    registries.add(registry);
    return {
      registry, made, setNow: (value) => { now = value; },
      rotate: () => { identity += "-rotated"; },
      failProvisioning: (value) => { provisioningError = value; },
    };
  }
  await mark("goal_transition_serialization_and_no_resurrection", async () => {
    const f = mockRegistry(), a = scope("shared"), b = scope("shared", "goal-b");
    const gate = deferred(), started = deferred();
    const first = f.registry.call(a, "browser_exec", { code: "set:old", gate, started });
    await bounded(started.promise, "old Goal call entered");
    const transition = f.registry.call(b, "browser_screenshot", {});
    assert.equal(f.made[0].closed, 0);
    gate.resolve(); await first;
    const newer = resultData(await transition);
    assert.equal(newer.value, null); assert.equal(f.made[0].closed, 1);
    const returned = resultData(await f.registry.call(a, "browser_screenshot", {}));
    assert.equal(returned.value, null); assert.equal(f.made[1].closed, 1);
    assert.equal(new Set(f.made.map((p) => p.dataDirectory)).size, 3);
    await f.registry.dispose();
  });
  await mark("provisioning_rotation_failure_and_fresh_generation", async () => {
    const f = mockRegistry(), s = scope("provision");
    await f.registry.call(s, "browser_exec", { code: "set:old" });
    f.rotate();
    assert.equal(resultData(await f.registry.call(s, "browser_screenshot", {})).value, null);
    assert.equal(f.made[0].closed, 1);
    f.failProvisioning("fixture revoked");
    await assert.rejects(f.registry.call(s, "browser_screenshot", {}), /fixture revoked/);
    assert.equal(f.made[1].closed, 1);
    f.failProvisioning(undefined);
    await f.registry.call(s, "browser_screenshot", {});
    assert.equal(new Set(f.made.map((p) => p.dataDirectory)).size, 3);
    await f.registry.dispose();
  });
  await mark("idle_capacity_and_explicit_close_preserve_active_work", async () => {
    const f = mockRegistry({ maxEntries: 1 }), s = scope("busy");
    const gate = deferred(), started = deferred();
    const running = f.registry.call(s, "browser_exec", { code: "set:busy", gate, started });
    await bounded(started.promise, "busy scope call entered");
    f.setNow(1000);
    assert.equal(await f.registry.sweepExpired(), 0);
    await assert.rejects(f.registry.call(scope("overflow"), "browser_screenshot", {}), /CAPACITY_BUSY/);
    assert.equal(f.made[0].closed, 0);
    const close = f.registry.close(s.key);
    assert.equal(f.made[0].closed, 0);
    gate.resolve(); await running; await close;
    assert.equal(f.made[0].closed, 1);
    await f.registry.call(s, "browser_screenshot", {});
    f.setNow(1200); assert.equal(await f.registry.sweepExpired(), 1);
    assert.equal(f.made[1].closed, 1);
    await f.registry.call(s, "browser_screenshot", {});
    assert.equal(new Set(f.made.map((p) => p.dataDirectory)).size, 3);
    await f.registry.dispose();
  });

  await mark("cancelled_queued_scope_never_dispatches", async () => {
    const f = mockRegistry(), s = scope("cancelled");
    const gate = deferred(), started = deferred(), controller = new AbortController();
    const running = f.registry.call(s, "browser_exec", { code: "set:running", gate, started });
    await bounded(started.promise, "running call before queued cancellation");
    const cancelled = f.registry.call({ ...scope("cancelled", "next-goal"), signal: controller.signal }, "browser_exec", { code: "set:must-not-run" });
    const cancelledAssertion = assert.rejects(cancelled, /REQUEST_ABORTED/);
    controller.abort(); gate.resolve(); await running; await cancelledAssertion;
    assert.equal(f.made.length, 1);
    assert.deepEqual(f.made[0].events, ["call:set:running"]);
    assert.equal(f.made[0].closed, 0);
    await f.registry.dispose();
  });

  class ControlledProvider extends BrowserUseProvider {
    constructor(options = {}) {
      super({ idleTimeoutMs: 0 });
      this.control = options; this.events = []; this.invocations = []; this.disposals = 0;
      this.identity = "fixture-provision";
    }
    readProvisioningIdentity() {
      if (this.provisionError) throw new Error(this.provisionError);
      return this.identity;
    }
    async createConnection() {
      this.events.push("connect");
      this.control.connectStarted?.resolve();
      if (this.control.connectGate) await this.control.connectGate.promise;
      return {
        chrome: { exitCode: null, signalCode: null }, chromePid: 1, transport: { pid: 2 },
        daemonStarted: false, provenance, cdpPort: 0,
        client: { callTool: async ({ name, arguments: args }) => {
          this.events.push("call:" + args.code);
          this.invocations.push(name);
          this.control.callStarted?.resolve();
          if (this.control.callGate) await this.control.callGate.promise;
          if (args.code === "effect-then-timeout") throw new Error("connection closed after effect");
          if (name === "browser_screenshot" && this.control.screenshotFailures > 0) {
            this.control.screenshotFailures--; throw new Error("temporary connection reset");
          }
          return textResult({ ok: true });
        } },
      };
    }
    async disposeConnection() { this.disposals++; this.events.push("dispose"); }
  }
  await mark("provider_before_dispatch_guard_never_replays", async () => {
    const f = mockRegistry(), gate = deferred(), entered = deferred();
    const operation = f.registry.call({ ...scope("guard-entry"), beforeDispatch: async () => {
      entered.resolve(); await gate.promise; throw new Error("fixture authorization closed");
    } }, "browser_exec", { code: "must-not-run" });
    const rejected = assert.rejects(operation, /fixture authorization closed/);
    await bounded(entered.promise, "registry deferred admission");
    assert.equal(f.made.length, 0);
    gate.resolve(); await rejected; assert.equal(f.made.length, 0);
    await f.registry.dispose();

    const direct = new ControlledProvider(), directGate = deferred(), directEntered = deferred();
    const directOperation = direct.call("browser_exec", { code: "must-not-connect" }, undefined, async () => {
      directEntered.resolve(); await directGate.promise; throw new Error("fixture authorization closed");
    });
    const directRejected = assert.rejects(directOperation, /fixture authorization closed/);
    await bounded(directEntered.promise, "provider queued admission");
    assert.deepEqual(direct.events, []);
    directGate.resolve(); await directRejected; assert.deepEqual(direct.events, []);
    await direct.close();

    for (const tool of ["browser_exec", "browser_screenshot"]) {
      const connectGate = deferred(), connectStarted = deferred(), guardGate = deferred(), guardEntered = deferred();
      const p = new ControlledProvider({ connectGate, connectStarted });
      const linked = mockRegistry({ createProvider: () => p });
      let guardCalls = 0;
      const guarded = linked.registry.call({ ...scope("guard-after-connect-" + tool), beforeDispatch: async () => {
        guardCalls++;
        if (guardCalls === 3) {
          guardEntered.resolve(); await guardGate.promise;
          // This text resembles an upstream transient error; admission failure
          // still must not be retried, even for a read-only screenshot.
          throw new Error("fixture authorization closed");
        }
      } }, tool, { code: "must-not-run" });
      const guardRejected = assert.rejects(guarded, /fixture authorization closed/);
      await bounded(connectStarted.promise, "connection before deferred dispatch check");
      connectGate.resolve();
      await bounded(guardEntered.promise, "forwarded guard immediately before upstream dispatch");
      assert.deepEqual(p.invocations, []);
      guardGate.resolve(); await guardRejected;
      assert.equal(guardCalls, 3); assert.deepEqual(p.invocations, []);
      await linked.registry.dispose(); assert.equal(p.disposals, 1);
    }

    const controller = new AbortController(), cancelGate = deferred(), cancelEntered = deferred();
    const cancelled = new ControlledProvider();
    let calls = 0;
    const cancellable = cancelled.call("browser_exec", { code: "must-not-run" }, controller.signal, async () => {
      if (++calls === 2) { cancelEntered.resolve(); await cancelGate.promise; }
    });
    const cancelRejected = assert.rejects(cancellable, /REQUEST_ABORTED/);
    await bounded(cancelEntered.promise, "dispatch authorization pending while cancelled");
    controller.abort(); cancelGate.resolve(); await cancelRejected;
    assert.deepEqual(cancelled.invocations, []);
    await cancelled.close(); assert.equal(cancelled.disposals, 1);
  });
  await mark("close_during_connect_fences_new_calls_and_disposes_once", async () => {
    const connectGate = deferred(), connectStarted = deferred();
    const p = new ControlledProvider({ connectGate, connectStarted });
    const accepted = p.call("browser_exec", { code: "accepted" });
    await bounded(connectStarted.promise, "pending connection");
    const closing = p.close();
    await assert.rejects(p.call("browser_exec", { code: "late" }), /PROVIDER_CLOSED/);
    connectGate.resolve(); await accepted; await closing; await p.close();
    assert.deepEqual(p.events, ["connect", "call:accepted", "dispose"]);
    assert.equal(p.disposals, 1);
  });
  await mark("cancel_during_connect_never_dispatches_upstream", async () => {
    const connectGate = deferred(), connectStarted = deferred(), controller = new AbortController();
    const p = new ControlledProvider({ connectGate, connectStarted });
    const operation = p.call("browser_exec", { code: "must-not-run" }, controller.signal);
    const rejected = assert.rejects(operation, /REQUEST_ABORTED/);
    await bounded(connectStarted.promise, "connection awaiting cancellation");
    controller.abort(); connectGate.resolve(); await rejected;
    assert.deepEqual(p.invocations, []);
    await p.close(); assert.equal(p.disposals, 1);
  });
  await mark("close_drains_inflight_and_already_accepted_calls", async () => {
    const callGate = deferred(), callStarted = deferred();
    const p = new ControlledProvider({ callGate, callStarted });
    const first = p.call("browser_exec", { code: "first" });
    await bounded(callStarted.promise, "inflight call");
    const second = p.call("browser_exec", { code: "second" });
    const closing = p.close();
    await assert.rejects(p.call("browser_exec", { code: "late" }), /PROVIDER_CLOSED/);
    assert.equal(p.disposals, 0);
    callGate.resolve(); await first; await second; await closing;
    assert.deepEqual(p.events, ["connect", "call:first", "call:second", "dispose"]);
  });
  await mark("exec_no_replay_and_same_connection_screenshot_retry", async () => {
    const p = new ControlledProvider({ screenshotFailures: 1 });
    await assert.rejects(p.call("browser_exec", { code: "effect-then-timeout" }), /after effect/);
    assert.equal(p.invocations.filter((name) => name === "browser_exec").length, 1);
    await p.call("browser_screenshot", {});
    assert.equal(p.invocations.filter((name) => name === "browser_screenshot").length, 2);
    assert.equal(p.events.filter((event) => event === "connect").length, 1);
    await p.close();
  });
  await mark("provider_provisioning_revocation_disposes_and_fences", async () => {
    for (const invalid of [false, true]) {
      const p = new ControlledProvider();
      await p.call("browser_exec", { code: "initial" });
      if (invalid) p.provisionError = "fixture integrity failure"; else p.identity = "rotated";
      await assert.rejects(p.call("browser_exec", { code: "stale" }), invalid ? /integrity failure/ : /PROVISIONING_CHANGED/);
      assert.equal(p.disposals, 1);
      await assert.rejects(p.call("browser_exec", { code: "late" }), /PROVIDER_CLOSED/);
      await p.close();
    }
  });
  await mark("queued_provisioning_revocation_never_reconnects", async () => {
    for (const invalid of [false, true]) {
      const p = new ControlledProvider();
      await p.call("browser_exec", { code: "initial" });
      if (invalid) p.provisionError = "fixture revoked"; else p.identity = "rotated";
      const first = p.call("browser_exec", { code: "detect-revocation" });
      const queued = p.call("browser_exec", { code: "must-not-reconnect" });
      const results = await Promise.allSettled([first, queued]);
      assert.equal(results[0].status, "rejected");
      assert.equal(results[1].status, "rejected");
      assert.match(String(results[1].reason), /PROVIDER_REVOKED/);
      assert.equal(p.events.filter((event) => event === "connect").length, 1);
      assert.deepEqual(p.invocations, ["browser_exec"]);
      assert.equal(p.disposals, 1);
      await p.close();
    }
  });
  await mark("missing_scope_fails_closed", async () => {
    const { registerBrowserUseTools } = await import(pathToFileURL(path.join(dist, "tools", "browser-use.js")).href);
    const callbacks = new Map(), fakeServer = { registerTool: (name, _config, callback) => callbacks.set(name, callback) };
    registerBrowserUseTools(fakeServer);
    await assert.rejects(async () => callbacks.get("browser_use_screenshot")({ full: false }), /SCOPE|scope/i);
    await disposeBrowserUseProvider(fakeServer);
  });
  afterVersions = await versions();
  assert.deepEqual(afterVersions, beforeVersions, "Verified source/compiled files changed while assertions ran");
  checks.push({ name: "verified_source_and_compiled_bytes_stable", passed: true });
} catch (error) {
  failed = error;
  console.error(error?.stack ?? String(error));
} finally {
  for (const handle of [...connections]) await handle.close().catch((error) => { failed ??= error; });
  for (const registry of registries) await registry.dispose().catch((error) => { failed ??= error; });
  for (const provider of mockedProviders) await provider.close().catch((error) => { failed ??= error; });
  if (providerPrototype) {
    providerPrototype.createConnection = originalCreate;
    providerPrototype.disposeConnection = originalDispose;
  }
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch((error) => { failed ??= error; });
}
const result = {
  schema_version: 1, complete: !failed, passed: !failed, checked_at: new Date().toISOString(),
  checks,
  source_files: (afterVersions ?? beforeVersions ?? []).filter((item) => item.kind !== "compiled"),
  compiled_files: (afterVersions ?? beforeVersions ?? []).filter((item) => item.kind === "compiled"),
  ...(failed ? { failure: String(failed?.stack ?? failed) } : {}),
};
if (reportPath) {
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(result, null, 2) + "\n");
}
console.log("BROWSER_USE_SESSION_LIFECYCLE_RESULT " + JSON.stringify(result));
if (failed) process.exitCode = 1;
