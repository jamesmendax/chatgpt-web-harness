/** WP8 actual two-process replacement race + dead-writer journal recovery. No live files touched. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createGoal,getGoal} from "../dist/lib/goals.js";
import {ensureGoalRunAuthority} from "../dist/lib/goal-run-web.js";
import {readGoalRun} from "../dist/lib/goal-run-store.js";
import {createDurableTask,getDurableTask} from "../dist/lib/durable-tasks.js";
import {goalCreationJournalPath} from "../dist/lib/goal-state-store.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const temp=await fs.mkdtemp(path.join(os.tmpdir(),"a11-wp8-replace-crash-"));
const envKeys=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED","HARNESS_COMPANION_ENABLED"];
const prev=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
const worker=fileURLToPath(new URL("./test-goal-replacement-race-child.mjs",import.meta.url));
const checks=[],children=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const wait=async(file,label)=>{
  for(let i=0;i<230;i++){if(await fs.access(file).then(()=>true,()=>false))return;await sleep(20);}
  throw new Error("WP8_TEST_BARRIER_TIMEOUT: "+label);
};
const spawnChild=(mode,workspace,session,task,ready,release)=>{
  const child=spawn(process.execPath,[worker,mode,workspace,session,task||"",ready||"",release||""],
    {cwd:path.dirname(worker),env:{...process.env},stdio:["ignore","pipe","pipe"],windowsHide:true});
  children.push(child);
  let out="",err="";
  child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
  child.stdout.on("data",s=>out+=s);child.stderr.on("data",s=>err+=s);
  const done=new Promise((resolve,reject)=>{child.once("error",reject);
    child.once("exit",(code,signal)=>resolve({code,signal,out,err,pid:child.pid}));});
  return {child,done};
};
const parseResult=x=>JSON.parse(x.out.trim().split(/\r?\n/).at(-1));
const setup=async(workspace,session,label)=>{
  await fs.mkdir(workspace,{recursive:true});
  const owner=fn=>runWithRuntimeScope(createRuntimeScope(
    {workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:session}),fn);
  const goal=await owner(()=>createGoal(workspace,{
    objective:"Original "+label, success_criteria:[{name:"Original "+label+" tested",passed:false}]
  }));
  await owner(()=>ensureGoalRunAuthority(workspace,goal));
  const task=await owner(()=>createDurableTask(workspace,{
    goal:"Old Task for "+label,blocking_checks:[{name:"Old output meets original goal",passed:true}]
  }));
  return {goal,task,owner};
};
try{
  process.env.CODEX_HOME=path.join(temp,"isolated-state");
  process.env.GOAL_WATCHDOG_ENABLED="false";
  process.env.HARNESS_RELAY_ENABLED="false";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
  process.env.HARNESS_COMPANION_ENABLED="false";

  const session="wp8-owner";
  const w1=path.join(temp,"race-workspace");
  const a=await setup(w1,session,"race");
  const ready1=path.join(temp,"replacement-ready");
  const released=path.join(temp,"release-replacement");
  const ready2=path.join(temp,"completion-started");
  const replacer=spawnChild("replace",w1,session,a.task.id,ready1,released);
  await wait(ready1,"replacement journal prepared boundary");
  checks.push("First process paused at real Goal creation journal publication");

  const completer=spawnChild("complete",w1,session,a.task.id,ready2,released);
  await wait(ready2,"second process Task completion entered");
  await sleep(450);
  assert.equal(completer.child.exitCode,null,
    "Task completion overtook replacement before new Goal journal committed");
  checks.push("Concurrent old Task completion blocked while replacement holds cross-process fence");

  await fs.writeFile(released,"RELEASE\n");
  const [r1,r2]=await Promise.all([replacer.done,completer.done]);
  assert.equal(r1.code,0,"replacement child: "+r1.err+" "+r1.out);
  assert.equal(r2.code,0,"completion child: "+r2.err+" "+r2.out);
  assert.equal(parseResult(r2).result,"denied",r2.out);
  assert.match(parseResult(r2).error,/already cancelled|TASK_GOAL_MISMATCH|TASK_GOAL_STALE|TASK_GOAL_CANCELLED/i);
  const newGoal=await a.owner(()=>getGoal(w1));
  const task=await a.owner(()=>getDurableTask(w1,a.task.id));
  const run=await a.owner(()=>readGoalRun(w1));
  assert.notEqual(newGoal.id,a.goal.id);
  assert.equal(run.run.runId,newGoal.id);
  assert.equal(task.status,"cancelled");
  checks.push("Old Task denied after replacement and persisted Goal/GoalRun identity coherent");

  const w2=path.join(temp,"crash-workspace");
  const d=await setup(w2,session,"crash");
  const crashReady=path.join(temp,"crash-written");
  const crash=spawnChild("crash",w2,session,d.task.id,crashReady,"");
  const crashed=await crash.done;
  assert.equal(crashed.code,77,"expected deliberate abrupt exit after durable archived journal: "+crashed.err);
  await wait(crashReady,"crash marker");
  const pending=JSON.parse(await fs.readFile(goalCreationJournalPath(w2,session),"utf8"));
  assert.equal(pending.phase,"archived");
  assert.equal((await d.owner(()=>getDurableTask(w2,d.task.id))).status,"active");
  checks.push("Independent process died after archived Goal journal, before old Task cancellation");

  const resume=spawnChild("recover",w2,session,d.task.id,"","");
  const recovered=await resume.done;
  assert.equal(recovered.code,0,"dead-owner lock/journal recovery: "+recovered.err+" "+recovered.out);
  assert.equal(parseResult(recovered).id,pending.new_goal.id);
  const resumedGoal=await d.owner(()=>getGoal(w2));
  const resumedTask=await d.owner(()=>getDurableTask(w2,d.task.id));
  const resumedRun=await d.owner(()=>readGoalRun(w2));
  const finalJournal=JSON.parse(await fs.readFile(goalCreationJournalPath(w2,session),"utf8"));
  assert.equal(resumedGoal.id,pending.new_goal.id);
  assert.equal(resumedRun.run.runId,resumedGoal.id);
  assert.equal(resumedTask.status,"cancelled");
  assert.equal(finalJournal.phase,"committed");
  checks.push("Fresh process reclaimed dead PID lock, reconciled exact pending Goal, cancelled old Task");

  const again=spawnChild("recover",w2,session,d.task.id,"","");
  const twice=await again.done;
  assert.equal(twice.code,0,twice.err);
  assert.equal(parseResult(twice).id,null);
  assert.equal((await d.owner(()=>getGoal(w2))).id,resumedGoal.id);
  checks.push("Repeated recovery idempotent: no new Goal identity and no stale completion");

  console.log("A1.1 WP8 replacement + crash PASS:",checks.length,"groups");
  for(const c of checks)console.log(" PASS",c);
}finally{
  for(const child of children){if(child.exitCode===null&&child.signalCode===null)child.kill();}
  for(const [k,v]of Object.entries(prev)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await fs.rm(temp,{recursive:true,force:true});
}
