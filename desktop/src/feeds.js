"use strict";
// 实时活动源：即使 MCP / Tunnel 是外部进程（旧脚本或手动启动），也能拿到滚动的连接与调用信息。
//   MCP  → Admin API /api/activity（工具调用、HTTP 事件）
//   Tunnel → tunnel-client /api/logs（控制平面轮询、命令派发、错误）
// 两者都按水位线增量拉取，只在服务可达时工作，不影响进程本身。
const { EventEmitter } = require("events");
const http = require("http");
const adminClient = require("./admin-client");

const POLL_MS = 1500;

function getJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (settled) return; settled = true; clearTimeout(deadline); resolve(value); };
    // A server that dies mid-body emits "aborted"/"close" instead of "end".
    // This poll then never settled, tick() stayed busy and the account's MCP
    // and tunnel feeds stopped until restart; settle on every outcome.
    const deadline = setTimeout(() => { req.destroy(); done(null); }, timeoutMs + 1000);
    deadline.unref?.();
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { if (body.length < 2_000_000) body += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return done(null);
        try { done(JSON.parse(body)); } catch { done(null); }
      });
      res.on("aborted", () => done(null));
      res.on("error", () => done(null));
      res.on("close", () => done(null));
    });
    req.on("timeout", () => { req.destroy(); done(null); });
    req.on("error", () => done(null));
  });
}

const pad = (n) => String(n).padStart(2, "0");
function clockOf(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** tunnel-client 启动期的 fx 依赖注入噪音，对排查连接问题没有价值。 */
const TUNNEL_NOISE = new Set(["provided", "invoking", "run", "supplied", "initialized custom fxevent.Logger"]);
// 只保留排查连接问题真正需要的字段，丢掉 stacktrace/moduletrace 等大块内容。
const TUNNEL_ATTRS = [
  "component", "cmd_request_id", "request_id", "session_id", "rpc_request_id",
  "method", "path", "status", "status_code", "http_status", "duration",
  "channel", "url", "error", "err", "reason", "attempt", "backoff",
];

class ActivityFeeds extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.ports = { admin: 0, tunnel: 0 };
    this.adminToken = "";
    this.lastActivityId = null;
    this.lastTunnelSeq = 0;
    this.primed = { mcp: false, tunnel: false };
    this.seenIds = new Set();
    this.seenOrder = [];
    this.busy = false;
    this.generation = 0;
  }

  /** 端口变化时重置水位线，避免把上一个实例的历史当成新事件。 */
  configure({ adminPort, tunnelPort, adminToken, mcpOnStdout = false }) {
    const token = typeof adminToken === "string" ? adminToken : "";
    const managed = mcpOnStdout === true;
    if (adminPort !== this.ports.admin || tunnelPort !== this.ports.tunnel ||
        token !== this.adminToken || managed !== Boolean(this.mcpOnStdout)) this.generation++;
    this.adminToken = token;
    // 本程序托管的 MCP 已经从 stdout 输出同样的活动行；这时只推进水位线，不重复显示。
    this.mcpOnStdout = managed;
    if (adminPort !== this.ports.admin) {
      this.ports.admin = adminPort;
      this.lastActivityId = null;
      this.primed.mcp = false;
      this.seenIds.clear();
      this.seenOrder.length = 0;
    }
    if (tunnelPort !== this.ports.tunnel) {
      this.ports.tunnel = tunnelPort;
      this.lastTunnelSeq = 0;
      this.primed.tunnel = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await Promise.all([this.pollMcpActivity(), this.pollTunnelLogs()]);
    } finally {
      this.busy = false;
    }
  }

  emitLines(channel, lines) {
    if (lines.length) this.emit("lines", { name: channel, lines });
  }

  async pollMcpActivity() {
    const generation = this.generation;
    const port = this.ports.admin;
    if (!port) return;
    // 首次只取少量历史，避免一次灌入几百行；之后按 since 增量。
    const limit = this.primed.mcp ? 100 : 25;
    const query = this.lastActivityId
      ? `?limit=${limit}&since=${encodeURIComponent(this.lastActivityId)}`
      : `?limit=${limit}`;
    const data = await adminClient.getJson(port, `/api/activity${query}`, this.adminToken);
    if (generation !== this.generation || !data || !Array.isArray(data.entries)) return;
    const entries = data.entries.slice().reverse(); // 接口按新到旧返回
    const lines = [];
    for (const e of entries) {
      if (generation !== this.generation) return;
      // MCP 的活动缓冲是进程内环形队列：重启后 id 全新，since 失配会回退成"最近 N 条"，
      // 因此再按 id 去重一次，避免重复刷屏。
      if (e.id) {
        if (this.seenIds.has(e.id)) continue;
        this.seenIds.add(e.id);
        this.seenOrder.push(e.id);
        if (this.seenOrder.length > 800) this.seenIds.delete(this.seenOrder.shift());
      }
      // The authenticated Admin activity source retains a full verified
      // conversation identity. Never use the eight-character log prefix as
      // an account's persistent conversation key.
      if (e.action === "tools/call" &&
          typeof e.conversation_id === "string" &&
          /^oai_conv_[a-f0-9]{32}$/.test(e.conversation_id) &&
          typeof e.tool === "string" &&
          e.details?.conversation_continuity === "trusted" &&
          e.details?.conversation_source === "openai/session") {
        this.emit("activity", {
          conversationId: e.conversation_id,
          identitySource: "openai/session",
          identityVersion: 2,
          at: Date.parse(e.time),
          tool: e.tool,
          hint: typeof e.details?.conversation_label_hint === "string" ? e.details.conversation_label_hint : "",
        });
      }
      if (generation !== this.generation) return;
      if (!e.details?.lifecycle_detail) lines.push(formatActivity(e));
    }
    if (entries.length) this.lastActivityId = entries[entries.length - 1].id || this.lastActivityId;
    if (this.mcpOnStdout) return;
    if (!this.primed.mcp) {
      this.primed.mcp = true;
      lines.unshift(`${clockOf(new Date().toISOString())}   [活动] 已接入 MCP Admin API :${port}/api/activity（工具调用实时流）`);
    }
    this.emitLines("mcp", lines);
  }

  async pollTunnelLogs() {
    const generation = this.generation;
    const port = this.ports.tunnel;
    if (!port) return;
    const data = await getJson(`http://127.0.0.1:${port}/api/logs`);
    if (generation !== this.generation || !data || !Array.isArray(data.events)) return;
    // tunnel-client keeps its log buffer in memory, so after a restart seq
    // starts again from 1; reset the watermark instead of hiding new events
    // until they pass the old maximum.
    const newest = data.events.reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0);
    if (newest && newest < this.lastTunnelSeq) this.lastTunnelSeq = 0;
    let events = data.events.filter((e) => Number(e.seq) > this.lastTunnelSeq);
    if (!events.length) return;
    this.lastTunnelSeq = Math.max(...events.map((e) => Number(e.seq) || 0));
    if (!this.primed.tunnel) {
      this.primed.tunnel = true;
      // 首次只显示最近的若干条，其余留在 tunnel-client 自己的 UI 里。
      events = events.slice(-40);
      this.emitLines("tunnel", [
        `${clockOf(new Date().toISOString())}   [活动] 已接入 tunnel-client :${port}/api/logs（控制平面与命令派发日志）`,
      ]);
    }
    if (generation !== this.generation) return;
    this.emitLines("tunnel", events.filter((e) => !TUNNEL_NOISE.has(String(e.message))).map(formatTunnelEvent));
  }
}

function formatActivity(e) {
  const time = clockOf(e.time);
  const status = e.status ? String(e.status) : "";
  const bad = /err|fail|deny|reject/i.test(status);
  const parts = [];
  if (e.kind) parts.push(`[${e.kind}]`);
  if (e.action) parts.push(e.action);
  if (e.tool) parts.push(e.tool);
  if (status) parts.push(status);
  if (e.duration_ms != null) parts.push(`${e.duration_ms}ms`);
  // Keep outcome semantics as bounded machine tokens, separate from visible summary.
  const d = e.details;
  if (["needs_input", "review_rejected", "blocked", "execution_error", "unknown", "running"].includes(d?.outcome_kind)) {
    parts.push(`outcome=${d.outcome_kind}`);
    if (typeof d.error_code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(d.error_code)) parts.push(`code=${d.error_code}`);
    if (["admission", "validation", "execution", "postprocessing"].includes(d.failure_phase)) parts.push(`phase=${d.failure_phase}`);
    if (typeof d.operation_started === "boolean") parts.push(`started=${d.operation_started}`);
    if (Number.isInteger(d.exit_code)) parts.push(`exit=${d.exit_code}`);
    if (typeof d.timed_out === "boolean") parts.push(`timeout=${d.timed_out}`);
    if (typeof d.may_have_partially_completed === "boolean") parts.push(`partial=${d.may_have_partially_completed}`);
    if (["retry_with_changed_args", "refresh_state", "inspect_original_result", "repair_then_review", "none"].includes(d.retry_policy)) parts.push(`retry=${d.retry_policy}`);
  }
  if (typeof e.details?.invocation_id === "string" && /^[A-Za-z0-9_.:-]+$/.test(e.details.invocation_id)) parts.push(`call=${e.details.invocation_id}`);
  if (e.client) parts.push(`client=${e.client}`);
  if (e.session_id) parts.push(`session=${String(e.session_id).slice(0, 8)}`);
  // Same short form as the MCP console line, so both sources name a conversation identically.
  if (typeof e.conversation_id === "string" && e.conversation_id.startsWith("oai_conv_")) parts.push(`conv=${e.conversation_id.slice(9, 17)}`);
  const head = `${time} ${bad ? "!" : " "} ${parts.join(" ")}`;
  const summary = e.summary ? ` — ${collapse(String(e.summary), 220)}` : "";
  return head + summary;
}

function formatTunnelEvent(e) {
  const level = String(e.level || "INFO").toUpperCase();
  const bad = level === "ERROR" || level === "WARN";
  const attrs = [];
  const bag = e.attrs && typeof e.attrs === "object" ? e.attrs : {};
  for (const key of TUNNEL_ATTRS) {
    const value = bag[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "object") continue;
    attrs.push(`${key}=${collapse(String(value), 90)}`);
  }
  return `${clockOf(e.time)} ${bad ? "!" : " "} ${level} ${collapse(String(e.message || ""), 160)}${attrs.length ? `  ${attrs.join(" ")}` : ""}`;
}

function collapse(text, max) {
  const flat = text.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

module.exports = { ActivityFeeds, formatActivity };
