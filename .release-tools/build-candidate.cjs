"use strict";

// Isolated candidate workflow: builds, launches, installs, and uninstalls only under
// task-scoped temporary roots. It never publishes or takes over live services.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createReleaseEvidenceSummary } = require("./release-evidence.cjs");
const { parseMode, assertBuildMode } = require("./candidate-mode.cjs");
const mode = parseMode(process.argv.slice(2));
for (const arg of process.argv.slice(2)) if (arg !== "--local-development") throw new Error(`Unknown option: ${arg}`);

const repo = path.resolve(__dirname, "..");
const desktop = path.join(repo, "desktop");
const validation = path.join(repo, ".validation");
const node = "C:\\Program Files\\nodejs\\node.exe";
const npm = path.join(path.dirname(node), "node_modules/npm/bin/npm-cli.js");


function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceSignature() {
  return require("./source-signature.cjs").sourceSignature(repo);
}

function readReleaseMetadata() {
  const rootPackage = readJson(path.join(repo, "package.json"));
  const desktopPackage = readJson(path.join(desktop, "package.json"));
  const rootLock = readJson(path.join(repo, "package-lock.json"));
  const desktopLock = readJson(path.join(desktop, "package-lock.json"));
  const version = rootPackage.version;
  assert.equal(typeof version, "string", "root package version is missing");
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "invalid release version");
  assert.equal(desktopPackage.version, version, "root and desktop package versions differ");

  const checkLock = (label, lock, manifest) => {
    assert.equal(lock.name, manifest.name, `${label} lock name differs from package`);
    assert.equal(lock.version, version, `${label} lock version differs from release version`);
    assert.ok(lock.packages && lock.packages[""], `${label} lock has no root package entry`);
    assert.equal(lock.packages[""].name, manifest.name, `${label} lock root name differs from package`);
    assert.equal(lock.packages[""].version, version, `${label} lock root version differs from release version`);
  };
  checkLock("root", rootLock, rootPackage);
  checkLock("desktop", desktopLock, desktopPackage);
  return { version, rootPackage, desktopPackage, rootLock, desktopLock };
}

const benchmarkFingerprintFiles = {
  package_json: "package.json",
  tool_profile: "src/lib/tool-profile.ts",
  transport_resilience: "src/lib/transport-resilience.ts",
  process_journal: "src/lib/process-journal.ts",
  grep_search: "src/lib/grep-search.ts",
  context_bundle: "src/lib/context-bundle.ts",
  goal_work_progress: "src/lib/goal-work-progress.ts",
  relay_manager: "src/lib/relay-manager.ts",
  mcp_session_manager: "src/lib/mcp-session-manager.ts",
  mcp_event_store: "src/lib/mcp-event-store.ts",
  computer_use_provider: "src/lib/computer-use-provider.ts",
  browser_use_provider: "src/lib/browser-use-provider.ts",
  provider_health: "src/lib/provider-health.ts",
  browser_use_runtime_lock: "bundled-plugins/browser-use/runtime-lock.json",
};

function selectBenchmarkReport() {
  const configured = process.env.BENCHMARK_REPORT;
  if (configured) {
    const file = path.isAbsolute(configured) ? configured : path.resolve(repo, configured);
    if (!fs.existsSync(file)) throw new Error(`Configured benchmark report is missing: ${file}`);
    return file;
  }
  const diagnostics = path.resolve(repo, "../diagnostics");
  if (!fs.existsSync(diagnostics)) throw new Error(`Benchmark diagnostics directory is missing: ${diagnostics}`);
  const candidates = fs.readdirSync(diagnostics)
    .filter((name) => /^release-benchmark-gate-.*\.json$/i.test(name))
    .map((name) => {
      const file = path.join(diagnostics, name);
      let checkedAt = 0;
      try { checkedAt = Date.parse(readJson(file).checked_at) || 0; } catch {}
      return { file, checkedAt, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => (right.checkedAt || right.mtimeMs) - (left.checkedAt || left.mtimeMs));
  if (!candidates.length) throw new Error(`No release benchmark report found in ${diagnostics}`);
  return candidates[0].file;
}

function assertFreshBenchmark(file) {
  const report = readJson(file);
  assert.equal(report.schema, 1, `Unsupported benchmark report schema: ${file}`);
  assert.equal(report.result, "PASS", `Benchmark did not pass: ${file}`);
  assert.ok(report.build && report.build.status === "PASS" && report.build.exit_code === 0 && !report.build.error, `Benchmark build is incomplete: ${file}`);
  assert.ok(Array.isArray(report.cases) && report.cases.length > 0, `Benchmark cases are missing: ${file}`);
  for (const row of report.cases) {
    assert.equal(row.status, "PASS", `Benchmark case failed: ${row.name}`);
    assert.equal(row.exit_code, 0, `Benchmark case exit code is not zero: ${row.name}`);
    assert.equal(row.error, null, `Benchmark case reported an error: ${row.name}`);
  }
  assert.ok(report.local_operation_latency, "Benchmark local operation latency is missing");
  assert.ok(report.local_operation_latency.p95_ms <= report.local_operation_latency.threshold_p95_ms, "Benchmark local operation latency exceeded its threshold");
  assert.ok(report.stream_recovery_stress, "Stream recovery stress report is missing");
  assert.ok(report.stream_recovery_stress.total_samples >= 100, "Stream recovery stress sample is too small");
  assert.equal(report.stream_recovery_stress.recovery_rate, 1, "Stream recovery stress did not recover every sample");
  const checkedAt = Date.parse(report.checked_at);
  assert.ok(Number.isFinite(checkedAt), `Benchmark checked_at is invalid: ${file}`);
  for (const [key, relative] of Object.entries(benchmarkFingerprintFiles)) {
    const source = path.join(repo, relative);
    assert.ok(fs.existsSync(source), `Benchmark fingerprint source is missing: ${relative}`);
    assert.equal(report.source_fingerprints?.[key], sha(source), `Stale benchmark fingerprint: ${relative}`);
    if (fs.statSync(source).mtimeMs > checkedAt + 1000) throw new Error(`Benchmark predates source change: ${relative}`);
  }
  assert.equal(report.live_runtime_touched, false, "Benchmark must not touch the live runtime");
  return { path: file, report };
}

function assertFreshRegression(report, label) {
  assert.equal(report?.complete, true, `${label} regression is incomplete`);
  assert.equal(report?.passed, true, `${label} regression did not pass`);
  assert.ok(Array.isArray(report.results) && report.results.length > 0, `${label} regression has no results`);
  for (const row of report.results) {
    assert.equal(row.exit_code, 0, `${label} regression step failed: ${row.name}`);
    assert.equal(row.timed_out, false, `${label} regression step timed out: ${row.name}`);
    if ("passed" in row) assert.equal(row.passed, true, `${label} regression step was not passed: ${row.name}`);
  }
  require("./toolchain-receipts.cjs").assertReceipts(report, repo, node, label);
  const before = readJson(path.join(report.runRoot, "source-before.json"));
  const current = sourceSignature();
  assert.equal(report.source_sha256, before.sha256, `${label} report/source-before hash differs`);
  assert.deepEqual(current.files, before.files, `${label} source changed after regression`);
  assert.equal(current.sha256, report.source_sha256, `${label} regression is stale`);
  return current;
}

const metadata = readReleaseMetadata();
const version = metadata.version;
const output = path.join(desktop, `release-${version}${mode === "local-development" ? "-local-development" : ""}`);
const runRoot = fs.mkdtempSync(path.join(validation, "candidate-build-"));
const buildTemp = path.join(runRoot, "tmp");
const builderCache = path.join(runRoot, "electron-builder-cache");
fs.mkdirSync(buildTemp, { recursive: true });
fs.mkdirSync(builderCache, { recursive: true });
const rootReport = readJson(path.join(validation, "root-latest.json"));
const desktopReport = readJson(path.join(validation, "desktop-latest.json"));
const benchmark = mode === "final" ? assertFreshBenchmark(selectBenchmarkReport()) : null;
assertFreshRegression(rootReport, "root");
assertFreshRegression(desktopReport, "desktop");
assert.equal(rootReport.source_sha256, desktopReport.source_sha256, "Regression source revisions differ");
if (fs.existsSync(output)) throw new Error(`Refusing to replace an existing candidate build: ${output}`);

const env = {};
const allowed = /^(SystemRoot|windir|ComSpec|PATH|PATHEXT|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|LOCALAPPDATA|APPDATA|ProgramFiles|ProgramW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|ALLUSERSPROFILE|PROGRAMDATA)$/i;
for (const [key, value] of Object.entries(process.env)) if (allowed.test(key)) env[key] = value;
for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
env.PATH = path.dirname(node) + ";C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0;" + (process.env.PATH || process.env.Path || "");
env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
env.npm_config_audit = "false";
env.npm_config_fund = "false";
env.TEMP = buildTemp;
env.TMP = buildTemp;
env.ELECTRON_BUILDER_CACHE = builderCache;
env.DOTENV_CONFIG_PATH = path.join(runRoot, "empty.env");
fs.writeFileSync(env.DOTENV_CONFIG_PATH, "# Candidate build: no production credentials\n");
const cleanHostReportPath = path.join(runRoot, "clean-host-report.json");
env.HARNESS_CLEAN_HOST_REPORT = cleanHostReportPath;
if (process.env.HARNESS_ACCEPTANCE_PROTECTED_PID) {
  env.HARNESS_ACCEPTANCE_PROTECTED_PID = process.env.HARNESS_ACCEPTANCE_PROTECTED_PID;
}
if (process.env.HARNESS_REPLACE_EXISTING_INSTALL === "1") {
  env.HARNESS_REPLACE_EXISTING_INSTALL = "1";
}

const steps = [];
const targetRuntimeInputs = [];
async function run(label, args, cwd, budget = 600000) {
  const log = path.join(runRoot, `${label}.log`);
  const fd = fs.openSync(log, "w");
  const start = Date.now();
  const child = spawn(node, args, { cwd, env, windowsHide: true, stdio: ["ignore", fd, fd] });
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; child.kill(); }, budget);
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ exit_code: null, error: String(error) }));
    child.once("close", (code, signal) => resolve({ exit_code: code, signal }));
  });
  clearTimeout(timer);
  fs.closeSync(fd);
  const row = { name: label, ...result, timed_out: timeout, duration_ms: Date.now() - start, log };
  steps.push(row);
  fs.writeFileSync(path.join(runRoot, "steps.json"), JSON.stringify(steps, null, 2));
  console.log(JSON.stringify(row));
  if (result.exit_code !== 0 || timeout) {
    console.error(fs.readFileSync(log, "utf8").slice(-5000));
    throw new Error(`${label} failed`);
  }
}

(async () => {
  console.log(JSON.stringify({ mode, runRoot, output, version, source_sha256: rootReport.source_sha256, benchmark_report: benchmark?.path ?? null }));
  await run("build", [npm, "run", "build"], repo);
  await run("stage", ["scripts/stage-harness.mjs"], desktop);
  await run("portable-template", ["scripts/patch-portable-template.mjs"], desktop);
  const cli = "node_modules/electron-builder/out/cli/cli.js";
  for (const target of ["nsis", "portable"]) {
    await run(target, [cli, "--win", target, "--x64", "--config", "electron-builder.yml", `--config.directories.output=${output}`, "--publish=never"], desktop);
    if (target === "nsis") {
      // Portable rebuilds win-unpacked and omits this NSIS-only helper.
      // Preserve the exact post-builder bytes before that rebuild happens.
      const helper = path.join(output, "win-unpacked/resources/elevate.exe");
      const captured = path.join(runRoot, "nsis-elevate.exe");
      fs.copyFileSync(helper, captured, fs.constants.COPYFILE_EXCL);
      targetRuntimeInputs.push({ target: "nsis", path: "resources/elevate.exe", file: captured, bytes: fs.statSync(captured).size, sha256: sha(captured) });
    }
  }
  env.HARNESS_RELEASE_ROOT = output;
  await run("retired-package-check", ["scripts/acceptance-relay-retired.cjs"], desktop, 900000);
  await run("shared-packaged-safety", ["scripts/acceptance-shared-packaged.mjs"], desktop, 900000);
  let cleanHostReport = null;
  if (mode === "final") {
    await run("packaged-provider-acceptance", ["scripts/acceptance-shared-packaged.mjs", "--providers"], desktop, 900000);
    await run("clean-host-acceptance", ["scripts/acceptance-builtins-clean-host.mjs"], desktop, 1800000);
    cleanHostReport = readJson(cleanHostReportPath);
    assert.equal(cleanHostReport.passed, true, "Clean-host acceptance report did not pass");
  }
  assertFreshRegression(rootReport, "root");
  assertFreshRegression(desktopReport, "desktop");
  const artifacts = fs.readdirSync(output)
    .filter((name) => name.endsWith(".exe"))
    .map((name) => ({ name, bytes: fs.statSync(path.join(output, name)).size, sha256: sha(path.join(output, name)) }));
  assert.equal(artifacts.length, 2, "Expected exactly two candidate executables");
  assert.ok(artifacts.some((entry) => entry.name.endsWith("-setup.exe")), "Missing setup executable");
  assert.ok(artifacts.some((entry) => entry.name.endsWith("-portable.exe")), "Missing portable executable");
  const report = {
    passed: true,
    complete: true,
    mode,
    version,
    output,
    runRoot,
    source_sha256: rootReport.source_sha256,
    release_evidence: createReleaseEvidenceSummary({
      sourceSha256: rootReport.source_sha256,
      rootReport,
      desktopReport,
      packagedAcceptance: mode === "final",
      liveRuntimeReplaced: false,
      cloudLongStreamAcceptance: false,
    }),
    benchmark_report: benchmark?.path ?? null,
    gates: {
      offline_retired_package: "passed", shared_packaged_safety: "passed",
      benchmark: mode === "final" ? "passed" : "not_run",
      packaged_runtime: mode === "final" ? "passed" : "not_run",
      setup_install: mode === "final" ? "passed" : "not_run",
      clean_windows_machine: "not_run", real_web: "not_run",
    },
    steps,
    target_runtime_inputs: targetRuntimeInputs,
    artifacts,
    live_runtime_replaced: false,
    packaged_acceptance: mode === "final",
    installer_executed: cleanHostReport?.installer_executed === true,
    clean_profile_install_acceptance: cleanHostReport?.installed_profile_acceptance === true,
    portable_clean_profile_acceptance: cleanHostReport?.portable_profile_acceptance === true,
    installed_version_after_acceptance: cleanHostReport?.installed_version_after_acceptance || null,
    completed_at: new Date().toISOString(),
  };
  assertBuildMode(report, mode);
  fs.writeFileSync(path.join(validation, "candidate-build-latest.json"), JSON.stringify(report, null, 2));
  console.log(`CANDIDATE_BUILD_COMPLETE ${JSON.stringify(report)}`);
})().catch((error) => {
  fs.writeFileSync(path.join(runRoot, "failure.json"), JSON.stringify({ error: String(error), steps }, null, 2));
  console.error(error.stack || error);
  process.exitCode = 1;
});
