import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const diagnosticsDir = path.resolve(root, '../diagnostics');
const reportPath = path.join(
  diagnosticsDir,
  `release-benchmark-gate-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.json`,
);

const cases = [
  { name: 'goal-work-progress', args: ['scripts/test-goal-work-progress.mjs'], category: 'goal_continuation' },
  { name: 'grep-deadline-isolation', args: ['scripts/test-grep-deadline.mjs'], category: 'transport_responsiveness' },
  { name: 'schema-compliance', args: ['scripts/test-tool-profile.mjs'], category: 'schema_drift' },
  { name: 'deterministic-tool-dogfood', args: ['scripts/test-tools.mjs'], category: 'mcp_dogfood' },
  { name: 'invocation-gateway', args: ['scripts/test-invocation-gateway.mjs'], category: 'mcp_dogfood' },
  { name: 'payload-transport', args: ['scripts/test-transport-resilience.mjs'], category: 'payload_regression' },
  { name: 'stream-survival', args: ['scripts/test-stream-survival.mjs'], category: 'stream_recovery' },
  { name: 'mcp-event-replay', args: ['scripts/test-mcp-event-store.mjs'], category: 'stream_recovery' },
  { name: 'restart-recovery', args: ['scripts/test-recovery-v2.mjs'], category: 'restart_recovery' },
  { name: 'durable-operation-recovery', args: ['scripts/test-operation-recovery.mjs'], category: 'restart_recovery' },
  { name: 'five-repo-atomic-config', args: ['scripts/test-safe-text-write.mjs'], category: 'source_adoption' },
  { name: 'five-repo-semantic-implementations', args: ['scripts/test-code-intelligence.mjs'], category: 'source_adoption' },
  { name: 'five-repo-turn-lifecycle', args: ['scripts/test-browser-turn-fence.mjs'], category: 'source_adoption' },
  { name: 'five-repo-output-integrity', args: ['scripts/test-process-unicode.mjs'], category: 'source_adoption' },
  { name: 'public-workload-graders', args: ['scripts/agent-eval.mjs', 'selftest'], category: 'real_workload_harness' },
];

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function runCase(entry) {
  const started = performance.now();
  const result = spawnSync(process.execPath, entry.args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: 'true', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
  });
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  return {
    ...entry,
    status: result.status === 0 && !result.error ? 'PASS' : 'FAIL',
    exit_code: result.status,
    signal: result.signal,
    duration_ms: durationMs,
    error: result.error?.message ?? null,
    stdout_tail: (result.stdout ?? '').slice(-4000),
    stderr_tail: (result.stderr ?? '').slice(-4000),
  };
}

const stressScenarios = [
  { name: 'http_drop_duplicate_large_payload', script: 'scripts/test-stream-survival.mjs', samples: 5 },
  { name: 'source_dead_epoch_fencing', script: 'scripts/test-relay-manager.mjs', samples: 20 },
  { name: 'turn_acceptance_and_ambiguity_fence', script: 'scripts/test-browser-turn-fence.mjs', samples: 50 },
  { name: 'sse_last_event_id_replay', script: 'scripts/test-mcp-event-store.mjs', samples: 25 },
];

function runStreamRecoveryStress() {
  const scenarios = [];
  for (const scenario of stressScenarios) {
    const samples = [];
    for (let index = 0; index < scenario.samples; index++) {
      const started = performance.now();
      const result = spawnSync(process.execPath, [scenario.script], {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: 'true', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' },
      });
      samples.push({
        index: index + 1,
        status: result.status === 0 && !result.error ? 'PASS' : 'FAIL',
        duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
        exit_code: result.status,
        error: result.error?.message ?? null,
        stdout_tail: result.status === 0 ? undefined : (result.stdout ?? '').slice(-2000),
        stderr_tail: result.status === 0 ? undefined : (result.stderr ?? '').slice(-2000),
      });
    }
    const durations = samples.map((sample) => sample.duration_ms);
    const recovered = samples.filter((sample) => sample.status === 'PASS').length;
    scenarios.push({
      name: scenario.name,
      script: scenario.script,
      samples: samples.length,
      recovered,
      recovery_rate: recovered / samples.length,
      fixture_completion_latency_ms: {
        p50: percentile(durations, 0.50),
        p95: percentile(durations, 0.95),
        max: Math.max(...durations),
      },
      results: samples,
    });
  }
  const all = scenarios.flatMap((scenario) => scenario.results);
  const recovered = all.filter((sample) => sample.status === 'PASS').length;
  return {
    scope: 'isolated local recovery fixtures; no live MCP/Tunnel or ChatGPT account',
    dimensions: [
      'real HTTP response loss with ten duplicate retries and oversized output',
      'source-dead relay takeover with epoch fencing and same Goal',
      'turn acceptance/completion/ambiguity fences',
      'persistent SSE Last-Event-ID replay',
    ],
    model_dimension: 'not available in an offline fixture; measured separately by live ChatGPT acceptance',
    total_samples: all.length,
    recovered,
    recovery_rate: recovered / all.length,
    fixture_completion_latency_ms: {
      p50: percentile(all.map((sample) => sample.duration_ms), 0.50),
      p95: percentile(all.map((sample) => sample.duration_ms), 0.95),
      max: Math.max(...all.map((sample) => sample.duration_ms)),
    },
    scenarios,
  };
}

async function localLatencyBenchmark() {
  const { grepSearchPage } = await import('../dist/lib/grep-search.js');
  const { selectRelevantContext } = await import('../dist/lib/context-bundle.js');
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'wh-release-bench-'));
  try {
    const searchFile = path.join(fixture, 'fixture.ts');
    const searchText = Array.from({ length: 400 }, (_, index) =>
      index % 7 === 0 ? `export const needle_${index} = ${index};` : `export const value_${index} = ${index};`
    ).join('\n');
    await fsp.writeFile(searchFile, searchText);
    const sources = [
      {
        path: path.join(fixture, 'AGENTS.md'),
        content: '# Release\nRun build, transport, recovery, and workload gates before packaging.\n',
        truncated: false,
        bytes: 78,
      },
      {
        path: path.join(fixture, 'README.md'),
        content: '# Search\nCursor paging uses offset and next_offset while retaining bounded output.\n',
        truncated: false,
        bytes: 82,
      },
    ];
    const samples = [];
    for (let index = 0; index < 30; index++) {
      let started = performance.now();
      const page = await grepSearchPage({ path: searchFile, pattern: 'needle', headLimit: 20, offset: index % 3 });
      assert.ok(page.rows > 0);
      samples.push(performance.now() - started);

      started = performance.now();
      const bundle = selectRelevantContext(fixture, sources, 'release recovery search cursor', { maxTotalBytes: 4000, maxChunks: 4 });
      assert.ok(bundle.chunks.length > 0);
      assert.match(bundle.export_manifest.revision, /^[a-f0-9]{64}$/);
      samples.push(performance.now() - started);
    }
    const rounded = samples.map((value) => Math.round(value * 1000) / 1000);
    return {
      scope: 'local_harness_operations_only',
      note: 'Measures deterministic local search/context operations; excludes model, browser network, MCP tunnel, and client delivery latency.',
      samples: rounded.length,
      min_ms: Math.min(...rounded),
      p50_ms: Math.round(percentile(rounded, 0.50) * 1000) / 1000,
      p95_ms: Math.round(percentile(rounded, 0.95) * 1000) / 1000,
      max_ms: Math.max(...rounded),
      threshold_p95_ms: 2000,
    };
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

await fsp.mkdir(diagnosticsDir, { recursive: true });

const buildStarted = performance.now();
const build = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--pretty', 'false'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 120_000,
  maxBuffer: 8 * 1024 * 1024,
});
const buildResult = {
  status: build.status === 0 && !build.error ? 'PASS' : 'FAIL',
  exit_code: build.status,
  duration_ms: Math.round((performance.now() - buildStarted) * 1000) / 1000,
  error: build.error?.message ?? null,
  stdout_tail: (build.stdout ?? '').slice(-4000),
  stderr_tail: (build.stderr ?? '').slice(-4000),
};

const results = buildResult.status === 'PASS' ? cases.map(runCase) : [];
let latency = null;
let latencyError = null;
let streamRecoveryStress = null;
let streamRecoveryStressError = null;
if (buildResult.status === 'PASS') {
  try {
    latency = await localLatencyBenchmark();
  } catch (error) {
    latencyError = error instanceof Error ? error.stack || error.message : String(error);
  }
  try {
    streamRecoveryStress = runStreamRecoveryStress();
  } catch (error) {
    streamRecoveryStressError = error instanceof Error ? error.stack || error.message : String(error);
  }
}

const categories = Object.fromEntries(
  [...new Set(cases.map((entry) => entry.category))].map((category) => {
    const rows = results.filter((entry) => entry.category === category);
    return [category, { passed: rows.length > 0 && rows.every((entry) => entry.status === 'PASS'), cases: rows.map((entry) => entry.name) }];
  }),
);
const latencyPassed = Boolean(latency && latency.p95_ms <= latency.threshold_p95_ms);
const streamStressPassed = Boolean(
  streamRecoveryStress &&
  streamRecoveryStress.total_samples >= 100 &&
  streamRecoveryStress.recovery_rate === 1
);
const passed = buildResult.status === 'PASS'
  && results.length === cases.length
  && results.every((entry) => entry.status === 'PASS')
  && latencyPassed
  && streamStressPassed;

const report = {
  schema: 1,
  checked_at: new Date().toISOString(),
  result: passed ? 'PASS' : 'FAIL',
  scope: 'offline release benchmark gate; does not exercise or restart live MCP/Tunnel',
  build: buildResult,
  cases: results,
  categories,
  command_latency_ms: results.length ? {
    p50: percentile(results.map((entry) => entry.duration_ms), 0.50),
    p95: percentile(results.map((entry) => entry.duration_ms), 0.95),
  } : null,
  local_operation_latency: latency,
  local_operation_latency_error: latencyError,
  stream_recovery_stress: streamRecoveryStress,
  stream_recovery_stress_error: streamRecoveryStressError,
  source_fingerprints: {
    package_json: sha256(path.join(root, 'package.json')),
    tool_profile: sha256(path.join(root, 'src/lib/tool-profile.ts')),
    transport_resilience: sha256(path.join(root, 'src/lib/transport-resilience.ts')),
    process_journal: sha256(path.join(root, 'src/lib/process-journal.ts')),
    grep_search: sha256(path.join(root, 'src/lib/grep-search.ts')),
    context_bundle: sha256(path.join(root, 'src/lib/context-bundle.ts')),
    goal_work_progress: sha256(path.join(root, 'src/lib/goal-work-progress.ts')),
    relay_manager: sha256(path.join(root, 'src/lib/relay-manager.ts')),
    mcp_session_manager: sha256(path.join(root, 'src/lib/mcp-session-manager.ts')),
    mcp_event_store: sha256(path.join(root, 'src/lib/mcp-event-store.ts')),
    computer_use_provider: sha256(path.join(root, 'src/lib/computer-use-provider.ts')),
    browser_use_provider: sha256(path.join(root, 'src/lib/browser-use-provider.ts')),
    provider_health: sha256(path.join(root, 'src/lib/provider-health.ts')),
    browser_use_runtime_lock: sha256(path.join(root, 'bundled-plugins/browser-use/runtime-lock.json')),
  },
  live_runtime_touched: false,
  model_benchmark_included: false,
  note: 'Harness preflight/workload grader validation is intentionally separated from any model benchmark or live ChatGPT stream acceptance.',
};

await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ result: report.result, report: reportPath, categories, local_operation_latency: latency,
  stream_recovery_stress: streamRecoveryStress && {
    total_samples: streamRecoveryStress.total_samples,
    recovered: streamRecoveryStress.recovered,
    recovery_rate: streamRecoveryStress.recovery_rate,
    fixture_completion_latency_ms: streamRecoveryStress.fixture_completion_latency_ms,
  },
}, null, 2));
if (!passed) process.exitCode = 1;
