#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const self = fileURLToPath(import.meta.url);
const recoveredProbe = process.argv[2] === "--recovered-probe";
const sandbox = recoveredProbe ? process.argv[3] : await fs.mkdtemp(path.join(os.tmpdir(), "wh-process-goal-scope-"));
const previousEnv = new Map(["CODEX_HOME", "MCP_SHELL_STATE_DIR"].map((key) => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
process.env.MCP_SHELL_STATE_DIR = path.join(sandbox, "shell-state");

const {
  captureProcessScope, processScopeKind, processScopeMatches,
  upsertProcessJournalRecord, listProcessJournalRecords, getProcessJournalRecord,
} = await import("../dist/lib/process-journal.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const { withRelayGoal } = await import("../dist/lib/relay-scope.js");
const { registerShellTools } = await import("../dist/tools/shell.js");
const { bootstrapShellSession } = await import("../dist/lib/persistent-shell.js");
const { setDefaultCwd, setAllowedRoots, setFullDiskAccess } = await import("../dist/lib/path-security.js");

setDefaultCwd(sandbox);
setAllowedRoots([sandbox]);
setFullDiskAccess(false);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => process.platform === "win32" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\\''") + "'";
const commandFor = (script) => process.platform === "win32"
  ? "Write-Output 'READY'; while ($null -ne ($line = [Console]::In.ReadLine())) { Write-Output ('ECHO:' + $line); if ($line -eq 'quit') { break } }"
  : quote(process.execPath) + " " + quote(script);
const scope = (goalId, sessionId = "owner-a", root = sandbox) => Object.assign(
  createRuntimeScope({ workspaceRoot: root, projectRoots: [root] }, { sessionId }),
  goalId ? { goalId, goalOwnerSessionId: sessionId } : {},
);
const scopeA = () => scope("goal-process-a");
const scopeB = () => scope("goal-process-b", "owner-b");
const scopeSession = () => scope(undefined, "session-without-goal");

// Invoke the registered production callbacks with trusted runtime scopes.
// Gateway/transport authority is covered separately by the MCP process fixtures.
function register(root) {
  const callbacks = new Map();
  registerShellTools({
    registerTool(name, config, handler) { callbacks.set(name, { schema: z.object(config.inputSchema), handler }); },
  }, root, 5000);
  return callbacks;
}
const callbacks = register(sandbox);
await bootstrapShellSession(sandbox);
async function invoke(name, args, trustedScope, registry = callbacks) {
  const entry = registry.get(name);
  assert.ok(entry, name);
  const result = await runWithRuntimeScope(trustedScope, () => entry.handler(entry.schema.parse(args)));
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result));
  return result.structuredContent.data;
}
const deny = (name, args, trustedScope, expected = /PROCESS_OWNER_SCOPE_MISMATCH/, registry = callbacks) =>
  assert.rejects(() => invoke(name, args, trustedScope, registry), expected);
async function waitFor(id, trustedScope, predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let output;
  while (Date.now() < deadline) {
    output = await invoke("process_output", { id, output_mode: "full", tail_chars: 100000 }, trustedScope);
    if (predicate(output)) return output;
    await delay(40);
  }
  throw new Error("process output wait failed: " + JSON.stringify(output));
}
async function removeSandbox() {
  for (let attempt = 0; attempt < 600; attempt++) {
    try { await fs.rm(sandbox, { recursive: true, force: true }); return; }
    catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes(error?.code) || attempt === 599) throw error;
      await delay(100);
    }
  }
}
async function stopAndDrain(entry) {
  // The fixture child has an explicit quit protocol. Prefer graceful exit so
  // the detached process host can close stdout/stderr and release cwd handles.
  await invoke("process_input", { id: entry.id, text: "quit", append_newline: true }, entry.scope).catch(() => {});
  const deadline = Date.now() + 20_000;
  let lastReceipt = null;
  while (Date.now() < deadline) {
    lastReceipt = await invoke("stop_process", { id: entry.id, force: true }, entry.scope).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if (lastReceipt?.host_released === true) return;
    await delay(100);
  }
  throw new Error(`owned process host did not release before sandbox cleanup: ${entry.id}; last_receipt=${JSON.stringify(lastReceipt)}`);
}
const baseRecord = (id) => ({
  id, pid: 2147483000, command_hash: "fixture-hash", cwd: sandbox,
  started_at: new Date().toISOString(), process_start_identity: null,
  full_output_path: null, state: "finished", exit_code: 0, signal: null,
  updated_at: new Date().toISOString(),
});

if (recoveredProbe) {
  const id = process.argv[4];
  assert.deepEqual((await invoke("process_status", { id }, scopeB())).processes, []);
  await deny("process_output", { id }, scopeB());
  await deny("process_input", { id, text: "forbidden-recovered", append_newline: true }, scopeB());
  await deny("stop_process", { id, force: true }, scopeB());
  const successor = scope("goal-process-a", "verified-successor");
  const status = (await invoke("process_status", { id }, successor)).processes[0];
  assert.equal(status.recovered, true);
  assert.equal(status.control_available, true);
  assert.equal(status.goal_id, "goal-process-a");
  const input = await invoke("process_input", { id, text: "recovered-successor", append_newline: true }, successor);
  assert.equal(input.accepted, true);
  const output = await waitFor(id, successor, (value) => value.stdout.includes("ECHO:recovered-successor"));
  assert.equal(output.recovered, true);
  assert.ok(!output.stdout.includes("forbidden-recovered"));
  console.log("process-goal-scope recovered probe PASS");
  process.exit(0);
}

const owned = [];
try {
  const capturedA = runWithRuntimeScope(scopeA(), () => captureProcessScope(sandbox));
  assert.equal(Object.isFrozen(capturedA), true);
  assert.equal(capturedA.scope_kind, "goal");
  const spoofed = { ...baseRecord("owned-a"), scope_kind: "session", goal_id: "spoofed", owner_session_id: "spoofed" };
  await upsertProcessJournalRecord(sandbox, spoofed, capturedA);
  let record = await getProcessJournalRecord(sandbox, "owned-a");
  assert.equal(record.goal_id, "goal-process-a", "record input cannot grant ownership");
  assert.equal(record.owner_session_id, "owner-a");
  assert.equal(record.scope_kind, "goal");
  await assert.rejects(() => upsertProcessJournalRecord(sandbox, baseRecord("forged-token"), { ...capturedA }), /PROCESS_SCOPE_NOT_CAPTURED/);
  await assert.rejects(() => runWithRuntimeScope(scopeB(), () => upsertProcessJournalRecord(sandbox, baseRecord("owned-a"))), /PROCESS_OWNER_SCOPE_MISMATCH/);
  await runWithRuntimeScope(scope("goal-process-a", "verified-successor"), () => upsertProcessJournalRecord(sandbox, baseRecord("owned-a")));
  record = await getProcessJournalRecord(sandbox, "owned-a");
  assert.equal(record.owner_session_id, "owner-a", "successor updates preserve original owner provenance");

  await runWithRuntimeScope(scopeB(), () => upsertProcessJournalRecord(sandbox, baseRecord("owned-b")));
  await runWithRuntimeScope(scopeSession(), () => upsertProcessJournalRecord(sandbox, baseRecord("owned-session")));
  await upsertProcessJournalRecord(sandbox, { ...baseRecord("legacy-unknown"), owner_session_id: "owner-a", goal_id: "spoofed" });
  await runWithRuntimeScope(scopeA(), () => upsertProcessJournalRecord(sandbox, { ...baseRecord("legacy-unknown"), goal_id: "goal-process-a" }));
  const legacy = await getProcessJournalRecord(sandbox, "legacy-unknown");
  assert.equal(processScopeKind(legacy), "unknown");
  assert.equal(legacy.goal_id, null);
  assert.equal(legacy.owner_session_id, null);
  assert.equal(processScopeMatches(legacy, capturedA), false);
  assert.equal(processScopeKind({ owner_session_id: "owner-a" }), "unknown", "incidental legacy session metadata is not authority");
  assert.deepEqual((await listProcessJournalRecords(sandbox, "goal-process-a")).map((value) => value.id).sort(), ["legacy-unknown", "owned-a"]);
  assert.deepEqual((await listProcessJournalRecords(sandbox, "goal-process-b")).map((value) => value.id).sort(), ["legacy-unknown", "owned-b"]);
  assert.equal(await getProcessJournalRecord(sandbox, "owned-b", "goal-process-a"), null);
  assert.throws(() => runWithRuntimeScope(scopeA(), () => withRelayGoal(sandbox, "goal-process-b", () => captureProcessScope(sandbox))), /PROCESS_GOAL_SCOPE_MISMATCH/);
  assert.throws(() => runWithRuntimeScope(scope(undefined, "workspace-owner", path.join(sandbox, "other")), () => captureProcessScope(sandbox)), /PROCESS_WORKSPACE_SCOPE_MISMATCH/);
  const relayOnly = withRelayGoal(sandbox, "goal-relay", () => captureProcessScope(sandbox));
  assert.equal(relayOnly.goal_id, "goal-relay");
  assert.equal(relayOnly.scope_kind, "goal");

  const childPath = path.join(sandbox, "echo-child.mjs");
  await fs.writeFile(childPath, [
    'import readline from "node:readline";',
    'const rl = readline.createInterface({ input: process.stdin, terminal: false });',
    'console.log("READY");',
    'rl.on("line", line => { console.log("ECHO:" + line); if (line === "quit") process.exit(0); });',
    'setTimeout(() => process.exit(0), 300000);',
  ].join("\n"));
  const mutableInvocation = scopeA();
  // An obsolete admission callback must not block the process, and ownership
  // must still be captured synchronously before the first asynchronous step.
  mutableInvocation.beforeDispatch = async () => { throw new Error("retired effect gate called"); };
  const startPending = invoke("start_process", { command: commandFor(childPath), working_directory: sandbox }, mutableInvocation);
  mutableInvocation.goalId = "goal-process-b";
  mutableInvocation.goalOwnerSessionId = "owner-b";
  const startedA = await startPending;
  owned.push({ id: startedA.id, scope: scopeA() });
  assert.equal(startedA.goal_id, "goal-process-a", "start captures scope before first await");
  assert.equal(startedA.owner_session_id, "owner-a");
  assert.equal((await getProcessJournalRecord(sandbox, startedA.id)).goal_id, "goal-process-a");
  await waitFor(startedA.id, scopeA(), (value) => value.stdout.includes("READY"));

  assert.deepEqual((await invoke("process_status", { id: startedA.id }, scopeB())).processes, []);
  await deny("process_output", { id: startedA.id }, scopeB());
  await deny("process_input", { id: startedA.id, text: "forbidden-live", append_newline: true }, scopeB());
  await deny("stop_process", { id: startedA.id, force: true }, scopeB());
  const successor = scope("goal-process-a", "verified-successor");
  assert.equal((await invoke("process_input", { id: startedA.id, text: "same-goal-successor", append_newline: true }, successor)).accepted, true);
  const afterSuccessor = await waitFor(startedA.id, successor, (value) => value.stdout.includes("ECHO:same-goal-successor"));
  assert.ok(!afterSuccessor.stdout.includes("forbidden-live"));

  const startedSession = await invoke("start_process", { command: commandFor(childPath), working_directory: sandbox }, scopeSession());
  owned.push({ id: startedSession.id, scope: scopeSession() });
  assert.equal(startedSession.scope_kind, "session");
  assert.equal(startedSession.goal_id, null);
  assert.equal(startedSession.owner_session_id, "session-without-goal");
  await waitFor(startedSession.id, scopeSession(), (value) => value.stdout.includes("READY"));
  assert.equal((await invoke("process_input", { id: startedSession.id, text: "session-ok", append_newline: true }, scopeSession())).accepted, true);
  await waitFor(startedSession.id, scopeSession(), (value) => value.stdout.includes("ECHO:session-ok"));
  await deny("process_output", { id: startedSession.id }, scope(undefined, "another-session"));
  await deny("process_input", { id: startedSession.id, text: "forbidden-new-goal" }, scope("new-goal", "session-without-goal"));
  await deny("stop_process", { id: startedSession.id, force: true }, scopeA());
  assert.deepEqual((await invoke("process_status", { id: startedSession.id }, scopeA())).processes, []);
  await deny("start_process", { command: commandFor(childPath), working_directory: sandbox }, scope(undefined, ""), /PROCESS_SCOPE_REQUIRED/);

  const legacyStatus = (await invoke("process_status", { id: "legacy-unknown" }, scopeA())).processes[0];
  assert.equal(legacyStatus.scope_kind, "unknown");
  assert.equal(legacyStatus.control_available, false);
  await deny("process_output", { id: "legacy-unknown" }, scopeA(), /PROCESS_OWNER_UNKNOWN/);
  await deny("process_input", { id: "legacy-unknown", text: "unsafe" }, scopeA(), /PROCESS_OWNER_UNKNOWN/);
  await deny("stop_process", { id: "legacy-unknown" }, scopeA(), /PROCESS_OWNER_UNKNOWN/);

  const otherRoot = path.join(sandbox, "other");
  await fs.mkdir(otherRoot);
  const otherCallbacks = register(otherRoot);
  await deny("stop_process", { id: startedA.id, force: true }, scope("goal-process-a", "owner-a", otherRoot), /PROCESS_OWNER_SCOPE_MISMATCH/, otherCallbacks);

  const probe = spawn(process.execPath, [self, "--recovered-probe", sandbox, startedA.id], { cwd: sandbox, env: { ...process.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let probeOut = "", probeErr = "";
  probe.stdout.on("data", (chunk) => { probeOut += chunk; });
  probe.stderr.on("data", (chunk) => { probeErr += chunk; });
  const probeTimeout = setTimeout(() => probe.kill("SIGKILL"), 25000);
  const probeExit = await new Promise((resolve, reject) => { probe.once("error", reject); probe.once("close", resolve); }).finally(() => clearTimeout(probeTimeout));
  assert.equal(probeExit, 0, probeOut + probeErr);
  assert.match(probeOut, /recovered probe PASS/);
  const afterProbe = await waitFor(startedA.id, scopeA(), (value) => value.stdout.includes("ECHO:recovered-successor"));
  assert.ok(!afterProbe.stdout.includes("forbidden-recovered"));

  await invoke("process_input", { id: startedA.id, text: "quit", append_newline: true }, scopeA());
  await waitFor(startedA.id, scopeA(), (value) => value.running === false);
  const finishedOwnedIndex = owned.findIndex((entry) => entry.id === startedA.id);
  if (finishedOwnedIndex >= 0) owned.splice(finishedOwnedIndex, 1);
  assert.equal((await invoke("clear_processes", {}, scopeB())).cleared, 0);
  assert.equal((await invoke("process_status", { id: startedA.id }, scopeA())).processes[0].recovered, false, "other Goal clear must not delete this Goal's memory record");
  assert.equal((await invoke("clear_processes", {}, scopeA())).cleared, 1);
  const recoveredFinished = (await invoke("process_status", { id: startedA.id }, successor)).processes[0];
  assert.equal(recoveredFinished.recovered, true);
  assert.equal(recoveredFinished.goal_id, "goal-process-a");
  console.log("process-goal-scope PASS: immutable provenance, Goal/session/unknown isolation, pre-await capture, live and recovered control, successor access, workspace and clear boundaries");
} finally {
  for (const entry of owned) await stopAndDrain(entry);
  for (const [key, value] of previousEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await removeSandbox();
}
