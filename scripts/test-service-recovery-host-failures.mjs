import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProcessStartIdentity } from "../dist/lib/process-journal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostScript = path.join(root, "scripts", "service-recovery-host.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function readLines(file) { try { return (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; } }
async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await delay(40);
  }
  throw new Error("timed out; last=" + JSON.stringify(last));
}
function launch(workspace, state, artifacts, token, extraEnv = {}) {
  let output = "";
  const child = spawn(process.execPath, [hostScript, "--workspace", workspace, "--state-root", state, "--artifact-root", artifacts, "--launch-token", token], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HARNESS_RECOVERY_SUPERVISOR_CHILD: "1", ...extraEnv }
  });
  child.stdout.on("data", (c) => { output += c.toString(); });
  child.stderr.on("data", (c) => { output += c.toString(); });
  return { child, output: () => output };
}
async function stopHost(state, record) {
  if (!record?.instance_token) return;
  await fs.writeFile(path.join(state, "stop.request.json"), JSON.stringify({version:1,instance_token:record.instance_token,requested_at:new Date().toISOString(),requested_by_pid:process.pid}) + "\n");
}
async function sandbox(name) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-host-failure-"));
  const workspace = path.join(base,"workspace");
  const state = path.join(base,"state");
  const artifacts = path.join(base,"artifacts");
  await Promise.all([fs.mkdir(workspace,{recursive:true}),fs.mkdir(state,{recursive:true}),fs.mkdir(artifacts,{recursive:true})]);
  return {name,base,workspace,state,artifacts,status:path.join(state,"host-status.json"),pid:path.join(state,"host.pid.json"),lock:path.join(state,"host.lock"),activity:path.join(artifacts,"activity.jsonl")};
}
async function cleanup(box, records = []) {
  for (const r of records) if (r?.child?.exitCode === null) r.child.kill("SIGKILL");
  await fs.rm(box.base,{recursive:true,force:true});
}

{
  const box = await sandbox("live-owner");
  const first = launch(box.workspace,box.state,box.artifacts,"first");
  let firstPid;
  try {
    firstPid = await waitFor(() => readJson(box.pid));
    const second = launch(box.workspace,box.state,box.artifacts,"second");
    const secondExit = await Promise.race([new Promise((resolve)=>second.child.once("exit",(code)=>resolve(code))),delay(3000).then(()=>null)]);
    assert.equal(secondExit,0,"concurrent second host did not exit cleanly: " + second.output());
    const after = await readJson(box.pid);
    assert.equal(after.pid,firstPid.pid,"concurrent second host replaced live owner");
    const events = await readLines(box.activity);
    assert.ok(events.some((e)=>e.event==="host_lock_live_owner" && e.owner_pid===firstPid.pid),"live owner diagnostic missing");
    await stopHost(box.state,firstPid);
    await new Promise((resolve)=>first.child.once("exit",resolve));
    console.log("PASS live-owner-single-winner");
  } finally { await cleanup(box,[first]); }
}

{
  const box = await sandbox("corrupt-old-lock");
  await fs.writeFile(box.lock,"{not-json");
  const old = new Date(Date.now()-5000);
  await fs.utimes(box.lock,old,old);
  const launched = launch(box.workspace,box.state,box.artifacts,"corrupt");
  try {
    const exit = await Promise.race([new Promise((resolve)=>launched.child.once("exit",(code)=>resolve(code))),delay(3000).then(()=>null)]);
    assert.notEqual(exit,0,"corrupt old lock was unsafely replaced");
    assert.equal(await readJson(box.pid),null,"corrupt old lock published a host pid");
    const events = await readLines(box.activity);
    assert.ok(events.some((e)=>e.event==="host_lock_blocked" && e.classification==="corrupt"),"corrupt-lock diagnostic missing");
    console.log("PASS corrupt-old-lock-fail-closed");
  } finally { await cleanup(box,[launched]); }
}

{
  const box = await sandbox("initializing-lock");
  const identity = await readProcessStartIdentity(process.pid);
  assert.ok(identity);
  await fs.writeFile(box.lock,"");
  const launched = launch(box.workspace,box.state,box.artifacts,"initializing");
  try {
    setTimeout(() => {
      void fs.writeFile(box.lock,JSON.stringify({version:1,pid:process.pid,process_start_identity:identity,instance_token:"initializer",acquired_at:new Date().toISOString()}));
    },120);
    const exit = await Promise.race([new Promise((resolve)=>launched.child.once("exit",(code)=>resolve(code))),delay(3000).then(()=>null)]);
    assert.equal(exit,0,"initializing lock was not resolved to live owner: " + launched.output());
    assert.equal(await readJson(box.pid),null,"contender started while lock initialization completed to live owner");
    const files = await fs.readdir(box.state);
    assert.equal(files.filter((n)=>n.startsWith("host.lock.dead-")).length,0,"initializing/live lock was incorrectly archived");
    console.log("PASS initializing-lock-no-unsafe-takeover");
  } finally { await cleanup(box,[launched]); }
}

{
  const box = await sandbox("missing-worker");
  const launched = launch(box.workspace,box.state,box.artifacts,"missing-worker",{HARNESS_RECOVERY_WORKER_SCRIPT:path.join(box.base,"missing-worker.mjs")});
  let pid;
  try {
    pid = await waitFor(()=>readJson(box.pid));
    const status = await waitFor(async()=>{
      const s=await readJson(box.status);
      return s?.worker_restart_suppressed && s?.last_worker_exit?.error==="worker_script_missing" ? s : null;
    });
    assert.equal(status.worker_pid,null);
    assert.equal(status.worker_restart_count,0,"missing worker should not enter restart loop");
    const events = await readLines(box.activity);
    assert.equal(events.filter((e)=>e.event==="worker_start_failed").length,1,"missing worker diagnostic should be emitted once");
    await stopHost(box.state,pid);
    await new Promise((resolve)=>launched.child.once("exit",resolve));
    console.log("PASS missing-worker-explicit-diagnostic");
  } finally { await cleanup(box,[launched]); }
}

{
  const box = await sandbox("bounded-backoff");
  const crashWorker = path.join(box.base,"crash-worker.mjs");
  await fs.writeFile(crashWorker,'export const = ;\n');
  const launched = launch(box.workspace,box.state,box.artifacts,"backoff",{
    HARNESS_RECOVERY_WORKER_SCRIPT:crashWorker,
    HARNESS_RECOVERY_WORKER_RESTART_BASE_MS:"100",
    HARNESS_RECOVERY_WORKER_RESTART_MAX_MS:"250",
    HARNESS_RECOVERY_WORKER_RESTART_LIMIT:"3",
    HARNESS_RECOVERY_WORKER_STABLE_MS:"1000"
  });
  let pid;
  try {
    pid = await waitFor(()=>readJson(box.pid));
    const status = await waitFor(async()=>{
      const s=await readJson(box.status);
      return s?.worker_restart_suppressed && s?.worker_failure_streak>=3 ? s : null;
    },5000);
    assert.equal(status.worker_failure_streak,3);
    assert.equal(status.worker_restart_suppressed,true);
    assert.equal(status.next_worker_restart_at,null);
    const events = await readLines(box.activity);
    const scheduled = events.filter((e)=>e.event==="worker_restart_scheduled").map((e)=>e.delay_ms);
    assert.deepEqual(scheduled,[100,200],"unexpected backoff sequence");
    assert.equal(events.filter((e)=>e.event==="worker_restart_suppressed").length,1,"restart suppression should occur exactly once");
    assert.equal(events.filter((e)=>e.event==="worker_started").length,3,"worker should have exactly three bounded attempts");
    await stopHost(box.state,pid);
    await new Promise((resolve)=>launched.child.once("exit",resolve));
    console.log("PASS bounded-worker-backoff");
  } finally { await cleanup(box,[launched]); }
}

console.log("service-recovery-host-failures: PASS");
