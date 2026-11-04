import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  serviceRecoverySupervisorPaths,
  serviceRecoverySupervisorStatus,
  stopServiceRecoverySupervisor,
} from "../dist/lib/service-recovery-supervisor.js";
import { readProcessStartIdentity } from "../dist/lib/process-journal.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-parent-exit-"));
const workspace = path.join(base, "workspace");
const state = path.join(base, "state");
const artifacts = path.join(base, "artifacts");
await fs.mkdir(workspace, { recursive: true });

process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED = "true";
process.env.HARNESS_RECOVERY_SUPERVISOR_STATE_DIR = state;
process.env.HARNESS_RECOVERY_ARTIFACT_ROOT = artifacts;
const paths = serviceRecoverySupervisorPaths(workspace);
const moduleUrl = pathToFileURL(path.join(root, "dist", "lib", "service-recovery-supervisor.js")).href;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readJson(file) { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; } }
async function identity(pid) { try { return await readProcessStartIdentity(pid); } catch { return null; } }
async function waitFor(label, fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await delay(50);
  }
  throw new Error(label + " timeout; last=" + JSON.stringify(last));
}
async function liveRecord(file) {
  const record = await readJson(file);
  return record?.pid && await identity(record.pid) === record.process_start_identity ? record : null;
}

const helperCode = [
  "process.env.HARNESS_RECOVERY_SUPERVISOR_ENABLED='true';",
  "process.env.HARNESS_RECOVERY_SUPERVISOR_STATE_DIR=" + JSON.stringify(state) + ";",
  "process.env.HARNESS_RECOVERY_ARTIFACT_ROOT=" + JSON.stringify(artifacts) + ";",
  "const m=await import(" + JSON.stringify(moduleUrl) + ");",
  "const s=await m.startServiceRecoverySupervisor(" + JSON.stringify(workspace) + ");",
  "if(!s.running||!s.guardian_running)process.exit(3);",
  "console.log(JSON.stringify({parent_pid:process.pid,host_pid:s.pid,guardian_pid:s.guardian_pid}));"
].join("");

let stopped = false;
try {
  let helperOut = "";
  let helperErr = "";
  const helper = spawn(process.execPath, ["--input-type=module", "-e", helperCode], {
    cwd: root,
    env: { ...process.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  helper.stdout.on("data", (c) => { helperOut += c.toString(); });
  helper.stderr.on("data", (c) => { helperErr += c.toString(); });
  const helperExit = await new Promise((resolve) => helper.once("exit", resolve));
  assert.equal(helperExit, 0, "starter parent failed: " + helperErr);
  const helperInfo = JSON.parse(helperOut.trim().split(/\r?\n/).filter(Boolean).at(-1));
  assert.ok(helperInfo.parent_pid && helperInfo.host_pid && helperInfo.guardian_pid);

  assert.equal(await identity(helperInfo.parent_pid), null, "starter parent unexpectedly remained alive");
  const guardian = await waitFor("guardian after parent exit", () => liveRecord(paths.guardianPidFile));
  const firstHost = await waitFor("host after parent exit", () => liveRecord(paths.pidFile));
  assert.equal(guardian.pid, helperInfo.guardian_pid);
  assert.equal(firstHost.pid, helperInfo.host_pid);

  const killedAt = Date.now();
  process.kill(firstHost.pid, "SIGKILL");
  const recovered = await waitFor("host recovery after parent already exited", async () => {
    const record = await liveRecord(paths.pidFile);
    return record && record.pid !== firstHost.pid ? record : null;
  }, 6000);
  const recoveryMs = Date.now() - killedAt;

  const status = await serviceRecoverySupervisorStatus(workspace);
  assert.equal(status.guardian_running, true, "guardian did not survive starter parent exit");
  assert.equal(status.guardian_pid, guardian.pid, "guardian identity changed unexpectedly");
  assert.equal(status.pid, recovered.pid, "recovered host is not current supervisor host");

  const stoppedStatus = await stopServiceRecoverySupervisor(workspace);
  stopped = true;
  assert.equal(stoppedStatus.running, false);
  assert.equal(stoppedStatus.guardian_running, false);

  console.log(JSON.stringify({
    test: "service-recovery-parent-exit",
    result: "PASS",
    starter_parent_pid: helperInfo.parent_pid,
    guardian_pid: guardian.pid,
    initial_host_pid: firstHost.pid,
    recovered_host_pid: recovered.pid,
    recovery_ms: recoveryMs,
    same_guardian_after_parent_exit: true
  }));
} finally {
  if (!stopped) {
    try { await stopServiceRecoverySupervisor(workspace); } catch {}
  }
  await fs.rm(base, { recursive: true, force: true });
}
