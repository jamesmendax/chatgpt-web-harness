#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const ID_KEYS = ['request_id', 'cmd_request_id', 'session_id', 'tunnel_request_id', 'invocation_id'];
const SAFE_WORD = /^[A-Za-z0-9_-]{1,160}$/;

function envelope(line) {
  const offset = line.indexOf('{');
  if (offset < 0) return null;
  try {
    const raw = JSON.parse(line.slice(offset));
    return raw && !Array.isArray(raw) && typeof raw === 'object' ? raw : null;
  } catch { return null; }
}

function eventTime(raw, line = '') {
  const value = raw?.time ?? raw?.timestamp ?? line.match(/\btime=["']?([^\s"']+)/)?.[1];
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const millis = Date.parse(value);
    if (Number.isFinite(millis)) return { time: new Date(millis).toISOString(), time_precision: 'absolute' };
  }
  const clock = (typeof value === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(value) ? value : null)
    ?? line.match(/^\d{2}:\d{2}:\d{2}\b/)?.[0];
  return { time: clock || null, time_precision: clock ? 'clock_only' : 'unknown' };
}

function identifiers(raw, line = '') {
  const clean = {};
  for (const key of ID_KEYS) {
    const value = raw?.[key] ?? line.match(new RegExp('(?:^|\\s)' + key + '=([A-Za-z0-9_-]{1,160})(?:\\s|$)'))?.[1];
    if (typeof value === 'string' && SAFE_WORD.test(value)) clean[key] = value;
  }
  return clean;
}

function httpStatus(raw, text) {
  for (const value of [raw?.status, raw?.status_code, raw?.http_status, raw?.statusCode, raw?.error?.status]) {
    if (/^[1-5]\d{2}$/.test(String(value))) return Number(value);
  }
  const match = text.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?: code)?|status_code)\s*[:=]?\s*["']?([1-5]\d{2})\b/i);
  return match ? Number(match[1]) : null;
}

// Read-only log analysis. Export classified metadata only, never raw messages,
// request/response bodies, credentials, cookies, URLs or command arguments.
export function classifyLine(line) {
  const raw = envelope(line);
  // For JSON logs, inspect diagnostic fields only, not command bodies or URLs.
  const text = raw ? [raw.msg, raw.message, raw.error?.message, typeof raw.error === 'string' ? raw.error : null]
    .filter(value => typeof value === 'string').join(' ') : line;
  const status = httpStatus(raw, text);
  let category, layer;
  if (/ChatGPT stream recovery polling timed out/i.test(text)) [category, layer] = ['web_stream_recovery_polling_timeout', 'web_ui'];
  else if (/request_body_too_large/i.test(text) || status === 413) [category, layer] = ['payload_rejected', 'transport'];
  else if (/poll timed out;? backing off/i.test(text)) [category, layer] = ['poll_timeout_backoff', 'transport'];
  else if (/poll failed;? backing off/i.test(text)) [category, layer] = ['poll_failed_backoff', 'transport'];
  else if (/command response deadline reached|response deadline has passed/i.test(text)) [category, layer] = ['command_response_deadline', 'transport'];
  else if (/MCP connection TTL reached/i.test(text)) [category, layer] = ['connection_ttl', 'transport'];
  else if (/Command timed out after|local_command_budget|COMMAND_NOT_STARTED/i.test(text)) [category, layer] = ['local_execution_budget', 'local_execution'];
  else if (/Message delivery timed out/i.test(text)) [category, layer] = ['host_ui_timeout_observed', 'observer'];
  else if (/Debugger unattached/i.test(text)) [category, layer] = ['observer_debugger_unattached', 'observer'];
  else if (/Cannot find (?:module|package).*browser-(?:service|client)/i.test(text)) [category, layer] = ['observer_runtime_missing_module', 'observer'];
  else if (/Auto(?:mated)?[- ]review.*(?:denied|refused)|guardian_denied/i.test(text)) [category, layer] = ['observer_review_denied', 'observer'];
  else if (/workspace member hit a limit|credit limit (?:reached|exceeded)|insufficient credits/i.test(text)) [category, layer] = ['workspace_quota_exhausted', 'quota'];
  else if (/Session terminated/i.test(text)) [category, layer] = ['mcp_session_terminated', 'connector'];
  else if (/driver[_ -]lease[_ -](?:lost|expired)|DRIVER_LEASE_LOST/i.test(text)) [category, layer] = ['admission_driver_lease_lost', 'admission'];
  else if (status === 429) [category, layer] = ['http_rate_limited', 'http'];
  else if (status === 404) [category, layer] = ['http_not_found', 'http'];
  else if (/ECONNREFUSED|connection refused|spawn.*ENOENT/i.test(text) || [502, 503, 504].includes(status)) [category, layer] = ['transport_or_origin_failure', 'transport'];
  else if (/context cancel(?:l)?ed|stream cancel(?:l)?ed/i.test(text)) [category, layer] = ['cancellation_observed', 'transport'];
  else return null;
  const event = { category, layer, ...eventTime(raw, line), ...identifiers(raw, line) };
  if (status !== null) event.http_status = status;
  for (const key of ['retry_in_ms', 'poll_timeout_ms', 'poll_deadline_ms']) {
    if (Number.isFinite(raw?.[key]) && raw[key] >= 0) event[key] = raw[key];
  }
  return event;
}

export function cleanStructuredEvent(raw, source) {
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') return null;
  const clean = { source, ...eventTime(raw), ...identifiers(raw) };
  for (const key of ['tool', 'stage', 'outcome', 'status', 'category', 'layer', 'observed_source']) {
    if (typeof raw[key] === 'string' && SAFE_WORD.test(raw[key])) clean[key] = raw[key];
  }
  for (const key of ['result_bytes', 'budget_bytes', 'deadline_remaining_ms', 'duration_ms', 'pid']) {
    if (Number.isFinite(raw[key]) && raw[key] >= 0) clean[key] = raw[key];
  }
  for (const key of ['deadline_known', 'aborted', 'spill_saved', 'duplicated_text_compacted', 'capture_time_not_error_onset']) {
    if (typeof raw[key] === 'boolean') clean[key] = raw[key];
  }
  return clean;
}

export async function tail(file, maxBytes = DEFAULT_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new RangeError('maxBytes must be an integer from 1 to 16777216');
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const buffer = Buffer.alloc(stat.size - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    const bytes = buffer.subarray(0, bytesRead);
    const lines = bytes.toString('utf8').split(/\r?\n/);
    let droppedPrefixBytes = 0;
    if (start) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, start - 1);
      if (previous[0] !== 10) {
        droppedPrefixBytes = bytes.indexOf(10) < 0 ? bytes.length : bytes.indexOf(10) + 1;
        lines.shift();
      }
    }
    return { lines, truncated: start > 0, source_bytes: stat.size, window_start_byte: start,
      read_bytes: bytesRead, window_sha256: createHash('sha256').update(bytes).digest('hex'),
      dropped_partial_prefix_bytes: droppedPrefixBytes, changed_during_read: (await handle.stat()).size !== stat.size };
  } finally { await handle.close(); }
}
export async function collect(logDirectory, eventFile, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new RangeError('maxBytes must be an integer from 1 to 16777216');
  const sources = [], events = [];
  // The installed app rotates to .1 at 5 MiB; current-file-only collection
  // erased the incident history when a healthy service was restored.
  for (const name of ['mcp.log.1', 'mcp.log', 'tunnel.log.1', 'tunnel.log']) {
    if (!logDirectory) continue;
    try {
      const { lines, ...provenance } = await tail(path.join(logDirectory, name), maxBytes);
      sources.push({ name, ...provenance });
      lines.forEach((line, index) => { const event = classifyLine(line); if (event) events.push({ source: name, line_in_window: index + 1, ...event }); });
    } catch (error) { sources.push({ name, unavailable: true, optional: name.endsWith('.1'), code: error.code || 'READ_FAILED' }); }
  }
  for (const [name, file] of [['events.jsonl', eventFile], ['mcp-audit.log', options.auditFile], ['browser-observations.jsonl', options.browserObservationsFile]]) {
    if (!file) continue;
    try {
      const { lines, ...provenance } = await tail(file, maxBytes);
      const source = { name, ...provenance, malformed_lines: 0 }; sources.push(source);
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
          const clean = cleanStructuredEvent(JSON.parse(line), name);
          if (clean) events.push({ ...clean, line_in_window: index + 1 });
        } catch { source.malformed_lines++; /* A partial final line may be in flight. */ }
      }
    } catch (error) { sources.push({ name, unavailable: true, code: error.code || 'READ_FAILED' }); }
  }
  const counts = {};
  for (const event of events) { const key = event.category || event.outcome || event.status || 'other'; counts[key] = (counts[key] || 0) + 1; }
  return { schema_version: 2, collected_at: new Date().toISOString(), max_source_bytes: maxBytes, sources, counts, events,
    limits: ['Read-only bounded log tails; absence of an event is not proof of absence.',
      'Local result-ready events do not prove tunnel POST delivery or browser receipt.',
      'Correlate the exact UI error timestamp and request IDs before attributing a cause.',
      'Clock-only MCP timestamps require the incident date/timezone; no date is guessed.',
      'A generic HTTP error is not assigned to Web Chat versus its observer without exact source/request correlation.',
      'Approval and observer gaps require browser evidence and are never inferred as continuous model work.',
      'Review diagnostic files before sharing. Raw HAR, headers, console content and bodies are intentionally not exported.'] };
}
const args = process.argv.slice(2);
function value(flag) { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain && args.includes('--self-test')) {
  const line = '06:00:00 level=ERROR request_id=cmd_fixture session_id=session_fixture error="unexpected status 413: request_body_too_large" Authorization=SECRET https://private.example/token';
  const parsed = classifyLine(line);
  assert.equal(parsed.category, 'payload_rejected'); assert.equal(parsed.request_id, 'cmd_fixture');
  assert.ok(!JSON.stringify(parsed).includes('SECRET')); assert.ok(!JSON.stringify(parsed).includes('private.example'));
  assert.equal(classifyLine('06:00:00 command response deadline reached; dropping without posting a response').category, 'command_response_deadline');
  assert.equal(classifyLine('healthy request_id=fixture502'), null);
  assert.equal(classifyLine('Message delivery timed out').category, 'host_ui_timeout_observed');
  console.log('diagnostic-collector: 7 assertions PASS');
} else if (isMain && (value('--logs') || value('--events') || value('--audit') || value('--observations'))) {
  const report = await collect(value('--logs'), value('--events'), {
    maxBytes: value('--max-bytes') === undefined ? DEFAULT_MAX_BYTES : Number(value('--max-bytes')), auditFile: value('--audit'),
    browserObservationsFile: value('--observations') });
  const output = value('--out');
  if (output) { await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); console.log('Diagnostic report written: ' + output); }
  else console.log(JSON.stringify(report, null, 2));
} else if (isMain) {
  console.log('Usage: node collect-timeout-diagnostics.mjs --logs <account-log-directory> [--events <events.jsonl>] [--audit <audit.log>] [--observations <metadata.jsonl>] [--max-bytes <1..16777216>] --out <report.json>');
}
