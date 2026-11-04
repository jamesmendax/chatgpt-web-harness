import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-watchdog-lifecycle");
await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(tmpRoot, { recursive: true });

function slug(workspace) {
  return crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 12);
}

async function seedGoal(codexHome, workspace, status = "active", criterionPassed = false) {
  const stateDir = path.join(codexHome, "projects", slug(workspace));
  await fs.mkdir(path.join(stateDir, "tasks"), { recursive: true });
  await fs.writeFile(path.join(stateDir, "goal.json"), JSON.stringify({
    id: "watchdog-test",
    status,
    updated_at: new Date().toISOString(),
    success_criteria: [{ name: "finish test", passed: criterionPassed }],
  }, null, 2));
  return stateDir;
}

async function waitUntil(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timeout waiting for watchdog lifecycle condition");
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

const codexHome = path.join(tmpRoot, "codex-home");
const workspace = path.join(tmpRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });
const stateDir = await seedGoal(codexHome, workspace);
const pidFile = path.join(stateDir, "goal-watchdog.pid.json");

process.env.CODEX_HOME = codexHome;
process.env.GOAL_STALL_GAP_MS = "999999999";
process.env.WATCHDOG_POLL_MS = "50";
process.env.WATCHDOG_REMIND_MS = "999999999";
const lifecycle = await import(`../dist/lib/goal-watchdog.js?test=${Date.now()}`);

const first = lifecycle.startGoalWatchdog(workspace);
assert.equal(first.running, true);
assert.equal(first.state, "on");
assert.equal(first.mode, "goal_scoped");
assert.equal(first.lifecycle, "managed_by_goal");
assert.equal(first.role, "fallback_alert_only");
assert.equal(first.parent_bound, true);
assert.equal(first.parent_pid, process.pid);
assert.ok(first.pid);
await waitUntil(() => exists(pidFile));
const pidRecord = JSON.parse(await fs.readFile(pidFile, "utf8"));
assert.equal(pidRecord.parent_pid, process.pid, "auto watchdog must be bound to the MCP parent pid");
const second = lifecycle.startGoalWatchdog(workspace);
assert.equal(second.pid, first.pid, "repeated active-goal sync must not spawn duplicate watchdogs");

await seedGoal(codexHome, workspace, "paused");
await waitUntil(() => !lifecycle.goalWatchdogStatus().running);
await waitUntil(async () => !(await exists(pidFile)));

await seedGoal(codexHome, workspace, "active");
const restarted = lifecycle.startGoalWatchdog(workspace);
assert.equal(restarted.running, true);
const stopped = lifecycle.stopGoalWatchdog();
assert.equal(stopped.running, false);
assert.equal(stopped.state, "off");
assert.equal(stopped.mode, "goal_scoped");
assert.equal(stopped.lifecycle, "managed_by_goal");
assert.equal(stopped.role, "fallback_alert_only");
assert.equal(stopped.parent_bound, false);
await waitUntil(() => !lifecycle.goalWatchdogStatus().running);
await waitUntil(async () => !(await exists(pidFile)));

// All criteria passed while the goal is still active is a separate reminder
// path. It must share the normal reminder throttle instead of notifying every
// polling interval.
const allPassHome = path.join(tmpRoot, "codex-home-all-pass");
const allPassWorkspace = path.join(tmpRoot, "workspace-all-pass");
await fs.mkdir(allPassWorkspace, { recursive: true });
const allPassStateDir = await seedGoal(allPassHome, allPassWorkspace, "active", true);
const allPassLog = path.join(allPassStateDir, "goal-watchdog.log");
const allPassParent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
assert.ok(allPassParent.pid);
const allPassWatchdog = spawn(process.execPath, [path.join(root, "scripts", "goal-watchdog.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    CODEX_HOME: allPassHome,
    WATCH_WORKSPACE: allPassWorkspace,
    WATCHDOG_PARENT_PID: String(allPassParent.pid),
    WATCHDOG_POLL_MS: "50",
    GOAL_STALL_GAP_MS: "999999999",
    WATCHDOG_REMIND_MS: "999999999",
  },
  windowsHide: true,
  stdio: "ignore",
});
await waitUntil(async () => {
  const text = await fs.readFile(allPassLog, "utf8").catch(() => "");
  return text.split("all criteria passed but not completed").length - 1 === 1;
});
await new Promise((resolve) => setTimeout(resolve, 250));
const allPassLogText = await fs.readFile(allPassLog, "utf8");
if (allPassLogText.split("all criteria passed but not completed").length - 1 !== 1) {
  throw new Error("all-criteria-pass reminder bypassed the existing throttle");
}
allPassParent.kill();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("all-pass watchdog did not stop")), 4000);
  allPassWatchdog.once("exit", () => { clearTimeout(timer); resolve(); });
});
await waitUntil(async () => !(await exists(path.join(allPassStateDir, "goal-watchdog.pid.json"))));

// Session shards: each ChatGPT conversation gets its own watchdog state.
// A paused legacy projection must not satisfy an active shard, and stopping
// one session must not silence another session in the same workspace.
const codexHomeSessions = path.join(tmpRoot, "codex-home-sessions");
const sessionsWorkspace = path.join(tmpRoot, "workspace-sessions");
await fs.mkdir(sessionsWorkspace, { recursive: true });
const sessionsStateDir = await seedGoal(codexHomeSessions, sessionsWorkspace, "paused");
const sessionA = "watchdog-session-A";
const sessionB = "watchdog-session-B";
async function seedSessionGoal(sessionId, status = "active") {
  const dir = path.join(sessionsStateDir, "sessions", sessionId);
  await fs.mkdir(dir, { recursive: true });
  const goalFile = path.join(dir, "goal.json");
  await fs.writeFile(goalFile, JSON.stringify({
    id: `watchdog-${sessionId}`,
    status,
    updated_at: new Date().toISOString(),
    success_criteria: [{ name: "finish shard test", passed: false }],
  }, null, 2));
  return {
    dir,
    goalFile,
    pidFile: path.join(dir, "goal-watchdog.pid.json"),
    logFile: path.join(dir, "goal-watchdog.log"),
  };
}
const shardA = await seedSessionGoal(sessionA);
const shardB = await seedSessionGoal(sessionB);
process.env.CODEX_HOME = codexHomeSessions;
const watchdogA = lifecycle.startGoalWatchdog(sessionsWorkspace, sessionA);
const watchdogB = lifecycle.startGoalWatchdog(sessionsWorkspace, sessionB);
assert.equal(watchdogA.session_id, sessionA);
assert.equal(watchdogB.session_id, sessionB);
assert.notEqual(watchdogA.pid, watchdogB.pid);
await waitUntil(() => exists(shardA.pidFile));
await waitUntil(() => exists(shardB.pidFile));
const stoppedA = lifecycle.stopGoalWatchdog(sessionsWorkspace, sessionA);
assert.equal(stoppedA.running, false);
await waitUntil(async () => !(await exists(shardA.pidFile)));
assert.equal(lifecycle.goalWatchdogStatus(sessionsWorkspace, sessionB).running, true);
const stoppedAll = lifecycle.stopGoalWatchdog(sessionsWorkspace);
assert.equal(stoppedAll.running, false);
await waitUntil(async () => !(await exists(shardB.pidFile)));
const shardALog = await fs.readFile(shardA.logFile, "utf8").catch(() => "");
assert.match(shardALog, new RegExp(`watchdog started:.*session=${sessionA}`));
assert.doesNotMatch(shardALog, new RegExp(`session=${sessionB}`));

// Independent parent-death check: even if the MCP disappears without running
// goal(pause/complete/cancel), the watchdog must self-terminate.
const codexHome2 = path.join(tmpRoot, "codex-home-parent");
const workspace2 = path.join(tmpRoot, "workspace-parent");
await fs.mkdir(workspace2, { recursive: true });
const stateDir2 = await seedGoal(codexHome2, workspace2, "active");
const pidFile2 = path.join(stateDir2, "goal-watchdog.pid.json");
const fakeParent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
assert.ok(fakeParent.pid);
const rawWatchdog = spawn(process.execPath, [path.join(root, "scripts", "goal-watchdog.mjs")], {
  cwd: root,
  env: {
    ...process.env,
    CODEX_HOME: codexHome2,
    WATCH_WORKSPACE: workspace2,
    WATCHDOG_PARENT_PID: String(fakeParent.pid),
    WATCHDOG_POLL_MS: "50",
    GOAL_STALL_GAP_MS: "999999999",
    WATCHDOG_REMIND_MS: "999999999",
  },
  windowsHide: true,
  stdio: "ignore",
});
await waitUntil(() => exists(pidFile2));
fakeParent.kill();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("watchdog did not exit after parent MCP died")), 4000);
  rawWatchdog.once("exit", () => { clearTimeout(timer); resolve(); });
});
await waitUntil(async () => !(await exists(pidFile2)));

console.log("goal-watchdog: active-goal auto start, duplicate guard, pause/stop shutdown, and MCP-parent death shutdown OK");
