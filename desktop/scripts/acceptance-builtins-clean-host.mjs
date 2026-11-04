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
    minimizeToTray: false, relayEnabled: false,
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

async function stopExercise(app, mcpIdentity, profile) {
  const appIdentity = await processIdentity(app.pid).catch(() => null);
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

async function exercise(exe, label) {
  const scope = path.join(runRoot, label.replaceAll(" ", "-"));
  await fs.mkdir(scope, { recursive: true });
  // The offline Portable carries and materializes several gigabytes of
  // Browser Use dependencies before Electron can start the MCP process.
  // Keep the normal installed-app limit strict while allowing a real cold
  // Portable launch to finish on machines with antivirus scanning enabled.
  const healthTimeoutMs = label === "portable" ? 480_000 : 360_000;
  let profile = await prepareProfile(scope, true);
  let app = spawnApp(exe, scope, profile);
  console.log(`CLEAN_HOST_PHASE ${label} enabled launch pid=${app.pid}`);
  let enabledStartupMs = null;
  let disabledStartupMs = null;
  let mcpIdentity = null;
  try {
    const health = await waitHealth(profile.mcpPort, app, `${label} enabled`, healthTimeoutMs);
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
    const session = await initialize(profile.mcpPort);
    const tools = await rpc(profile.mcpPort, session, 3, "tools/list", {});
    const names = new Set((tools?.tools || []).map((tool) => tool.name));
    assert.deepEqual([...names].sort(), [...expectedSlim, "computer_use", "browser_use_exec", "browser_use_screenshot"].sort(), `${label} enabled tools/list`);
    for (const name of ["computer_use", "browser_use_exec", "browser_use_screenshot"]) assert.ok(names.has(name), `${label} missing ${name}`);
    const computer = await rpc(profile.mcpPort, session, 4, "tools/call", { name: "computer_use", arguments: { action: "status", _intent: INTENT } });
    assert.equal(computer?.structuredContent?.ok, true, `${label} Computer Use status failed`);
    const browser = await rpc(profile.mcpPort, session, 5, "tools/call", { name: "browser_use_screenshot", arguments: { full: false, max_dim: 640, _intent: INTENT } });
    assert.notEqual(browser?.isError, true, `${label} Browser Use screenshot failed`);
    assert.ok((browser?.content || []).some((item) => item.type === "image" && item.data), `${label} Browser Use image missing`);
    await deleteSession(profile.mcpPort, session);
    console.log(`CLEAN_HOST_PHASE ${label} enabled builtins passed`);
  } finally {
    await stopExercise(app, mcpIdentity, profile);
  }
  assert.equal(await portClosed(profile.mcpPort), true, `${label} enabled MCP port remained open`);

  profile = await prepareProfile(scope, false);
  app = spawnApp(exe, scope, profile);
  console.log(`CLEAN_HOST_PHASE ${label} disabled launch pid=${app.pid}`);
  mcpIdentity = null;
  try {
    const health = await waitHealth(profile.mcpPort, app, `${label} disabled`, healthTimeoutMs);
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
    const session = await initialize(profile.mcpPort);
    const tools = await rpc(profile.mcpPort, session, 6, "tools/list", {});
    const names = new Set((tools?.tools || []).map((tool) => tool.name));
    assert.deepEqual([...names].sort(), expectedSlim, `${label} disabled tools/list`);
    for (const name of ["computer_use", "browser_use_exec", "browser_use_screenshot"]) assert.equal(names.has(name), false, `${label} disabled ${name} leaked`);
    await deleteSession(profile.mcpPort, session);
    console.log(`CLEAN_HOST_PHASE ${label} disabled profile passed`);
  } finally {
    await stopExercise(app, mcpIdentity, profile);
  }
  assert.equal(await exists(path.join(profile.userData, "computer-use", "capability.json")), false, `${label} disabled capability token remained`);
  assert.equal(await portClosed(profile.mcpPort), true, `${label} disabled MCP port remained open`);
  return { label, enabled_tools: expectedSlim.length + 3, disabled_tools: expectedSlim.length, enabled_startup_ms: enabledStartupMs, disabled_startup_ms: disabledStartupMs };
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
    await execFileAsync(uninstaller, ["/currentuser", "/S"], { cwd: runRoot, windowsHide: true, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    await waitUntil(async () => (await existingInstallRecords()).length === 0, "previous uninstall registration removal");
    if (await exists(installRoot)) {
      assertSafeInstallRoot(installRoot);
      await fs.rm(installRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    }
    console.log(`CLEAN_HOST_PHASE install ${version} to ${installRoot}`);
    const installedExe = await installCandidate(installRoot);
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
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`BUILTIN_CLEAN_HOST_ACCEPTANCE ${JSON.stringify(report)}`);
}

try { await main(); }
finally {
  await stopOwnedProcesses(runRoot).catch(() => undefined);
  if (protectedIdentity) {
    const current = (await isolatedProductProcesses()).find(row => Number(row.ProcessId) === protectedPid);
    assert.ok(current, "the protected live runtime disappeared during Portable acceptance");
    for (const field of ["CreationDate", "ExecutablePath", "CommandLine"]) {
      assert.equal(String(current[field]), String(protectedIdentity[field]), `protected runtime ${field} changed`);
    }
  }
  if (process.env.KEEP_ACCEPTANCE_TMP === "1") console.log(`clean-host temp retained: ${runRoot}`);
  else { ensureInside(path.dirname(runRoot), runRoot); await fs.rm(runRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 }).catch(() => undefined); }
}
