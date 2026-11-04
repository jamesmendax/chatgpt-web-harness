/** Two real Node processes intentionally race one disposable Goal definition update against old Task completion. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createGoal,getGoal} from "../dist/lib/goals.js";
import {ensureGoalRunAuthority} from "../dist/lib/goal-run-web.js";
import {createDurableTask,getDurableTask} from "../dist/lib/durable-tasks.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"a11-goal-task-two-procs-"));
const keys=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED","HARNESS_COMPANION_ENABLED"];
const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const worker=fileURLToPath(new URL("./test-goal-task-crossprocess-child.mjs",import.meta.url));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checks=[];
const spawned=[];
const waitFile=async(file,label)=>{
  for(let i=0;i<300;i++){
    if(await fs.access(file).then(()=>true,()=>false))return;
    await sleep(20);
  }
  throw new Error("Fixture timeout: "+label);
};
const runChild=(mode,args)=>{
  const child=spawn(process.execPath,[worker,mode,...args],{cwd:path.dirname(worker),env:{...process.env},stdio:["ignore","pipe","pipe"],windowsHide:true});
  spawned.push(child);
  let out="",err="";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data",x=>{out+=x;});
  child.stderr.on("data",x=>{err+=x;});
  const result=new Promise((resolve,reject)=>{
    child.once("error",reject);
    child.once("exit",(code,signal)=>resolve({code,signal,out,err,pid:child.pid}));
  });
  return {child,result};
};
try{
  process.env.CODEX_HOME=path.join(tmp,"state");
  process.env.GOAL_WATCHDOG_ENABLED="false";
  process.env.HARNESS_RELAY_ENABLED="false";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
  process.env.HARNESS_COMPANION_ENABLED="false";
  const workspace=path.join(tmp,"workspace");
  await fs.mkdir(workspace,{recursive:true});
  const session="two-proc-owner";
  const owner=fn=>runWithRuntimeScope(
    createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:session}),fn);
  const goal=await owner(()=>createGoal(workspace,{
    objective:"User wants private offline output",
    success_criteria:[{name:"Private offline output verified",passed:false}],
    constraints:["No external upload"],
  }));
  await owner(()=>ensureGoalRunAuthority(workspace,goal));
  const task=await owner(()=>createDurableTask(workspace,{
    goal:"Old definition work with checks complete",
    blocking_checks:[{name:"Old scope verified",passed:true}],
  }));
  assert.ok(task.goal_definition_sha256,"new Task must bind material definition");
  const mutateReady=path.join(tmp,"mutator-ready");
  const mutateRelease=path.join(tmp,"mutator-release");
  const completeReady=path.join(tmp,"completer-ready");
  const mutator=runChild("mutate",[workspace,session,task.id,mutateReady,mutateRelease]);
  await waitFile(mutateReady,"mutator entered GoalRun commit under cross-process fence");
  checks.push("Mutator blocked at GoalRun commit with transaction still open");
  const completer=runChild("complete",[workspace,session,task.id,completeReady,mutateRelease]);
  await waitFile(completeReady,"second process began Task completion");
  await sleep(550);
  assert.equal(completer.child.exitCode,null,"Task completion raced past an in-progress Goal update");
  checks.push("Second process cannot complete old Task while first process owns Goal-definition commit fence");
  await fs.writeFile(mutateRelease,"RELEASE\n");
  const [mutation,completion]=await Promise.all([mutator.result,completer.result]);
  assert.equal(mutation.code,0,"Goal mutation child: "+mutation.err+" "+mutation.out);
  assert.equal(completion.code,0,"Task completion child: "+completion.err+" "+completion.out);
  const writeResult=JSON.parse(mutation.out.trim().split(/\r?\n/).at(-1));
  const taskResult=JSON.parse(completion.out.trim().split(/\r?\n/).at(-1));
  assert.equal(writeResult.ok,true);
  assert.equal(taskResult.result,"denied","old Task must be rejected after new Goal commits: "+JSON.stringify(taskResult));
  assert.match(taskResult.error,/TASK_GOAL_DEFINITION_CHANGED/);
  checks.push("Cross-process stale Task completion denied after serialized in-place Goal commit");
  const finalGoal=await owner(()=>getGoal(workspace));
  const finalTask=await owner(()=>getDurableTask(workspace,task.id));
  assert.equal(finalGoal.revision,goal.revision+1);
  assert.equal(finalGoal.id,goal.id);
  assert.equal(finalTask.status,"active");
  assert.equal(finalTask.goal_definition_sha256,task.goal_definition_sha256);
  checks.push("Persisted Goal and Task identity/state are coherent after racing child exits");
  console.log("A1.1 cross-process Goal/Task race PASS:",checks.length,"groups");
  for(const c of checks) console.log(" PASS",c);
}finally{
  for(const child of spawned){
    if(child.exitCode===null && child.signalCode===null)child.kill();
  }
  for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;
  await fs.rm(tmp,{recursive:true,force:true});
}
