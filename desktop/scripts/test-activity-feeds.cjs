"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");

// The Admin API is replaced before feeds.js loads it; no port is opened.
let entries = [];
const adminPath = require.resolve("../src/admin-client");
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: { getJson: async () => ({ entries: entries.slice().reverse() }) } };
const { ActivityFeeds } = require("../src/feeds");

const entry = (id, tool) => ({ id, time: new Date().toISOString(), kind: "mcp", action: "tools/call", tool, status: "ok", duration_ms: 4, client: "chatgpt" });

test("Admin feed preserves bounded error diagnostics without copying arbitrary details", () => {
  const { formatActivity } = require("../src/feeds");
  const event = { ...entry("diagnostic", "run_command"), status: "error", summary: "The command did not start", details: {
    invocation_id: "call-diagnostic", outcome_kind: "needs_input", error_code: "REQUIREMENT_CONTRACT_REQUIRED",
    failure_phase: "admission", operation_started: false, retry_policy: "retry_with_changed_args",
    arbitrary_secret: "do-not-log-this", raw_args: { command: "private command" }
  } };
  const line = formatActivity(event);
  assert.match(line, /error 4ms outcome=needs_input code=REQUIREMENT_CONTRACT_REQUIRED phase=admission started=false retry=retry_with_changed_args call=call-diagnostic/);
  assert.match(line, / — The command did not start$/);
  assert.doesNotMatch(line, /do-not-log-this|private command/);
  const invalid = formatActivity({ ...event, details: { ...event.details, error_code: "BAD\ncall=spoof", retry_policy: "retry blindly" } });
  assert.doesNotMatch(invalid, /spoof|retry blindly|code=|retry=/);
});

test("a managed MCP's activity is not repeated from the Admin feed; switching to an external MCP shows only new entries", async () => {
  const feed = new ActivityFeeds(), shown = [];
  feed.on("lines", ({ name, lines }) => { if (name === "mcp") shown.push(...lines); });
  feed.configure({ adminPort: 3401, tunnelPort: 0, adminToken: "", mcpOnStdout: true });
  entries = [entry("1", "grep")];
  await feed.pollMcpActivity();
  assert.deepEqual(shown, [], "stdout already carries these lines");
  feed.configure({ adminPort: 3401, tunnelPort: 0, adminToken: "", mcpOnStdout: false });
  entries.push(entry("2", "read_text_file"));
  await feed.pollMcpActivity();
  assert.equal(shown.length, 2);
  assert.match(shown[0], /已接入 MCP Admin API/);
  assert.match(shown[1], /tools\/call read_text_file ok 4ms client=chatgpt/);
  assert.equal(shown.some(line => / grep /.test(line)), false, "an entry skipped while managed is not replayed later");
});

test("without the managed flag the feed behaves as before", async () => {
  const feed = new ActivityFeeds(), shown = [];
  feed.on("lines", ({ lines }) => shown.push(...lines));
  feed.configure({ adminPort: 3402, tunnelPort: 0, adminToken: "" });
  entries = [entry("a", "write_file")];
  await feed.pollMcpActivity();
  assert.equal(shown.length, 2);
  assert.match(shown[1], /tools\/call write_file/);
});

test("external canonical lifecycle preserves invocation IDs and excludes scoped detail duplicates", async () => {
  const { formatActivity } = require("../src/feeds");
  const feed = new ActivityFeeds(), shown = [];
  feed.on("lines", ({ lines }) => shown.push(...lines));
  feed.configure({ adminPort: 3403, tunnelPort: 0, adminToken: "" });
  const canonical = { ...entry("start", "run_command"), kind: "tool", status: "running", duration_ms: 0, summary: "started", conversation_id: "oai_conv_0123abcd" + "0".repeat(24), details: { invocation_id: "abc-def-1", canonical_lifecycle: true } };
  entries = [canonical, { ...canonical, id: "detail", status: "ok", details: { invocation_id: "abc-def-1", lifecycle_detail: true } }, { ...canonical, id: "end", status: "ok", duration_ms: 17, summary: "completed" }];
  await feed.pollMcpActivity();
  assert.equal(shown.length, 3, "connection notice plus one start and one end");
  assert.match(shown[1], /\[tool\] tools\/call run_command running 0ms call=abc-def-1 client=chatgpt conv=0123abcd — started$/);
  assert.match(shown[2], / ok 17ms call=abc-def-1 /);
  assert.match(formatActivity(canonical), /call=abc-def-1/);
  await feed.pollMcpActivity(); assert.equal(shown.length, 3, "repeated polling does not replay lifecycle events");
});

test("authenticated Admin activity forwards complete identity and task label without changing visible log tokens", async () => {
  const feed=new ActivityFeeds(),observed=[];
  feed.on("activity",e=>observed.push(e));
  feed.configure({adminPort:3457,tunnelPort:0,adminToken:"",mcpOnStdout:true});
  const id="oai_conv_eeeeffff"+"1".repeat(24);
  entries=[{...entry("safe-task-label","task_create"),conversation_id:id,details:{conversation_label_hint:"SVG 动画制作"}}];
  await feed.pollMcpActivity();
  assert.deepEqual(observed.map(x=>[x.conversationId,x.hint,x.tool]),[[id,"SVG 动画制作","task_create"]]);
  await feed.pollMcpActivity();
  assert.equal(observed.length,1);
  entries.push({...entry("short-only","task_state"),conversation_id:"oai_conv_eeeeffff"});
  await feed.pollMcpActivity();
  assert.equal(observed.length,1,"unverified short identity not forwarded");
});


test("reconfiguration and stop discard in-flight MCP responses", async () => {
  const client = require("../src/admin-client"), original = client.getJson;
  try {
    for (const stop of [false, true]) {
      let respond;
      client.getJson = () => new Promise(resolve => { respond = resolve; });
      const feed = new ActivityFeeds(), events = [];
      feed.on("lines", event => events.push(event));
      feed.on("activity", event => events.push(event));
      feed.configure({ adminPort: 1, tunnelPort: 0, adminToken: "old" });
      const pending = feed.pollMcpActivity();
      if (stop) feed.stop(); else feed.configure({ adminPort: 2, tunnelPort: 0, adminToken: "new" });
      respond({ entries: [{ ...entry("stale", "read"), conversation_id: "oai_conv_" + "a".repeat(32) }] });
      await pending;
      assert.deepEqual(events, []);
      assert.equal(feed.lastActivityId, null);
      assert.equal(feed.primed.mcp, false);
      assert.equal(feed.seenIds.size, 0);
    }
  } finally { client.getJson = original; }
});

test("stop discards an in-flight tunnel response", async () => {
  const http = require("node:http");
  let respond, arrived;
  const requestArrived = new Promise(resolve => { arrived = resolve; });
  const server = http.createServer((_req, res) => { respond = res; arrived(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const feed = new ActivityFeeds(), events = [];
    feed.on("lines", event => events.push(event));
    feed.configure({ adminPort: 0, tunnelPort: server.address().port, adminToken: "" });
    const pending = feed.pollTunnelLogs();
    await requestArrived;
    feed.stop();
    respond.end(JSON.stringify({ events: [{ seq: 42, message: "stale" }] }));
    await pending;
    assert.deepEqual(events, []);
    assert.equal(feed.lastTunnelSeq, 0);
    assert.equal(feed.primed.tunnel, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});


test("a listener that reconfigures during activity delivery stops the old response", async () => {
  const feed = new ActivityFeeds(), lines = [];
  feed.configure({ adminPort: 1, tunnelPort: 0, adminToken: "" });
  feed.on("activity", () => feed.configure({ adminPort: 2, tunnelPort: 0, adminToken: "" }));
  feed.on("lines", value => lines.push(value));
  entries = [{ ...entry("old", "read"), conversation_id: "oai_conv_" + "b".repeat(32) }];
  await feed.pollMcpActivity();
  assert.deepEqual(lines, []);
  assert.equal(feed.lastActivityId, null);
  assert.equal(feed.seenIds.size, 0);
  assert.equal(feed.primed.mcp, false);
});


test("repeated unchanged service status does not starve an in-flight poll", async () => {
  const client = require("../src/admin-client"), original = client.getJson;
  try {
    let respond;
    client.getJson = () => new Promise(resolve => { respond = resolve; });
    const feed = new ActivityFeeds(), events = [];
    const config = { adminPort: 1, tunnelPort: 0, adminToken: "token" };
    feed.configure(config);
    feed.on("lines", event => events.push(event));
    const pending = feed.pollMcpActivity();
    feed.configure(config);
    respond({ entries: [entry("current", "read")] });
    await pending;
    assert.equal(feed.lastActivityId, "current");
    assert.equal(events.length, 1);
  } finally { client.getJson = original; }
});
