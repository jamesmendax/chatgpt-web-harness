import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { RecoveryFault, recoverTask, readRecoveryTask, clearRecoveryWait } from "../dist/lib/recovery-engine.js";
import { recoveryFixturePaths, writeRecoveryPlanFixture } from "./lib/recovery-plan-fixture.mjs";

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const root=await fs.mkdtemp(path.join(os.tmpdir(),"recovery-boundaries-"));
const workspace=path.join(root,"workspace"),stateRoot=path.join(root,"state"),artifactRoot=path.join(root,"artifacts"),plansDir=path.join(stateRoot,"plans");
await Promise.all([workspace,plansDir,artifactRoot,path.join(workspace,"nested")].map(p=>fs.mkdir(p,{recursive:true})));
const rows=[];
async function check(name,fn){try{await fn();rows.push({name,passed:true});}catch(error){rows.push({name,passed:false,error:error.message});}}
async function readJson(file){try{return JSON.parse(await fs.readFile(file,"utf8"));}catch{return null;}}
async function waitFor(fn,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,70));}throw new Error("fixture observation timed out");}

await check("unknown outcome overrides a safe replay declaration",async()=>{
 let calls=0;
 const result=await recoverTask({workspaceRoot:path.join(root,"engine-unknown"),taskId:"unknown",maxAutomaticRecoveries:1,
 plan:{steps:[{id:"one",operation_id:"unknown-op",replay_policy:"safe"}]},
 executor:async()=>{calls++;throw new RecoveryFault("stream_disconnected",{disposition:"retry",sideEffect:"unknown"});}});
 assert.equal(calls,1,"unknown-result executor must never be replayed");
 assert.equal(result.action,"blocked");
 assert.equal(result.state.failure_reason,"unknown_side_effect_result");
});
await check("duplicate operation identities are rejected before execution",async()=>{
 let calls=0,rejected=false;
 try{await recoverTask({workspaceRoot:path.join(root,"engine-duplicate"),taskId:"duplicate",
 plan:{steps:[{id:"one",operation_id:"same-op",replay_policy:"safe"},{id:"two",operation_id:"same-op",replay_policy:"safe"}]},
 executor:async()=>{calls++;return{ok:true};}});}catch(e){rejected=/OPERATION_ID_DUPLICATE/.test(e.message);}
 assert.equal(rejected,true);assert.equal(calls,0);
});

await check("recovery budgets persist across separate wait/resume calls",async()=>{
 let calls=0;
 const recoveryWorkspace=path.join(root,"engine-cumulative");
 const options={workspaceRoot:recoveryWorkspace,taskId:"cumulative",maxAutomaticRecoveries:1,
  plan:{steps:[{id:"one",operation_id:"cumulative-op",replay_policy:"safe"}]},
  executor:async()=>{calls++;throw new RecoveryFault(calls===2?"approval_pending":"timeout");}};
 const first=await recoverTask(options);
 assert.equal(first.action,"waiting");assert.equal(first.state.recovery_count,1);assert.equal(calls,2);
 assert.equal((await clearRecoveryWait(recoveryWorkspace,"cumulative")).action,"cleared");
 const second=await recoverTask(options);
 assert.equal(second.action,"blocked");assert.equal(second.state.recovery_count,1);assert.equal(calls,3);
 assert.equal(second.state.failure_reason,"automatic_recovery_limit_exceeded");
});

const worker=spawn(process.execPath,[path.join(source,"scripts","service-recovery-worker.mjs"),"--workspace",workspace,"--state-root",stateRoot,"--artifact-root",artifactRoot,"--host-token","isolated-boundary-test"],{cwd:source,windowsHide:true,env:process.env,stdio:["ignore","pipe","pipe"]});
let stderr="";worker.stderr.on("data",b=>{stderr+=b;});worker.stdout.resume();
const goalId="recovery-boundaries-goal";
const scopedPaths=id=>recoveryFixturePaths({stateRoot,artifactRoot,goalId,taskId:id});
const taskRoot=id=>scopedPaths(id).taskRoot;
async function publish(id,step,overrides={}){
 const plan={task_id:id,lease_ms:250,max_automatic_recoveries:2,steps:[{id:"step",operation_id:id+"-op",replay_policy:"safe",action:step}],...overrides};
 return (await writeRecoveryPlanFixture({stateRoot,artifactRoot,workspaceRoot:workspace,goalId,plan})).plan;
}
async function observed(id,after=0){
 return waitFor(async()=>{const status=await readJson(path.join(stateRoot,"worker-status.json"));if(Date.parse(status?.heartbeat_at||"")<after)return false;const entry=status?.summaries?.find(x=>x.goal_id===goalId&&x.task_id===id);return entry?{entry,state:await readRecoveryTask(taskRoot(id),id)}:false;});
}
try{
 await waitFor(()=>readJson(path.join(stateRoot,"worker-status.json")));
 await check("zero recovery budget is preserved by the worker",async()=>{
  await publish("zero-budget",{kind:"fault_sequence",faults:["timeout"]},{max_automatic_recoveries:0});
  const result=await observed("zero-budget");assert.equal(result.state?.status,"blocked");assert.equal(result.state.steps[0].attempts.length,1);
 });
 await check("an ancestor cannot widen the admitted workspace",async()=>{
  await publish("ancestor",{kind:"command",command:"echo unauthorized > ancestor-effect.txt",cwd:root,side_effect:"none"},{workspace_root:root});
  const result=await observed("ancestor");assert.equal(result.entry.action,"worker_error");assert.match(result.entry.error,/WORKSPACE_MISMATCH/);
  assert.equal(await fs.access(path.join(root,"ancestor-effect.txt")).then(()=>true,()=>false),false);
 });
 await check("artifact paths stay inside the configured artifact root",async()=>{
  await publish("artifact-escape",{kind:"append",text:"outside"},{artifact_root:path.join(root,"outside-artifacts")});
  const result=await observed("artifact-escape");assert.equal(result.entry.action,"worker_error");assert.match(result.entry.error,/ARTIFACT/);
  assert.equal(await fs.access(path.join(root,"outside-artifacts","effects.log")).then(()=>true,()=>false),false);
 });
 await check("a subworkspace is the default command working directory",async()=>{
  await publish("subworkspace",{kind:"command",command:"echo nested-ok",side_effect:"none"},{workspace_root:path.join(workspace,"nested")});
  const result=await observed("subworkspace");assert.equal(result.state?.status,"completed");
 });
 await check("unknown actions cannot produce successful receipts",async()=>{
  await publish("unknown-action",{kind:"misspelled_command"});
  const result=await observed("unknown-action");assert.equal(result.state?.status,"blocked");assert.match(result.state.failure_reason,/unsupported_action/);
 });
 await check("Windows-valid operation IDs use safe state filenames",async()=>{
  await publish("colon-identity",{kind:"fault_sequence",faults:["timeout"]},{steps:[{id:"step",operation_id:"native:phase:operation",replay_policy:"safe",action:{kind:"fault_sequence",faults:["timeout"]}}]});
  const result=await observed("colon-identity");assert.equal(result.state?.status,"completed");assert.equal(result.state.steps[0].attempts.length,2);
 });
 await check("workspace changes cannot reuse a completed receipt",async()=>{
  const p=await publish("workspace-drift",{kind:"append",text:"once"},{workspace_root:workspace});
  const result=await observed("workspace-drift");assert.equal(result.state?.status,"completed");
  const changedAt=Date.now();p.workspace_root=path.join(workspace,"nested");await fs.writeFile(scopedPaths("workspace-drift").planPath,JSON.stringify(p));
  const changed=await observed("workspace-drift",changedAt+20);assert.equal(changed.entry.action,"worker_error");assert.match(changed.entry.error,/PLAN_MISMATCH/);
  const effects=(await fs.readFile(path.join(taskRoot("workspace-drift"),"effects.log"),"utf8")).trim().split(/\r?\n/);assert.equal(effects.length,1);
 });
}finally{
 if(worker.exitCode===null){worker.kill("SIGTERM");await Promise.race([new Promise(r=>worker.once("close",r)),new Promise(r=>setTimeout(r,2000))]);}
 if(worker.exitCode===null)worker.kill("SIGKILL");
}
const report={test:"recovery-execution-boundaries",status:rows.every(x=>x.passed)?"PASS":"FAIL",root,rows,stderr_tail:stderr.slice(-1500)};
console.log(JSON.stringify(report,null,2));
if(report.status!=="PASS")process.exitCode=1;
