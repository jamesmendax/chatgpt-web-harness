import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSkillDiscoveryAppender } from '../dist/lib/skill-discovery.js';
import { loadProjectSkill, loadProjectSkills } from '../dist/lib/skills-loader.js';
import { readIndexedSkillFile } from '../dist/lib/skill-index.js';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'skill-index-'));
const registry=path.join(tmp,'profiles/plugins.json'), dir=path.join(tmp,'profiles/local-skills/fixture');
await fs.mkdir(dir,{recursive:true});
await fs.writeFile(registry,JSON.stringify({schema_version:2,skills:[],computer_use:{enabled:false},browser_use:{enabled:false}}));
process.env.CHATGPT_PLUGINS_CONFIG=registry;process.env.CODEX_HOME=path.join(tmp,'home');
const skillPath=path.join(dir,'SKILL.md');
const body='---\nname: fixture\ndescription: Fixture workflow\n---\nFollow the fixture.\n';
await fs.writeFile(skillPath,body);
const originalRead=fs.readFile;
let bodyReads=0,displays=0;
fs.readFile=async function(file,...args){if(String(file)===skillPath)bodyReads++;return originalRead.call(this,file,...args);};
try{
 const result={content:[{type:'text',text:'original'}]};
 for(let i=0;i<20;i++){
  const appender=getSkillDiscoveryAppender(tmp);
  const response=await appender.append(result,'same-trusted-conversation','read_text_file');
  if(response.content.length>1)displays++;
 }
 assert.equal(bodyReads,1,'twenty unchanged calls should read a Skill body once');
 assert.equal(displays,2,'new server/appender lookups retain the twelve-call reminder cadence');
 await fs.appendFile(skillPath,'Changed fixture body.\n');
 assert.equal((await getSkillDiscoveryAppender(tmp).append(result,'same-trusted-conversation','read_text_file')).content.length,2);
 assert.equal(bodyReads,2,'only the changed body is reread');
 const newDir=path.join(tmp,'profiles/local-skills/new-skill');await fs.mkdir(newDir);
 await fs.writeFile(path.join(newDir,'SKILL.md'),body.replace('name: fixture','name: new-skill'));
 assert.ok((await loadProjectSkills(tmp,{includeLayout:false})).some(skill=>skill.id==='new-skill'));
 await fs.mkdir(path.join(dir,'agents'));
 await fs.writeFile(path.join(dir,'agents/openai.yaml'),'policy:\n  allow_implicit_invocation: false\n');
 await assert.rejects(loadProjectSkill(tmp,'fixture',1000,{mode:'implicit'}),/implicit|policy|manual/i);
 // Concurrent first reads of one file must count its cached bytes once. A
 // duplicate accounting charge would evict this otherwise admissible entry.
 const largeFile=path.join(tmp,'concurrent-body.md');
 await fs.writeFile(largeFile,Buffer.alloc(17*1024*1024,97));
 let largeReads=0;
 fs.readFile=async function(file,...args){if(String(file)===largeFile)largeReads++;return originalRead.call(this,file,...args);};
 await Promise.all([readIndexedSkillFile(largeFile),readIndexedSkillFile(largeFile)]);
 await readIndexedSkillFile(largeFile);
 assert.equal(largeReads,2,'concurrent cache fills must not evict an entry by double-counting bytes');
 console.log(`PASS 20 calls: body_reads=1 catalog_displays=${displays}; edits/new skills invalidate; loading rechecks policy`);
}finally{fs.readFile=originalRead;}
