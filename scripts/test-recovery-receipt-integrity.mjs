import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recoverTask } from "../dist/lib/recovery-engine.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-receipt-integrity-"));
const taskId = "receipt-integrity";
const statePath = path.join(root, ".recovery-engine", `task-${taskId}.json`);
const plan = {
  workspace_root: root,
  allowed_workspaces: [root],
  steps: [{
    id: "write",
    operation_id: "receipt-integrity-op",
    replay_policy: "safe",
  }],
};

try {
  let executions = 0;
  const first = await recoverTask({
    workspaceRoot: root,
    taskId,
    plan,
    executor: async () => {
      executions += 1;
      return { value: "durable-result" };
    },
  });
  assert.equal(first.action, "completed");
  assert.equal(executions, 1);

  const clean = JSON.parse(await fs.readFile(statePath, "utf8"));
  const cleanReceiptHash = clean.final_receipt.receipt_sha256;
  assert.match(cleanReceiptHash, /^[a-f0-9]{64}$/);

  clean.steps[0].receipt.result_sha256 = "0".repeat(64);
  await fs.writeFile(statePath, JSON.stringify(clean, null, 2) + "\n", "utf8");

  await assert.rejects(
    () => recoverTask({
      workspaceRoot: root,
      taskId,
      plan,
      executor: async () => {
        executions += 1;
        return { should_not_execute: true };
      },
    }),
    /RECOVERY_RECEIPT_CORRUPT/
  );
  assert.equal(executions, 1, "corrupt completed receipt must fail closed before executor entry");

  console.log(JSON.stringify({
    test: "recovery-receipt-integrity",
    status: "PASS",
    clean_receipt_sha256: cleanReceiptHash,
    corrupt_receipt_rejected: true,
    executor_entries_after_corruption: 0,
  }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}