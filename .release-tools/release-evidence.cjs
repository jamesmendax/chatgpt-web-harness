"use strict";

const crypto = require("node:crypto");

function testReceipt(report, sourceSha256) {
  const results = Array.isArray(report?.results) ? report.results : [];
  const rows = results.map((row) => ({
    name: typeof row?.name === "string" ? row.name : "unknown",
    exit_code: Number.isInteger(row?.exit_code) ? row.exit_code : null,
    timed_out: row?.timed_out === true,
    ...(typeof row?.log_sha256 === "string" ? { log_sha256: row.log_sha256 } : {}),
    ...(Array.isArray(row?.tests) ? { tests: row.tests } : {}),
    ...(Object.prototype.hasOwnProperty.call(row ?? {}, "passed") ? { passed: row.passed === true } : {}),
  }));
  const sourceMatches = typeof sourceSha256 === "string" && report?.source_sha256 === sourceSha256;
  const passed = report?.complete === true && report?.passed === true && rows.length > 0 && sourceMatches &&
    rows.every((row) => row.exit_code === 0 && !row.timed_out && (!Object.prototype.hasOwnProperty.call(row, "passed") || row.passed));
  const receiptPayload = { source_sha256: report?.source_sha256 ?? null, results: rows };
  return {
    status: passed ? "passed" : "incomplete",
    source_sha256: report?.source_sha256 ?? null,
    completed_at: report?.completed_at ?? report?.checked_at ?? null,
    result_count: rows.length,
    receipt_sha256: crypto.createHash("sha256").update(JSON.stringify(receiptPayload)).digest("hex"),
  };
}

function createReleaseEvidenceSummary(options = {}) {
  const sourceSha256 = options.sourceSha256 ?? null;
  const sourceHashValid = typeof sourceSha256 === "string" && /^[a-f0-9]{64}$/i.test(sourceSha256);
  const root = testReceipt(options.rootReport, sourceSha256);
  const desktop = testReceipt(options.desktopReport, sourceSha256);
  const sourceMatches = sourceHashValid && options.rootReport?.source_sha256 === sourceSha256 &&
    options.desktopReport?.source_sha256 === sourceSha256;
  const testPassed = sourceMatches && root.status === "passed" && desktop.status === "passed";
  const checkedAt = options.checkedAt instanceof Date ? options.checkedAt : new Date(options.checkedAt ?? Date.now());
  return Object.freeze({
    source: Object.freeze({ status: sourceMatches ? "verified" : "unverified", sha256: sourceHashValid ? sourceSha256 : null }),
    test_execution: Object.freeze({ status: testPassed ? "passed" : "incomplete", root: Object.freeze(root), desktop: Object.freeze(desktop) }),
    runtime_acceptance: Object.freeze({
      packaged_runtime: Object.freeze({ status: options.packagedAcceptance === true ? "passed" : "not_run" }),
      live_runtime: Object.freeze({ status: options.liveRuntimeReplaced === true ? "replaced" : "not_replaced" }),
      chatgpt_cloud_long_stream: Object.freeze({ status: options.cloudLongStreamAcceptance === true ? "accepted" : "not_claimed" }),
    }),
    checked_at: Number.isFinite(checkedAt.getTime()) ? checkedAt.toISOString() : new Date().toISOString(),
  });
}

module.exports = { createReleaseEvidenceSummary };