"use strict";
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clc-node-shim-"));
app.setPath("userData", tmp);
process.env.CLC_RUNTIME_DIR = path.join(tmp, "runtime");

async function main() {
  const paths = require("../src/paths");
  const harness = require("../src/harness");
  const shimDir = harness.ensureNodeShim();
  if (process.platform !== "win32") {
    console.log("node-shim: skipped (Windows-only shim)");
    fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(0);
    return;
  }
  const shim = path.join(shimDir, "node.cmd");
  if (!fs.existsSync(shim)) throw new Error("node.cmd was not created");
  const content = fs.readFileSync(shim, "utf8");
  if (!content.includes("ELECTRON_RUN_AS_NODE=1") || !content.includes(process.execPath)) throw new Error("node.cmd does not forward Electron Node safely");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
  const version = spawnSync(shim, ["--version"], { env, shell: true, windowsHide: true, encoding: "utf8" });
  if (version.status !== 0 || !/^v\d+\./.test((version.stdout || "").trim())) throw new Error("node.cmd --version failed");
  const script = spawnSync(shim, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp, env, shell: true, windowsHide: true, encoding: "utf8" });
  if (script.status !== 0 || path.resolve(script.stdout.trim()) !== path.resolve(tmp)) throw new Error("node.cmd argument/cwd forwarding failed");
  const spaced = path.join(tmp, "space path");
  fs.mkdirSync(spaced);
  const spacedCommand = "& '" + shim.replace(/'/g, "''") + "' -e 'process.stdout.write(process.argv[1])' '" + spaced.replace(/'/g, "''") + "'";
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const spacedRun = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", spacedCommand], { cwd: tmp, env, windowsHide: true, encoding: "utf8" });
  if (spacedRun.status !== 0 || spacedRun.stdout.trim() !== spaced) throw new Error("node.cmd space path forwarding failed: status=" + spacedRun.status + " stdout=" + JSON.stringify(spacedRun.stdout) + " stderr=" + JSON.stringify(spacedRun.stderr));
  // Use an explicitly encrypted synthetic credential, never a borrowed
  // process-level Admin token or a newly generated production credential.
  env.ADMIN_TOKEN = "phase4-admin-test-only";
  const previousAdminToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = env.ADMIN_TOKEN;
  try {
    if (harness.mcpSpawnSpec({ mcpPort: 3999, adminPort: 3998, workspacePath: tmp, toolProfile: "slim", adminTokenEnc: require("electron").safeStorage.encryptString("phase4-admin-test-only").toString("base64") }).command !== process.execPath) {
      throw new Error("MCP did not use explicit Electron executable");
    }
  } finally {
    if (previousAdminToken === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previousAdminToken;
  }
  console.log("node-shim: PATH forwarding, arguments, exit status, space paths, no recursion and explicit MCP executable OK");
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
}

app.whenReady().then(() => main().catch((error) => {
  console.error("node-shim FAIL", error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(1);
}));
