import { applyUnifiedPatchToText, buildSimpleDiff } from "../dist/lib/patch.js";
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    failed++;
  }
}

test("codex-style patch without line numbers", () => {
  const original = "def fib(n):\n    if n <= 1:\n        return n\n    return fib(n-1) + fib(n-2)\n";
  const patch = "@@\n-def fib(n):\n+def fibonacci(n):\n     if n <= 1:\n";
  const result = applyUnifiedPatchToText(original, patch);
  if (!result.includes("def fibonacci(n):")) throw new Error("rename not applied");
  if (result.includes("def fib(n):")) throw new Error("old name still present");
});

test("unified diff with line numbers", () => {
  const original = "line1\nline2\nline3\nline4\n";
  const patch = "@@ -2,3 +2,4 @@\n line2\n-line3\n+new\n+extra\n line4\n";
  assert.equal(applyUnifiedPatchToText(original, patch), "line1\nline2\nnew\nextra\nline4\n");
});

test("a numbered hunk whose removed line is not in the file is rejected, not applied by position", () => {
  // The previous version of the test above removed a nonexistent "old" line
  // and still "succeeded" by overwriting whatever sat at line 3.
  assert.throws(() => applyUnifiedPatchToText("line1\nline2\nline3\nline4\n", "@@ -2,2 +2,3 @@\n line2\n-old\n+new\n line4\n"), /Patch context not found/);
});

test("crlf preserved", () => {
  const original = "a\r\nb\r\nc\r\n";
  const patch = "@@\n-b\r\n+c2\r\n";
  const result = applyUnifiedPatchToText(original, patch);
  if (!result.includes("c2\r\n")) throw new Error("crlf patch failed");
});

test("insertion before a long unchanged suffix produces only the inserted line", () => {
  const original = Array.from({ length: 10000 }, (_, i) => `row ${i}`).join("\n");
  const preview = buildSimpleDiff(original, `inserted\n${original}`);
  assert.ok(preview === "+ inserted", `unexpected insertion diff: ${Buffer.byteLength(preview)} bytes`);
});

test("deletion before a long unchanged suffix produces only the removed line", () => {
  const rest = Array.from({ length: 10000 }, (_, i) => `row ${i}`).join("\n");
  const preview = buildSimpleDiff(`removed\n${rest}`, rest);
  assert.ok(preview === "- removed", `unexpected deletion diff: ${Buffer.byteLength(preview)} bytes`);
});

test("separated edits resynchronize without repeating unchanged source", () => {
  const original = Array.from({ length: 1000 }, (_, i) => `row ${i}`);
  const updated = original.flatMap((row, i) => i === 250 ? ["replacement 250"]
    : i === 500 ? ["insert500", row] : i === 750 ? [] : [row]);
  updated.unshift("start"); updated.push("end");
  const preview = buildSimpleDiff(original.join("\n"), updated.join("\n"));
  assert.ok(preview === "+ start\n- row 250\n+ replacement 250\n+ insert500\n- row 750\n+ end",
    `unexpected separated-edit diff: ${Buffer.byteLength(preview)} bytes`);
});

test("line ending normalization does not invent content changes", () => {
  assert.equal(buildSimpleDiff("a\r\nb\r\n", "a\nb\n"), "(no visible diff)");
});

test("repeated lines and unicode preserve every addition and removal", () => {
  const before = ["same", "same", "\u4e2d\u6587", "tail", "same", "end"];
  const after = ["same", "\u65b0\u589e", "same", "tail", "same", "end", "extra"];
  const counts = new Map();
  const add = (line, amount) => counts.set(line, (counts.get(line) || 0) + amount);
  before.forEach(line => add(line, 1));
  for (const line of buildSimpleDiff(before.join("\n"), after.join("\n")).split("\n")) {
    assert.match(line, /^[+-] /);
    add(line.slice(2), line[0] === "+" ? 1 : -1);
  }
  after.forEach(line => add(line, -1));
  assert.ok([...counts.values()].every(value => value === 0));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);