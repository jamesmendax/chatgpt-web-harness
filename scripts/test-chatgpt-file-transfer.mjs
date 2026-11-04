import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Synthetic, in-process HTTPS responses exercise the actual tool handler.
// This test NEVER claims that a real ChatGPT cloud download succeeded.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.resolve(process.env.HARNESS_TRANSFER_DIST || path.join(root, 'dist'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-transfer-regression-'));
const originalCwd = process.cwd();
process.chdir(temp);
process.env.WORKSPACE_PATH = temp;
process.env.FULL_DISK_ACCESS = 'true';
process.env.CHECKPOINT_PATH = path.join(temp, 'checkpoints');
process.env.AUDIT_LOG_PATH = path.join(temp, 'audit.jsonl');
delete process.env.HARNESS_FILE_DOWNLOAD_PROXY;
process.env.NO_PROXY = '*'; // Synthetic responses only; never use host network.
process.env.no_proxy = '*';
const { registerFilesystemTools, streamResponseBodyToFile, describeChatGptTransferError,
  MAX_CHATGPT_FILE_BYTES, DEFAULT_CHATGPT_FILE_TIMEOUT_MS, MAX_CHATGPT_FILE_TIMEOUT_MS,
  lookupFileAddresses, assertPublicHttpsUrl } =
  await import(pathToFileURL(path.join(dist, 'tools/filesystem.js')).href);
let spec, handler;
registerFilesystemTools({ registerTool(name, schema, fn) { if (name === 'save_chatgpt_file') { spec = schema; handler = fn; } } }, temp, {fetchResponse:(url,signal,route)=>{assert.equal(route.mode,'direct');return globalThis.fetch(url,{signal,redirect:'manual',headers:{'User-Agent':'chatgpt-local-coder/1.0','Accept-Encoding':'identity'}})}});
assert.equal(typeof handler, 'function');
const realFetch = globalThis.fetch;
const tests = [];
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function fileHash(file) { const h=createHash('sha256');for await(const b of createReadStream(file))h.update(b);return h.digest('hex'); }
async function test(name, action) {
  const started=Date.now();
  try { const detail=await action();tests.push({name,passed:true,ms:Date.now()-started,...detail});console.log('PASS '+name); }
  catch(e) { tests.push({name,passed:false,error:e.message});console.error('FAIL '+name+' '+e.stack); }
}
const fixture = (name, size) => ({ file_id: 'local-synthetic-fixture', download_url: 'https://93.184.216.34/'+name+'?sig=TEST_SECRET', file_name:name, ...(size===undefined?{}:{size}) });
async function save(name, fetcher, options={}) {
  globalThis.fetch=fetcher;
  const result=await handler({file:fixture(name,options.size),path:path.join(temp,name),...options}, {signal:options.signal});
  return result.structuredContent.data;
}
async function noParts() { assert.deepEqual((await fs.readdir(temp)).filter(x=>/\.\d+\.[0-9a-f-]+\.part$/i.test(x)),[]); }
try {
  await test('advertised-schema-preserves-fileParams-and-bounded-options', async()=>{
    assert.deepEqual(spec._meta['openai/fileParams'],['file']);
    assert.equal(MAX_CHATGPT_FILE_BYTES,536870912);assert.equal(DEFAULT_CHATGPT_FILE_TIMEOUT_MS,120000);assert.equal(MAX_CHATGPT_FILE_TIMEOUT_MS,900000);
    assert.equal(spec.inputSchema.timeout_ms.safeParse(900000).success,true);
    assert.equal(spec.inputSchema.timeout_ms.safeParse(900001).success,false);
    assert.equal(spec.inputSchema.file.safeParse({file_id:'id',download_url:'https://93.184.216.34/x'}).success,true);
    assert.equal(spec.inputSchema.file.safeParse('sandbox:/mnt/data/a').success,false);
  });
  await test('hung-DNS-obeys-deadline-and-late-success-is-ignored',async()=>{
    let finish;let calls=0;const controller=new AbortController();
    const pending=lookupFileAddresses('fixture.invalid',controller.signal,()=>{calls++;return new Promise(resolve=>{finish=resolve})});
    const timer=setTimeout(()=>controller.abort(new DOMException('DNS deadline','TimeoutError')),30);
    try{await assert.rejects(pending,/DNS deadline/);}finally{clearTimeout(timer)}
    assert.equal(calls,1);finish([{address:'93.184.216.34',family:4}]);await delay(0);
  });
  await test('caller-cancel-DNS-and-late-rejection-are-observed',async()=>{
    let fail;const controller=new AbortController();
    const pending=assertPublicHttpsUrl('https://fixture.invalid/file',controller.signal,false,()=>new Promise((_,reject)=>{fail=reject}));
    await delay(0);controller.abort();await assert.rejects(pending,/AbortError/);
    fail(new Error('late resolver failure'));await delay(0);
  });
  await test('pre-aborted-DNS-does-not-dispatch-resolver',async()=>{
    let calls=0;await assert.rejects(lookupFileAddresses('fixture.invalid',AbortSignal.abort(),async()=>{calls++;return[]}),/AbortError/);assert.equal(calls,0);
  });
  await test('fake-IP-DNS-allowed-only-for-selected-proxy',async()=>{
    const resolver=async()=>[{address:'198.18.0.1',family:4}];const signal=new AbortController().signal;
    await assert.rejects(assertPublicHttpsUrl('https://fixture.invalid/file',signal,false,resolver),/private\/reserved/);
    assert.equal((await assertPublicHttpsUrl('https://fixture.invalid/file',signal,true,resolver)).hostname,'fixture.invalid');
    await assert.rejects(assertPublicHttpsUrl('https://198.18.0.1/file',signal,true,resolver),/private\/reserved/);
    await assert.rejects(assertPublicHttpsUrl('https://user:password@fixture.invalid/file',signal,true,resolver),/credentials/);
  });
  await test('pre-aborted-handler-does-not-create-parent-lock-checkpoint-or-fetch',async()=>{
    let calls=0;const before=(await fs.readdir(temp)).sort();
    await assert.rejects(save('not-created/deep/file',async()=>{calls++;return new Response('x')},{signal:AbortSignal.abort()}),/AbortError/);
    assert.equal(calls,0);assert.deepEqual((await fs.readdir(temp)).sort(),before);
  });
  await test('head-read-is-staging-only-and-final-read-denial-cannot-fail-commit',async()=>{
    const original=fs.open;const target=path.join(temp,'head-before-commit');let stagingReads=0;
    fs.open=async function(file,flags,...rest){if(String(file)===target&&flags==='r')throw Object.assign(new Error('final read denied'),{code:'EACCES'});if(String(file).endsWith('.part')&&flags==='r')stagingReads++;return original.call(this,file,flags,...rest)};
    try{const r=await save('head-before-commit',async()=>new Response('abc'));assert.equal(r.finalized,true);assert.equal(r.first_bytes_hex,'616263');assert.equal(stagingReads,1);assert.equal(await fs.readFile(target,'utf8'),'abc');}finally{fs.open=original}
  });
  await test('staging-head-failure-preserves-old-target',async()=>{
    const original=fs.open;const target=path.join(temp,'head-fails');await fs.writeFile(target,'old');
    fs.open=async function(file,flags,...rest){if(String(file).endsWith('.part')&&flags==='r')throw Object.assign(new Error('staging read denied'),{code:'EACCES'});return original.call(this,file,flags,...rest)};
    try{await assert.rejects(save('head-fails',async()=>new Response('new')),/EACCES/);assert.equal(await fs.readFile(target,'utf8'),'old');await noParts();}finally{fs.open=original}
  });
  await test('abort-during-prepublication-read-prevents-late-publish',async()=>{
    const original=fs.open;const controller=new AbortController();const target=path.join(temp,'abort-at-head');await fs.writeFile(target,'old');
    fs.open=async function(file,flags,...rest){if(String(file).endsWith('.part')&&flags==='r')controller.abort();return original.call(this,file,flags,...rest)};
    try{await assert.rejects(save('abort-at-head',async()=>new Response('new'),{signal:controller.signal}),/AbortError/);assert.equal(await fs.readFile(target,'utf8'),'old');await noParts();}finally{fs.open=original}
  });
  for(const mib of [1,16,64,128]) await test('synthetic-stream-'+mib+'-MiB-complete-and-hash-matched',async()=>{
    const bytes=mib*1024*1024, chunk=Buffer.alloc(65536,0x63),expected=createHash('sha256');let produced=0;
    const response=new Response(new ReadableStream({pull(controller){if(produced>=bytes){controller.close();return;}const part=chunk.subarray(0,Math.min(chunk.length,bytes-produced));produced+=part.length;expected.update(part);controller.enqueue(part)}}));
    const file=path.join(temp,'stream-'+mib+'.bin');let last=0;
    const r=await streamResponseBodyToFile(response,file,MAX_CHATGPT_FILE_BYTES,{exclusive:true,onProgress:b=>{assert.ok(b>=last);last=b;}});
    assert.equal(r.bytes,bytes);assert.equal(last,bytes);assert.equal((await fs.stat(file)).size,bytes);assert.equal(r.sha256,expected.digest('hex'));assert.equal(await fileHash(file),r.sha256);
    await fs.unlink(file);return {bytes,sha256:r.sha256,transport:'synthetic-response-not-cloud'};
  });
  await test('stream-cap-checks-next-chunk-before-writing',async()=>{
    const f=path.join(temp,'cap.bin');await assert.rejects(streamResponseBodyToFile(new Response(Buffer.alloc(4097)),f,4096),/safety limit/);assert.equal((await fs.stat(f)).size,0);
  });
  await test('metadata-over-512-MiB-rejected-without-network',async()=>{
    let calls=0;await assert.rejects(save('too-large',async()=>{calls++;return new Response('x')},{size:MAX_CHATGPT_FILE_BYTES+1}),/TOO_LARGE/);assert.equal(calls,0);
  });
  await test('successful-handler-publishes-and-reports-sha256',async()=>{
    const payload=Buffer.from('Original UTF-8 bytes: test\n');const r=await save('ok.txt',async(_,init)=>{assert.equal(init.headers['Accept-Encoding'],'identity');return new Response(payload,{headers:{'content-length':String(payload.length)}})},{size:payload.length,expected_sha256:hash(payload)});
    assert.equal(r.finalized,true);assert.equal(r.sha256,hash(payload));assert.equal(await fileHash(r.path),r.sha256);await noParts();
  });
  await test('failed-download-preserves-old-file-and-unrelated-part',async()=>{
    const f=path.join(temp,'preserve.txt');await fs.writeFile(f,'old');await fs.writeFile(f+'.part','belongs to another writer');
    let n=0;const broken=new Response(new ReadableStream({pull(c){if(n++===0)c.enqueue(Buffer.from('partial'));else c.error(Object.assign(new Error('Connection reset'),{code:'ECONNRESET'}));}}));
    await assert.rejects(save('preserve.txt',async()=>broken),/code=ECONNRESET/);assert.equal(await fs.readFile(f,'utf8'),'old');assert.equal(await fs.readFile(f+'.part','utf8'),'belongs to another writer');await noParts();
  });
  await test('hash-mismatch-does-not-publish',async()=>{
    await assert.rejects(save('wrong-hash',async()=>new Response('abc'),{expected_sha256:'0'.repeat(64)}),/HASH_MISMATCH/);await assert.rejects(fs.stat(path.join(temp,'wrong-hash')),/ENOENT/);await noParts();
  });
  await test('size-mismatch-does-not-publish',async()=>{
    await assert.rejects(save('wrong-size',async()=>new Response('abc'),{size:9}),/size mismatch/);await noParts();
  });
  await test('decoded-encoded-response-not-compared-to-wire-length',async()=>{
    const r=await save('encoded',async()=>new Response('decoded bytes',{headers:{'content-encoding':'gzip','content-length':'5'}}),{size:13});assert.equal(r.size,13);
  });
  await test('host-cancel-aborts-hung-body-without-publication',async()=>{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),50);
    try{await assert.rejects(save('cancelled',async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]));}})),{signal:controller.signal}),/AbortError/);}finally{clearTimeout(timer)}
    await assert.rejects(fs.stat(path.join(temp,'cancelled')),/ENOENT/);await noParts();
  });
  await test('configurable-total-timeout-covers-body',async()=>{
    const keepAlive=setInterval(()=>{},100);
    try{await assert.rejects(save('timeout',async()=>new Response(new ReadableStream()),{timeout_ms:1000}),/TimeoutError/);}finally{clearInterval(keepAlive)}
    await noParts();
  });
  await test('concurrent-same-target-writers-do-not-share-part',async()=>{
    let inFlight=0,maxFlight=0;
    globalThis.fetch=async()=>{inFlight++;maxFlight=Math.max(maxFlight,inFlight);await delay(80);inFlight--;return new Response('serialized bytes')};
    const args={file:fixture('concurrent.txt'),path:path.join(temp,'concurrent.txt')};const [a,b]=await Promise.all([handler(args,{}),handler(args,{})]);
    assert.equal(maxFlight,1);assert.equal(a.structuredContent.data.finalized,true);assert.equal(b.structuredContent.data.finalized,true);assert.equal(await fs.readFile(args.path,'utf8'),'serialized bytes');await noParts();
  });
  await test('redirect-body-cancelled-and-private-target-rejected',async()=>{
    let cancelled=false,calls=0;
    await assert.rejects(save('redirect',async()=>{calls++;return new Response(new ReadableStream({cancel(){cancelled=true}}),{status:302,headers:{location:'https://127.0.0.1/private'}})}),/private\/reserved/);
    assert.equal(cancelled,true);assert.equal(calls,1);await noParts();
  });
  await test('five-redirects-allowed-sixth-rejected-and-bodies-cancelled',async()=>{
    let calls=0,cancelled=0;
    const redirect=()=>new Response(new ReadableStream({cancel(){cancelled++}}),{status:302,headers:{location:'https://93.184.216.34/next'}});
    const r=await save('five-redirects',async()=>++calls<=5?redirect():new Response('ok'));
    assert.equal(r.finalized,true);assert.equal(calls,6);assert.equal(cancelled,5);
    calls=0;cancelled=0;await assert.rejects(save('six-redirects',async()=>{calls++;return redirect()}),/exceeded 5 redirects/);
    assert.equal(calls,6);assert.equal(cancelled,6);await noParts();
  });
  await test('failure-contains-cause-and-redacts-signed-url',async()=>{
    const error=new TypeError('fetch failed',{cause:Object.assign(new Error('connect EACCES https://files.example/file?sig=DO_NOT_LOG'),{code:'EACCES'})});
    const d=describeChatGptTransferError(error);assert.equal(d.code,'EACCES');assert.doesNotMatch(d.message,/DO_NOT_LOG|https:\/\//);
    await assert.rejects(save('denied',async()=>{throw error}),e=>/code=EACCES/.test(e.message)&&/downloaded_bytes=0/.test(e.message)&&!/DO_NOT_LOG/.test(e.message));await noParts();
  });
} finally {
  globalThis.fetch=realFetch;process.chdir(originalCwd);
  const report={at:new Date().toISOString(),tested_dist:dist,tests,passed:tests.filter(x=>x.passed).length,failed:tests.filter(x=>!x.passed).length,real_cloud_transfer:false};
  if(process.env.HARNESS_TRANSFER_REPORT)await fs.writeFile(process.env.HARNESS_TRANSFER_REPORT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({passed:report.passed,failed:report.failed,real_cloud_transfer:false}));
  await fs.rm(temp,{recursive:true,force:true});if(report.failed)process.exitCode=1;
}
