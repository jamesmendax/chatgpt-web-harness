import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const dist = path.resolve(process.argv[2] || "dist");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wh-managed-v32-"));
process.env.CODEX_HOME = path.join(root, "state");
process.env.MCP_SHELL_STATE_DIR = path.join(root, "shell");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.jsonl");
process.env.CHATGPT_TOOL_PROFILE = "full";
process.env.GOAL_WATCHDOG_ENABLED = "false";
const load = file => import(pathToFileURL(path.join(dist, file)).href);
const { registerShellTools } = await load("tools/shell.js");
const { EffectiveToolRegistry } = await load("lib/effective-tool-registry.js");
const { InvocationGateway } = await load("lib/invocation-gateway.js");
const { processControlPaths, readProcessHostState } = await load("lib/process-control.js");
const { createRuntimeScope, runWithRuntimeScope } = await load("lib/runtime-scope.js");
const { setDefaultCwd, setAllowedRoots, setFullDiskAccess } = await load("lib/path-security.js");
const { createGoal } = await load("lib/goals.js");
setDefaultCwd(root); setAllowedRoots([root]); setFullDiskAccess(false);
const registry = new EffectiveToolRegistry("full");
registerShellTools({ registerTool(name, config, handler) {
  registry.register(name, config, args => handler(z.object(config.inputSchema).parse(args)));
} }, root, 20);
const gateway = new InvocationGateway(registry, { workspaceRoot: root, projectRoots: [root], fallbackSessionId: "fixture-session" });
let request = 0;
const invoke = (name, args, operation) => gateway.invoke(name, [args, {
  sessionId: "fixture-session", requestId: ++request, signal: new AbortController().signal,
  ...(operation ? { _meta: { "local-coder/operation-id": operation } } : {}),
}]);
const data = result => {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.data;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(40); }
  throw new Error("Timed out: " + label);
}
const child = path.join(root, "child.mjs");
const ids = [];
try {
  await fs.writeFile(child, [
    'import fs from "node:fs";',
    'fs.appendFileSync("launch-count.txt", "x");',
    'console.log("READY");',
    'const timer=setInterval(()=>{if(fs.existsSync("finish.txt")){clearInterval(timer);process.exit(0)}},30);',
    'setTimeout(()=>process.exit(99),20000).unref();',
  ].join("\n"));
  const args = { executable: process.execPath, args: [child], working_directory: root };
  const first = data(await invoke("start_process", args, "launch-one"));
  ids.push(first.id);
  assert.equal(first.execution_mode, "argv");
  await until(async () => (await fs.readFile(path.join(root, "launch-count.txt"), "utf8").catch(() => "")) === "x", "first launch");
  const replay = data(await invoke("start_process", args, "launch-one"));
  assert.equal(replay.id, first.id, "the same operation must return the original receipt");
  assert.equal(await fs.readFile(path.join(root, "launch-count.txt"), "utf8"), "x");
  const changed = await invoke("start_process", { ...args, args: [child, "different"] }, "launch-one");
  assert.equal(changed.structuredContent?.ok, false, "reused operation ID with different arguments must fail");
  assert.equal(await fs.readFile(path.join(root, "launch-count.txt"), "utf8"), "x");

  const spec = processControlPaths(root, first.id).spec;
  await assert.rejects(fs.access(spec), /ENOENT/);
  const replayHost = spawn(process.execPath, [path.join(dist, "process-host.js"), spec], { cwd: root, windowsHide: true, stdio: "ignore" });
  const replayExit = await new Promise((resolve, reject) => { replayHost.once("error", reject); replayHost.once("close", resolve); });
  assert.notEqual(replayExit, 0, "consumed host specification cannot launch twice");
  assert.equal(await fs.readFile(path.join(root, "launch-count.txt"), "utf8"), "x");

  const second = data(await invoke("start_process", args, "launch-two"));
  ids.push(second.id); assert.notEqual(second.id, first.id);
  await until(async () => (await fs.readFile(path.join(root, "launch-count.txt"), "utf8")) === "xx", "distinct operation");
  const live = data(await invoke("process_status", { id: first.id })).processes[0];
  assert.equal(live.running, true); assert.equal(live.scope_kind, "session");
  // Simulate an ACK read failure while the real host and child continue. This
  // must report uncertainty and keep the operation receipt from replaying.
  const originalRead = fs.readFile;
  let uncertain;
  fs.readFile = async function(file, ...rest) {
    if (String(file).includes("process-control") && path.basename(String(file)) === "state.json") {
      throw Object.assign(new Error("fixture ACK unavailable"), { code: "ENOENT" });
    }
    return originalRead.call(this, file, ...rest);
  };
  try { uncertain = await invoke("start_process", args, "launch-uncertain"); }
  finally { fs.readFile = originalRead; }
  const unknown = uncertain.structuredContent?.data;
  assert.equal(uncertain.structuredContent?.ok, false);
  assert.equal(unknown.error_code, "PROCESS_HOST_START_UNKNOWN");
  assert.equal(unknown.outcome_kind, "unknown");
  assert.equal(unknown.operation_started, null); assert.equal(unknown.may_have_partially_completed, true);
  assert(unknown.id && unknown.host_pid && unknown.state_path && unknown.full_output_path);
  ids.push(unknown.id);
  const observed = await readProcessHostState(unknown.state_path);
  assert(observed && observed.running && observed.child_pid, "child exists despite unavailable ACK");
  assert.equal(await fs.readFile(path.join(root, "launch-count.txt"), "utf8"), "xxx");
  await invoke("start_process", args, "launch-uncertain");
  assert.equal(await fs.readFile(path.join(root, "launch-count.txt"), "utf8"), "xxx", "unknown operation must not launch twice");
  const scope = createRuntimeScope({ workspaceRoot: root, projectRoots: [root] }, { sessionId: "fixture-session" });
  const nextGoal = await runWithRuntimeScope(scope, () => createGoal(root, { objective: "new work while processes run", success_criteria: [{ name: "done", passed: false }] }));
  assert(nextGoal.id, "a running process cannot block an unrelated new Goal");
  await fs.writeFile(path.join(root, "finish.txt"), "finish");
  for (const id of ids) {
    const state = await until(async () => {
      const current = await readProcessHostState(processControlPaths(root, id).state);
      return current && !current.running ? current : null;
    }, "host exit");
    assert.equal(state.exit_code, 0);
  }
  assert.equal(await fs.readFile(path.join(root, "launch-count.txt"), "utf8"), "xxx");
  console.log("PASS managed process v32: exact and unknown operations never replay, consumed spec, distinct operation and Goal remain available");
} finally {
  await fs.writeFile(path.join(root, "finish.txt"), "cleanup").catch(() => undefined);
  for (const id of ids) await until(async () => {
    const state = await readProcessHostState(processControlPaths(root, id).state).catch(() => null);
    return state && !state.running;
  }, "owned process cleanup").catch(() => undefined);
  for (let i = 0; ; i++) {
    try { await fs.rm(root, { recursive: true, force: true }); break; }
    catch (error) { if (i >= 100) throw error; await delay(100); }
  }
}
