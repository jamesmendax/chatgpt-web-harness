"use strict";

// Candidate verification and source archive assembly. This is offline-only:
// it never installs, launches, publishes, or replaces the live MCP/Tunnel.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TextDecoder } = require("node:util");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const asar = require("../desktop/node_modules/@electron/asar");
const unzipper = require("../desktop/node_modules/unzipper");
const { createReleaseEvidenceSummary } = require("./release-evidence.cjs");
const { includeDesktop, assertDistMatches, readAsarFile } = require("./build-policy.cjs");
const { parseMode, assertBuildMode } = require("./candidate-mode.cjs");
const os = require("node:os");

const repo = path.resolve(__dirname, "..");
const desktop = path.join(repo, "desktop");
const validation = path.join(repo, ".validation");
const requiredSourceFiles = [
  "src/lib/goal-work-progress.ts",
  "src/lib/grep-search-core.ts",
  "src/lib/grep-search-worker.ts",
  "scripts/test-goal-work-progress.mjs",
  "scripts/test-grep-deadline.mjs",
  "docs/RECOVERY_0.2.7.zh-CN.md",
  ".release-tools/build-candidate.cjs",
  ".release-tools/verify-candidate.cjs",
  ".release-tools/verify-stream-release.cjs",
  ".release-tools/release-evidence.cjs",
  ".release-tools/source-signature.cjs",
  ".release-tools/build-policy.cjs",
  ".release-tools/candidate-mode.cjs",
  ".release-tools/toolchain-receipts.cjs",
  ".release-tools/verify-exe-extraction.cjs",
  "scripts/active-test-manifest.mjs",
  "browser-companion/content.js",
  "scripts/test-release-build-contract.mjs",
  "src/lib/recovery-atomic-write.ts",
  "src/lib/service-recovery-plan.ts",
  "src/tools/recovery.ts",
  "scripts/service-recovery-guardian.mjs",
  "scripts/service-recovery-host.mjs",
  "scripts/service-recovery-worker.mjs",
  "docs/DURABLE_RECOVERY.zh-CN.md",
  "skills/codex-execution/SKILL.md",
  "skills/project-engineering/SKILL.md",
  "skills/visual-qa/SKILL.md",
  "src/lib/operation-journal.ts",
  "scripts/test-operation-recovery.mjs",
  "scripts/test-stream-survival.mjs",
  "docs/FIVE_REPO_OPTIMIZATIONS.zh-CN.md",
  "scripts/test-safe-text-write.mjs",
  "scripts/test-code-intelligence.mjs",
  "scripts/test-process-unicode.mjs",
  "scripts/test-process-recovery.mjs",
  "scripts/test-browser.mjs",
];
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha(file) {
  return digest(fs.readFileSync(file));
}

function walkFiles(root) {
  const output = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed: ${file}`);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) output.push(file);
      else throw new Error(`Unsupported candidate entry: ${file}`);
    }
  }
  visit(root);
  return output;
}

function fileManifest(root) {
  return walkFiles(root).map((file) => ({
    path: path.relative(root, file).split(path.sep).join("/"),
    bytes: fs.statSync(file).size,
    sha256: sha(file),
  }));
}

function sourceSignature() {
  return require("./source-signature.cjs").sourceSignature(repo);
}

function releaseMetadata() {
  const rootPackage = readJson(path.join(repo, "package.json"));
  const desktopPackage = readJson(path.join(desktop, "package.json"));
  const rootLock = readJson(path.join(repo, "package-lock.json"));
  const desktopLock = readJson(path.join(desktop, "package-lock.json"));
  const version = rootPackage.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "invalid root package version");
  assert.equal(desktopPackage.version, version, "root and desktop package versions differ");
  for (const [label, lock, manifest] of [["root", rootLock, rootPackage], ["desktop", desktopLock, desktopPackage]]) {
    assert.equal(lock.name, manifest.name, `${label} lock name differs from package`);
    assert.equal(lock.version, version, `${label} lock version differs from release version`);
    assert.ok(lock.lockfileVersion === 3 && lock.packages?.[""], `${label} lock is not an npm v3 lockfile`);
    assert.equal(lock.packages[""].name, manifest.name, `${label} lock root name differs from package`);
    assert.equal(lock.packages[""].version, version, `${label} lock root version differs from release version`);
  }
  return { version, rootPackage, desktopPackage };
}

function parseArguments() {
  const options = { checkOnly: false, destination: null, mode: parseMode(process.argv.slice(2)) };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--local-development") {
      continue;
    } else if (arg === "--check-only") {
      options.checkOnly = true;
    } else if (arg === "--destination") {
      options.destination = args[++index];
      if (!options.destination) throw new Error("--destination requires a path");
    } else if (arg.startsWith("--destination=")) {
      options.destination = arg.slice("--destination=".length);
      if (!options.destination) throw new Error("--destination requires a path");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function candidateDestination(version, options) {
  const configured = options.destination || process.env.CANDIDATE_DESTINATION;
  const defaultDate = process.env.RELEASE_DATE || "20260912";
  const value = configured || path.resolve(repo, `../candidate-${version}${options.mode === "local-development" ? "-local-development" : ""}-${defaultDate}`);
  const resolved = path.resolve(value);
  if (resolved === path.resolve(repo) || resolved === path.resolve(desktop)) {
    throw new Error(`Unsafe candidate destination: ${resolved}`);
  }
  return resolved;
}

function latestBenchmarkReport() {
  const configured = process.env.BENCHMARK_REPORT;
  if (configured) {
    const file = path.isAbsolute(configured) ? configured : path.resolve(repo, configured);
    if (!fs.existsSync(file)) throw new Error(`Configured benchmark report is missing: ${file}`);
    return file;
  }
  const diagnostics = path.resolve(repo, "../diagnostics");
  if (!fs.existsSync(diagnostics)) throw new Error(`Benchmark diagnostics directory is missing: ${diagnostics}`);
  const reports = fs.readdirSync(diagnostics)
    .filter((name) => /^release-benchmark-gate-.*\.json$/i.test(name))
    .map((name) => {
      const file = path.join(diagnostics, name);
      let checkedAt = 0;
      try { checkedAt = Date.parse(readJson(file).checked_at) || 0; } catch {}
      return { file, checkedAt, mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => (right.checkedAt || right.mtimeMs) - (left.checkedAt || left.mtimeMs));
  if (!reports.length) throw new Error(`No release benchmark report found in ${diagnostics}`);
  return reports[0].file;
}

function verifyBenchmark(file) {
  const report = readJson(file);
  assert.equal(report.schema, 1, `Unsupported benchmark report schema: ${file}`);
  assert.equal(report.result, "PASS", `Benchmark did not pass: ${file}`);
  assert.equal(report.build?.status, "PASS", `Benchmark build is incomplete: ${file}`);
  assert.equal(report.build?.exit_code, 0, `Benchmark build exit code is not zero: ${file}`);
  assert.equal(report.build?.error, null, `Benchmark build reported an error: ${file}`);
  assert.ok(Array.isArray(report.cases) && report.cases.length > 0, `Benchmark cases are missing: ${file}`);
  for (const row of report.cases) {
    assert.equal(row.status, "PASS", `Benchmark case failed: ${row.name}`);
    assert.equal(row.exit_code, 0, `Benchmark case exit code is not zero: ${row.name}`);
    assert.equal(row.error, null, `Benchmark case reported an error: ${row.name}`);
  }
  assert.ok(report.local_operation_latency, "Benchmark latency result is missing");
  assert.ok(report.local_operation_latency.p95_ms <= report.local_operation_latency.threshold_p95_ms, "Benchmark latency threshold failed");
  assert.ok(report.stream_recovery_stress, "Stream recovery stress result is missing");
  assert.ok(report.stream_recovery_stress.total_samples >= 100, "Stream recovery stress sample is too small");
  assert.equal(report.stream_recovery_stress.recovery_rate, 1, "Stream recovery stress did not recover every sample");
  assert.equal(report.live_runtime_touched, false, "Benchmark touched the live runtime");
  assert.ok(Number.isFinite(Date.parse(report.checked_at)), `Benchmark checked_at is invalid: ${file}`);
  for (const [key, relative] of Object.entries(benchmarkFingerprintFiles)) {
    const source = path.join(repo, relative);
    assert.ok(fs.existsSync(source), `Benchmark source is missing: ${relative}`);
    assert.equal(report.source_fingerprints?.[key], sha(source), `Stale benchmark fingerprint: ${relative}`);
  }
  return { path: file, report };
}

function verifyFreshRegression(report, label) {
  assert.equal(report?.complete, true, `${label} regression is incomplete`);
  assert.equal(report?.passed, true, `${label} regression did not pass`);
  assert.ok(Array.isArray(report.results) && report.results.length > 0, `${label} regression has no results`);
  for (const row of report.results) {
    assert.equal(row.exit_code, 0, `${label} regression step failed: ${row.name}`);
    assert.equal(row.timed_out, false, `${label} regression step timed out: ${row.name}`);
    if ("passed" in row) assert.equal(row.passed, true, `${label} regression step was not passed: ${row.name}`);
  }
  assert.ok(report.runRoot, `${label} regression runRoot is missing`);
  require("./toolchain-receipts.cjs").assertReceipts(report, repo, process.execPath, label);
  const before = readJson(path.join(report.runRoot, "source-before.json"));
  const current = sourceSignature();
  assert.equal(report.source_sha256, before.sha256, `${label} source-before hash differs from report`);
  assert.deepEqual(current.files, before.files, `${label} source changed after regression`);
  assert.equal(current.sha256, report.source_sha256, `${label} regression is stale`);
  return current;
}

function assertSafeManifestPath(relative) {
  assert.ok(relative && !path.isAbsolute(relative) && !relative.split(/[\\/]/).includes(".."), `Unsafe manifest path: ${relative}`);
}

const binaryExtensions = new Set([
  ".7z", ".asar", ".bin", ".bz2", ".cab", ".class", ".dat", ".db", ".dll", ".dylib", ".exe", ".gz", ".gif",
  ".ico", ".jar", ".jpeg", ".jpg", ".lib", ".msi", ".node", ".o", ".obj", ".otf", ".pack", ".pdf", ".pdb",
  ".png", ".rar", ".so", ".sqlite", ".tar", ".tgz", ".ttf", ".wasm", ".webp", ".woff", ".woff2", ".xz", ".zip",
]);
const { privateUserProfilePath } = require("./source-privacy.cjs");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function textContents(relative, bytes) {
  if (binaryExtensions.has(path.extname(relative).toLowerCase()) || bytes.includes(0)) return null;
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

function assertPrivateProfileFree(relative, bytes) {
  const text = textContents(relative, bytes);
  if (text === null) return;
  assert.ok(!privateUserProfilePath.test(text), `Curated source contains a concrete user profile path: ${relative}`);
}

function assertCuratedSourcePrivacy(root) {
  for (const file of walkFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    assertPrivateProfileFree(relative, fs.readFileSync(file));
  }
}

function redactPrivateProfilePaths(value) {
  if (typeof value === "string") {
    return value
      .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+[\\/]AppData[\\/]Local[\\/]Temp/gi, "<USER_TEMP>")
      .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\r\n]+[\\/]AppData/gi, "<USER_APPDATA>");
  }
  if (Array.isArray(value)) return value.map(redactPrivateProfilePaths);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactPrivateProfilePaths(entry)]));
  }
  return value;
}

function assertCandidateMetadataPrivacy(root) {
  for (const name of [
    "root-verification.json",
    "desktop-verification.json",
    "build-verification.json",
    "benchmark-verification.json",
    "SOURCE_MANIFEST.json",
    "RUNTIME_MANIFEST.json",
    "VERIFICATION.json",
    "SHA256SUMS.txt",
    "READ-ME.txt",
  ]) {
    const file = path.join(root, name);
    if (fs.existsSync(file)) assertPrivateProfileFree(name, fs.readFileSync(file));
  }
}

async function verifyZip(zipFile, expected) {
  const archive = await unzipper.Open.file(zipFile);
  const entries = archive.files.filter((entry) => entry.type === "File");
  assert.equal(entries.length, expected.length, "Source archive file count differs from manifest");
  const expectedByPath = new Map(expected.map((row) => [row.path, row]));
  const seen = new Set();
  for (const entry of entries) {
    const relative = entry.path.replaceAll("\\", "/");
    assertSafeManifestPath(relative);
    assert.ok(!seen.has(relative), `Duplicate archive entry: ${relative}`);
    seen.add(relative);
    const row = expectedByPath.get(relative);
    assert.ok(row, `Unexpected source archive entry: ${relative}`);
    const bytes = await entry.buffer();
    assert.equal(bytes.length, row.bytes, `Source archive byte mismatch: ${relative}`);
    assert.equal(digest(bytes), row.sha256, `Source archive hash mismatch: ${relative}`);
    assertPrivateProfileFree(relative, bytes);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertRequiredSourceManifest(sourceManifest) {
  require("./source-signature.cjs").assertSourceManifest(sourceSignature(), sourceManifest);
  for (const relative of requiredSourceFiles) {
    const row = sourceManifest.find((entry) => entry.path === relative);
    assert.ok(row, `Candidate source archive omitted required file: ${relative}`);
    assert.equal(row.sha256, sha(path.join(repo, relative)), `Candidate required source is stale: ${relative}`);
  }
}

function copySourceSnapshot(destination) {
  const snapshot = path.join(destination, "source");
  fs.mkdirSync(snapshot, { recursive: true });
  const directories = [
    "src",
    "scripts",
    "skills",
    "docs",
    "evals",
    "public",
    "browser-companion",
    "bundled-plugins",
    "third-party",
    "vendor",
    "bin",
    ".release-tools",
    "desktop/src",
    "desktop/renderer",
    "desktop/scripts",
    "desktop/build",
  ];
  const excluded = new Set(["node_modules", ".git", ".codex", ".validation", "command-logs", "userData", "staging", "release", "release-0.2.5-rc.1"]);
  for (const relative of directories) {
    const from = path.join(repo, relative);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(snapshot, relative), {
      recursive: true,
      filter: (file) => !path.relative(from, file).split(path.sep).some((part) => excluded.has(part) || part === ".env"),
    });
  }
  for (const entry of fs.readdirSync(repo, { withFileTypes: true })) {
    if (entry.isFile() && (/\.(json|md|cmd|ps1|png)$/i.test(entry.name) || ["LICENSE", ".env.example", ".gitignore"].includes(entry.name))) {
      fs.copyFileSync(path.join(repo, entry.name), path.join(snapshot, entry.name));
    }
  }
  for (const name of ["package.json", "package-lock.json", "electron-builder.yml"]) {
    fs.copyFileSync(path.join(desktop, name), path.join(snapshot, "desktop", name));
  }
  const packagedProfiles = path.join(repo, "desktop/staging/harness/profiles");
  if (fs.existsSync(packagedProfiles)) fs.cpSync(packagedProfiles, path.join(snapshot, "profiles"), { recursive: true });
  return snapshot;
}

async function main() {
  const options = parseArguments();
  const metadata = releaseMetadata();
  const version = metadata.version;
  const destination = candidateDestination(version, options);
  const rootReport = readJson(path.join(validation, "root-latest.json"));
  const desktopReport = readJson(path.join(validation, "desktop-latest.json"));
  const buildReport = readJson(path.join(validation, "candidate-build-latest.json"));
  const benchmark = options.mode === "final" ? verifyBenchmark(latestBenchmarkReport()) : null;
  const rootSignature = verifyFreshRegression(rootReport, "root");
  const desktopSignature = verifyFreshRegression(desktopReport, "desktop");
  assert.equal(rootReport.source_sha256, desktopReport.source_sha256, "Regression source revisions differ");
  assert.equal(rootSignature.sha256, desktopSignature.sha256, "Regression source signatures differ");
  assert.equal(buildReport.complete, true, "Candidate build is incomplete");
  assert.equal(buildReport.passed, true, "Candidate build did not pass");
  assert.equal(buildReport.version, version, "Candidate build version differs from manifests");
  assert.equal(buildReport.source_sha256, rootReport.source_sha256, "Candidate build source differs from regressions");
  assertBuildMode(buildReport, options.mode);
  const buildEvidence = createReleaseEvidenceSummary({
    sourceSha256: rootReport.source_sha256,
    rootReport,
    desktopReport,
    packagedAcceptance: buildReport.packaged_acceptance === true,
    liveRuntimeReplaced: false,
    cloudLongStreamAcceptance: false,
  });
  assert.equal(buildEvidence.source.status, "verified", "Candidate source evidence is not verified");
  assert.equal(buildEvidence.test_execution.status, "passed", "Candidate test execution receipts are incomplete");
  assert.equal(buildEvidence.runtime_acceptance.chatgpt_cloud_long_stream.status, "not_claimed");
  assert.deepEqual(buildReport.release_evidence, createReleaseEvidenceSummary({
    sourceSha256: rootReport.source_sha256,
    rootReport,
    desktopReport,
    packagedAcceptance: buildReport.packaged_acceptance === true,
    liveRuntimeReplaced: false,
    cloudLongStreamAcceptance: false,
    checkedAt: buildReport.release_evidence?.checked_at,
  }), "Candidate build release evidence differs from the regression receipts");
  const output = path.resolve(buildReport.output);
  assert.ok(fs.existsSync(output), `Candidate build output is missing: ${output}`);
  const staged = path.join(desktop, "staging/harness");
  const packaged = path.join(output, "win-unpacked/resources/harness");
  assert.ok(fs.existsSync(staged) && fs.existsSync(packaged), "Staging or packaged harness is missing");
  const stagedManifest = fileManifest(staged);
  const packagedManifest = fileManifest(packaged);
  assert.deepEqual(packagedManifest, stagedManifest, "Packaged runtime differs from staging");
  const payload = readJson(path.join(packaged, "harness-files.json"));
  const payloadRows = packagedManifest.filter((row) => row.path !== "harness-files.json");
  assert.equal(payload.file_count, payloadRows.length, "Runtime payload file count is stale");
  assert.equal(payload.total_bytes, payloadRows.reduce((total, row) => total + row.bytes, 0), "Runtime payload byte count is stale");
  for (const row of payload.files) {
    assertSafeManifestPath(row.path);
    assert.match(row.sha256 || "", /^[a-f0-9]{64}$/, `Runtime payload hash missing: ${row.path}`);
  }
  assert.deepEqual([...payload.files].sort((a,b)=>a.path.localeCompare(b.path)), [...payloadRows].sort((a,b)=>a.path.localeCompare(b.path)), "Runtime payload hash inventory differs");
  const harnessVersion = readJson(path.join(packaged, "harness-version.json"));
  assert.equal(harnessVersion.harness_version, version, "Packaged harness version differs");
  assert.equal(harnessVersion.dist_index_sha256_16, sha(path.join(packaged, "dist/index.js")).slice(0, 16), "Packaged dist fingerprint is stale");
  const compileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-verify-compile-"));
  try {
    const freshDist = path.join(compileRoot, "dist");
    const compile = spawnSync(process.execPath, [path.join(repo, "node_modules/typescript/bin/tsc"), "--outDir", freshDist], { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 120000 });
    if (compile.error || compile.status !== 0) throw new Error(`Fresh verifier compilation failed: ${compile.error || compile.stderr || compile.stdout}`);
    assertDistMatches(freshDist, path.join(packaged, "dist"));
  } finally { fs.rmSync(compileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  const fingerprintCommand = 'import { pathToFileURL } from "node:url"; const m = await import(pathToFileURL(process.argv[1]).href); console.log(JSON.stringify(m.runtimeContent(process.argv[2])));';
  const fingerprint = spawnSync(process.execPath, ["--input-type=module", "-e", fingerprintCommand, path.join(packaged, "dist/lib/build-fingerprint.js"), packaged], { encoding: "utf8", windowsHide: true });
  if (fingerprint.error || fingerprint.status !== 0) throw new Error(`Packaged fingerprint verification failed: ${fingerprint.error || fingerprint.stderr}`);
  assert.deepEqual(readJson(path.join(packaged, "dist/build-manifest.json")), JSON.parse(fingerprint.stdout), "Packaged runtime fingerprint is stale");
  const app = path.join(output, "win-unpacked/resources/app.asar");
  for (const entry of asar.listPackage(app)) {
    const relative = entry.replace(/^[/\\]+/, "").replaceAll("\\", "/");
    assert.ok(includeDesktop(relative), `Retired desktop entry unexpectedly packaged: ${relative}`);
  }
  const appPackage = JSON.parse(readAsarFile(app, "package.json").toString("utf8"));
  assert.equal(appPackage.version, version, "ASAR package version differs");
  let asarSourceFiles = 0;
  for (const directory of ["src", "renderer"]) {
    for (const file of walkFiles(path.join(desktop, directory))) {
      const relative = path.relative(desktop, file).split(path.sep).join("/");
      if (!includeDesktop(relative)) {
        assert.throws(() => readAsarFile(app, relative), `Retired desktop file unexpectedly packaged: ${relative}`);
        continue;
      }
      assert.equal(digest(readAsarFile(app, relative)), sha(file), `ASAR source mismatch: ${relative}`);
      asarSourceFiles += 1;
    }
  }
  const plugins = readJson(path.join(packaged, "profiles/plugins.json"));
  assert.deepEqual(plugins.skills, [], "Packaged skills profile is not empty");
  assert.equal(plugins.computer_use.enabled, false, "Packaged computer-use profile is enabled");
  assert.deepEqual(readJson(path.join(packaged, "profiles/mcp-upstream.json")).servers, [], "Packaged upstream profile is not empty");
  assert.ok(fs.existsSync(path.join(packaged, "LICENSE")) && fs.existsSync(path.join(packaged, "third-party")), "Packaged license data is missing");
  assert.ok(!packagedManifest.some((row) => /(^|\/)\.env$|(^|\/)userData\/|(^|\/)command-logs\//i.test(row.path)), "Packaged runtime contains private data");
  for (const artifact of buildReport.artifacts) {
    const file = path.join(output, artifact.name);
    assert.equal(sha(file), artifact.sha256, `Build artifact hash changed: ${artifact.name}`);
    assert.ok(fs.statSync(file).size > 1024 * 1024, `Build artifact is unexpectedly small: ${artifact.name}`);
    const header = fs.readFileSync(file).subarray(0, 2).toString("ascii");
    assert.equal(header, "MZ", `Build artifact is not a Windows executable: ${artifact.name}`);
    assert.ok(artifact.name.includes(version), `Build artifact lacks release version: ${artifact.name}`);
  }
  const exeExtraction = require("./verify-exe-extraction.cjs").verifyExeExtraction(repo, output, buildReport.artifacts, path.join(output, "win-unpacked"), buildReport.target_runtime_inputs);
  for (const relative of requiredSourceFiles) assert.ok(fs.existsSync(path.join(repo, relative)), `Required release source is missing: ${relative}`);

  if (options.checkOnly) {
    assert.ok(fs.existsSync(destination), `Candidate destination is missing: ${destination}`);
    const report = readJson(path.join(destination, "VERIFICATION.json"));
    assert.equal(report.passed, true, "Candidate verification report did not pass");
    assert.equal(report.mode, options.mode, "Candidate verification mode differs");
    assert.deepEqual(report.gates, buildReport.gates, "Candidate gate statuses differ from the build");
    assert.equal(report.version, version, "Candidate verification version differs");
    assert.deepEqual(report.artifacts.filter(row => row.name.endsWith(".exe")), buildReport.artifacts, "Delivered artifact identities differ from extracted build artifacts");
    assert.deepEqual(report.exe_extraction, exeExtraction, "Actual EXE extraction receipts differ");
    assert.equal(report.source_sha256, rootReport.source_sha256, "Candidate verification source is stale");
    assert.equal(report.release_evidence?.source?.sha256, rootReport.source_sha256, "Candidate release-evidence source hash is stale");
    assert.equal(report.release_evidence?.test_execution?.status, "passed", "Candidate release-evidence test receipt is incomplete");
    assert.equal(report.release_evidence?.runtime_acceptance?.live_runtime?.status, "not_replaced");
    assert.equal(report.release_evidence?.runtime_acceptance?.chatgpt_cloud_long_stream?.status, "not_claimed");
    assert.deepEqual(report.release_evidence, createReleaseEvidenceSummary({
      sourceSha256: rootReport.source_sha256,
      rootReport,
      desktopReport,
      packagedAcceptance: buildReport.packaged_acceptance === true,
      liveRuntimeReplaced: false,
      cloudLongStreamAcceptance: false,
      checkedAt: report.release_evidence.checked_at,
    }), "Stored release evidence differs from current source/test receipts");
    const sourceManifest = readJson(path.join(destination, "SOURCE_MANIFEST.json"));
    const snapshot = path.join(destination, "source");
    const actualSourceManifest = fileManifest(snapshot);
    assertCuratedSourcePrivacy(snapshot);
    assert.deepEqual(actualSourceManifest, sourceManifest, "Candidate source manifest is stale");
    for (const row of sourceManifest) {
      assertSafeManifestPath(row.path);
      assert.equal(sha(path.join(snapshot, row.path)), row.sha256, `Candidate source hash mismatch: ${row.path}`);
    }
    assertRequiredSourceManifest(sourceManifest);
    const archive = path.join(destination, `Web-Harness-${version}-source.zip`);
    await verifyZip(archive, sourceManifest);
    assertCandidateMetadataPrivacy(destination);
    for (const artifact of report.artifacts) assert.equal(sha(path.join(destination, artifact.name)), artifact.sha256, `Candidate artifact hash mismatch: ${artifact.name}`);
    console.log(`${options.mode === "final" ? "DELIVERABLE_READY" : "LOCAL_DEVELOPMENT_CANDIDATE_VERIFIED"} ${JSON.stringify({ directory: destination, version, source_sha256: rootReport.source_sha256, release_evidence: report.release_evidence, gates: report.gates, files: sourceManifest.length, runtime_files: packagedManifest.length, asar_files: asarSourceFiles, artifacts: report.artifacts })}`);
    return;
  }

  if (fs.existsSync(destination)) throw new Error(`Refusing to replace existing candidate destination: ${destination}`);
  fs.mkdirSync(destination, { recursive: false });
  const snapshot = copySourceSnapshot(destination);
  assertCuratedSourcePrivacy(snapshot);
  const sourceManifest = fileManifest(snapshot);
  assertRequiredSourceManifest(sourceManifest);
  writeJson(path.join(destination, "SOURCE_MANIFEST.json"), sourceManifest);
  const archive = path.join(destination, `Web-Harness-${version}-source.zip`);
  const zip = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "zip-source.ps1"), "-Source", snapshot, "-Destination", archive], { encoding: "utf8", timeout: 120000, windowsHide: true });
  assert.equal(zip.status, 0, zip.stderr || "Source archive creation failed");
  await verifyZip(archive, sourceManifest);
  for (const artifact of buildReport.artifacts) {
    const delivered = path.join(destination, artifact.name);
    fs.copyFileSync(path.join(output, artifact.name), delivered, fs.constants.COPYFILE_EXCL);
    assert.equal(sha(delivered), artifact.sha256, `Delivered executable differs from verified build: ${artifact.name}`);
  }
  for (const [name, report] of [["root", rootReport], ["desktop", desktopReport], ["build", buildReport]]) {
    writeJson(path.join(destination, `${name}-verification.json`), redactPrivateProfilePaths(report));
  }
  writeJson(path.join(destination, "benchmark-verification.json"), benchmark ? redactPrivateProfilePaths(benchmark.report) : { status: "not_run", reason: "local-development candidate" });
  writeJson(path.join(destination, "RUNTIME_MANIFEST.json"), packagedManifest);
  const names = [...buildReport.artifacts.map((entry) => entry.name), path.basename(archive), "SOURCE_MANIFEST.json", "RUNTIME_MANIFEST.json", "root-verification.json", "desktop-verification.json", "build-verification.json", "benchmark-verification.json"];
  const artifacts = names.map((name) => ({ name, bytes: fs.statSync(path.join(destination, name)).size, sha256: sha(path.join(destination, name)) }));
  const report = {
    schema: 2,
    passed: true,
    complete: true,
    mode: options.mode,
    gates: buildReport.gates,
    source_sha256: rootReport.source_sha256,
    release_evidence: createReleaseEvidenceSummary({
      sourceSha256: rootReport.source_sha256,
      rootReport,
      desktopReport,
      packagedAcceptance: buildReport.packaged_acceptance === true,
      liveRuntimeReplaced: false,
      cloudLongStreamAcceptance: false,
    }),
    version,
    checked_at: new Date().toISOString(),
    runtime_files: packagedManifest.length,
    exe_extraction: exeExtraction,
    asar_files: asarSourceFiles,
    source_files: sourceManifest.length,
    artifacts,
    claims: {
      offline_regression: true,
      source_archive_roundtrip: true,
      packaged_runtime_hashes: true,
      packaged_app_source_hashes: true,
      installer_executed: buildReport.installer_executed,
      clean_profile_install_acceptance: buildReport.clean_profile_install_acceptance,
      live_runtime_replaced: false,
      chatgpt_cloud_long_stream_acceptance: false,
    },
  };
  writeJson(path.join(destination, "VERIFICATION.json"), report);
  fs.writeFileSync(path.join(destination, "SHA256SUMS.txt"), `${artifacts.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n")}\n${sha(path.join(destination, "VERIFICATION.json"))}  VERIFICATION.json\n`);
  fs.writeFileSync(path.join(destination, "READ-ME.txt"), `Web Harness ${version} ${options.mode} candidate.\nRoot and desktop regressions, archive round-trip, and packaged content hashes verified.\n${options.mode === "local-development" ? "Local development only: benchmark, packaged provider launch, Setup installation, clean-Windows and real-web acceptance were not run." : "Portable and Setup were tested in disposable profiles; clean-Windows and real-web acceptance were not run."}\nSee VERIFICATION.json for gate statuses. Existing live services are not replaced.\n`);
  assertCandidateMetadataPrivacy(destination);
  console.log(`CANDIDATE_VERIFIED ${JSON.stringify({ directory: destination, ...report })}`);
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
