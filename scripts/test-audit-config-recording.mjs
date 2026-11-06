import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootstrapIsolatedTestEnv, assertAuditFixture } from './lib/isolated-test-env.mjs';
const fixture=await bootstrapIsolatedTestEnv('audit-config-recording');
const tmp=fixture.root;
const source=path.join(tmp,'source'),localSkillsDir=path.join(tmp,'local-skills'),registryPath=path.join(tmp,'plugins.json');
process.env.CHATGPT_PLUGINS_CONFIG=registryPath;
await assertAuditFixture(fixture,await import('../dist/lib/audit.js'),'audit-config-recording');
if(process.argv.includes('--isolation-only'))process.exit(0);
const { installSkill, setSkillEnabled, uninstallSkill } = await import('../dist/lib/skill-installer.js');
const { readLocalPluginsConfig, saveLocalPluginsConfigAt } = await import('../dist/lib/plugin-config.js');
const { createDurableTask, recordToolObservation, getDurableTask } = await import('../dist/lib/durable-tasks.js');
const { createRuntimeScope, runWithRuntimeScope } = await import('../dist/lib/runtime-scope.js');
await fs.mkdir(source,{recursive:true});
await fs.writeFile(path.join(source,'SKILL.md'),'---\nname: fixture\ndescription: Audit fixture\n---\noriginal\n');
const options={source,id:'fixture',localSkillsDir,registryPath};
await installSkill(options);
const cases={
 config:async()=>{
  const broken='{"schema_version":2,"skills":[{"id":"other","enabled":false}],}';
  await fs.writeFile(registryPath,broken);
  const before=await fs.readFile(path.join(localSkillsDir,'fixture','SKILL.md'),'utf8');
  assert.throws(()=>readLocalPluginsConfig(registryPath),/配置|config/i);
  await assert.rejects(setSkillEnabled({...options,id:'fixture',enabled:false}),/配置|config/i);
  await assert.rejects(installSkill(options),/配置|config/i);
  await assert.rejects(uninstallSkill({...options,id:'fixture'}),/配置|config/i);
  assert.throws(()=>saveLocalPluginsConfigAt(registryPath,{schema_version:2,skills:[]}),/配置|config/i);
  assert.equal(await fs.readFile(registryPath,'utf8'),broken);
  assert.equal(await fs.readFile(path.join(localSkillsDir,'fixture','SKILL.md'),'utf8'),before);
 },
 disabled:async()=>{
  await fs.writeFile(registryPath,JSON.stringify({schema_version:2,skills:[{id:'fixture',source:'installed',enabled:false}]}));
  await installSkill(options);
  assert.equal(readLocalPluginsConfig(registryPath).skills[0].enabled,false);
 },
 error:async()=>{
  const workspace=path.join(tmp,'workspace');await fs.mkdir(workspace,{recursive:true});
  await runWithRuntimeScope(createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:'audit'}),async()=>{
   const task=await createDurableTask(workspace,{goal:'Verify external tool failure recording'});
   await recordToolObservation(workspace,'upstream__fixture',{}, {isError:true,content:[{type:'text',text:'fixture upstream failure'}]});
   const saved=await getDurableTask(workspace,task.id);
   assert.equal(saved.last_failure?.tool,'upstream__fixture');
   assert.equal(saved.recent_events.at(-1)?.ok,false);
   assert.match(saved.last_failure.summary,/fixture upstream failure/);
  });
 }
};
let failures=0;
for(const [name,run] of Object.entries(cases)){
 if(process.argv[2]&&process.argv[2]!==name)continue;
 try{await run();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+': '+error.message);}
}
if(failures)process.exitCode=1;
