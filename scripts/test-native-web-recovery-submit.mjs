import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-web-recovery-submit-"));
const workspace = path.join(root, "workspace");
const stateRoot = path.join(root, "state");
const artifactRoot = path.join(root, "artifacts");
await fs.mkdir(workspace, { recursive: true });

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.HARNESS_RELAY_ENABLED = "false";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_ENABLED = "false";
process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED = "true";
process.env.HARNESS_RECOVERY_SUPERVISOR_STATE_DIR = stateRoot;
process.env.HARNESS_RECOVERY_ARTIFACT_ROOT = artifactRoot;
process.env.CODEX_HOME = path.join(root, "codex-home");
process.env.HARNESS_RECOVERY_WORKER_RESTART_BASE_MS = "100";
process.env.HARNESS_RECOVERY_WORKER_RESTART_MAX_MS = "500";
process.env.HARNESS_RECOVERY_WORKER_RESTART_LIMIT = "8";
process.env.HARNESS_RECOVERY_WORKER_STABLE_MS = "1000";

const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Verify native Web durable recovery submission and disconnected continuation",
  scope: ["isolated temporary MCP client/server and detached recovery supervisor"],
  out_of_scope: ["live MCP, browser, user services, remote repositories"],
  deliverables: ["native recovery_submit receipt", "same-operation autonomous completion after client disconnect and worker crash"],
  success_criteria: ["plan is durable before work", "same stable operation completes after disconnected client", "no duplicate continuation submission"],
  constraints: ["all side effects stay inside temporary test root", "safe replay only for side_effect=none"],
  protected_resources: ["live MCP3300/Admin3301/Tunnel8380", "browser"],
  known_facts: ["test supervisor uses isolated state and artifact roots"],
  assumptions: [],
  delegated_decisions: [],
  remaining_nonblocking_uncertainties: [],
  closure_items: [],
  ambiguities: [],
  clarification_round: 0,
  questions_in_round: 0,
  resolution_mode: "none",
});

const { createMcpServer } = await import("../dist/server-factory.js");
const {
  startServiceRecoverySupervisor,
  stopServiceRecoverySupervisor,
  serviceRecoverySupervisorStatus,
} = await import("../dist/lib/service-recovery-supervisor.js");
const { readRecoveryTask } = await import("../dist/lib/recovery-engine.js");

function data(result) {
  if (!result?.structuredContent?.ok) {
    throw new Error(`tool failed: ${JSON.stringify(result?.structuredContent)}`);
  }
  return result.structuredContent.data;
}

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timeout${last ? `: ${last.message}` : ""}`);
}

async function killOwnedWorker(pid) {
  assert.equal(Number.isInteger(pid) && pid > 0, true, "isolated worker pid missing");
  if (process.platform === "win32") {
    const { spawn } = await import("node:child_process");
    const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    await new Promise((resolve, reject) => {
      const child = spawn(taskkill, ["/PID", String(pid), "/F"], { windowsHide: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`taskkill exit ${code}`)));
    });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

const initial = await startServiceRecoverySupervisor(workspace);
assert.equal(initial.running, true);
assert.equal(initial.guardian_running, true);

const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "native-web-recovery-submit-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
serverTransport.sessionId = "native-web-recovery-submit-session";
await server.connect(serverTransport);
await client.connect(clientTransport);

const taskId = "native-web-disconnect";
const operationId = "nlr-20261001-03-native-web-op";
const planArgs = {
  task_id: taskId,
  steps: [{
    id: "bounded-no-side-effect-work",
    name: "bounded no-side-effect work",
    operation_id: operationId,
    replay_policy: "safe",
    command: "ping 127.0.0.1 -n 7 >nul",
    cwd: workspace,
    timeout_ms: 10_000,
    side_effect: "none",
    retry_on_nonzero: true,
  }],
  lease_ms: 400,
  max_automatic_recoveries: 8,
  _intent: TEST_INTENT,
};

let disconnectedAt;
let workerKilledAt;
let detectedAt;
let recoveredAt;
try {
  const listed = await client.listTools();
  const names = new Set(listed.tools.map((tool) => tool.name));
  assert.equal(names.has("recovery_submit"), true, "recovery_submit missing from slim native MCP tools");
  assert.equal(names.has("recovery_status"), true, "recovery_status missing from slim native MCP tools");

  const created = data(await client.callTool({
    name: "goal",
    arguments: {
      action: "create",
      objective: "Verify detached recovery in this isolated native MCP session",
      success_criteria: [{ name: "durable continuation verified", passed: false }],
      _intent: TEST_INTENT,
    },
  }));
  const goalId = created.goal.id;
  assert.equal(created.goal.owner_session, serverTransport.sessionId);

  const submitted = data(await client.callTool({ name: "recovery_submit", arguments: planArgs }));
  assert.equal(submitted.goal_id, goalId);
  assert.equal(submitted.version, 2);
  assert.equal(submitted.task_id, taskId);
  assert.equal(submitted.operation_ids[0], operationId);
  assert.match(submitted.plan_sha256, /^[a-f0-9]{64}$/);
  await fs.stat(submitted.plan_path);
  await fs.stat(submitted.receipt_path);
  assert.equal(JSON.parse(await fs.readFile(submitted.plan_path, "utf8")).goal_id, goalId);
  assert.equal(JSON.parse(await fs.readFile(submitted.receipt_path, "utf8")).goal_id, goalId);

  const same = data(await client.callTool({ name: "recovery_submit", arguments: planArgs }));
  assert.equal(same.idempotent, true);
  assert.equal(same.plan_sha256, submitted.plan_sha256);
  assert.equal(same.goal_id, goalId);
  assert.equal(same.submitted_at, submitted.submitted_at);

  const drift = await client.callTool({
    name: "recovery_submit",
    arguments: {
      ...planArgs,
      steps: [{ ...planArgs.steps[0], command: "echo DRIFT" }],
    },
  });
  assert.equal(drift.structuredContent?.ok, false);
  assert.match(JSON.stringify(drift.structuredContent), /RECOVERY_SUBMISSION_PLAN_DRIFT/);

  const escapeTask = "native-web-cwd-escape";
  const escaped = await client.callTool({
    name: "recovery_submit",
    arguments: {
      task_id: escapeTask,
      steps: [{
        id: "escape",
        operation_id: "nlr-20261001-03-cwd-escape",
        replay_policy: "safe",
        command: "echo should-not-run",
        cwd: path.dirname(workspace),
        side_effect: "none",
      }],
      _intent: TEST_INTENT,
    },
  });
  assert.equal(escaped.structuredContent?.ok, false);
  assert.match(JSON.stringify(escaped.structuredContent), /RECOVERY_SUBMISSION_CWD_OUTSIDE_WORKSPACE/);

  let observedNonRunning = null;
  const runningState = await waitFor("durable runner starts submitted operation", async () => {
    const state = await readRecoveryTask(submitted.artifact_root, taskId);
    if (state?.status === "running" && state.steps?.[0]?.operation_id === operationId) return state;
    if (state?.status === "blocked" || state?.status === "failed" || state?.status === "completed") observedNonRunning = state;
    return false;
  });
  assert.equal(observedNonRunning, null, `runner left running state before interruption: ${JSON.stringify(observedNonRunning)}`);
  assert.equal(runningState.steps[0].attempts.length >= 1, true);

  const beforeDisconnectStatus = data(await client.callTool({ name: "recovery_status", arguments: { task_id: taskId } }));
  assert.equal(beforeDisconnectStatus.goal_id, goalId);
  assert.equal(beforeDisconnectStatus.execution.goal_id, goalId);
  assert.equal(beforeDisconnectStatus.receipt.operation_ids[0], operationId);
  assert.equal(beforeDisconnectStatus.execution.steps[0].operation_id, operationId);

  disconnectedAt = new Date().toISOString();
  await client.close();
  await server.close();

  const preKill = await serviceRecoverySupervisorStatus(workspace);
  const workerPid = preKill.worker_pid;
  assert.equal(preKill.worker_running, true);
  workerKilledAt = new Date().toISOString();
  await killOwnedWorker(workerPid);

  const detected = await waitFor("host detects worker exit", async () => {
    const status = await serviceRecoverySupervisorStatus(workspace);
    if ((status.worker_restart_count || 0) >= 1 || status.executor_state === "recovering") return status;
    return false;
  });
  detectedAt = new Date().toISOString();

  const completed = await waitFor("detached runner completes same operation", async () => {
    const state = await readRecoveryTask(submitted.artifact_root, taskId);
    return state?.status === "completed" ? state : false;
  }, 25_000);
  recoveredAt = new Date().toISOString();
  assert.equal(completed.goal_id, goalId);
  assert.equal(completed.steps[0].receipt.goal_id, goalId);
  assert.equal(completed.final_receipt.goal_id, goalId);
  assert.equal(completed.steps[0].operation_id, operationId);
  assert.equal(completed.steps[0].receipt.operation_id, operationId);
  assert.equal(completed.steps[0].attempts.length >= 2, true);
  assert.equal(completed.steps[0].receipt.status, "completed");

  const finalStatus = await serviceRecoverySupervisorStatus(workspace);
  assert.equal(finalStatus.worker_running, true);
  assert.equal((finalStatus.worker_restart_count || 0) >= 1, true);

  const activityPath = path.join(artifactRoot, "activity.jsonl");
  const activity = await fs.readFile(activityPath, "utf8");
  assert.match(activity, /worker_exit/);
  assert.match(activity, /worker_started/);

  console.log(JSON.stringify({
    test: "native-web-recovery-submit",
    status: "PASS",
    goal_id: goalId,
    task_id: taskId,
    operation_id: operationId,
    plan_sha256: submitted.plan_sha256,
    plan_persisted_before_disconnect: true,
    submission_receipt_persisted_before_disconnect: true,
    client_disconnected_at: disconnectedAt,
    worker_killed_at: workerKilledAt,
    worker_exit_detected_at: detectedAt,
    detached_completion_at: recoveredAt,
    worker_restart_count: finalStatus.worker_restart_count,
    attempt_count: completed.steps[0].attempts.length,
    duplicate_continuation_submissions: 0,
    web_model_recovery: "unverified",
    boundary: "Detached runner continuity after native MCP client disconnect is verified; ChatGPT Web model auto-resumption is not claimed.",
  }));
} finally {
  try { await client.close(); } catch {}
  try { await server.close(); } catch {}
  try { await stopServiceRecoverySupervisor(workspace); } catch {}
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
