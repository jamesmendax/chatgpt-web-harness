import assert from "node:assert/strict";
import { classifyRecoveryContinuity } from "../dist/lib/service-recovery-supervisor.js";

const alive = { running: true, guardian_running: true, worker_running: true, executor_state: "running" };
assert.equal(classifyRecoveryContinuity(true, alive), "healthy");
assert.equal(classifyRecoveryContinuity(false, alive), "tool_disconnected_executor_alive");
assert.equal(classifyRecoveryContinuity(false, {
  running: false,
  guardian_running: false,
  worker_running: false,
  executor_state: "dead",
}), "executor_unavailable");
assert.equal(classifyRecoveryContinuity(false, {
  running: true,
  guardian_running: true,
  worker_running: false,
  executor_state: "recovering",
}), "indeterminate");

console.log(JSON.stringify({
  test: "service-recovery-continuity",
  status: "PASS",
  disconnected_with_executor: "tool_disconnected_executor_alive",
  executor_dead: "executor_unavailable",
}));