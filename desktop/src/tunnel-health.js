"use strict";
// Loopback /readyz is local MCP readiness, NOT evidence of a working cloud poll.
const http = require("http");

const DEFAULT_TIMEOUT_MS = 2000;
const MAX_BODY_BYTES = 512 * 1024;
// Metrics may contain high-cardinality histograms. Scan a bounded wire budget,
// retaining only bounded poll-gauge lines; never buffer the entire scrape.
const METRIC_SCAN_BYTES = 16 * 1024 * 1024;
const METRIC_LINE_BYTES = 16 * 1024;
const METRIC_KEEP_BYTES = 64 * 1024;
const LIMITS = { ready: 4096, status: 64 * 1024, metrics: 256 * 1024, logs: 256 * 1024 };

/** One loopback GET, bounded by a wall-clock deadline (including slow-drip bodies).
 * Never follows redirects; every request/response termination settles exactly once.
 */
function readLoopback(port, pathname, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = MAX_BODY_BYTES, selectPollMetric = false } = {}) {
  return new Promise((resolve) => {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      resolve({ status: null, text: "", error: "invalid_port" });
      return;
    }
    const deadline = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(5000, timeoutMs)) : DEFAULT_TIMEOUT_MS;
    const limit = Number.isFinite(maxBytes) ? Math.max(1, Math.min(MAX_BODY_BYTES, maxBytes)) : MAX_BODY_BYTES;
    let req, response, timer;
    let done = false;
    let bytes = 0;
    const chunks = [];
    let line = Buffer.alloc(0), skipLine = false, keptBytes = 0;
    const retainLine = () => {
      if (!skipLine && /^commands_poll_last_successful_timestamp_seconds(?:\{|\s)/.test(line.toString("utf8").trimStart())) {
        keptBytes += line.length + 1;
        if (keptBytes > METRIC_KEEP_BYTES) { finish("response_too_large"); return; }
        chunks.push(line, Buffer.from("\n"));
      }
      line = Buffer.alloc(0); skipLine = false;
    };
    const finish = (error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ status: response ? response.statusCode : null, text: error ? "" : Buffer.concat(chunks).toString("utf8"), error });
      if (error) {
        if (response) response.destroy();
        if (req) req.destroy();
      }
    };
    timer = setTimeout(() => finish("timeout"), deadline);
    try {
      req = http.get({ hostname: "127.0.0.1", family: 4, port: number, path: pathname, agent: false,
        headers: { "Accept-Encoding": "identity" } }, (res) => {
        response = res;
        res.on("error", () => finish("response_error"));
        res.on("aborted", () => finish("aborted"));
        res.on("close", () => { if (!done) finish("aborted"); });
        res.on("end", () => {
          if (selectPollMetric && !done) retainLine();
          finish(res.complete ? null : "aborted");
        });
        res.on("data", (chunk) => {
          if (done) return;
          bytes += chunk.length;
          if (bytes > (selectPollMetric ? METRIC_SCAN_BYTES : limit)) { finish("response_too_large"); return; }
          if (!selectPollMetric) { chunks.push(chunk); return; }
          let offset = 0;
          while (offset < chunk.length && !done) {
            const end = chunk.indexOf(10, offset);
            const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
            if (!skipLine) {
              if (line.length + part.length > METRIC_LINE_BYTES) { line = Buffer.alloc(0); skipLine = true; }
              else line = Buffer.concat([line, part]);
            }
            if (end < 0) break;
            retainLine(); offset = end + 1;
          }
        });
        if (Number(res.headers["content-length"]) > (selectPollMetric ? METRIC_SCAN_BYTES : limit)) finish("response_too_large");
      });
      req.on("error", () => finish("request_error"));
      req.on("abort", () => finish("aborted"));
      req.on("timeout", () => finish("timeout"));
      req.on("close", () => { if (!done) finish("aborted"); });
    } catch {
      finish("request_error");
    }
  });
}

function jsonBody(response) {
  if (!response || response.error || response.status !== 200) return null;
  try {
    const value = JSON.parse(response.text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function identity(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
}

function timestamp(value) {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? at : null;
}

/** Expose only route mode and proxy origin, never credentials, path, query or fragment. */
function proxyRoute(route) {
  if (!route || !["direct", "proxy"].includes(route.route_mode)) return null;
  const result = { mode: route.route_mode, source: identity(route.proxy_source) || "tunnel-client", url: "" };
  if (result.mode === "proxy" && typeof route.proxy_url === "string") {
    try {
      const url = new URL(route.proxy_url);
      if (["http:", "https:", "socks5:"].includes(url.protocol)) result.url = `${url.protocol}//${url.host}`;
    } catch {}
  }
  return result;
}

function duration(value, fallback) {
  if (typeof value !== "string" || value.length > 40) return fallback;
  const units = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (!parts.length || parts.map((part) => part[0]).join("") !== value) return fallback;
  const total = parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]], 0);
  return Number.isFinite(total) && total >= 0 ? total : fallback;
}

function freshnessWindow(meta) {
  // Allow two poll+guard windows and 10s retry/backoff slack. v0.0.10's 30s+5s
  // gives 80s. Clamp to 60s..5m so bad config cannot keep old evidence online.
  // An observed newer failure overrides this grace window immediately.
  const poll = duration(meta.control_plane_poll_timeout, 30000);
  const guard = duration(meta.control_plane_poll_deadline_guardrail, 5000);
  return Math.max(60000, Math.min(300000, 2 * (poll + guard) + 10000));
}

function metricLabels(text) {
  const labels = Object.create(null);
  if (!text) return labels;
  const re = /\s*([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"\s*(?:,\s*|$)/gy;
  let offset = 0;
  while (offset < text.length) {
    re.lastIndex = offset;
    const match = re.exec(text);
    if (!match || Object.hasOwn(labels, match[1])) return null;
    try { labels[match[1]] = JSON.parse(`"${match[2]}"`); } catch { return null; }
    offset = re.lastIndex;
  }
  return labels;
}

function pollMetric(response, scope, now) {
  const result = { observed: false, at: null };
  if (!response || response.error || response.status !== 200) return result;
  for (const line of response.text.split(/\r?\n/)) {
    const match = /^commands_poll_last_successful_timestamp_seconds(?:\{(.*)\})?\s+(\S+)(?:\s+\S+)?\s*$/.exec(line.trim());
    if (!match) continue;
    const labels = metricLabels(match[1]);
    if (!labels || (labels.otel_scope_name && labels.otel_scope_name !== "controlplane")) continue;
    if (labels.client_instance_id && labels.client_instance_id !== scope.instanceId) continue;
    if (labels.control_plane_tunnel_id && labels.control_plane_tunnel_id !== scope.tunnelId) continue;
    if (labels.tunnel_id && labels.tunnel_id !== scope.tunnelId) continue;
    const seconds = Number(match[2]);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    // The gauge has SECOND resolution. Use its lower bound: a same-second
    // sample cannot prove recovery after a failure or after an instance restart.
    const at = Math.floor(seconds) * 1000;
    if (!Number.isSafeInteger(at) || at > now) continue;
    result.observed = true;
    if (at >= scope.startedAt && at > 0) result.at = Math.max(result.at || 0, at);
  }
  return result;
}

const POLL_FAILURE = /\bpoll (?:failed|timed out)(?:\b|;)/i;
const META_FAILURE = /tunnel metadata fetch failed/i;
const AUTH_FAILURE = /invalid_api_key|\bunauthori[sz]ed\b|\bforbidden\b|\b(?:HTTP(?:\/\d(?:\.\d)?)?(?:\s+status)?|status(?:_code|\s+code)?|response(?:\s+status)?|code)[\s"':=]+(?:401|403)\b/i;

function diagnostic(event, observedAt = null) {
  if (!event || typeof event !== "object") return null;
  const attrs = event.attrs && typeof event.attrs === "object" ? event.attrs : {};
  const message = typeof event.message === "string" ? event.message : "";
  const error = typeof attrs.error === "string" ? attrs.error : "";
  const text = `${message} ${error}`;
  const poll = POLL_FAILURE.test(message);
  const meta = META_FAILURE.test(message);
  if (attrs.component && attrs.component !== "controlplane") return null;
  if (attrs.component !== "controlplane" && !poll && !meta) return null;
  const code = String(attrs.status_code || attrs.status || attrs.http_status || "");
  const auth = AUTH_FAILURE.test(text) || /^(401|403)$/.test(code);
  if (!auth && !poll && !meta) return null;
  const at = timestamp(event.time) || timestamp(observedAt);
  if (!at) return null;
  // Fixed summaries deliberately avoid echoing request URLs, API keys or arbitrary log attrs.
  let cause = "network/control-plane error";
  if (/unexpected EOF/i.test(text)) cause = "unexpected EOF";
  else if (/\bEOF\b/.test(text)) cause = "EOF";
  else if (/timeout|timed out|deadline exceeded/i.test(text)) cause = "timeout";
  else if (/ECONNRESET|connection reset/i.test(text)) cause = "connection reset";
  else if (/ECONNREFUSED|connection refused/i.test(text)) cause = "connection refused";
  else if (/no such host|ENOTFOUND|\bDNS\b/i.test(text)) cause = "DNS error";
  return {
    kind: auth ? "authError" : "metaError", at,
    instanceId: identity(attrs.client_instance_id),
    tunnelId: identity(attrs.control_plane_tunnel_id || attrs.tunnel_id),
    code: auth ? "authentication_failed" : poll ? "poll_failed" : "metadata_failed",
    line: auth ? "Control-plane authentication failed (401/403, unauthorized or invalid_api_key)."
      : `Control-plane ${poll ? "poll" : "metadata fetch"} failed (${cause})${poll ? "; backing off" : ""}.`,
  };
}

/** Managed stdout/stderr fallback. Keep observation time once, not on each refresh.
 * Supports JSON and slog/logfmt after ManagedProcess's HH:MM:SS prefix.
 */
function parseManagedDiagnostic(line, observedAt = Date.now()) {
  if (typeof line !== "string") return null;
  const text = line.slice(0, 16384).replace(/^\d{2}:\d{2}:\d{2}\s+[! ]*/, "");
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text);
      return diagnostic({ ...value, message: value.message || value.msg, attrs: { ...value, ...value.attrs } }, observedAt);
    } catch {}
  }
  const field = (name) => {
    const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"\\r\\n]*)"|([^\\s]+))`).exec(text);
    return match ? match[1] || match[2] : undefined;
  };
  return diagnostic({ time: field("time"), message: text, attrs: {
    component: field("component"), client_instance_id: field("client_instance_id"),
    control_plane_tunnel_id: field("control_plane_tunnel_id"), tunnel_id: field("tunnel_id"),
  } }, observedAt);
}

function inScope(item, scope, now) {
  if (!item || !timestamp(item.at) || item.at > now) return false;
  if (scope.startedAt && item.at < scope.startedAt) return false;
  if (item.instanceId && scope.instanceId && item.instanceId !== scope.instanceId) return false;
  if (item.tunnelId && scope.tunnelId && item.tunnelId !== scope.tunnelId) return false;
  return true;
}

/** Backward-compatible reachable/ready plus independent, evidence-based cloud health.
 * No process-global cache: port reuse/restarts must not inherit another daemon's success.
 */
async function probeTunnel(port, options = {}) {
  const entries = await Promise.all([
    ["ready", "/readyz"], ["status", "/api/status"], ["metrics", "/metrics"], ["logs", "/api/logs"],
  ].map(async ([name, endpoint]) => [name, await readLoopback(port, endpoint, { timeoutMs: options.timeoutMs, maxBytes: LIMITS[name], selectPollMetric: name === "metrics" })]));
  const responses = Object.fromEntries(entries);
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const meta = jsonBody(responses.status);
  const instanceId = identity(meta && meta.client_instance_id);
  const tunnelId = identity(meta && meta.control_plane_tunnel_id);
  const startedAt = timestamp(meta && meta.started_at);
  const expectedTunnelId = options.expectedTunnelId || null;
  const expectedInstanceId = options.expectedInstanceId || null;
  const result = {
    reachable: responses.ready.status !== null,
    ready: !responses.ready.error && responses.ready.status === 200 && responses.ready.text.trim() === "ready",
    cloudState: "unknown", lastPollSuccessAt: null, authError: null, metaError: null,
    instanceId, proxyRoute: proxyRoute(meta && meta.control_plane_route),
  };
  const mismatch = (expectedTunnelId && tunnelId && expectedTunnelId !== tunnelId) ? "tunnel_mismatch"
    : (expectedInstanceId && instanceId && expectedInstanceId !== instanceId) ? "instance_mismatch" : null;
  if (mismatch) {
    result.cloudState = "error";
    result.metaError = { at: now, code: mismatch, line: mismatch === "tunnel_mismatch"
      ? "Local daemon Tunnel ID does not match the configured Tunnel ID."
      : "Local daemon instance does not match the expected instance." };
    return result;
  }
  const identified = Boolean(meta && instanceId && tunnelId && startedAt && startedAt <= now);
  const scope = { instanceId: instanceId || expectedInstanceId, tunnelId: tunnelId || expectedTunnelId,
    startedAt: Math.max(startedAt || 0, timestamp(options.managedStartedAt) || 0) };
  const metric = identified ? pollMetric(responses.metrics, scope, now) : { observed: false, at: null };
  // Bracket positive evidence with the same daemon identity: a port can be reused
  // while the independent endpoints are in flight. Mixed-generation snapshots
  // must never attribute a new daemon's metric to the old daemon.
  if (metric.at !== null) {
    const confirm = jsonBody(await readLoopback(port, "/api/status", { timeoutMs: options.timeoutMs, maxBytes: LIMITS.status }));
    if (!confirm || confirm.client_instance_id !== instanceId || confirm.control_plane_tunnel_id !== tunnelId || timestamp(confirm.started_at) !== startedAt) {
      return result;
    }
  }
  result.lastPollSuccessAt = metric.at;
  const logBody = identified ? jsonBody(responses.logs) : null;
  const events = logBody && Array.isArray(logBody.events) ? logBody.events : [];
  const diagnostics = events.map((event) => diagnostic(event)).filter(Boolean);
  if (Array.isArray(options.managedDiagnostics)) diagnostics.push(...options.managedDiagnostics.slice(-64));
  for (const item of diagnostics) {
    if (!["authError", "metaError"].includes(item.kind) || !inScope(item, scope, now)) continue;
    // Metadata fetches and successful-looking log lines never clear a failure.
    if (metric.at !== null && metric.at > item.at) continue;
    if (!result[item.kind] || item.at > result[item.kind].at) {
      result[item.kind] = { at: item.at, line: item.line, code: item.code };
    }
  }
  if (result.authError || result.metaError) result.cloudState = "error";
  else if (metric.at !== null) result.cloudState = now - metric.at > freshnessWindow(meta) ? "stale" : logBody ? "online" : "unknown";
  else if (identified && metric.observed) result.cloudState = "connecting";
  return result;
}

module.exports = { probeTunnel, readLoopback, parseManagedDiagnostic };
