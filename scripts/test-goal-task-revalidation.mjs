/** A1.1 historical Task revalidation: no silent approval migration. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createGoal, getGoal} from "../dist/lib/goals.js";
import {updateGoalRunDefinition} from "../dist/lib/goal-run-web.js";
import {
  createDurableTask, completeDurableTask, durableTaskDir, getDurableTask,
  updateDurableTask, revalidateDurableTaskGoalDefinition, taskHandoff,
} from "../dist/lib/durable-tasks.js";
import {goalDefinitionFingerprint} from "../dist/lib/goal-state-store.js";
import {registerTaskTools} from "../dist/tools/tasks.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),"a11-legacy-task-revalidate-"));
const tracked=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED","HARNESS_COMPANION_ENABLED"];
const saved=Object.fromEntries(tracked.map(k=>[k,process.env[k]]));
const checks=[];
try {
  process.env.CODEX_HOME=path.join(tmp,"state");
  process.env.GOAL_WATCHDOG_ENABLED="false";
  process.env.HARNESS_RELAY_ENABLED="false";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
  process.env.HARNESS_COMPANION_ENABLED="false";
  const workspace=path.join(tmp,"workspace");
  await fs.mkdir(workspace,{recursive:true});
  const inSession=(id,fn)=>runWithRuntimeScope(
    createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:id}),fn);
  const owner=fn=>inSession("legacy-owner",fn);
  const goal=await owner(()=>createGoal(workspace,{
    objective:"Prepare a private research summary",
    success_criteria:[{name:"Accurate and private summary",passed:false}],
    constraints:["No upload"],
  }));
  const task=await owner(()=>createDurableTask(workspace,{
    goal:"Complete user-approved research",
    blocking_checks:[{name:"Original privacy check",passed:true}],
  }));
  const file=path.join(durableTaskDir(workspace),task.id+".json");
  const historical=JSON.parse(await fs.readFile(file,"utf8"));
  delete historical.goal_definition_sha256;
  await fs.writeFile(file,JSON.stringify(historical,null,2)+"\n","utf8");
  await assert.rejects(()=>owner(()=>completeDurableTask(workspace,task.id)),/TASK_GOAL_REVALIDATION_REQUIRED/,
    "legacy task with no binding must never silently complete");
  assert.equal((await owner(()=>getDurableTask(workspace,task.id))).status,"active");
  assert.equal(taskHandoff(await owner(()=>getDurableTask(workspace,task.id))).goal_definition_revalidation_required,true);
  checks.push("Historical Task with no definition fingerprint fails closed without mutating it");
  await assert.rejects(()=>owner(()=>updateDurableTask(workspace,task.id,{status:"completed"})),
    /TASK_COMPLETION_GATE_REQUIRED/);
  assert.equal((await owner(()=>getDurableTask(workspace,task.id))).status,"active");
  checks.push("Low-level task_update cannot bypass Goal-aware completion checks");

  await assert.rejects(()=>owner(()=>revalidateDurableTaskGoalDefinition(workspace,task.id,goal.revision+5)),/GOAL_STALE_REVISION/);
  await assert.rejects(()=>inSession("foreign-owner",()=>revalidateDurableTaskGoalDefinition(workspace,task.id,goal.revision)),/different ChatGPT window|owner/i);
  checks.push("Revalidation rejects stale Goal revision and foreign session");

  const refreshed=await owner(()=>revalidateDurableTaskGoalDefinition(workspace,task.id,goal.revision));
  assert.equal(refreshed.goal_definition_sha256,goalDefinitionFingerprint(await owner(()=>getGoal(workspace))));
  assert.equal(refreshed.goal_id,goal.id);
  assert.equal(refreshed.blocking_checks.length,1);
  assert.equal(refreshed.blocking_checks[0].passed,false,"old pass cannot survive revalidation");
  assert.match(refreshed.current_step,/revalidat/i);
  await assert.rejects(()=>owner(()=>completeDurableTask(workspace,task.id)),/blocking check/i);
  checks.push("Explicit revalidation binds active user-Goal revision but invalidates earlier checks");

  await owner(()=>updateDurableTask(workspace,task.id,{blocking_checks:[{name:"New verification against current Goal",passed:true}]}));
  assert.equal((await owner(()=>completeDurableTask(workspace,task.id))).status,"completed");
  assert.equal((await owner(()=>getGoal(workspace))).status,"active");
  checks.push("Revalidated Task independently completes only after fresh checks; broad Goal stays active");

  const changedTask=await owner(()=>createDurableTask(workspace,{
    goal:"Old definition specific",blocking_checks:[{name:"old acceptance",passed:true}],
  }));
  const updated=await owner(()=>updateGoalRunDefinition(workspace,{
    objective:"Prepare a public research summary",
  },goal.revision));
  await assert.rejects(()=>owner(()=>completeDurableTask(workspace,changedTask.id)),/TASK_GOAL_DEFINITION_CHANGED/);
  await assert.rejects(()=>owner(()=>revalidateDurableTaskGoalDefinition(workspace,changedTask.id,goal.revision)),/GOAL_STALE_REVISION/);
  const rebound=await owner(()=>revalidateDurableTaskGoalDefinition(workspace,changedTask.id,updated.goal.revision));
  assert.equal(rebound.blocking_checks.every(x=>!x.passed),true);
  checks.push("In-place Goal changes require explicit latest-revision revalidation, never silent upgrade");

  const noChecks=await owner(()=>createDurableTask(workspace,{goal:"Legacy task with no declared checks"}));
  const noChecksFile=path.join(durableTaskDir(workspace),noChecks.id+".json");
  const noChecksJson=JSON.parse(await fs.readFile(noChecksFile,"utf8"));
  delete noChecksJson.goal_definition_sha256;
  await fs.writeFile(noChecksFile,JSON.stringify(noChecksJson)+"\n");
  const tool={};
  registerTaskTools({registerTool(name,config,callback){tool[name]={config,callback};}},workspace);
  const valid=await owner(()=>tool.task_state.callback({
    action:"revalidate",task_id:noChecks.id,expected_goal_revision:updated.goal.revision,
  }));
  assert.equal(valid.isError,undefined,"public Task state revalidation path failed: "+JSON.stringify(valid));
  assert.equal(valid.structuredContent?.data?.previous_passed_checks_invalidated,true);
  const reinstated=await owner(()=>getDurableTask(workspace,noChecks.id));
  assert.ok(reinstated.blocking_checks.some(x=>!x.passed),
    "legacy task without checks cannot revalidate into automatically deliverable task");
  checks.push("No-check legacy Task gains a blocking revalidation check");

  const bad=await owner(()=>tool.task_state.callback({action:"revalidate",task_id:rebound.id}));
  assert.ok(bad.isError,"MCP revalidate action must require explicit goal revision");
  checks.push("MCP action revalidate requires expected revision");

  console.log("A1.1 Task revalidation PASS:",checks.length,"groups");
  for(const x of checks) console.log(" PASS",x);
}finally{
  for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;
  await fs.rm(tmp,{recursive:true,force:true});
}
