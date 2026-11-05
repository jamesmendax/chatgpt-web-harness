import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "wh-v32-identity-"));
Object.assign(process.env, {
  CODEX_HOME: path.join(fixture, "state"),
  AUDIT_LOG_PATH: path.join(fixture, "audit.log"),
  CHECKPOINT_PATH: path.join(fixture, "checkpoints"),
  CHATGPT_PLUGINS_CONFIG: path.join(fixture, "plugins.json"),
  MCP_UPSTREAM_CONFIG: path.join(fixture, "upstream.json"),
  CHATGPT_TOOL_PROFILE: "full", GOAL_WATCHDOG_ENABLED: "false",
  HARNESS_ACCOUNT_ID: "v32-fixture-account",
});
await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG!, JSON.stringify({schema_version:2,skills:[],computer_use:{enabled:false}}));
await fs.writeFile(process.env.MCP_UPSTREAM_CONFIG!, JSON.stringify({version:1,servers:[]}));
const identity = await import("../src/lib/mcp-request-identity.js");
const { createRuntimeScope } = await import("../src/lib/runtime-scope.js");
const outcomes = await import("../src/lib/mcp-outcome.js");
const { toolFailureDiagnostic } = await import("../src/lib/tool-diagnostics.js");
const { createMcpServer } = await import("../src/server-factory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const workspace = path.join(fixture, "workspace"); await fs.mkdir(workspace);
const seed = {workspaceRoot:workspace,projectRoots:[workspace],principalId:"account-a"};
const body = (conversation: string) => ({params:{_meta:{"openai/session":conversation}}});
try {
  const chatA = identity.conversationSessionIdFromMeta({"openai/session":"chat-a"});
  const chatB = identity.conversationSessionIdFromMeta({"openai/session":"chat-b"});
  assert.notEqual(chatA, chatB);
  assert.equal(identity.conversationSessionIdFromHeaders({"x-openai-session":"chat-a"}), undefined);
  const headers = {accept:"application/json, text/event-stream","mcp-session-id":"old","authorization":"secret"};
  const original = identity.runWithMcpRequestIdentity(headers, "old", () => {
    const first = identity.getMcpRequestIdentity()!;
    headers.accept="application/json";headers["mcp-session-id"]="recovered";
    return identity.runWithMcpRequestIdentity(headers,"recovered",()=> {
      const nested = identity.getMcpRequestIdentity()!;
      assert.equal(nested.requestInstanceId, first.requestInstanceId);
      assert.equal(nested.originalHeaders.accept, "application/json, text/event-stream");
      assert.equal(nested.originalHeaders["mcp-session-id"], "old");
      assert.equal(nested.originalHeaders.authorization, undefined);
      const scope = createRuntimeScope(seed,{sessionId:"recovered"});
      assert.equal(scope.mcpSessionId,chatA);
      assert.equal(scope.conversationContinuity,"trusted");
      return nested;
    },body("chat-a"));
  },body("chat-a"));
  assert.equal(original.conversationSessionId,chatA);
  const reconnected = identity.runWithMcpRequestIdentity({}, "new",()=>createRuntimeScope(seed,{sessionId:"new"}),body("chat-a"));
  assert.equal(reconnected.mcpSessionId,chatA);
  const unknown = identity.runWithMcpRequestIdentity({"x-openai-session":"chat-a"},"transport",()=>createRuntimeScope(seed,{sessionId:"transport"}));
  assert.equal(unknown.conversationSessionId,undefined);
  assert.equal(unknown.conversationContinuity,"unknown");
  identity.runWithMcpRequestIdentity({},"outer",()=> {
    const conflict = createRuntimeScope(seed,{sessionId:"inner",_meta:{"openai/session":"chat-b"}});
    assert.equal(conflict.conversationContinuity,"conflict");
    assert.equal(conflict.conversationSessionId,undefined);
    assert.match(conflict.mcpSessionId!,/^unattributed_/);
  },body("chat-a"));
  await Promise.all(["chat-a","chat-b"].map(async chat => identity.runWithMcpRequestIdentity({}, "shared-transport", async()=>{
    const scope=createRuntimeScope(seed,{sessionId:"shared-transport"});
    assert.equal(scope.mcpSessionId,identity.conversationSessionIdFromMeta({"openai/session":chat}));
    outcomes.observeMcpToolResult({requestId:7,tool:"fixture",invocationId:chat,result:{content:[],structuredContent:{ok:true}}});
    await new Promise(resolve=>setTimeout(resolve,chat==="chat-a"?15:1));
    assert.equal(outcomes.consumeMcpOutcome(7,"fixture")?.invocation_id,chat);
  },body(chat))));
  const failure=toolFailureDiagnostic({content:[],isError:true,structuredContent:{ok:false,data:{exit_code:1,timed_out:false,operation_started:true,outcome_kind:"execution_error",failure_step:"command_exit",original_error_code:"EIO",full_output_path:"fixture.log"}}});
  assert.equal(failure?.exit_code,1);assert.equal(failure?.timed_out,false);assert.equal(failure?.result_path,"fixture.log");
  for(const kind of ["running","unknown"] as const){
    identity.runWithMcpRequestIdentity({}, "status",()=> {
      outcomes.observeMcpToolResult({requestId:1,tool:"fixture",invocationId:kind,result:{content:[],structuredContent:{ok:true,data:{outcome_kind:kind}}}});
      assert.equal(outcomes.consumeMcpOutcome(1,"fixture")?.tool_result_status,kind);
    });
  }
  const connect=async()=>{
    const server=createMcpServer(workspace,10000,[workspace],false);
    const client=new Client({name:"v32-identity-fixture",version:"1"});
    const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
    return {server,client,close:async()=>{await client.close();await server.close();}};
  };
  const call=async(client:InstanceType<typeof Client>,chat:string,name:string,args:Record<string,unknown>)=>{
    const result=await client.callTool({name,arguments:args,_meta:{"openai/session":chat}});
    assert.notEqual(result.isError,true,JSON.stringify(result.structuredContent??result.content));
    return result.structuredContent as any;
  };
  let connection=await connect();
  let taskId:string;
  try {
    const created=await call(connection.client,"chat-a","task_state",{action:"create",goal:"中文目标"});
    taskId=created.data.handoff.task_id;
    await call(connection.client,"chat-a","goal",{action:"create",objective:"中文目标",success_criteria:["Save the result"]});
    const other=await call(connection.client,"chat-b","goal",{action:"status"});
    assert.equal(other.data.goal,null,"two conversations on one MCP transport cannot share a Goal");
    const tasks=await call(connection.client,"chat-b","task_state",{action:"list"});
    assert.equal(JSON.stringify(tasks.data).includes(taskId),false,"another conversation cannot list this task");
  } finally {await connection.close();}
  connection=await connect();
  try {
    const same=await call(connection.client,"chat-a","task_state",{action:"resume",task_id:taskId!});
    assert.equal(same.data.handoff.task_id,taskId!,"Task continuity survives a new MCP server/transport");
    const goal=await call(connection.client,"chat-a","goal",{action:"status"});
    assert.equal(goal.data.goal.objective,"中文目标","language and transport do not change identity");
    const other=await call(connection.client,"chat-b","goal",{action:"status"});
    assert.equal(other.data.goal,null);
  } finally {await connection.close();}
  console.log("PASS v3.2 trusted conversation reconnect, cross-chat isolation, original headers, concurrent RPC and truthful outcomes");
} finally {await fs.rm(fixture,{recursive:true,force:true});}
