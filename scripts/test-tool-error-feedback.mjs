import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Actual MCP requests in an owned fixture; no live account or user artifact.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] || path.join(repo, "dist"));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-error-feedback-"));
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace, { recursive: true });
Object.assign(process.env, {
  CODEX_HOME: path.join(temp, "state"), AUDIT_LOG_PATH: path.join(temp, "audit.jsonl"),
  HARNESS_ACCOUNT_ID: "isolated-error-feedback-fixture", CHATGPT_TOOL_PROFILE: "slim",
  CHATGPT_PLUGINS_CONFIG: path.join(temp, "plugins.json"), MCP_UPSTREAM_CONFIG: path.join(temp, "upstream.json"),
});
await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG, JSON.stringify({schema_version:2,skills:[]}));
const load = file => import(pathToFileURL(path.join(dist, file)).href);
const { createMcpServer } = await load("server-factory.js");
const { toolFailureDiagnostic, toolDiagnosticTokens, redactSensitiveText } = await load("lib/tool-diagnostics.js");
const { observeMcpToolResult, consumeMcpOutcome } = await load("lib/mcp-outcome.js");
const { runWithMcpRequestIdentity } = await load("lib/mcp-request-identity.js");
const { getRecentActivity, logMcpRequest } = await load("lib/activity-log.js");
const server = createMcpServer(workspace, 30000, [workspace], false);
const client = new Client({ name: "isolated-error-feedback-test", version: "3.2" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport); await client.connect(clientTransport);
const savedConsole = { log: console.log, warn: console.warn }, lines = [];
console.log = (...values) => lines.push(values.join(" ")); console.warn = console.log;
const call = (name, args) => client.callTool({ name, arguments: args, _meta: {"openai/session":"error-feedback-fixture"} });
const okData = result => {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent || result));
  return result.structuredContent.data;
};
try {
  const catalog = await client.listTools();
  const schema = name => catalog.tools.find(tool => tool.name === name).inputSchema.properties;
  assert.match(schema("list_skills").max_bytes.description, /2000.20000/);
  assert.match(schema("grep").context_after.description, /0.20/);
  assert.equal(schema("run_command")._intent, undefined, "retired approval metadata is not advertised");
  const args = { executable: process.execPath, args: ["-e", "require('node:fs').appendFileSync('executed.txt','x')"], working_directory: workspace };
  const marker = path.join(workspace, "executed.txt");
  const invalid = await call("run_command", {...args, command:"should-not-run"});
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /command OR executable.*exclusively/);
  const invalidDiagnostic = toolFailureDiagnostic(invalid);
  assert.equal(invalidDiagnostic.error_code, "COMMAND_INPUT_INVALID");
  assert.equal(invalidDiagnostic.outcome_kind, "needs_input");
  assert.equal(invalidDiagnostic.failure_phase, "validation");
  assert.equal(invalidDiagnostic.operation_started, false);
  assert.equal(invalidDiagnostic.may_have_partially_completed, false);
  await assert.rejects(fs.stat(marker), {code:"ENOENT"});
  assert.equal(okData(await call("run_command", args)).exit_code, 0);
  assert.equal(await fs.readFile(marker, "utf8"), "x");
  for (const legacy of ['{"intent_revision":1}', '{"reference":{"intent_revision":1,"requirement_hash":"obsolete"}}']) {
    assert.equal(okData(await call("run_command", {...args, _intent:legacy})).exit_code, 0);
  }
  assert.equal(await fs.readFile(marker, "utf8"), "xxx", "each distinct valid request executes once without approval bookkeeping");
  const executionFailure = await call("run_command", {executable:process.execPath,args:["-e","process.exit(7)"],working_directory:workspace});
  assert.equal(executionFailure.structuredContent.ok, false);
  assert.equal(executionFailure.structuredContent.data.error_code, "COMMAND_EXIT_NONZERO");
  const diagnostic = toolFailureDiagnostic(executionFailure);
  assert.equal(diagnostic.outcome_kind,"execution_error"); assert.equal(diagnostic.operation_started,true);
  assert.equal(diagnostic.exit_code,7); assert.equal(diagnostic.timed_out,false);
  assert.equal(diagnostic.may_have_partially_completed,true);
  const noReview=okData(await call("visual_review",{action:"status"}));
  assert.equal(noReview.review,null);
  const unknownReview=await call("visual_review",{action:"status",review_id:"11111111-1111-1111-1111-111111111111"});
  assert.equal(unknownReview.structuredContent.data.error_code,"VISUAL_REVIEW_NOT_FOUND");
  assert.equal(unknownReview.structuredContent.data.outcome_kind,"needs_input");
  const sensitive = {
    isError:true,content:[{type:"text",text:"RAW_RESULT_SENTINEL"}],
    structuredContent:{ok:false,data:{error:'FIXTURE_ERROR: API_KEY="SECRET_KEY_SENTINEL" token: SECRET_TOKEN_SENTINEL\nBearer SECRET_BEARER_SENTINEL',
      error_code:"FIXTURE_ERROR",outcome_kind:"needs_input",failure_phase:"validation",operation_started:false,
      retry_policy:"retry_with_changed_args",raw_args:"RAW_ARGS_SENTINEL",stdout:"RAW_STDOUT_SENTINEL"}}
  };
  const observed=runWithMcpRequestIdentity(undefined,"diagnostic-transport",()=>{
    observeMcpToolResult({requestId:"diagnostic-test",tool:"fixture",invocationId:"fixture-call",result:sensitive});
    const outcome=consumeMcpOutcome("diagnostic-test","fixture");
    assert.equal(consumeMcpOutcome("diagnostic-test","fixture"),undefined);
    return outcome;
  });
  assert.equal(observed.rpc_result_status,"success");assert.equal(observed.tool_result_status,"error");
  assert.equal(observed.client_delivery,"unknown");
  assert.doesNotMatch(JSON.stringify(observed),/SECRET_.*_SENTINEL|RAW_.*_SENTINEL/);
  assert.match(toolDiagnosticTokens(observed.failure),/outcome=needs_input.*started=false/);
  assert.equal(redactSensitiveText('{"password":"SECRET_PASSWORD_SENTINEL"}'),'{"password":[REDACTED]}');
  logMcpRequest({method:"tools/call",params:{name:"fixture",arguments:{}}},"fixture-session",1,200,undefined,observed);
  const logged=getRecentActivity(1)[0];
  assert.equal(logged.status,"error");assert.equal(logged.details.operation_started,false);
  assert.match(lines.at(-1),/outcome=needs_input code=FIXTURE_ERROR phase=validation started=false retry=retry_with_changed_args call=fixture-call/);
  assert.doesNotMatch(JSON.stringify(logged),/SECRET_.*_SENTINEL|RAW_.*_SENTINEL/);
  const canonical=getRecentActivity(500).find(entry=>entry.details?.canonical_lifecycle&&entry.details?.error_code==="COMMAND_EXIT_NONZERO");
  assert.equal(canonical?.details?.outcome_kind,"execution_error");
  assert.equal(canonical?.details?.operation_started,true);
} finally {
  Object.assign(console,savedConsole);
  await client.close();await server.close();await fs.rm(temp,{recursive:true,force:true});
}
console.log("Tool error feedback: invalid arguments do not execute, direct and legacy requests execute once, exit/timeout differ, visual missing state and request-scoped redacted diagnostics PASS");
