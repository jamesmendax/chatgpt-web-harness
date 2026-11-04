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

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}
async function waitFor(file, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await readJson(file);
    if (value && predicate(value)) return value;
    await delay(40);
  }
  throw new Error("timed out waiting for " + file);
}
function launch(workspace, state, artifacts, token) {
  let output = "";
  const child = spawn(process.execPath, [hostScript, "--workspace", workspace, "--state-root", state, "--artifact-root", artifacts, "--launch-token", token], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HARNESS_RECOVERY_SUPERVISOR_CHILD: "1" }
  });
  child.stdout.on("data", (c) => { output += c.toString(); });
  child.stderr.on("data", (c) => { output += c.toString(); });
  return { child, output: () => output };
}
async function stopHost(state, record) {
  await fs.writeFile(path.join(state, "stop.request.json"), JSON.stringify({version:1, instance_token:record.instance_token, requested_at:new Date().toISOString(), requested_by_pid:process.pid}) + "\n");
}
async function runCase(name, seedLock) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-host-lock-"));
  const workspace = path.join(base, "workspace");
  const state = path.join(base, "state");
  const artifacts = path.join(base, "artifacts");
  await Promise.all([fs.mkdir(workspace,{recursive:true}),fs.mkdir(state,{recursive:true}),fs.mkdir(artifacts,{recursive:true})]);
  await fs.writeFile(path.join(state, "host.lock"), JSON.stringify(seedLock) + "\n");
  const launched = launch(workspace, state, artifacts, name);
  try {
    const pid = await waitFor(path.join(state, "host.pid.json"), (v) => v.launch_token === name);
    assert.notEqual(pid.pid, seedLock.pid, name + " did not replace stale owner");
    const archived = (await fs.readdir(state)).filter((n) => n.startsWith("host.lock.dead-"));
    assert.ok(archived.length >= 1, name + " did not archive stale lock");
    await stopHost(state, pid);
    await new Promise((resolve) => launched.child.once("exit", resolve));
    console.log("PASS " + name);
  } finally {
    if (launched.child.exitCode === null) launched.child.kill("SIGKILL");
    await fs.rm(base,{recursive:true,force:true});
  }
}

await runCase("dead-owner", {version:1,pid:999999,process_start_identity:"dead-owner",instance_token:"dead",acquired_at:new Date(Date.now()-60000).toISOString()});
const currentIdentity = await readProcessStartIdentity(process.pid);
assert.ok(currentIdentity, "test process identity unavailable");
await runCase("pid-reuse", {version:1,pid:process.pid,process_start_identity:currentIdentity + "-different",instance_token:"reused",acquired_at:new Date(Date.now()-60000).toISOString()});

console.log("service-recovery-host-locks: dead owner + PID reuse recovery PASS");
