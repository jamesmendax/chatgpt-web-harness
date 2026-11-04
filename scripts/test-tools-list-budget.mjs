import assert from "node:assert/strict";
import test from "node:test";
import { assessToolsListBudget, assertToolsListBudget, SLIM_TOOLS_LIST_BUDGET } from "./lib/tools-list-budget.mjs";

function payloadWithBytes(bytes) {
  const listed = { tools: [{ name: "boundary", description: "" }] };
  const fixedBytes = Buffer.byteLength(JSON.stringify(listed), "utf8");
  assert.ok(bytes >= fixedBytes);
  listed.tools[0].description = "x".repeat(bytes - fixedBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(listed), "utf8"), bytes);
  return listed;
}

function capture(listed) {
  const reports = [];
  const warnings = [];
  const result = assertToolsListBudget(listed, {
    label: "budget fixture",
    report: (text) => reports.push(text),
    warn: (text) => warnings.push(text),
  });
  return { result, reports, warnings };
}

test("40 KiB soft boundary passes without a warning; the next byte warns", () => {
  assert.equal(SLIM_TOOLS_LIST_BUDGET.softBytes, 40960);
  for (const bytes of [40959, 40960]) {
    const { result, reports, warnings } = capture(payloadWithBytes(bytes));
    assert.equal(result.status, "pass");
    assert.equal(result.bytes, bytes);
    assert.equal(reports.length, 1);
    assert.equal(warnings.length, 0);
  }
  const { result, reports, warnings } = capture(payloadWithBytes(40961));
  assert.equal(result.status, "warn");
  assert.equal(reports.length, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /soft budget exceeded.*40961 bytes/);
});

test("48 KiB is inclusive; the next byte fails with retained diagnostics", () => {
  assert.equal(SLIM_TOOLS_LIST_BUDGET.hardBytes, 49152);
  const { result, warnings } = capture(payloadWithBytes(49152));
  assert.equal(result.status, "warn");
  assert.equal(warnings.length, 1);
  const reports = [];
  const hardWarnings = [];
  assert.throws(() => assertToolsListBudget(payloadWithBytes(49153), {
    report: (text) => reports.push(text),
    warn: (text) => hardWarnings.push(text),
  }), /hard budget exceeded.*49153 bytes.*soft=40960, hard=49152.*boundary=/);
  assert.equal(reports.length, 1);
  const report = JSON.parse(reports[0].slice("TOOLS_LIST_BUDGET ".length));
  assert.equal(report.status, "fail");
  assert.equal(report.bytes, 49153);
  assert.equal(report.largestTools[0].name, "boundary");
  assert.equal(hardWarnings.length, 0);
});

test("UTF-8 bytes, including Unicode tool names and schemas, govern the budget", () => {
  const listed = {
    tools: [{
      name: "工具",
      description: "恢复 🧭",
      inputSchema: { type: "object", properties: { "路径": { type: "string" } } },
      annotations: { readOnlyHint: true },
    }],
  };
  const serialized = JSON.stringify(listed);
  const measured = assessToolsListBudget(listed);
  assert.equal(measured.bytes, Buffer.byteLength(serialized, "utf8"));
  assert.ok(measured.bytes > serialized.length);
  assert.equal(measured.largestTools[0].bytes, Buffer.byteLength(JSON.stringify(listed.tools[0]), "utf8"));
  const boundary = payloadWithBytes(40960);
  boundary.tools[0].description = boundary.tools[0].description.slice(1) + "界";
  assert.equal(assessToolsListBudget(boundary).bytes, 40962);
  assert.equal(assessToolsListBudget(boundary).status, "warn");
});

test("only the normalized tools payload is counted, preserving schemas and annotations", () => {
  const tool = {
    name: "write_fixture",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  };
  const expected = structuredClone(tool);
  const plain = { tools: [tool] };
  const wrapped = { tools: plain.tools, _meta: { request: "x".repeat(60000) }, jsonrpc: "2.0", id: 8 };
  assert.deepEqual(assessToolsListBudget(wrapped), assessToolsListBudget(plain));
  capture(wrapped);
  assert.deepEqual(tool, expected);
});

test("diagnostics contain the ten largest tools in deterministic byte order", () => {
  const tools = Array.from({ length: 12 }, (_, index) => ({
    name: `tool-${String(index).padStart(2, "0")}`,
    description: "x".repeat(index * 50),
  }));
  const listed = { tools };
  const before = structuredClone(listed);
  const { result, reports } = capture(listed);
  assert.equal(result.toolCount, 12);
  assert.equal(result.largestTools.length, 10);
  assert.deepEqual(result.largestTools.map((row) => row.name),
    ["tool-11", "tool-10", "tool-09", "tool-08", "tool-07", "tool-06", "tool-05", "tool-04", "tool-03", "tool-02"]);
  for (const row of result.largestTools) {
    assert.equal(row.bytes, Buffer.byteLength(JSON.stringify(tools.find((tool) => tool.name === row.name)), "utf8"));
  }
  assert.deepEqual(listed, before);
  assert.equal(JSON.parse(reports[0].slice("TOOLS_LIST_BUDGET ".length)).largestTools.length, 10);
  assert.deepEqual(assessToolsListBudget({ tools: [{ name: "b" }, { name: "a" }] }).largestTools.map((row) => row.name), ["a", "b"]);
});

test("empty catalogs are measured; malformed list results fail instead of undercounting", () => {
  const empty = assessToolsListBudget({ tools: [] });
  assert.equal(empty.bytes, Buffer.byteLength('{"tools":[]}', "utf8"));
  assert.equal(empty.toolCount, 0);
  assert.deepEqual(empty.largestTools, []);
  for (const value of [null, {}, { tools: {} }]) {
    assert.throws(() => assessToolsListBudget(value), /requires a tools array/);
  }
});