import assert from "node:assert/strict";
import { compactOutput, observeCommand } from "../dist/lib/command-observation.js";

const failure = observeCommand({
  command: "npm test",
  stdout: "Tests: 7 passed, 1 failed\n8 total\n",
  stderr: "AssertionError: expected 2 but received 3\n",
  exitCode: 1,
});
assert.equal(failure.command_kind, "test");
assert.equal(failure.outcome, "failed");
assert.ok(failure.diagnostics.some((item) => item.level === "error"));
assert.equal(failure.test_summary?.failed, 1);

const success = observeCommand({
  command: "npm run build",
  stdout: "Build succeeded\n0 errors\n",
  stderr: "",
  exitCode: 0,
});
assert.equal(success.command_kind, "build");
assert.equal(success.outcome, "passed");

const long = compactOutput(`${"head\n".repeat(500)}TAIL-MARKER`, 1200);
assert.equal(long.truncated, true);
assert.ok(long.text.length <= 1300);
assert.ok(long.text.includes("TAIL-MARKER"));

console.log("command-observation: classification, diagnostics, test counts, and bounded previews OK");