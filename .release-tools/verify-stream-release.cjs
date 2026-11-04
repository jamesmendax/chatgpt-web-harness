"use strict";

// Check-only release gate. It consumes completed evidence and delegates
// package/hash inspection to verify-candidate.cjs; it never builds, tests,
// installs, publishes, or changes the live MCP/Tunnel.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createReleaseEvidenceSummary } = require("./release-evidence.cjs");

const repo = path.resolve(__dirname, "..");
const validation = path.join(repo, ".validation");
const requiredEvidenceTests = [
  "scripts/test-goal-work-progress.mjs",
  "scripts/test-grep-deadline.mjs",
  "scripts/test-process-recovery-control.mjs",
  "scripts/test-browser-recovery-v2.mjs",
  "scripts/test-stream-survival.mjs",
  "scripts/test-operation-recovery.mjs",
  "scripts/test-safe-text-write.mjs",
  "scripts/test-code-intelligence.mjs",
  "scripts/test-process-unicode.mjs",
  "scripts/test-process-recovery.mjs",
  "scripts/test-browser-turn-fence.mjs",
  "scripts/test-browser.mjs",
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function digest(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha(file) {
  return digest(fs.readFileSync(file));
}

function sourceSignature() {
  return require("./source-signature.cjs").sourceSignature(repo);
}

function parseArguments() {
  const args = process.argv.slice(2);
  let destination = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check-only") continue;
    if (arg === "--destination") {
      destination = args[++index];
      if (!destination) throw new Error("--destination requires a path");
      continue;
    }
    if (arg.startsWith("--destination=")) {
      destination = arg.slice("--destination=".length);
      if (!destination) throw new Error("--destination requires a path");
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return destination;
}

function verifyRegression(report, label) {
  assert.equal(report?.complete, true, `${label} regression is incomplete`);
  assert.equal(report?.passed, true, `${label} regression did not pass`);
  assert.ok(Array.isArray(report.results) && report.results.length > 0, `${label} regression has no results`);
  for (const row of report.results) {
    assert.equal(row.exit_code, 0, `${label} regression step failed: ${row.name}`);
    assert.equal(row.timed_out, false, `${label} regression step timed out: ${row.name}`);
    if ("passed" in row) assert.equal(row.passed, true, `${label} regression step was not passed: ${row.name}`);
  }
  require("./toolchain-receipts.cjs").assertReceipts(report, repo, process.execPath, label);
  const before = readJson(path.join(report.runRoot, "source-before.json"));
  const current = sourceSignature();
  assert.equal(report.source_sha256, before.sha256, `${label} source-before hash differs from report`);
  assert.deepEqual(current.files, before.files, `${label} source changed after regression`);
  assert.equal(current.sha256, report.source_sha256, `${label} regression is stale`);
  return current;
}

function requireEvidenceLog(report) {
  const rootRun = report.results.find((row) => row.name === "root-all") || report.results[0];
  assert.ok(rootRun?.log, "Root regression log is missing");
  assert.ok(fs.existsSync(rootRun.log), `Root regression log does not exist: ${rootRun.log}`);
  const log = fs.readFileSync(rootRun.log, "utf8");
  for (const test of requiredEvidenceTests) {
    assert.ok(log.includes(test), `Required stream recovery test was not recorded: ${test}`);
  }
  return { path: rootRun.log, tests: requiredEvidenceTests };
}

function releaseVersion() {
  const root = readJson(path.join(repo, "package.json"));
  const desktop = readJson(path.join(repo, "desktop/package.json"));
  assert.equal(root.version, desktop.version, "root and desktop package versions differ");
  return root.version;
}

function main() {
  const destinationArg = parseArguments();
  const version = releaseVersion();
  const destination = path.resolve(destinationArg || process.env.CANDIDATE_DESTINATION || path.resolve(repo, `../candidate-${version}-${process.env.RELEASE_DATE || "20260912"}`));
  const rootReport = readJson(path.join(validation, "root-latest.json"));
  const desktopReport = readJson(path.join(validation, "desktop-latest.json"));
  const buildReport = readJson(path.join(validation, "candidate-build-latest.json"));
  const rootSignature = verifyRegression(rootReport, "root");
  const desktopSignature = verifyRegression(desktopReport, "desktop");
  assert.equal(rootReport.source_sha256, desktopReport.source_sha256, "Regression source revisions differ");
  assert.equal(rootSignature.sha256, desktopSignature.sha256, "Regression source signatures differ");
  assert.equal(buildReport.complete, true, "Candidate build is incomplete");
  assert.equal(buildReport.passed, true, "Candidate build did not pass");
  assert.equal(buildReport.version, version, "Candidate build version differs");
  assert.equal(buildReport.source_sha256, rootReport.source_sha256, "Candidate build source is stale");
  const evidence = requireEvidenceLog(rootReport);
  assert.ok(fs.existsSync(destination), `Candidate destination is missing: ${destination}`);
  const verifier = spawnSync(process.execPath, [path.join(__dirname, "verify-candidate.cjs"), "--check-only", "--destination", destination], {
    cwd: repo,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CANDIDATE_DESTINATION: destination },
  });
  if (verifier.error || verifier.status !== 0) {
    const detail = `${verifier.error ? `${verifier.error}\n` : ""}${verifier.stderr || verifier.stdout || ""}`.slice(-6000);
    throw new Error(`Candidate check-only verification failed (exit ${verifier.status}):\n${detail}`);
  }
  const report = readJson(path.join(destination, "VERIFICATION.json"));
  assert.equal(report.passed, true, "Candidate verification report did not pass");
  assert.equal(report.complete, true, "Candidate verification report is incomplete");
  assert.equal(report.version, version, "Candidate verification version differs");
  assert.equal(report.source_sha256, rootReport.source_sha256, "Candidate verification source is stale");
  assert.equal(report.claims?.live_runtime_replaced, false, "Candidate claims to replace the live runtime");
  assert.equal(report.claims?.chatgpt_cloud_long_stream_acceptance, false, "Candidate claims cloud long-stream acceptance");
  const releaseEvidence = report.release_evidence;
  assert.ok(releaseEvidence, "Release evidence summary is missing");
  assert.equal(releaseEvidence.source?.status, "verified");
  assert.equal(releaseEvidence.source?.sha256, rootReport.source_sha256);
  assert.equal(releaseEvidence.test_execution?.status, "passed");
  assert.equal(releaseEvidence.runtime_acceptance?.live_runtime?.status, "not_replaced");
  assert.equal(releaseEvidence.runtime_acceptance?.chatgpt_cloud_long_stream?.status, "not_claimed");
  assert.deepEqual(releaseEvidence, createReleaseEvidenceSummary({
    sourceSha256: rootReport.source_sha256,
    rootReport,
    desktopReport,
    packagedAcceptance: true,
    liveRuntimeReplaced: false,
    cloudLongStreamAcceptance: false,
    checkedAt: releaseEvidence.checked_at,
  }), "Release evidence summary differs from the underlying source and test receipts");
  console.log(`STREAM_RELEASE_VERIFIED ${JSON.stringify({
    directory: destination,
    version,
    source_sha256: rootReport.source_sha256,
    release_evidence: releaseEvidence,
    evidence_log: evidence.path,
    evidence_tests: evidence.tests,
    verifier_output: (verifier.stdout || "").trim().split(/\r?\n/).slice(-1)[0] || null,
  })}`);
}

try {
  main();
} catch (error) {
  console.error(`STREAM_RELEASE_NOT_READY ${error.stack || error}`);
  process.exitCode = 1;
}
