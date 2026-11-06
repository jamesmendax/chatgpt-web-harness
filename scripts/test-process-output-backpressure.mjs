import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceBase = process.env.PROCESS_OUTPUT_TEST_EVIDENCE_DIR || path.join(root, ".tool-test-tmp");
await fs.mkdir(evidenceBase, { recursive: true });
const evidence = await fs.mkdtemp(path.join(evidenceBase, "process-output-backpressure-"));
const temp = path.join(evidence, "temp"); await fs.mkdir(temp);
process.env.TEMP = temp; process.env.TMP = temp; process.env.CODEX_HOME = path.join(evidence, "codex-home");
const runtime = path.join(evidence, "runtime");
await fs.cp(path.join(root, "dist"), path.join(runtime, "dist"), { recursive: true });
await fs.copyFile(path.join(root, "package.json"), path.join(runtime, "package.json"));
const hashes = {};
for (const relative of ["src/process-host.ts", "src/lib/process-output-queue.ts"]) {
  let source;
  try { source = await fs.readFile(path.join(root, relative), "utf8"); } catch (error) { if (relative.endsWith("process-output-queue.ts") && error.code === "ENOENT") continue; throw error; }
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: relative, reportDiagnostics: true });
  assert.equal(result.diagnostics?.length || 0, 0);
  await fs.writeFile(path.join(runtime, relative.replace(/^src\//, "dist/").replace(/\.ts$/, ".js")), result.outputText);
  hashes[relative] = createHash("sha256").update(source).digest("hex");
}
await fs.writeFile(path.join(evidence, "source-files.json"), JSON.stringify(hashes, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const extractTagged = (log, stream) => {
  const tags = [...log.matchAll(/\[(stdout|stderr)\]\n/g)];
  let result = "";
  for (let index = 0; index < tags.length; index++) {
    if (tags[index][1] !== stream) continue;
    const start = tags[index].index + tags[index][0].length;
    let end = tags[index + 1]?.index ?? log.length;
    const trailer = log.indexOf("\n# ", start); if (trailer >= 0) end = Math.min(end, trailer);
    result += log.slice(start, end);
  }
  return result;
};

async function runHost(name, childSource, options = {}) {
  const directory = path.join(evidence, name); await fs.mkdir(directory);
  const childPath = path.join(directory, "child.mjs"); await fs.writeFile(childPath, childSource);
  const specPath = path.join(directory, "spec.json"), metricsPath = path.join(directory, "metrics.json");
  const spec = { version: 1, id: randomUUID(), shell: process.execPath, args: [childPath], cwd: directory, execution_mode: "argv", output_encoding: options.encoding || "utf-8", full_output_path: path.join(directory, "full.log"), stdout_path: path.join(directory, "stdout.log"), stderr_path: path.join(directory, "stderr.log"), state_path: path.join(directory, "state.json"), control_dir: path.join(directory, "commands") };
  await fs.writeFile(specPath, JSON.stringify(spec));
  const preloadPath = path.join(directory, "delayed-sink.mjs");
  await fs.writeFile(preloadPath, `
import fs from 'node:fs/promises'; import fsSync from 'node:fs'; import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const originalOpen=fs.open.bind(fs),originalSpawn=cp.spawn.bind(cp),metrics={pause:{stdout:0,stderr:0},resume:{stdout:0,stderr:0},accepted:0,written:0,max_backlog:0,max_chunk:0};
const metricsPath=${JSON.stringify(metricsPath)};
cp.spawn=function(file,args,options){const child=originalSpawn(file,args,options);if(args?.[0]===${JSON.stringify(childPath)}){for(const name of ['stdout','stderr']){const source=child[name],pause=source.pause,resume=source.resume;source.pause=function(...args){metrics.pause[name]++;return pause.apply(this,args)};source.resume=function(...args){metrics.resume[name]++;return resume.apply(this,args)};source.on('data',chunk=>{metrics.accepted+=chunk.length;metrics.max_chunk=Math.max(metrics.max_chunk,chunk.length);metrics.max_backlog=Math.max(metrics.max_backlog,metrics.accepted-metrics.written)})}child.on('exit',()=>{metrics.child_exit_at=Date.now()})}return child};
fs.open=async function(file,...args){const handle=await originalOpen(file,...args);if([${JSON.stringify(spec.stdout_path)},${JSON.stringify(spec.stderr_path)},${JSON.stringify(spec.full_output_path)}].includes(String(file))){const write=handle.write.bind(handle);handle.write=async function(value,offset,length,position){await new Promise(resolve=>setTimeout(resolve,${options.delayMs ?? 2}));const bytes=typeof value==='string'?Buffer.from(value):value;const start=typeof offset==='number'&&typeof value!=='string'?offset:0;const size=Math.min(typeof length==='number'?length:bytes.length-start,${options.partialBytes ?? 8192});const result=await write(bytes,start,size,typeof position==='number'?position:null);if(String(file)!==${JSON.stringify(spec.full_output_path)})metrics.written+=result.bytesWritten;return result}}return handle};
syncBuiltinESMExports();process.on('exit',()=>fsSync.writeFileSync(metricsPath,JSON.stringify(metrics)));
`);
  const host = spawn(process.execPath, ["--import", pathToFileURL(preloadPath).href, path.join(runtime, "dist/process-host.js"), specPath], { windowsHide: true, cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  let hostStdout = "", hostStderr = ""; host.stdout.on("data", chunk => { hostStdout += chunk; }); host.stderr.on("data", chunk => { hostStderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; host.kill(); }, options.timeoutMs ?? 30_000);
  try {
    const exit = await new Promise((resolve, reject) => { host.once("error", reject); host.once("close", (code, signal) => resolve({ code, signal })); });
    assert.equal(timedOut, false, `Managed host timeout: ${hostStderr}`);
    assert.equal(exit.code, 0, `Managed host failed: ${hostStderr}`);
    const state = JSON.parse(await fs.readFile(spec.state_path, "utf8"));
    const metrics = JSON.parse(await fs.readFile(metricsPath, "utf8"));
    assert.equal(state.running, false); assert.equal(state.exit_code, 0); assert.equal(state.log_error, undefined);
    await assert.rejects(fs.access(specPath), /ENOENT/, "One-use launch spec was not consumed");
    await fs.writeFile(path.join(directory, "host-output.json"), JSON.stringify({ host_pid: host.pid, hostStdout, hostStderr, exit, state, metrics }, null, 2));
    return { directory, spec, state, metrics };
  } finally { clearTimeout(timer); if (host.exitCode === null) host.kill(); }
}

const receipt = { test: "process-output-backpressure", evidence, passed: false, checks: [] };
try {
  if (!process.argv.includes("--host-only")) {
    const { ProcessOutputQueue, PostExitOutputDrain, writeAllProcessOutput } = await import(pathToFileURL(path.join(runtime, "dist/lib/process-output-queue.js")).href);
    const sources = [0, 1].map(() => ({ paused: false, pauses: 0, resumes: 0, pause() { this.paused = true; this.pauses++; }, resume() { this.paused = false; this.resumes++; } }));
    const delivered = [], pending = [];
    const queue = new ProcessOutputQueue(sources, async (stream, chunk) => { await new Promise(resolve => pending.push(resolve)); delivered.push({ stream, bytes: Buffer.from(chunk) }); }, { highWaterBytes: 128, lowWaterBytes: 32, highWaterChunks: 64, lowWaterChunks: 2 });
    const expected = [];
    for (let index = 0; index < 8; index++) { const chunk = Buffer.alloc(16, index); expected.push({ stream: index % 2 ? "stderr" : "stdout", bytes: chunk }); queue.enqueue(expected.at(-1).stream, chunk); }
    assert.equal(queue.pendingBytes, 128); assert.ok(sources.every(source => source.paused));
    const policy = new PostExitOutputDrain(0, 3000, 15000);
    assert.equal(policy.evaluate(5000, { pendingBytes: queue.pendingBytes, backpressured: queue.backpressured, bufferedBytes: 64, revision: queue.revision }), "wait", "Paused own data was mistaken for inherited pipes");
    for (let index = 0; index < 8; index++) { await delay(0); pending.shift()(); await delay(0); }
    await queue.idle();
    assert.deepEqual(delivered, expected); assert.ok(sources.every(source => !source.paused && source.resumes === 1));
    const flush = async () => { for (let turn = 0; turn < 5; turn++) await Promise.resolve(); };
    const stressSources = sources.map(() => ({ paused: false, pause() { this.paused = true; }, resume() { this.paused = false; } }));
    const stressPending = [], stressExpected = [], stressDelivered = [];
    const stress = new ProcessOutputQueue(stressSources, async (stream, bytes) => { await new Promise(resolve => stressPending.push(resolve)); stressDelivered.push({ stream, bytes: Buffer.from(bytes) }); }, { highWaterBytes: 128, lowWaterBytes: 32, highWaterChunks: 64, lowWaterChunks: 2 });
    let peak = 0;
    while (stressExpected.length < 2000 || stress.pendingChunks > 0) {
      while (stressExpected.length < 2000 && !stressSources[0].paused) {
        const entry = { stream: stressExpected.length % 2 ? "stderr" : "stdout", bytes: Buffer.alloc(16, stressExpected.length % 251) };
        stressExpected.push(entry); stress.enqueue(entry.stream, entry.bytes); peak = Math.max(peak, stress.pendingBytes);
      }
      if (stress.pendingChunks > 0) { assert.ok(stressPending.length); stressPending.shift()(); await flush(); }
    }
    await stress.idle(); assert.equal(peak, 128); assert.deepEqual(stressDelivered, stressExpected);
    const tinySources = stressSources.map(() => ({ paused: false, resumes: 0, pause() { this.paused = true; }, resume() { this.paused = false; this.resumes++; } }));
    const tinyPending = [], tinyBytes = [];
    const tiny = new ProcessOutputQueue(tinySources, async (_stream, bytes) => { await new Promise(resolve => tinyPending.push(resolve)); tinyBytes.push(Buffer.from(bytes)); }, { highWaterBytes: 1024, lowWaterBytes: 256, highWaterChunks: 8, lowWaterChunks: 2 });
    for (let index = 0; index < 8; index++) tiny.enqueue("stdout", Buffer.from([index]));
    assert.ok(tinySources.every(source => source.paused), "Small chunks escaped the pending-item limit");
    tiny.stopSources(); tiny.enqueue("stderr", Buffer.from("known readable buffer"));
    while (tiny.pendingChunks > 0) { tinyPending.shift()(); await flush(); }
    await tiny.idle(); assert.ok(tinySources.every(source => source.paused && source.resumes === 0));
    assert.deepEqual(Buffer.concat(tinyBytes), Buffer.concat([Buffer.from([0,1,2,3,4,5,6,7]), Buffer.from("known readable buffer")]));
    assert.equal(policy.evaluate(10000, { pendingBytes: 0, backpressured: false, bufferedBytes: 0, revision: queue.revision }), "wait");
    assert.equal(policy.evaluate(10001, { pendingBytes: 0, backpressured: false, bufferedBytes: 0, revision: queue.revision }), "wait");
    assert.equal(policy.evaluate(13002, { pendingBytes: 0, backpressured: false, bufferedBytes: 0, revision: queue.revision }), "idle-cutoff");
    assert.equal(new PostExitOutputDrain(0, 3000, 15000).evaluate(15000, { pendingBytes: 128, backpressured: true, bufferedBytes: 64, revision: 9 }), "grace-cutoff");
    const sinkBytes = []; await writeAllProcessOutput({ async write(bytes, offset, size) { const count = Math.min(size, 3); sinkBytes.push(Buffer.from(bytes.subarray(offset, offset + count))); return { bytesWritten: count }; } }, "中文😀 café");
    assert.equal(Buffer.concat(sinkBytes).toString(), "中文😀 café");
    await assert.rejects(writeAllProcessOutput({ async write() { return { bytesWritten: 0 }; } }, Buffer.from("x")), /zero|progress/i);
    for (const [encoding, bytes, expectedText] of [["utf-8", Buffer.from("中文😀 café"), "中文😀 café"], ["gbk", Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), "中文"]]) {
      const decoder = new TextDecoder(encoding); let text = "";
      const decodedQueue = new ProcessOutputQueue([], async (_stream, chunk) => { text += decoder.decode(chunk, { stream: true }); });
      for (const byte of bytes) decodedQueue.enqueue("stdout", Buffer.from([byte]));
      await decodedQueue.idle(); text += decoder.decode(); assert.equal(text, expectedText);
    }
    receipt.checks.push("combined byte/chunk hysteresis, serial order, blocked own-output drain, bounded inherited-pipe grace, partial write, split UTF-8/GBK");
  }

  const stdoutText = "stdout: 中文😀 café\n".repeat(60000), stderrText = "stderr: 状态🛠️ café\n".repeat(60000);
  const large = await runHost("finite-child", `const out=Buffer.from(${JSON.stringify(stdoutText.slice(0, stdoutText.length / 60000))}.repeat(60000)),err=Buffer.from(${JSON.stringify(stderrText.slice(0, stderrText.length / 60000))}.repeat(60000));await Promise.all([new Promise((resolve,reject)=>process.stdout.write(out,error=>error?reject(error):resolve())),new Promise((resolve,reject)=>process.stderr.write(err,error=>error?reject(error):resolve()))]);`);
  assert.ok(large.metrics.pause.stdout > 0 && large.metrics.pause.stderr > 0, "Output sink overload did not pause BOTH stdout/stderr readers");
  assert.ok(large.metrics.max_backlog <= 1024 * 1024 + 2 * large.metrics.max_chunk, `Combined pending output was unbounded: ${large.metrics.max_backlog}`);
  assert.deepEqual(await fs.readFile(large.spec.stdout_path), Buffer.from(stdoutText));
  assert.deepEqual(await fs.readFile(large.spec.stderr_path), Buffer.from(stderrText));
  const log = await fs.readFile(large.spec.full_output_path, "utf8");
  assert.equal(extractTagged(log, "stdout"), stdoutText); assert.equal(extractTagged(log, "stderr"), stderrText);
  assert.equal(large.state.stdout_bytes, Buffer.byteLength(stdoutText)); assert.equal(large.state.stderr_bytes, Buffer.byteLength(stderrText));
  assert.equal(large.state.decode_anomaly, false); assert.equal(large.state.stdio_held_by_descendant, undefined);
  receipt.checks.push({ finite_child: "passed", stdout_bytes: large.state.stdout_bytes, stderr_bytes: large.state.stderr_bytes, metrics: large.metrics });

  if (!process.argv.includes("--host-only")) {
    const descendantPath = path.join(evidence, "continuous-descendant.mjs"), endedPath = path.join(evidence, "descendant-ended.json"), startedPath = path.join(evidence, "descendant-started.json");
    await fs.writeFile(descendantPath, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(startedPath)},JSON.stringify({pid:process.pid,started_at:Date.now()}));process.on('exit',()=>fs.writeFileSync(${JSON.stringify(endedPath)},JSON.stringify({pid:process.pid,ended_at:Date.now()})));process.stdout.on('error',()=>process.exit(0));const chunk=Buffer.from('DESCENDANT:'+'x'.repeat(2036)+'\\n');let timer;function begin(){timer=setInterval(()=>{if(!process.stdout.write(chunk)){clearInterval(timer);process.stdout.once('drain',begin)}},5)}begin();setTimeout(()=>process.exit(0),25000);`);
    const started = Date.now();
    const inherited = await runHost("inherited-pipes", `import fs from 'node:fs/promises';import {spawn} from 'node:child_process';const child=spawn(process.execPath,[${JSON.stringify(descendantPath)}],{windowsHide:true,detached:true,stdio:['ignore',process.stdout,process.stderr]});child.unref();const deadline=Date.now()+5000;while(Date.now()<deadline){try{await fs.access(${JSON.stringify(startedPath)});break}catch{await new Promise(resolve=>setTimeout(resolve,25))}}await fs.access(${JSON.stringify(startedPath)});process.stdout.write('PARENT-END\\n');`);
    await fs.access(startedPath);
    assert.equal(inherited.state.stdio_held_by_descendant, true);
    assert.ok(Date.now() - started < 23000, "Continuously producing descendant kept the managed process running indefinitely");
    const raw = await fs.readFile(inherited.spec.stdout_path), inheritedLog = await fs.readFile(inherited.spec.full_output_path, "utf8");
    assert.equal(extractTagged(inheritedLog, "stdout"), raw.toString(), "Accepted descendant output was lost between raw and full logs");
    assert.match(inheritedLog, /output_capture_incomplete|stdio_held_by_descendant/);
    const deadline = Date.now() + 5000; while (Date.now() < deadline) { try { await fs.access(endedPath); break; } catch { await delay(25); } }
    await fs.access(endedPath);
    receipt.checks.push({ inherited_continuous_pipe: "passed", elapsed_ms: Date.now() - started, accepted_stdout_bytes: raw.length, descendant_self_exit: JSON.parse(await fs.readFile(endedPath, "utf8")) });
  }
  receipt.passed = true;
  console.log(`process-output-backpressure PASS: ${JSON.stringify(receipt.checks)}`);
} catch (error) { receipt.error = error instanceof Error ? error.stack : String(error); throw error; }
finally { await fs.writeFile(path.join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(`PROCESS_OUTPUT_TEST_RECEIPT ${JSON.stringify(receipt)}`); }
