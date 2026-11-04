/** WP11: real child exit after Driver+snapshot commit, before Resume Bundle commit. */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {z} from "zod";
import {createGoal,bindGoalToSession,getGoal} from "../dist/lib/goals.js";
import {ensureGoalRunAuthority} from "../dist/lib/goal-run-web.js";
import {admitExecutionContract,inheritAcceptedExecutionContractState} from "../dist/lib/execution-contract.js";
import * as driver from "../dist/lib/driver-lease.js";
import * as relay from "../dist/lib/relay-control.js";
import * as handoff from "../dist/lib/handoff-store.js";
import * as resumes from "../dist/lib/resume-bundle.js";
import {withRelayGoal} from "../dist/lib/relay-scope.js";
import {registerGoalTool} from "../dist/tools/goal.js";
import {createRuntimeScope,runWithRuntimeScope} from "../dist/lib/runtime-scope.js";

const script=fileURLToPath(import.meta.url);
const underTemp=(p)=>typeof p==="string"&&path.resolve(p).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()+path.sep);
const as=(w,s,fn)=>runWithRuntimeScope(createRuntimeScope({workspaceRoot:w,projectRoots:[w]},{sessionId:s}),fn);
if(process.argv[2]==="crash"){
  const [w,from,to,goalId,handoffId,marker]=process.argv.slice(3);
  if(!underTemp(w)||!underTemp(process.env.CODEX_HOME)||!underTemp(marker))throw new Error("WP11 refuses non-temporary state");
  const originalGoal=await as(w,from,()=>getGoal(w));
  if(originalGoal?.id!==goalId)throw new Error("WP11 fixture original Goal mismatch");
  const bound=await as(w,to,()=>bindGoalToSession(w,{expectedRevision:originalGoal.revision,expectedGoalId:goalId,sourceSessionId:from}));
  assert.equal(bound.id,goalId);
  assert.equal(bound.owner_session,to);
  const committed=await driver.commitDriverHandoff(w,handoffId,to);
  assert.equal(committed.owner_session_id,to);
  await fs.writeFile(marker,"DRIVER_COMMITTED_BUNDLE_PENDING\n");
  process.exit(77); // deliberate crash after real Driver+handoff commit; no Resume transition
}
const root=await fs.mkdtemp(path.join(os.tmpdir(),"a11-wp11-relay-commit-"));
const keys=["CODEX_HOME","HARNESS_RELAY_ENABLED","HARNESS_COMPANION_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED","GOAL_WATCHDOG_ENABLED"];
const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const checks=[];
try{
  process.env.CODEX_HOME=path.join(root,"state");
  process.env.HARNESS_RELAY_ENABLED="true";
  process.env.HARNESS_COMPANION_ENABLED="true";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
  process.env.GOAL_WATCHDOG_ENABLED="false";
  const w=path.join(root,"workspace");
  await fs.mkdir(w,{recursive:true});
  const source="wp11-source",target="wp11-target";
  const g=await as(w,source,()=>createGoal(w,{
    objective:"Keep a local authenticated handoff consistent",
    success_criteria:[{name:"Handoff bundle recovers",passed:false}],
  }));
  await as(w,source,()=>ensureGoalRunAuthority(w,g));
  const requirement={
    intent_revision:1,objective:"Fixture goal handoff",
    scope:["only disposable WP11 temp state"],out_of_scope:[],
    deliverables:["verify exact handoff recovery"],
    success_criteria:["idempotent retry completes same bundle"],
    constraints:["never access live 3.0.2"],protected_resources:[],
    known_facts:["fixture only"],assumptions:[],delegated_decisions:[],
    remaining_nonblocking_uncertainties:[],closure_items:[],ambiguities:[],
    clarification_round:0,questions_in_round:0,resolution_mode:"none"
  };
  const admitted=await admitExecutionContract(w,source,requirement,g.id);
  const hash=admitted.state.requirement_hash;
  await inheritAcceptedExecutionContractState(w,source,target,hash,1,g.id);
  const prepared=await driver.prepareDriverHandoff(w,{
    goalId:g.id,sourceSessionId:source,targetSessionId:target,
    executionContractHash:hash,intentRevision:1,
    snapshot:{goal_revision:g.revision,current_phase:g.current_phase,next_action:"continue same Goal"},
  });
  const id=prepared.snapshot.handoff_id;
  const bundle=await resumes.createResumeBundle(w,prepared.snapshot,{
    runId:g.id,revision:g.revision,criteria:[{id:"fixture-criterion",confirmed:false}],
  });
  assert.equal(bundle.state,"PREPARED");
  assert.equal(prepared.lease.state,"HANDOFF_PREPARED");
  checks.push("Prepared real Driver handoff, authenticated Resume Bundle and accepted target contract");
  const marker=path.join(root,"committed-marker");
  const child=spawn(process.execPath,[script,"crash",w,source,target,g.id,id,marker],{
    cwd:path.dirname(script),env:{...process.env},stdio:["ignore","pipe","pipe"],windowsHide:true,
  });
  let childErr="";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data",x=>childErr+=x);
  const exit=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
  assert.equal(exit,77,"Expected intentional after-driver-commit exit: "+childErr);
  assert.equal(await fs.readFile(marker,"utf8"),"DRIVER_COMMITTED_BUNDLE_PENDING\n");
  const committedLease=await driver.readDriverLease(w,g.id);
  const snapshot=await withRelayGoal(w,g.id,()=>handoff.readHandoffSnapshot(w,id));
  const pending=await withRelayGoal(w,g.id,()=>resumes.readResumeBundle(w,id));
  assert.equal((await as(w,target,()=>getGoal(w))).owner_session,target);
  assert.equal(committedLease.state,"ACTIVE");
  assert.equal(committedLease.owner_session_id,target);
  assert.equal(committedLease.epoch,prepared.lease.epoch+1);
  assert.equal(committedLease.authority_transition?.transition_id,id);
  assert.equal(snapshot.state,"COMMITTED");
  assert.equal(pending.state,"PREPARED");
  checks.push("A genuinely exited child left Goal/lease/snapshot target-owned but Resume Bundle PREPARED");

  const bundleFile=resumes.resumeBundlePath(w,id,g.id);
  const originalBundleBytes=await fs.readFile(bundleFile,"utf8");
  try{
    const damaged=JSON.parse(originalBundleBytes);
    damaged.execution_contract_hash="f".repeat(64);
    await fs.writeFile(bundleFile,JSON.stringify(damaged,null,2)+"\n");
    await assert.rejects(
      ()=>withRelayGoal(w,g.id,()=>relay.validateRelayBind(w,id,target)),
      /RESUME_BUNDLE_CORRUPT/
    );
  }finally{
    await fs.writeFile(bundleFile,originalBundleBytes);
  }
  checks.push("A modified Resume Bundle with invalid stored hash is denied even for a committed Driver");

  const approved=await withRelayGoal(w,g.id,()=>relay.validateRelayBind(w,id,target));
  assert.equal(approved.already_bound,true);
  assert.equal(approved.resume_bundle.state,"PREPARED");
  checks.push("Exact committed lease allows bounded recovery admission without fabricating new handoff");

  await assert.rejects(()=>withRelayGoal(w,g.id,()=>relay.validateRelayBind(w,id,"wp11-foreign")),/TARGET_MISMATCH/);
  checks.push("Wrong target cannot exploit partial-commit recovery");

  let goalTool;
  registerGoalTool({registerTool(name,config,callback){if(name==="goal")goalTool={config,callback};}},w);
  assert.ok(goalTool);
  const schema=z.object(goalTool.config.inputSchema);
  const result=await as(w,target,()=>goalTool.callback(schema.parse({action:"bind",handoff_id:id})));
  assert.equal(result.structuredContent?.ok,true,JSON.stringify(result).slice(0,1800));
  const finished=await withRelayGoal(w,g.id,()=>resumes.readResumeBundle(w,id));
  assert.equal(finished.state,"COMMITTED");
  assert.equal(finished.target_session_id,target);
  const finalLease=await driver.readDriverLease(w,g.id);
  assert.equal(finalLease.lease_id,committedLease.lease_id);
  assert.equal(finalLease.epoch,committedLease.epoch);
  assert.equal(finalLease.owner_session_id,target);
  checks.push("Public goal(action=bind) finishes pending Resume Bundle with unchanged Driver epoch/lease");

  const repeated=await as(w,target,()=>goalTool.callback(schema.parse({action:"bind",handoff_id:id})));
  assert.equal(repeated.structuredContent?.ok,true,JSON.stringify(repeated).slice(0,900));
  assert.equal((await driver.readDriverLease(w,g.id)).epoch,committedLease.epoch);
  checks.push("Repeated public bind is idempotent after full reconciliation");
  console.log("A1.1 WP11 Relay partial commit PASS:",checks.length,"groups");
  for(const check of checks)console.log(" PASS",check);
}finally{
  for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await fs.rm(root,{recursive:true,force:true});
}
