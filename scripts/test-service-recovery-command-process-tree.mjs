import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readRecoveryTask } from "../dist/lib/recovery-engine.js";

import { recoveryFixturePaths, writeRecoveryPlanFixture } from "./lib/recovery-plan-fixture.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function commandOutput(taskRoot) {
  const dir = path.join(taskRoot, "command-output");
  try {
    const names = await fs.readdir(dir);
    const entries = {};
    for (const name of names.sort()) {
      entries[name] = await fs.readFile(path.join(dir, name), "utf8");
    }
    return entries;
  } catch {
    return {};
  }
}

async function waitFor(label, predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timeout${last ? `: ${last.message}` : ""}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-process-tree-"));
const workspace = path.join(root, "workspace");
const stateRoot = path.join(root, "state");
const artifactRoot = path.join(root, "artifacts");
const plansDir = path.join(stateRoot, "plans");
const goalId = "recovery-command-fixture-goal";
const scopedPaths = (taskId) => recoveryFixturePaths({ stateRoot, artifactRoot, goalId, taskId });
const publishPlan = (plan) => writeRecoveryPlanFixture({ stateRoot, artifactRoot, workspaceRoot: workspace, goalId, plan });
await Promise.all([
  fs.mkdir(workspace, { recursive: true }),
  fs.mkdir(plansDir, { recursive: true }),
  fs.mkdir(artifactRoot, { recursive: true }),
]);

const childScript = path.join(workspace, "delayed-child.ps1");
await fs.writeFile(childScript, [
  "param([string]$Started,[string]$Late)",
  "Set-Content -LiteralPath $Started -Value 'STARTED'",
  "Start-Sleep -Milliseconds 4000",
  "Set-Content -LiteralPath $Late -Value 'LATE'",
  "Start-Sleep -Seconds 30",
].join("\n") + "\n", "utf8");
const launcher = path.join(workspace, "detached-launcher.ps1");
await fs.writeFile(launcher, [
  "param([string]$ChildScript,[string]$Started,[string]$Late,[string]$Launched)",
  "$args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ChildScript,'-Started',$Started,'-Late',$Late)",
  "$child = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -PassThru",
  "Set-Content -LiteralPath $Launched -Value $child.Id",
  "Start-Sleep -Seconds 10",
].join("\n") + "\n", "utf8");

const host = spawn(process.execPath, [
  path.join(sourceRoot, "scripts", "service-recovery-host.mjs"),
  "--workspace", workspace,
  "--state-root", stateRoot,
  "--artifact-root", artifactRoot,
  "--launch-token", "phase5-process-tree-test",
], {
  cwd: sourceRoot,
  env: {
    ...process.env,
    HARNESS_RECOVERY_WORKER_RESTART_BASE_MS: "100",
    HARNESS_RECOVERY_WORKER_RESTART_MAX_MS: "500",
    HARNESS_RECOVERY_WORKER_RESTART_LIMIT: "4",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

try {
  const hostStatusFile = path.join(stateRoot, "host-status.json");
  await waitFor("worker ready", async () => {
    const status = await readJson(hostStatusFile);
    return status.worker_pid ? status : false;
  });

  const taskId = "timeout-tree";
  const taskRoot = scopedPaths(taskId).taskRoot;
  const started = path.join(taskRoot, "started-marker.txt");
  const marker = path.join(taskRoot, "late-marker.txt");
  const launched = path.join(taskRoot, "launched-marker.txt");
  const command = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File detached-launcher.ps1 -ChildScript ${childScript} -Started ${started} -Late ${marker} -Launched ${launched}`;
  await publishPlan({
    task_id: taskId,
    artifact_root: taskRoot,
    steps: [{
      id: "timed-command",
      operation_id: "nlr-20261001-03-timeout-tree",
      replay_policy: "never",
      action: {
        kind: "command",
        command,
        cwd: workspace,
        timeout_ms: 2000,
        side_effect: "unknown",
      },
    }],
  });

  const state = await waitFor("timed command blocked", async () => {
    const value = await readRecoveryTask(taskRoot, taskId);
    return value?.status === "blocked" ? value : false;
  });
  assert.equal(state.steps[0].attempts.length, 1);
  assert.equal(state.steps[0].failure_reason === "unknown_side_effect_result" || state.steps[0].failure_reason === "timeout", true);
  const output = await commandOutput(taskRoot);
  assert.equal(await exists(launched), true, `launcher did not spawn the detached descendant before timeout; output=${JSON.stringify(output)}`);
  assert.equal(await exists(started), true, `descendant did not start before timeout; process-tree assertion would be invalid; output=${JSON.stringify(output)}`);

  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(await exists(marker), false, "timed-out descendant survived and produced a late side effect");

  const outputTask = "stdout-stderr-boundary";
  const outputTaskRoot = scopedPaths(outputTask).taskRoot;
  await publishPlan({
    task_id: outputTask,
    artifact_root: outputTaskRoot,
    steps: [{
      id: "emit-boundaries",
      operation_id: "nlr-20261001-03-output-boundaries",
      replay_policy: "safe",
      action: {
        kind: "command",
        command: "echo STDOUT-BOUNDARY & echo STDERR-BOUNDARY 1>&2",
        cwd: workspace,
        timeout_ms: 5000,
        side_effect: "none",
      },
    }],
  });
  const outputState = await waitFor("stdout stderr command completes", async () => {
    const value = await readRecoveryTask(outputTaskRoot, outputTask);
    return value?.status === "completed" ? value : false;
  });
  assert.match(outputState.steps[0].receipt?.result_sha256 || "", /^[a-f0-9]{64}$/);
  const outputFiles = await commandOutput(outputTaskRoot);
  const outputText = Object.values(outputFiles).join("\n");
  assert.match(outputText, /STDOUT-BOUNDARY/);
  assert.match(outputText, /STDERR-BOUNDARY/);
  assert.equal(Object.keys(outputFiles).some((name) => name.endsWith(".stdout.tail.log")), true);
  assert.equal(Object.keys(outputFiles).some((name) => name.endsWith(".stderr.tail.log")), true);

  const nonzeroTask = "nonzero-default-unknown";
  const nonzeroTaskRoot = scopedPaths(nonzeroTask).taskRoot;
  await publishPlan({
    task_id: nonzeroTask,
    artifact_root: nonzeroTaskRoot,
    steps: [{
      id: "nonzero",
      operation_id: "nlr-20261001-03-nonzero-unknown",
      replay_policy: "safe",
      action: {
        kind: "command",
        command: "echo NONZERO-STDOUT & echo NONZERO-STDERR 1>&2 & exit /b 9",
        cwd: workspace,
        timeout_ms: 5000,
        retry_on_nonzero: true,
      },
    }],
  });
  const nonzeroState = await waitFor("nonzero unknown blocks", async () => {
    const value = await readRecoveryTask(nonzeroTaskRoot, nonzeroTask);
    return value?.status === "blocked" ? value : false;
  });
  assert.equal(nonzeroState.steps[0].attempts.length, 1);
  assert.equal(nonzeroState.steps[0].failure_reason, "unknown_side_effect_result");
  const nonzeroOutput = await commandOutput(nonzeroTaskRoot);
  assert.match(Object.values(nonzeroOutput).join("\n"), /NONZERO-STDOUT/);
  assert.match(Object.values(nonzeroOutput).join("\n"), /NONZERO-STDERR/);

  console.log(JSON.stringify({
    test: "service-recovery-command-process-tree",
    status: "PASS",
    platform: process.platform,
    timeout_status: state.status,
    failure_reason: state.steps[0].failure_reason,
    descendant_started: true,
    late_side_effect: false,
    stdout_stderr_persisted: true,
    nonzero_default_unknown_attempts: nonzeroState.steps[0].attempts.length,
    nonzero_default_unknown_failure: nonzeroState.steps[0].failure_reason,
  }));
} finally {
  try { host.kill("SIGTERM"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { if (host.exitCode === null) host.kill("SIGKILL"); } catch {}
  await fs.rm(root, { recursive: true, force: true });
}
