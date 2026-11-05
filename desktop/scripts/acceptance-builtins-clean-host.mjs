import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const { SLIM_CHATGPT_TOOLS } = await import(pathToFileURL(path.join(desktopRoot, "..", "dist", "lib", "tool-profile.js")).href);
const expectedSlim = [...SLIM_CHATGPT_TOOLS].sort();
assert.ok(expectedSlim.includes("route_skills"), "runtime slim profile is missing route_skills");
function assertCatalog(health, names, label) {
  const expected = [...names].sort();
  assert.equal(health.runtime?.tool_profile, "slim", `${label} profile`);
  assert.equal(health.runtime?.tool_count, expected.length, `${label} tool count`);
  assert.equal(health.runtime?.tool_manifest_hash, crypto.createHash("sha256").update(expected.join("\n")).digest("hex"), `${label} tool manifest`);
}
const { version } = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
const releaseRoot = process.env.HARNESS_RELEASE_ROOT
  ? path.resolve(process.env.HARNESS_RELEASE_ROOT)
  : path.join(desktopRoot, "release");
const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harness-clean-host-"));
const adminToken = `clean-host-${crypto.randomBytes(24).toString("base64url")}`;
const product = "ChatGPT Web Harness Isolated";
const setup = path.join(releaseRoot, `${product}-${version}-setup.exe`);
const portable = path.join(releaseRoot, `${product}-${version}-portable.exe`);
const replaceExistingInstall = process.env.HARNESS_REPLACE_EXISTING_INSTALL === "1";
const protectedPid = Number(process.env.HARNESS_ACCEPTANCE_PROTECTED_PID || 0);
let protectedIdentity = null;
const reportPath = process.env.HARNESS_CLEAN_HOST_REPORT
  ? path.resolve(process.env.HARNESS_CLEAN_HOST_REPORT)
  : path.join(runRoot, "clean-host-report.json");
const INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Validate packaged built-in providers in an isolated clean-host fixture",
  scope: [runRoot], out_of_scope: [], deliverables: ["acceptance evidence"],
  success_criteria: ["both providers execute without host Codex or Python"],
  constraints: [], protected_resources: [], known_facts: ["all files and ports are task-scoped"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0, resolution_mode: "none",
});
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(desktopRoot, "..");
let notificationBaseline = null;
const notificationObservations = [];
let installerAttempted = false;
let replacementAttempted = false;

async function fileDigest(file) {
  const handle = await fs.open(file, "r");
  try {
    const before = await handle.stat();
    assert.ok(before.isFile(), `not a regular file: ${file}`);
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    assert.equal(after.size, before.size, `file changed during hashing: ${file}`);
    assert.equal(after.mtimeMs, before.mtimeMs, `file changed during hashing: ${file}`);
    return { bytes: before.size, sha256: digest.digest("hex") };
  } finally { await handle.close(); }
}

async function requireVerifiedCandidate() {
  const proofPath = process.env.HARNESS_CLEAN_HOST_VERIFICATION;
  if (!proofPath) return verifyPortableFixtureIsolation();
  assert.equal(path.resolve(proofPath).toLowerCase(), path.join(releaseRoot, "VERIFICATION.json").toLowerCase(),
    "candidate verification report must belong to the selected release directory");
  const report = JSON.parse(await fs.readFile(proofPath, "utf8"));
  assert.equal(report.schema, 2); assert.equal(report.complete, true); assert.equal(report.passed, true);
  assert.equal(report.version, version);
  assert.equal(report.claims?.packaged_app_source_hashes, true);
  assert.equal(report.claims?.packaged_runtime_hashes, true);
  assert.match(String(report.source_sha256 || ""), /^[a-f0-9]{64}$/);
  assert.equal(report.release_evidence?.source?.sha256, report.source_sha256);
  const rows = report.artifacts;
  assert.ok(Array.isArray(rows), "candidate artifact manifest missing");
  async function verifyArtifact(name) {
    const matching = rows.filter(row => row.name === name);
    assert.equal(matching.length, 1, `candidate artifact must be unique: ${name}`);
    const actual = await fileDigest(path.join(releaseRoot, name));
    assert.equal(actual.bytes, matching[0].bytes, `candidate size differs: ${name}`);
    assert.equal(actual.sha256, matching[0].sha256, `candidate hash differs: ${name}`);
    return actual;
  }
  const executable = await verifyArtifact(path.basename(portable));
  await verifyArtifact(path.basename(setup));
  await verifyArtifact("SOURCE_MANIFEST.json");
  await verifyArtifact("root-verification.json");
  await verifyArtifact("desktop-verification.json");
  const extraction = Array.isArray(report.exe_extraction) ? report.exe_extraction : [];
  for (const name of [path.basename(portable), path.basename(setup)]) {
    const artifact = rows.find(row => row.name === name);
    const proof = extraction.filter(row => row.name === name);
    assert.ok(artifact && proof.length === 1 && proof[0].sha256 === artifact.sha256 &&
      /^[a-f0-9]{64}$/.test(String(proof[0].app_asar_sha256 || "")) &&
      Number(proof[0].runtime_files) > 0, `candidate EXE extraction proof missing: ${name}`);
  }
  for (const name of ["root-verification.json", "desktop-verification.json"]) {
    const result = JSON.parse(await fs.readFile(path.join(releaseRoot, name), "utf8"));
    assert.equal(result.complete, true); assert.equal(result.passed, true);
    assert.equal(result.source_sha256, report.source_sha256, `${name} source mismatch`);
  }
  const signature = require(path.join(repoRoot, ".release-tools", "source-signature.cjs")).sourceSignature(repoRoot);
  assert.equal(signature.sha256, report.source_sha256, "current source differs from tested candidate");
  const manifest = JSON.parse(await fs.readFile(path.join(releaseRoot, "SOURCE_MANIFEST.json"), "utf8"));
  assert.ok(Array.isArray(manifest), "candidate source manifest invalid");
  for (const relative of ["desktop/src/main.js", "desktop/src/isolated-runtime.js"]) {
    const matches = manifest.filter(row => row.path === relative);
    assert.equal(matches.length, 1, `candidate source entry must be unique: ${relative}`);
    const [current, snapshot] = await Promise.all([
      fileDigest(path.join(repoRoot, relative)), fileDigest(path.join(releaseRoot, "source", relative)),
    ]);
    assert.equal(current.sha256, matches[0].sha256, `current fixture isolation source differs: ${relative}`);
    assert.equal(snapshot.sha256, matches[0].sha256, `packaged source snapshot differs: ${relative}`);
    assert.equal(current.bytes, matches[0].bytes); assert.equal(snapshot.bytes, matches[0].bytes);
  }
  return { method: "verified_export", source_sha256: report.source_sha256, portable_sha256: executable.sha256, portable_bytes: executable.bytes };
}

async function verifyPortableFixtureIsolation() {
  // The canonical build runs this acceptance before final VERIFICATION.json
  // exists. Prove the actual EXE contents directly without executing it.
  const signature = require(path.join(repoRoot, ".release-tools", "source-signature.cjs")).sourceSignature(repoRoot);
  for (const name of ["root-latest.json", "desktop-latest.json"]) {
    const result = JSON.parse(await fs.readFile(path.join(repoRoot, ".validation", name), "utf8"));
    assert.equal(result.complete, true); assert.equal(result.passed, true);
    assert.equal(result.source_sha256, signature.sha256, `${name} does not match current source`);
  }
  const before = await fileDigest(portable);
  const inspection = path.join(runRoot, "portable-inspection");
  await fs.mkdir(inspection, { recursive: true });
  const vendor = path.join(desktopRoot, "node_modules", "electron-winstaller", "vendor");
  const sevenZip = path.join(inspection, "7z.exe");
  await fs.copyFile(path.join(vendor, "7z-x64.exe"), sevenZip);
  await fs.copyFile(path.join(vendor, "7z-x64.dll"), path.join(inspection, "7z.dll"));
  const extracted = path.join(inspection, "payload");
  await fs.mkdir(extracted);
  await execFileAsync(sevenZip, ["x", "-y", "-bso0", "-bsp0", `-o${extracted}`, portable, "resources/app.asar"],
    { windowsHide: true, timeout: 900_000, maxBuffer: 4 * 1024 * 1024 });
  const archive = path.join(extracted, "resources", "app.asar");
  const readAsarFile = require(path.join(repoRoot, ".release-tools", "build-policy.cjs")).readAsarFile;
  const asarSha = (await fileDigest(archive)).sha256;
  for (const relative of ["src/main.js", "src/isolated-runtime.js"]) {
    const packaged = readAsarFile(archive, relative);
    const source = await fileDigest(path.join(desktopRoot, relative));
    assert.equal(packaged.length, source.bytes, `Portable ASAR source size mismatch: ${relative}`);
    assert.equal(crypto.createHash("sha256").update(packaged).digest("hex"), source.sha256,
      `Portable ASAR fixture isolation source mismatch: ${relative}`);
  }
  const after = await fileDigest(portable);
  assert.deepEqual(after, before, "Portable changed during fixture-isolation inspection");
  return { method: "direct_portable_asar", source_sha256: signature.sha256,
    portable_sha256: before.sha256, portable_bytes: before.bytes, app_asar_sha256: asarSha };
}

async function realRoamingAppData() {
  const code = `
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CleanHostKnownFolder {
  [DllImport("shell32.dll")] public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);
}
'@
$id = [Guid]'3EB685DB-65F9-4CF6-A03A-E3EF65729F3D'
$p = [IntPtr]::Zero
$hr = [CleanHostKnownFolder]::SHGetKnownFolderPath([ref]$id, 0, [IntPtr]::Zero, [ref]$p)
if ($hr -ne 0) { throw ("SHGetKnownFolderPath failed: " + $hr) }
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringUni($p)) }
finally { [Runtime.InteropServices.Marshal]::FreeCoTaskMem($p) }
`;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", code], { windowsHide: true });
  const value = String(stdout).trim();
  assert.ok(path.isAbsolute(value), "Windows roaming Known Folder unavailable");
  return value;
}

async function notificationSnapshot() {
  const base = path.join(await realRoamingAppData(), "Microsoft", "Windows", "Start Menu", "Programs");
  const names = [`${product}.lnk`, `${product} Portable.lnk`];
  return Promise.all(names.map(async name => {
    const file = path.join(base, name);
    try {
      const stat = await fs.lstat(file);
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), `notification shortcut is not a regular file: ${name}`);
      const digest = await fileDigest(file);
      return { name, exists: true, ...digest };
    } catch (error) {
      if (error?.code === "ENOENT") return { name, exists: false, bytes: null, sha256: null };
      throw error;
    }
  }));
}

async function checkNotificationShortcuts(stage) {
  let entries;
  try { entries = await notificationSnapshot(); }
  catch (error) {
    notificationObservations.push({ stage, unchanged: null, error: String(error) });
    throw error;
  }
  const unchanged = JSON.stringify(entries) === JSON.stringify(notificationBaseline);
  notificationObservations.push({ stage, unchanged, entries });
  assert.equal(unchanged, true, `real Windows notification shortcuts changed during ${stage}; no restoration was attempted`);
}

function ensureInside(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  assert.ok(relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)), `path escaped task root: ${target}`);
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function cleanEnvironment(scope) {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const allow = [
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
    // Electron resolves Windows Known Folders against the authenticated user
    // token. Preserve the real profile identity while APPDATA/LOCALAPPDATA and
    // --user-data-dir below isolate every application-owned file.
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN",
  ];
  const env = Object.fromEntries(allow.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  Object.assign(env, {
    SystemRoot: systemRoot,
    WINDIR: process.env.WINDIR || systemRoot,
    PATH: [path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")].join(";"),
    APPDATA: path.join(scope, "appdata"),
    LOCALAPPDATA: path.join(scope, "localappdata"),
    TEMP: path.join(scope, "temp"),
    TMP: path.join(scope, "temp"),
    ADMIN_TOKEN: adminToken,
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    CHATGPT_TOOL_PROFILE: "slim",
  });
  return env;
}

async function prepareProfile(scope, enabled) {
  // Packaged isolated builds intentionally accept only their dedicated default
  // user-data root. Point APPDATA at the disposable scope and use that exact root.
  const userData = path.join(scope, "appdata", "chatgpt-web-harness-isolated");
  const workspace = path.join(scope, "workspace");
  const profiles = path.join(userData, "runtime", "profiles");
  await Promise.all(
    [userData, workspace, profiles, path.join(scope, "profile"), path.join(scope, "appdata"), path.join(scope, "localappdata"), path.join(scope, "temp")]
      .map((directory) => fs.mkdir(directory, { recursive: true })),
  );
  const fixtureToken = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(path.join(scope, ".clean-host-fixture.json"), `${JSON.stringify({
    schema_version: 1, scope, token: fixtureToken, created_at: Date.now(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
  const mcpPort = await freePort();
  let adminPort = await freePort();
  while (adminPort === mcpPort) adminPort = await freePort();
  let tunnelPort = await freePort();
  while (tunnelPort === mcpPort || tunnelPort === adminPort) tunnelPort = await freePort();
  await fs.writeFile(path.join(userData, "config.json"), `${JSON.stringify({
    version: 1, setupDone: true, tunnelId: "", apiKeyEnc: "", workspacePath: workspace,
    mcpPort, adminPort, tunnelPort, toolProfile: "slim", autoStart: true,
    minimizeToTray: false, relayEnabled: false, idleReminderMinutes: 0,
  }, null, 2)}\n`);
  await fs.writeFile(path.join(profiles, "plugins.json"), `${JSON.stringify({
    schema_version: 2,
    computer_use: { enabled },
    browser_use: { enabled },
    skills: [],
  }, null, 2)}\n`);
  await fs.writeFile(path.join(profiles, "mcp-upstream.json"), "{\"version\":1,\"servers\":[]}\n");
  return { userData, workspace, mcpPort, adminPort, tunnelPort, fixtureToken };
}

async function jsonFetch(url, options = {}, timeoutMs = 120_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function decodeRpc(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .at(-1);
  return data ? JSON.parse(data) : null;
}

async function waitHealth(port, child, label, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const exitCode = child.process.exitCode;
    const signalCode = child.process.signalCode;
    if (exitCode !== null || signalCode !== null) {
      throw new Error(`${label} exited ${exitCode ?? signalCode}: ${child.output().slice(-4000)}`);
    }
    try {
      const result = await jsonFetch(`http://127.0.0.1:${port}/health`, {}, 5000);
      last = `${result.response.status} ${result.text.slice(0, 300)}`;
      if (result.response.ok && result.json?.name === "codex-mcp-server") return result.json;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} health timed out: ${last}\n${child.output().slice(-4000)}`);
}

async function initialize(port) {
  const result = await jsonFetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "clean-host-acceptance", version: "1" },
    } }),
  });
  const sessionId = result.response.headers.get("mcp-session-id");
  assert.ok(result.response.ok && sessionId, `MCP initialize failed: ${result.response.status} ${result.text.slice(0, 500)}`);
  await rpc(port, sessionId, 0, "notifications/initialized", {});
  return sessionId;
}

async function rpc(port, sessionId, id, method, params) {
  const result = await jsonFetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id ? { id } : {}), method, params }),
  });
  assert.ok(result.response.ok, `${method} HTTP ${result.response.status}: ${result.text.slice(0, 500)}`);
  const message = result.json || decodeRpc(result.text);
  assert.equal(message?.error, undefined, `${method} RPC error: ${JSON.stringify(message?.error)}`);
  return message?.result;
}

async function deleteSession(port, sessionId) {
  await jsonFetch(`http://127.0.0.1:${port}/mcp`, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId, "mcp-protocol-version": "2025-03-26" },
  }, 30_000).catch(() => undefined);
}

function spawnApp(exe, scope, profile) {
  const startedAt = Date.now();
  const env = cleanEnvironment(scope);
  env.HARNESS_CLEAN_HOST_SCOPE = scope;
  env.HARNESS_CLEAN_HOST_TOKEN = profile.fixtureToken;
  const child = spawn(exe, [`--user-data-dir=${profile.userData}`, "--disable-gpu", "--disable-software-rasterizer"], {
    cwd: path.dirname(exe), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => { output = (output + String(chunk)).slice(-120_000); };
  child.stdout?.on("data", append); child.stderr?.on("data", append); child.on("error", append);
  return { pid: child.pid, process: child, startedAt, output: () => output };
}

async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const script = [
    "$id=[int]$env:HARNESS_ACCEPTANCE_PROCESS_ID",
    "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue",
    // Windows PowerShell 5 otherwise emits /Date(...)/, which Date.parse rejects.
    "if($p){$p|Select-Object ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}},Name,ExecutablePath,CommandLine|ConvertTo-Json -Compress -Depth 3}else{'null'}",
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, HARNESS_ACCEPTANCE_PROCESS_ID: String(pid) },
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(String(stdout).trim() || "null");
}

async function logMcpIdentityTiming(label, app, health, identity) {
  if (process.env.HARNESS_CLEAN_HOST_DIAGNOSTICS !== "1") return;
  const rawCreationDate = String(identity?.CreationDate || "");
  const diagnostic = JSON.stringify({
    label,
    app_started_at: new Date(app.startedAt).toISOString(),
    health_pid: health.runtime?.pid ?? null,
    health_started_at: health.runtime?.started_at ?? null,
    identity_pid: identity?.ProcessId ?? null,
    identity_created_at: rawCreationDate,
    identity_created_epoch_ms: Date.parse(rawCreationDate),
    app_started_epoch_ms: app.startedAt,
  });
  console.log(`CLEAN_HOST_DIAG ${diagnostic}`);
  if (process.env.HARNESS_CLEAN_HOST_DIAGNOSTIC_LOG) {
    const logPath = path.resolve(process.env.HARNESS_CLEAN_HOST_DIAGNOSTIC_LOG);
    ensureInside(path.dirname(reportPath), logPath);
    await fs.appendFile(logPath, `${diagnostic}\n`, "utf8");
  }
}

async function stopExactTree(identity, expectedNeedle) {
  if (!identity) return;
  const current = await processIdentity(Number(identity.ProcessId));
  if (!current) return;
  assert.equal(String(current.CreationDate), String(identity.CreationDate), `PID ${identity.ProcessId} was reused; refusing cleanup`);
  assert.equal(String(current.CommandLine || ""), String(identity.CommandLine || ""), `PID ${identity.ProcessId} command changed; refusing cleanup`);
  assert.ok(String(current.CommandLine || "").toLowerCase().includes(String(expectedNeedle).toLowerCase()), `PID ${identity.ProcessId} is outside the acceptance scope`);
  const taskkill = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  await execFileAsync(taskkill, ["/PID", String(identity.ProcessId), "/T", "/F"], { windowsHide: true, timeout: 30_000 }).catch(() => undefined);
}

async function verifyMcpOwnership(app, mcpIdentity, profile) {
  assert.ok(mcpIdentity, "MCP identity missing; refusing to infer ownership");
  assert.ok(Date.parse(String(mcpIdentity.CreationDate)) >= app.startedAt - 5000, "MCP predates fixture launch");
  const marker = String(profile.userData).toLowerCase();
  if (String(mcpIdentity.CommandLine || "").toLowerCase().includes(marker)) return "fixture-path";
  if (String(mcpIdentity.CommandLine || "").toLowerCase().includes(String(runRoot).toLowerCase())) return "fixture-root";
  let current = mcpIdentity;
  const visited = new Set();
  while (current && !visited.has(Number(current.ProcessId))) {
    visited.add(Number(current.ProcessId));
    if (Number(current.ProcessId) === Number(app.pid)) {
      assert.ok(String(current.CommandLine || "").toLowerCase().includes(marker), "application PID lacks fixture user-data path");
      assert.ok(Date.parse(String(current.CreationDate)) >= app.startedAt - 5000, "application PID predates fixture launch");
      return "app-descendant";
    }
    const parent = Number(current.ParentProcessId);
    if (!Number.isSafeInteger(parent) || parent <= 0) break;
    const next = await processIdentity(parent);
    if (next && Date.parse(String(next.CreationDate)) > Date.parse(String(current.CreationDate))) break;
    current = next;
  }
  throw new Error(`MCP PID ${mcpIdentity.ProcessId} ownership is unknown; refusing MCP cleanup`);
}

async function stopExercise(appIdentity, mcpIdentity, profile, mcpOwnership) {
  if (mcpIdentity && !mcpOwnership) throw new Error("MCP ownership was not proved; refusing MCP cleanup");
  await stopExactTree(appIdentity, profile.userData);
  await stopExactTree(mcpIdentity, "dist\\index.js");
  await stopOwnedProcesses(runRoot);
}

async function processRows(marker) {
  const script = [
    "$needle=[string]$env:HARNESS_ACCEPTANCE_PROCESS_MARKER", "$self=[int]$env:HARNESS_ACCEPTANCE_SELF_PID",
    "$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.ProcessId -ne $self -and $_.CommandLine -and $_.CommandLine.Contains($needle) } | Select-Object ProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}},Name,CommandLine)",
    "if($rows.Count){$rows|ConvertTo-Json -Compress -Depth 3}else{'[]'}",
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: {
      ...process.env,
      HARNESS_ACCEPTANCE_PROCESS_MARKER: String(marker),
      HARNESS_ACCEPTANCE_SELF_PID: String(process.pid),
    },
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(String(stdout).trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function stopOwnedProcesses(marker) {
  ensureInside(runRoot, marker);
  for (let pass = 0; pass < 12; pass++) {
    const rows = await processRows(marker);
    if (!rows.length) return;
    for (const row of rows) {
      const script = [
        "$id=[int]$env:HARNESS_ACCEPTANCE_PROCESS_ID", "$born=[string]$env:HARNESS_ACCEPTANCE_PROCESS_BORN", "$needle=[string]$env:HARNESS_ACCEPTANCE_PROCESS_MARKER",
        "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$id\" -ErrorAction SilentlyContinue",
        "if($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq $born -and $p.CommandLine -and $p.CommandLine.Contains($needle)){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}",
      ].join(";");
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: {
          ...process.env,
          HARNESS_ACCEPTANCE_PROCESS_ID: String(row.ProcessId),
          HARNESS_ACCEPTANCE_PROCESS_BORN: String(row.CreationDate),
          HARNESS_ACCEPTANCE_PROCESS_MARKER: String(marker),
        },
        windowsHide: true,
      }).catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(await processRows(marker), [], `owned processes survived cleanup for ${marker}`);
}

async function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(true); });
  });
}

async function captureCandidateWindow(port, session, scope, app, profile, label) {
  const call = (id, args) => rpc(port, session, id, "tools/call", { name: "computer_use", arguments: args });
  let selected;
  await waitUntil(async () => {
    const result = await call(30, { action: "list_windows" });
    assert.equal(result?.structuredContent?.ok, true, "candidate window list failed");
    const matches = [];
    for (const window of result.structuredContent.data.windows || []) {
      const pid = Number(window.pid);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === protectedPid ||
          !String(window.title || "").toLowerCase().includes("harness")) continue;
      const identity = await processIdentity(pid);
      if (!identity) continue;
      try {
        const ownership = await verifyMcpOwnership(app, identity, profile);
        matches.push({ window, identity, ownership });
      } catch { /* A same-titled unrelated window is not a candidate. */ }
    }
    if (matches.length > 1) throw new Error("multiple candidate Aura windows; refusing ambiguous capture");
    if (matches.length === 1) { selected = matches[0]; return true; }
    return false;
  }, `${label} owned Aura window`, 20_000);
  const hwnd = String(selected.window.hwnd);
  const selection = await call(31, { action: "select_target", target: "window", hwnd });
  assert.equal(selection?.structuredContent?.ok, true, "candidate Aura target selection failed");
  try {
    const status = await call(32, { action: "status" });
    assert.equal(String(status?.structuredContent?.data?.selected_target?.hwnd), hwnd, "candidate target changed before screenshot");
    const recheck = await call(35, { action: "list_windows" });
    assert.ok((recheck?.structuredContent?.data?.windows || []).some(item =>
      String(item.hwnd) === hwnd && Number(item.pid) === Number(selected.identity.ProcessId)), "candidate window identity changed");
    const current = await processIdentity(Number(selected.identity.ProcessId));
    assert.ok(current && String(current.CreationDate) === String(selected.identity.CreationDate) &&
      String(current.CommandLine || "") === String(selected.identity.CommandLine || ""), "candidate PID changed before capture");
    const screenshot = await call(33, { action: "screenshot" });
    assert.equal(screenshot?.structuredContent?.ok, true, "candidate Aura screenshot failed");
    const image = (screenshot.content || []).find(item => item.type === "image" && item.mimeType === "image/png" && item.data);
    assert.ok(image, "candidate Aura screenshot PNG missing");
    const bytes = Buffer.from(image.data, "base64");
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "candidate screenshot is not PNG");
    const scopeImage = path.join(scope, "aura-window.png");
    await fs.writeFile(scopeImage, bytes);
    const evidenceImage = path.join(path.dirname(reportPath), `${label}-aura-window-${crypto.randomUUID()}.png`);
    await fs.mkdir(path.dirname(evidenceImage), { recursive: true });
    await fs.writeFile(evidenceImage, bytes, { flag: "wx" });
    return { pid: Number(selected.identity.ProcessId), hwnd, ownership: selected.ownership,
      created_at: selected.identity.CreationDate, scope_image_path: scopeImage,
      image_path: evidenceImage, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  } finally {
    const closed = await call(34, { action: "close" });
    assert.equal(closed?.structuredContent?.ok, true, "candidate Aura target release failed");
  }
}

async function exerciseOwnedWindow(port, session, scope) {
  const scriptPath = path.join(scope, "owned-window.ps1");
  const geometryPath = path.join(scope, "owned-window-geometry.json");
  const resultPath = path.join(scope, "owned-window-result.txt");
  const title = `Harness clean-host fixture ${crypto.randomUUID()}`;
  const marker = `fixture-${crypto.randomBytes(12).toString("hex")}`;
  const psString = value => "'" + String(value).replaceAll("'", "''") + "'";
  await fs.writeFile(scriptPath, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CleanHostGeometry {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
'@
[CleanHostGeometry]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = [Windows.Forms.Form]::new()
$form.Text = ${psString(title)}
$form.StartPosition = 'Manual'
$form.Location = [Drawing.Point]::new(40, 40)
$form.ClientSize = [Drawing.Size]::new(390, 145)
$form.TopMost = $true
$box = [Windows.Forms.TextBox]::new()
$box.Location = [Drawing.Point]::new(20, 20)
$box.Size = [Drawing.Size]::new(330, 28)
$button = [Windows.Forms.Button]::new()
$button.Text = 'Commit'
$button.Location = [Drawing.Point]::new(20, 72)
$button.Size = [Drawing.Size]::new(120, 32)
$button.Add_Click({ [IO.File]::WriteAllText(${psString(resultPath)}, $box.Text, [Text.UTF8Encoding]::new($false)) })
$form.Controls.Add($box); $form.Controls.Add($button)
$form.Add_Shown({
  $rect = [CleanHostGeometry+RECT]::new()
  if (-not [CleanHostGeometry]::GetWindowRect($form.Handle, [ref]$rect)) { throw 'Fixture bounds unavailable' }
  $textPoint = $box.PointToScreen([Drawing.Point]::new([int]($box.Width / 2), [int]($box.Height / 2)))
  $buttonPoint = $button.PointToScreen([Drawing.Point]::new([int]($button.Width / 2), [int]($button.Height / 2)))
  $g = @{ hwnd=$form.Handle.ToInt64().ToString(); text_x=$textPoint.X-$rect.Left; text_y=$textPoint.Y-$rect.Top; button_x=$buttonPoint.X-$rect.Left; button_y=$buttonPoint.Y-$rect.Top }
  [IO.File]::WriteAllText(${psString(geometryPath)}, ($g | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $box.Focus()
})
[void]$form.ShowDialog()
`, "utf8");
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const fixture = spawn(powershell, ["-NoLogo", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
    env: cleanEnvironment(scope), windowsHide: false, stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(fixture.pid, "owned fixture did not start");
  let errors = "";
  fixture.stderr?.on("data", chunk => { errors += String(chunk); });
  const call = async (id, args) => {
    const response = await rpc(port, session, id, "tools/call", { name: "computer_use", arguments: args });
    assert.equal(response?.structuredContent?.ok, true, `owned Computer Use ${args.action}: ${JSON.stringify(response?.structuredContent)}`);
    return response.structuredContent.data;
  };
  try {
    let geometry;
    await waitUntil(async () => {
      if (fixture.exitCode !== null) throw new Error(`owned window exited ${fixture.exitCode}: ${errors}`);
      try { geometry = JSON.parse(await fs.readFile(geometryPath, "utf8")); return true; } catch { return false; }
    }, "owned window geometry", 15_000);
    const listed = await call(20, { action: "list_windows" });
    const found = (listed.windows || []).find(item => Number(item.pid) === fixture.pid && item.title === title);
    assert.ok(found, "owned fixture window was not listed");
    assert.equal(String(found.hwnd), String(geometry.hwnd), "window handle/geometry mismatch");
    await call(21, { action: "select_target", target: "window", hwnd: String(found.hwnd) });
    await call(22, { action: "click", x: geometry.text_x, y: geometry.text_y, button: "left" });
    const typed = await call(23, { action: "type", text: marker, replace_existing: true });
    assert.equal(typed.replaced_existing, true);
    await call(24, { action: "click", x: geometry.button_x, y: geometry.button_y, button: "left" });
    await waitUntil(async () => (await fs.readFile(resultPath, "utf8").catch(() => "")) === marker, "owned window input", 5000);
    await call(25, { action: "keypress", keys: ["ALT", "F4"] });
    await waitUntil(() => fixture.exitCode !== null, "owned window close", 5000);
    await call(26, { action: "close" });
    return { owned_window_click_type_close: true };
  } finally {
    if (fixture.exitCode === null) {
      fixture.kill("SIGKILL");
      await new Promise(resolve => { if (fixture.exitCode !== null) resolve(); else fixture.once("exit", resolve); });
    }
  }
}

async function exercise(exe, label) {
  const scope = path.join(runRoot, label.replaceAll(" ", "-"));
  await fs.mkdir(scope, { recursive: true });
  // The offline Portable carries and materializes several gigabytes of
  // Browser Use dependencies before Electron can start the MCP process.
  // Keep the normal installed-app limit strict while allowing a real cold
  // Portable launch to finish on machines with antivirus scanning enabled.
  const healthTimeoutMs = label === "portable" ? 480_000 : 360_000;
  let profile = await prepareProfile(scope, true);
  await checkNotificationShortcuts(`${label} before enabled launch`);
  let app = spawnApp(exe, scope, profile);
  let appIdentity = await processIdentity(app.pid);
  assert.ok(appIdentity, `${label} app process identity is unavailable`);
  console.log(`CLEAN_HOST_PHASE ${label} enabled launch pid=${app.pid}`);
  let enabledStartupMs = null;
  let disabledStartupMs = null;
  let mcpIdentity = null;
  let mcpOwnership = null;
  let ownedWindow = null;
  let auraCapture = null;
  let privateNotificationShortcut = null;
  try {
    const health = await waitHealth(profile.mcpPort, app, `${label} enabled`, healthTimeoutMs);
    await checkNotificationShortcuts(`${label} enabled running`);
    const privateShortcut = path.join(scope, "appdata", "Microsoft", "Windows", "Start Menu", "Programs",
      `${product}${label === "portable" ? " Portable" : ""}.lnk`);
    ensureInside(scope, privateShortcut);
    const shortcutStat = await fs.lstat(privateShortcut);
    assert.ok(shortcutStat.isFile() && !shortcutStat.isSymbolicLink(), "fixture notification shortcut is missing or not a regular file");
    privateNotificationShortcut = { path: privateShortcut, ...(await fileDigest(privateShortcut)) };
    enabledStartupMs = Date.now() - app.startedAt;
    console.log(`CLEAN_HOST_PHASE ${label} enabled health startup_ms=${enabledStartupMs}`);
    assertCatalog(health, [...expectedSlim, "computer_use", "browser_use_exec", "browser_use_screenshot"], `${label} enabled`);
    assert.equal(health.providers?.computer_use?.status, "ready");
    assert.equal(health.providers?.browser_use?.status, "ready");
    mcpIdentity = await processIdentity(Number(health.runtime?.pid));
    assert.ok(mcpIdentity, `${label} MCP process identity is unavailable`);
    await logMcpIdentityTiming(`${label} enabled`, app, health, mcpIdentity);
    assert.ok(Date.parse(String(mcpIdentity.CreationDate)) >= app.startedAt - 5000, `${label} MCP predates this acceptance launch`);
    assert.match(String(mcpIdentity.CommandLine || ""), /dist[\\/]index\.js/i, `${label} health PID is not the packaged MCP`);
    mcpOwnership = await verifyMcpOwnership(app, mcpIdentity, profile);
    const session = await initialize(profile.mcpPort);
    const tools = await rpc(profile.mcpPort, session, 3, "tools/list", {});
    const names = new Set((tools?.tools || []).map((tool) => tool.name));
    assert.deepEqual([...names].sort(), [...expectedSlim, "computer_use", "browser_use_exec", "browser_use_screenshot"].sort(), `${label} enabled tools/list`);
    for (const name of ["computer_use", "browser_use_exec", "browser_use_screenshot"]) assert.ok(names.has(name), `${label} missing ${name}`);
    const computer = await rpc(profile.mcpPort, session, 4, "tools/call", { name: "computer_use", arguments: { action: "status" } });
    assert.equal(computer?.structuredContent?.ok, true, `${label} Computer Use status failed`);
    const legacy = await rpc(profile.mcpPort, session, 7, "tools/call", { name: "computer_use", arguments: { action: "status", _intent: INTENT } });
    assert.equal(legacy?.structuredContent?.ok, true, `${label} legacy intent compatibility failed`);
    auraCapture = await captureCandidateWindow(profile.mcpPort, session, scope, app, profile, label);
    const browser = await rpc(profile.mcpPort, session, 5, "tools/call", { name: "browser_use_screenshot", arguments: { full: false, max_dim: 640 } });
    assert.notEqual(browser?.isError, true, `${label} Browser Use screenshot failed`);
    assert.ok((browser?.content || []).some((item) => item.type === "image" && item.data), `${label} Browser Use image missing`);
    ownedWindow = await exerciseOwnedWindow(profile.mcpPort, session, scope);
    await deleteSession(profile.mcpPort, session);
    console.log(`CLEAN_HOST_PHASE ${label} enabled builtins passed`);
  } finally {
    try { await stopExercise(appIdentity, mcpIdentity, profile, mcpOwnership); }
    finally { await checkNotificationShortcuts(`${label} enabled stopped`); }
  }
  assert.equal(await portClosed(profile.mcpPort), true, `${label} enabled MCP port remained open`);

  profile = await prepareProfile(scope, false);
  await checkNotificationShortcuts(`${label} before disabled launch`);
  app = spawnApp(exe, scope, profile);
  appIdentity = await processIdentity(app.pid);
  assert.ok(appIdentity, `${label} disabled app process identity is unavailable`);
  console.log(`CLEAN_HOST_PHASE ${label} disabled launch pid=${app.pid}`);
  mcpIdentity = null;
  mcpOwnership = null;
  try {
    const health = await waitHealth(profile.mcpPort, app, `${label} disabled`, healthTimeoutMs);
    await checkNotificationShortcuts(`${label} disabled running`);
    disabledStartupMs = Date.now() - app.startedAt;
    console.log(`CLEAN_HOST_PHASE ${label} disabled health startup_ms=${disabledStartupMs}`);
    assertCatalog(health, expectedSlim, `${label} disabled`);
    assert.equal(health.providers?.computer_use?.status, "disabled");
    assert.equal(health.providers?.browser_use?.status, "disabled");
    mcpIdentity = await processIdentity(Number(health.runtime?.pid));
    assert.ok(mcpIdentity, `${label} disabled MCP process identity is unavailable`);
    await logMcpIdentityTiming(`${label} disabled`, app, health, mcpIdentity);
    assert.ok(Date.parse(String(mcpIdentity.CreationDate)) >= app.startedAt - 5000, `${label} disabled MCP predates this acceptance launch`);
    assert.match(String(mcpIdentity.CommandLine || ""), /dist[\\/]index\.js/i, `${label} disabled health PID is not the packaged MCP`);
    mcpOwnership = await verifyMcpOwnership(app, mcpIdentity, profile);
    const session = await initialize(profile.mcpPort);
    const tools = await rpc(profile.mcpPort, session, 6, "tools/list", {});
    const names = new Set((tools?.tools || []).map((tool) => tool.name));
    assert.deepEqual([...names].sort(), expectedSlim, `${label} disabled tools/list`);
    for (const name of ["computer_use", "browser_use_exec", "browser_use_screenshot"]) assert.equal(names.has(name), false, `${label} disabled ${name} leaked`);
    await deleteSession(profile.mcpPort, session);
    console.log(`CLEAN_HOST_PHASE ${label} disabled profile passed`);
  } finally {
    try { await stopExercise(appIdentity, mcpIdentity, profile, mcpOwnership); }
    finally { await checkNotificationShortcuts(`${label} disabled stopped`); }
  }
  assert.equal(await exists(path.join(profile.userData, "computer-use", "capability.json")), false, `${label} disabled capability token remained`);
  assert.equal(await portClosed(profile.mcpPort), true, `${label} disabled MCP port remained open`);
  return { label, enabled_tools: expectedSlim.length + 3, disabled_tools: expectedSlim.length, enabled_startup_ms: enabledStartupMs, disabled_startup_ms: disabledStartupMs, aura_capture: auraCapture, private_notification_shortcut: privateNotificationShortcut, ...ownedWindow };
}

async function existingInstallRecords() {
  const script = [
    "$r='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
    "$x=@(Get-ChildItem -LiteralPath $r -ErrorAction SilentlyContinue|%{$p=Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue;if($p.DisplayName -like 'ChatGPT Web Harness Isolated*'){[pscustomobject]@{RegistryPath=$_.PSPath;DisplayName=$p.DisplayName;DisplayVersion=$p.DisplayVersion;InstallLocation=$p.InstallLocation;UninstallString=$p.UninstallString;QuietUninstallString=$p.QuietUninstallString;DisplayIcon=$p.DisplayIcon}}})",
    "if($x.Count){$x|ConvertTo-Json -Compress -Depth 3}else{'[]'}",
  ].join(";");
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
  const parsed = JSON.parse(String(stdout).trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function commandExecutable(command) {
  const text = String(command || "").trim();
  const match = /^"([^"]+\.exe)"|^(\S+\.exe)/i.exec(text);
  return match ? path.resolve(match[1] || match[2]) : "";
}

function installRootFromRecord(record) {
  const uninstall = commandExecutable(record?.QuietUninstallString) || commandExecutable(record?.UninstallString);
  if (uninstall) return path.dirname(uninstall);
  const icon = String(record?.DisplayIcon || "").replace(/,\d+$/, "");
  return icon ? path.dirname(path.resolve(icon)) : "";
}

function assertSafeInstallRoot(target) {
  const resolved = path.resolve(target);
  assert.ok(path.isAbsolute(resolved), "installation root must be absolute");
  assert.equal(path.basename(resolved).toLowerCase(), product.toLowerCase(), `unexpected installation directory: ${resolved}`);
  assert.notEqual(path.dirname(resolved), path.parse(resolved).root, "refusing to operate directly below a drive root");
  return resolved;
}

async function waitUntil(check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try { if (await check()) return; }
    catch (error) { last = error instanceof Error ? error.message : String(error); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out${last ? `: ${last}` : ""}`);
}

async function isolatedProductProcesses() {
  const script = "$x=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue|Where-Object{$_.Name -eq 'ChatGPT Web Harness Isolated.exe'}|Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine);if($x.Count){$x|ConvertTo-Json -Compress -Depth 3}else{'[]'}";
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(String(stdout).trim() || "[]");
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function installCandidate(installRoot) {
  await execFileAsync(setup, ["/S", `/D=${installRoot}`], { windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
  const installedExe = path.join(installRoot, `${product}.exe`);
  await waitUntil(() => exists(installedExe), "candidate installation");
  return installedExe;
}

async function main() {
  for (const file of [setup, portable]) assert.ok(await exists(file), `missing artifact: ${file}`);
  const candidateBinding = await requireVerifiedCandidate();
  const before = await existingInstallRecords();
  assert.ok(before.length <= 1, "multiple isolated Harness installations are registered; refusing ambiguous replacement");
  const running = await isolatedProductProcesses();
  if (running.length && !replaceExistingInstall && Number.isSafeInteger(protectedPid) && protectedPid > 0) {
    protectedIdentity = running.find(row => Number(row.ProcessId) === protectedPid);
    assert.ok(protectedIdentity, "the explicitly protected live runtime is missing");
    // The Portable fixture uses a nonce-validated user-data root, fresh ports,
    // and exact process-marker cleanup. This mode never runs the installer.
  } else {
    assert.deepEqual(running, [], "an installed Harness process is running; refusing to stop or replace it");
  }

  const portableCopy = path.join(runRoot, path.basename(portable));
  await fs.copyFile(portable, portableCopy);
  const copyDigest = await fileDigest(portableCopy);
  assert.equal(copyDigest.sha256, candidateBinding.portable_sha256, "fixture Portable copy differs from verified EXE");
  assert.equal(copyDigest.bytes, candidateBinding.portable_bytes);
  notificationBaseline = await notificationSnapshot();
  notificationObservations.push({ stage: "before candidate launch", unchanged: true, entries: notificationBaseline });
  console.log(`CLEAN_HOST_PHASE portable artifact copied`);
  const results = [await exercise(portableCopy, "portable")];

  let installRoot = null;
  let previousVersion = null;
  if (replaceExistingInstall) {
    assert.equal(before.length, 1, "authorized in-place replacement requires one existing isolated Harness installation");
    const record = before[0];
    previousVersion = String(record.DisplayVersion || "") || null;
    installRoot = assertSafeInstallRoot(installRootFromRecord(record));
    const uninstaller = commandExecutable(record.QuietUninstallString) || commandExecutable(record.UninstallString);
    assert.ok(uninstaller && await exists(uninstaller), `registered uninstaller is missing: ${uninstaller}`);
    assert.equal(path.dirname(uninstaller).toLowerCase(), installRoot.toLowerCase(), "uninstaller is outside the verified installation directory");
    console.log(`CLEAN_HOST_PHASE uninstall ${previousVersion} from ${installRoot}`);
    replacementAttempted = true;
    await execFileAsync(uninstaller, ["/currentuser", "/S"], { cwd: runRoot, windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    await waitUntil(async () => (await existingInstallRecords()).length === 0, "previous uninstall registration removal");
    if (await exists(installRoot)) {
      assertSafeInstallRoot(installRoot);
      await fs.rm(installRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    }
    console.log(`CLEAN_HOST_PHASE install ${version} to ${installRoot}`);
    installerAttempted = true;
    const installedExe = await installCandidate(installRoot);
    // An explicitly authorized installer may legitimately update its own
    // shortcuts. Monitor the installed fixture against its post-install state.
    notificationBaseline = await notificationSnapshot();
    notificationObservations.push({ stage: "after authorized installer, before setup fixture", unchanged: true, entries: notificationBaseline });
    results.push(await exercise(installedExe, "setup"));
    const after = await existingInstallRecords();
    assert.equal(after.length, 1, "candidate installation registration is missing or ambiguous");
    assert.equal(String(after[0].DisplayVersion), version, "installed version differs from candidate");
    assert.equal(assertSafeInstallRoot(installRootFromRecord(after[0])).toLowerCase(), installRoot.toLowerCase(), "candidate was not installed into the previous directory");
  }

  const report = {
    passed: true,
    version,
    release_root: releaseRoot,
    results,
    portable_profile_acceptance: true,
    installer_executed: Boolean(installRoot),
    installed_profile_acceptance: Boolean(installRoot),
    replaced_version: previousVersion,
    installed_version_after_acceptance: installRoot ? version : null,
    installed_root: installRoot,
    host_dependencies: { codex: false, global_python: false, user_chrome: false },
    live_runtime_touched: false,
    protected_live_pid: protectedIdentity ? protectedPid : null,
    candidate_binding: candidateBinding,
    notification_shortcuts: { baseline: notificationBaseline, observations: notificationObservations },
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`BUILTIN_CLEAN_HOST_ACCEPTANCE ${JSON.stringify(report)}`);
}

let acceptanceFailure = null;
try { await main(); } catch (error) { acceptanceFailure = error; }
finally {
  try { await stopOwnedProcesses(runRoot); } catch (error) { acceptanceFailure ||= error; }
  if (notificationBaseline) {
    try { await checkNotificationShortcuts("final cleanup"); } catch (error) { acceptanceFailure ||= error; }
  }
  if (protectedIdentity) try {
    const current = (await isolatedProductProcesses()).find(row => Number(row.ProcessId) === protectedPid);
    assert.ok(current, "the protected live runtime disappeared during Portable acceptance");
    for (const field of ["CreationDate", "ExecutablePath", "CommandLine"]) {
      assert.equal(String(current[field]), String(protectedIdentity[field]), `protected runtime ${field} changed`);
    }
  } catch (error) { acceptanceFailure ||= error; }
  if (!acceptanceFailure && notificationBaseline) {
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      report.notification_shortcuts = { baseline: notificationBaseline, observations: notificationObservations };
      await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    } catch (error) { acceptanceFailure ||= error; }
  }
  if (acceptanceFailure) {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify({ passed: false, error: String(acceptanceFailure),
      notification_shortcuts: { baseline: notificationBaseline, observations: notificationObservations },
      installer_executed: installerAttempted ? null : false, installer_attempted: installerAttempted,
      replacement_attempted: replacementAttempted }, null, 2)}\n`, "utf8");
  }
  if (process.env.KEEP_ACCEPTANCE_TMP === "1") console.log(`clean-host temp retained: ${runRoot}`);
  else { ensureInside(path.dirname(runRoot), runRoot); await fs.rm(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => undefined); }
}
if (acceptanceFailure) throw acceptanceFailure;
