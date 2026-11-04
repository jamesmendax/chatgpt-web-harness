import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { collect } from './collect-timeout-diagnostics.mjs';

// A passive local evidence instrument, not a browser controller or model driver.
// It never reads credentials, captures response bodies, retries tools, or sends.
export function summarize(report, previous = null, health = {}, observedAt = new Date().toISOString()) {
  const latest = predicate => report.events.filter(event => predicate(event)
    && event.time_precision === 'absolute' && typeof event.time === 'string')
    .sort((left, right) => left.time.localeCompare(right.time)).at(-1);
  const fileRead = latest(event => event.source === 'mcp-audit.log'
    && ['read_text_file', 'read_file_base64'].includes(event.tool));
  // An observer connection failure is not a fresh native page observation.
  // Unknown/legacy layers also fail closed rather than refreshing the UI clock.
  const ui = latest(event => event.source === 'browser-observations.jsonl'
    && event.layer === 'web_ui');
  const observerFailureCategories = new Set(['observer_debugger_unattached',
    'observer_runtime_missing_module', 'observer_review_denied', 'host_ui_timeout_observed']);
  const observerFailure = latest(event => event.source === 'browser-observations.jsonl'
    && event.layer === 'observer' && (event.outcome === 'failed'
      || observerFailureCategories.has(event.category)));
  const result = {
    schema_version: 1,
    kind: 'metadata_sample',
    observed_at: observedAt,
    collector_at: report.collected_at,
    health: { mcp: health.mcp ?? null, tunnel: health.tunnel ?? null },
    last_project_file_read_at: fileRead?.time ?? null,
    last_project_file_read_pid: fileRead?.pid ?? null,
    file_read_time_advanced: Boolean(previous && fileRead?.time
      && fileRead.time > (previous.last_project_file_read_at || '')),
    last_ui_observation_at: ui?.time ?? null,
    last_known_ui_category: ui?.category ?? null,
    last_observer_failure_at: observerFailure?.time ?? null,
    counts_in_available_log_windows: report.counts,
    sources: report.sources.map(({ name, unavailable, truncated, source_bytes, window_start_byte,
      window_sha256, changed_during_read }) => ({ name, unavailable, truncated, source_bytes,
      window_start_byte, window_sha256, changed_during_read })),
    native_continuity_verified: false,
    limits: [
      'Local file-tool activity is not attributed to one Web Chat without owner/request evidence.',
      'Stored UI observations are last-known captures, not a fresh browser read.',
      'This process cannot keep a Web Chat model alive or retry/continue its task.',
      'Health or a growing timeline never counts as an active-work hour.'
    ]
  };
  return result;
}

async function loopbackHealth() {
  const probe = async url => {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel(); return response.status;
    } catch { return null; }
  };
  const [mcp, tunnel] = await Promise.all([
    probe('http://127.0.0.1:3300/health'), probe('http://127.0.0.1:8380/readyz')
  ]);
  return { mcp, tunnel };
}

export async function watch(options) {
  const intervalMs = options.intervalMs ?? 15000;
  const durationMs = options.durationMs ?? 180 * 60000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
    throw new RangeError('intervalMs must be an integer from 1000 to 60000');
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 24 * 60 * 60000)
    throw new RangeError('durationMs must be from 1000 to 86400000');
  const output = path.resolve(options.output);
  const timeline = path.resolve(options.timeline);
  if (output === timeline || path.dirname(output) !== path.dirname(timeline))
    throw new Error('Distinct output and timeline must share the named artifact directory');
  const lockPath = output + '.watch-lock.json';
  const watchId = randomUUID();
  const lockBytes = JSON.stringify({ watch_id: watchId, pid: process.pid,
    started_at: new Date().toISOString(), interval_ms: intervalMs, duration_ms: durationMs });
  const lock = await fs.open(lockPath, 'wx', 0o600); // Fail closed on any existing owner.
  let stop = false, sample = null, samples = 0;
  const abort = new AbortController();
  const stopRequested = () => { stop = true; abort.abort(); };
  try {
    await lock.writeFile(lockBytes); await lock.sync();
    process.on('SIGINT', stopRequested); process.on('SIGTERM', stopRequested);
    const end = Date.now() + durationMs;
    while (!stop && Date.now() < end) {
      const report = await collect(options.logDirectory, options.eventFile, {
        auditFile: options.auditFile, browserObservationsFile: options.browserObservationsFile });
      sample = { ...summarize(report, sample, await loopbackHealth()), watch_id: watchId,
        monitor_pid: process.pid, sequence: ++samples, monitor_state: 'running' };
      await fs.writeFile(output, JSON.stringify(sample, null, 2) + '\n', { mode: 0o600 });
      await fs.appendFile(timeline, JSON.stringify(sample) + '\n', { mode: 0o600 });
      const remaining = end - Date.now();
      if (remaining <= 0) break;
      try { await delay(Math.min(intervalMs, remaining), undefined, { signal: abort.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
    const ended = { kind: 'monitor_stopped', observed_at: new Date().toISOString(),
      watch_id: watchId, monitor_pid: process.pid, samples, reason: stop ? 'signal' : 'duration' };
    await fs.appendFile(timeline, JSON.stringify(ended) + '\n', { mode: 0o600 });
    if (sample) await fs.writeFile(output, JSON.stringify({ ...sample,
      monitor_state: 'stopped', stopped_at: ended.observed_at, stop_reason: ended.reason }, null, 2) + '\n');
    return ended;
  } finally {
    process.off('SIGINT', stopRequested); process.off('SIGTERM', stopRequested);
    await lock.close();
    // Only unlink the exact lock created here, if its ownership bytes still match.
    if (path.dirname(lockPath) === path.dirname(output)
      && await fs.readFile(lockPath, 'utf8').catch(() => null) === lockBytes) await fs.unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const value = flag => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  if (!value('--out') || !value('--timeline') || !value('--logs')) {
    console.error('Usage: node watch-timeout-diagnostics.mjs --logs <dir> --audit <file> --observations <metadata.jsonl> --out <latest.json> --timeline <samples.jsonl> [--interval-ms 15000] [--duration-minutes 180]');
    process.exitCode = 1;
  } else {
    const result = await watch({ logDirectory: value('--logs'), auditFile: value('--audit'),
      browserObservationsFile: value('--observations'), output: value('--out'), timeline: value('--timeline'),
      intervalMs: value('--interval-ms') === undefined ? 15000 : Number(value('--interval-ms')),
      durationMs: value('--duration-minutes') === undefined ? 180 * 60000 : Number(value('--duration-minutes')) * 60000 });
    console.log(JSON.stringify(result));
  }
}
