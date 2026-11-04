"use strict";
// 运行状态探测：MCP /health、Tunnel /readyz、端口占用者及其命令行（用于识别外部进程）。
const { execFile } = require("child_process");
const { probeTunnel, readLoopback } = require("./tunnel-health");

const INFO_TTL_MS = 15000;
const MAX_INFO_CACHE = 128;
const MAX_QUERY_BYTES = 1024 * 1024;

async function probeMcp(port) {
  const res = await readLoopback(port, "/health", { maxBytes: 256 * 1024 });
  if (res.error || res.status !== 200) return null;
  try {
    const health = JSON.parse(res.text);
    return health && health.name === "codex-mcp-server" ? health : null;
  } catch { return null; }
}

// execFile keeps the Electron main loop free. The separate deadline also settles
// the query if a failed/killed child never delivers its completion callback.
function query(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = (error, out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(out || "");
    };
    const timer = setTimeout(() => {
      const error = Object.assign(new Error(command + " query timed out"), { code: "ETIMEDOUT" });
      finish(error);
      // Only the disposable probe child, never the PID being inspected.
      try { if (child) child.kill(); } catch {}
    }, timeoutMs);
    try {
      child = execFile(command, args, {
        encoding: "utf8", windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_QUERY_BYTES,
      }, finish);
    } catch (error) { finish(error); }
  });
}

function validPid(pid) {
  return Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
}

let listenersPending = null;
function listeners({ fresh = false } = {}) {
  // Share only work in progress, not a completed port/PID snapshot. A destructive
  // operation must not join a poll that started before that operation.
  if (!fresh && listenersPending) return listenersPending;
  const pending = query("netstat", ["-ano", "-p", "tcp"], 5000).then((out) => {
    const ports = new Map();
    for (const line of out.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0].toUpperCase() !== "TCP" || parts[3].toUpperCase() !== "LISTENING") continue;
      const match = /:(\d+)$/.exec(parts[1]);
      const pid = Number(parts[4]);
      if (!match || !validPid(pid)) continue;
      const port = Number(match[1]);
      if (!ports.has(port)) ports.set(port, new Set());
      ports.get(port).add(pid);
    }
    return ports;
  }).finally(() => {
    if (listenersPending === pending) listenersPending = null;
  });
  listenersPending = pending;
  return pending;
}

/** Async PID list. A failed query rejects: unknown must not mean a free port. */
async function listeningPids(port, options) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw Object.assign(new Error("Invalid port"), { code: "INVALID_PORT" });
  }
  const ports = await listeners(options);
  return [...(ports.get(value) || [])];
}

const infoCache = new Map();
const infoPending = new Map();
function parseInfo(out, pid) {
  try {
    const value = JSON.parse(out.trim());
    if (!value || Array.isArray(value) || typeof value !== "object" || Number(value.ProcessId) !== pid) return null;
    return {
      ProcessId: pid,
      Name: typeof value.Name === "string" ? value.Name : "",
      CommandLine: typeof value.CommandLine === "string" ? value.CommandLine : "",
      ParentProcessId: validPid(Number(value.ParentProcessId)) ? Number(value.ParentProcessId) : null,
      CreationDate: typeof value.CreationDate === "string" ? value.CreationDate : null,
    };
  } catch { return null; }
}

/** Display-only 15s cache. fresh bypasses BOTH cached and in-flight identity. */
function processInfo(pid, { fresh = false } = {}) {
  pid = Number(pid);
  if (!validPid(pid)) return Promise.resolve(null);
  const cached = infoCache.get(pid);
  const age = cached ? Date.now() - cached.at : -1;
  if (!fresh && cached && age >= 0 && age < INFO_TTL_MS) return Promise.resolve({ ...cached.value });
  infoCache.delete(pid);
  if (!fresh && infoPending.has(pid)) return infoPending.get(pid);
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,Name,CommandLine,ParentProcessId,CreationDate | ConvertTo-Json -Compress`;
  const pending = query("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], 8000)
    .then((out) => parseInfo(out, pid), () => null)
    .then((value) => {
      // A late passive query must not repopulate a cache invalidated by a fresh
      // check (including a failed fresh check). Failures are never cached.
      if (infoPending.get(pid) === pending) {
        infoPending.delete(pid);
        if (value) {
          infoCache.set(pid, { at: Date.now(), value: { ...value } });
          while (infoCache.size > MAX_INFO_CACHE) infoCache.delete(infoCache.keys().next().value);
        }
      }
      return value;
    });
  infoPending.set(pid, pending);
  return pending;
}

async function classifyPortOwner(port, expectedPattern, options) {
  const empty = { pid: null, recognized: false, info: null, creationDate: null, error: null };
  let pids;
  try { pids = await listeningPids(port, options); }
  catch (error) { return { ...empty, error: String(error.code || "port_query_failed") }; }
  if (pids.length === 0) return empty;
  const pid = pids[0];
  const info = await processInfo(pid, options);
  const cmd = info ? info.CommandLine : "";
  const name = info ? info.Name : "";
  const pattern = new RegExp(expectedPattern.source, expectedPattern.flags.replace(/[gy]/g, ""));
  // Multiple distinct listeners are ambiguous; never authorize stopping the
  // first PID just because its command line matches.
  const recognized = pids.length === 1 && Boolean(info) && (pattern.test(cmd) || pattern.test(name));
  return {
    pid, recognized, info: info ? { name, commandLine: cmd } : null,
    creationDate: info ? info.CreationDate : null,
    error: info ? null : "process_query_failed",
  };
}

module.exports = { probeMcp, probeTunnel, listeningPids, processInfo, classifyPortOwner };
