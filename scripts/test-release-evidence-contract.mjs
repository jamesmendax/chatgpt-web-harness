import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createReleaseEvidenceSummary } = require("../.release-tools/release-evidence.cjs");
const sourceSha256 = "a".repeat(64);
const checkedAt = "2026-11-02T18:30:00.000Z";
const report = (name, extra = {}) => ({
  complete: true,
  passed: true,
  source_sha256: sourceSha256,
  completed_at: checkedAt,
  results: [
    { name: `${name}-all`, exit_code: 0, timed_out: false },
    { name: `${name}-focused`, exit_code: 0, timed_out: false, passed: true },
  ],
  ...extra,
});

const rootReport = report("root");
const desktopReport = report("desktop");
const summary = createReleaseEvidenceSummary({
  sourceSha256,
  rootReport,
  desktopReport,
  packagedAcceptance: true,
  checkedAt,
});
assert.deepEqual(Object.keys(summary).sort(), ["checked_at", "runtime_acceptance", "source", "test_execution"]);
assert.deepEqual(summary.source, { status: "verified", sha256: sourceSha256 });
assert.equal(summary.test_execution.status, "passed");
for (const receipt of [summary.test_execution.root, summary.test_execution.desktop]) {
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.source_sha256, sourceSha256);
  assert.equal(receipt.completed_at, checkedAt);
  assert.equal(receipt.result_count, 2);
  assert.match(receipt.receipt_sha256, /^[a-f0-9]{64}$/);
}
assert.equal(summary.runtime_acceptance.packaged_runtime.status, "passed");
assert.equal(summary.runtime_acceptance.live_runtime.status, "not_replaced");
assert.equal(summary.runtime_acceptance.chatgpt_cloud_long_stream.status, "not_claimed");
assert.equal(summary.checked_at, checkedAt);

const stale = createReleaseEvidenceSummary({
  sourceSha256,
  rootReport: report("root", { source_sha256: "b".repeat(64) }),
  desktopReport,
  packagedAcceptance: true,
  checkedAt,
});
assert.equal(stale.source.status, "unverified", "a valid-looking hash cannot verify mismatched test evidence");
assert.equal(stale.test_execution.status, "incomplete");

const failed = createReleaseEvidenceSummary({
  sourceSha256,
  rootReport: report("root", { results: [{ name: "root-all", exit_code: 1, timed_out: false }] }),
  desktopReport,
  packagedAcceptance: true,
  checkedAt,
});
assert.equal(failed.source.status, "verified", "source identity is distinct from test outcome");
assert.equal(failed.test_execution.status, "incomplete", "failed tests must not be reported as passed");

const explicitlyAccepted = createReleaseEvidenceSummary({
  sourceSha256,
  rootReport,
  desktopReport,
  packagedAcceptance: true,
  liveRuntimeReplaced: true,
  cloudLongStreamAcceptance: true,
  checkedAt,
});
assert.equal(explicitlyAccepted.runtime_acceptance.live_runtime.status, "replaced");
assert.equal(explicitlyAccepted.runtime_acceptance.chatgpt_cloud_long_stream.status, "accepted");
const serialized = JSON.stringify(summary);
assert.equal(/token|secret|credential|session_id/i.test(serialized), false, "release evidence must not contain secrets or session identity");

console.log("release-evidence-contract: source hash, root/desktop test receipts, packaged acceptance, live runtime and cloud acceptance remain separate; stale/failed evidence fails closed PASS");