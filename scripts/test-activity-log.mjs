import assert from "node:assert/strict";
import {
  activityConversationId, appendActivity, getRecentActivity, logMcpRequest, logMcpToolRunning, redactSensitiveText, summarizeToolArgs, conversationTaskTitleHint,
} from "../dist/lib/activity-log.js";
import { conversationSessionIdFromMeta } from "../dist/lib/mcp-request-identity.js";

// summarizeToolArgs
assert.equal(summarizeToolArgs("run_command", { command: "npm test" }), "npm test");
assert.equal(summarizeToolArgs("read_text_file", { path: "C:\\foo.ts" }), "C:\\foo.ts");
assert.equal(redactSensitiveText("OPENAI_API_KEY=sk-secret npm test"), "OPENAI_API_KEY=[REDACTED] npm test");
assert.equal(redactSensitiveText("Authorization: Bearer abc.def-123"), "Authorization: Bearer [REDACTED]");

// append + retrieve
const before = getRecentActivity(500).length;
appendActivity({ kind: "tool", tool: "grep", status: "ok", summary: "pattern: foo" });
assert.equal(getRecentActivity(500).length, before + 1);
const latest = getRecentActivity(1)[0];
assert.equal(latest.tool, "grep");
assert.equal(latest.kind, "tool");

// logMcpRequest tools/call
logMcpRequest(
  { method: "tools/call", params: { name: "read_text_file", arguments: { path: "/tmp/x" } } },
  "sess-abc-123",
  42,
  200
);
const mcp = getRecentActivity(5).find((e) => e.kind === "mcp" && e.tool === "read_text_file");
assert.ok(mcp, "expected mcp tools/call entry");
assert.equal(mcp.client, "chatgpt");
assert.equal(mcp.duration_ms, 42);
assert.equal(mcp.summary, "/tmp/x");
assert.deepEqual(mcp.details?.argument_keys, ["path"]);
assert.equal("arguments" in (mcp.details || {}), false, "raw tool arguments must not be retained");

// filter since
const all = getRecentActivity(500);
const since = all[1]?.id;
if (since) {
  const newer = getRecentActivity(500, since);
  assert.ok(newer.length < all.length);
}

// error logging with message
logMcpRequest(
  { method: "tools/call", params: { name: "write_file", arguments: { path: "/x" } } },
  "sess-err",
  2,
  400,
  "Bad Request: Server not initialized"
);
const errEntry = getRecentActivity(3).find((e) => e.status === "error" && e.tool === "write_file");
assert.ok(errEntry, "expected error activity entry");
assert.equal(errEntry.summary, "Bad Request: Server not initialized");

// conversation attribution: only the documented openai/session identity, never workflow or transport ids
const conversation = conversationSessionIdFromMeta({ "openai/session": "activity-conversation-fixture" });
assert.match(conversation, /^oai_conv_[0-9a-f]{32}$/);
const short = conversation.slice("oai_conv_".length, "oai_conv_".length + 8);
assert.equal(activityConversationId({ method: "tools/call", params: { _meta: { "openai/session": "activity-conversation-fixture" } } }), conversation);
assert.equal(activityConversationId({ params: {} }, { "X-OpenAI-Session": "activity-conversation-fixture" }), conversation);
assert.equal(activityConversationId({ params: {} }, { "x-client-request-id": "wfr_legacyWorkflow1/command_1" }), undefined);
assert.equal(activityConversationId({ params: {} }, { "mcp-session-id": "transport-only" }), undefined);
assert.equal(activityConversationId([{ params: { _meta: { "openai/session": "batch" } } }]), undefined);

const printed = [];
const original = { log: console.log, warn: console.warn };
console.log = (line) => printed.push(String(line));
console.warn = (line) => printed.push(String(line));
try {
  logMcpRequest(
    { method: "tools/call", params: { name: "run_command", arguments: { command: "echo conv=deadbeef" } } },
    "sess-conv-1",
    7,
    200,
    undefined,
    undefined,
    conversation
  );
  logMcpRequest({ method: "tools/call", params: { name: "write_file", arguments: { path: "/y" } } }, "sess-conv-2", 3, 400, "denied", undefined, conversation);
  logMcpToolRunning({ tool: "run_command", elapsedMs: 60000, sessionId: "sess-running", conversationId: conversation, summary: "npm test" });
  logMcpRequest({ method: "tools/call", params: { name: "read_text_file", arguments: { path: "/z" } } }, "sess-anon", 5, 200);
} finally {
  Object.assign(console, original);
}
const tagged = getRecentActivity(4).reverse();
assert.equal(tagged[0].conversation_id, conversation);
assert.equal(tagged[0].session_id, "sess-conv-1", "transport session stays separate from the conversation");
assert.equal(tagged[2].status, "running");
assert.equal(tagged[2].duration_ms, 60000);
assert.equal(tagged[3].conversation_id, undefined);
assert.equal(printed[0], `[MCP] [transport_ok] tools/call run_command — echo conv=deadbeef 7ms session=sess-con conv=${short}`);
assert.equal(printed[1], `[MCP ERROR] HTTP 400 tools/call write_file — denied 3ms session=sess-con conv=${short}`);
assert.equal(printed[2], `[MCP] [running] tools/call run_command — npm test 60000ms session=sess-run conv=${short}`);
assert.equal(printed[3], "[MCP] [transport_ok] tools/call read_text_file — /z 5ms session=sess-ano");

console.log("activity-log: ok");
// HTTP outcome correlation must survive console rendering without exposing credentials.
const correlated=[],savedConsole={log:console.log,warn:console.warn};console.log=line=>correlated.push(String(line));console.warn=console.log;
try {
  for(const status of ['success','error'])logMcpRequest({method:'tools/call',params:{name:'run_command',arguments:{command:'echo API_KEY=PRIVATE_SENTINEL'}}},'transport-correlation',0,200,undefined,{rpc_result_status:'success',tool_result_status:status,client_delivery:'unknown',invocation_id:'correlated-'+status},conversation);
} finally {Object.assign(console,savedConsole);}
assert.match(correlated[0],new RegExp('^\\[MCP\\] \\[ok\\].*API_KEY=\\[REDACTED\\] 0ms call=correlated-success session=transpor conv='+short+'$'));
assert.match(correlated[1],new RegExp('^\\[MCP ERROR\\] HTTP 200 .*0ms call=correlated-error session=transpor conv='+short+'$'));
assert.doesNotMatch(correlated.join('\n'),/PRIVATE_SENTINEL/);

assert.equal(conversationTaskTitleHint("task_create",{goal:"创建 SVG 动画 HTML"}),"创建 SVG 动画 HTML");
assert.equal(conversationTaskTitleHint("task_state",{action:"create",goal:"修复账号迁移"}),"修复账号迁移");
assert.equal(conversationTaskTitleHint("goal",{action:"create",objective:"继续发行安全检查"}),"继续发行安全检查");
assert.equal(conversationTaskTitleHint("run_command",{goal:"伪造目标"}),undefined);
assert.equal(conversationTaskTitleHint("task_create",{goal:"API_KEY=private-sentinel"}),undefined);
assert.equal(conversationTaskTitleHint("task_create",{goal:"https://private.example/key"}),undefined);
const noPrint=console.log;console.log=()=>{};
try {
  logMcpRequest({method:"tools/call",params:{name:"task_create",arguments:{goal:"创建 SVG 动画 HTML"}}},
    "title-fixture",6,200,undefined,{rpc_result_status:"success",tool_result_status:"success"},conversation);
  const e=getRecentActivity(1)[0];
  assert.equal(e.details?.conversation_label_hint,"创建 SVG 动画 HTML");
  logMcpRequest({method:"tools/call",params:{name:"task_create",arguments:{goal:"ACCESS_TOKEN=private-value"}}},
    "title-fixture",6,200,undefined,{rpc_result_status:"success",tool_result_status:"error"},conversation);
  assert.equal(getRecentActivity(1)[0].details?.conversation_label_hint,undefined);
} finally {console.log=noPrint;}
