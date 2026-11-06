/**
 * Real MCP registration/session regression. Native helper and capability reads
 * are mocked in this process; no desktop input or external service is used.
 * Optional HARNESS_CU_SESSION_REPORT writes a structured verification artifact.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import isolation from "../desktop/scripts/lib/test-isolation.cjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT) : path.join(sourceRoot, "dist");
const reportArgumentIndex = process.argv.indexOf("--report");
const reportTarget = reportArgumentIndex >= 0
  ? process.argv[reportArgumentIndex + 1] : process.env.HARNESS_CU_SESSION_REPORT;
const reportFile = reportTarget ? path.resolve(reportTarget) : undefined;
const startedAt = new Date().toISOString();
const tempRoot = isolation.artifactRoot("computer-use-session-persistence");
const workspace = path.join(tempRoot, "workspace");
const otherWorkspace = path.join(tempRoot, "other-workspace");
const environment = {
  CODEX_HOME: path.join(tempRoot, "runtime"),
  AUDIT_LOG_PATH: path.join(tempRoot, "audit.jsonl"),
  MCP_SHELL_STATE_DIR: path.join(tempRoot, "shell"),
  MCP_UPSTREAM_CONFIG: path.join(tempRoot, "upstream.json"),
  CHATGPT_PLUGINS_CONFIG: path.join(tempRoot, "plugins.json"),
  CHATGPT_TOOL_PROFILE: "full",
  HARNESS_RELAY_ENABLED: "false",
  HARNESS_RELAY_AUTOMATION_ENABLED: "false",
  HARNESS_COMPANION_ENABLED: "false",
  GOAL_WATCHDOG_ENABLED: "false",
  HARNESS_COMPUTER_USE_AUDIT_LOG: path.join(tempRoot, "computer-use.audit.jsonl"),
};
const savedEnvironment = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
await fs.mkdir(workspace);
await fs.mkdir(otherWorkspace);
await fs.writeFile(environment.CHATGPT_PLUGINS_CONFIG, JSON.stringify({
  schema_version: 2, computer_use: { enabled: true }, browser_use: { enabled: false }, skills: [],
}));
const intent = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated mocked Computer Use session lifetime and isolation",
  scope: [tempRoot, "Mocked provider requests and real MCP fixture Goals"],
  out_of_scope: ["Live desktop input", "Host services", "User data", "Non-fixture Goals"],
  deliverables: ["Regression assertions"],
  success_criteria: ["Trusted conversation retains target across fresh MCP transports with correct isolation"],
  constraints: ["No native process invocation", "Only owned temporary fixture state"],
  protected_resources: ["Host desktop", "Unrelated Goals and accounts"],
  known_facts: ["All native responses in this process are mocked"],
  assumptions: [], delegated_decisions: ["Fixture implementation"],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [],
  clarification_round: 0, questions_in_round: 0, resolution_mode: "none",
});
let capability = {
  schema_version: 1, provider: "computer-use",
  account_id: "a".repeat(32), instance_id: "cui_fixture_initial",
  token: "fixture-only-not-a-live-secret",
  issued_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  helper_sha256: "b".repeat(64),
};
let capabilityError;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const noSelection = /select.+(desktop|window|target)|selected.target|selection/i;
const nativeFailureText = "OWNED-CU-NATIVE-FAILURE";
const connections = new Set();
const checks = [];
const helperEvents = [];
const helperActive = new WeakMap();
const gates = new Map();
const entryGates = new Map();
let maxSameProviderConcurrency = 0;
let providerPrototype;
let originalValidate;
let originalHelper;
let originalExecute;
let createMcpServer;
let createRuntimeScope;
let runWithRuntimeScope;
let getRuntimeScope;
let getComputerUseProvider;
let beforeVersions;
let afterVersions;
let failed;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function blockWindow(hwnd) {
  const gate = { started: deferred(), released: deferred() };
  gates.set(hwnd, gate);
  return gate;
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out: " + label)), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}
function data(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent ?? result));
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent ?? result));
  return result.structuredContent.data;
}
function assertToolError(result, pattern = noSelection) {
  assert.equal(result.isError === true || result.structuredContent?.ok === false, true,
    "request unexpectedly succeeded: " + JSON.stringify(result.structuredContent ?? result));
  const message = (result.content ?? []).filter(item => item.type === "text").map(item => item.text).join("\n");
  assert.match(message + JSON.stringify(result.structuredContent ?? {}), pattern);
}
function mark(name) {
  checks.push({ name, passed: true });
  console.log("PASS " + name);
}
async function captureVersions() {
  const files = [
    ["source", sourceRoot, "src/lib/invocation-gateway.ts"],
    ["source", sourceRoot, "src/lib/runtime-scope.ts"],
    ["source", sourceRoot, "src/lib/provider-scope.ts"],
    ["source", sourceRoot, "src/lib/computer-use-registry.ts"],
    ["source", sourceRoot, "src/lib/computer-use-provider.ts"],
    ["source", sourceRoot, "src/tools/computer-use.ts"],
    ["test", sourceRoot, "scripts/test-computer-use-session-persistence.mjs"],
    ["compiled", distRoot, "lib/invocation-gateway.js"],
    ["compiled", distRoot, "lib/runtime-scope.js"],
    ["compiled", distRoot, "lib/provider-scope.js"],
    ["compiled", distRoot, "lib/computer-use-registry.js"],
    ["compiled", distRoot, "lib/computer-use-provider.js"],
    ["compiled", distRoot, "tools/computer-use.js"],
  ];
  return Promise.all(files.map(async ([kind, root, relative]) => {
    const bytes = await fs.readFile(path.join(root, relative));
    return { kind, path: relative, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  }));
}
async function connect(label, workspaceRoot = workspace, anonymous = false) {
  const server = createMcpServer(workspaceRoot, 30_000, [workspaceRoot], false);
  server.registerTool("cu_scope_probe", {
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const scope = getRuntimeScope();
    const envelope = { ok: true, tool: "cu_scope_probe", summary: "fixture scope",
      data: { session: scope?.mcpSessionId, goal: scope?.goalId ?? null } };
    return { content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope };
  });
  const client = new Client({ name: "cu-persistence-" + label, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  if (!anonymous) serverTransport.sessionId = "transport-" + crypto.randomUUID();
  const entry = { server, client, serverTransport };
  connections.add(entry);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return entry;
}
async function closeConnection(entry) {
  await entry.client.close().catch(() => {});
  await entry.server.close().catch(() => {});
  connections.delete(entry);
}
const call = (entry, conversation, args, name = "computer_use") => entry.client.callTool({
  name, arguments: { ...args, _intent: intent },
  ...(conversation === undefined ? {} : { _meta: { "openai/session": conversation } }),
});
function direct(options, args) {
  const scope = createRuntimeScope({
    workspaceRoot: options.workspace ?? workspace,
    projectRoots: [options.workspace ?? workspace],
    principalId: options.principal,
    tunnelProfile: options.profile,
  }, { sessionId: options.session, signal: options.signal });
  scope.goalId = options.goal;
  scope.goalOwnerSessionId = options.owner;
  scope.goalStatus = options.status;
  return runWithRuntimeScope(scope, () => getComputerUseProvider().execute(args));
}
const selection = (hwnd) => ({ action: "select_target", target: "window", hwnd });
const shot = { action: "screenshot" };

try {
  beforeVersions = await captureVersions();
  ({ createMcpServer } = await import(pathToFileURL(path.join(distRoot, "server-factory.js")).href));
  const runtimeScopeModule = await import(pathToFileURL(path.join(distRoot, "lib", "runtime-scope.js")).href);
  ({ createRuntimeScope, runWithRuntimeScope, getRuntimeScope } = runtimeScopeModule);
  const { hasNativePreDispatchFailure, markNativeDispatchStarted } = runtimeScopeModule;
  const { inspectGoalAdmission } = await import(pathToFileURL(path.join(distRoot, "lib", "goal-effect-scope.js")).href);
  const { EffectiveToolRegistry } = await import(pathToFileURL(path.join(distRoot, "lib", "effective-tool-registry.js")).href);
  const { InvocationGateway } = await import(pathToFileURL(path.join(distRoot, "lib", "invocation-gateway.js")).href);
  const { subscribeActivity } = await import(pathToFileURL(path.join(distRoot, "lib", "activity-log.js")).href);
  const { consumeMcpOutcome } = await import(pathToFileURL(path.join(distRoot, "lib", "mcp-outcome.js")).href);
  ({ getComputerUseProvider } = await import(pathToFileURL(path.join(distRoot, "lib", "computer-use-registry.js")).href));
  const { conversationSessionIdFromMeta, runWithMcpRequestIdentity, runtimePrincipalId } =
    await import(pathToFileURL(path.join(distRoot, "lib", "mcp-request-identity.js")).href);
  const { ComputerUseProvider } =
    await import(pathToFileURL(path.join(distRoot, "lib", "computer-use-provider.js")).href);
  providerPrototype = ComputerUseProvider.prototype;
  originalValidate = providerPrototype.validateCapability;
  originalHelper = providerPrototype.runHelper;
  originalExecute = providerPrototype.execute;
  assert.equal(typeof originalValidate, "function", "capability mock seam changed");
  assert.equal(typeof originalHelper, "function", "native helper mock seam changed");
  providerPrototype.execute = function (request, ...rest) {
    const result = originalExecute.call(this, request, ...rest);
    if (request.action === "type") entryGates.get(request.text)?.resolve(getRuntimeScope());
    return result;
  };
  providerPrototype.validateCapability = function () {
    if (capabilityError) throw new Error(capabilityError);
    return { ...capability };
  };
  providerPrototype.runHelper = async function (request) {
    this.validateCapability();
    const active = (helperActive.get(this) ?? 0) + 1;
    helperActive.set(this, active);
    maxSameProviderConcurrency = Math.max(maxSameProviderConcurrency, active);
    const event = { action: request.action, hwnd: request.hwnd,
      target: request.selected_target ? { ...request.selected_target } : null,
      session: getRuntimeScope()?.mcpSessionId };
    helperEvents.push({ phase: "start", ...event });
    try {
      const gate = request.action === "window_info" ? gates.get(request.hwnd) : undefined;
      if (gate) {
        gate.started.resolve();
        await gate.released.promise;
      }
      if (request.action === "status") return { ok: true, data: { fixture: true } };
      if (request.action === "list_windows") return { ok: true, data: { windows: [{ hwnd: "101", title: "Owned mock window" }] } };
      if (request.action === "window_info") {
        if (request.hwnd === "999") throw new Error("Owned fixture window is unavailable");
        return { ok: true, data: { title: "Owned mock window " + request.hwnd } };
      }
      assert.ok(request.selected_target, "provider did not pass an explicit target to the helper");
      if (request.action === "screenshot") {
        return { ok: true, data: { width: 1, height: 1, image_base64: png.toString("base64") } };
      }
      assert.ok(["click", "double_click", "move", "type", "scroll", "keypress", "drag", "wait"].includes(request.action),
        "Unexpected mocked helper action: " + request.action);
      if (request.action === "type" && request.text === nativeFailureText) {
        throw Object.assign(new Error("Owned mocked native input failed after helper dispatch"), { operation_started: false });
      }
      return { ok: true, data: { action: request.action, mock_input: true } };
    } finally {
      helperEvents.push({ phase: "end", ...event });
      helperActive.set(this, active - 1);
    }
  };

  const conversationA = "fixture-conversation-A-" + crypto.randomUUID();
  const conversationB = "fixture-conversation-B-" + crypto.randomUUID();
  const first = await connect("first");
  const expectedSession = conversationSessionIdFromMeta({ "openai/session": conversationA });
  assert.equal(data(await call(first, conversationA, {}, "cu_scope_probe")).session, expectedSession);
  assert.equal(data(await call(first, conversationA, { action: "status" })).selected_target, null);
  data(await call(first, conversationA, { action: "list_windows" }));
  const helperCountBeforeUnselected = helperEvents.length;
  assertToolError(await call(first, conversationA, shot));
  assertToolError(await call(first, conversationA, { action: "click", x: 1, y: 1 }));
  assert.equal(helperEvents.length, helperCountBeforeUnselected, "unselected requests reached native helper");
  mark("unselected screenshot and input fail before native dispatch");

  assert.equal(data(await call(first, conversationA, selection("101"))).selected_target.hwnd, "101");
  assert.equal(data(await call(first, conversationA, shot)).selected_target.hwnd, "101");
  await closeConnection(first);
  const second = await connect("second");
  assert.notEqual(second.serverTransport.sessionId, first.serverTransport.sessionId);
  assert.equal(data(await call(second, conversationA, {}, "cu_scope_probe")).session, expectedSession);
  const screenshot = await call(second, conversationA, shot);
  assert.equal(data(screenshot).selected_target.hwnd, "101");
  assert.ok(screenshot.content.some(item => item.type === "image" && item.data === png.toString("base64")));
  mark("same openai/session retains selection across fresh MCP server and transport");

  assertToolError(await call(second, conversationB, shot));
  data(await call(second, conversationB, selection("202")));
  assert.equal(data(await call(second, conversationA, shot)).selected_target.hwnd, "101");
  assert.equal(data(await call(second, conversationB, { action: "click", x: 2, y: 3 })).selected_target.hwnd, "202");
  const spoofConversation = "fixture-spoof-" + crypto.randomUUID();
  assertToolError(await call(second, spoofConversation, {
    ...shot, sessionId: expectedSession, mcpSessionId: expectedSession,
    _meta: { "openai/session": conversationA },
  }));
  mark("different trusted sessions isolate targets even within one registration");

  const beforeDirectKey = helperEvents.length;
  assert.equal(data(await call(second, conversationB, { action: "keypress", keys: ["ALT", "F4"] })).selected_target.hwnd, "202");
  assert.equal(helperEvents.length, beforeDirectKey + 2, "direct keypress must dispatch once to the selected fixture");
  assert.equal(data(await call(second, conversationB, {
    action: "keypress", keys: ["ALT", "F4"], confirmed: true,
  })).selected_target.hwnd, "202");
  assertToolError(await call(second, conversationB, selection("999")), /fixture window is unavailable/);
  assertToolError(await call(second, conversationB, shot));
  data(await call(second, conversationB, selection("202")));
  mark("keypress accepts execution parameters and legacy confirmed; failed retarget clears the old window");

  const aliasHelperCount = helperEvents.length;
  for (const keys of [
    ["CONTROL", "W"], ["CONTROL", "SHIFT", "W"], ["CONTROL", "ALT", "DELETE"],
    [" control ", "w"],
  ]) {
    assert.equal(data(await call(second, conversationB, { action: "keypress", keys, confirmed: false })).selected_target.hwnd, "202");
  }
  assert.equal(data(await call(second, conversationB, { action: "keypress", key: "CONTROL+W" })).selected_target.hwnd, "202");
  assert.equal(helperEvents.length, aliasHelperCount + 10, "each alias must dispatch exactly once");
  mark("CONTROL aliases and chord strings use the selected target without a product approval field");

  const differentWorkspace = await connect("other-workspace", otherWorkspace);
  assertToolError(await call(differentWorkspace, conversationA, shot));
  data(await call(differentWorkspace, conversationA, selection("303")));
  assert.equal(data(await call(second, conversationA, shot)).selected_target.hwnd, "101");
  const aliasWorkspace = await connect("canonical-workspace-alias", workspace + path.sep + ".");
  assert.equal(data(await call(aliasWorkspace, conversationA, shot)).selected_target.hwnd, "101");
  mark("workspace boundaries isolate and canonical aliases retain the same selection");

  const anonymousA = await connect("anonymous-A", workspace, true);
  const anonymousB = await connect("anonymous-B", workspace, true);
  assert.equal(anonymousA.serverTransport.sessionId, undefined);
  assert.equal(anonymousB.serverTransport.sessionId, undefined);
  data(await call(anonymousA, undefined, selection("304")));
  assertToolError(await call(anonymousB, undefined, shot));
  assert.equal(data(await call(anonymousA, undefined, shot)).selected_target.hwnd, "304");
  mark("anonymous server identities remain distinct and stable");

  const conversationGoal = "fixture-goal-" + crypto.randomUUID();
  data(await call(second, conversationGoal, selection("401")));
  const createGoal = label => ({
    action: "create", objective: label,
    success_criteria: [{ name: label + " fixture only", passed: false }],
  });
  const goalA = data(await call(second, conversationGoal, createGoal("Computer Use fixture A"), "goal")).goal;
  assert.ok(goalA.id);
  const beforeGoalRejection = helperEvents.length;
  const goalRejection = await call(second, conversationGoal, shot);
  assertToolError(goalRejection);
  assert.equal(helperEvents.length, beforeGoalRejection, "Goal-local rejection dispatched a native helper");
  assert.equal(goalRejection.structuredContent.data.operation_started, false);
  assert.equal(goalRejection.structuredContent.data.outcome_kind, "blocked");
  assert.equal(goalRejection.structuredContent.data.error_code, "COMPUTER_USE_NOT_DISPATCHED");
  assert.deepEqual(await inspectGoalAdmission(workspace, goalA.id), [], "pre-dispatch rejection stranded a Goal reservation");
  data(await call(second, conversationGoal, selection("402")));
  assert.equal(data(await call(aliasWorkspace, conversationGoal, shot)).selected_target.hwnd, "402");
  const goalB = data(await call(second, conversationGoal, createGoal("Computer Use fixture B"), "goal")).goal;
  assert.notEqual(goalA.id, goalB.id);
  assertToolError(await call(aliasWorkspace, conversationGoal, shot));
  data(await call(aliasWorkspace, conversationGoal, selection("403")));
  assert.equal(data(await call(second, conversationGoal, shot)).selected_target.hwnd, "403");
  assert.equal(data(await call(second, conversationA, shot)).selected_target.hwnd, "101");
  mark("real MCP Goal creation and replacement clear prior selection without affecting another session");

  const closed = data(await call(aliasWorkspace, conversationA, { action: "close" }));
  assert.equal(closed.closed, true);
  assert.equal(closed.selected_target, null);
  assertToolError(await call(second, conversationA, shot));
  assert.equal(data(await call(second, conversationB, shot)).selected_target.hwnd, "202");
  data(await call(second, conversationA, { action: "select_target", target: "desktop" }));
  assert.equal(data(await call(aliasWorkspace, conversationA, shot)).selected_target.kind, "desktop");
  mark("close clears every registration of its session and desktop selection can be re-established");

  assert.throws(() => getComputerUseProvider(), /trusted.*scope/i);
  assert.throws(() => direct({ session: undefined }, { action: "status" }), /trusted.*scope/i);
  const authority = { session: "direct-authority", principal: "principal-A", profile: "profile-A" };
  await direct(authority, selection("501"));
  await assert.rejects(direct({ ...authority, principal: "principal-B" }, shot), noSelection);
  await assert.rejects(direct({ ...authority, profile: "profile-B" }, shot), noSelection);
  assert.equal((await direct(authority, shot)).data.selected_target.hwnd, "501");
  const scopedGoal = { session: "direct-goal", goal: "goal-A", owner: "owner-A" };
  await direct(scopedGoal, selection("502"));
  await assert.rejects(direct({ ...scopedGoal, goal: "goal-B" }, shot), noSelection);
  await assert.rejects(direct(scopedGoal, shot), noSelection);
  await direct(scopedGoal, selection("503"));
  await assert.rejects(direct({ ...scopedGoal, owner: "owner-B" }, shot), noSelection);
  mark("trusted scope is required; principal, profile, Goal and owner boundaries cannot resurrect a target");

  const rotation = { session: "direct-capability-rotation" };
  await direct(rotation, selection("599"));
  capability = { ...capability, expires_at: new Date(Date.now() + 7_200_000).toISOString() };
  assert.equal((await direct(rotation, shot)).data.selected_target.hwnd, "599", "renewal must preserve target while token/instance are unchanged");
  let targetNumber = 600;
  for (const [field, value] of [
    ["token", "fixture-rotated-token"],
    ["instance_id", "cui_fixture_rotated"],
    ["account_id", "c".repeat(32)],
    ["helper_sha256", "d".repeat(64)],
  ]) {
    await direct(rotation, selection(String(targetNumber++)));
    capability = { ...capability, [field]: value };
    await assert.rejects(direct(rotation, shot), noSelection, field + " rotation inherited a target");
    assert.equal((await direct(rotation, { action: "status" })).data.selected_target, null);
  }
  await direct(rotation, selection("610"));
  capabilityError = "Computer Use capability expired (isolated fixture)";
  await assert.rejects(direct(rotation, { action: "status" }), /capability expired/);
  capabilityError = undefined;
  await assert.rejects(direct(rotation, shot), noSelection);
  mark("capability token, instance, account and helper rotation plus validation failure revoke selection");

  const queueSession = { session: "direct-queue-order" };
  const gate = blockWindow("701");
  const eventStart = helperEvents.length;
  const queued = [
    direct(queueSession, selection("701")),
    direct(queueSession, selection("702")),
    direct(queueSession, shot),
    direct(queueSession, { action: "close" }),
    direct(queueSession, shot),
  ];
  const completed = Promise.allSettled(queued);
  await bounded(gate.started.promise, "first queued selection entered native helper");
  assert.equal(helperEvents.slice(eventStart).filter(event => event.phase === "start").length, 1,
    "later operation overtook the blocked selection");
  gate.released.resolve();
  const outcomes = await bounded(completed, "same-session queue completed");
  for (let index = 0; index < 4; index++) assert.equal(outcomes[index].status, "fulfilled");
  assert.equal(outcomes[2].value.data.selected_target.hwnd, "702");
  assert.equal(outcomes[3].value.data.selected_target, null);
  assert.equal(outcomes[4].status, "rejected");
  assert.match(String(outcomes[4].reason), noSelection);
  assert.deepEqual(helperEvents.slice(eventStart).filter(event => event.phase === "start")
    .map(event => [event.action, event.hwnd ?? event.target?.hwnd]), [
      ["window_info", "701"], ["window_info", "702"], ["screenshot", "702"],
    ]);
  await direct(queueSession, selection("703"));
  assert.equal((await direct(queueSession, shot)).data.selected_target.hwnd, "703");
  assert.equal(maxSameProviderConcurrency, 1);
  mark("same-session retarget, screenshot and close serialize; a rejected action does not poison the queue");

  const parallelGate = blockWindow("801");
  const firstParallel = direct({ session: "parallel-A" }, selection("801"));
  await bounded(parallelGate.started.promise, "parallel-A helper started");
  try {
    const other = await bounded(direct({ session: "parallel-B" }, selection("802")),
      "independent session must not wait for blocked session");
    assert.equal(other.data.selected_target.hwnd, "802");
  } finally { parallelGate.released.resolve(); }
  await bounded(firstParallel, "parallel-A selection completion");

  const bindingGate = blockWindow("803");
  const bindingScope = { session: "queued-goal-change", goal: "goal-old", owner: "owner" };
  const pendingBinding = Promise.allSettled([
    direct(bindingScope, selection("803")),
    direct({ ...bindingScope, goal: "goal-new" }, shot),
    direct(bindingScope, shot),
  ]);
  await bounded(bindingGate.started.promise, "Goal-bound queued selection");
  bindingGate.released.resolve();
  const bindingOutcomes = await bounded(pendingBinding, "Goal binding queue completed");
  assert.equal(bindingOutcomes[0].status, "fulfilled");
  assert.equal(bindingOutcomes[1].status, "rejected");
  assert.equal(bindingOutcomes[2].status, "rejected");
  assert.match(String(bindingOutcomes[1].reason), noSelection);
  assert.match(String(bindingOutcomes[2].reason), noSelection);
  mark("independent sessions progress concurrently and queued Goal changes revoke old selection");

  const cancelledSession = { session: "cancelled-queue" };
  const cancelGate = blockWindow("804");
  const cancelEventsBefore = helperEvents.length;
  const beforeCancel = direct(cancelledSession, selection("804"));
  await bounded(cancelGate.started.promise, "selection before cancelled queued input");
  const aborter = new AbortController();
  const cancelledInput = direct({ ...cancelledSession, signal: aborter.signal }, { action: "click", x: 1, y: 1 });
  const cancelOutcomesPromise = Promise.allSettled([beforeCancel, cancelledInput]);
  aborter.abort(new Error("fixture caller cancelled before native dispatch"));
  cancelGate.released.resolve();
  const cancelOutcomes = await bounded(cancelOutcomesPromise, "cancelled queue drained");
  assert.equal(cancelOutcomes[0].status, "fulfilled");
  assert.equal(cancelOutcomes[1].status, "rejected");
  assert.match(String(cancelOutcomes[1].reason), /abort|cancel/i);
  assert.equal(helperEvents.slice(cancelEventsBefore).some(event => event.action === "click"), false,
    "cancelled queued input reached native helper");
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const beforeAbortedCall = helperEvents.length;
  await assert.rejects(direct({ session: "already-cancelled", signal: alreadyAborted.signal }, selection("805")), /abort|cancel/i);
  assert.equal(helperEvents.length, beforeAbortedCall);
  await direct(cancelledSession, selection("806"));
  assert.equal((await direct(cancelledSession, shot)).data.selected_target.hwnd, "806");
  mark("queued and already-cancelled requests never dispatch native input and leave the queue usable");

  const legacyA = new ComputerUseProvider();
  const legacyB = new ComputerUseProvider();
  await legacyA.execute(selection("901"));
  await assert.rejects(legacyB.execute(shot), noSelection);
  assert.equal((await legacyA.execute(shot)).data.selected_target.hwnd, "901");
  mark("direct provider API remains instance-local for existing native smoke fixtures");

  const cancelConversation = "real-goal-cancel-" + crypto.randomUUID();
  const cancellationGoal = data(await call(second, cancelConversation,
    createGoal("Queued Computer Use cancellation fixture"), "goal")).goal;
  assert.equal(cancellationGoal.status, "active");
  const goalCancelGate = blockWindow("807");
  const cancelEntry = deferred();
  const cancelledText = "OWNED-CU-GOAL-CANCEL-INPUT";
  entryGates.set(cancelledText, cancelEntry);
  const beforeGoalCancelEvents = helperEvents.length;
  const goalBlockedSelection = call(second, cancelConversation, selection("807"));
  await bounded(goalCancelGate.started.promise, "real Goal selection helper blocked");
  const goalQueuedInput = call(aliasWorkspace, cancelConversation, { action: "type", text: cancelledText });
  const goalQueuedOutcomes = Promise.allSettled([goalBlockedSelection, goalQueuedInput]);
  try {
    const queuedScope = await bounded(cancelEntry.promise, "real old-Goal input admitted and queued");
    assert.equal(queuedScope.goalId, cancellationGoal.id);
    assert.equal(queuedScope.signal.aborted, false);
    assert.equal(helperEvents.slice(beforeGoalCancelEvents).some(event => event.action === "type"), false);
    const cancelledGoal = data(await call(second, cancelConversation, { action: "cancel" }, "goal")).goal;
    assert.equal(cancelledGoal.id, cancellationGoal.id);
    assert.equal(cancelledGoal.status, "cancelled");
    // Cancelling a work record does not cancel an already queued SDK request.
    // Explicit request aborts were checked above and still prevent dispatch.
    assert.equal(queuedScope.signal.aborted, false);
  } finally {
    goalCancelGate.released.resolve();
    entryGates.delete(cancelledText);
  }
  const settledGoalCalls = await bounded(goalQueuedOutcomes, "old-Goal queue drained after cancellation");
  assert.equal(settledGoalCalls[0].status, "fulfilled");
  assert.equal(settledGoalCalls[1].status, "fulfilled");
  assert.equal(data(settledGoalCalls[1].value).selected_target.hwnd, "807");
  assert.equal(helperEvents.slice(beforeGoalCancelEvents).filter(event => event.phase === "start" && event.action === "type").length, 1,
    "queued input must dispatch exactly once independently of Goal record state");
  const beforeFreshCancelledInput = helperEvents.length;
  assertToolError(await call(second, cancelConversation, { action: "type", text: "AFTER-CANCEL-BEFORE-SELECT" }));
  assert.equal(helperEvents.length, beforeFreshCancelledInput, "new cancelled-state request inherited an old target");
  data(await call(aliasWorkspace, cancelConversation, selection("808")));
  assert.equal(data(await call(second, cancelConversation, shot)).selected_target.hwnd, "808");

  const stateScope = { session: "direct-goal-status", goal: "same-goal", owner: "owner", status: "active" };
  await direct(stateScope, selection("809"));
  await assert.rejects(direct({ ...stateScope, status: "paused" }, shot), noSelection);
  await direct({ ...stateScope, status: "paused" }, selection("810"));
  assert.equal((await direct({ ...stateScope, status: "paused" }, shot)).data.selected_target.hwnd, "810");
  await assert.rejects(direct({ ...stateScope, status: "cancelled" }, shot), noSelection);
  await assert.rejects(direct(stateScope, shot), noSelection);
  mark("Goal record cancellation does not gate queued input; later scope changes require a fresh target");

  const nativeFailureConversation = "native-helper-failure-" + crypto.randomUUID();
  const nativeFailureGoal = data(await call(second, nativeFailureConversation,
    createGoal("Native helper failure remains uncertain"), "goal")).goal;
  data(await call(second, nativeFailureConversation, selection("911")));
  const beforeNativeFailure = helperEvents.length;
  assertToolError(await call(second, nativeFailureConversation, { action: "type", text: nativeFailureText }), /after helper dispatch/);
  assert.ok(helperEvents.slice(beforeNativeFailure).some(event => event.phase === "start" && event.action === "type"));
  assert.deepEqual(await inspectGoalAdmission(workspace, nativeFailureGoal.id), []);
  const afterNativeFailure = helperEvents.length;
  assert.equal(data(await call(second, nativeFailureConversation, selection("912"))).selected_target.hwnd, "912");
  assert.equal(helperEvents.length, afterNativeFailure + 2, "an unrelated selection dispatches once");
  mark("native helper failures stay observable without a global Goal gate on unrelated actions");

  let originalProofError;
  let originalProofScope;
  async function proofCase(label, execute, options = {}) {
    const conversation = "proof-case-" + label + "-" + crypto.randomUUID();
    const goal = data(await call(second, conversation, createGoal("Proof boundary " + label), "goal")).goal;
    const session = conversationSessionIdFromMeta({ "openai/session": conversation });
    const registry = new EffectiveToolRegistry("full");
    const toolName = options.toolName ?? "computer_use";
    let invocationId;
    const definition = registry.prepare(toolName, { inputSchema: {}, annotations: { readOnlyHint: false } }, async (...args) => {
      const scope = getRuntimeScope();
      assert.equal(scope.goalId, goal.id, label + ": fixture did not bind its real Goal");
      assert.equal(scope.mcpSessionId, session);
      assert.equal(scope.goalOwnerSessionId, session);
      invocationId = scope.invocationId;
      return execute(...args);
    });
    assert.ok(definition);
    registry.register(options.source ? { ...definition, source: options.source } : definition);
    const traces = [];
    let failureCalls = 0;
    const gateway = new InvocationGateway(registry, { workspaceRoot: workspace, projectRoots: [workspace], principalId: runtimePrincipalId(workspace) }, {
      onFailure: async (context, error) => {
        failureCalls += 1;
        await options.onFailure?.(context, error);
      },
      trace: async record => { traces.push(record); await options.trace?.(record); },
    });
    const activityEvents = [];
    const unsubscribe = subscribeActivity(entry => {
      if (entry.kind === "tool" && entry.status === "error" && entry.details?.canonical_lifecycle &&
          entry.details.invocation_id === invocationId) {
        activityEvents.push(entry);
        options.activity?.(entry);
      }
    });
    let result;
    let failure;
    const requestId = "cu-proof-" + crypto.randomUUID();
    const extra = { sessionId: session, requestId, signal: new AbortController().signal, _meta: {"openai/session":conversation} };
    let outcome;
    await runWithMcpRequestIdentity(undefined, session, async () => {
      try { result = await gateway.invoke(toolName, [{ ...shot, _intent: intent }, extra]); }
      catch (error) { failure = error; }
      finally { unsubscribe(); }
      outcome = consumeMcpOutcome(requestId, toolName);
      assert.equal(consumeMcpOutcome(requestId, toolName), undefined, label + ": duplicate MCP outcome");
    }, {params:{_meta:extra._meta}});
    assert.ok(outcome, label + ": missing consumable MCP outcome");
    assert.equal(consumeMcpOutcome(requestId, toolName), undefined, label + ": duplicate MCP outcome");
    assert.equal(outcome.invocation_id, invocationId);
    assert.equal(outcome.tool_result_status, "error");
    assert.equal(failureCalls, 1, label + ": failure hook was skipped or repeated");
    const trace = traces.findLast(record => record.status === "failure");
    assert.ok(trace, label + ": missing failure trace");
    assert.equal(trace.handlerEntered, true);
    assert.equal(trace.handlerReturned, false);
    const reservations = await inspectGoalAdmission(workspace, goal.id);
    if (options.settled) {
      assert.equal(failure, undefined);
      assertToolError(result);
      assert.equal(result.structuredContent.data.operation_started, false);
      assert.equal(result.structuredContent.data.reconciliation_needed, false);
      assert.equal(outcome.rpc_result_status, "success");
      assert.equal(outcome.failure.operation_started, false);
      // Trace observers precede final proof validation and stay conservative.
      assert.equal(trace.postprocessingCompleted, false);
      assert.equal(trace.reconciliationNeeded, true);
      assert.deepEqual(reservations, []);
    } else {
      assert.equal(result, undefined, label + ": untrusted failure was converted to a settled rejection");
      assert.ok(failure, label + ": failure unexpectedly succeeded");
      if (options.expectedError) assert.equal(failure, options.expectedError);
      assert.equal(trace.reconciliationNeeded, true);
      assert.deepEqual(reservations, [], label + ": obsolete Goal reservations must not return");
      assert.equal(outcome.rpc_result_status, "error");
      assert.notEqual(outcome.failure.operation_started, false);
      assert.notEqual(activityEvents.at(-1).details.operation_started, false,
        label + ": final canonical activity misreported dispatch as not started");
    }
    if (options.activityCount) assert.equal(activityEvents.length, options.activityCount);
  }

  await proofCase("current-local-rejection", async () => {
    try { return await new ComputerUseProvider().execute(shot); }
    catch (error) {
      originalProofError = error;
      originalProofScope = getRuntimeScope();
      assert.equal(hasNativePreDispatchFailure(originalProofScope, error), true);
      throw error;
    }
  }, { settled: true });
  await proofCase("replayed-error", async () => {
    assert.notEqual(getRuntimeScope(), originalProofScope);
    assert.equal(hasNativePreDispatchFailure(getRuntimeScope(), originalProofError), false);
    throw originalProofError;
  }, { expectedError: originalProofError });
  const fakeDiagnostic = Object.assign(new Error("Synthetic not-started fields are not a proof"), {
    operation_started: false, error_code: "COMPUTER_USE_NOT_DISPATCHED", reconciliation_needed: false,
  });
  await proofCase("plain-error-fields", async () => { throw fakeDiagnostic; }, { expectedError: fakeDiagnostic });
  const fakeMcpError = { isError: true, content: [{ type: "text", text: "operation_started=false" }],
    structuredContent: { ok: false, data: { operation_started: false, error_code: "COMPUTER_USE_NOT_DISPATCHED" } } };
  await proofCase("mcp-error-fields", async () => { throw fakeMcpError; }, { expectedError: fakeMcpError });
  const hookFailure = new Error("Owned failure hook rejected");
  await proofCase("failure-hook-error", () => new ComputerUseProvider().execute(shot), {
    onFailure: () => { throw hookFailure; }, expectedError: hookFailure,
  });
  await proofCase("failure-hook-dispatch", () => new ComputerUseProvider().execute(shot), {
    onFailure: () => new ComputerUseProvider().execute(selection("913")),
  });
  await proofCase("failure-trace-dispatch", () => new ComputerUseProvider().execute(shot), {
    trace: record => {
      if (record.status === "failure") {
        markNativeDispatchStarted();
        throw new Error("Diagnostic observer failed after dispatch");
      }
    },
  });
  await proofCase("activity-listener-dispatch", () => new ComputerUseProvider().execute(shot), {
    activity: () => { markNativeDispatchStarted(); throw new Error("Activity listener failed after dispatch"); },
    activityCount: 2,
  });
  await proofCase("same-invocation-dispatch-is-sticky", async () => {
    const provider = new ComputerUseProvider();
    let rejected;
    try { await provider.execute(shot); } catch (error) { rejected = error; }
    assert.equal(hasNativePreDispatchFailure(getRuntimeScope(), rejected), true);
    await provider.execute(selection("914"));
    assert.equal(hasNativePreDispatchFailure(getRuntimeScope(), rejected), false);
    throw rejected;
  });
  await proofCase("other-native-tool", () => new ComputerUseProvider().execute(shot), { toolName: "cu_other_native_fixture" });
  await proofCase("upstream-source", () => new ComputerUseProvider().execute(shot), { source: "upstream" });
  mark("only current native Computer Use pre-dispatch proof settles after a successful non-dispatching failure hook");

  afterVersions = await captureVersions();
  assert.deepEqual(afterVersions, beforeVersions, "verified source/test/compiled modules changed during execution");
  mark("source, test and compiled file hashes remain stable during verification");
} catch (error) {
  failed = error;
} finally {
  for (const gate of gates.values()) gate.released.resolve();
  for (const entry of connections) await closeConnection(entry);
  if (providerPrototype) {
    providerPrototype.validateCapability = originalValidate;
    providerPrototype.runHelper = originalHelper;
    providerPrototype.execute = originalExecute;
  }
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}

const report = {
  schema_version: 1, complete: true, passed: !failed, native_helper_mocked: true,
  started_at: startedAt, finished_at: new Date().toISOString(),
  cwd: process.cwd(), command: "node scripts/test-computer-use-session-persistence.mjs",
  checks, helper_dispatch_count: helperEvents.filter(event => event.phase === "start").length,
  source_before: beforeVersions ?? null, source_after: afterVersions ?? null,
  ...(failed ? { error: { name: failed.name, message: failed.message, stack: failed.stack } } : {}),
};
if (reportFile) {
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
}
console.log("COMPUTER_USE_SESSION_PERSISTENCE_RESULT " + JSON.stringify({
  schema_version: 1, complete: true, passed: !failed, checks,
  native_helper_mocked: true, helper_dispatch_count: report.helper_dispatch_count,
  ...(failed ? { error: failed.message } : {}),
}));
if (failed) throw failed;
