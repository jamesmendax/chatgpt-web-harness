"use strict";
const assert = require("node:assert/strict");

function parseMode(args) {
  const flags = args.filter(arg => arg === "--local-development");
  if (flags.length > 1) throw new Error("Duplicate --local-development");
  return flags.length ? "local-development" : "final";
}

function assertBuildMode(report, mode) {
  assert.equal(report.mode, mode, `Candidate mode must be ${mode}`);
  assert.equal(report.gates?.offline_retired_package, "passed");
  assert.equal(report.gates?.shared_packaged_safety, "passed");
  assert.equal(report.gates?.real_web, "not_run");
  assert.equal(report.gates?.clean_windows_machine, "not_run");
  const steps = new Map((report.steps || []).map(step => [step.name, step]));
  const required = ["build", "stage", "portable-template", "nsis", "portable", "retired-package-check", "shared-packaged-safety"];
  if (mode === "final") required.push("packaged-provider-acceptance", "clean-host-acceptance");
  for (const name of required) {
    const step = steps.get(name);
    assert.ok(step, `Candidate build step is missing: ${name}`);
    assert.equal(step.exit_code, 0, `Candidate build step failed: ${name}`);
    assert.equal(step.timed_out, false, `Candidate build step timed out: ${name}`);
  }
  if (mode === "local-development") {
    for (const name of ["packaged-provider-acceptance", "clean-host-acceptance"]) assert.ok(!steps.has(name), `Unexpected local-only step: ${name}`);
    assert.equal(report.gates.benchmark, "not_run");
    assert.equal(report.gates.packaged_runtime, "not_run");
    assert.equal(report.gates.setup_install, "not_run");
    assert.equal(report.packaged_acceptance, false);
    assert.equal(report.installer_executed, false);
    assert.equal(report.clean_profile_install_acceptance, false);
    assert.equal(report.portable_clean_profile_acceptance, false);
  } else {
    assert.equal(report.gates.benchmark, "passed");
    assert.equal(report.gates.packaged_runtime, "passed");
    assert.equal(report.gates.setup_install, "passed");
    assert.equal(report.packaged_acceptance, true);
    assert.equal(report.installer_executed, true);
    assert.equal(report.clean_profile_install_acceptance, true);
    assert.equal(report.portable_clean_profile_acceptance, true);
  }
}
module.exports = { parseMode, assertBuildMode };
