import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { recoverTask } from "../dist/lib/recovery-engine.js";

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-plan-fingerprint-"));
const taskId = "plan-fingerprint";
const basePlan = {
  fingerprint: "plan-v1",
  workspace_root: workspace,
  allowed_workspaces: [workspace],
  steps: [{
    id: "write",
    name: "write-v1",
    operation_id: "stable-op",
    replay_policy: "safe",
    spec_fingerprint: "spec-v1"
  }]
};
try {
  const first = await recoverTask({
    workspaceRoot: workspace,
    taskId,
    plan: basePlan,
    executor: async () => ({ok:true, value:"v1"})
  });
  assert.equal(first.action, "completed");
  assert.match(first.state.plan_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(first.state.steps[0].spec_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.state.steps[0].receipt.plan_fingerprint, first.state.plan_fingerprint);
  assert.equal(first.state.steps[0].receipt.spec_fingerprint, first.state.steps[0].spec_fingerprint);

  await assert.rejects(
    () => recoverTask({
      workspaceRoot: workspace,
      taskId,
      plan: {
        fingerprint: "plan-v1",
        workspace_root: workspace,
        allowed_workspaces: [workspace],
        steps: [{
          id: "write",
          name: "write-v2",
          operation_id: "stable-op",
          replay_policy: "safe",
          spec_fingerprint: "spec-v1"
        }]
      },
      executor: async () => ({ok:true, value:"v2"})
    }),
    /RECOVERY_PLAN_MISMATCH/
  );

  await assert.rejects(
    () => recoverTask({
      workspaceRoot: workspace,
      taskId: "workspace-bound",
      plan: {
        workspace_root: path.join(workspace, "other"),
        allowed_workspaces: [workspace],
        steps: [{ id: "noop", replay_policy: "safe" }]
      },
      executor: async () => ({ok:true})
    }),
    /RECOVERY_PLAN_WORKSPACE_MISMATCH/
  );

  await assert.rejects(
    () => recoverTask({
      workspaceRoot: workspace,
      taskId: "invalid-policy",
      plan: { steps: [{ id: "noop", replay_policy: "sometimes" }] },
      executor: async () => ({ok:true})
    }),
    /RECOVERY_REPLAY_POLICY_INVALID/
  );
  console.log("recovery-plan-fingerprint: PASS");
} finally {
  await fs.rm(workspace,{recursive:true,force:true});
}
