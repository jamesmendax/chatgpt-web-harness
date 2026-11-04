import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

// Run with node --import tsx; all files and state are confined to a temp directory.
const originalCwd = process.cwd();
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'binary-upload-regression-'));
// Keep the transpiler service's cwd outside the fixture: esbuild retains its
// startup directory on Windows. All tool paths/state below are absolute.
process.env.WORKSPACE_PATH = temp;
process.env.FULL_DISK_ACCESS = 'true';
process.env.CHECKPOINT_PATH = path.join(temp, 'checkpoints');
process.env.AUDIT_LOG_PATH = path.join(temp, 'audit.jsonl');
const { registerFilesystemTools } = await import('../src/tools/filesystem.ts');
const { writeAll } = await import('../src/lib/binary-upload.ts');
let handler;
registerFilesystemTools({registerTool(name, schema, fn) { if (name === 'write_file_base64') handler = fn; }}, temp);
assert.equal(typeof handler, 'function');
const hash = b => createHash('sha256').update(b).digest('hex');
const call = async (name, content, extra = {}) => (await handler({path:path.join(temp,name), content:Buffer.from(content).toString('base64'), offset:0, truncate:true, ...extra})).structuredContent.data;
const read = name => fs.readFile(path.join(temp,name),'utf8');
async function test(name, fn) { await fn(); console.log('PASS '+name); }
try {
  await test('interleaved-transfers-are-isolated-and-conflict-on-publish', async () => {
    const a=await call('interleave','abc',{expected_size:6});
    const b=await call('interleave','XYZ',{expected_size:6});
    assert.notEqual(a.transfer_id,b.transfer_id);
    const done=await call('interleave','def',{expected_size:6,transfer_id:a.transfer_id,offset:3,truncate:false});
    assert.equal(done.finalized,true); assert.equal(await read('interleave'),'abcdef');
    await assert.rejects(call('interleave','123',{expected_size:6,transfer_id:b.transfer_id,offset:3,truncate:false}),/WRITE_CONFLICT/);
    assert.equal(await read('interleave'),'abcdef');
  });
  await test('concurrent-same-transfer-chunks-serialize', async () => {
    const start=await call('race','abc',{expected_size:9});
    const opts={expected_size:9,transfer_id:start.transfer_id,offset:3,truncate:false};
    const results=await Promise.allSettled([call('race','def',opts),call('race','XYZ',opts)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.match(results.find(r=>r.status==='rejected').reason.message,/UPLOAD_CONFLICT/);
    const winner=results.find(r=>r.status==='fulfilled').value;
    assert.equal(winner.next_offset,6);
    const final=await call('race','ghi',{...opts,offset:6});
    assert.equal(final.finalized,true);
    assert.ok(['abcdefghi','abcXYZghi'].includes(await read('race')));
  });
  await test('unrelated-hardlinked-part-preserved', async () => {
    await fs.writeFile(path.join(temp,'victim'),'precious');
    await fs.link(path.join(temp,'victim'),path.join(temp,'linked.part'));
    const start=await call('linked','abc',{expected_size:6});
    assert.equal(await read('victim'),'precious'); assert.equal(await read('linked.part'),'precious');
    await call('linked','def',{expected_size:6,transfer_id:start.transfer_id,offset:3,truncate:false});
    assert.equal(await read('victim'),'precious'); assert.equal(await read('linked.part'),'precious');
  });
  await test('first-chunk-retry-preserves-later-bytes-and-returns-current-offset', async () => {
    const start=await call('retry','abc',{expected_size:9});
    const id=start.transfer_id;
    await call('retry','def',{expected_size:9,transfer_id:id,offset:3,truncate:false});
    const retry=await call('retry','abc',{expected_size:9,transfer_id:id});
    assert.equal(retry.idempotent_retry,true); assert.equal(retry.bytes_written,0); assert.equal(retry.next_offset,6);
    await assert.rejects(call('retry','abX',{expected_size:9,transfer_id:id}),/UPLOAD_CONFLICT/);
    await assert.rejects(call('retry','ghi',{expected_size:9,offset:6,truncate:false}),/UPLOAD_ID_REQUIRED/);
    const done=await call('retry','ghi',{expected_size:9,transfer_id:id,offset:6,truncate:false});
    assert.equal(done.finalized,true); assert.equal(await read('retry'),'abcdefghi');
    const finalRetry=await call('retry','ghi',{expected_size:9,transfer_id:id,offset:6,truncate:false});
    assert.equal(finalRetry.idempotent_retry,true); assert.equal(finalRetry.finalized,true);
    await fs.writeFile(path.join(temp,'retry'),'replacement');
    await assert.rejects(call('retry','ghi',{expected_size:9,transfer_id:id,offset:6,truncate:false}),/UPLOAD_CONFLICT/);
  });
  await test('replaced-staging-hardlink-cannot-write-outside-file', async () => {
    const start=await call('stage-linked','abc',{expected_size:6});
    const victim=path.join(temp,'outside-victim');
    await fs.writeFile(victim,'precious');
    await fs.unlink(start.staging_path);
    await fs.link(victim,start.staging_path);
    await assert.rejects(call('stage-linked','def',{expected_size:6,transfer_id:start.transfer_id,offset:3,truncate:false}),/staging file was linked or replaced/);
    assert.equal(await fs.readFile(victim,'utf8'),'precious');
  });
  await test('target-change-and-parameter-mismatch-rejected', async () => {
    await fs.writeFile(path.join(temp,'changed'),'old');
    const start=await call('changed','abc',{expected_size:6,expected_sha256:hash('abcdef')});
    await assert.rejects(call('changed','def',{expected_size:6,transfer_id:start.transfer_id,offset:3,truncate:false}),/UPLOAD_CONFLICT/);
    await fs.writeFile(path.join(temp,'changed'),'external');
    await assert.rejects(call('changed','def',{expected_size:6,expected_sha256:hash('abcdef'),transfer_id:start.transfer_id,offset:3,truncate:false}),/WRITE_CONFLICT/);
    assert.equal(await read('changed'),'external');
  });
  await test('short-writes-and-zero-progress', async () => {
    const output=Buffer.alloc(6); let calls=0;
    await writeAll({async write(b,start,len,pos) { calls++; const count=Math.min(len,2); b.copy(output,pos,start,start+count); return {bytesWritten:count,buffer:b}; }},Buffer.from('abcdef'),0);
    assert.equal(output.toString(),'abcdef'); assert.equal(calls,3);
    await assert.rejects(writeAll({async write(b) { return {bytesWritten:0,buffer:b}; }},Buffer.from('x'),0),/zero or invalid write progress/);
    const start=await call('fault','abc',{expected_size:6});
    const original=fs.open;
    fs.open=async function(file, flags, ...rest) {
      const h=await original.call(this,file,flags,...rest);
      if (String(file).includes(`.upload-${start.transfer_id}.part`) && flags === 'r+') {
        const write=h.write.bind(h); let n=0;
        h.write=async (...args) => { if(n++===0) return write(args[0],args[1],1,args[3]); return {bytesWritten:0,buffer:args[0]}; };
      }
      return h;
    };
    try { await assert.rejects(call('fault','def',{expected_size:6,transfer_id:start.transfer_id,offset:3,truncate:false}),/zero or invalid write progress/); }
    finally { fs.open=original; }
    const done=await call('fault','def',{expected_size:6,transfer_id:start.transfer_id,offset:3,truncate:false});
    assert.equal(done.next_offset,6); assert.equal(await read('fault'),'abcdef');
  });
  console.log('binary-upload-integrity: all tests passed');
} finally { process.chdir(originalCwd); await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
