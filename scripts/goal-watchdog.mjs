#!/usr/bin/env node
/**
 * Goal Watchdog(T1 半自动看门狗)
 *
 * 直读生产状态文件(不经过 MCP 进程):
 *   goal active + criteria 未满足 + 高价值活动间隔超过阈值
 *     → Windows 弹窗提醒用户回来按一下继续(发送动作永远由人执行)。
 *
 * 与 MCP 内部 recordGoalStallTelemetry 的判定语义保持一致:
 *   同一 GOAL_STALL_GAP_MS 阈值;blocked 让位不算 stall;
 *   活动时间取 goal.updated_at 与 task.updated_at 较新者。
 *
 * 本脚本同时是数据采集器:每次提醒追加写入 watchdog 日志(*.log,已 gitignore)。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const WORKSPACE = path.resolve(process.env.WATCH_WORKSPACE || "D:\\web-local");
const GAP_MS = posInt(process.env.GOAL_STALL_GAP_MS, 10 * 60 * 1000);
const POLL_MS = posInt(process.env.WATCHDOG_POLL_MS, 60 * 1000);
const REMIND_MS = posInt(process.env.WATCHDOG_REMIND_MS, 30 * 60 * 1000);
const CONTINUE_PHRASE = process.env.WATCHDOG_PHRASE || "continue";
const PARENT_PID = posInt(process.env.WATCHDOG_PARENT_PID, 0);
const SESSION_ID = process.env.WATCH_SESSION_ID || "";

function posInt(v, fallback) {
  const n = Number.parseInt(v || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function slug(workspaceRoot) {
  return crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}
function sessionSegment(sessionId) {
  const clean = String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || null;
}
function taskSessionSuffix(sessionId) {
  const clean = String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  return clean || null;
}
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const stateDir = path.join(HOME, "projects", slug(WORKSPACE));
const sessionSegmentValue = sessionSegment(SESSION_ID);
const watchdogDir = sessionSegmentValue ? path.join(stateDir, "sessions", sessionSegmentValue) : stateDir;
const goalFile = path.join(watchdogDir, "goal.json");
const taskDir = path.join(stateDir, "tasks");
const taskSuffix = taskSessionSuffix(SESSION_ID);
const activeTaskFile = path.join(taskDir, taskSuffix ? `active-task.${taskSuffix}.json` : "active-task.json");
const logFile = path.join(watchdogDir, "goal-watchdog.log");
const pidFile = process.env.WATCHDOG_PID_FILE || path.join(watchdogDir, "goal-watchdog.pid.json");

function readPidRecord() {
  const record = readJson(pidFile);
  return record && Number.isInteger(record.pid) ? record : null;
}

function publishPid() {
  try {
    fs.mkdirSync(watchdogDir, { recursive: true });
    const existing = readPidRecord();
    if (existing?.pid && existing.pid !== process.pid && processAlive(existing.pid)) {
      console.log(`goal watchdog already running as pid ${existing.pid}; exiting duplicate`);
      process.exit(0);
    }
    fs.writeFileSync(pidFile, JSON.stringify({
      pid: process.pid,
      parent_pid: PARENT_PID || null,
      workspace: WORKSPACE,
      session_id: sessionSegmentValue,
      started_at: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

function clearPid() {
  try {
    const record = readPidRecord();
    if (record?.pid === process.pid) fs.unlinkSync(pidFile);
  } catch {}
}

function log(line) {
  const line_ = `${new Date().toISOString()} ${line}\n`;
  try {
    fs.appendFileSync(logFile, line_);
  } catch {}
  console.log(line_.trimEnd());
}

let lastNotifiedAt = 0;
let lastActivitySeen = 0;

function notify(title, message) {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "try {",
    "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    "  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "  $t = $xml.GetElementsByTagName('text')",
    "  $t.Item(0).AppendChild($xml.CreateTextNode($args[0])) | Out-Null",
    "  $t.Item(1).AppendChild($xml.CreateTextNode($args[1])) | Out-Null",
    `  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'`,
    "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
    "} catch {",
    "  Add-Type -AssemblyName PresentationFramework",
    "  [System.Windows.MessageBox]::Show($args[1], $args[0]) | Out-Null",
    "}",
  ].join("\n");
  try {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps, title, message], { windowsHide: true, stdio: "ignore" });
    p.unref();
  } catch {}
}

function poll() {
  if (PARENT_PID && !processAlive(PARENT_PID)) {
    log(`parent MCP pid ${PARENT_PID} is gone — watchdog exiting`);
    process.exit(0);
  }
  const goal = readJson(goalFile);
  if (!goal || goal.status !== "active") {
    log("goal no longer active — watchdog exiting");
    process.exit(0);
  }
  const unmet = (goal.success_criteria || []).filter((c) => !c.passed);
  if (!unmet.length) {
    // criteria 全过但 goal 未 complete:这是"完成链未走完",也值得提醒
    if (Date.now() - lastNotifiedAt < REMIND_MS) return;
    log(`goal active with all criteria passed but not completed — remind to run goal(action=complete)`);
    notify("Goal 待收尾", `全部 criteria 已通过但 goal 仍 active。请让 agent 执行 goal(action=complete) 然后 task complete。`);
    lastNotifiedAt = Date.now();
    return;
  }

  let lastActivity = Date.parse(goal.updated_at);
  if (!Number.isFinite(lastActivity)) lastActivity = 0;
  const pointer = readJson(activeTaskFile);
  let taskBlocked = false;
  if (pointer?.task_id) {
    const task = readJson(path.join(taskDir, `${pointer.task_id}.json`));
    if (task) {
      const ta = Date.parse(task.updated_at);
      if (Number.isFinite(ta) && ta > lastActivity) lastActivity = ta;
      taskBlocked = Boolean(task.blocked);
    }
  }
  if (lastActivity > lastActivitySeen) {
    // 有新活动:stall 剧集结束
    if (lastNotifiedAt) log("activity detected — stall episode over");
    lastNotifiedAt = 0;
    lastActivitySeen = lastActivity;
  }
  if (taskBlocked) return; // 记录了 blocker = 合法让位,不提醒

  const gapMs = Date.now() - lastActivity;
  if (gapMs <= GAP_MS) return;
  if (Date.now() - lastNotifiedAt < REMIND_MS) return;
  lastNotifiedAt = Date.now();
  const minutes = Math.round(gapMs / 60000);
  log(`stall: ${minutes} min without activity, ${unmet.length} criteria unmet — notifying`);
  notify(
    `Goal 已停 ${minutes} 分钟(剩 ${unmet.length} 项)`,
    `打开 ChatGPT 发送:${CONTINUE_PHRASE} —— 让 agent 继续执行:${String(unmet[0]?.name || "").slice(0, 80)}`
  );
}

publishPid();
process.once("exit", clearPid);
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));
log(`watchdog started: workspace=${WORKSPACE} session=${sessionSegmentValue || "legacy"} parent_pid=${PARENT_PID || "none"} gap=${Math.round(GAP_MS / 60000)}min poll=${Math.round(POLL_MS / 1000)}s`);
poll();
setInterval(poll, POLL_MS);
