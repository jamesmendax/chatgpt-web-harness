/** WP8 independent test child. Only temporary isolated Goal/Task fixtures allowed. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {createGoal,recoverGoalCreation} from "../dist/lib/goals.js";
import {completeDurableTask} from "../dist/lib/durable-tasks.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const [mode,workspace,session,taskId,readyFile,releaseFile]=process.argv.slice(2);
const tmp=path.resolve(os.tmpdir()).toLowerCase()+path.sep;
if(!["replace","complete","crash","recover"].includes(mode) ||
   !path.resolve(workspace||"").toLowerCase().startsWith(tmp) ||
   !process.env.CODEX_HOME || !path.resolve(process.env.CODEX_HOME).toLowerCase().startsWith(tmp)) {
  throw new Error("WP8 test child rejects anything outside the OS temporary fixture.");
}
const owner=(fn)=>runWithRuntimeScope(createRuntimeScope(
 {workspaceRoot:workspace,projectRoots:[workspace]}, {sessionId:session}),fn);
const input=(label)=>({objective:label,success_criteria:[{name:label+" checked",passed:false}]});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=async(file)=>fs.access(file).then(()=>true,()=>false);
if(mode==="complete"){
  await fs.writeFile(readyFile,"STARTED\n");
  try{const t=await owner(()=>completeDurableTask(workspace,taskId));
    console.log(JSON.stringify({mode,result:"completed",id:t.id}));}
  catch(e){console.log(JSON.stringify({mode,result:"denied",error:String(e?.message||e).slice(0,600)}));}
}else if(mode==="recover"){
  const recovered=await owner(()=>recoverGoalCreation(workspace));
  console.log(JSON.stringify({mode,result:"recovered",id:recovered?.id??null}));
}else {
  const original=fs.rename;
  let intercepted=false;
  fs.rename=async(source,destination)=>{
    if(path.basename(String(destination))==="goal-create-transaction.json"){
      const value=JSON.parse(await fs.readFile(source,"utf8"));
      if(!intercepted && (mode==="replace"&&value.phase==="prepared" ||
                          mode==="crash"&&value.phase==="archived")){
        intercepted=true;
        if(mode==="crash"){
          await original(source,destination);
          await fs.writeFile(readyFile,"CRASH_AFTER_ARCHIVED\n");
          process.exit(77); // deliberate abrupt child termination, no finally/release
        }
        await fs.writeFile(readyFile,"HOLD_PREPARED\n");
        for(let i=0;i<300;i++){
          if(await exists(releaseFile))break;
          await sleep(20);
        }
        if(!(await exists(releaseFile))) throw new Error("WP8_REPLACEMENT_TEST_RELEASE_TIMEOUT");
      }
    }
    return original(source,destination);
  };
  try{
    const next=await owner(()=>createGoal(workspace,input(
      mode==="replace"?"Replacement after concurrent old Task":"Replacement after abrupt journal crash")));
    if(!intercepted) throw new Error("WP8_TEST_DID_NOT_INTERCEPT_JOURNAL");
    console.log(JSON.stringify({mode,result:"created",id:next.id,revision:next.revision}));
  }finally{fs.rename=original;}
}
