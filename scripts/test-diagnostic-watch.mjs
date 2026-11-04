import assert from 'node:assert/strict';
import { summarize, watch } from './watch-timeout-diagnostics.mjs';

const report = { collected_at: '2026-09-30T07:00:00Z', counts: { poll_failed_backoff: 149 },
  sources: [{ name: 'tunnel.log', truncated: false, window_sha256: 'fixture' }], events: [
    { source: 'mcp-audit.log', time_precision: 'absolute', time: '2026-09-30T02:47:17Z', tool: 'read_text_file', pid: 21264, target: 'SECRET' },
    { source: 'mcp-audit.log', time_precision: 'absolute', time: '2026-09-30T07:00:00Z', tool: 'agent_status', pid: 21264 },
    { source: 'browser-observations.jsonl', time_precision: 'absolute', time: '2026-09-30T06:48:47Z', category: 'observer_debugger_unattached', layer: 'observer' },
    { source: 'browser-observations.jsonl', time_precision: 'absolute', time: '2026-09-30T06:58:41Z', category: 'web_stream_recovery_polling_timeout', layer: 'web_ui' }
  ] };
const first = summarize(report, null, { mcp: 200, tunnel: 200 });
assert.equal(first.last_project_file_read_at, '2026-09-30T02:47:17Z');
assert.equal(first.last_project_file_read_pid, 21264);
assert.equal(first.file_read_time_advanced, false);
assert.equal(first.last_known_ui_category, 'web_stream_recovery_polling_timeout');
assert.equal(first.native_continuity_verified, false);
assert.ok(!JSON.stringify(first).includes('SECRET'));
const unchanged = summarize(report, first);
assert.equal(unchanged.file_read_time_advanced, false);
assert.equal(unchanged.health.mcp, null);
report.events.push({ source: 'mcp-audit.log', time_precision: 'absolute', time: '2026-09-30T07:01:00Z', tool: 'read_file_base64', pid: 21264 });
assert.equal(summarize(report, first).file_read_time_advanced, true);
assert.equal(summarize(report, first).native_continuity_verified, false);
report.events.push({ source: 'browser-observations.jsonl', time_precision: 'absolute',
  time: '2026-09-30T09:22:53Z', category: 'observer_debugger_unattached', layer: 'observer' });
const newerObserver = summarize(report, first);
assert.equal(newerObserver.last_ui_observation_at, '2026-09-30T06:58:41Z');
assert.equal(newerObserver.last_known_ui_category, 'web_stream_recovery_polling_timeout');
assert.equal(newerObserver.last_observer_failure_at, '2026-09-30T09:22:53Z');
assert.equal(newerObserver.native_continuity_verified, false);
report.events.push({ source: 'browser-observations.jsonl', time_precision: 'absolute',
  time: '2026-09-30T09:25:00Z', category: 'observer_transport_connected', layer: 'observer' });
assert.equal(summarize(report).last_observer_failure_at, '2026-09-30T09:22:53Z');
assert.equal(summarize(report).last_ui_observation_at, '2026-09-30T06:58:41Z');
const observerOnly = summarize({ ...report,
  events: report.events.filter(event => event.layer === 'observer') });
assert.equal(observerOnly.last_ui_observation_at, null);
assert.equal(observerOnly.last_known_ui_category, null);
assert.equal(observerOnly.native_continuity_verified, false);
const unknownLayer = summarize({ ...report, events: [{ source: 'browser-observations.jsonl',
  time_precision: 'absolute', time: '2026-09-30T09:26:00Z',
  category: 'web_stream_recovery_polling_timeout' }] });
assert.equal(unknownLayer.last_ui_observation_at, null);
report.events.push({ source: 'browser-observations.jsonl', time_precision: 'absolute',
  time: '2026-09-30T09:27:00Z', category: 'web_native_progress_observed', layer: 'web_ui' });
assert.equal(summarize(report).last_ui_observation_at, '2026-09-30T09:27:00Z');
assert.equal(summarize(report).last_known_ui_category, 'web_native_progress_observed');
assert.equal(summarize(report).last_observer_failure_at, '2026-09-30T09:22:53Z');
assert.equal(summarize(report).native_continuity_verified, false);
report.events.push({ source: 'browser-observations.jsonl', time_precision: 'absolute',
  time: '2026-09-30T09:28:00Z', category: 'observer_other_failure', layer: 'observer', outcome: 'failed' });
assert.equal(summarize(report).last_observer_failure_at, '2026-09-30T09:28:00Z');
await assert.rejects(watch({ intervalMs: 0 }), RangeError);
await assert.rejects(watch({ durationMs: 999 }), RangeError);
console.log('diagnostic-watch: 27 metadata/layer-isolation/no-false-continuity assertions PASS');
