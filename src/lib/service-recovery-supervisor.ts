import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv } from "./child-env.js";
import { readProcessStartIdentity } from "./process-journal.js";
import { assertRecoveryBackgroundIngress } from "./recovery-non-mcp-fence.js";

export interface ServiceRecoverySupervisorStatus {
  enabled: boolean;
  running: boolean;
  pid?: number;
  process_start_identity?: string;
  instance_token?: string;
  guardian_running?: boolean;
  guardian_pid?: number;
  guardian_process_start_identity?: string;
  guardian_instance_token?: string;
  worker_pid?: number | null;
  worker_running?: boolean;
  worker_process_start_identity?: string;
  worker_restart_count?: number;
  executor_state?: "running" | "recovering" | "dead" | "unknown";
  state_root: string;
  artifact_root: string;
  plans_dir: string;
  detail: string;
}

export type RecoveryContinuityClassification =
  | "healthy"
  | "tool_disconnected_executor_alive"
  | "executor_unavailable"
  | "indeterminate";

export function classifyRecoveryContinuity(
  toolTransportReachable: boolean,
  status: Pick<ServiceRecoverySupervisorStatus, "running" | "guardian_running" | "worker_running" | "executor_state">
): RecoveryContinuityClassification {
  if (status.executor_state === "running" && status.worker_running === true) {
    return toolTransportReachable ? "healthy" : "tool_disconnected_executor_alive";
  }
  if (status.executor_state === "dead" || (!status.running && !status.guardian_running)) {
    return "executor_unavailable";
  }
  return "indeterminate";
}

interface HostPidRecord {
  version: 1;
  pid: number;
  process_start_identity: string | null;
  instance_token: string;
  workspace_root: string;
  state_root: string;
  artifact_root: string;
  plans_dir: string;
  started_at: string;
}

interface GuardianPidRecord {
  version: 1;
  pid: number;
  process_start_identity: string | null;
  instance_token: string;
  workspace_root: string;
  state_root: string;
  artifact_root: string;
  started_at: string;
  launch_token?: string;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value || "").trim().toLowerCase());
}

export function serviceRecoverySupervisorEnabled(): boolean {
  return truthy(process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED);
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot).toLowerCase()).digest("hex").slice(0, 16);
}

export function serviceRecoverySupervisorPaths(workspaceRoot: string): {
  stateRoot: string;
  artifactRoot: string;
  plansDir: string;
  pidFile: string;
  statusFile: string;
  stopFile: string;
  guardianPidFile: string;
  guardianStatusFile: string;
  guardianStopFile: string;
  activityFile: string;
} {
  const resolved = path.resolve(workspaceRoot);
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const stateRoot = path.resolve(
    process.env.HARNESS_RECOVERY_SUPERVISOR_STATE_DIR ||
      path.join(home, "service-recovery", projectSlug(resolved))
  );
  const artifactRoot = path.resolve(
    process.env.HARNESS_RECOVERY_ARTIFACT_ROOT ||
      path.join(resolved, "artifacts", "service-recovery")
  );
  const plansDir = path.join(stateRoot, "plans");
  return {
    stateRoot,
    artifactRoot,
    plansDir,
    pidFile: path.join(stateRoot, "host.pid.json"),
    statusFile: path.join(stateRoot, "host-status.json"),
    stopFile: path.join(stateRoot, "stop.request.json"),
    guardianPidFile: path.join(stateRoot, "guardian.pid.json"),
    guardianStatusFile: path.join(stateRoot, "guardian-status.json"),
    guardianStopFile: path.join(stateRoot, "guardian-stop.request.json"),
    activityFile: path.join(artifactRoot, "activity.jsonl"),
  };
}

function hostScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "service-recovery-host.mjs");
}

function guardianScriptPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "service-recovery-guardian.mjs");
}

async function readPidRecord(pidFile: string): Promise<HostPidRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(pidFile, "utf8")) as HostPidRecord;
    if (parsed.version !== 1 || !Number.isInteger(parsed.pid) || !parsed.instance_token) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function readGuardianPidRecord(pidFile: string): Promise<GuardianPidRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(pidFile, "utf8")) as GuardianPidRecord;
    if (parsed.version !== 1 || !Number.isInteger(parsed.pid) || !parsed.instance_token) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function recordAlive(record: HostPidRecord | null): Promise<boolean> {
  if (!record?.pid || !record.process_start_identity) return false;
  return (await readProcessStartIdentity(record.pid)) === record.process_start_identity;
}

export async function serviceRecoverySupervisorStatus(workspaceRoot: string): Promise<ServiceRecoverySupervisorStatus> {
  const paths = serviceRecoverySupervisorPaths(workspaceRoot);
  const record = await readPidRecord(paths.pidFile);
  const alive = await recordAlive(record);
  const guardian = await readGuardianPidRecord(paths.guardianPidFile);
  const guardianAlive = await recordAlive(guardian as HostPidRecord | null);
  let status: Record<string, unknown> | null = null;
  try {
    status = JSON.parse(await fs.readFile(paths.statusFile, "utf8")) as Record<string, unknown>;
  } catch {}
  const workerPid = typeof status?.worker_pid === "number" ? status.worker_pid : null;
  const workerExpectedIdentity = typeof status?.worker_process_start_identity === "string"
    ? status.worker_process_start_identity
    : null;
  const workerObservedIdentity = workerPid ? await readProcessStartIdentity(workerPid) : null;
  const workerAlive = Boolean(
    alive &&
    workerPid &&
    workerExpectedIdentity &&
    workerObservedIdentity === workerExpectedIdentity
  );
  const workerRestartSuppressed = status?.worker_restart_suppressed === true;
  const nextWorkerRestartAt = typeof status?.next_worker_restart_at === "string" ? status.next_worker_restart_at : null;
  const executorState: ServiceRecoverySupervisorStatus["executor_state"] = workerAlive
    ? "running"
    : (!alive && guardianAlive)
      ? "recovering"
      : (alive && (nextWorkerRestartAt || (!workerRestartSuppressed && workerPid === null)))
        ? "recovering"
        : (workerRestartSuppressed || (!alive && !guardianAlive))
          ? "dead"
          : "unknown";
  return {
    enabled: serviceRecoverySupervisorEnabled(),
    running: alive,
    ...(alive && record ? {
      pid: record.pid,
      process_start_identity: record.process_start_identity || undefined,
      instance_token: record.instance_token,
      worker_pid: workerPid,
      worker_running: workerAlive,
      ...(workerExpectedIdentity ? { worker_process_start_identity: workerExpectedIdentity } : {}),
      worker_restart_count: typeof status?.worker_restart_count === "number" ? status.worker_restart_count : 0,
    } : {}),
    guardian_running: guardianAlive,
    ...(guardianAlive && guardian ? {
      guardian_pid: guardian.pid,
      guardian_process_start_identity: guardian.process_start_identity || undefined,
      guardian_instance_token: guardian.instance_token,
    } : {}),
    state_root: paths.stateRoot,
    artifact_root: paths.artifactRoot,
    plans_dir: paths.plansDir,
    executor_state: executorState,
    detail: alive
      ? (workerAlive
          ? (guardianAlive ? "detached recovery guardian, host, and worker are alive" : "detached recovery host and worker are alive without lifecycle guardian")
          : `detached recovery host is alive; executor is ${executorState}`)
      : (guardianAlive ? "detached recovery guardian is alive and host is recovering" : "detached recovery host is not running"),
  };
}

export async function startServiceRecoverySupervisor(workspaceRoot: string): Promise<ServiceRecoverySupervisorStatus> {
  assertRecoveryBackgroundIngress("service_recovery_supervisor.start");
  const paths = serviceRecoverySupervisorPaths(workspaceRoot);
  if (!serviceRecoverySupervisorEnabled()) {
    return {
      enabled: false,
      running: false,
      state_root: paths.stateRoot,
      artifact_root: paths.artifactRoot,
      plans_dir: paths.plansDir,
      detail: "disabled by HARNESS_RECOVERY_SUPERVISOR_ENABLED",
    };
  }
  await fs.mkdir(paths.stateRoot, { recursive: true });
  await fs.mkdir(paths.plansDir, { recursive: true });
  await fs.mkdir(paths.artifactRoot, { recursive: true });

  const existingGuardian = await readGuardianPidRecord(paths.guardianPidFile);
  if (!(await recordAlive(existingGuardian as HostPidRecord | null))) {
    await fs.rm(paths.guardianPidFile, { force: true }).catch(() => undefined);
    await fs.rm(paths.guardianStopFile, { force: true }).catch(() => undefined);
    const launchToken = randomUUID();
    const child = spawn(process.execPath, [
    guardianScriptPath(),
    "--workspace", path.resolve(workspaceRoot),
    "--state-root", paths.stateRoot,
    "--artifact-root", paths.artifactRoot,
    "--launch-token", launchToken,
  ], {
    cwd: path.resolve(path.dirname(guardianScriptPath()), ".."),
    env: childProcessEnv({
      HARNESS_RECOVERY_SUPERVISOR_CHILD: "1",
      HARNESS_RECOVERY_SUPERVISOR_STATE_DIR: paths.stateRoot,
      HARNESS_RECOVERY_ARTIFACT_ROOT: paths.artifactRoot,
    }),
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  }

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const status = await serviceRecoverySupervisorStatus(workspaceRoot);
    if (status.running && status.guardian_running) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("RECOVERY_SUPERVISOR_START_TIMEOUT: detached guardian/host did not publish live pid identities");
}

export async function stopServiceRecoverySupervisor(workspaceRoot: string): Promise<ServiceRecoverySupervisorStatus> {
  assertRecoveryBackgroundIngress("service_recovery_supervisor.stop");
  const paths = serviceRecoverySupervisorPaths(workspaceRoot);
  const guardian = await readGuardianPidRecord(paths.guardianPidFile);
  if (await recordAlive(guardian as HostPidRecord | null) && guardian) {
    const request = {
      version: 1,
      instance_token: guardian.instance_token,
      requested_at: new Date().toISOString(),
      requested_by_pid: process.pid,
    };
    const temp = `${paths.guardianStopFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(request, null, 2) + "\n", "utf8");
    await fs.rename(temp, paths.guardianStopFile);

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const status = await serviceRecoverySupervisorStatus(workspaceRoot);
      if (!status.running && !status.guardian_running) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("RECOVERY_SUPERVISOR_STOP_TIMEOUT: lifecycle guardian/host did not stop after token-scoped request");
  }

  // Backward-compatible stop for an already-running legacy host from a build
  // that predates the lifecycle guardian.
  const record = await readPidRecord(paths.pidFile);
  if (!(await recordAlive(record)) || !record) {
    await fs.rm(paths.pidFile, { force: true }).catch(() => undefined);
    return serviceRecoverySupervisorStatus(workspaceRoot);
  }
  const request = {
    version: 1,
    instance_token: record.instance_token,
    requested_at: new Date().toISOString(),
    requested_by_pid: process.pid,
  };
  const temp = `${paths.stopFile}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(request, null, 2) + "\n", "utf8");
  await fs.rename(temp, paths.stopFile);

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const status = await serviceRecoverySupervisorStatus(workspaceRoot);
    if (!status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RECOVERY_SUPERVISOR_STOP_TIMEOUT: detached host did not stop after token-scoped request");
}
