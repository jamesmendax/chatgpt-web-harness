import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  serviceRecoverySupervisorPaths,
  serviceRecoverySupervisorStatus,
  startServiceRecoverySupervisor,
  stopServiceRecoverySupervisor,
} from "../dist/lib/service-recovery-supervisor.js";
import { readProcessStartIdentity } from "../dist/lib/process-journal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-lifecycle-"));
const workspace = path.join(base, "workspace");
const state = path.join(base, "state");
const artifacts = path.join(base, "artifacts");
await fs.mkdir(workspace, { recursive: true });
process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED = "true";
process.env.HARNESS_RECOVERY_SUPERVISOR_STATE_DIR = state;
process.env.HARNESS_RECOVERY_ARTIFACT_ROOT = artifacts;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(label, fn, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error?.message || String(error);
    }
    await delay(50);
  }
  throw new Error(label + " timeout; last=" + JSON.stringify(last));
}
async function processIdentity(pid) {
  try { return await readProcessStartIdentity(pid); } catch { return null; }
}
function hardKillOwned(record) {
  assert.ok(record?.pid && record?.process_start_identity, "missing owned host identity");
  return processIdentity(record.pid).then((current) => {
    assert.equal(current, record.process_start_identity, "refusing to kill pid whose identity changed");
    process.kill(record.pid, "SIGKILL");
  });
}
async function readPidRecord(paths) {
  try { return JSON.parse(await fs.readFile(paths.pidFile, "utf8")); } catch { return null; }
}

const paths = serviceRecoverySupervisorPaths(workspace);
let stopped = false;
try {
  const started = await startServiceRecoverySupervisor(workspace);
  assert.equal(started.running, true, "initial supervisor host did not start");
  const first = await waitFor("initial host record", async () => {
    const record = await readPidRecord(paths);
    return record?.pid && await processIdentity(record.pid) === record.process_start_identity ? record : null;
  });

  const concurrent = await Promise.all([
    startServiceRecoverySupervisor(workspace),
    startServiceRecoverySupervisor(workspace),
    startServiceRecoverySupervisor(workspace),
  ]);
  assert.ok(concurrent.every((s) => s.running && s.pid === first.pid), "concurrent starts did not converge on one host");

  const killedAt = Date.now();
  await hardKillOwned(first);

  const recovered = await waitFor("automatic host relaunch after hard kill", async () => {
    const record = await readPidRecord(paths);
    if (!record?.pid || record.pid === first.pid) return null;
    const identity = await processIdentity(record.pid);
    return identity === record.process_start_identity ? record : null;
  }, 5000);
  const recoveredMs = Date.now() - killedAt;
  assert.notEqual(recovered.pid, first.pid, "host pid did not change after hard kill");
  assert.ok(recoveredMs < 5000, "host recovery exceeded bounded acceptance");

  const statusAfterRecovery = await serviceRecoverySupervisorStatus(workspace);
  assert.equal(statusAfterRecovery.running, true);
  assert.equal(statusAfterRecovery.pid, recovered.pid);

  const stopStartedAt = Date.now();
  const stoppedStatus = await stopServiceRecoverySupervisor(workspace);
  stopped = true;
  assert.equal(stoppedStatus.running, false, "graceful stop did not stop host");
  await delay(1200);
  const afterGrace = await serviceRecoverySupervisorStatus(workspace);
  assert.equal(afterGrace.running, false, "gracefully stopped host was spuriously relaunched");
  const lingering = await readPidRecord(paths);
  if (lingering?.pid) {
    assert.notEqual(await processIdentity(lingering.pid), lingering.process_start_identity, "live host remained after graceful stop");
  }

  console.log(JSON.stringify({
    test: "service-recovery-lifecycle",
    result: "PASS",
    initial_host_pid: first.pid,
    recovered_host_pid: recovered.pid,
    recovery_ms: recoveredMs,
    graceful_stop_ms: Date.now() - stopStartedAt,
    same_host_after_concurrent_start: true,
    graceful_stop_relaunch_count: 0
  }));
} finally {
  if (!stopped) {
    try { await stopServiceRecoverySupervisor(workspace); } catch {}
  }
  await fs.rm(base, { recursive: true, force: true });
}
