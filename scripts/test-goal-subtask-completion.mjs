/** A1 Task-versus-Goal lifecycle regression. All mutations are in temp CODEX_HOME. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGoal, getGoal } from "../dist/lib/goals.js";
import {
  createDurableTask, getDurableTask, completeDurableTask,
  updateDurableTask, durableTaskDir, getActiveTaskId,
} from "../dist/lib/durable-tasks.js";
import { readGoalRun } from "../dist/lib/goal-run-store.js";
import { registerTaskTools } from "../dist/tools/tasks.js";
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "a11-task-goal-"));
const tracked = ["CODEX_HOME", "GOAL_WATCHDOG_ENABLED", "HARNESS_RELAY_ENABLED", "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_COMPANION_ENABLED"];
const saved = Object.fromEntries(tracked.map(k => [k, process.env[k]]));
const checks = [];
try {
  process.env.CODEX_HOME = path.join(temp, "state");
  process.env.GOAL_WATCHDOG_ENABLED = "false";
  process.env.HARNESS_RELAY_ENABLED = "false";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
  process.env.HARNESS_COMPANION_ENABLED = "false";
  const workspace = path.join(temp, "work");
  await fs.mkdir(workspace, { recursive: true });
  const session = (name, fn) => runWithRuntimeScope(
    createRuntimeScope({workspaceRoot: workspace, projectRoots: [workspace]}, {sessionId: name}), fn);
  const owner = (fn) => session("owner-A", fn);
  const goal = await owner(() => createGoal(workspace, {
    objective: "Complete multiple tasks while one broad Goal remains open",
    success_criteria: [
      {name: "First actual user-facing capability verified", passed: false},
      {name: "Second independent capability verified", passed: false},
    ],
  }));
  const register = {};
  registerTaskTools({registerTool(name, config, callback) { register[name] = {config, callback}; }}, workspace);
  const call = (name, args) => owner(() => register[name].callback(args));
  const ready = () => ({goal:"Deliver a bounded subtask", blocking_checks:[{name:"isolated regression",passed:true}],advisory_checks:[{name:"future work",passed:false}]});

  const failed = await owner(() => createDurableTask(workspace, {...ready(), blocking_checks:[{name:"unfinished test", passed:false}]}));
  const declared = await owner(() => completeDurableTask(workspace, failed.id, "Declared with unfinished test"));
  assert.equal(declared.status, "completed");
  assert.equal(declared.completion_basis.verification, "model_declared");
  assert.equal(declared.completion_basis.unmet_checks[0]?.name, "unfinished test");
  assert.equal(declared.completion_basis.unmet_checks[0]?.passed, false);
  const passed = await owner(() => createDurableTask(workspace, ready()));
  const done = await call("task_complete", {task_id:passed.id,note:"Isolated subtask done, parent still open"});
  assert.equal(done.isError,undefined,"bounded subtask should close");
  assert.equal(done.structuredContent?.data?.task?.status,"completed",JSON.stringify(done.structuredContent));
  assert.equal(done.structuredContent?.data?.goal_still_active,true);
  assert.equal(done.structuredContent?.data?.completion_status,"model_declared");
  assert.equal(done.structuredContent?.data?.deliverable_ready,false,"declaration alone does not verify deliverable quality");
  assert.doesNotMatch(done.structuredContent?.summary||"",/GOAL_DELIVERABLE_READY/);
  assert.equal((await owner(() => getGoal(workspace))).status,"active");
  assert.equal((await owner(() => getGoal(workspace))).revision,goal.revision);
  assert.notEqual((await readGoalRun(workspace,"owner-A"))?.run.state,"COMPLETED");
  checks.push("task completion records unverified checks and preserves the active Goal");

  const next = await owner(() => createDurableTask(workspace, ready()));
  const second = await call("task_state", {action:"complete",task_id:next.id,note:"Only Task 2 is finished"});
  assert.equal(second.isError,undefined);
  assert.equal(second.structuredContent?.data?.handoff?.status,"completed");
  assert.equal(second.structuredContent?.data?.goal_still_active,true);
  assert.equal(second.structuredContent?.data?.completion_status,"model_declared");
  assert.equal(await owner(() => getActiveTaskId(workspace,"owner-A")),null);
  checks.push("task_state records declaration and clears the active Task pointer");

  const stale = await owner(() => createDurableTask(workspace, ready()));
  const stalePath = path.join(durableTaskDir(workspace),stale.id+".json");
  await fs.writeFile(stalePath,JSON.stringify({...JSON.parse(await fs.readFile(stalePath,"utf8")),goal_id:randomUUID()},null,2)+"\n");
  const staleCompleted = await owner(() => completeDurableTask(workspace,stale.id));
  assert.equal(staleCompleted.status,"completed");
  assert.equal(staleCompleted.completion_basis.verification,"model_declared");
  assert.equal((await owner(() => getGoal(workspace))).id,goal.id);
  assert.equal((await owner(() => getGoal(workspace))).revision,goal.revision);
  checks.push("stale Goal association does not block a Task declaration or change the current Goal");

  const foreign = await owner(() => createDurableTask(workspace, ready()));
  await assert.rejects(() => session("foreign-B",()=>completeDurableTask(workspace,foreign.id)),/different ChatGPT window|TASK_.*OWNER|owner|session/i);
  assert.equal((await owner(() => getDurableTask(workspace,foreign.id))).status,"active");
  checks.push("foreign session cannot close the owner's task");

  assert.equal((await owner(() => getGoal(workspace))).id,goal.id);
  assert.equal((await owner(() => getGoal(workspace))).revision,goal.revision);
  checks.push("parent Goal identity/revision/criteria never auto-finalized by subtask completion");
  console.log("Goal/Task subtask lifecycle PASS:",checks.length,"groups");
  for(const check of checks) console.log("  PASS",check);
} finally {
  for(const [k,v] of Object.entries(saved)) {if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await fs.rm(temp,{recursive:true,force:true});
}
