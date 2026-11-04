#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { RecoveryFault, recoverTask } from "../dist/lib/recovery-engine.js";
import { writeRecoveryJson } from "../dist/lib/recovery-atomic-write.js";
import { durableRecoveryGoalKey, durableRecoveryPlanFingerprint } from "../dist/lib/service-recovery-plan.js";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}
for (const name of ["--workspace", "--state-root", "--artifact-root"]) {
  if (!arg(name)?.trim()) throw new Error("service-recovery-worker requires " + name);
}
const workspaceRoot = path.resolve(arg("--workspace"));
const stateRoot = path.resolve(arg("--state-root"));
const artifactRoot = path.resolve(arg("--artifact-root"));
const hostToken = arg("--host-token") || "";
const plansDir = path.join(stateRoot, "plans");
const activityFile = path.join(artifactRoot, "activity.jsonl");
const workerStatusFile = path.join(stateRoot, "worker-status.json");
if (!workspaceRoot || !stateRoot || !artifactRoot || !hostToken) throw new Error("service-recovery-worker requires workspace/state/artifact roots and host token");
await Promise.all([fs.mkdir(plansDir, { recursive: true }), fs.mkdir(artifactRoot, { recursive: true })]);

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function appendActivity(event, detail = {}) {
  await fs.appendFile(activityFile, JSON.stringify({
    at: new Date().toISOString(),
    source: "service-recovery-worker",
    event,
    worker_pid: process.pid,
    host_token_sha256_prefix: hostToken.slice(0, 8),
    ...detail,
  }) + "\n", "utf8");
}

async function atomicJson(file, value) {
  await writeRecoveryJson(file, value);
}

async function readPlans() {
  const plans = [];
  async function collect(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".plan.json")).sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        const file = path.join(directory, entry.name);
        const content = await fs.readFile(file, "utf8");
        const plan = JSON.parse(content);
        if (!plan || typeof plan.task_id !== "string" || !Array.isArray(plan.steps)) continue;
        plans.push({ file, content, plan });
      } catch {}
    }
  }
  // Legacy plans remain visible as blocked entries; never migrate or execute them.
  await collect(plansDir);
  let goals = [];
  try { goals = await fs.readdir(path.join(plansDir, "goals"), { withFileTypes: true }); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  for (const entry of goals.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    await collect(path.join(plansDir, "goals", entry.name));
  }
  return plans;
}

async function actionState(taskRoot, operationId, goalId) {
  const dir = path.join(taskRoot, ".action-state");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${createHash("sha256").update(operationId, "utf8").digest("hex")}.json`);
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.goal_id !== goalId) throw new Error("RECOVERY_ACTION_STATE_GOAL_SCOPE_MISMATCH");
    return { file, value };
  }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Preserve preexisting safe-name checkpoints without using Windows ADS
    // or path separators from externally supplied operation identifiers.
    if (/^[A-Za-z0-9._-]{1,160}$/.test(operationId)) {
      const legacy = path.join(dir, `${operationId}.json`);
      try {
        const value = JSON.parse(await fs.readFile(legacy, "utf8"));
        if (value.goal_id !== goalId) throw new Error("RECOVERY_ACTION_STATE_LEGACY_SCOPE_UNASSIGNED");
        await atomicJson(file, value);
        return { file, value };
      } catch (legacyError) {
        if (legacyError?.code !== "ENOENT") throw legacyError;
      }
    }
    return { file, value: { goal_id: goalId } };
  }
}

async function writeActionState(file, value) {
  await atomicJson(file, value);
}

function declaredCommandSideEffect(action) {
  return action.side_effect === "none" ? "none" : "unknown";
}

function pathWithin(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

async function resolvedPath(candidate) {
  try { return await fs.realpath(candidate); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw error;
    return path.join(await resolvedPath(parent), path.basename(candidate));
  }
}

async function requireWithin(root, candidate, code) {
  if (!pathWithin(root, candidate) || !pathWithin(await resolvedPath(root), await resolvedPath(candidate))) {
    throw new Error(code);
  }
}

async function terminateOwnedProcessTree(child) {
  const pid = Number(child?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 0) return { confirmed: false, method: "missing_pid" };
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    const taskkill = path.win32.join(root, "System32", "taskkill.exe");
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (confirmed, method, detail = undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ confirmed, method, detail });
      };
      const killer = spawn(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      killer.stderr.on("data", (chunk) => { stderr += chunk.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
      killer.once("error", (error) => finish(false, "taskkill_error", error.message));
      killer.once("close", (code) => finish(code === 0, "taskkill_tree", stderr.trim() || `exit ${code}`));
      const timer = setTimeout(() => {
        try { killer.kill(); } catch {}
        finish(false, "taskkill_timeout");
      }, 8000);
    });
  }
  try {
    child.kill("SIGKILL");
    return { confirmed: true, method: "sigkill_child" };
  } catch (error) {
    return { confirmed: false, method: "sigkill_error", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function persistCommandOutput(taskRoot, operationId, stdout, stderr, stdoutBytes, stderrBytes) {
  const outputDir = path.join(taskRoot, "command-output");
  await fs.mkdir(outputDir, { recursive: true });
  const outputId = createHash("sha256").update(String(operationId), "utf8").digest("hex").slice(0, 24);
  const stdoutFile = path.join(outputDir, `${outputId}.stdout.tail.log`);
  const stderrFile = path.join(outputDir, `${outputId}.stderr.tail.log`);
  await Promise.all([
    fs.writeFile(stdoutFile, stdout, "utf8"),
    fs.writeFile(stderrFile, stderr, "utf8"),
  ]);
  return {
    stdout_tail_file: stdoutFile,
    stderr_tail_file: stderrFile,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    stdout_tail_chars: stdout.length,
    stderr_tail_chars: stderr.length,
    stdout_truncated: stdoutBytes > Buffer.byteLength(stdout, "utf8"),
    stderr_truncated: stderrBytes > Buffer.byteLength(stderr, "utf8"),
    stdout_tail_sha256: createHash("sha256").update(stdout, "utf8").digest("hex"),
    stderr_tail_sha256: createHash("sha256").update(stderr, "utf8").digest("hex"),
  };
}

async function runCommand(action, taskRoot, heartbeat, operationId, allowedWorkspaceRoot) {
  const allowedRoot = path.resolve(allowedWorkspaceRoot || workspaceRoot);
  const cwd = path.resolve(action.cwd || allowedRoot);
  if (!pathWithin(allowedRoot, cwd) || !pathWithin(await resolvedPath(allowedRoot), await resolvedPath(cwd))) {
    throw new RecoveryFault("command_cwd_outside_workspace", {
      disposition: "block",
      sideEffect: "none",
      message: `command cwd is outside durable plan workspace: ${cwd}`,
    });
  }
  const timeoutMs = Math.max(100, Math.min(Number(action.timeout_ms || 30000), 300000));
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", String(action.command || "")]
    : ["-c", String(action.command || "")];
  return await new Promise((resolve, reject) => {
    const child = spawn(shell, args, { cwd, windowsHide: true, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timingOut = false;
    let settled = false;
    const beat = setInterval(() => void heartbeat("command_running").catch(() => undefined), 500);
    const timer = setTimeout(() => {
      if (settled) return;
      timingOut = true;
      void (async () => {
        const termination = await terminateOwnedProcessTree(child);
        const output = await persistCommandOutput(taskRoot, operationId, stdout, stderr, stdoutBytes, stderrBytes).catch(() => null);
        if (settled) return;
        settled = true;
        clearInterval(beat);
        const sideEffect = termination.confirmed && declaredCommandSideEffect(action) === "none" ? "none" : "unknown";
        reject(new RecoveryFault("timeout", {
          disposition: sideEffect === "none" ? "retry" : "block",
          sideEffect,
          message: `command timeout after ${timeoutMs}ms; process_tree=${termination.method}; confirmed=${termination.confirmed}; output=${output ? "persisted" : "unavailable"}`,
        }));
      })();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdoutBytes += chunk.length; stdout += chunk.toString(); if (stdout.length > 20000) stdout = stdout.slice(-20000); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; stderr += chunk.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.once("error", (error) => {
      if (settled || timingOut) return;
      settled = true;
      clearTimeout(timer); clearInterval(beat);
      reject(new RecoveryFault("process_exit", { disposition: "retry", sideEffect: "none", message: error.message }));
    });
    child.once("close", (code, signal) => {
      if (settled || timingOut) return;
      settled = true;
      clearTimeout(timer); clearInterval(beat);
      void (async () => {
        const output = await persistCommandOutput(taskRoot, operationId, stdout, stderr, stdoutBytes, stderrBytes).catch(() => null);
        if (code === 0) return resolve({ exit_code: code, signal, ...(output || {}) });
        const sideEffect = declaredCommandSideEffect(action);
        if (action.retry_on_nonzero === true && sideEffect === "none") {
          return reject(new RecoveryFault("process_exit", { disposition: "retry", sideEffect: "none", message: `command exit ${code}; output=${output ? "persisted" : "unavailable"}` }));
        }
        reject(new RecoveryFault("command_failed", {
          disposition: "block",
          sideEffect,
          message: `command exit ${code}; output=${output ? "persisted" : "unavailable"}`,
        }));
      })();
    });
  });
}

async function executeAction({ taskRoot, step, operation_id, heartbeat, allowedWorkspaceRoot, goalId }) {
  const action = step.spec?.action || {};
  const state = await actionState(taskRoot, operation_id, goalId);
  await heartbeat(`action:${action.kind || "noop"}`);

  if (action.kind === "fault_sequence") {
    const faults = Array.isArray(action.faults) ? action.faults.map(String) : [];
    const index = Number(state.value.fault_index || 0);
    if (index < faults.length) {
      await writeActionState(state.file, { ...state.value, fault_index: index + 1, updated_at: new Date().toISOString() });
      throw new RecoveryFault(faults[index], { disposition: "retry", sideEffect: "none" });
    }
    return { faults_consumed: faults.length };
  }

  if (action.kind === "crash_worker_once") {
    if (!state.value.crashed) {
      await writeActionState(state.file, { ...state.value, crashed: true, crashed_at: new Date().toISOString(), worker_pid: process.pid });
      await appendActivity("bounded_worker_crash_injected", { goal_id: goalId, task_id: step.task_id, step_id: step.id, operation_id });
      process.exit(Number(action.exit_code || 71));
    }
    if (action.effect_file) await fs.appendFile(path.join(taskRoot, action.effect_file), operation_id + "\n", "utf8");
    return { recovered_after_worker_crash: true };
  }

  if (action.kind === "append_then_crash_once") {
    const effectFile = path.join(taskRoot, action.effect_file || "effects.log");
    if (!state.value.crashed) {
      await fs.appendFile(effectFile, operation_id + "\n", "utf8");
      await writeActionState(state.file, { ...state.value, crashed: true, effect_written: true, crashed_at: new Date().toISOString(), worker_pid: process.pid });
      await appendActivity("unknown_effect_worker_crash_injected", { goal_id: goalId, task_id: step.task_id, step_id: step.id, operation_id });
      process.exit(Number(action.exit_code || 72));
    }
    await fs.appendFile(effectFile, operation_id + "\n", "utf8");
    return { replayed: true };
  }

  if (action.kind === "approval_wait") {
    throw new RecoveryFault("approval_pending", { disposition: "wait", sideEffect: "none" });
  }

  if (action.kind === "append") {
    const effectFile = path.join(taskRoot, action.effect_file || "effects.log");
    await fs.appendFile(effectFile, String(action.text || operation_id) + "\n", "utf8");
    return { appended: true };
  }

  if (action.kind === "command") return runCommand(action, taskRoot, heartbeat, operation_id, allowedWorkspaceRoot);
  throw new RecoveryFault("unsupported_action", { disposition: "block", sideEffect: "none", message: "Unsupported recovery action: " + String(action.kind) });
}

async function runPlan({ file, content, plan }) {
  if (plan.version !== 2 || typeof plan.goal_id !== "string" || !plan.goal_id) {
    throw new Error("RECOVERY_PLAN_LEGACY_SCOPE_UNASSIGNED");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(plan.task_id)) throw new Error("RECOVERY_TASK_ID_INVALID");
  const goalId = plan.goal_id;
  const goalKey = durableRecoveryGoalKey(goalId);
  const expectedPlanPath = path.join(plansDir, "goals", goalKey, `${plan.task_id}.plan.json`);
  if (path.resolve(file) !== path.resolve(expectedPlanPath)) throw new Error("RECOVERY_PLAN_GOAL_SCOPE_PATH_MISMATCH");
  const goalArtifactRoot = path.join(artifactRoot, "goals", goalKey);
  const expectedTaskRoot = path.join(goalArtifactRoot, "tasks", plan.task_id);
  const taskRoot = path.resolve(plan.artifact_root || expectedTaskRoot);
  const planWorkspaceRoot = path.resolve(plan.workspace_root || workspaceRoot);
  await requireWithin(workspaceRoot, planWorkspaceRoot, "RECOVERY_PLAN_WORKSPACE_MISMATCH");
  await requireWithin(artifactRoot, taskRoot, "RECOVERY_PLAN_ARTIFACT_OUTSIDE_ROOT");
  await requireWithin(goalArtifactRoot, taskRoot, "RECOVERY_PLAN_ARTIFACT_GOAL_SCOPE_MISMATCH");
  if (taskRoot !== path.resolve(expectedTaskRoot)) throw new Error("RECOVERY_PLAN_ARTIFACT_TASK_SCOPE_MISMATCH");
  await requireWithin(plansDir, file, "RECOVERY_PLAN_SOURCE_OUTSIDE_ROOT");
  const receiptPath = path.join(stateRoot, "submissions", "goals", goalKey, `${plan.task_id}.submission.json`);
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(receiptPath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("RECOVERY_PLAN_SUBMISSION_RECEIPT_MISSING");
    throw error;
  }
  if (receipt?.version !== 2 || receipt.goal_id !== goalId || receipt.task_id !== plan.task_id ||
      receipt.plan_path !== expectedPlanPath || receipt.receipt_path !== receiptPath ||
      receipt.artifact_root !== taskRoot ||
      receipt.plan_sha256 !== createHash("sha256").update(content, "utf8").digest("hex")) {
    throw new Error("RECOVERY_PLAN_MISMATCH: immutable submission receipt differs");
  }
  // Every asynchronous executor closes over this durable scope, not any active-Goal projection.
  const scope = Object.freeze({ goalId, goalKey, taskId: plan.task_id, taskRoot, workspaceRoot: planWorkspaceRoot });
  await fs.mkdir(taskRoot, { recursive: true });
  const enginePlan = {
    goal_id: scope.goalId,
    fingerprint: durableRecoveryPlanFingerprint({ ...plan, artifact_root: taskRoot, workspace_root: planWorkspaceRoot }),
    workspace_root: taskRoot,
    allowed_workspaces: [taskRoot],
    steps: plan.steps.map((spec, index) => ({
      id: String(spec.id || `step-${index + 1}`),
      name: String(spec.name || spec.id || `step-${index + 1}`),
      operation_id: typeof spec.operation_id === "string" ? spec.operation_id : undefined,
      replay_policy: spec.replay_policy === "never" ? "never" : "safe",
      spec_fingerprint: sha256Json({ goal_id: scope.goalId, spec }),
      spec,
    })),
  };
  // recovery-engine intentionally ignores extra spec fields, so retain a local
  // map by stable step id for the executor.
  const specs = new Map(enginePlan.steps.map((item) => [item.id, item.spec]));
  const runtimePlan = {
    goal_id: scope.goalId,
    fingerprint: enginePlan.fingerprint,
    workspace_root: enginePlan.workspace_root,
    allowed_workspaces: enginePlan.allowed_workspaces,
    steps: enginePlan.steps.map(({ spec, ...item }) => item),
  };
  const result = await recoverTask({
    workspaceRoot: taskRoot,
    taskId: plan.task_id,
    plan: runtimePlan,
    ownerId: `service-worker:${scope.goalKey}:${process.pid}`,
    leaseMs: Number(plan.lease_ms || 5000),
    maxAutomaticRecoveries: Number(plan.max_automatic_recoveries ?? 16),
    executor: async ({ step, operation_id, heartbeat }) => {
      const spec = specs.get(step.id) || {};
      const decorated = { ...step, spec, goal_id: scope.goalId, task_id: scope.taskId };
      await appendActivity("step_executor_enter", { goal_id: scope.goalId, task_id: scope.taskId, step_id: step.id, operation_id });
      const value = await executeAction({ taskRoot: scope.taskRoot, step: decorated, operation_id, heartbeat, allowedWorkspaceRoot: scope.workspaceRoot, goalId: scope.goalId });
      await appendActivity("step_executor_exit", { goal_id: scope.goalId, task_id: scope.taskId, step_id: step.id, operation_id });
      return value;
    },
  });
  await appendActivity("task_cycle", {
    goal_id: scope.goalId,
    task_id: scope.taskId,
    action: result.action,
    status: result.state?.status,
    recovery_count: result.state?.recovery_count,
    failure_reason: result.state?.failure_reason,
  });
  return result;
}

await appendActivity("worker_started");
while (!stopping) {
  const plans = await readPlans();
  const summaries = [];
  for (const record of plans) {
    const { plan } = record;
    if (stopping) break;
    try {
      const result = await runPlan(record);
      summaries.push({ goal_id: plan.goal_id, task_id: plan.task_id, action: result.action, status: result.state?.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const action = /LEGACY_SCOPE_UNASSIGNED|SUBMISSION_RECEIPT_MISSING/.test(message) ? "blocked" : "worker_error";
      summaries.push({ goal_id: plan.goal_id || null, task_id: plan.task_id, action, error: message });
      await appendActivity("task_worker_error", { goal_id: plan.goal_id || null, task_id: plan.task_id, message });
    }
  }
  await atomicJson(workerStatusFile, {
    version: 1,
    pid: process.pid,
    host_token_sha256_prefix: hostToken.slice(0, 8),
    heartbeat_at: new Date().toISOString(),
    plan_count: plans.length,
    summaries,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}
await appendActivity("worker_stopped");
