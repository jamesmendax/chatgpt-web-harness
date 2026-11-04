/** A1.1 WP10: a live parent process must not trust stale active Task pointers after another Node binds Goal. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {createGoal,bindGoalToSession,getGoal} from "../dist/lib/goals.js";
import {ensureGoalRunAuthority} from "../dist/lib/goal-run-web.js";
import {createDurableTask,durableTaskDir,getActiveTaskId,getDurableTask,runWithActiveDurableTaskSessionRebind} from "../dist/lib/durable-tasks.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const self=fileURLToPath(import.meta.url);
const inSession=(w,s,fn)=>runWithRuntimeScope(
  createRuntimeScope({workspaceRoot:w,projectRoots:[w]},{sessionId:s}),fn);
const underTemp=(p)=>typeof p==="string" && path.resolve(p).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()+path.sep);
if(process.argv[2]==="child"){
  const [w,from,to,goalId]=process.argv.slice(3);
  if(!underTemp(w)||!underTemp(process.env.CODEX_HOME))throw new Error("WP10 refuses non-temporary workspace/CODEX_HOME");
  const result=await inSession(w,to,()=>runWithActiveDurableTaskSessionRebind(w,from,to,
    ()=>bindGoalToSession(w,{expectedRevision:1,expectedGoalId:goalId,sourceSessionId:from}),goalId));
  console.log(JSON.stringify({goal:result.value.id,task:result.durable_task_rebind.task_id,owner:result.value.owner_session}));
}else{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"a11-wp10-task-pointer-"));
  const keys=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED","HARNESS_COMPANION_ENABLED"];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const checks=[];
  try{
    process.env.CODEX_HOME=path.join(root,"state");
    process.env.GOAL_WATCHDOG_ENABLED="false";
    process.env.HARNESS_RELAY_ENABLED="false";
    process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
    process.env.HARNESS_COMPANION_ENABLED="false";
    const w=path.join(root,"bind-workspace");
    const from="wp10-source",to="wp10-target";
    await fs.mkdir(w,{recursive:true});
    const g=await inSession(w,from,()=>createGoal(w,{
      objective:"Create a verified local-only report",
      success_criteria:[{name:"Local report checked",passed:false}],
      constraints:["Do not upload"],
    }));
    assert.equal(g.revision,1);
    await inSession(w,from,()=>ensureGoalRunAuthority(w,g));
    const task=await inSession(w,from,()=>createDurableTask(w,{
      goal:"Prepare report",blocking_checks:[{name:"Report checked",passed:true}],
    }));
    assert.equal(await getActiveTaskId(w,from),task.id); // cache positive in parent
    assert.equal(await getActiveTaskId(w,to),null); // cache negative in parent
    checks.push("Parent process cached source Task and empty destination before bind");

    const child=spawn(process.execPath,[self,"child",w,from,to,g.id],
      {cwd:path.dirname(self),env:{...process.env},stdio:["ignore","pipe","pipe"],windowsHide:true});
    let output="",errors="";
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");
    child.stdout.on("data",s=>output+=s);
    child.stderr.on("data",s=>errors+=s);
    const code=await new Promise((resolve,reject)=>{
      child.once("error",reject);child.once("exit",(exitCode)=>resolve(exitCode));
    });
    assert.equal(code,0,"bind child failed: "+errors+" "+output);
    const migrated=JSON.parse(output.trim().split(/\r?\n/).at(-1));
    assert.equal(migrated.task,task.id);
    assert.equal(migrated.goal,g.id);
    assert.equal(migrated.owner,to);
    checks.push("Independent Node completed exact Goal/Task bind and exited");

    assert.equal(await getActiveTaskId(w,from),null,
      "Source's old process must not return its stale cached Task after another process migrated it");
    assert.equal(await getActiveTaskId(w,to),task.id,
      "Destination's old process must not persist a stale cached null after another process bound Task");
    assert.equal((await inSession(w,to,()=>getGoal(w))).id,g.id);
    assert.equal((await inSession(w,to,()=>getDurableTask(w,task.id))).owner_session,to);
    checks.push("Same original process observes source removal and destination creation from durable pointers");

    const expiredWorkspace=path.join(root,"expired-workspace");
    const taskDir=durableTaskDir(expiredWorkspace);
    await fs.mkdir(taskDir,{recursive:true});
    const staleFile=path.join(taskDir,"active-task.json");
    await fs.writeFile(staleFile,JSON.stringify({
      task_id:"11111111-1111-4111-8111-111111111111",updated_at:"2000-01-01T00:00:00.000Z"
    })+"\n");
    assert.equal(await getActiveTaskId(expiredWorkspace),null);
    assert.equal(await fs.access(staleFile).then(()=>true,()=>false),false);
    checks.push("Existing TTL expiration still rejects/removes stale persisted pointer");

    console.log("A1.1 WP10 active Task pointer coherence PASS:",checks.length,"groups");
    for(const check of checks)console.log(" PASS",check);
  }finally{
    for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    await fs.rm(root,{recursive:true,force:true});
  }
}
