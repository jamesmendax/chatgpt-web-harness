import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EffectiveToolRegistry } from '../src/lib/effective-tool-registry.js';
import { InvocationGateway } from '../src/lib/invocation-gateway.js';
import { createRuntimeScope, runWithRuntimeScope } from '../src/lib/runtime-scope.js';
import { createDurableTask, completeDurableTask, getDurableTask } from '../src/lib/durable-tasks.js';
import { createGoal, getGoal } from '../src/lib/goals.js';
import { goalRunCriterionId } from '../src/lib/goal-run-store.js';
import { ensureGoalRunAuthority, appendGoalRunEvidenceToResult, confirmGoalRunCriterion } from '../src/lib/goal-run-web.js';
import { saveVisualReviewRecord, assessVisualReviewRecord, critiqueVisualReviewRecord, getVisualReviewFreshness, getVisualReviewRecord, latestSessionVisualReview, withdrawVisualReview } from '../src/lib/visual-review-state.js';
import { assertRecoveryWriteCommit, recoveryStrictEnabled } from '../src/lib/recovery-integrity.js';
import { createMcpServer } from '../src/server-factory.js';
import { appendHarnessEvent, readHarnessEventTail } from '../src/lib/harness-events.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-v32-execution-'));
process.env.CODEX_HOME = path.join(temp, 'codex');
process.env.HARNESS_RECOVERY_SCOPE_MODE = 'stale-invalid-config';
process.env.GOAL_WATCHDOG_ENABLED = 'false';
const root = path.join(temp, 'workspace'); await fs.mkdir(root);
const scope = createRuntimeScope({workspaceRoot: root, projectRoots: [root], principalId: 'account-a'}, {sessionId: 'transport', _meta:{'openai/session':'abc'}});
const run = <T>(fn: () => Promise<T>) => runWithRuntimeScope(scope, fn);
try {
  assert.equal(recoveryStrictEnabled(), false);
  await assertRecoveryWriteCommit({} as any);
  const registry = new EffectiveToolRegistry('full');
  let effects = 0;
  for (const name of ['write_fake','upstream__edit']) {
    const def = registry.prepare(name, {inputSchema: {}, annotations: {readOnlyHint: false}}, async () => {
      effects++; return {content:[{type:'text', text:'ok'}], structuredContent:{ok:true}};
    })!;
    registry.register(def);
  }
  const gateway = new InvocationGateway(registry, {workspaceRoot: root, projectRoots:[root], principalId:'account-a', fallbackSessionId:'test'});
  const invoke = (name:string, id:string, intent?:string) => gateway.invoke(name, [{ ...(intent ? {_intent:intent} : {}) }, {sessionId:'transport', requestId:id, signal:new AbortController().signal, _meta:{'local-coder/operation-id':id}}]);
  assert.notEqual((await invoke('write_fake','same','{bad')).isError, true);
  assert.notEqual((await invoke('write_fake','same','{bad')).isError, true);
  assert.equal(effects, 1, 'same operation ID must deduplicate');
  assert.notEqual((await invoke('upstream__edit','new')).isError, true);
  assert.equal(effects, 2, 'new upstream operation must execute');

  const task = await run(() => createDurableTask(root, {goal:'Upload and verify binaries', blocking_checks:[{name:'Both binary release assets uploaded and verified',passed:false}], advisory_checks:[{name:'Optional verification',passed:false}], visual_required:true}));
  const completed = await run(() => completeDurableTask(root, task.id, 'Model believes work is complete'));
  const reloaded = await run(() => getDurableTask(root, task.id));
  assert.equal(completed.status, 'completed');
  assert.equal(reloaded.completion_basis?.verification, 'model_declared');
  assert.equal(reloaded.completion_basis?.unmet_checks[0].passed, false);
  assert.equal(reloaded.completion_basis?.unmet_checks[1].name, 'Optional verification');
  assert.equal(reloaded.blocking_checks[0].passed, false);

  const artifact = path.join(root, 'checked.txt'); await fs.writeFile(artifact, 'verified file');
  const goal = await run(() => createGoal(root, {objective:'Check the file',success_criteria:[{name:'File exists',passed:false,verification:{kind:'file_exists',target:artifact}}]}));
  const secondAccount = {...scope,principalId:'account-b'};
  assert.equal(await runWithRuntimeScope(secondAccount, () => getGoal(root)), null, 'same workspace and session cannot read another account Goal');
  await assert.rejects(runWithRuntimeScope(secondAccount, () => getDurableTask(root,task.id)), /ENOENT|NOT_FOUND/, 'same workspace and session cannot read another account Task');
  await run(() => appendHarnessEvent(root, {type:'evidence/recorded',data:{marker:'account-a-only'}}));
  assert.ok((await run(() => readHarnessEventTail(root,0))).events.some(event => event.data.marker === 'account-a-only'));
  assert.equal((await runWithRuntimeScope(secondAccount, () => readHarnessEventTail(root,0))).events.length,0, 'event tail is account isolated');
  await runWithRuntimeScope(secondAccount, () => appendHarnessEvent(root,{type:'evidence/recorded',data:{marker:'account-b-only'}}));
  const accountAEvents = (await run(() => readHarnessEventTail(root,0))).events;
  assert.ok(!accountAEvents.some(event => event.data.marker === 'account-b-only'));
  const envelope = await run(() => ensureGoalRunAuthority(root, goal));
  const criterionId = envelope.run.criteria[0].id;
  const evidenceScope = {...scope, invocationId:'file-info-proof', goalId:goal.id, goalOwnerSessionId:goal.owner_session, goalStatus:goal.status};
  const payload = {ok:true,tool:'file_info',summary:'file exists',data:{path:artifact,sha256:createHash('sha256').update('verified file').digest('hex')}};
  await runWithRuntimeScope(evidenceScope, () => appendGoalRunEvidenceToResult(root, {definition:{name:'file_info',source:'native'} as any,scope:evidenceScope,rawArgs:{},callbackArgs:[]}, {content:[{type:'text',text:JSON.stringify(payload)}],structuredContent:payload}));
  const confirmation = await run(() => confirmGoalRunCriterion(root, {criterion:criterionId,evidenceIds:['tool-file-info-proof']}));
  assert.equal(confirmation.goal.success_criteria[0].passed,true, 'status criterion ID resolves on confirm');

  const base = {target:'visual',kind:'image' as const,renderer:'test', output_paths:['render.png'],page_paths:[],delivered_pages:[1],focus_paths:[],machine_blocking_issues:[],machine_advisories:[],diagnostics:{}};
  const review = await run(() => saveVisualReviewRecord(root, base));
  assert.equal((await run(() => latestSessionVisualReview(root)))?.id, review.id);
  const assessed = await run(() => assessVisualReviewRecord(root, review.id, {verdict:'pass',inspected_full_render:true}));
  assert.equal(assessed.model_visual_assessment?.further_improvement_worthwhile,undefined);
  assert.equal((await run(() => getVisualReviewFreshness(root, review.id))).model_visual_ready,true);
  const scores = {task_fidelity:4.1,composition:4.1,visual_hierarchy:4.1,coherence:4.1,craft_precision:4.1,professional_readiness:4.1};
  await run(() => critiqueVisualReviewRecord(root, review.id, {inspected_full_render:true,first_impression:'acceptable',delivery_recommendation:'accept',quality_scores:scores}));
  await run(() => assessVisualReviewRecord(root, review.id, {verdict:'fail',inspected_full_render:true,issues:['revised finding']}));
  assert.equal((await run(() => getVisualReviewRecord(root, review.id))).review_history?.length,3);
  await run(() => withdrawVisualReview(root, review.id, 'retracted'));
  assert.equal((await run(() => getVisualReviewRecord(root, review.id))).model_visual_assessment,undefined);
  const empty = await run(() => saveVisualReviewRecord(root, {...base,delivered_pages:[]}));
  await assert.rejects(run(() => assessVisualReviewRecord(root,empty.id,{verdict:'pass',inspected_full_render:true})), /VISUAL_IMAGES_UNAVAILABLE/);
  const otherScope = {...scope,principalId:'account-b'};
  assert.equal(await runWithRuntimeScope(otherScope, () => latestSessionVisualReview(root)), null);
  await assert.rejects(runWithRuntimeScope(otherScope, () => getVisualReviewRecord(root,review.id)), /NOT_FOUND/);
  const mcpRoot = path.join(temp, 'mcp'); await fs.mkdir(mcpRoot);
  process.env.CHATGPT_TOOL_PROFILE = 'full';
  const server = createMcpServer(mcpRoot, 10000, [mcpRoot], false);
  const client = new Client({name:'v32-test',version:'1'});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  const call = async (name:string, args:Record<string,unknown>) => {
    const result = await client.callTool({name,arguments:args});
    assert.notEqual(result.isError,true, JSON.stringify(result.structuredContent ?? result.content));
    return result.structuredContent as any;
  };
  try {
    const target = path.join(mcpRoot,'direct.txt');
    await call('write_file',{path:target,content:'direct write',_intent:'invalid legacy value'});
    assert.equal(await fs.readFile(target,'utf8'),'direct write');
    const created = await call('goal',{action:'create',objective:'Simple objective',success_criteria:['Plain-language criterion']});
    assert.equal(created.data.goal.success_criteria[0].name,'Plain-language criterion');
    assert.equal(created.data.continue_execution,undefined);
    const declaredGoal = await call('goal',{action:'complete',detail:'Work declared finished'});
    assert.equal(declaredGoal.data.completion_basis.verification,'model_declared');
    assert.equal(declaredGoal.data.completion_basis.declaration,'Work declared finished');
    assert.equal(declaredGoal.data.unverified_criteria.length,1);
    assert.equal(declaredGoal.data.goal.success_criteria[0].passed,false, 'declaration cannot turn an unchecked criterion into a verified result');
    const declaredStatus = await call('goal',{action:'status'});
    assert.equal(declaredStatus.data.goal_run.completionBasis.verification,'model_declared', 'basis survives persistence');
    assert.equal(declaredStatus.data.goal.success_criteria[0].passed,false);
    const criteria = ['Status ID','Criterion by name','Legacy before rename','Stable before rename']
      .map(name => ({name, verification:{kind:'file_exists',target}}));
    await call('goal',{action:'create',objective:'Exercise status and confirmation',success_criteria:criteria});
    let status = await call('goal',{action:'status'});
    const ids = status.data.goal_run.criteria.map((item:any) => item.id);
    assert.equal(ids.length,4);
    await call('goal',{action:'update',success_criteria:[
      {id:ids[2],name:'Legacy after rename'},
      {id:ids[3],name:'Stable after rename'},
    ]});
    status = await call('goal',{action:'status'});
    assert.deepEqual(status.data.goal_run.criteria.map((item:any) => item.id), ids, 'renames preserve status IDs');
    assert.equal(status.data.goal.success_criteria.length,4, 'renames do not append new criteria');
    await call('file_info',{path:target,sha256:true});
    status = await call('goal',{action:'status'});
    const proof = status.data.goal_run.typedEvidence.find((item:any) => item.source === 'native:file_info' && item.metadata?.verifiesCriterion);
    assert.ok(proof, 'real MCP file_info yields verification evidence');
    for (const selector of [ids[0], 'Criterion by name', goalRunCriterionId('Legacy after rename',2), ids[3]]) {
      await call('goal',{action:'confirm',criterion:selector,evidence_ids:[proof.id]});
    }
    status = await call('goal',{action:'status'});
    assert.ok(status.data.goal.success_criteria.every((item:any) => item.passed), 'status IDs, names, generated legacy IDs and stable renamed IDs all confirm');
    serverTransport.sessionId = 'bind-source';
    const bindSource = await call('goal',{action:'create',objective:'Selected Goal',success_criteria:['Unverified item']});
    const sourceGoal = bindSource.data.goal;
    serverTransport.sessionId = 'bind-target';
    const discovery = await call('goal',{action:'status'});
    assert.equal(discovery.data.takeover_candidate.goal_id,sourceGoal.id);
    assert.equal(discovery.data.target_selection_required,true);
    const missingSelection = await client.callTool({name:'goal',arguments:{action:'bind',expected_revision:sourceGoal.revision}});
    assert.equal(missingSelection.structuredContent?.ok,false);
    assert.match(JSON.stringify(missingSelection.structuredContent),/GOAL_BIND_TARGET_REQUIRED/);
    const wrongSelection = await client.callTool({name:'goal',arguments:{action:'bind',goal_id:'not-the-selected-goal',expected_revision:sourceGoal.revision}});
    assert.equal(wrongSelection.structuredContent?.ok,false);
    const staleSelection = await client.callTool({name:'goal',arguments:{action:'bind',goal_id:sourceGoal.id,expected_revision:sourceGoal.revision+1}});
    assert.equal(staleSelection.structuredContent?.ok,false);
    assert.match(JSON.stringify(staleSelection.structuredContent),/GOAL_TAKEOVER_REVISION_REQUIRED/);
    const selected = await call('goal',{action:'bind',goal_id:sourceGoal.id,expected_revision:sourceGoal.revision,takeover_token:'ignored-legacy-token'});
    assert.equal(selected.data.goal.id,sourceGoal.id);
    assert.equal(selected.data.goal.owner_session,'bind-target');
    const taskCreated = await call('task_state',{action:'create',goal:'Publish binaries',visual_required:true,blocking_checks:[{name:'uploaded and verified',passed:false}],advisory_checks:[{name:'advisory still open',passed:false}]});
    assert.equal(taskCreated.data.continue_execution,undefined);
    const taskResult = await call('task_state',{action:'complete',task_id:taskCreated.data.handoff.task_id,completion_basis:'Reported by model'});
    assert.equal(taskResult.data.completion_status,'model_declared');
    assert.equal(taskResult.data.unmet_checks[0].passed,false);
    assert.equal(taskResult.data.unmet_checks[1].name,'advisory still open');
    assert.equal(taskResult.data.continue_execution,undefined);
    const emptyStatus = await call('visual_review',{action:'status'});
    assert.equal(emptyStatus.data.review,null);
  } finally { await client.close(); await server.close(); }
  console.log('PASS v3.2 execution, Goal evidence, Task declarations, visual revisions and account scope');
} finally { await fs.rm(temp,{recursive:true,force:true}); }
