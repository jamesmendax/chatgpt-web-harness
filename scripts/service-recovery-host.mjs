#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readProcessStartIdentity } from "../dist/lib/process-journal.js";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
for (const name of ["--workspace", "--state-root", "--artifact-root"]) {
  if (!arg(name)?.trim()) throw new Error("service-recovery-host requires " + name);
}
const workspaceRoot = path.resolve(arg("--workspace"));
const stateRoot = path.resolve(arg("--state-root"));
const artifactRoot = path.resolve(arg("--artifact-root"));
const launchToken = arg("--launch-token") || randomUUID();
if (!workspaceRoot || !stateRoot || !artifactRoot) throw new Error("service-recovery-host requires workspace/state/artifact roots");

const plansDir = path.join(stateRoot, "plans");
const lockFile = path.join(stateRoot, "host.lock");
const pidFile = path.join(stateRoot, "host.pid.json");
const statusFile = path.join(stateRoot, "host-status.json");
const stopFile = path.join(stateRoot, "stop.request.json");
const activityFile = path.join(artifactRoot, "activity.jsonl");
const LOCK_SETTLE_MS = 750;
const WORKER_RESTART_BASE_MS = Math.max(100, Number.parseInt(process.env.HARNESS_RECOVERY_WORKER_RESTART_BASE_MS || "250", 10) || 250);
const WORKER_RESTART_MAX_MS = Math.max(WORKER_RESTART_BASE_MS, Number.parseInt(process.env.HARNESS_RECOVERY_WORKER_RESTART_MAX_MS || "5000", 10) || 5000);
const WORKER_RESTART_LIMIT = Math.max(1, Number.parseInt(process.env.HARNESS_RECOVERY_WORKER_RESTART_LIMIT || "6", 10) || 6);
const WORKER_STABLE_MS = Math.max(1000, Number.parseInt(process.env.HARNESS_RECOVERY_WORKER_STABLE_MS || "10000", 10) || 10000);
await Promise.all([
  fs.mkdir(stateRoot, { recursive: true }),
  fs.mkdir(plansDir, { recursive: true }),
  fs.mkdir(artifactRoot, { recursive: true }),
]);

const instanceToken = randomUUID();
const startIdentity = await readProcessStartIdentity(process.pid);
if (!startIdentity) throw new Error("RECOVERY_HOST_IDENTITY_UNAVAILABLE: cannot establish current process start identity");

async function appendStartupActivity(event, detail = {}) {
  await fs.appendFile(activityFile, JSON.stringify({
    at: new Date().toISOString(),
    source: "service-recovery-host",
    event,
    host_pid: process.pid,
    ...detail,
  }) + "\n", "utf8");
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

async function readExistingLock() {
  let raw;
  try {
    raw = await fs.readFile(lockFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    if (error?.code === "EPERM" || error?.code === "EACCES") return { kind: "permission_denied", error };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const stat = await fs.stat(lockFile).catch(() => null);
    const ageMs = stat ? Math.max(0, Date.now() - stat.mtimeMs) : Number.POSITIVE_INFINITY;
    return { kind: ageMs < LOCK_SETTLE_MS ? "initializing" : "corrupt", age_ms: ageMs };
  }
  if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0 || typeof parsed?.instance_token !== "string") {
    return { kind: "corrupt", parsed };
  }
  let identity = typeof parsed.process_start_identity === "string" && parsed.process_start_identity
    ? parsed.process_start_identity
    : null;
  if (!identity) {
    const legacyPid = await fs.readFile(pidFile, "utf8").then(JSON.parse).catch(() => null);
    if (legacyPid?.pid === parsed.pid && legacyPid?.instance_token === parsed.instance_token &&
        typeof legacyPid?.process_start_identity === "string" && legacyPid.process_start_identity) {
      identity = legacyPid.process_start_identity;
    }
  }
  if (!identity) return { kind: "unverifiable", reason: "lock has no process start identity", parsed };
  const currentIdentity = await readProcessStartIdentity(parsed.pid);
  if (currentIdentity) {
    return currentIdentity === identity
      ? { kind: "live", parsed, identity }
      : { kind: "stale", reason: "pid_reused", parsed, identity, current_identity: currentIdentity };
  }
  const presence = processPresence(parsed.pid);
  if (presence === "gone") return { kind: "stale", reason: "owner_dead", parsed, identity };
  return { kind: "unverifiable", reason: presence, parsed, identity };
}

async function archiveStaleLock(existing) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "");
  const archived = path.join(stateRoot, `host.lock.dead-${stamp}-${randomUUID().slice(0, 8)}`);
  try {
    await fs.rename(lockFile, archived);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await appendStartupActivity("host_lock_recovered", {
    reason: existing.reason,
    previous_pid: existing.parsed?.pid ?? null,
    previous_process_start_identity: existing.identity ?? null,
    current_process_start_identity: existing.current_identity ?? null,
    archived_lock: archived,
  });
  return true;
}

async function acquireHostLock() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx");
      await handle.writeFile(JSON.stringify({
        version: 1,
        pid: process.pid,
        process_start_identity: startIdentity,
        instance_token: instanceToken,
        acquired_at: new Date().toISOString(),
      }), "utf8");
      await handle.sync();
      return handle;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readExistingLock();
      if (existing.kind === "missing") continue;
      if (existing.kind === "initializing") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if (existing.kind === "live") {
        await appendStartupActivity("host_lock_live_owner", { owner_pid: existing.parsed.pid });
        return null;
      }
      if (existing.kind === "stale") {
        await archiveStaleLock(existing);
        continue;
      }
      const message = existing.kind === "permission_denied"
        ? "RECOVERY_HOST_LOCK_PERMISSION_DENIED"
        : existing.kind === "corrupt"
          ? "RECOVERY_HOST_LOCK_CORRUPT"
          : "RECOVERY_HOST_LOCK_UNVERIFIABLE";
      await appendStartupActivity("host_lock_blocked", { classification: existing.kind, reason: existing.reason || null });
      const fatal = new Error(message + ": refusing to replace lock without proof that its owner is stale");
      fatal.code = message;
      throw fatal;
    }
  }
  throw new Error("RECOVERY_HOST_LOCK_CONTENTION: could not acquire host lock after bounded retries");
}
const lockHandle = await acquireHostLock();
if (!lockHandle) process.exit(0);
const startedAt = new Date().toISOString();
await atomicJson(pidFile, {
  version: 1,
  pid: process.pid,
  process_start_identity: startIdentity,
  instance_token: instanceToken,
  launch_token: launchToken,
  workspace_root: workspaceRoot,
  state_root: stateRoot,
  artifact_root: artifactRoot,
  plans_dir: plansDir,
  started_at: startedAt,
});

let stopping = false;
let worker = null;
let workerRestartCount = 0;
let workerFailureStreak = 0;
let workerRestartSuppressed = false;
let nextWorkerRestartAt = null;
let lastWorkerExit = null;
let workerStartedAt = null;
let workerStartIdentity = null;

async function appendActivity(event, detail = {}) {
  await fs.appendFile(activityFile, JSON.stringify({
    at: new Date().toISOString(),
    source: "service-recovery-host",
    event,
    host_pid: process.pid,
    worker_pid: worker?.pid ?? null,
    worker_restart_count: workerRestartCount,
    worker_failure_streak: workerFailureStreak,
    worker_restart_suppressed: workerRestartSuppressed,
    next_worker_restart_at: nextWorkerRestartAt,
    ...detail,
  }) + "\n", "utf8");
}

let statusWriteChain = Promise.resolve();
function saveStatus() {
  const write = statusWriteChain.then(() => atomicJson(statusFile, {
    version: 1,
    pid: process.pid,
    process_start_identity: startIdentity,
    instance_token: instanceToken,
    workspace_root: workspaceRoot,
    worker_pid: worker?.pid ?? null,
    worker_process_start_identity: workerStartIdentity,
    worker_started_at: workerStartedAt,
    worker_restart_count: workerRestartCount,
    worker_failure_streak: workerFailureStreak,
    worker_restart_suppressed: workerRestartSuppressed,
    next_worker_restart_at: nextWorkerRestartAt,
    last_worker_exit: lastWorkerExit,
    started_at: startedAt,
    heartbeat_at: new Date().toISOString(),
    stopping,
  }));
  statusWriteChain = write.catch(() => undefined);
  return write;
}

function workerScript() {
  return path.resolve(process.env.HARNESS_RECOVERY_WORKER_SCRIPT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "service-recovery-worker.mjs"));
}

async function scheduleWorkerRestart(detail) {
  if (stopping || workerRestartSuppressed) return;
  workerRestartCount += 1;
  if (workerFailureStreak >= WORKER_RESTART_LIMIT) {
    workerRestartSuppressed = true;
    nextWorkerRestartAt = null;
    await appendActivity("worker_restart_suppressed", { ...detail, worker_failure_streak: workerFailureStreak, restart_limit: WORKER_RESTART_LIMIT });
    await saveStatus();
    return;
  }
  const delayMs = Math.min(WORKER_RESTART_MAX_MS, WORKER_RESTART_BASE_MS * (2 ** Math.max(0, workerFailureStreak - 1)));
  nextWorkerRestartAt = new Date(Date.now() + delayMs).toISOString();
  await appendActivity("worker_restart_scheduled", { ...detail, delay_ms: delayMs, worker_failure_streak: workerFailureStreak });
  await saveStatus();
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  nextWorkerRestartAt = null;
  if (!stopping) await spawnWorker();
}

async function spawnWorker() {
  const script = workerScript();
  try {
    await fs.access(script);
  } catch (error) {
    workerRestartSuppressed = true;
    lastWorkerExit = { at: new Date().toISOString(), code: null, signal: null, error: "worker_script_missing", script };
    await appendActivity("worker_start_failed", { reason: "worker_script_missing", script, code: error?.code || null });
    await saveStatus();
    return;
  }
  workerStartedAt = new Date().toISOString();
  worker = spawn(process.execPath, [
    script,
    "--workspace", workspaceRoot,
    "--state-root", stateRoot,
    "--artifact-root", artifactRoot,
    "--host-token", instanceToken,
  ], {
    cwd: path.resolve(path.dirname(script), ".."),
    env: { ...process.env, HARNESS_RECOVERY_WORKER: "1" },
    windowsHide: true,
    stdio: "ignore",
  });
  const thisWorker = worker;
  const thisWorkerStartedAt = workerStartedAt;
  let handledFailure = false;
  const handleFailure = (code, signal, error = null) => {
    if (handledFailure) return;
    handledFailure = true;
    const startedMs = Date.parse(thisWorkerStartedAt || "");
    const uptimeMs = Number.isFinite(startedMs) ? Math.max(0, Date.now() - startedMs) : 0;
    workerFailureStreak = uptimeMs >= WORKER_STABLE_MS ? 1 : workerFailureStreak + 1;
    lastWorkerExit = { at: new Date().toISOString(), code, signal };
    const exitedPid = thisWorker?.pid ?? null;
    if (worker === thisWorker) {
      worker = null;
      workerStartIdentity = null;
    }
    void appendActivity("worker_exited", { worker_pid: exitedPid, code, signal, error: error?.message || null, uptime_ms: uptimeMs }).then(async () => {
      if (!stopping) {
        await scheduleWorkerRestart({ code, signal, error: error?.message || null, uptime_ms: uptimeMs });
      }
    });
  };
  thisWorker.once("exit", (code, signal) => handleFailure(code, signal));
  thisWorker.once("error", (error) => handleFailure(null, null, error));
  // Register exit/error listeners before the asynchronous identity lookup:
  // a syntax error can terminate the child while that lookup is running.
  if (thisWorker.pid) void appendActivity("worker_started", { worker_pid: thisWorker.pid });
  void saveStatus();
  const identity = thisWorker.pid ? await readProcessStartIdentity(thisWorker.pid) : null;
  if (worker === thisWorker && !handledFailure) {
    workerStartIdentity = identity;
    await saveStatus();
  }
}

async function stopRequested() {
  try {
    const request = JSON.parse(await fs.readFile(stopFile, "utf8"));
    return request?.version === 1 && request?.instance_token === instanceToken;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
}

async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  await appendActivity("host_stopping", { reason });
  await saveStatus();
  if (worker?.pid) {
    try { worker.kill(); } catch {}
    const deadline = Date.now() + 3000;
    while (worker && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await fs.rm(stopFile, { force: true }).catch(() => undefined);
  await fs.rm(pidFile, { force: true }).catch(() => undefined);
  try { await lockHandle.close(); } catch {}
  const ownedLock = await fs.readFile(lockFile, "utf8").then(JSON.parse).catch(() => null);
  if (ownedLock?.instance_token === instanceToken) {
    await fs.rm(lockFile, { force: true }).catch(() => undefined);
  }
  await appendActivity("host_stopped", { reason });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", async (error) => {
  await appendActivity("host_uncaught_exception", { message: error?.message || String(error) }).catch(() => undefined);
  process.exit(90);
});
process.on("unhandledRejection", async (error) => {
  await appendActivity("host_unhandled_rejection", { message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
  process.exit(91);
});

await appendActivity("host_started", { launch_token: launchToken, process_start_identity: startIdentity });
await spawnWorker();
const timer = setInterval(async () => {
  if (await stopRequested()) return shutdown("stop_request");
  await saveStatus();
}, 500);
// Keep the detached host alive even when the worker cannot be loaded or its
// restart budget is exhausted. In those failure states there is deliberately
// no child process to hold the event loop open; the host must remain present
// so the supervising service can observe the durable diagnostic and an
// operator/packaging repair can be applied without an uncontrolled respawn
// loop. shutdown() remains the only normal owner of this interval's lifetime.
await saveStatus();
await new Promise(() => {});

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rename(temp, file);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}
