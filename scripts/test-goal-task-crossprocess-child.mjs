/** Independent subprocess for deterministic A1.1 Goal-update/Task-completion race. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getGoal } from "../dist/lib/goals.js";
import { updateGoalRunDefinition } from "../dist/lib/goal-run-web.js";
import { completeDurableTask } from "../dist/lib/durable-tasks.js";
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";

const [mode,workspace,session,taskId,readyFile,releaseFile] = process.argv.slice(2);
if (!["mutate","complete"].includes(mode) || !path.resolve(workspace||"").toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()+path.sep)) {
  throw new Error("Cross-process fixture requires an OS-temp workspace and recognized mode.");
}
if (!process.env.CODEX_HOME || !path.resolve(process.env.CODEX_HOME).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()+path.sep)) {
  throw new Error("Fixture requires isolated temp CODEX_HOME.");
}
const owner=fn=>runWithRuntimeScope(
  createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:session}),fn);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=async(file)=>fs.access(file).then(()=>true,()=>false);

if(mode==="mutate"){
  const originalRename=fs.rename;
  let intercepted=false;
  fs.rename=async(source,target)=>{
    if(!intercepted && path.basename(String(target)).toLowerCase()==="goal-run.json"){
      intercepted=true;
      await fs.writeFile(readyFile,"READY\n");
      for(let n=0;n<300;n++){
        if(await exists(releaseFile)) break;
        await sleep(20);
      }
      if(!(await exists(releaseFile))) throw new Error("RACE_FIXTURE_RELEASE_TIMEOUT");
    }
    return originalRename(source,target);
  };
  try{
    const goal=await owner(()=>getGoal(workspace));
    const updated=await owner(()=>updateGoalRunDefinition(workspace,{
      objective:"After request revision, users want private plus strictly offline output",
    },goal.revision));
    if(!intercepted) throw new Error("RACE_FIXTURE_DID_NOT_REACH_GOALRUN_COMMIT");
    console.log(JSON.stringify({mode,ok:true,goal_id:updated.goal.id,revision:updated.goal.revision}));
  }finally{fs.rename=originalRename;}
}else{
  await fs.writeFile(readyFile,"STARTED\n");
  try{
    const task=await owner(()=>completeDurableTask(workspace,taskId));
    console.log(JSON.stringify({mode,result:"completed",task_id:task.id}));
  }catch(e){
    console.log(JSON.stringify({mode,result:"denied",error:String(e?.message||e).slice(0,700)}));
  }
}
