"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), cp = require("node:child_process");
const { Writable } = require("node:stream");
const { artifactRoot } = require("./lib/test-isolation.cjs");
const { createCompletionObserver, verifyDesktopCompletionLog } = require("./lib/electron-test-completion.cjs");
const base = artifactRoot("electron-completion-contract");
function fixture() { return fs.mkdtempSync(path.join(base, "case-")); }
function boot(scope, value = { passed: true, fixture: scope }) {
  fs.writeFileSync(path.join(scope, "report.json"), JSON.stringify(value));
  return "AURA_OCCLUDED_BOOT " + JSON.stringify(value) + "\n";
}
function observer(target = "test-aura-boot.cjs", args = [], scope = fixture()) { return { scope, value: createCompletionObserver({ target, args, scope }) }; }
const success = { exitCode: 0, signal: null };

test("exit 0 without a completion signal fails; a real result and split UTF-8 signal succeeds", () => {
  const missing = observer(); assert.throws(() => missing.value.finish(success), /terminal completion/);
  const valid = observer(); const bytes = Buffer.from(boot(valid.scope, { passed: true, fixture: valid.scope, note: "实际完成" }));
  for (let i=0;i<bytes.length;i+=3) valid.value.write("stdout", bytes.subarray(i,i+3));
  const result = valid.value.finish(success); assert.ok(fs.existsSync(result.receipt));
  assert.equal(JSON.parse(fs.readFileSync(result.receipt)).passed, true);
});
test("failed, absent, outside-scope and duplicate completion evidence fails", () => {
  const failed = observer(); failed.value.write("stdout",Buffer.from(boot(failed.scope,{passed:false,fixture:failed.scope}))); assert.throws(()=>failed.value.finish(success),/did not report success/);
  const absent = observer(); absent.value.write("stdout",Buffer.from("AURA_OCCLUDED_BOOT "+JSON.stringify({passed:true,fixture:absent.scope})+"\n")); assert.throws(()=>absent.value.finish(success),/ENOENT/);
  const escaped = observer(), elsewhere=fixture(); escaped.value.write("stdout",Buffer.from(boot(elsewhere))); assert.throws(()=>escaped.value.finish(success),/escaped/);
  const duplicate = observer(), line=boot(duplicate.scope); duplicate.value.write("stdout",Buffer.from(line+line)); assert.throws(()=>duplicate.value.finish(success),/terminal completion/);
});
test("wrong memory mode, signal termination and nonzero exit cannot use a positive result", () => {
  const wrong = observer("test-renderer-memory-recovery.cjs",["--plain-crash"]);
  const payload={passed:true,fixture:wrong.scope,mode:"gpu"};fs.writeFileSync(path.join(wrong.scope,"result.json"),JSON.stringify(payload));
  wrong.value.write("stdout",Buffer.from("MEMORY_GUARD_NATIVE_ACCEPTANCE "+JSON.stringify(payload)+"\n"));assert.throws(()=>wrong.value.finish(success),/wrong memory mode/);
  for(const outcome of [{exitCode:1,signal:null},{exitCode:null,signal:"SIGTERM"}]) {const x=observer();x.value.write("stdout",Buffer.from(boot(x.scope)));assert.throws(()=>x.value.finish(outcome));}
});
test("a partial desktop batch cannot be accepted as all 15 invocations", () => {
  const x=observer();x.value.write("stdout",Buffer.from(boot(x.scope)));const row=x.value.finish(success);
  assert.throws(()=>verifyDesktopCompletionLog(""),/omitted or duplicated/);
  assert.throws(()=>verifyDesktopCompletionLog("DESKTOP_COMPONENT_COMPLETE "+JSON.stringify(row)+"\n"),/omitted or duplicated/);
});

async function runWrapper(childSource) {
  const scope=fixture(), filename=path.join(__dirname,"run-electron.cjs");
  const chunks={stdout:[],stderr:[]};
  const streams=Object.fromEntries(Object.keys(chunks).map(name=>[name,new Writable({write(chunk,_encoding,done){chunks[name].push(Buffer.from(chunk));setImmediate(done);}})]));
  const virtualProcess={argv:[process.execPath,filename,path.join(__dirname,"test-aura-boot.cjs")],env:{...process.env},cwd:()=>path.resolve(__dirname,".."),...streams,exitCode:0,exit(){throw Error("Wrapper must drain output before natural exit");}};
  let realNodeChildren=0;
  const sandbox={__dirname,process:virtualProcess,console:{log(s){streams.stdout.write(String(s)+"\n");},error(s){streams.stderr.write(String(s)+"\n");}},require(name){
    if(name==="electron")return "NO-GUI-EXECUTABLE";
    if(name==="./lib/test-isolation.cjs")return {artifactRoot:()=>scope,privatePorts:async()=>[61001,61002,61003],componentElectronTests:["test-aura-boot.cjs"]};
    if(name==="./lib/electron-test-completion.cjs")return require(name);
    if(name==="node:child_process")return {spawn(executable,args,options){assert.equal(executable,"NO-GUI-EXECUTABLE");assert.ok(args[0].endsWith("electron-test-bootstrap.cjs"));realNodeChildren++;return cp.spawn(process.execPath,["-e",childSource],options);}};
    return require(name);
  }};
  vm.createContext(sandbox);
  const source=fs.readFileSync(filename,"utf8").replace("main().catch(","globalThis.runPromise = main().catch(");
  new vm.Script(source,{filename}).runInContext(sandbox);await sandbox.runPromise;
  await Promise.all(Object.values(streams).map(stream=>new Promise(resolve=>stream.end(resolve))));
  assert.equal(realNodeChildren,1);
  return {exitCode:virtualProcess.exitCode,stdout:Buffer.concat(chunks.stdout).toString(),stderr:Buffer.concat(chunks.stderr).toString()};
}
test("actual wrapper rejects a real Node child that exits 0 before any terminal assertion", async () => {
  const result=await runWrapper("process.stdout.write('started but not completed\\n');process.stderr.write('fixture stderr retained\\n')");
  assert.equal(result.exitCode,1);assert.match(result.stdout,/started but not completed/);assert.match(result.stderr,/fixture stderr retained/);assert.match(result.stderr,/terminal completion/);
});
test("actual wrapper accepts a completed real Node child and preserves both output streams", async () => {
  const source="const fs=require('fs'),p=require('path'),scope=process.env.HARNESS_ELECTRON_TEST_SCOPE;const r={passed:true,fixture:scope};fs.writeFileSync(p.join(scope,'report.json'),JSON.stringify(r));process.stdout.write('diagnostic line\\n'.repeat(20000));process.stderr.write('stderr before completion\\n');console.log('AURA_OCCLUDED_BOOT '+JSON.stringify(r));";
  const result=await runWrapper(source);assert.equal(result.exitCode,0);assert.equal(result.stdout.split("diagnostic line\n").length-1,20000);assert.match(result.stderr,/stderr before completion/);assert.match(result.stdout,/DESKTOP_COMPONENT_COMPLETE /);
});
