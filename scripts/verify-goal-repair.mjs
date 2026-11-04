import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDir = path.resolve(root, '../diagnostics');
fs.mkdirSync(reportDir, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-goal-regression-'));
const env = { ...process.env, CODEX_HOME: path.join(fixture, 'home'), AUDIT_LOG_PATH: path.join(fixture, 'audit.log'), GOAL_WATCHDOG_ENABLED: 'false', DOTENV_CONFIG_PATH: path.join(fixture, 'empty.env') };
for (const key of Object.keys(env)) if (/API_KEY|SECRET|AUTHORIZATION|ACCESS_TOKEN|TUNNEL_ID|TUNNEL_TOKEN|^MCP_TOKEN$|^ADMIN_TOKEN$/i.test(key)) delete env[key];
fs.writeFileSync(env.DOTENV_CONFIG_PATH, '');
const cases = [
  ['build-typescript6', ['node_modules/typescript/bin/tsc', '--pretty', 'false']],
  ['goal-status-purity', ['scripts/test-goal-status-purity.mjs']],
  ['goal-run-state', ['scripts/test-goal-run-state.mjs']],
  ['goal-run-store', ['scripts/test-goal-run-store.mjs']],
  ['goal-run-web', ['scripts/test-goal-run-web.mjs']],
  ['goal-mode', ['scripts/test-goal-mode.mjs']],
  ['goal-scope', ['scripts/test-goal-scope.mjs']],
  ['goal-web-freeze', ['scripts/test-goal-web-freeze.mjs']],
  ['goal-run-policy', ['scripts/test-goal-run-policy.mjs']],
  ['state-response', ['scripts/test-state-response.mjs']],
  ['invocation-gateway', ['scripts/test-invocation-gateway.mjs']],
  ['typescript-unified', ['scripts/test-typescript-unified.mjs']],
  ['mcp-outcome-log', ['scripts/test-mcp-outcome-log.mjs']],
  ['mcp-outcome-correlation', ['scripts/test-mcp-outcome-correlation.mjs']],
  ['grep-resilience', ['scripts/test-grep-resilience.mjs']],
  ['search-cursor', ['scripts/test-search-cursor.mjs']],
  ['context-bundle', ['scripts/test-context-bundle.mjs']],
  ['recovery-v2', ['scripts/test-recovery-v2.mjs']],
  ['coding-v2', ['scripts/test-coding-v2.mjs']],
  ['code-intelligence-cache-rename', ['scripts/test-code-intelligence-cache-rename.mjs']],
  ['browser-turn-fence', ['scripts/test-browser-turn-fence.mjs']],
  ['tool-profile', ['scripts/test-tool-profile.mjs']],
];
const results = [];
try {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json'))).version, '6.0.3');
  for (const [name, args] of cases) {
    const started = Date.now();
    const r = spawnSync(process.execPath, args, { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    const row = { name, args, status: r.status === 0 && !r.error ? 'PASS' : 'FAIL', exit_code: r.status, signal: r.signal, duration_ms: Date.now() - started, error: r.error?.message ?? null, stdout_tail: (r.stdout ?? '').slice(-5000), stderr_tail: (r.stderr ?? '').slice(-5000) };
    results.push(row);
    console.log(`${row.status} ${name} exit=${r.status}`);
  }
} finally {
  const files = [
    'package.json', 'package-lock.json', 'README.md',
    'src/tools/goal.ts', 'src/lib/context-broker.ts',
    'src/lib/code-intelligence.ts', 'src/tools/code-intelligence.ts',
    'src/lib/mcp-outcome.ts', 'src/lib/activity-log.ts', 'src/lib/invocation-gateway.ts', 'src/index.ts',
    'src/lib/browser-turn-fence.ts', 'src/tools/browser.ts',
    'src/lib/grep-search.ts', 'src/tools/filesystem.ts', 'src/lib/context-bundle.ts', 'src/tools/context.ts',
    'desktop/scripts/stage-harness.mjs', 'desktop/scripts/lib/runtime-file-policy.mjs',
    'scripts/test-goal-status-purity.mjs', 'scripts/test-goal-web-freeze.mjs', 'scripts/test-typescript-unified.mjs',
    'scripts/test-mcp-outcome-log.mjs', 'scripts/test-mcp-outcome-correlation.mjs',
    'scripts/test-grep-resilience.mjs', 'scripts/test-search-cursor.mjs', 'scripts/test-context-bundle.mjs',
    'scripts/test-recovery-v2.mjs', 'scripts/test-coding-v2.mjs', 'scripts/test-code-intelligence-cache-rename.mjs',
    'scripts/test-browser-turn-fence.mjs', 'scripts/release-benchmark-gate.mjs', 'scripts/run-all-tests.mjs',
    'scripts/verify-goal-repair.mjs'
  ];
  const hashes = files.map((file) => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
  const report = {
    schema: 2, checked_at: new Date().toISOString(), scope: 'Offline Goal/outcome/P0/P1 reliability candidate verification',
    scoped_result: results.length === cases.length && results.every((row) => row.status === 'PASS') ? 'PASS' : 'FAIL',
    executed: results.length, expected: cases.length, results, files: hashes,
    offline_scope_complete: results.length === cases.length && results.every((row) => row.status === 'PASS'),
    packaged: false, live_runtime_replaced: false,
    platform_keyword_trigger_identified: false, all_native_calls_admitted: false,
    outstanding: [
      'Current live MCP/Tunnel has not been replaced by this candidate.',
      'Clean-profile installer acceptance is intentionally not run against the production account.',
      'No claim of live ChatGPT client/cloud long-stream acceptance or unconditional platform admission.',
      'Document adapters remain optional/de-scoped from the reliability P0/P1 candidate rather than a blocking core reliability item.'
    ]
  };
  const name = 'goal-repair-verification-' + report.checked_at.replaceAll(':', '-').replaceAll('.', '-') + '.json';
  fs.writeFileSync(path.join(reportDir, name), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.join(reportDir, name), scoped_result: report.scoped_result, executed: report.executed, offline_scope_complete: report.offline_scope_complete, packaged: false }));
  fs.rmSync(fixture, { recursive: true, force: true });
  if (report.scoped_result !== 'PASS') process.exitCode = 1;
}
