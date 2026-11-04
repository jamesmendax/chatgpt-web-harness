import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessStartIdentity } from "../dist/lib/process-journal.js";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

for (const name of ["--workspace", "--state-root", "--artifact-root"]) {
  if (!arg(name).trim()) throw new Error("RECOVERY_GUARDIAN_ARGS: " + name + " is required");
}
const workspaceRoot = path.resolve(arg("--workspace"));
const stateRoot = path.resolve(arg("--state-root"));
const artifactRoot = path.resolve(arg("--artifact-root"));
const launchToken = arg("--launch-token");
if (!workspaceRoot || !stateRoot || !artifactRoot || !launchToken) {
  throw new Error("RECOVERY_GUARDIAN_ARGS: --workspace, --state-root, --artifact-root and --launch-token are required");
}

const guardianLock = path.join(stateRoot, "guardian.lock");
const guardianPidFile = path.join(stateRoot, "guardian.pid.json");
const guardianStatusFile = path.join(stateRoot, "guardian-status.json");
const guardianStopFile = path.join(stateRoot, "guardian-stop.request.json");
const hostPidFile = path.join(stateRoot, "host.pid.json");
const hostStopFile = path.join(stateRoot, "stop.request.json");
const activityFile = path.join(artifactRoot, "activity.jsonl");
const hostScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "service-recovery-host.mjs");
const CHECK_MS = Math.max(100, Number.parseInt(process.env.HARNESS_RECOVERY_GUARDIAN_CHECK_MS || "500", 10) || 500);
const HOST_RESTART_BASE_MS = Math.max(100, Number.parseInt(process.env.HARNESS_RECOVERY_HOST_RESTART_BASE_MS || "250", 10) || 250);
const HOST_RESTART_MAX_MS = Math.max(HOST_RESTART_BASE_MS, Number.parseInt(process.env.HARNESS_RECOVERY_HOST_RESTART_MAX_MS || "5000", 10) || 5000);
const HOST_RESTART_LIMIT = Math.max(1, Number.parseInt(process.env.HARNESS_RECOVERY_HOST_RESTART_LIMIT || "8", 10) || 8);

await Promise.all([
  fs.mkdir(stateRoot, { recursive: true }),
  fs.mkdir(artifactRoot, { recursive: true }),
]);

const instanceToken = randomUUID();
const processStartIdentity = await readProcessStartIdentity(process.pid);
if (!processStartIdentity) throw new Error("RECOVERY_GUARDIAN_IDENTITY_UNAVAILABLE");

async function appendActivity(event, detail = {}) {
  await fs.appendFile(activityFile, JSON.stringify({
    at: new Date().toISOString(),
    source: "service-recovery-guardian",
    event,
    guardian_pid: process.pid,
    guardian_instance_token: instanceToken,
    ...detail,
  }) + "\n", "utf8");
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

function processPresence(pid) {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    if (error?.code === "ESRCH") return "gone";
    if (error?.code === "EPERM" || error?.code === "EACCES") return "permission_denied";
    return "unverifiable";
  }
}

async function recordAlive(record) {
  if (!record?.pid || !record?.process_start_identity) return false;
  const identity = await readProcessStartIdentity(record.pid);
  if (identity) return identity === record.process_start_identity;
  return processPresence(record.pid) === "present" ? null : false;
}

async function acquireGuardianLock() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const handle = await fs.open(guardianLock, "wx");
      const record = {
        version: 1,
        pid: process.pid,
        process_start_identity: processStartIdentity,
        instance_token: instanceToken,
        acquired_at: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readJson(guardianLock);
      if (!existing) {
        const stat = await fs.stat(guardianLock).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs < 750) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        throw new Error("RECOVERY_GUARDIAN_LOCK_CORRUPT: refusing to replace an unverifiable guardian lock");
      }
      const alive = await recordAlive(existing);
      if (alive === true) {
        await appendActivity("guardian_lock_live_owner", { owner_pid: existing.pid });
        return null;
      }
      if (alive === null) {
        throw new Error("RECOVERY_GUARDIAN_LOCK_UNVERIFIABLE: insufficient permission to prove prior guardian is stale");
      }
      const archived = path.join(stateRoot, "guardian.lock.dead-" + new Date().toISOString().replace(/[:.]/g, "") + "-" + randomUUID().slice(0,8));
      try {
        await fs.rename(guardianLock, archived);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue;
        throw renameError;
      }
      await appendActivity("guardian_lock_recovered", { previous_pid: existing.pid, archived_lock: archived });
    }
  }
  throw new Error("RECOVERY_GUARDIAN_LOCK_CONTENTION");
}

const lockHandle = await acquireGuardianLock();
if (!lockHandle) process.exit(0);

const startedAt = new Date().toISOString();
await fs.writeFile(guardianPidFile, JSON.stringify({
  version: 1,
  pid: process.pid,
  process_start_identity: processStartIdentity,
  instance_token: instanceToken,
  workspace_root: workspaceRoot,
  state_root: stateRoot,
  artifact_root: artifactRoot,
  started_at: startedAt,
  launch_token: launchToken,
}, null, 2) + "\n", "utf8");

let stopping = false;
let hostFailureStreak = 0;
let hostRestartCount = 0;
let nextHostRestartAt = null;
let lastObservedHostPid = null;
let lastHostFailure = null;

async function saveStatus() {
  const host = await readJson(hostPidFile);
  const hostAlive = await recordAlive(host);
  await fs.writeFile(guardianStatusFile, JSON.stringify({
    version: 1,
    pid: process.pid,
    process_start_identity: processStartIdentity,
    instance_token: instanceToken,
    started_at: startedAt,
    stopping,
    host_running: hostAlive === true,
    host_pid: hostAlive === true ? host.pid : null,
    host_restart_count: hostRestartCount,
    host_failure_streak: hostFailureStreak,
    next_host_restart_at: nextHostRestartAt,
    last_host_failure: lastHostFailure,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", "utf8");
}

async function waitForHost(launch) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const record = await readJson(hostPidFile);
    if (record?.launch_token === launch && await recordAlive(record) === true) return record;
    const any = await readJson(hostPidFile);
    if (await recordAlive(any) === true) return any;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function spawnHost(reason) {
  if (stopping) return null;
  const launch = randomUUID();
  await fs.rm(hostStopFile, { force: true }).catch(() => undefined);
  const child = spawn(process.execPath, [
    hostScript,
    "--workspace", workspaceRoot,
    "--state-root", stateRoot,
    "--artifact-root", artifactRoot,
    "--launch-token", launch,
  ], {
    cwd: path.resolve(path.dirname(hostScript), ".."),
    env: {
      ...process.env,
      HARNESS_RECOVERY_SUPERVISOR_CHILD: "1",
      HARNESS_RECOVERY_SUPERVISOR_STATE_DIR: stateRoot,
      HARNESS_RECOVERY_ARTIFACT_ROOT: artifactRoot,
    },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  await appendActivity("host_launch_attempt", { reason, spawned_pid: child.pid, launch_token: launch, failure_streak: hostFailureStreak });
  const record = await waitForHost(launch);
  if (record) {
    const previous = lastObservedHostPid;
    lastObservedHostPid = record.pid;
    hostFailureStreak = 0;
    nextHostRestartAt = null;
    if (previous && previous !== record.pid) hostRestartCount += 1;
    await appendActivity(previous && previous !== record.pid ? "host_restarted" : "host_started", {
      reason,
      host_pid: record.pid,
      previous_host_pid: previous,
      host_restart_count: hostRestartCount,
    });
    await saveStatus();
    return record;
  }
  hostFailureStreak += 1;
  lastHostFailure = { at: new Date().toISOString(), reason: "launch_timeout", launch_token: launch };
  await appendActivity("host_launch_failed", { reason, launch_token: launch, failure_streak: hostFailureStreak });
  return null;
}

async function ensureHost() {
  if (stopping) return;
  const current = await readJson(hostPidFile);
  const alive = await recordAlive(current);
  if (alive === true) {
    lastObservedHostPid = current.pid;
    if (hostFailureStreak !== 0) hostFailureStreak = 0;
    nextHostRestartAt = null;
    await saveStatus();
    return;
  }
  if (alive === null) {
    lastHostFailure = { at: new Date().toISOString(), reason: "host_identity_unverifiable", pid: current?.pid ?? null };
    await appendActivity("host_identity_unverifiable", { host_pid: current?.pid ?? null });
    await saveStatus();
    return;
  }
  if (current?.pid) {
    lastObservedHostPid = current.pid;
    lastHostFailure = { at: new Date().toISOString(), reason: "host_dead", pid: current.pid };
    await appendActivity("host_detected_dead", { host_pid: current.pid });
  }
  if (hostFailureStreak >= HOST_RESTART_LIMIT) {
    nextHostRestartAt = null;
    await appendActivity("host_restart_suppressed", { failure_streak: hostFailureStreak, restart_limit: HOST_RESTART_LIMIT });
    await saveStatus();
    return;
  }
  const delayMs = hostFailureStreak === 0 ? 0 : Math.min(HOST_RESTART_MAX_MS, HOST_RESTART_BASE_MS * (2 ** Math.max(0, hostFailureStreak - 1)));
  if (delayMs > 0) {
    nextHostRestartAt = new Date(Date.now() + delayMs).toISOString();
    await saveStatus();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (stopping) return;
  }
  await spawnHost(current?.pid ? "host_dead" : "host_missing");
}

async function stopRequested() {
  const request = await readJson(guardianStopFile);
  return request?.instance_token === instanceToken;
}

async function requestHostStop() {
  const record = await readJson(hostPidFile);
  if (await recordAlive(record) !== true) return;
  const temp = hostStopFile + "." + process.pid + "." + randomUUID() + ".tmp";
  await fs.writeFile(temp, JSON.stringify({
    version: 1,
    instance_token: record.instance_token,
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  }, null, 2) + "\n", "utf8");
  await fs.rename(temp, hostStopFile);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await recordAlive(record) !== true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RECOVERY_GUARDIAN_HOST_STOP_TIMEOUT");
}

async function cleanupOwnedFiles() {
  const pidRecord = await readJson(guardianPidFile);
  if (pidRecord?.instance_token === instanceToken) {
    await fs.rm(guardianPidFile, { force: true }).catch(() => undefined);
  }
  const lockRecord = await readJson(guardianLock);
  try { await lockHandle.close(); } catch {}
  if (lockRecord?.instance_token === instanceToken) {
    await fs.rm(guardianLock, { force: true }).catch(() => undefined);
  }
  await fs.rm(guardianStopFile, { force: true }).catch(() => undefined);
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  await appendActivity("guardian_stopping", { reason });
  await saveStatus();
  try {
    await requestHostStop();
  } catch (error) {
    await appendActivity("guardian_host_stop_failed", { reason: error?.message || String(error) });
  }
  await cleanupOwnedFiles();
  await appendActivity("guardian_stopped", { reason });
  process.exit(0);
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGHUP", () => { void shutdown("SIGHUP"); });

await appendActivity("guardian_started", { launch_token: launchToken, process_start_identity: processStartIdentity });
await ensureHost();
await saveStatus();

let tickRunning = false;
const timer = setInterval(() => {
  if (tickRunning || stopping) return;
  tickRunning = true;
  void (async () => {
    try {
      if (await stopRequested()) {
        await shutdown("stop_request");
        return;
      }
      await ensureHost();
    } catch (error) {
      lastHostFailure = { at: new Date().toISOString(), reason: error?.message || String(error) };
      await appendActivity("guardian_tick_error", { error: error?.message || String(error) });
      await saveStatus().catch(() => undefined);
    } finally {
      tickRunning = false;
    }
  })();
}, CHECK_MS);

await new Promise(() => {});
