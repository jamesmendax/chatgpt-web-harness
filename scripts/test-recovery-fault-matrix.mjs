import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifact = path.join(root, ".harness", "artifacts", "recovery-supervisor", "NATIVE-LONG-RECOVERY-20261001-03.fault-matrix.json");

const executions = [
  { id: "transport", script: "test-transport-resilience.mjs", expect: /transport-resilience: .*PASS/ },
  { id: "session-delete", script: "test-session-delete-grace.mjs", expect: /session-delete-grace: .*PASS/ },
  { id: "host-lifecycle", script: "test-service-recovery-lifecycle.mjs", expect: /PASS/i },
  { id: "host-locks", script: "test-service-recovery-host-locks.mjs", expect: /PID reuse recovery PASS/ },
  { id: "host-failures", script: "test-service-recovery-host-failures.mjs", expect: /service-recovery-host-failures: PASS/ },
  { id: "durable-runner", script: "test-service-recovery-durable-plan.mjs", expect: /"status":"PASS"/ },
  { id: "stale-lease", script: "test-recovery-stale-lease-pid-reuse.mjs", expect: /"status":"PASS"/ },
  { id: "receipt-integrity", script: "test-recovery-receipt-integrity.mjs", expect: /"corrupt_receipt_rejected":true/ },
  { id: "plan-drift", script: "test-recovery-plan-fingerprint.mjs", expect: /recovery-plan-fingerprint: PASS/ },
  { id: "process-tree", script: "test-service-recovery-command-process-tree.mjs", expect: /"late_side_effect":false/ },
  { id: "execution-boundaries", script: "test-recovery-execution-boundaries.mjs", expect: /"status":\s*"PASS"/ },
  { id: "native-admission", script: "test-native-web-recovery-submit.mjs", expect: /"status":\s*"PASS"/ },
  { id: "atomic-storage", script: "test-recovery-atomic-write.mjs", expect: /"status":\s*"PASS"/ },
];

const faultRows = [
  { fault: "windows_atomic_state_and_concurrent_publication", execution: "atomic-storage", expected: "sharing violations retry; final state is ordered; concurrent submissions publish one complete file" },
  { fault: "execution_scope_identity_and_retry_boundaries", execution: "execution-boundaries", expected: "unknown effects never replay; operation IDs, workspaces, artifacts and cumulative budgets remain bound" },
  { fault: "durable_admission_then_client_loss", execution: "native-admission", expected: "MCP admission and receipt persist; isolated same-operation executor survives client/worker loss" },
  { fault: "process_exit", execution: "durable-runner", expected: "safe same-operation recovery; one effect" },
  { fault: "http_sse_disconnect", execution: "transport", expected: "transport disconnect/replay fixtures pass without live service disruption" },
  { fault: "session_delete_rebuild", execution: "session-delete", expected: "in-flight handler drains; deleted session fenced; stale session rebuilds" },
  { fault: "host_crash", execution: "host-lifecycle", expected: "existing lifecycle supervisor restarts task-owned host without duplicate host" },
  { fault: "worker_crash", execution: "durable-runner", expected: "host restarts worker; stable operation id resumes exactly once" },
  { fault: "cold_start_dead_lock", execution: "host-locks", expected: "dead owner and PID-reuse locks are archived/recovered" },
  { fault: "concurrent_recovery", execution: "durable-runner", expected: "second contender returns busy; executor enters once" },
  { fault: "expired_lease", execution: "stale-lease", expected: "expired lease with live identity is recovered" },
  { fault: "pid_reuse", execution: "stale-lease", expected: "fresh lease with reused PID but mismatched process identity is stale" },
  { fault: "approval_wait", execution: "durable-runner", expected: "waiting persists with one attempt and no replay" },
  { fault: "unknown_side_effect", execution: "durable-runner", expected: "unknown result blocks fail-closed with effect count one" },
  { fault: "corrupt_receipt", execution: "receipt-integrity", expected: "corrupt completed receipt rejected before executor entry" },
  { fault: "plan_drift", execution: "plan-drift", expected: "semantic plan drift rejected despite reused caller labels" },
  { fault: "timeout_residual_process", execution: "process-tree", expected: "proven descendant started; timeout tree-kill leaves no late side effect" },
  { fault: "packaging_missing_worker", execution: "host-failures", expected: "missing worker emits one explicit diagnostic and suppresses restart loop" },
  { fault: "worker_load_failure_backoff", execution: "host-failures", expected: "bounded backoff 100/200ms then suppression" },
];

function hash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function runExecution(spec) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const child = spawn(process.execPath, [path.join(root, "scripts", spec.script)], {
    cwd: root,
    windowsHide: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 100000) stdout = stdout.slice(-100000); });
  child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 100000) stderr = stderr.slice(-100000); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`${spec.id} timed out`));
    }, 45_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
  const combined = stdout + "\n" + stderr;
  return {
    id: spec.id,
    script: spec.script,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedMs,
    exit_code: exitCode,
    expected_output_matched: spec.expect.test(combined),
    stdout_sha256: hash(stdout),
    stderr_sha256: hash(stderr),
    stdout_tail: stdout.slice(-4000),
    stderr_tail: stderr.slice(-4000),
  };
}

await fs.mkdir(path.dirname(artifact), { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
for (const spec of executions) {
  try {
    results.push(await runExecution(spec));
  } catch (error) {
    results.push({
      id: spec.id,
      script: spec.script,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 0,
      exit_code: -1,
      expected_output_matched: false,
      error: error instanceof Error ? error.message : String(error),
      stdout_sha256: null,
      stderr_sha256: null,
      stdout_tail: "",
      stderr_tail: "",
    });
  }
}

const byId = new Map(results.map((item) => [item.id, item]));
const rows = faultRows.map((row) => {
  const execution = byId.get(row.execution);
  return {
    ...row,
    status: execution?.exit_code === 0 && execution?.expected_output_matched ? "PASS" : "FAIL",
    actual_exit_code: execution?.exit_code ?? null,
    execution_script: execution?.script ?? null,
    execution_stdout_sha256: execution?.stdout_sha256 ?? null,
  };
});
const report = {
  marker: "NATIVE-LONG-RECOVERY-20261001-03",
  test: "recovery-fault-matrix",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  live_services_disrupted: false,
  isolated_fault_injection_only: true,
  rows,
  executions: results,
  pass_count: rows.filter((row) => row.status === "PASS").length,
  total_count: rows.length,
};
await fs.writeFile(artifact, JSON.stringify(report, null, 2) + "\n", "utf8");

if (report.pass_count !== report.total_count) {
  console.error(JSON.stringify({ test: report.test, status: "FAIL", artifact, pass_count: report.pass_count, total_count: report.total_count, failed: rows.filter((row) => row.status !== "PASS") }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ test: report.test, status: "PASS", artifact, pass_count: report.pass_count, total_count: report.total_count, execution_exit_codes: Object.fromEntries(results.map((item) => [item.id, item.exit_code])) }));
}
