import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyLine, cleanStructuredEvent, collect, tail } from './collect-timeout-diagnostics.mjs';

let assertions = 0;
function equal(actual, expected) { assert.deepEqual(actual, expected); assertions++; }
function okay(value) { assert.ok(value); assertions++; }
const json = raw => '12:11:20   ' + JSON.stringify(raw);
const fault = classifyLine(json({ time: '2026-09-29T21:52:31.6191429+08:00', msg: 'poll failed; backing off',
  error: 'POST https://private.example?token=SECRET HTTP 503', tunnel_request_id: 'tunnel_fixture', retry_in_ms: 1500 }));
equal(fault.category, 'poll_failed_backoff');
equal(fault.time, '2026-09-29T13:52:31.619Z');
equal(fault.time_precision, 'absolute');
equal(fault.tunnel_request_id, 'tunnel_fixture');
equal(fault.retry_in_ms, 1500);
equal(fault.http_status, 503);
okay(!JSON.stringify(fault).includes('SECRET'));
okay(!JSON.stringify(fault).includes('private.example'));
equal(classifyLine(json({ msg: 'poll timed out; backing off', error: 'context canceled' })).category, 'poll_timeout_backoff');
equal(classifyLine(json({ status_code: 429, msg: 'gateway probe failed' })).category, 'http_rate_limited');
equal(classifyLine('HTTP/1.1 404').category, 'http_not_found');
equal(classifyLine('status=413').category, 'payload_rejected');
equal(classifyLine('Session terminated').layer, 'connector');
equal(classifyLine('Debugger unattached').layer, 'observer');
equal(classifyLine("Cannot find module 'D:/official/browser-service.mjs' imported from trusted-worker").category, 'observer_runtime_missing_module');
equal(classifyLine('Auto-review denied this action').category, 'observer_review_denied');
equal(classifyLine('A workspace member hit a limit').layer, 'quota');
equal(classifyLine('ChatGPT stream recovery polling timed out').category, 'web_stream_recovery_polling_timeout');
equal(classifyLine('ChatGPT stream recovery polling timed out').layer, 'web_ui');
equal(classifyLine('DRIVER_LEASE_LOST').layer, 'admission');
equal(classifyLine('healthy request_id=cmd_429_413_404_fixture'), null);
equal(classifyLine(json({ msg: 'healthy', request_id: 'uuid-429-413-404', command: 'HTTP 503' })), null);
equal(classifyLine('06:00:00 Command timed out after 15 seconds').time_precision, 'clock_only');
equal(classifyLine(json({ time: '2026-09-29T06:00:00', msg: 'Session terminated' })).time_precision, 'clock_only');
equal(classifyLine('not JSON {broken'), null);
const clean = cleanStructuredEvent({ time: '2026-09-30T02:40:52Z', tool: 'read_text_file', status: 'ok', pid: 42,
  request_id: 'https://SECRET.example', args: { token: 'SECRET' }, target: 'D:/private/SECRET', action: 'password SECRET' }, 'mcp-audit.log');
equal(clean.tool, 'read_text_file'); equal(clean.time, '2026-09-30T02:40:52.000Z');
okay(!JSON.stringify(clean).includes('SECRET')); equal(clean.request_id, undefined);
equal(cleanStructuredEvent(null, 'events'), null);

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'web-harness-diag-'));
try {
  await fs.writeFile(path.join(fixtureRoot, 'mcp.log'), '06:00:00 Message delivery timed out\nhealthy request_id=uuid429\n');
  const tunnelLine = json({ time: '2026-09-30T01:00:00+08:00', msg: 'poll timed out; backing off', error: 'SECRET' });
  await fs.writeFile(path.join(fixtureRoot, 'tunnel.log'), tunnelLine + '\n');
  await fs.writeFile(path.join(fixtureRoot, 'tunnel.log.1'), json({ time: '2026-09-29T21:52:31+08:00', msg: 'poll failed; backing off' }) + '\n');
  await fs.writeFile(path.join(fixtureRoot, 'audit.log'), JSON.stringify({ time: '2026-09-30T02:40:52Z', tool: 'read_text_file', status: 'ok', target: 'SECRET' }) + '\n{partial');
  await fs.writeFile(path.join(fixtureRoot, 'observations.jsonl'), JSON.stringify({time:'2026-09-30T06:58:41Z',category:'web_stream_recovery_polling_timeout',layer:'web_ui',capture_time_not_error_onset:true,transcript:'SECRET'}) + '\n');
  const report = await collect(fixtureRoot, undefined, { auditFile: path.join(fixtureRoot, 'audit.log'), browserObservationsFile:path.join(fixtureRoot,'observations.jsonl') });
  equal(report.counts, { host_ui_timeout_observed: 1, poll_failed_backoff: 1, poll_timeout_backoff: 1, ok: 1, web_stream_recovery_polling_timeout:1 });
  equal(report.events.find(event=>event.source==='browser-observations.jsonl').capture_time_not_error_onset,true);
  equal(report.sources.find(source => source.name === 'mcp-audit.log').malformed_lines, 1);
  okay(report.sources.filter(source => !source.unavailable).every(source => source.window_sha256?.length === 64));
  okay(report.sources.filter(source => !source.unavailable).every(source => !source.truncated));
  equal(report.events.find(event => event.source === 'tunnel.log.1').category, 'poll_failed_backoff');
  okay(!JSON.stringify(report).includes('SECRET'));
  await fs.writeFile(path.join(fixtureRoot, 'boundary.log'), 'drop\nkeep\n');
  equal((await tail(path.join(fixtureRoot, 'boundary.log'), 5)).lines, ['keep', '']);
  equal((await tail(path.join(fixtureRoot, 'boundary.log'), 5)).dropped_partial_prefix_bytes, 0);
  equal((await tail(path.join(fixtureRoot, 'boundary.log'), 7)).lines, ['keep', '']);
  equal((await tail(path.join(fixtureRoot, 'boundary.log'), 7)).dropped_partial_prefix_bytes, 2);
  const missing = await collect(path.join(fixtureRoot, 'missing'));
  equal(missing.sources.map(source => source.code), ['ENOENT', 'ENOENT', 'ENOENT', 'ENOENT']);
  await assert.rejects(collect(fixtureRoot, undefined, { maxBytes: -1 }), RangeError); assertions++;
  await assert.rejects(tail(path.join(fixtureRoot, 'boundary.log'), 16777217), RangeError); assertions++;
} finally {
  // Only this exact mkdtemp-owned fixture is removed; no user/workspace paths.
  okay(path.dirname(fixtureRoot) === os.tmpdir() && path.basename(fixtureRoot).startsWith('web-harness-diag-'));
  await fs.rm(fixtureRoot, { recursive: true });
}
console.log(`diagnostic-collector: ${assertions} regression assertions PASS`);
