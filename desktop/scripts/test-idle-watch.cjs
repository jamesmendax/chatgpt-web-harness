"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { IdleWatch, reminderMinutes, parseCall } = require("../src/idle-watch");
const { formatActivity } = require("../src/feeds");

const MIN = 60_000;
const T0 = new Date(2026, 10, 1, 14, 0, 0).getTime();
const pad = n => String(n).padStart(2, "0");
const clock = ms => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
// The exact console lines the MCP server writes (see scripts/test-activity-log.mjs), as ManagedProcess stamps them.
const stdout = (ms, text, stderr = false) => `${clock(ms)} ${stderr ? "! " : "  "}${text}`;
const ok = (ms, tool, conv, summary = "a.txt") => stdout(ms, `[MCP] [ok] tools/call ${tool} — ${summary} 12ms session=1a2b3c4d${conv ? ` conv=${conv}` : ""}`);

function fixture(minutes = { a: 5, b: 5 }) {
  let now = T0;
  const reminders = [];
  const watch = new IdleWatch({
    now: () => now,
    minutesFor: id => { if (!(id in minutes)) throw new Error("account removed"); return minutes[id]; },
    onRemind: r => reminders.push(r),
  });
  return { watch, reminders, minutes, at: ms => { now = ms; }, tick: ms => { now = ms; return watch.tick(ms); } };
}

test("reads stdout success, error and running lines and the Admin feed line", () => {
  const conv = "0123abcd";
  assert.deepEqual(parseCall(ok(T0, "read_text_file", conv), T0), { at: T0, tool: "read_text_file", conversation: conv, summary: "a.txt" });
  const failed = parseCall(stdout(T0, `[MCP ERROR] HTTP 400 tools/call write_file — denied 3ms session=1a2b3c4d conv=${conv}`, true), T0);
  assert.equal(failed.tool, "write_file"); assert.equal(failed.conversation, conv); assert.equal(failed.summary, "denied");
  const running = parseCall(stdout(T0, `[MCP] [running] tools/call run_command — npm test 60000ms session=1a2b3c4d conv=${conv}`), T0);
  assert.equal(running.tool, "run_command"); assert.equal(running.summary, "npm test");
  const feedLine = formatActivity({ time: new Date(T0).toISOString(), kind: "mcp", action: "tools/call", tool: "grep", status: "ok", duration_ms: 9,
    client: "chatgpt", session_id: "1a2b3c4d-transport", conversation_id: `oai_conv_${conv}${"f".repeat(24)}`, summary: "pattern: foo" });
  assert.match(feedLine, / session=1a2b3c4d conv=0123abcd — pattern: foo$/);
  assert.deepEqual(parseCall(feedLine, T0), { at: T0, tool: "grep", conversation: conv, summary: "pattern: foo" });
  assert.doesNotMatch(formatActivity({ time: new Date(T0).toISOString(), kind: "mcp", action: "tools/call", tool: "grep", conversation_id: "wfr_legacy" }), /conv=/);
});

test("ignores everything that is not an MCP tools/call line, and summary text cannot imitate a conversation", () => {
  for (const text of ["[TOOL] [ok] read_text_file — a.txt", "[MCP] [transport_ok] tools/list (30 tools) — discovery 5ms session=1a2b3c4d",
    "[MCP] session initialize session=1a2b3c4d", "[HARNESS] status=success invocation=I1 tool=grep duration_ms=3",
    "[MCP] [transport_ok] resources/read — mentions tools/call grep 3ms"]) {
    assert.equal(parseCall(stdout(T0, text), T0), null, text);
  }
  const spoof = parseCall(ok(T0, "run_command", null, "echo conv=deadbeef"), T0);
  assert.equal(spoof.conversation, null);
  assert.equal(spoof.summary, "echo conv=deadbeef");
  const { watch } = fixture();
  assert.equal(watch.observe("a", "tunnel", ok(T0, "grep", "0123abcd")), false, "tunnel lines never count");
  assert.equal(watch.observe("a", "launcher", ok(T0, "grep", "0123abcd")), false);
});

test("each conversation has its own gap; another conversation still calling does not hide it", () => {
  const f = fixture();
  f.at(T0); f.watch.observe("a", "mcp", ok(T0, "read_text_file", "aaaa0001"));
  for (let m = 1; m <= 9; m++) { f.at(T0 + m * MIN); f.watch.observe("a", "mcp", ok(T0 + m * MIN, "run_command", "bbbb0002", "npm test")); }
  assert.deepEqual(f.tick(T0 + 5 * MIN - 1).map(r => r.conversation), []);
  const first = f.tick(T0 + 5 * MIN);
  assert.equal(first.length, 1);
  assert.deepEqual({ ...first[0] }, { accountId: "a", conversation: "aaaa0001", tool: "read_text_file", summary: "a.txt", lastAt: T0, idleMinutes: 5 });
  assert.deepEqual(f.tick(T0 + 9 * MIN), [], "one reminder per gap; the busy conversation is not idle");
  assert.deepEqual(f.tick(T0 + 14 * MIN).map(r => r.conversation), ["bbbb0002"]);
  assert.equal(f.reminders.length, 2);
});

test("accounts are independent and calls without a conversation id are timed per account", () => {
  const f = fixture();
  f.watch.observe("a", "mcp", ok(T0, "grep", null));
  f.watch.observe("a", "mcp", ok(T0, "grep", "cccc0003"));
  for (let m = 1; m <= 6; m++) { f.at(T0 + m * MIN); f.watch.observe("b", "mcp", ok(T0 + m * MIN, "grep", null)); }
  const fired = f.tick(T0 + 6 * MIN);
  assert.deepEqual(fired.map(r => [r.accountId, r.conversation]).sort(), [["a", "cccc0003"], ["a", null]].sort());
});

test("a long call reporting [running] every minute is not a gap, and the gap starts when it ends", () => {
  const f = fixture();
  const running = ms => stdout(ms, `[MCP] [running] tools/call run_command — npm run build ${ms - T0}ms session=1a2b3c4d conv=dddd0004`);
  f.watch.observe("a", "mcp", ok(T0, "write_file", "dddd0004"));
  for (let m = 1; m <= 12; m++) { f.at(T0 + m * MIN); f.watch.observe("a", "mcp", running(T0 + m * MIN)); }
  assert.deepEqual(f.tick(T0 + 12 * MIN + 30_000), []);
  f.at(T0 + 13 * MIN); f.watch.observe("a", "mcp", ok(T0 + 13 * MIN, "run_command", "dddd0004", "npm run build"));
  assert.deepEqual(f.tick(T0 + 17 * MIN), []);
  assert.equal(f.tick(T0 + 18 * MIN)[0].summary, "npm run build");
});

test("the same call reported by stdout and the Admin feed does not move time backwards; replayed history never opens a gap", () => {
  const f = fixture();
  f.at(T0 + 3 * MIN); f.watch.observe("a", "mcp", ok(T0 + 3 * MIN, "grep", "eeee0005"));
  f.at(T0 + 3 * MIN + 1500);
  f.watch.observe("a", "mcp", formatActivity({ time: new Date(T0 + 3 * MIN - 200).toISOString(), kind: "mcp", action: "tools/call", tool: "grep", status: "ok", conversation_id: "oai_conv_eeee0005" + "0".repeat(24) }));
  assert.deepEqual(f.tick(T0 + 8 * MIN - 1), []);
  assert.equal(f.tick(T0 + 8 * MIN).length, 1);
  const g = fixture();
  g.at(T0 + 30 * MIN);
  assert.equal(g.watch.observe("a", "mcp", ok(T0, "grep", "ffff0006")), false, "a 30-minute-old feed line is history");
  assert.deepEqual(g.tick(T0 + 40 * MIN), []);
});

test("interval choices: off never reminds; turning it on reports the real gap once; a new call re-arms", () => {
  const f = fixture({ a: 0 });
  f.watch.observe("a", "mcp", ok(T0, "grep", "abab0007"));
  assert.deepEqual(f.tick(T0 + 20 * MIN), []);
  f.minutes.a = 15;
  assert.equal(f.tick(T0 + 22 * MIN)[0].idleMinutes, 22);
  assert.deepEqual(f.tick(T0 + 40 * MIN), []);
  f.at(T0 + 41 * MIN); f.watch.observe("a", "mcp", ok(T0 + 41 * MIN, "grep", "abab0007"));
  assert.deepEqual(f.tick(T0 + 55 * MIN), []);
  assert.equal(f.tick(T0 + 56 * MIN).length, 1);
  assert.equal(reminderMinutes({ idleReminderMinutes: 15 }), 15);
  assert.equal(reminderMinutes({ idleReminderMinutes: 0 }), 0);
  assert.equal(reminderMinutes({ idleReminderMinutes: 7 }), 5);
  assert.equal(reminderMinutes({}), 5);
});

test("a deliberate stop or a removed account clears pending gaps", () => {
  const f = fixture();
  f.watch.observe("a", "mcp", ok(T0, "grep", "cdcd0008"));
  f.watch.observe("gone", "mcp", ok(T0, "grep", "cdcd0009"));
  f.at(T0 + MIN); f.watch.forget("a");
  f.at(T0 + MIN + 1500);
  assert.equal(f.watch.observe("a", "mcp", ok(T0 + 30_000, "grep", "cdcd0008")), false, "a late feed line from before the stop is ignored");
  assert.deepEqual(f.tick(T0 + 10 * MIN), []);
  assert.equal(f.watch.accounts.size, 0);
  f.at(T0 + 11 * MIN);
  assert.equal(f.watch.observe("a", "mcp", ok(T0 + 11 * MIN, "grep", "cdcd0008")), true, "calls after a restart are timed again");
  assert.equal(f.tick(T0 + 16 * MIN).length, 1);
});

test("a line stamped just before midnight belongs to the previous day", () => {
  const late = new Date(2026, 10, 1, 23, 59, 50).getTime(), after = new Date(2026, 10, 2, 0, 0, 5).getTime();
  assert.equal(parseCall(ok(late, "grep", "1234abcd"), after).at, late);
});

test("an initial running report closes a nearly expired gap before the first periodic heartbeat", () => {
  const f = fixture();
  f.watch.observe("a", "mcp", ok(T0, "read_text_file", "abcd0010"));
  f.at(T0 + 4 * MIN + 45_000);
  f.watch.observe("a", "mcp", stdout(T0 + 4 * MIN + 45_000, "[MCP] [running] tools/call run_command — build 0ms conv=abcd0010"));
  assert.deepEqual(f.tick(T0 + 5 * MIN), [], "a call that just started is active even before its first minute heartbeat");
});

test("canonical tool lifecycle tags do not leak into reminder summaries", () => {
  const call = parseCall(stdout(T0, "[TOOL] [running] run_command — started 0ms call=abc-def-1 session=123 conv=0123abcd"), T0);
  assert.equal(call.conversation, "0123abcd"); assert.equal(call.summary, "started");
  const { formatActivity } = require("../src/feeds");
  const feed = parseCall(formatActivity({ time: new Date(T0).toISOString(), kind: "tool", action: "tools/call", tool: "run_command", status: "ok", duration_ms: 9, summary: "completed", details: { invocation_id: "abc-def-1" }, conversation_id: "oai_conv_0123abcd" + "0".repeat(24) }), T0);
  assert.equal(feed.conversation, "0123abcd"); assert.equal(feed.summary, "completed");
});

test("correlated HTTP metadata stays out of idle reminder summary", () => {
  const call = parseCall(stdout(T0, "[MCP ERROR] HTTP 200 tools/call run_command — denied 11ms call=abc-def-1 session=123 conv=0123abcd"), T0);
  assert.equal(call.summary,"denied"); assert.equal(call.conversation,"0123abcd");
});

test("failed delivery retries after a minute without consuming the gap", async () => {
  let now = T0, attempts = 0;
  const watch = new IdleWatch({ now: () => now, minutesFor: () => 5,
    onRemind: async () => ++attempts > 1 });
  watch.observe("a", "mcp", ok(T0, "grep", "dead0011"));
  now = T0 + 5 * MIN; watch.tick(); await Promise.resolve(); await Promise.resolve();
  now += 15_000; watch.tick(); assert.equal(attempts, 1, "no retry on every polling tick");
  now = T0 + 6 * MIN; watch.tick(); await Promise.resolve(); await Promise.resolve();
  assert.equal(attempts, 2, "an unacknowledged notification must be retried");
  now += MIN; watch.tick(); assert.equal(attempts, 2, "successful delivery completes this gap");
});

test("delivery attempts are bounded and pending delivery cannot be duplicated", async () => {
  let now = T0, attempts = 0, settle;
  const watch = new IdleWatch({ now: () => now, minutesFor: () => 5,
    onRemind: () => { attempts++; return new Promise(resolve => { settle = resolve; }); } });
  watch.observe("a", "mcp", ok(T0, "grep", "dead0012"));
  now = T0 + 5 * MIN; watch.tick();
  now += MIN; watch.tick(); assert.equal(attempts, 1);
  settle(false); await Promise.resolve(); await Promise.resolve();
  now += MIN; watch.tick(); assert.equal(attempts, 2);
  settle(false); await Promise.resolve(); await Promise.resolve();
  now += MIN; watch.tick(); assert.equal(attempts, 3);
  settle(false); await Promise.resolve(); await Promise.resolve();
  now += MIN; watch.tick(); assert.equal(attempts, 3, "three attempts per gap avoids endless alerts");
});

test("late delivery results cannot consume a newer gap or revive a stopped account", async () => {
  let now = T0, attempts = 0, settle;
  const watch = new IdleWatch({ now: () => now, minutesFor: () => 5,
    onRemind: () => { attempts++; return new Promise(resolve => { settle = resolve; }); } });
  watch.observe("a", "mcp", ok(T0, "grep", "dead0013"));
  now = T0 + 5 * MIN; watch.tick(); const first = settle;
  now += MIN; watch.observe("a", "mcp", ok(now, "grep", "dead0013"));
  first(true); await Promise.resolve(); await Promise.resolve();
  now += 5 * MIN; watch.tick(); assert.equal(attempts, 2, "new call owns a new gap");
  watch.forget("a"); settle(false); await Promise.resolve(); await Promise.resolve();
  now += 5 * MIN; watch.tick(); assert.equal(attempts, 2); assert.equal(watch.accounts.size, 0);
});

test("duplicate reports of an already observed call do not re-arm a delivered gap", () => {
  const f = fixture(); f.watch.observe("a", "mcp", ok(T0, "grep", "dead0014"));
  f.tick(T0 + 5 * MIN);
  f.at(T0 + 5 * MIN); f.watch.observe("a", "mcp", ok(T0, "grep", "dead0014"));
  f.tick(T0 + 6 * MIN); assert.equal(f.reminders.length, 1);
});

test("trusted full activity identity supersedes old short bucket and survives stdout duplicates", () => {
  const f=fixture(),full="oai_conv_1234abcd"+"f".repeat(24);
  f.at(T0);f.watch.observe("a","mcp",ok(T0,"grep","1234abcd"));
  f.at(T0+500);
  assert.equal(f.watch.observeIdentity("a",{conversationId:full,at:T0+500,tool:"grep"}),true);
  assert.equal(f.watch.accounts.get("a").has("1234abcd"),false);
  f.at(T0+501);
  f.watch.observe("a","mcp",ok(T0,"grep","1234abcd"));
  assert.deepEqual(f.tick(T0+5*MIN+500).map(x=>x.conversation),[full]);
  assert.deepEqual(f.tick(T0+6*MIN),[]);
});

test("different full conversations sharing eight characters never borrow each other's timers", () => {
  const f=fixture(),x="oai_conv_aaaa1234"+"1".repeat(24),y="oai_conv_aaaa1234"+"2".repeat(24);
  f.at(T0);
  assert.equal(f.watch.observeIdentity("a",{conversationId:x,at:T0,tool:"grep"}),true);
  f.at(T0+MIN);
  assert.equal(f.watch.observeIdentity("a",{conversationId:y,at:T0+MIN,tool:"task_state"}),true);
  assert.equal(f.watch.observe("a","mcp",ok(T0+MIN,"grep","aaaa1234")),false);
  const fired=f.tick(T0+6*MIN).map(x=>x.conversation);
  assert.deepEqual(fired.sort(),[x,y].sort());
});
