import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readProcessStartIdentity } from "../dist/lib/process-journal.js";
import { recoverTask } from "../dist/lib/recovery-engine.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-stale-lease-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readState(taskId) {
  const statePath = path.join(root, ".recovery-engine", `task-${taskId}.json`);
  return { statePath, state: JSON.parse(await fs.readFile(statePath, "utf8")) };
}

async function waitForExecuting(taskId, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const observed = await readState(taskId);
      if (observed.state.status === "running" && observed.state.steps?.[0]?.status === "executing") return observed;
    } catch {}
    await delay(25);
  }
  throw new Error(`timed out waiting for executing snapshot: ${taskId}`);
}

async function captureExecutingSnapshot(taskId, operationId) {
  const plan = {
    workspace_root: root,
    allowed_workspaces: [root],
    steps: [{ id: "work", operation_id: operationId, replay_policy: "safe" }],
  };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = recoverTask({
    workspaceRoot: root,
    taskId,
    plan,
    leaseMs: 60_000,
    executor: async ({ heartbeat }) => {
      await heartbeat("snapshot-ready");
      await gate;
      return { first_attempt_completed_only_to_release_lock: true };
    },
  });
  const observed = await waitForExecuting(taskId);
  const snapshot = structuredClone(observed.state);
  release();
  const completed = await first;
  assert.equal(completed.action, "completed");
  return { plan, statePath: observed.statePath, snapshot };
}

try {
  const identity = await readProcessStartIdentity(process.pid);
  assert.ok(identity, "test process identity unavailable");

  const pidReuseTask = "pid-reuse-fresh-lease";
  const pidReuseOperation = "nlr-20261001-03-pid-reuse";
  const pidReuse = await captureExecutingSnapshot(pidReuseTask, pidReuseOperation);
  pidReuse.snapshot.steps[0].lease.owner_pid = process.pid;
  pidReuse.snapshot.steps[0].lease.owner_process_start_identity = identity + "-different";
  pidReuse.snapshot.steps[0].lease.expires_at = new Date(Date.now() + 60_000).toISOString();
  await fs.writeFile(pidReuse.statePath, JSON.stringify(pidReuse.snapshot, null, 2) + "\n", "utf8");
  let pidReuseExecutions = 0;
  const recoveredPidReuse = await recoverTask({
    workspaceRoot: root,
    taskId: pidReuseTask,
    plan: pidReuse.plan,
    leaseMs: 500,
    executor: async ({ operation_id }) => {
      pidReuseExecutions += 1;
      assert.equal(operation_id, pidReuseOperation);
      return { recovered: "pid-reuse" };
    },
  });
  assert.equal(recoveredPidReuse.action, "completed");
  assert.equal(pidReuseExecutions, 1);
  assert.equal(recoveredPidReuse.state.recovery_count, 1);

  const expiredTask = "expired-live-identity-lease";
  const expiredOperation = "nlr-20261001-03-expired-lease";
  const expired = await captureExecutingSnapshot(expiredTask, expiredOperation);
  expired.snapshot.steps[0].lease.owner_pid = process.pid;
  expired.snapshot.steps[0].lease.owner_process_start_identity = identity;
  expired.snapshot.steps[0].lease.expires_at = new Date(Date.now() - 1000).toISOString();
  await fs.writeFile(expired.statePath, JSON.stringify(expired.snapshot, null, 2) + "\n", "utf8");
  let expiredExecutions = 0;
  const recoveredExpired = await recoverTask({
    workspaceRoot: root,
    taskId: expiredTask,
    plan: expired.plan,
    leaseMs: 500,
    executor: async ({ operation_id }) => {
      expiredExecutions += 1;
      assert.equal(operation_id, expiredOperation);
      return { recovered: "expired-lease" };
    },
  });
  assert.equal(recoveredExpired.action, "completed");
  assert.equal(expiredExecutions, 1);
  assert.equal(recoveredExpired.state.recovery_count, 1);

  console.log(JSON.stringify({
    test: "recovery-stale-lease-pid-reuse",
    status: "PASS",
    pid_reuse_fresh_lease_recovered: true,
    pid_reuse_operation_id: pidReuseOperation,
    expired_live_identity_lease_recovered: true,
    expired_operation_id: expiredOperation,
    duplicate_executor_entries: 0,
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
