"use strict";
// Completion contracts for the existing default Electron tests. Exit 0 is
// necessary, but the main process can also quit before a test's assertions end.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { StringDecoder } = require("node:string_decoder");
const { componentElectronTests } = require("./test-isolation.cjs");
const contracts = {
  "smoke.js": { text: "30/30 passed" },
  "test-migration.js": { text: "migration: v1 registry/upstream migration, archify seed cleanup, manifest, reset backups and data boundaries OK" },
  "test-node-shim.js": { text: "node-shim: PATH forwarding, arguments, exit status, space paths, non-ASCII executable path, no recursion and explicit MCP executable OK" },
  "test-isolated-ui.cjs": { text: "PASS real Aura Electron main/preload isolation, inherited override scrubbing, protected legacy data and separate accounts" },
  "test-setup-runtime.cjs": { marker: "SETUP_RUNTIME ", directory: true, file: "result.json", success: "ok", checks: 3 },
  "test-account-setup-ui.cjs": { marker: "RESULT ", directory: true, file: "result.json", success: "ok", checks: 4 },
  "test-account-import-ui.cjs": { marker: "RESULT ", directory: true, file: "result.json", success: "ok", checks: 6 },
  "test-aura-preferences.cjs": { marker: "RESULT ", directory: true, file: "result.json", success: "ok", checks: 6 },
  "test-aura-boot.cjs": { marker: "AURA_OCCLUDED_BOOT ", file: "report.json", success: "passed" },
  "test-aura-ui.cjs": { marker: "AURA_UI_COMPLETE ", report: true, success: "passed", checks: 11 },
  "test-aura-feedback.cjs": { marker: "AURA_NATIVE_FEEDBACK ", file: "report.json", success: "passed" },
  "test-renderer-memory-recovery.cjs": { marker: "MEMORY_GUARD_NATIVE_ACCEPTANCE ", file: "result.json", success: "passed", modes: ["renderer", "gpu", "plain"] },
  "test-aura-quality-ui.cjs": { marker: "QUALITY_NATIVE_PASS ", file: "result.json", success: "passed", checks: 13 },
};
assert.deepEqual(Object.keys(contracts).sort(), [...componentElectronTests].sort(), "Default Electron entries need completion contracts");
const expectedInvocations = Object.entries(contracts).flatMap(([target, spec]) => (spec.modes || ["default"]).map(mode => ({ target, mode })));
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function inside(scope, file) {
  const relative = path.relative(path.resolve(scope), path.resolve(file));
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
function readOwnedJson(scope, file) {
  assert.ok(path.isAbsolute(file) && inside(scope, file), "Completion result escaped its fresh fixture scope");
  assert.ok(inside(fs.realpathSync(scope), fs.realpathSync(file)), "Completion result resolves outside its fixture scope");
  assert.ok(fs.statSync(file).size <= 1024 * 1024, "Completion result exceeds 1 MiB");
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")), sha256: digest(bytes), path: file };
}
function invocationMode(target, args) {
  if (!contracts[target]?.modes) return "default";
  assert.ok(!(args.includes("--gpu-pressure") && args.includes("--plain-crash")), "Conflicting memory test modes");
  return args.includes("--gpu-pressure") ? "gpu" : args.includes("--plain-crash") ? "plain" : "renderer";
}
function assertResult(spec, value, mode) {
  assert.equal(value[spec.success], true, "Electron result did not report success");
  if (spec.checks) { assert.ok(Array.isArray(value.checks), "Electron checks are not an array"); assert.equal(value.checks.length, spec.checks, "Electron result omitted required checks"); }
  if (spec.modes) assert.equal(value.mode, mode, "Result has wrong memory mode");
}
function createCompletionObserver({ target, args = [], scope }) {
  const spec = contracts[target]; assert.ok(spec, "Unknown default Electron test: " + target);
  const mode = invocationMode(target, args), streams = new Map();
  let completion, matches = 0, parseError;
  function line(text) {
    if (spec.text) { if (text.trim() === spec.text) { matches++; completion = { text: spec.text }; } return; }
    if (!text.startsWith(spec.marker)) return;
    const tail = text.slice(spec.marker.length);
    // Bundled doctor output can also say "RESULT ok". Only an absolute fixture
    // directory is the test's RESULT contract.
    if (spec.directory && !path.isAbsolute(tail)) return;
    matches++;
    completion = spec.directory ? { fixture: tail } : JSON.parse(tail);
  }
  function consume(state, text, end = false) {
    state.pending += text;
    let offset;
    while ((offset = state.pending.indexOf("\n")) !== -1) {
      line(state.pending.slice(0, offset).replace(/\r$/, "")); state.pending = state.pending.slice(offset + 1);
    }
    assert.ok(state.pending.length <= 256 * 1024, "Electron completion output line exceeds 256 KiB");
    if (end && state.pending) { line(state.pending.replace(/\r$/, "")); state.pending = ""; }
  }
  return {
    write(channel, chunk) {
      if (parseError) return;
      let state = streams.get(channel);
      if (!state) { state = { decoder: new StringDecoder("utf8"), pending: "" }; streams.set(channel, state); }
      try { consume(state, state.decoder.write(chunk)); } catch (error) { parseError = error; }
    },
    finish({ exitCode, signal, error }) {
      if (error) throw error;
      assert.equal(signal, null, "Electron fixture terminated by signal");
      assert.equal(exitCode, 0, "Electron fixture exited unsuccessfully");
      for (const state of streams.values()) { try { consume(state, state.decoder.end(), true); } catch (error) { parseError ||= error; } }
      if (parseError) throw parseError;
      assert.equal(matches, 1, "Expected one terminal completion signal for " + target);
      const proof = { marker: spec.text || spec.marker };
      if (!spec.text) {
        const resultPath = spec.report ? completion.report : path.join(completion.fixture || "", spec.file);
        const result = readOwnedJson(scope, resultPath);
        assertResult(spec, result.value, mode);
        if (spec.modes) assert.equal(completion.mode, mode, "Completion signal has wrong memory mode");
        if (Object.hasOwn(completion, "passed")) assert.equal(completion.passed, true, "Completion signal did not pass");
        if (Object.hasOwn(completion, "checks")) assert.equal(completion.checks, result.value.checks.length, "Completion signal/check count differs");
        Object.assign(proof, { result: result.path, result_sha256: result.sha256 });
      }
      const value = { schema: 1, target, mode, scope: path.resolve(scope), complete: true, passed: true, exit_code: 0, signal: null, proof };
      const receipt = path.join(scope, "component-completion.json"), bytes = JSON.stringify(value, null, 2) + "\n";
      fs.writeFileSync(receipt, bytes, { flag: "wx" });
      return { target, mode, scope: value.scope, receipt, receipt_sha256: digest(bytes) };
    },
  };
}
function verifyDesktopCompletionLog(log) {
  const records = log.split(/\r?\n/).filter(line => line.startsWith("DESKTOP_COMPONENT_COMPLETE ")).map(line => JSON.parse(line.slice(27)));
  const keys = records.map(row => row.target + ":" + row.mode).sort();
  assert.deepEqual(keys, expectedInvocations.map(row => row.target + ":" + row.mode).sort(), "Desktop log omitted or duplicated a required Electron invocation");
  for (const row of records) {
    const receipt = readOwnedJson(row.scope, row.receipt);
    assert.equal(receipt.sha256, row.receipt_sha256, "Electron completion receipt changed");
    assert.equal(receipt.value.target, row.target); assert.equal(receipt.value.mode, row.mode);
    assert.equal(path.resolve(receipt.value.scope), path.resolve(row.scope));
    assert.equal(receipt.value.complete, true); assert.equal(receipt.value.passed, true);
    assert.equal(receipt.value.exit_code, 0); assert.equal(receipt.value.signal, null);
    const spec = contracts[row.target];
    assert.equal(receipt.value.proof?.marker, spec.text || spec.marker, "Electron completion contract differs");
    if (!spec.text) {
      const result = readOwnedJson(row.scope, receipt.value.proof.result);
      assert.equal(result.sha256, receipt.value.proof.result_sha256, "Electron test result changed after completion");
      assertResult(spec, result.value, row.mode);
    }
  }
  return records;
}
module.exports = { createCompletionObserver, verifyDesktopCompletionLog, expectedInvocations };
