import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const self = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(self), "..");
const dist = path.resolve(process.argv[2] || path.join(repo, "dist"));
const worker = process.argv[3] === "--worker" ? process.argv[4] : null;
const root = worker ? path.resolve(process.argv[5]) : await fs.mkdtemp(path.join(os.tmpdir(), "wh-managed-effect-"));
process.env.CODEX_HOME = path.join(root, "state");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.jsonl");
process.env.HARNESS_ACCOUNT_ID = "isolated-managed-process-effect";
process.env.CHATGPT_TOOL_PROFILE = "full";
process.env.HARNESS_RELAY_ENABLED = "false";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_ENABLED = "false";
process.env.GOAL_WATCHDOG_ENABLED = "false";
const load = (name) => import(pathToFileURL(path.join(dist, name)).href);
const effects = await load("lib/goal-effect-scope.js");
const control = await load("lib/process-control.js");
const journal = await load("lib/process-journal.js");
const { createMcpServer } = await load("server-factory.js");
const { createGoal } = await load("lib/goals.js");
const { goalStateStore } = await load("lib/goal-state-store.js");
const { createRuntimeScope, runWithRuntimeScope, getRuntimeScope } = await load("lib/runtime-scope.js");
const session = "managed-process-effect-fixture";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const inSession = (workspace, operation) => runWithRuntimeScope(createRuntimeScope(
  { workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId: session }), operation);
const goalInput = objective => ({ objective, success_criteria: [{ name: objective + " verified", passed: false }] });
const newGoal = (workspace, objective) => inSession(workspace, () => createGoal(workspace, goalInput(objective)));
const intent = JSON.stringify({ intent_revision: 1, objective: "Exercise isolated managed process effect lifecycle",
  scope: ["temporary fixture account and processes"], out_of_scope: ["live runtime and historical operations"],
  deliverables: ["native process lifecycle assertions"], success_criteria: ["trusted completion releases only its reservation"],
  constraints: [], protected_resources: [], known_facts: ["all fixtures belong to this test"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [], closure_items: [],
  ambiguities: [], clarification_round: 0, questions_in_round: 0, resolution_mode: "none" });
const okData = result => {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent || result));
  return result.structuredContent.data;
};
// Recovered status can report PID disappearance before its earlier host-state
// snapshot contains an exit result. That observation is not a known terminal.
const knownTerminal = value => value?.running === false &&
  (Number.isInteger(value.exit_code) || (typeof value.signal === "string" && value.signal.length > 0));
async function until(operation, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await operation();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("Timed out: " + label);
    await delay(20);
  }
}
async function exists(file) { try { await fs.stat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
function pathsFor(workspace, goal, token) {
  const hash = createHash("sha256").update(goal).digest("hex");
  const shard = goalStateStore.goalShardDir(workspace);
  return {
    record: path.join(shard, "goal-effect-admission-v1", hash, "effect-" + token + ".json"),
    receipt: path.join(shard, "goal-effect-terminals-v1", hash, token + ".json"),
  };
}
const children = [];
function spawnObserved(script, args, cwd, options = {}) {
  const child = spawn(process.execPath, [script, ...args], { cwd, env: { ...process.env }, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  child.stdout?.on("data", value => { output += value.toString(); });
  child.stderr?.on("data", value => { output += value.toString(); });
  const result = { child, get output() { return output; }, done: null, closed: false };
  result.done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { result.closed = true; resolve(code); });
  });
  children.push(result);
  return result;
}
function spawnWorker(mode, workspace) {
  return spawnObserved(self, [dist, "--worker", mode, root, workspace], repo);
}
async function passedWorker(mode, workspace) {
  const task = spawnWorker(mode, workspace);
  const code = await task.done;
  assert.equal(code, 0, mode + ": " + task.output.slice(-8000));
}
async function makeClient(workspace) {
  const server = createMcpServer(workspace, 30_000, [workspace], true);
  const client = new Client({ name: "managed-process-effect-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  st.sessionId = session;
  await server.connect(st);
  await client.connect(ct);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const call = (client, name, args = {}) => client.callTool({
  name, arguments: ["start_process", "write_file", "stop_process"].includes(name) ? { ...args, _intent: intent } : args,
});
async function writeChild(workspace, { fast = false, exitCode = 0 } = {}) {
  const source = [
    'import fs from "node:fs";',
    'fs.appendFileSync("launch-count.txt","x");',
    'fs.writeFileSync("child-pid.txt",String(process.pid));',
    'console.log("READY");',
    fast ? "process.exit(" + exitCode + ");" :
      'const timer=setInterval(()=>{if(fs.existsSync("finish.txt")){clearInterval(timer);process.exit(' + exitCode + ');}},20);',
    'setTimeout(()=>process.exit(98),20000).unref();',
  ].join("\n");
  await fs.writeFile(path.join(workspace, "child.mjs"), source);
}
async function directStart(workspace, goal, { fast = false, exitCode = 0, crashAfterReceipt = false, detached = false, lease } = {}) {
  await writeChild(workspace, { fast, exitCode });
  const parent = lease || await effects.enterGoalEffect(workspace, goal.id, session);
  const id = "fixture_" + Math.random().toString(36).slice(2);
  const launch = await parent.prepareManagedProcess(id, journal.processCommandHash("fixture-child"));
  const paths = control.processControlPaths(workspace, id);
  const spec = { version: 1, id, shell: process.execPath, args: [path.join(workspace, "child.mjs")], cwd: workspace,
    full_output_path: path.join(workspace, "combined.log"), stdout_path: paths.stdout, stderr_path: paths.stderr,
    state_path: paths.state, control_dir: paths.controlDir, goal_effect: launch };
  await control.writeProcessHostSpec(paths.spec, spec);
  let script = path.join(dist, "process-host.js");
  if (crashAfterReceipt) {
    const file = pathsFor(workspace, goal.id, launch.effect_token).record;
    script = path.join(workspace, "crash-host.mjs");
    await fs.writeFile(script, [
      'import fs from "node:fs/promises";',
      "const original=fs.unlink;",
      "fs.unlink=async function(file){if(String(file)===" + JSON.stringify(file) + ")process.exit(73);return original.call(this,file);};",
      "await import(" + JSON.stringify(pathToFileURL(path.join(dist, "process-host.js")).href) + ");",
    ].join("\n"));
  }
  const log = detached ? await fs.open(path.join(workspace, "detached-host.log"), "w") : null;
  const host = spawnObserved(script, [paths.spec], workspace,
    detached ? { detached: true, stdio: ["ignore", log.fd, log.fd] } : {});
  if (detached) { host.child.unref(); await log.close(); }
  return { parent, launch, paths, spec, host, workspace, goal };
}
async function acknowledge(item) {
  const state = await control.waitForProcessHostState(item.paths.state, 10_000);
  await item.parent.confirmManagedProcess(item.launch, item.host.child.pid);
  assert.equal(state.host_pid, item.host.child.pid);
  assert.equal(await exists(item.paths.spec), false, "private spec must be consumed before child launch");
  return state;
}
async function releaseChild(item) {
  await fs.writeFile(path.join(item.workspace, "finish.txt"), "finish");
  return item.host.done;
}
async function makeCase(name) {
  const workspace = path.join(root, name);
  await fs.mkdir(workspace);
  return { workspace, goal: await newGoal(workspace, name) };
}

if (worker) {
  const workspace = path.resolve(process.argv[6]);
  if (worker === "native-start") {
    const goal = await newGoal(workspace, "native restart");
    const connection = await makeClient(workspace);
    try {
      const result = await call(connection.client, "start_process", { command: "node child.mjs", working_directory: workspace });
      const started = okData(result);
      assert.doesNotMatch(JSON.stringify(result), /receipt_key|prepared_process|goal_effect/);
      await fs.writeFile(path.join(workspace, "native.json"), JSON.stringify({ ...started, goal_id: goal.id }));
      const active = await effects.inspectGoalAdmission(workspace, goal.id);
      assert.equal(active.length, 1, "successful submission must leave exactly the managed reservation");
      assert.ok(active[0].managed_process);
    } finally { await connection.close(); }
  } else if (worker === "native-finish") {
    const original = JSON.parse(await fs.readFile(path.join(workspace, "native.json"), "utf8"));
    const connection = await makeClient(workspace);
    try {
      const state = okData(await call(connection.client, "process_status", { id: original.id })).processes[0];
      assert.equal(state.recovered, true);
      assert.equal(state.running, true);
      okData(await call(connection.client, "write_file", { path: path.join(workspace, "while-running.txt"), content: "allowed" }));
      await assert.rejects(newGoal(workspace, "must wait"), /GOAL_CREATION_EFFECT_BUSY/);
      // Force the real recovered-status interleaving seen in the complete suite:
      // snapshot running state, let the child close and its host commit terminal
      // state, then finish the OS identity probe against the earlier snapshot.
      const record = await journal.getProcessJournalRecord(workspace, original.id);
      const readFile = fs.readFile;
      let armed = true, staleObservation;
      fs.readFile = async function(file, ...args) {
        const value = await readFile.call(this, file, ...args);
        if (armed && String(file) === record.state_path && JSON.parse(String(value)).running === true) {
          armed = false;
          okData(await call(connection.client, "write_file", { path: path.join(workspace, "finish.txt"), content: "finish" }));
          await until(async () => JSON.parse(await readFile(record.state_path, "utf8")).running === false,
            "host terminal commit behind status snapshot");
        }
        return value;
      };
      try {
        staleObservation = okData(await call(connection.client, "process_status", { id: original.id })).processes[0];
      } finally { fs.readFile = readFile; }
      assert.equal(armed, false, "the controlled status race must execute");
      assert.equal(staleObservation.running, false);
      assert.equal(staleObservation.exit_code, null);
      assert.equal(staleObservation.signal, null);
      assert.equal(knownTerminal(staleObservation), false, "PID disappearance cannot satisfy the terminal wait");
      const terminal = await until(async () => {
        const value = okData(await call(connection.client, "process_status", { id: original.id })).processes[0];
        return knownTerminal(value) ? value : null;
      }, "native recovered terminal");
      assert.equal(terminal.exit_code, 0);
      okData(await call(connection.client, "write_file", { path: path.join(workspace, "after-finish.txt"), content: "allowed" }));
      const next = await newGoal(workspace, "replacement after trusted close");
      assert.notEqual(next.id, original.goal_id);
      assert.equal(await fs.readFile(path.join(workspace, "launch-count.txt"), "utf8"), "x");
    } finally { await connection.close(); }
  } else if (worker === "reconcile") {
    const info = JSON.parse(await fs.readFile(path.join(workspace, "recovery.json"), "utf8"));
    const release = await effects.enterGoalEffect(workspace, info.goal, session);
    await release("settled");
  } else if (worker === "orphan-parent") {
    const info = JSON.parse(await fs.readFile(path.join(workspace, "recovery.json"), "utf8"));
    const item = await directStart(workspace, { id: info.goal }, { detached: true });
    await acknowledge(item);
    await fs.writeFile(path.join(workspace, "orphan.json"), JSON.stringify({
      token: item.launch.effect_token, parent: item.launch.parent_effect_token, state: item.paths.state,
    }));
    // Simulate a submitter dying after handoff, before finishing its own hooks/release.
    process.exit(0);
  } else throw new Error("Unknown worker mode");
  process.exit(0);
}

const results = [];
async function check(name, run) { await run(); results.push({ name, passed: true }); console.log("PASS " + name); }
try {
  await check("real MCP restart retains live ownership and permits mutation; trusted close permits replacement", async () => {
    const workspace = path.join(root, "native");
    await fs.mkdir(workspace);
    await writeChild(workspace);
    await passedWorker("native-start", workspace);
    await passedWorker("native-finish", workspace);
  });

  await check("fast child close before ACK and duplicate launch remain one-shot", async () => {
    const { workspace, goal } = await makeCase("fast");
    const item = await directStart(workspace, goal, { fast: true, exitCode: 7 });
    assert.equal(await item.host.done, 0, item.host.output);
    assert.equal((await control.readProcessHostState(item.paths.state)).exit_code, 7);
    const records = await effects.inspectGoalAdmission(workspace, goal.id);
    assert.equal(records.length, 1, "only the unfinished parent remains after fast child close");
    assert.equal(records[0].token, item.launch.parent_effect_token);
    await assert.rejects(newGoal(workspace, "too early"), /GOAL_CREATION_EFFECT_BUSY/);
    await item.parent.confirmManagedProcess(item.launch, item.host.child.pid);
    await assert.rejects(effects.claimManagedProcessEffect(item.launch, "fixture-host-identity"), /GOAL_PROCESS_EFFECT_ALREADY_FINISHED/);
    assert.equal(await fs.readFile(path.join(workspace, "launch-count.txt"), "utf8"), "x");
    assert.ok(!item.host.output.includes(item.launch.receipt_key));
    await item.parent("settled");
    await newGoal(workspace, "after exact parent finish");
  });

  await check("same prepared launch cannot be claimed by two real hosts", async () => {
    const { workspace, goal } = await makeCase("duplicate");
    const item = await directStart(workspace, goal);
    const secondSpec = path.join(workspace, "second-spec.json");
    await control.writeProcessHostSpec(secondSpec, item.spec);
    const other = spawnObserved(path.join(dist, "process-host.js"), [secondSpec], workspace);
    const state = await control.waitForProcessHostState(item.paths.state, 10_000);
    const winner = state.host_pid === item.host.child.pid ? item.host : other;
    const loser = winner === item.host ? other : item.host;
    assert.notEqual(await loser.done, 0);
    await item.parent.confirmManagedProcess(item.launch, winner.child.pid);
    await item.parent("settled");
    await fs.writeFile(path.join(workspace, "finish.txt"), "finish");
    assert.equal(await winner.done, 0, winner.output);
    assert.equal(await fs.readFile(path.join(workspace, "launch-count.txt"), "utf8"), "x");
    assert.ok(!winner.output.includes(item.launch.receipt_key) && !loser.output.includes(item.launch.receipt_key));
    await newGoal(workspace, "after single execution");
  });

  await check("receipt write failure leaves uncertain effect despite displayed child close", async () => {
    const { workspace, goal } = await makeCase("receipt-failure");
    const item = await directStart(workspace, goal);
    await acknowledge(item);
    await item.parent("settled");
    const paths = pathsFor(workspace, goal.id, item.launch.effect_token);
    await fs.mkdir(paths.receipt, { recursive: true }); // Real publication failure, after a successful claim.
    assert.notEqual(await releaseChild(item), 0);
    assert.equal((await control.readProcessHostState(item.paths.state)).running, false);
    await effects.reconcileManagedProcessEffect(workspace, goal.id, session, item.launch.effect_token);
    assert.equal(await exists(paths.record), true);
    await assert.rejects(effects.enterGoalEffect(workspace, goal.id, session), /GOAL_EFFECT_RECONCILIATION_REQUIRED/);
    await assert.rejects(newGoal(workspace, "must remain blocked"), /GOAL_CREATION_EFFECT_BUSY/);
    assert.ok(!item.host.output.includes(item.launch.receipt_key));
  });

  await check("host crash after durable receipt recovers across processes; mismatched proof never settles", async () => {
    const { workspace, goal } = await makeCase("receipt-recovery");
    const item = await directStart(workspace, goal, { crashAfterReceipt: true });
    await acknowledge(item);
    await item.parent("settled");
    assert.equal(await releaseChild(item), 73);
    const paths = pathsFor(workspace, goal.id, item.launch.effect_token);
    const original = await fs.readFile(paths.receipt, "utf8");
    const receipt = JSON.parse(original);
    assert.equal(await exists(paths.record), true);
    const variants = [
      { owner_session_id: "wrong-owner" }, { launch_id: "00000000-0000-4000-8000-000000000001" },
      { parent_effect_token: "00000000-0000-4000-8000-000000000002" },
      { host_start_identity: "reused-host-pid" }, { child_pid: receipt.child_pid + 1 }, { receipt_key: "0".repeat(64) },
    ];
    for (const fields of variants) {
      await fs.writeFile(paths.receipt, JSON.stringify({ ...receipt, ...fields }));
      await effects.reconcileManagedProcessEffect(workspace, goal.id, session, item.launch.effect_token);
      assert.equal(await exists(paths.record), true, "mismatched terminal proof released its reservation");
    }
    await fs.writeFile(paths.receipt, original);
    await effects.reconcileManagedProcessEffect(workspace, goal.id, "wrong-owner", item.launch.effect_token);
    assert.equal(await exists(paths.record), true);
    await fs.writeFile(path.join(workspace, "recovery.json"), JSON.stringify({ goal: goal.id }));
    await Promise.all([passedWorker("reconcile", workspace), passedWorker("reconcile", workspace)]);
    assert.equal(await exists(paths.record), false);
    assert.equal(await fs.readFile(paths.receipt, "utf8"), original, "reconciliation must preserve the one-shot tombstone");
    await effects.reconcileManagedProcessEffect(workspace, goal.id, session, item.launch.effect_token);
    await newGoal(workspace, "after cross-process recovery");
  });

  await check("host disappearance without receipt is not completion even after child PID disappears", async () => {
    const { workspace, goal } = await makeCase("host-gone");
    const item = await directStart(workspace, goal);
    const state = await acknowledge(item);
    await item.parent("settled");
    item.host.child.kill("SIGKILL"); // This exact ChildProcess was spawned by this fixture.
    await item.host.done;
    await fs.writeFile(path.join(workspace, "finish.txt"), "finish");
    await until(async () => await journal.readProcessStartIdentity(state.child_pid) !== state.child_start_identity, "own child exits");
    const paths = pathsFor(workspace, goal.id, item.launch.effect_token);
    assert.equal(await exists(paths.receipt), false);
    await effects.reconcileManagedProcessEffect(workspace, goal.id, session, item.launch.effect_token);
    assert.equal(await exists(paths.record), true);
    await assert.rejects(effects.enterGoalEffect(workspace, goal.id, session), /GOAL_EFFECT_RECONCILIATION_REQUIRED/);
    await assert.rejects(newGoal(workspace, "PID gone is not proof"), /GOAL_CREATION_EFFECT_BUSY/);
  });

  await check("submitter crash after handoff does not let child receipt settle the unfinished parent", async () => {
    const { workspace, goal } = await makeCase("parent-gone");
    await fs.writeFile(path.join(workspace, "recovery.json"), JSON.stringify({ goal: goal.id }));
    await passedWorker("orphan-parent", workspace);
    const info = JSON.parse(await fs.readFile(path.join(workspace, "orphan.json"), "utf8"));
    await fs.writeFile(path.join(workspace, "finish.txt"), "finish");
    await until(async () => (await control.readProcessHostState(info.state))?.running === false, "orphan child close")
      .catch(async error => { error.message += "\n" + await fs.readFile(path.join(workspace, "detached-host.log"), "utf8"); throw error; });
    await effects.reconcileManagedProcessEffect(workspace, goal.id, session, info.token);
    const records = await effects.inspectGoalAdmission(workspace, goal.id);
    assert.equal(records.length, 1);
    assert.equal(records[0].token, info.parent);
    await assert.rejects(effects.enterGoalEffect(workspace, goal.id, session), /GOAL_EFFECT_RECONCILIATION_REQUIRED/);
    await assert.rejects(newGoal(workspace, "parent still uncertain"), /GOAL_CREATION_EFFECT_BUSY/);
  });

  await check("prepare and child binding are atomic one-shot transitions", async () => {
    const { workspace, goal } = await makeCase("concurrent-binding");
    const parent = await effects.enterGoalEffect(workspace, goal.id, session);
    const attempts = await Promise.allSettled([
      parent.prepareManagedProcess("one", "1".repeat(64)), parent.prepareManagedProcess("two", "2".repeat(64)),
    ]);
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    const launch = attempts.find(result => result.status === "fulfilled").value;
    const lease = await effects.claimManagedProcessEffect(launch, "fixture-known-host");
    const bindings = await Promise.allSettled([lease.bindChild(11, null), lease.bindChild(12, "different")]);
    assert.equal(bindings.filter(result => result.status === "fulfilled").length, 1);
    // No real child close occurred: retain the isolated uncertain record and close only endpoints.
    await lease.abandon();
    await parent("uncertain");
  });

  await check("a replay waiting for admission cannot revive an orphan challenge endpoint", async () => {
    const { workspace, goal } = await makeCase("orphan-replay");
    const parent = await effects.enterGoalEffect(workspace, goal.id, session);
    const launch = await parent.prepareManagedProcess("orphan", "3".repeat(64));
    const managed = await effects.claimManagedProcessEffect(launch, "fixture-known-host");
    await managed.bindChild(13, null);
    await managed.abandon();
    const records = await effects.inspectGoalAdmission(workspace, goal.id);
    const orphan = records.find(record => record.token === launch.effect_token);
    const { withCanonicalFileLock } = await load("lib/safe-text-write.js");
    const directory = path.dirname(pathsFor(workspace, goal.id, launch.effect_token).record);
    const target = directory + ".mutex";
    const canonical = process.platform === "win32" ? target.toLowerCase() : target;
    const lockPath = path.join(path.dirname(target), ".cas-" + createHash("sha256").update(canonical).digest("hex") + ".lock");
    let acquired, unlock, attempted;
    const entered = new Promise(resolve => { acquired = resolve; });
    const gate = new Promise(resolve => { unlock = resolve; });
    const lockAttempted = new Promise(resolve => { attempted = resolve; });
    const holder = withCanonicalFileLock(target, async () => { acquired(); await gate; });
    await entered;
    const originalOpen = fs.open, originalListen = net.Server.prototype.listen;
    let endpointAttempts = 0;
    fs.open = async function(file, ...args) {
      if (String(file) === lockPath && args[0] === "wx") attempted();
      return originalOpen.call(this, file, ...args);
    };
    net.Server.prototype.listen = function(endpoint, ...args) {
      if (endpoint === orphan.endpoint) endpointAttempts++;
      return originalListen.call(this, endpoint, ...args);
    };
    const replay = effects.claimManagedProcessEffect(launch, "fixture-replayed-host");
    const rejected = assert.rejects(replay, /GOAL_PROCESS_EFFECT_CLAIM_CONFLICT/);
    try {
      await Promise.race([lockAttempted, delay(5000).then(() => { throw new Error("replay did not reach admission mutex"); })]);
      assert.equal(endpointAttempts, 0, "a rejected replay revived the original live challenge");
    } finally {
      fs.open = originalOpen;
      net.Server.prototype.listen = originalListen;
      unlock();
      await holder;
      await rejected;
      await parent("uncertain");
    }
    await assert.rejects(effects.enterGoalEffect(workspace, goal.id, session), /GOAL_EFFECT_RECONCILIATION_REQUIRED/);
  });

  await check("gateway keeps parent reservation through all success hooks after background handoff", async () => {
    const { workspace, goal } = await makeCase("hooks");
    const { EffectiveToolRegistry } = await load("lib/effective-tool-registry.js");
    const { InvocationGateway } = await load("lib/invocation-gateway.js");
    const registry = new EffectiveToolRegistry("full");
    let item, entered, release;
    const atHook = new Promise(resolve => { entered = resolve; });
    const hookGate = new Promise(resolve => { release = resolve; });
    registry.register(registry.prepare("start_process", { inputSchema: {}, annotations: { readOnlyHint: false } }, async () => {
      assert.ok(getRuntimeScope().goalEffectLease, "the fixture must execute under a real gateway Goal reservation");
      item = await directStart(workspace, goal, { fast: true, lease: getRuntimeScope().goalEffectLease });
      await acknowledge(item);
      return { content: [{ type: "text", text: "started fixture" }],
        structuredContent: { ok: true, tool: "start_process", summary: "started", data: { id: item.launch.process_id } } };
    }));
    const gateway = new InvocationGateway(registry, { workspaceRoot: workspace, projectRoots: [workspace] }, {
      onSuccess: async (_context, result) => { entered(); await hookGate; return result; },
    });
    const invocation = gateway.invoke("start_process", [{ _intent: intent },
      { sessionId: session, requestId: 1, signal: new AbortController().signal }]);
    await Promise.race([atHook, invocation.then(() => { throw new Error("hook was not reached"); })]);
    try {
      assert.equal(await item.host.done, 0, item.host.output);
      await assert.rejects(newGoal(workspace, "hooks still pending"), /GOAL_CREATION_EFFECT_BUSY/);
    } finally { release(); }
    assert.equal((await invocation).structuredContent.ok, true);
    await newGoal(workspace, "hooks have completed");
  });

  console.log(JSON.stringify({ suite: "managed-process-effect", passed: results.length, results }, null, 2));
} finally {
  // These are only processes and directories created by this fixture.
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory() && entry.name !== "state") {
    await fs.writeFile(path.join(root, entry.name, "finish.txt"), "cleanup").catch(() => undefined);
  }
  for (const task of children) {
    if (!task.closed) await Promise.race([task.done, delay(5000)]);
    if (!task.closed) { task.child.kill("SIGKILL"); await task.done; }
  }
  for (let attempt = 0; ; attempt++) {
    try { await fs.rm(root, { recursive: true, force: true }); break; }
    catch (error) { if (attempt >= 100 || !["EPERM", "EBUSY", "ENOTEMPTY"].includes(error.code)) throw error; await delay(50); }
  }
}
