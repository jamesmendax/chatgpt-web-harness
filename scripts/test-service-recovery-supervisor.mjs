import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function waitFor(label, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timeout${lastError ? `: ${lastError.message}` : ""}`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt-web-harness-supervisor-"));
const stateRoot = path.join(workspaceRoot, "supervisor-state");
const artifactRoot = path.join(workspaceRoot, "supervisor-artifacts");
const pidFile = path.join(stateRoot, "host.pid.json");
const statusFile = path.join(stateRoot, "host-status.json");
const port = await freePort();
const adminPort = await freePort();
const child = spawn(process.execPath, [path.join(sourceRoot, "dist", "index.js")], {
  cwd: sourceRoot,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    ADMIN_PORT: String(adminPort),
    WORKSPACE_PATH: workspaceRoot,
    HARNESS_RECOVERY_SUPERVISOR_ENABLED: "true",
    HARNESS_RECOVERY_SUPERVISOR_STATE_DIR: stateRoot,
    HARNESS_RECOVERY_ARTIFACT_ROOT: artifactRoot,
    HARNESS_RELAY_AUTOMATION_ENABLED: "false",
    HARNESS_TEST_SHUTDOWN_AFTER_MS: "2000",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitFor("recovery host pid", async () => {
    const record = await readJson(pidFile);
    return record.version === 1 && record.pid && record.instance_token ? record : false;
  });
  const status = await waitFor("recovery host status", async () => {
    try {
      return await readJson(statusFile);
    } catch {
      return false;
    }
  });
  assert.equal(status.version, 1);
  assert.equal(typeof status.worker_pid, "number");
  const firstWorkerPid = status.worker_pid;
  process.kill(firstWorkerPid, "SIGTERM");
  const restarted = await waitFor("worker restart", async () => {
    try {
      const next = await readJson(statusFile);
      return next.worker_restart_count >= 1 && next.worker_pid && next.worker_pid !== firstWorkerPid
        ? next
        : false;
    } catch {
      return false;
    }
  });
  assert.equal(restarted.worker_restart_count >= 1, true);
  await waitFor("MCP health", async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      return response.ok;
    } catch {
      return false;
    }
  });
  await waitFor("startup banner", () => stdout.includes("Detached recovery: ON"));
  assert.match(stdout, /Recovery host PID:/);
  await waitFor("server exit", () => !processAlive(child.pid), 15_000);
  await waitFor("recovery host stop", async () => {
    try {
      await fs.access(pidFile);
      return false;
    } catch {
      return true;
    }
  }, 15_000);
  console.log("service recovery supervisor integration: PASS");
} catch (error) {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.error(stdout);
  console.error(stderr);
  throw error;
} finally {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
}
