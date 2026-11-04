/** A1.1: material Goal revision must fence old work, without fencing progress-only phase updates. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoal, getGoal } from "../dist/lib/goals.js";
import { goalDefinitionFingerprint } from "../dist/lib/goal-state-store.js";
import { updateGoalRunDefinition } from "../dist/lib/goal-run-web.js";
import { createDurableTask, completeDurableTask, getDurableTask } from "../dist/lib/durable-tasks.js";
import { runWithRuntimeScope, createRuntimeScope } from "../dist/lib/runtime-scope.js";

const temp=await fs.mkdtemp(path.join(os.tmpdir(),"a11-goal-definition-fence-"));
const env=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED","HARNESS_COMPANION_ENABLED"];
const previous=Object.fromEntries(env.map(k=>[k,process.env[k]]));
const checks=[];
try {
  process.env.CODEX_HOME=path.join(temp,"state");
  process.env.GOAL_WATCHDOG_ENABLED="false";
  process.env.HARNESS_RELAY_ENABLED="false";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
  process.env.HARNESS_COMPANION_ENABLED="false";
  const workspace=path.join(temp,"workspace");
  await fs.mkdir(workspace,{recursive:true});
  const owner=(fn)=>runWithRuntimeScope(createRuntimeScope(
    {workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:"definition-owner"}),fn);
  const goal=await owner(()=>createGoal(workspace,{
    objective:"User wants a localized product without cloud access",
    success_criteria:[{name:"Offline output is verified",passed:false,detail:"No cloud calls"}],
    constraints:["No cloud access"],
  }));
  const work=(name)=>owner(()=>createDurableTask(workspace,{
    goal:name,blocking_checks:[{name:"isolated output checked",passed:true}],
  }));
  const phaseTask=await work("phase-only work");
  assert.match(phaseTask.goal_definition_sha256||"",/^[a-f0-9]{64}$/,
    "new Tasks must pin Goal definition, not only ID");
  const phase=await owner(()=>updateGoalRunDefinition(workspace,{current_phase:"Implementation continuing"},goal.revision));
  assert.equal(phase.goal.id,goal.id);
  assert.notEqual(phase.goal.revision,goal.revision);
  const phaseDone=await owner(()=>completeDurableTask(workspace,phaseTask.id));
  assert.equal(phaseDone.status,"completed");
  checks.push("Phase-only progress preserves Task while parent Goal stays active");

  const progressGoal=await owner(()=>getGoal(workspace));
  const fingerprintBefore=goalDefinitionFingerprint(progressGoal);
  const projectedEvidence={...progressGoal,success_criteria:progressGoal.success_criteria.map(c=>({
    ...c,passed:true,detail:"Verification evidence summary created by GoalRun",
  }))};
  assert.equal(goalDefinitionFingerprint(projectedEvidence),fingerprintBefore);
  checks.push("Evidence projection and passed flags do not masquerade as changed user intent");

  const oldTask=await work("old intent work");
  const oldFingerprint=oldTask.goal_definition_sha256;
  const revised=await owner(()=>updateGoalRunDefinition(workspace,{
    objective:"User now wants a cloud-connected product",
  },phase.goal.revision));
  assert.equal(revised.goal.id,goal.id,"revise must preserve Goal identity");
  assert.notEqual(revised.goal.revision,phase.goal.revision);
  await assert.rejects(()=>owner(()=>completeDurableTask(workspace,oldTask.id)),/TASK_GOAL_DEFINITION_CHANGED/,
    "old Task must not claim completion against materially revised user intent");
  assert.equal((await owner(()=>getDurableTask(workspace,oldTask.id))).status,"active");
  assert.equal((await owner(()=>getDurableTask(workspace,oldTask.id))).goal_definition_sha256,oldFingerprint);
  checks.push("Changed objective invalidates older Task success checks without changing Goal ID");

  const constraintTask=await work("old constraint work");
  const limited=await owner(()=>updateGoalRunDefinition(workspace,{
    constraints:["No third-party distribution"],
  },revised.goal.revision));
  await assert.rejects(()=>owner(()=>completeDurableTask(workspace,constraintTask.id)),/TASK_GOAL_DEFINITION_CHANGED/);
  checks.push("Changed constraints invalidate older Task checks");

  const criteriaTask=await work("old criterion work");
  const criteriaChanged=await owner(()=>updateGoalRunDefinition(workspace,{
    success_criteria:[{name:"Cloud output is verified",passed:false,detail:"Includes remote behavior tests"}],
  },limited.goal.revision));
  await assert.rejects(()=>owner(()=>completeDurableTask(workspace,criteriaTask.id)),/TASK_GOAL_DEFINITION_CHANGED/);
  checks.push("Changed success criterion definition invalidates stale Task checks");

  const fresh=await work("new intent work");
  assert.equal((await owner(()=>completeDurableTask(workspace,fresh.id))).status,"completed");
  assert.equal((await owner(()=>getGoal(workspace))).status,"active");
  assert.equal((await owner(()=>getGoal(workspace))).revision,criteriaChanged.goal.revision);
  checks.push("Fresh Task finishes independently, without completing Goal");

  console.log("A1.1 Goal material-intent Task fence PASS:",checks.length,"groups");
  for(const c of checks)console.log(" PASS",c);
}finally{
  for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await fs.rm(temp,{recursive:true,force:true});
}
