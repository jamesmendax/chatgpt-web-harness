"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),vm=require("node:vm");
const {ConversationIndex}=require("../src/conversation-index");
const {formatActivity}=require("../src/feeds");
const context={window:{HarnessSim:{fmt:{hms:String,relative:String,duration:String}}}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../renderer/v3/core/core.js"),"utf8"),context);
const core=context.window.HarnessCore;
test("exit code, timeout, uncertainty and duplicate layers remain distinct",()=>{
 const canonical="[TOOL] [error] run_command — exit 1 31ms outcome=execution_error code=COMMAND_EXIT_NONZERO phase=execution started=true exit=1 timeout=false partial=true retry=inspect_original_result call=call-a";
 const transport="[MCP ERROR] HTTP 200 tools/call run_command — exit 1 33ms outcome=execution_error code=COMMAND_EXIT_NONZERO phase=execution started=true exit=1 timeout=false partial=true retry=inspect_original_result call=call-a";
 const rows=core.activityFromLogs([canonical,transport,
  "[TOOL] [unknown] run_command — result unavailable 40ms outcome=unknown started=true partial=true call=call-b",
  "[TOOL] [running] start_process — still active 50ms outcome=running call=call-c",
  "[MCP ERROR] HTTP 406 tools/call run_command — no correlated invocation 1ms",
 ].map(line=>core.parseLine("mcp",line)));
 assert.equal(rows.length,3);
 assert.equal(rows[0].exitCode,1);assert.equal(rows[0].timedOut,false);
 assert.equal(rows[0].mayHavePartiallyCompleted,true);assert.equal(rows[0].ms,31);
 assert.equal(rows[1].phase,"unknown");assert.equal(rows[1].ok,null);
 assert.equal(rows[2].phase,"running");assert.equal(rows[2].ok,null);
 const feed=formatActivity({time:new Date().toISOString(),kind:"tool",action:"tools/call",tool:"run_command",status:"error",duration_ms:31,details:{invocation_id:"call-d",outcome_kind:"execution_error",exit_code:1,timed_out:false,may_have_partially_completed:true}});
 const parsed=core.invocationFromLine(core.parseLine("mcp",feed).text);
 assert.equal(parsed.exitCode,1);assert.equal(parsed.timedOut,false);assert.equal(parsed.callId,"call-d");
});
test("legacy conversation index migration preserves original IDs and exact rollback bytes",t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"wh-v32-index-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id="oai_conv_"+"a".repeat(32),nextId="oai_conv_"+"b".repeat(32);
 const file=path.join(root,"acct","runtime","profiles","conversation-index.json");
 fs.mkdirSync(path.dirname(file),{recursive:true});
 const now=Date.now();
 const raw=JSON.stringify({schema:1,nextNumber:2,records:[{id,number:1,title:"历史任务",alias:"",pinned:true,createdAt:now,lastAt:now}]});
 fs.writeFileSync(file,raw);
 const index=new ConversationIndex({rootFor:account=>path.join(root,account)});
 assert.equal(index.lookup("acct",id).identitySource,"legacy-unknown");
 index.observe("acct",nextId,{hint:"New task",identitySource:"openai/session",identityVersion:2});
 const upgraded=JSON.parse(fs.readFileSync(file,"utf8"));
 assert.equal(upgraded.schema,2);assert.equal(upgraded.records.length,2);
 assert.equal(upgraded.records[0].originalId,id);
 assert.equal(fs.readFileSync(file+".v1.backup","utf8"),raw);
 assert.equal(index.lookup("acct",nextId).identitySource,"openai/session");
 assert.equal(index.list("another-account").length,0);
});
