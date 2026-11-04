import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessEnv } from "./child-env.js";

export interface GoalWatchdogStatus {
  running: boolean;
  state: "on" | "off";
  mode: "goal_scoped";
  lifecycle: "managed_by_goal";
  role: "fallback_alert_only";
  parent_bound: boolean;
  pid?: number;
  parent_pid?: number;
  workspace?: string;
  session_id?: string;
}

const watchdogs = new Map<string, ChildProcess>();

function sessionSegment(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || undefined;
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

function watchdogPidFile(workspaceRoot: string, sessionId?: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const segment = sessionSegment(sessionId);
  const stateDir = segment
    ? path.join(base, "projects", projectSlug(workspaceRoot), "sessions", segment)
    : path.join(base, "projects", projectSlug(workspaceRoot));
  return path.join(stateDir, "goal-watchdog.pid.json");
}

function watchdogKey(workspaceRoot: string, sessionId?: string): string {
  const resolved = path.resolve(workspaceRoot);
  const segment = sessionSegment(sessionId);
  return segment ? `${resolved}\0${segment}` : resolved;
}

function stoppedStatus(): GoalWatchdogStatus {
  return {
    running: false,
    state: "off",
    mode: "goal_scoped",
    lifecycle: "managed_by_goal",
    role: "fallback_alert_only",
    parent_bound: false,
  };
}

function scriptPath(): string {
  // src/lib -> repo/scripts in ts-node/source mode; dist/lib -> repo/scripts after build.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "goal-watchdog.mjs");
}

function childRunning(child: ChildProcess | null): child is ChildProcess {
  return Boolean(child && child.exitCode === null && !child.killed);
}

function statusFromEntry(key: string, child: ChildProcess | null): GoalWatchdogStatus {
  if (!childRunning(child)) return stoppedStatus();
  const [workspace, sessionId] = key.split("\0");
  return {
    running: true,
    state: "on",
    mode: "goal_scoped",
    lifecycle: "managed_by_goal",
    role: "fallback_alert_only",
    parent_bound: true,
    ...(child.pid ? { pid: child.pid } : {}),
    parent_pid: process.pid,
    workspace,
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

export function goalWatchdogStatus(workspaceRoot?: string, sessionId?: string): GoalWatchdogStatus {
  const resolved = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
  const exactKey = resolved ? watchdogKey(resolved, sessionId) : undefined;
  const entries = exactKey
    ? [[exactKey, watchdogs.get(exactKey) ?? null] as const]
    : resolved
      ? [...watchdogs.entries()].filter(([key]) => key === resolved || key.startsWith(`${resolved}\0`))
      : [...watchdogs.entries()];
  for (const [key, child] of entries) {
    if (!childRunning(child)) watchdogs.delete(key);
  }
  const currentEntry = exactKey
    ? [exactKey, watchdogs.get(exactKey) ?? null] as const
    : [...watchdogs.entries()][0];
  return currentEntry ? statusFromEntry(currentEntry[0], currentEntry[1]) : stoppedStatus();
}

export function startGoalWatchdog(workspaceRoot: string, sessionId?: string): GoalWatchdogStatus {
  const resolved = path.resolve(workspaceRoot);
  const key = watchdogKey(resolved, sessionId);
  const currentChild = watchdogs.get(key) ?? null;
  if (childRunning(currentChild)) return statusFromEntry(key, currentChild);
  watchdogs.delete(key);

  const child = spawn(process.execPath, [scriptPath()], {
    cwd: path.resolve(path.dirname(scriptPath()), ".."),
    env: {
      ...childProcessEnv(),
      WATCH_WORKSPACE: resolved,
      ...(sessionId ? { WATCH_SESSION_ID: sessionId } : {}),
      WATCHDOG_PID_FILE: watchdogPidFile(resolved, sessionId),
      WATCHDOG_PARENT_PID: String(process.pid),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  watchdogs.set(key, child);
  child.once("exit", () => {
    if (watchdogs.get(key) === child) watchdogs.delete(key);
    void cleanupPidFileAfterExit(watchdogPidFile(resolved, sessionId), child.pid);
  });
  return statusFromEntry(key, child);
}

async function cleanupPidFileAfterExit(pidFile: string, pid: number | undefined): Promise<void> {
  if (!pid) return;
  try {
    const raw = await fs.readFile(pidFile, "utf8");
    const record = JSON.parse(raw) as { pid?: unknown };
    if (record.pid === pid) await fs.rm(pidFile, { force: true });
  } catch {
    // A missing or already-replaced pid record is the desired end state.
  }
}

export function stopGoalWatchdog(workspaceRoot?: string, sessionId?: string): GoalWatchdogStatus {
  const resolved = workspaceRoot ? path.resolve(workspaceRoot) : undefined;
  const exactKey = resolved && sessionId ? watchdogKey(resolved, sessionId) : undefined;
  const targets = exactKey
    ? [exactKey]
    : resolved
      ? [...watchdogs.keys()].filter((key) => key === resolved || key.startsWith(`${resolved}\0`))
      : [...watchdogs.keys()];
  for (const key of targets) {
    const child = watchdogs.get(key) ?? null;
    watchdogs.delete(key);
    if (childRunning(child)) {
    try {
      child.kill();
    } catch {}
    }
  }
  return resolved ? goalWatchdogStatus(resolved, sessionId) : stoppedStatus();
}
