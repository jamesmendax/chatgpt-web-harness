import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=process.env.HARNESS_TEST_DIST_ROOT?path.resolve(process.env.HARNESS_TEST_DIST_ROOT):path.join(root,'dist');
const load=file=>import(pathToFileURL(path.join(dist,file)).href);
const repl=await load('tools/node-repl.js');
const {createRuntimeScope,runWithRuntimeScope}=await load('lib/runtime-scope.js');
const {ComputerUseProvider}=await load('lib/computer-use-provider.js');

const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'repl-lifecycle-'));
process.env.CHATGPT_PLUGINS_CONFIG=path.join(tmp,'plugins.json');
await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG,JSON.stringify({schema_version:2,computer_use:{enabled:true},skills:[]}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const handler=()=>{let callback;repl.registerNodeReplTool({registerTool(_n,_o,cb){callback=cb;}},tmp);return callback;};
const invoke=(cb,session,code,timeout_ms=1000,signal)=>runWithRuntimeScope(createRuntimeScope({workspaceRoot:tmp,projectRoots:[tmp],principalId:'fixture'}, {sessionId:session,signal}),()=>cb({action:'eval',code,timeout_ms}));
let failures=0;
async function check(name,fn){try{await fn();console.log('PASS '+name);}catch(error){failures++;console.error('FAIL '+name+': '+error.message);}}
try{
 await check('timeout stops delayed effects and discards its state',async()=>{
  const cb=handler(),file=path.join(tmp,'late-effect.txt');
  await assert.rejects(invoke(cb,'timeout',`await new Promise(r=>setTimeout(r,350)); require('node:fs').writeFileSync(${JSON.stringify(file)},'late'); globalThis.late=true;`,100),/exceeded|timed out/);
  await delay(450);
  assert.equal(await fs.access(file).then(()=>true,()=>false),false);
  const next=await invoke(cb,'timeout',`nodeRepl.write('new'); return globalThis.late;`);
  assert.equal(next.structuredContent.data.value,undefined);
  assert.equal(next.structuredContent.data.output,'new');
 });
 await check('cancel terminates an async evaluation',async()=>{
  const cb=handler(),abort=new AbortController(),file=path.join(tmp,'cancelled-effect.txt');
  const pending=invoke(cb,'cancel',`await new Promise(r=>setTimeout(r,350)); require('node:fs').writeFileSync(${JSON.stringify(file)},'late');`,1000,abort.signal);
  setTimeout(()=>abort.abort(),70);
  await assert.rejects(pending,/cancel|abort/i);
  await delay(400);
  assert.equal(await fs.access(file).then(()=>true,()=>false),false);
 });
 await check('overlapping calls are serialized with separate output',async()=>{
  const cb=handler();
  const first=invoke(cb,'serial',`await new Promise(r=>setTimeout(r,150)); nodeRepl.write('first'); globalThis.finished=true;`);
  await delay(20);
  const second=invoke(cb,'serial',`nodeRepl.write('second'); return globalThis.finished;`);
  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.structuredContent.data.output,'first');
  assert.equal(b.structuredContent.data.output,'second');
  assert.equal(b.structuredContent.data.value,'true');
 });
 await check('fresh transports share only the same trusted conversation',async()=>{
  const a=handler(),b=handler();
  await invoke(a,'reconnect','globalThis.remember=42;');
  assert.equal((await invoke(b,'reconnect','return globalThis.remember;')).structuredContent.data.value,'42');
  assert.equal((await invoke(b,'other-conversation','return globalThis.remember;')).structuredContent.data.value,undefined);
  const foreign=await runWithRuntimeScope(createRuntimeScope({workspaceRoot:tmp,projectRoots:[tmp],principalId:'other-account'}, {sessionId:'reconnect'}),()=>b({action:'eval',code:'return globalThis.remember;',timeout_ms:1000}));
  assert.equal(foreign.structuredContent.data.value,undefined);
  await runWithRuntimeScope(createRuntimeScope({workspaceRoot:tmp,projectRoots:[tmp],principalId:'fixture'},{sessionId:'reconnect'}),()=>b({action:'reset'}));
  assert.equal((await invoke(a,'reconnect','return globalThis.remember;')).structuredContent.data.value,undefined);
 });
 await check('synchronous loops and worker exits reset only that session',async()=>{
  const cb=handler();
  await assert.rejects(invoke(cb,'sync','while(true){}',100),/exceeded|timed out/);
  assert.equal((await invoke(cb,'sync','return 7;')).structuredContent.data.value,'7');
  await assert.rejects(invoke(cb,'exit','process.exit(3);'),/worker exited/);
  assert.equal((await invoke(cb,'exit','return 8;')).structuredContent.data.value,'8');
 });
 await check('ordinary text output is not silently shortened',async()=>{
  const result=await invoke(handler(),'long-output',`nodeRepl.write('x'.repeat(70000));`);
  assert.equal(result.structuredContent.data.output,'x'.repeat(70000));
 });
 await check('long tasks retain state across a 90-minute gap and then expire when idle',async()=>{
  const realNow=Date.now,started=realNow();
  await invoke(handler(),'long-task','globalThis.longTaskValue=42;');
  try{
   Date.now=()=>started+90*60_000;
   assert.equal((await invoke(handler(),'long-task','return globalThis.longTaskValue;')).structuredContent.data.value,'42');
   Date.now=()=>started+4*60*60_000;
   assert.equal((await invoke(handler(),'long-task','return globalThis.longTaskValue;')).structuredContent.data.value,undefined);
  }finally{Date.now=realNow;}
 });
 await check('screenshot survives a following image-free bridge response',async()=>{
  const old=ComputerUseProvider.prototype.execute;
  ComputerUseProvider.prototype.execute=async request=>({data:{action:request.action},...(request.action==='screenshot'?{image:Buffer.from('fixture-png')}: {})});
  try{
   const result=await invoke(handler(),'bridge',`await sky.computerUse({action:'screenshot'}); await sky.computer_use({action:'status'});`);
   assert.equal(result.content.filter(x=>x.type==='image').length,1);
  }finally{ComputerUseProvider.prototype.execute=old;}
 });
}finally{
 await repl.closeNodeReplSessions?.();
}
if(failures)process.exitCode=1;
