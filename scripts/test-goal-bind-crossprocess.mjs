/** A1.1 WP9: real two-owner Goal bind, Task completion race, interrupted Task migration journal. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createGoal, bindGoalToSession, getGoal} from "../dist/lib/goals.js";
import {createDurableTask,getDurableTask,getActiveTaskId,completeDurableTask,runWithActiveDurableTaskSessionRebind,recoverGoalTaskSessionRebind} from "../dist/lib/durable-tasks.js";
import {ensureGoalRunAuthority} from "../dist/lib/goal-run-web.js";
import {readGoalRun} from "../dist/lib/goal-run-store.js";
import {withGoalTaskDefinitionFences} from "../dist/lib/goal-state-store.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const sourceFile=fileURLToPath(import.meta.url);
const delay=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=(p)=>fs.access(p).then(()=>true,()=>false);
const inSession=(workspace,session,fn)=>runWithRuntimeScope(
  createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:session}),fn);
async function child([mode,workspace,from,to,goalId,taskId,ready,release]){
  const tmpPrefix=path.resolve(os.tmpdir()).toLowerCase()+path.sep;
  if(!["bind","crash","complete","recover","hold","reverse","inspect"].includes(mode)||
      !path.resolve(workspace||"").toLowerCase().startsWith(tmpPrefix)||
      !process.env.CODEX_HOME||!path.resolve(process.env.CODEX_HOME).toLowerCase().startsWith(tmpPrefix)){
    throw new Error("WP9 test child refuses non-temporary resources");
  }
  const awaitRelease=async()=>{
    for(let i=0;i<275;i++){if(await exists(release))return;await delay(20);}
    throw new Error("WP9_CHILD_RELEASE_TIMEOUT");
  };
  if(mode==="complete"){
    await fs.writeFile(ready,"STARTED\n");
    try{
      const task=await inSession(workspace,from,()=>completeDurableTask(workspace,taskId));
      console.log(JSON.stringify({mode,result:"completed",task_id:task.id}));
    }catch(e){console.log(JSON.stringify({mode,result:"denied",error:String(e?.message||e).slice(0,600)}));}
    return;
  }
  if(mode==="inspect"){
    // A *fresh* process observes the durable pointer, unlike this parent's
    // process-local activeTaskCache created before the ownership migration.
    console.log(JSON.stringify({mode,
      source_pointer:await getActiveTaskId(workspace,from),
      target_pointer:await getActiveTaskId(workspace,to)}));
    return;
  }
  if(mode==="recover"){
    const goal=await inSession(workspace,to,()=>bindGoalToSession(workspace,{expectedGoalId:goalId}));
    const rebound=await inSession(workspace,to,()=>recoverGoalTaskSessionRebind(workspace,goalId,to));
    console.log(JSON.stringify({mode,goal_id:goal.id,owner:goal.owner_session,rebound}));
    return;
  }
  if(mode==="hold"||mode==="reverse"){
    const order=mode==="hold"?[from,to]:[to,from];
    await inSession(workspace,to,()=>withGoalTaskDefinitionFences(workspace,order,async()=>{
      await fs.writeFile(ready,"LOCKED\n");
      if(mode==="hold")await awaitRelease();
    }));
    console.log(JSON.stringify({mode,result:"released"}));
    return;
  }
  const realRename=fs.rename;
  let triggered=false;
  fs.rename=async(src,dst)=>{
    const dest=String(dst).toLowerCase();
    if(!triggered&&mode==="bind"&&dest.includes("goal-bind-transactions")&&
        path.basename(dest)===goalId.toLowerCase()+".json"){
      const record=JSON.parse(await fs.readFile(src,"utf8"));
      if(record.phase==="prepared"){
        triggered=true;
        await fs.writeFile(ready,"BIND_PREPARED\n");
        await awaitRelease();
      }
    }
    if(!triggered&&mode==="crash"&&path.basename(dest)==="goal.json"&&
        dest.includes(path.sep+"sessions"+path.sep+to.toLowerCase()+path.sep)){
      const record=JSON.parse(await fs.readFile(src,"utf8"));
      if(record.id===goalId&&record.owner_session===to){
        triggered=true;
        await realRename(src,dst);
        await fs.writeFile(ready,"TARGET_GOAL_WRITTEN\n");
        process.exit(77); // deliberate abrupt test child exit, no lock release
      }
    }
    return realRename(src,dst);
  };
  try{
    const result=await inSession(workspace,to,()=>runWithActiveDurableTaskSessionRebind(
      workspace,from,to,
      ()=>bindGoalToSession(workspace,{expectedRevision:1,expectedGoalId:goalId,sourceSessionId:from}),
      goalId
    ));
    if(!triggered)throw new Error("WP9_BIND_BARRIER_NOT_REACHED");
    console.log(JSON.stringify({mode,result:"bound",goal_id:result.value.id,task_id:result.durable_task_rebind?.task_id}));
  }finally{fs.rename=realRename;}
}
async function main(){
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"a11-wp9-two-owner-"));
  const keys=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED","HARNESS_COMPANION_ENABLED"];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const children=[],checks=[];
  const start=(mode,w,from,to,goalId,taskId,ready,release)=>{
    const c=spawn(process.execPath,[sourceFile,"child",mode,w,from,to,goalId,taskId,ready||"",release||""],
      {cwd:path.dirname(sourceFile),env:{...process.env},windowsHide:true,stdio:["ignore","pipe","pipe"]});
    children.push(c);
    let stdout="",stderr="";
    c.stdout.setEncoding("utf8");c.stderr.setEncoding("utf8");
    c.stdout.on("data",x=>stdout+=x);c.stderr.on("data",x=>stderr+=x);
    const done=new Promise((resolve,reject)=>{c.once("error",reject);c.once("exit",(code,signal)=>resolve({code,signal,stdout,stderr}));});
    return {c,done,show:()=>({pid:c.pid,exit:c.exitCode,stdout,stderr})};
  };
  const marker=async(file,what,proc)=>{
    for(let i=0;i<245;i++){
      if(await exists(file))return;
      if(proc.c.exitCode!==null)throw new Error("WP9_EARLY_CHILD_EXIT "+what+" "+JSON.stringify(proc.show()));
      await delay(20);
    }
    throw new Error("WP9_MARKER_TIMEOUT "+what+" "+JSON.stringify(proc.show()));
  };
  const value=(r)=>JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
  const setup=async(w,from,label)=>{
    await fs.mkdir(w,{recursive:true});
    const goal=await inSession(w,from,()=>createGoal(w,{
      objective:"Original Goal "+label,success_criteria:[{name:"Original Goal "+label+" verified",passed:false}]
    }));
    assert.equal(goal.revision,1);
    await inSession(w,from,()=>ensureGoalRunAuthority(w,goal));
    const task=await inSession(w,from,()=>createDurableTask(w,{
      goal:"Old Task "+label,blocking_checks:[{name:"Original checks",passed:true}]
    }));
    assert.ok(task.goal_definition_sha256);
    assert.equal(task.owner_session,from);
    return {goal,task};
  };
  try{
    process.env.CODEX_HOME=path.join(tmp,"isolated-code-home");
    process.env.GOAL_WATCHDOG_ENABLED="false";
    process.env.HARNESS_RELAY_ENABLED="false";
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
    process.env.HARNESS_COMPANION_ENABLED="false";
    const from="wp9-source",to="wp9-target";
    const w1=path.join(tmp,"race-workspace");
    const a=await setup(w1,from,"race");
    const prepared=path.join(tmp,"bind-prepared");
    const release=path.join(tmp,"bind-release");
    const completionStarted=path.join(tmp,"task-completion-started");
    const binder=start("bind",w1,from,to,a.goal.id,a.task.id,prepared,release);
    await marker(prepared,"prepared bind journal",binder);
    checks.push("Real bind process holds the source/destination fence at prepared journal");

    const completer=start("complete",w1,from,to,a.goal.id,a.task.id,completionStarted,release);
    await marker(completionStarted,"source Task completion started",completer);
    await delay(390);
    assert.equal(completer.c.exitCode,null,
      "Old source Task completed before binding: "+JSON.stringify(completer.show()));
    checks.push("Other Node process cannot complete the old source Task during bind");

    await fs.writeFile(release,"RELEASE\n");
    const [bound,completion]=await Promise.all([binder.done,completer.done]);
    assert.equal(bound.code,0,"Bind child failed: "+JSON.stringify(bound));
    assert.equal(completion.code,0,"Completion child failed: "+JSON.stringify(completion));
    assert.equal(value(bound).result,"bound");
    assert.equal(value(completion).result,"denied",completion.stdout);
    const goal1=await inSession(w1,to,()=>getGoal(w1));
    const task1=await inSession(w1,to,()=>getDurableTask(w1,a.task.id));
    const run1=await inSession(w1,to,()=>readGoalRun(w1));
    assert.equal(goal1.id,a.goal.id);
    assert.equal(goal1.owner_session,to);
    assert.equal(run1.run.runId,a.goal.id);
    assert.equal(task1.status,"active");
    assert.equal(task1.owner_session,to);
    const fresh1=await start("inspect",w1,from,to,a.goal.id,a.task.id,"","").done;
    assert.equal(fresh1.code,0,JSON.stringify(fresh1));
    assert.equal(value(fresh1).source_pointer,null);
    assert.equal(value(fresh1).target_pointer,a.task.id);
    checks.push("Old Task denied after bind; Goal/GoalRun/Task owner and pointers match");

    const w2=path.join(tmp,"crash-workspace");
    const d=await setup(w2,from,"crash");
    const crashReady=path.join(tmp,"crash-target-goal-written");
    const crashing=start("crash",w2,from,to,d.goal.id,d.task.id,crashReady,"");
    const crashed=await crashing.done;
    assert.equal(crashed.code,77,"Expected exit77 after target Goal: "+JSON.stringify(crashed));
    await marker(crashReady,"target Goal written before Task migration",crashing);
    assert.equal((await inSession(w2,from,()=>getDurableTask(w2,d.task.id))).owner_session,from);
    checks.push("Abrupt bind exit left original Task on source after target Goal published");

    const recovering=start("recover",w2,from,to,d.goal.id,d.task.id,"","");
    const recovered=await recovering.done;
    assert.equal(recovered.code,0,"Fresh child recovery failed: "+JSON.stringify(recovered));
    assert.equal(value(recovered).goal_id,d.goal.id);
    assert.equal(value(recovered).rebound.migrated,true);
    const goal2=await inSession(w2,to,()=>getGoal(w2));
    const run2=await inSession(w2,to,()=>readGoalRun(w2));
    const task2=await inSession(w2,to,()=>getDurableTask(w2,d.task.id));
    assert.equal(goal2.id,d.goal.id);
    assert.equal(goal2.owner_session,to);
    assert.equal(run2.run.runId,d.goal.id);
    assert.equal(task2.owner_session,to);
    const fresh2=await start("inspect",w2,from,to,d.goal.id,d.task.id,"","").done;
    assert.equal(fresh2.code,0,JSON.stringify(fresh2));
    assert.equal(value(fresh2).source_pointer,null);
    assert.equal(value(fresh2).target_pointer,d.task.id);
    checks.push("Fresh child reclaims dead-owner locks and replays exact Task bind journal");

    const repeated=start("recover",w2,from,to,d.goal.id,d.task.id,"","");
    const again=await repeated.done;
    assert.equal(again.code,0,JSON.stringify(again));
    assert.equal(value(again).rebound.migrated,false);
    assert.equal((await inSession(w2,to,()=>getGoal(w2))).id,d.goal.id);
    checks.push("Bind recovery is idempotent without duplicating Goal/Task");

    const w3=path.join(tmp,"ordered-workspace");
    await fs.mkdir(w3,{recursive:true});
    const readyA=path.join(tmp,"ordered-holder");
    const readyB=path.join(tmp,"ordered-reverse");
    const releaseA=path.join(tmp,"ordered-release");
    const holder=start("hold",w3,from,to,"-","-",readyA,releaseA);
    await marker(readyA,"ordered lock holder",holder);
    const reverse=start("reverse",w3,from,to,"-","-",readyB,releaseA);
    await delay(300);
    assert.equal(await exists(readyB),false,"Reverse lock order bypassed held source/dest pair");
    assert.equal(reverse.c.exitCode,null);
    await fs.writeFile(releaseA,"RELEASE\n");
    const [h,r]=await Promise.all([holder.done,reverse.done]);
    assert.equal(h.code,0,JSON.stringify(h));
    assert.equal(r.code,0,JSON.stringify(r));
    checks.push("Reverse source/destination lock ordering completes without AB/BA deadlock");

    console.log("A1.1 WP9 Goal bind multi-process PASS:",checks.length,"groups");
    for(const check of checks)console.log(" PASS",check);
  }finally{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill();
    for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;
    await fs.rm(tmp,{recursive:true,force:true});
  }
}
if(process.argv[2]==="child") await child(process.argv.slice(3)); else await main();
