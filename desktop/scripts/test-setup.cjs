"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const setupPath = path.resolve(__dirname, "../src/setup.js");
function fixture(done = false) {
  const events = [], cfg = { setupDone: done, tunnelId: "tunnel_fixture", apiKeyEnc: "fixture", workspacePath: "fixture" };
  const deps = { cfg, services: { withSetupMcp: async fn => { events.push("mcp-ready"); try { return await fn(); } finally { events.push("mcp-stop"); } }, runDoctor: async () => { events.push("doctor"); return { ok: true, output: "CHECK mcp_server_reachable PASS\nCHECK codex_plugin SKIP optional" }; } }, saveConfig: c => events.push(`save:${c.setupDone}`), decryptKey: () => "synthetic-key", publicView: c => ({ setupDone: c.setupDone }) };
  return { deps, events, cfg };
}
function mainSetupFixture(f) {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/main.js"), "utf8");
  const start = source.indexOf("async function runSetup(payload) {"), end = source.indexOf('\napp.on("before-quit"', start);
  assert.ok(start >= 0 && end > start);
  const context = { ...f.deps, require: name => name === "./setup" ? require(setupPath) : { ensureDotEnv() {} }, send() {}, applyConfigPayload() {}, fs: { mkdirSync() {}, existsSync: () => true }, paths: { ensureRuntimeDir() {}, distEntry: () => "fixture", tunnelClientPath: () => "fixture" }, configStore: { load: () => f.cfg, save: f.deps.saveConfig, decryptKey: f.deps.decryptKey, publicView: f.deps.publicView }, accounts: { validateConfig() {}, currentId: "fixture", emit() {} }, services: { ...f.deps.services, note() {}, refresh: async () => {} } };
  vm.runInNewContext(source.slice(start, end) + "\nthis.runSetup = runSetup;", context);
  return context.runSetup;
}
test("actual main runSetup makes local MCP ready before doctor", async () => {
  const f = fixture(), result = await mainSetupFixture(f)({});
  assert.equal(result.ok, true);
  assert.ok(f.events.indexOf("mcp-ready") >= 0 && f.events.indexOf("mcp-ready") < f.events.indexOf("doctor"), "doctor must see owned ready MCP, never a stopped local port");
});
test("actual main runSetup reports the observed local refusal without blaming the key", async () => {
  const f = fixture();
  f.deps.services.runDoctor = async () => ({ok:false,output:"CHECK mcp_server_reachable FAIL dial tcp 127.0.0.1:3300: connectex: No connection could be made because the target machine actively refused it.\nCHECK oauth_metadata FAIL connection refused\nCHECK codex_plugin SKIP optional"});
  const result = await mainSetupFixture(f)({});
  assert.equal(result.ok,false); assert.equal(result.code,"LOCAL_MCP_UNREACHABLE");
  assert.doesNotMatch(result.message,/Runtime API Key|Tunnels 权限/);
});
test("doctor supplied failure is local refusal, not authentication or optional plugin", () => {
  const { diagnoseSetupFailure } = require(setupPath);
  const output = "CHECK mcp_server_reachable FAIL dial tcp 127.0.0.1:3300: connectex: actively refused\nCHECK oauth_metadata FAIL connection refused\nCHECK codex_plugin SKIP optional";
  const failure = diagnoseSetupFailure({ output });
  assert.equal(failure.code, "LOCAL_MCP_UNREACHABLE");
  assert.equal(failure.checks.filter(c => c.status === "FAIL").length, 2);
  assert.doesNotMatch(failure.message, /Key|密钥错误|Tunnels 权限/);
});
test("initialize order, cleanup and setupDone commit", async () => {
  const { initializeAccount } = require(setupPath), f = fixture();
  const result = await initializeAccount(f.deps);
  assert.equal(result.ok, true); assert.equal(f.cfg.setupDone, true);
  assert.deepEqual(f.events, ["save:false", "mcp-ready", "doctor", "mcp-stop", "save:true"]);
});
test("failed reinitialization keeps old setupDone and redacts streamed/output secrets", async () => {
  const { initializeAccount } = require(setupPath), f = fixture(true), streamed=[];
  f.deps.progress = (stage, line) => streamed.push(line);
  f.deps.services.runDoctor = async (cfg, key, onLine) => { onLine("Authorization: Bearer " + key); return { ok: false, output: "CHECK control_plane_api_key FAIL HTTP 403 api_key=" + key }; };
  const result = await initializeAccount(f.deps);
  assert.equal(result.ok, false); assert.equal(result.code, "AUTH_REJECTED"); assert.equal(f.cfg.setupDone, true);
  assert.ok(f.events.includes("mcp-stop")); assert.doesNotMatch(JSON.stringify([result,streamed]), /synthetic-key/);
});
test("optional SKIP succeeds; OAuth, missing configuration and process failures stay distinct", async () => {
  const { diagnoseSetupFailure, initializeAccount } = require(setupPath);
  assert.equal(diagnoseSetupFailure({ output: "CHECK oauth_metadata FAIL HTTP 404" }).code, "OAUTH_METADATA_FAILED");
  assert.equal(diagnoseSetupFailure({ output: "CHECK tunnel_id FAIL missing" }).code, "MISSING_CONFIG");
  assert.equal(diagnoseSetupFailure({ error: Error("spawn ENOENT"), stage: "local-mcp" }).code, "LOCAL_MCP_START_FAILED");
  const f = fixture(); f.deps.services.withSetupMcp = async () => { throw Error("spawn ENOENT"); };
  assert.equal((await initializeAccount(f.deps)).ok, false); assert.equal(f.cfg.setupDone, false);
});

function serviceFixture({ alive = false, external = false, adminOccupied = false, mcpOccupied = false, ready = true, healthPid = 42, portError = false, doctorSpawn } = {}) {
  const filename = path.resolve(__dirname, "../src/services.js"), { createRequire } = require("node:module"), realRequire = createRequire(filename);
  const events=[], module={exports:{}}, cfg={setupDone:false,mcpPort:3300,adminPort:3301,workspacePath:"fixture"};
  const probe = async () => external || (alive && ready) ? {runtime:{pid:healthPid}} : null;
  const mocks = { "./status": { probeMcp:probe, classifyPortOwner:async port => ({pid:(adminOccupied && port===3301)||(mcpOccupied && port===3300)?80:null}) }, "./paths": {distEntry:()=>"fixture",ensureRuntimeDir(){},ensureBrowserUseRuntime:async()=>{}}, "./harness": {ensureDotEnv(){},mcpSpawnSpec:()=>({}),tunnelSpawnSpec:async()=>({command:"fixture",args:[],env:{}})}, "./app-profile":{profile:{isolated:true}}, "./account-context":{current:()=>null}, fs:{existsSync:()=>true} };
  if (doctorSpawn) mocks.child_process = { spawn: doctorSpawn };
  vm.runInNewContext(fs.readFileSync(filename,"utf8"), {module,exports:module.exports,process,console,Symbol,setTimeout,clearTimeout,require:name=>mocks[name]||realRequire(name)}, {filename});
  const {Services}=module.exports, service=Object.create(Services.prototype);
  if (portError) mocks["./status"].classifyPortOwner = async () => ({error:"fixture probe unavailable"});
  const mcp={pid:42,child:alive?{}:null,isAlive:()=>alive,start:()=>{events.push("spawn");alive=true;mcp.child={};return 42;},markRunning(){events.push("ready");},stop:async()=>{events.push("stop");alive=false;mcp.child=null;}};
  Object.assign(service,{mcp,config:()=>cfg,startingServices:new Set(),shuttingDown:false,recovery:{mcp:{disarm:()=>events.push("disarm")}},note(){},revokeMcpCapabilities:()=>events.push("revoke"),waitFor:async check=>check()});
  return {service,events,cfg};
}
test("setup-only MCP lease starts unfinished account, cleans its owned child, no normal bypass", async () => {
  const f=serviceFixture();
  await assert.rejects(f.service.startMcpOwned(()=>true),/初始化/);
  await f.service.withSetupMcp(async()=>{f.events.push("doctor");assert.equal(f.cfg.setupDone,false);});
  assert.deepEqual(f.events,["disarm","spawn","ready","doctor","stop","revoke"]);
  assert.equal(f.service.startingServices.size,0);
});
test("setup lease preserves external listeners and pre-existing owned process on failure", async () => {
  const external=serviceFixture({external:true});
  await assert.rejects(external.service.withSetupMcp(()=>assert.fail("doctor must not run")),/外部/);
  assert.deepEqual(external.events,["disarm"]);
  const owned=serviceFixture({alive:true});
  await assert.rejects(owned.service.withSetupMcp(()=>{throw Error("doctor failed");}),/doctor failed/);
  assert.deepEqual(owned.events,[]);
});
test("temporary MCP stops on doctor throw; replacement child never becomes cleanup target", async () => {
  const f=serviceFixture();
  await assert.rejects(f.service.withSetupMcp(()=>{throw Error("doctor failed");}),/doctor failed/);
  assert.equal(f.events.filter(e=>e==="stop").length,1);
  const replaced=serviceFixture();
  await replaced.service.withSetupMcp(()=>{replaced.service.mcp.child={replacement:true};});
  assert.equal(replaced.events.includes("stop"),false);
});
test("occupied Admin port is refused without starting or stopping a process", async () => {
  const f=serviceFixture({adminOccupied:true});
  await assert.rejects(f.service.withSetupMcp(()=>assert.fail("doctor must not run")),/Admin 端口/);
  assert.deepEqual(f.events,["disarm"]); assert.equal(f.service.startingServices.size,0);
});
test("local OAuth 401 does not assert cloud credential rejection", () => {
  const {diagnoseSetupFailure}=require(setupPath);
  assert.equal(diagnoseSetupFailure({output:"CHECK oauth_metadata FAIL HTTP 401 local metadata"}).code,"OAUTH_METADATA_FAILED");
});
test("unhealthy foreign MCP listener is neither adopted nor stopped", async () => {
  const f=serviceFixture({mcpOccupied:true});
  await assert.rejects(f.service.withSetupMcp(()=>assert.fail("doctor must not run")),/端口/);
  assert.deepEqual(f.events,["disarm"]);
});
test("temporary readiness failure also cleans the exact spawned process", async () => {
  const f=serviceFixture({ready:false});
  await assert.rejects(f.service.withSetupMcp(()=>assert.fail("doctor must not run")),/未在 45 秒内就绪/);
  assert.deepEqual(f.events,["disarm","spawn","stop","revoke"]);
});

test("readiness must identify the exact created PID and preserves mismatched pre-existing child", async () => {
  const created=serviceFixture({healthPid:99});
  await assert.rejects(created.service.withSetupMcp(()=>assert.fail("wrong PID must not reach doctor")),/未在 45 秒内就绪/);
  assert.deepEqual(created.events,["disarm","spawn","stop","revoke"]);
  const owned=serviceFixture({alive:true,healthPid:99});
  await assert.rejects(owned.service.withSetupMcp(()=>assert.fail("wrong PID must not reach doctor")),/identity/);
  assert.deepEqual(owned.events,[]);
});

test("unknown port ownership fails closed and releases startup reservation", async () => {
  const f=serviceFixture({portError:true});
  await assert.rejects(f.service.withSetupMcp(()=>assert.fail("unconfirmed port must not reach doctor")),/Admin 端口/);
  assert.deepEqual(f.events,["disarm"]); assert.equal(f.service.startingServices.size,0);
});

test("configuration change during readiness cancels doctor and cleans temporary child", async () => {
  const f=serviceFixture();
  f.service.waitFor=async check=>{const ready=await check();f.cfg.mcpPort++;return ready;};
  await assert.rejects(f.service.withSetupMcp(()=>assert.fail("cancelled startup must not reach doctor")),/cancelled/);
  assert.deepEqual(f.events,["disarm","spawn","stop","revoke"]);
  assert.equal(f.service.startingServices.size,0);
});

test("save failure never commits initialization and retains previous initialized state", async () => {
  const {initializeAccount}=require(setupPath);
  for (const done of [false,true]) {
    const f=fixture(done); let saves=0;
    f.deps.saveConfig=()=>{if (++saves===2) throw Error("fixture disk write failed");};
    const result=await initializeAccount(f.deps);
    assert.equal(result.ok,false); assert.equal(result.code,"CONFIG_SAVE_FAILED");
    assert.equal(f.cfg.setupDone,done); assert.equal(f.events.at(-1),"mcp-stop");
  }
});

test("JSON-shaped diagnostic credentials are redacted even without known secret", () => {
  const {redactSetupText}=require(setupPath);
  assert.doesNotMatch(redactSetupText('{"api_key":"fixture-sensitive","access_token": "other-sensitive"}'),/fixture-sensitive|other-sensitive/);
});

test("doctor buffers fragmented output so split keys never reach progress, and preserves the final line", async () => {
  const { EventEmitter } = require("node:events");
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const f = serviceFixture({ doctorSpawn: () => child }), lines = [], key = "fixture-split-sensitive-key";
  const result = f.service.runDoctor({}, key, line => lines.push(line));
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.emit("data", Buffer.from("CHECK control_plane_api_key FAIL " + key.slice(0, 10)));
  const premature = lines.slice();
  child.stderr.emit("data", Buffer.from('diagnostic {"access_token":"other-'));
  child.stdout.emit("data", Buffer.from(key.slice(10) + "\n"));
  child.stderr.emit("data", Buffer.from('sensitive"}\n'));
  child.stdout.emit("data", Buffer.from("CHECK oauth_metadata PASS final line without newline"));
  child.emit("exit", 0); child.emit("close", 0);
  const doctor = await result;
  assert.equal(premature.length, 0, "incomplete lines can contain part of a secret and must not be streamed");
  assert.match(doctor.output, /CHECK oauth_metadata PASS final line without newline/);
  assert.doesNotMatch(JSON.stringify([doctor, lines]), /fixture-split|sensitive-key|other-sensitive/);
});
