import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-v32-skills-'));
const workspace = path.join(fixture,'workspace'); const registry = path.join(fixture,'plugins.json');
const root = path.resolve('skills/anthropic-official-skills');
// Historical upstream bytes are optional and require an explicit local snapshot.
const original = process.env.WH_SKILL_BASELINE || null;
process.env.CHATGPT_PLUGINS_CONFIG=registry; process.env.CODEX_HOME=path.join(fixture,'home'); process.env.AUDIT_LOG_PATH=path.join(fixture,'audit.jsonl');
const sha = b => createHash('sha256').update(b).digest('hex');
try {
 await fs.mkdir(workspace,{recursive:true}); await fs.writeFile(registry,JSON.stringify({schema_version:2,skills:[]}));
 const {loadProjectSkill,loadProjectSkills,resolveAllSkills,buildSkillCatalog}=await import('../src/lib/skills-loader.ts');
 const {selectSkill}=await import('../src/lib/skill-resolver.ts'); const {routeSkills}=await import('../src/lib/skill-routing.ts');
 const {registerContextTools}=await import('../src/tools/context.ts');
 const manifest=JSON.parse(await fs.readFile(path.join(root,'children.json'),'utf8')); assert.equal(manifest.children.length,14); assert.equal(new Set(manifest.children).size,14);
 let skills=await loadProjectSkills(workspace); const children=skills.filter(s=>s.id.startsWith('anthropic.')); assert.equal(children.length,14);
 const definitions=new Map(); registerContextTools({registerTool(name,_config,handler){definitions.set(name,handler);return {}}},workspace);
 let pages=[], offset=0; do {const page=buildSkillCatalog(skills,{offset,limit:5,maxBytes:6000}); pages.push(...page.entries); offset=page.next_offset;} while(offset!==null);
 for(const slug of manifest.children) {
  const id=`anthropic.${slug}`; assert.ok(pages.some(e=>e.id===id),id); assert.equal(selectSkill(skills,id).id,id);
  const listed=await definitions.get('list_skills')({name:id,offset:0,limit:50,max_bytes:6000,details:false}); assert.equal(listed.structuredContent.data.skills[0].id,id);
  const routed=routeSkills(children,{task:`Use ${id} for this task`,limit:3}); assert.equal(routed.primary?.id,id,JSON.stringify(routed));
  const viaTool=await definitions.get('route_skills')({task:`Use ${id} for this task`,phase:'auto',max_results:3,max_content_bytes:4096}); assert.equal(viaTool.structuredContent.data.loaded_primary.id,id);
  const body=await loadProjectSkill(workspace,id,4096,{mode:'implicit'}); assert.match(body.content,/Web Harness adaptation/); assert.ok(body.resource_root); assert.match(body.content_sha256,/^[a-f0-9]{64}$/);
  const entry=body.resource_catalog.entries.find(e=>e.relative_path==='ANTHROPIC-SKILL.md'); assert.ok(entry?.sha256,id); assert.equal(entry.load_params.name,id);
  const direct=await loadProjectSkill(workspace,id,100000,{mode:'implicit',resource_path:'ANTHROPIC-SKILL.md'}); assert.equal(direct.resource_sha256,entry.sha256); assert.equal(sha(await fs.readFile(path.join(body.resource_root,'ANTHROPIC-SKILL.md'))),entry.sha256);
  const directTool=await definitions.get('load_skill')({name:id,invocation_mode:'implicit',resource_path:'LICENSE.txt',max_bytes:100000,offset_bytes:0,evidence_action:'read'}); assert.match(directTool.structuredContent.data.content,/Apache License/i);
  const license=await loadProjectSkill(workspace,id,100000,{mode:'implicit',resource_path:'LICENSE.txt'}); assert.match(license.content,/Apache License/i);
  await assert.rejects(loadProjectSkill(workspace,id,1000,{mode:'implicit',resource_path:'ANTHROPIC-SKILL.md',expected_resource_sha256:'0'.repeat(64)}),/SKILL_RESOURCE_VERSION_CHANGED: supplied=.*current=/);
  await assert.rejects(loadProjectSkill(workspace,id,1000,{mode:'implicit',expected_content_sha256:'0'.repeat(64)}),/SKILL_VERSION_CHANGED: supplied=.*current=/);
 }
 for (const id of ['anthropic.claude-api','anthropic.academy-guide','anthropic.brand-guidelines']) {
  for(const task of ['Build a generic API integration','Design a brand identity','Create learning courses']) assert.notEqual(routeSkills(children,{task}).primary?.id,id);
 }
 for (const [id,task] of [['anthropic.claude-api','Build an Anthropic Claude API SDK integration'],['anthropic.academy-guide','Find Claude Academy learning courses'],['anthropic.brand-guidelines','Apply Anthropic brand guidelines']]) assert.equal(routeSkills(children.filter(s=>s.id===id),{task}).primary?.id,id);
 const examples={
  'frontend-design':'Design a distinctive frontend interface', 'webapp-testing':'Test a web application in a browser',
  'web-artifacts-builder':'Build an interactive web artifact prototype', 'skill-creator':'Create an agent Skill',
  'algorithmic-art':'Create generative algorithmic art', 'canvas-design':'Create a static poster illustration',
  'mcp-builder':'Build an MCP server', 'theme-factory':'Apply a theme to an artifact',
  'internal-comms':'Draft an internal communications status report', 'slack-gif-creator':'Create an animated GIF for Slack',
  'discernment-nudge':'Check assumptions and missing evidence', 'claude-api':'Develop an Anthropic Claude API',
  'academy-guide':'Find Claude Academy learning courses', 'brand-guidelines':'Apply Anthropic brand guidelines' };
 for (const [slug,task] of Object.entries(examples)) {
   const id=`anthropic.${slug}`, one=children.filter(s=>s.id===id);
   assert.equal(routeSkills(one,{task}).primary?.id,id,task);
   assert.equal(routeSkills(one,{task:'What is the weather tomorrow?'}).status,'no_match',id);
 }
 for (const [slug,task] of Object.entries(examples)) assert.equal(routeSkills(skills,{task}).primary?.id,`anthropic.${slug}`,`full catalog: ${task}`);
 for (const task of ['Build a generic API integration','Design a brand identity','Create learning courses']) {
   assert.ok(!['anthropic.claude-api','anthropic.academy-guide','anthropic.brand-guidelines'].includes(routeSkills(skills,{task}).primary?.id),task);
 }
 const project=path.join(workspace,'.claude/skills/frontend-design'); await fs.mkdir(project,{recursive:true}); await fs.writeFile(path.join(project,'SKILL.md'),'---\nname: frontend-design\ndescription: Project frontend design.\n---\nProject skill');
 skills=await loadProjectSkills(workspace); assert.equal(selectSkill(skills,'frontend-design').source,'project'); assert.equal(selectSkill(skills,'anthropic.frontend-design').source,'builtin');
 assert.equal(routeSkills(skills,{task:'Use frontend-design for this task'}).primary?.source,'project');
 assert.equal(routeSkills(skills,{task:'Use anthropic.frontend-design for this task'}).primary?.id,'anthropic.frontend-design');
 await fs.writeFile(path.join(project,'SKILL.md'),'---\nname: frontend-design\ndescription: Project frontend design.\ndisable-model-invocation: true\n---\nProject skill');
 skills=await loadProjectSkills(workspace); assert.equal(routeSkills(skills,{task:'Use frontend-design for this task'}).status,'no_match');
 assert.equal(routeSkills(skills,{task:'Use anthropic.frontend-design for this task'}).primary?.id,'anthropic.frontend-design');
 await fs.rm(project,{recursive:true});
 const installed=path.join(fixture,'local-skills','frontend-design'); await fs.mkdir(installed,{recursive:true}); await fs.writeFile(path.join(installed,'SKILL.md'),'---\nname: frontend-design\ndescription: Installed frontend design.\n---\nInstalled skill');
 skills=await loadProjectSkills(workspace); assert.equal(selectSkill(skills,'frontend-design').source,'installed'); assert.equal(routeSkills(skills,{task:'Use frontend-design for this task'}).primary?.source,'installed');
 const changed=await definitions.get('set_skill_enabled')({id:'anthropic.frontend-design',enabled:false}); assert.equal(changed.structuredContent.data.source,'builtin');
 skills=await resolveAllSkills(workspace); assert.equal(skills.find(s=>s.id==='anthropic.frontend-design').enabled,false); await assert.rejects(loadProjectSkill(workspace,'anthropic.frontend-design',1000),/Unknown Skill/);
 await definitions.get('set_skill_enabled')({id:'anthropic.frontend-design',source:'builtin',enabled:true}); assert.equal((await loadProjectSkill(workspace,'anthropic.frontend-design',1000)).skill.enabled,true);
 const manual=path.join(workspace,'.claude/skills/manual'); await fs.mkdir(manual,{recursive:true}); await fs.writeFile(path.join(manual,'SKILL.md'),'---\nname: manual\ndescription: manual specialized waveform test\ndisable-model-invocation: true\n---\nManual'); skills=await loadProjectSkills(workspace); assert.notEqual(routeSkills(skills,{task:'manual specialized waveform test'}).primary?.id,'manual'); await assert.rejects(loadProjectSkill(workspace,'manual',1000,{mode:'implicit'}),/does not allow/); assert.equal((await loadProjectSkill(workspace,'manual',1000,{mode:'explicit'})).content.includes('Manual'),true);
 const text='连续字节🙂中英 mixed\n'.repeat(30); await fs.writeFile(path.join(manual,'text.md'),text); const parts=[]; let opt={mode:'explicit',resource_path:'text.md',selection_id:'00000000-0000-4000-8000-000000000000'}; do {const part=await loadProjectSkill(workspace,'manual',13,opt); parts.push(part.content); opt=part.continuation?{...part.continuation,mode:'explicit'}:null;}while(opt); assert.equal(parts.join(''),text);
 const {createRuntimeScope,runWithRuntimeScope}=await import('../src/lib/runtime-scope.ts');
 const scoped=(account,conversation,transport,fn)=>runWithRuntimeScope(createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace],principalId:account},{sessionId:transport,_meta:{'openai/session':conversation}}),fn);
 const first=await scoped('account-a','conversation-a','transport-1',()=>loadProjectSkill(workspace,'manual',13,{mode:'explicit',resource_path:'text.md'}));
 const next=await scoped('account-a','conversation-a','transport-2',()=>loadProjectSkill(workspace,'manual',13,{mode:'explicit',resource_path:'text.md',selection_id:first.selection_id,offset_bytes:first.end_bytes}));
 assert.equal(next.selection_id,first.selection_id); assert.equal(next.content_receipt.selection_id,first.content_receipt.selection_id);
 for(const [account,conversation] of [['account-a','conversation-b'],['account-b','conversation-a']]) {
   const isolated=await scoped(account,conversation,'transport-3',()=>loadProjectSkill(workspace,'manual',13,{mode:'explicit',resource_path:'text.md',selection_id:first.selection_id}));
   assert.notEqual(isolated.selection_id,first.selection_id); assert.notEqual(isolated.content_receipt.account_session_task_binding,first.content_receipt.account_session_task_binding); assert.ok(isolated.content.length);
 }
 await fs.writeFile(path.join(manual,'binary.bin'),Buffer.from([0,1,2,255,42])); const bin=await loadProjectSkill(workspace,'manual',100,{mode:'explicit',resource_path:'binary.bin'}); assert.equal(bin.encoding,'base64'); assert.deepEqual(Buffer.from(bin.content,'base64'),Buffer.from([0,1,2,255,42]));
 const declared=await definitions.get('load_skill')({name:'manual',invocation_mode:'explicit',max_bytes:100,offset_bytes:0,evidence_action:'declare_application',statement:'Used this guidance'}); assert.equal(declared.structuredContent.data.evidence.kind,'model_application_declared'); assert.equal(declared.structuredContent.data.evidence.independently_verified,false);
 let auditRows=(await fs.readFile(process.env.AUDIT_LOG_PATH,'utf8')).trim().split('\n').map(JSON.parse); let recent=auditRows.slice(-2);
 assert.equal(recent[0].action,'skill_content_constructed'); assert.equal(recent[1].action,'skill_application_declared');
 assert.equal(recent[0].details.selection_id,declared.structuredContent.data.selection_id); assert.equal(recent[1].details.selection_id,declared.structuredContent.data.selection_id);
 const artifact=path.join(workspace,'artifact.txt'); await fs.writeFile(artifact,'fixture artifact');
 const verified=await definitions.get('load_skill')({name:'manual',invocation_mode:'explicit',max_bytes:100,offset_bytes:0,evidence_action:'verify_artifact',artifact_path:artifact,expected_artifact_sha256:sha('fixture artifact')});
 assert.equal(verified.structuredContent.data.evidence.workflow_quality_verified,false); assert.equal(verified.structuredContent.data.evidence.hash_matches,true);
 auditRows=(await fs.readFile(process.env.AUDIT_LOG_PATH,'utf8')).trim().split('\n').map(JSON.parse); recent=auditRows.slice(-2);
 assert.equal(recent[0].action,'skill_content_constructed'); assert.equal(recent[1].action,'skill_artifact_hash_checked'); assert.equal(recent[0].details.selection_id,verified.structuredContent.data.selection_id); assert.equal(recent[1].details.selection_id,verified.structuredContent.data.selection_id);
 await assert.rejects(loadProjectSkill(workspace,'manual',100,{mode:'explicit',resource_path:'../outside'}),/RESOURCE_/);
 // Compare every pre-existing upstream byte; additions only are the adaptation SKILL.md files.
 let compared=0; async function compare(dir,rel=''){for(const e of await fs.readdir(dir,{withFileTypes:true})){const next=path.join(rel,e.name), src=path.join(dir,e.name); if(e.isDirectory())await compare(src,next); else if(e.isFile() && (next.startsWith('references'+path.sep+'skills'+path.sep) || next==='THIRD_PARTY_NOTICES.md')){assert.equal(sha(await fs.readFile(src)),sha(await fs.readFile(path.join(root,next))),next);compared++;}}} 
 let baselineAvailable=true; try { await fs.access(original); } catch { baselineAvailable=false; }
 if (process.env.WH_SKILL_BASELINE && !baselineAvailable) throw new Error('WH_SKILL_BASELINE does not exist');
 if (baselineAvailable) { await compare(original); assert.ok(compared>100); }
 assert.equal(manifest.children.some(s=>['docx','pdf','pptx','xlsx'].includes(s)),false);
 console.log(`v32 skills PASS: 14 list/route/load/direct resource/license; pagination; 14 positive, provider negatives; alias precedence; disabled/manual-only; UTF-8 continuation, binary, traversal, legacy selection, stale hashes; ${baselineAvailable ? `${compared} original files hash-verified` : 'baseline comparison skipped (not present)'}`);
} finally { await fs.rm(fixture,{recursive:true,force:true,maxRetries:8,retryDelay:100}); }



