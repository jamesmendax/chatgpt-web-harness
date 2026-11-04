/**
 * Phase 4 local acceptance for the Windows desktop artifacts.
 *
 * This test installs the NSIS package only into a fresh task-scoped directory
 * and launches every delivered executable with disposable userData/workspace
 * paths plus a test-only Admin token.  It never passes --delete-app-data and
 * never touches the user's real Electron AppData.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { validatePayload } = require("../src/payload-manifest.js");
const { extractFile } = require("@electron/asar");
const { version: releaseVersion } = require("../package.json");

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const { SLIM_CHATGPT_TOOLS } = await import(pathToFileURL(path.join(repoRoot, "dist", "lib", "tool-profile.js")).href);
const expectedSlim = [...SLIM_CHATGPT_TOOLS].sort();
assert.ok(expectedSlim.includes("route_skills"), "runtime slim profile is missing route_skills");
const expectedSlimHash = crypto.createHash("sha256").update(expectedSlim.join("\n")).digest("hex");
const desktopRoot = path.join(repoRoot, "desktop");
const releaseRoot = path.join(desktopRoot, "release");
const taskTmpRoot = path.join(process.env.HARNESS_ACCEPTANCE_TMP_ROOT || path.join(os.tmpdir(), "chatgpt-web-harness"), ".codex-tmp");
const runRoot = path.join(taskTmpRoot, `client-optimization-acceptance-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`);
const adminToken = "phase4-admin-test-only";
const nsisTimeout = Number(process.env.HARNESS_NSIS_TIMEOUT_MS || 180_000);
const nsisRemovalTimeout = Number(process.env.HARNESS_NSIS_REMOVAL_TIMEOUT_MS || 60_000);

const textExtensions = new Set([
  ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".yaml", ".yml", ".env", ".toml", ".ts", ".tsx", ".css", ".html", ".xml",
]);
const personalDrive = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/;
const narrowPersonalDrive = /[A-Za-z]:[\\/](?:chatgpt-local-coder|Crack|Coding)(?:[\\/]|$)/i;

const checks = [];
function pass(name, detail = "") {
  checks.push({ name, ok: true, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, error) {
  checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
  console.error(`FAIL ${name} — ${checks.at(-1).detail}`);
}
function ensure(condition, message) {
  assert.ok(condition, message);
}

function pathInside(parent, target) {
  const base = path.resolve(parent);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function statFile(file, label = file) {
  const stat = await fs.stat(file);
  ensure(stat.isFile() && stat.size > 0, `${label} must be a non-empty file`);
  return stat;
}

async function listFiles(root) {
  const files = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  if (await exists(root)) await visit(root);
  return files;
}

async function scanText(root, pattern) {
  const hits = [];
  for (const file of await listFiles(root)) {
    if (!textExtensions.has(path.extname(file).toLowerCase()) && path.basename(file) !== ".env.example") continue;
    const stat = await fs.stat(file);
    if (stat.size > 8 * 1024 * 1024) continue;
    const content = await fs.readFile(file, "utf8");
    if (pattern.test(content)) hits.push(path.relative(root, file));
  }
  return hits;
}

async function inspectPayload(payloadRoot, label) {
  const appPackage = JSON.parse(extractFile(path.join(payloadRoot, "resources", "app.asar"), "package.json").toString("utf8"));
  ensure(appPackage.version === releaseVersion, `${label} version ${appPackage.version} differs from release ${releaseVersion}`);
  const harnessRoot = path.join(payloadRoot, "resources", "harness");
  const manifestStats = validatePayload(harnessRoot);
  ensure(manifestStats.file_count > 0 && manifestStats.total_bytes > 0, `${label} payload manifest is empty`);
  await statFile(path.join(harnessRoot, "dist", "lib", "skill-resolver.js"), `${label} resolver`);
  const packageFile = path.join(harnessRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageFile, "utf8"));
  ensure(packageJson.type === "module", `${label} harness package must be type=module`);
  const expressPackage = path.join(harnessRoot, "node_modules", "express", "package.json");
  await statFile(expressPackage, `${label} bundled express`);
  const mcpPackage = path.join(harnessRoot, "node_modules", "mcp-sdk", "package.json");
  await statFile(mcpPackage, `${label} bundled MCP SDK`);
  ensure(!(await exists(path.join(harnessRoot, "node_modules", "@modelcontextprotocol"))), `${label} retained the long MCP SDK scope`);
  const playwrightPackage = path.join(harnessRoot, "node_modules", "pw", "package.json");
  await statFile(playwrightPackage, `${label} bundled Playwright runtime`);
  ensure(!(await exists(path.join(harnessRoot, "node_modules", "playwright-core"))), `${label} retained the long Playwright package path`);
  ensure(!(await exists(path.join(harnessRoot, "skills"))), `${label} must not preinstall any Skill directory`);
  ensure(!(await exists(path.join(harnessRoot, "profiles", "local-skills"))), `${label} profiles must not contain local-skills`);
  const profileRoot = path.join(harnessRoot, "profiles");
  const expected = new Set([
    "chatgpt-connector-description.txt",
    "mcp-upstream.json",
    "plugins.json",
    "post-edit-hooks.json",
  ]);
  const actual = new Set((await fs.readdir(profileRoot)).sort());
  ensure(actual.size === expected.size && [...expected].every((item) => actual.has(item)), `${label} profile whitelist mismatch: ${[...actual].join(", ")}`);
  const plugins = JSON.parse(await fs.readFile(path.join(profileRoot, "plugins.json"), "utf8"));
  const upstream = JSON.parse(await fs.readFile(path.join(profileRoot, "mcp-upstream.json"), "utf8"));
  ensure(plugins.schema_version === 2 && Array.isArray(plugins.skills) && plugins.skills.length === 0, `${label} plugins seed must be empty v2`);
  ensure(Array.isArray(upstream.servers) && upstream.servers.length === 0, `${label} upstream seed must be empty`);
  const genericHits = await scanText(profileRoot, personalDrive);
  const narrowHits = await scanText(harnessRoot, narrowPersonalDrive);
  ensure(genericHits.length === 0, `${label} profiles contain drive paths: ${genericHits.join(", ")}`);
  ensure(narrowHits.length === 0, `${label} contains developer paths: ${narrowHits.join(", ")}`);
  return { harnessRoot, profileRoot, manifestStats };
}

async function findExtractedPayloads(tempRoot) {
  const candidates = [];
  async function visit(dir, depth) {
    if (depth > 5) return;
    if (await exists(path.join(dir, "resources", "harness", "harness-files.json"))) {
      // NSIS 7z keeps an internal `*.tmp\\7z-out` tree beside the final
      // extraction directory. The product's patched portable template names
      // the final tree `cgh-<pid>`; count only those process-isolated roots so
      // the concurrent check does not mistake the staging tree for a third
      // launcher instance.
      if (/^cgh-\d+$/i.test(path.basename(dir))) candidates.push(dir);
      return;
    }
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(tempRoot, 0);
  return candidates;
}

async function payloadTreeStats(root) {
  const files = await listFiles(root);
  return {
    files: files.length,
    bytes: (await Promise.all(files.map(async (file) => (await fs.stat(file)).size))).reduce((sum, size) => sum + size, 0),
  };
}

async function assertPayloadContains(expectedRoot, actualRoot, label) {
  const expectedFiles = await listFiles(expectedRoot);
  const actualFiles = new Map();
  for (const file of await listFiles(actualRoot)) {
    actualFiles.set(path.relative(actualRoot, file).toLowerCase(), file);
  }
  const missing = [];
  const sizeMismatches = [];
  for (const expected of expectedFiles) {
    const relative = path.relative(expectedRoot, expected).toLowerCase();
    const actual = actualFiles.get(relative);
    if (!actual) {
      missing.push(relative);
      continue;
    }
    const expectedSize = (await fs.stat(expected)).size;
    const actualSize = (await fs.stat(actual)).size;
    if (expectedSize !== actualSize) sizeMismatches.push(`${relative} (${actualSize}/${expectedSize})`);
  }
  ensure(missing.length === 0, `${label} missing files from packaged tree: ${missing.slice(0, 8).join(", ")}`);
  ensure(sizeMismatches.length === 0, `${label} packaged file size mismatches: ${sizeMismatches.slice(0, 8).join(", ")}`);
  return { expected_files: expectedFiles.length, actual_files: actualFiles.size };
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

async function powershellExpand(zipFile, destination) {
  const quote = (value) => String(value).replaceAll("'", "''");
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    `Expand-Archive -LiteralPath '${quote(zipFile)}' -DestinationPath '${quote(destination)}' -Force`,
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
}

async function powershellText(script, timeout = 10_000) {
  const result = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
  ], { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" });
  return String(result.stdout || "").trim();
}

async function assertNoNamedProcesses(label) {
  const text = await powershellText("$ErrorActionPreference='SilentlyContinue'; $ids=@(Get-Process -Name 'ChatGPT Web Harness','tunnel-client' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); if($ids.Count){ $ids | ConvertTo-Json -Compress } else { '[]' }; exit 0");
  if (text && text !== "null" && text !== "[]") throw new Error(`${label}: detected pre-existing ChatGPT Web Harness/tunnel-client process (${text})`);
}

async function shortcutSnapshot() {
  const script = "$w=New-Object -ComObject WScript.Shell; $items=@(); $desktop=[Environment]::GetFolderPath('Desktop'); $start=[IO.Path]::Combine([Environment]::GetFolderPath('ApplicationData'),'Microsoft','Windows','Start Menu','Programs'); $paths=@(); $desktopLink=[IO.Path]::Combine($desktop,'ChatGPT Web Harness.lnk'); if(Test-Path -LiteralPath $desktopLink){ $paths += $desktopLink }; if(Test-Path -LiteralPath $start){ $paths += @(Get-ChildItem -LiteralPath $start -Filter 'ChatGPT Web Harness*.lnk' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName) }; foreach($p in $paths){ $s=$w.CreateShortcut($p); $items += [pscustomobject]@{path=$p; target=$s.TargetPath; working_directory=$s.WorkingDirectory} }; if($items.Count){ $items | ConvertTo-Json -Compress -Depth 3 } else { '[]' }; exit 0";
  const text = await powershellText(script);
  if (!text || text === "null") return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function uninstallSnapshot() {
  const script = "$root='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; $items=@(); foreach($key in Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue){ $p=Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue; if($p.DisplayName -like 'ChatGPT Web Harness*'){ $items += [pscustomobject]@{key=$key.Name; display_name=$p.DisplayName; uninstall_string=$p.UninstallString; install_location=$p.InstallLocation} } }; $items | ConvertTo-Json -Compress -Depth 3";
  const text = await powershellText(script);
  if (!text || text === "null") return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function runBounded(command, args, options = {}) {
  return execFileAsync(command, args, {
    windowsHide: true,
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  });
}

async function waitForGone(target, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (await exists(target) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !(await exists(target));
}

async function waitForUninstallArtifactsGone(timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last = { keys: [], links: [] };
  while (Date.now() < deadline) {
    last = { keys: await uninstallSnapshot(), links: await shortcutSnapshot() };
    if (last.keys.length === 0 && last.links.length === 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

async function removeTaskTree(root, target) {
  ensure(pathInside(root, target), `cleanup target escaped task root: ${target}`);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      if (!(await exists(target))) return;
    } catch (error) {
      if (!/EBUSY|EPERM|ENOTEMPTY/i.test(String(error?.code || error?.message || "")) || attempt === 11) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  ensure(!(await exists(target)), `task cleanup left target: ${target}`);
}

async function findHarnessRoot(root) {
  const candidates = [];
  async function visit(dir, depth) {
    if (depth > 4) return;
    if (await exists(path.join(dir, "resources", "harness", "package.json"))) {
      candidates.push(path.join(dir, "resources", "harness"));
      return;
    }
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
    }
  }
  await visit(root, 0);
  ensure(candidates.length === 1, `zip must contain exactly one Electron payload (found ${candidates.length})`);
  return path.dirname(path.dirname(candidates[0]));
}

async function findFreePort() {
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

async function httpJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function waitForJson(url, predicate, timeout = 45_000, options = {}) {
  const deadline = Date.now() + timeout;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const result = await httpJson(url, options);
      last = `${result.response.status}: ${result.text.slice(0, 300)}`;
      if (result.response.ok && predicate(result.json)) return result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

function scrubEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:OPENAI_TUNNEL_API_KEY|CONTROL_PLANE_API_KEY|MCP_TOKEN|MCP_API_KEY|RUNTIME_API_KEY|.*COOKIE.*|.*PASSWORD.*|.*SECRET.*)$/i.test(key)) delete env[key];
  }
  env.ADMIN_TOKEN = adminToken;
  env.CHATGPT_TOOL_PROFILE = "slim";
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  return env;
}

async function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, maxBuffer: 256 * 1024 });
  } catch {}
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function extractToolData(result) {
  ensure(result?.structuredContent?.ok === true, `MCP tool failed: ${JSON.stringify(result?.structuredContent).slice(0, 500)}`);
  return result.structuredContent.data;
}

function assertToolRejected(result, label) {
  ensure(result?.isError === true || result?.structuredContent?.ok === false, `${label} unexpectedly succeeded: ${JSON.stringify(result).slice(0, 500)}`);
}

async function initializeMcp(baseUrl) {
  const { response, text } = await httpJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "phase4-acceptance", version: "1" } },
    }),
  });
  const sessionId = response.headers.get("mcp-session-id");
  ensure(response.ok && sessionId, `MCP initialize failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return sessionId;
}

async function mcpRpc(baseUrl, sessionId, id, method, params = {}) {
  const { response, text, json } = await httpJson(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  ensure(response.ok && json?.result, `MCP ${method} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
  return json.result;
}

async function makeFixture() {
  const fixture = path.join(runRoot, "presentation fixture with spaces");
  await fs.mkdir(path.join(fixture, "references"), { recursive: true });
  await fs.mkdir(path.join(fixture, "scripts"), { recursive: true });
  await fs.writeFile(path.join(fixture, "SKILL.md"), [
    "---",
    "name: ppt-master",
    "description: >",
    "  Portable presentation fixture description",
    "  requests that mention ppt-master",
    "metadata:",
    "  version: 5.1.0-fixture",
    "---",
    "",
    "Use the installed presentation fixture.",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(fixture, "references", "usage.md"), "Fixture reference contract\n", "utf8");
  await fs.writeFile(path.join(fixture, "scripts", "attribution_guard.py"), "import sys\nsys.exit(0)\n", "utf8");
  return fixture;
}

async function launch(exe, userData, workspace, mcpPort, adminPort, envOverrides = {}) {
  const config = {
    version: 1,
    setupDone: true,
    tunnelId: "",
    apiKeyEnc: "",
    workspacePath: workspace,
    mcpPort,
    adminPort,
    tunnelPort: await findFreePort(),
    toolProfile: "slim",
    autoStart: true,
    minimizeToTray: false,
  };
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(userData, "config.json"), JSON.stringify(config, null, 2), "utf8");
  const child = spawn(exe, [`--user-data-dir=${userData}`, "--disable-gpu", "--disable-software-rasterizer"], {
    cwd: path.dirname(exe),
    env: { ...scrubEnvironment(), ...envOverrides },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let log = "";
  const append = (chunk) => {
    log += String(chunk);
    if (log.length > 120_000) log = log.slice(-120_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", append);
  return { child, config, log: () => log };
}

async function assertRunning(appRun, fixture, userData, mcpPort, adminPort, label) {
  const mcpBase = `http://127.0.0.1:${mcpPort}`;
  const adminBase = `http://127.0.0.1:${adminPort}`;
  let mcpHealth;
  try {
    mcpHealth = await waitForJson(`${mcpBase}/health`, (json) => json?.name === "codex-mcp-server");
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\\nchild pid=${appRun.child.pid} exit=${appRun.child.exitCode} signal=${appRun.child.signalCode}\\nlauncher output:\\n${appRun.log().slice(-6000)}`);
  }
  ensure(mcpHealth.json.runtime?.tool_profile === "slim" && mcpHealth.json.runtime?.tool_count === expectedSlim.length && mcpHealth.json.runtime?.tool_manifest_hash === expectedSlimHash, `${label} MCP slim manifest differs from the runtime profile`);
  ensure(mcpHealth.json.runtime?.stale_build === false, `${label} MCP stale build`);
  let adminHealth;
  try {
    adminHealth = await waitForJson(`${adminBase}/health`, (json) => json?.name === "codex-mcp-admin", 45_000, {
      headers: { "x-admin-token": adminToken },
    });
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}\\nchild pid=${appRun.child.pid} exit=${appRun.child.exitCode} signal=${appRun.child.signalCode}\\nlauncher output:\\n${appRun.log().slice(-6000)}`);
  }
  ensure(adminHealth.json.status === "ok", `${label} Admin health not ok`);
  const unauthorized = await httpJson(`${adminBase}/api/skills`);
  ensure(unauthorized.response.status === 401, `${label} Admin token guard expected 401, got ${unauthorized.response.status}`);
  const shim = path.join(userData, "node-bin", "node.cmd");
  await waitForJson(`${adminBase}/api/skills`, (json) => json?.ok === true, 10_000, { headers: { "x-admin-token": adminToken } });
  ensure(await exists(shim), `${label} Electron Node shim not created`);
  const shimText = await fs.readFile(shim, "utf8");
  ensure(shimText.includes("ELECTRON_RUN_AS_NODE=1") && shimText.includes("%*"), `${label} node.cmd is not a forwarding shim`);

  const listBefore = await httpJson(`${adminBase}/api/skills`, { headers: { "x-admin-token": adminToken } });
  ensure(listBefore.response.ok && Array.isArray(listBefore.json?.skills), `${label} Admin skill list failed`);
  const install = await httpJson(`${adminBase}/api/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({ source: fixture, id: "presentation", overwrite: true }),
  });
  ensure(install.response.status === 201 && install.json?.ok === true, `${label} Admin install failed: ${install.text.slice(0, 500)}`);
  const installed = install.json.skills.find((skill) => skill.id.toLowerCase() === "presentation");
  ensure(installed?.source === "installed" && installed.aliases.includes("ppt-master"), `${label} installed alias missing`);
  ensure(installed.description.includes("requests that mention ppt-master") && installed.description !== ">", `${label} folded description was not parsed`);
  ensure(installed.version === "5.1.0-fixture", `${label} frontmatter version missing`);

  const sessionId = await initializeMcp(mcpBase);
  const toolsList = await mcpRpc(mcpBase, sessionId, 2, "tools/list");
  const toolNames = (toolsList.tools || []).map((tool) => tool.name);
  assert.deepEqual([...toolNames].sort(), expectedSlim, `${label} actual tools/list differs from the slim profile`);
  for (const name of ["route_skills", "list_skills", "load_skill", "install_skill", "uninstall_skill", "set_skill_enabled", "run_command"]) {
    ensure(toolNames.includes(name), `${label} slim tools/list missing ${name}`);
  }
  const listed = extractToolData(await mcpRpc(mcpBase, sessionId, 3, "tools/call", { name: "list_skills", arguments: {} }));
  ensure(listed.skills.some((skill) => skill.name === "presentation"), `${label} MCP list_skills missing installed fixture`);
  const adminAfterInstall = await httpJson(`${adminBase}/api/skills`, { headers: { "x-admin-token": adminToken } });
  ensure(adminAfterInstall.response.ok, `${label} Admin catalog after install failed`);
  const catalogKey = (skill) => `${String(skill.id || skill.name).toLowerCase()}|${skill.source}`;
  const mcpWinners = listed.skills.map(catalogKey).sort();
  const adminWinners = adminAfterInstall.json.skills.filter((skill) => skill.enabled && !skill.shadowedBy && !skill.error).map(catalogKey).sort();
  ensure(JSON.stringify(mcpWinners) === JSON.stringify(adminWinners), `${label} desktop catalog winners diverge from MCP: ${JSON.stringify({ mcpWinners, adminWinners })}`);
  const byId = extractToolData(await mcpRpc(mcpBase, sessionId, 4, "tools/call", { name: "load_skill", arguments: { name: "presentation" } }));
  const byAlias = extractToolData(await mcpRpc(mcpBase, sessionId, 5, "tools/call", { name: "load_skill", arguments: { name: "ppt-master" } }));
  ensure(byId.resolved_via === "id" && byAlias.resolved_via === "alias", `${label} id/alias resolution incorrect`);
  ensure(byId.dir === byAlias.dir && byId.dir.startsWith(path.join(userData, "runtime", "profiles", "local-skills")), `${label} load_skill dir escaped runtime`);
  ensure(byId.layout.references.includes("usage.md"), `${label} Skill layout missing reference`);
  const nodeProbe = await mcpRpc(mcpBase, sessionId, 6, "tools/call", {
    name: "run_command",
    arguments: { command: "node -e \"process.stdout.write(process.cwd())\"", working_directory: byId.dir, output_mode: "compact" },
  });
  const nodeResult = extractToolData(nodeProbe);
  ensure(nodeResult.exit_code === 0 && path.resolve(nodeResult.stdout.trim()) === path.resolve(byId.dir), `${label} packaged node shim/one-off cwd failed: ${JSON.stringify(nodeResult).slice(0, 500)}`);
  const pythonProbe = await mcpRpc(mcpBase, sessionId, 7, "tools/call", {
      name: "run_command",
      arguments: { command: "python scripts/attribution_guard.py", working_directory: byId.dir, output_mode: "compact" },
    });
  if (pythonProbe.structuredContent?.ok === true) {
    const runResult = extractToolData(pythonProbe);
    ensure(runResult.exit_code === 0, `${label} attribution_guard.py failed: ${JSON.stringify(runResult).slice(0, 500)}`);
  } else {
    const probeText = JSON.stringify(pythonProbe);
    ensure(/python|not found|not recognized|无法将|找不到|无法识别/i.test(probeText), `${label} attribution_guard.py failed: ${probeText.slice(0, 500)}`);
    pass(`${label} Python fixture skipped (interpreter unavailable)`);
  }
  const shellStatusBefore = extractToolData(await mcpRpc(mcpBase, sessionId, 8, "tools/call", { name: "shell_status", arguments: {} }));
  ensure(path.resolve(shellStatusBefore.cwd) === path.resolve(appRun.config.workspacePath), `${label} initial shell cwd changed`);

  // MCP must reject relative sources, attempts to reinstall from its managed
  // local-skills tree, and the reserved Computer Use id before copying data.
  assertToolRejected(await mcpRpc(mcpBase, sessionId, 15, "tools/call", { name: "install_skill", arguments: { source: "relative/skill", id: "bad-source" } }), `${label} relative install source`);
  assertToolRejected(await mcpRpc(mcpBase, sessionId, 16, "tools/call", { name: "install_skill", arguments: { source: path.join(userData, "runtime", "profiles", "local-skills", "presentation"), id: "self-copy" } }), `${label} local-skills self-copy`);
  assertToolRejected(await mcpRpc(mcpBase, sessionId, 17, "tools/call", { name: "install_skill", arguments: { source: fixture, id: "computer-use" } }), `${label} reserved computer-use id`);

  const removedByMcp = extractToolData(await mcpRpc(mcpBase, sessionId, 9, "tools/call", { name: "uninstall_skill", arguments: { id: "presentation" } }));
  ensure(removedByMcp.removed === true && !(await exists(path.join(userData, "runtime", "profiles", "local-skills", "presentation"))), `${label} MCP uninstall failed`);
  extractToolData(await mcpRpc(mcpBase, sessionId, 10, "tools/call", { name: "install_skill", arguments: { source: fixture, id: "presentation" } }));
  extractToolData(await mcpRpc(mcpBase, sessionId, 11, "tools/call", { name: "set_skill_enabled", arguments: { id: "presentation", enabled: false } }));
  const hidden = extractToolData(await mcpRpc(mcpBase, sessionId, 12, "tools/call", { name: "list_skills", arguments: {} }));
  ensure(!hidden.skills.some((skill) => skill.name === "presentation"), `${label} disabled Skill leaked into MCP list`);
  const disabledLoad = await mcpRpc(mcpBase, sessionId, 18, "tools/call", { name: "load_skill", arguments: { name: "presentation" } });
  assertToolRejected(disabledLoad, `${label} disabled load_skill`);
  extractToolData(await mcpRpc(mcpBase, sessionId, 13, "tools/call", { name: "uninstall_skill", arguments: { id: "presentation" } }));
  ensure(!(await exists(path.join(userData, "runtime", "profiles", "local-skills", "presentation"))), `${label} disabled Skill uninstall failed`);
  const reinstall = await httpJson(`${adminBase}/api/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-token": adminToken },
    body: JSON.stringify({ source: fixture, id: "presentation", overwrite: true }),
  });
  ensure(reinstall.response.status === 201 && reinstall.json?.ok === true, `${label} final Admin reinstall failed`);
  const reloaded = extractToolData(await mcpRpc(mcpBase, sessionId, 19, "tools/call", { name: "load_skill", arguments: { name: "presentation" } }));
  ensure(reloaded.resolved_via === "id", `${label} re-enabled load_skill did not recover live`);
  const shellStatusAfter = extractToolData(await mcpRpc(mcpBase, sessionId, 14, "tools/call", { name: "shell_status", arguments: {} }));
  ensure(path.resolve(shellStatusAfter.cwd) === path.resolve(appRun.config.workspacePath), `${label} one-off Skill command changed persistent cwd`);
  return { mcpHealth: mcpHealth.json, adminHealth: adminHealth.json, sessionId, dir: byId.dir };
}

async function main() {
  await fs.mkdir(taskTmpRoot, { recursive: true });
  await fs.mkdir(runRoot, { recursive: true });
  const portableExe = path.join(releaseRoot, `ChatGPT Web Harness-${releaseVersion}-portable.exe`);
  const setupExe = path.join(releaseRoot, `ChatGPT Web Harness-${releaseVersion}-setup.exe`);
  const zipFile = path.join(releaseRoot, `ChatGPT Web Harness-${releaseVersion}-x64.zip`);
  await statFile(portableExe, "portable EXE");
  await statFile(setupExe, "setup EXE");
  await statFile(zipFile, "zip artifact");
  pass("release artifacts exist", `portable=${(await fs.stat(portableExe)).size}B setup=${(await fs.stat(setupExe)).size}B zip=${(await fs.stat(zipFile)).size}B`);

  const unpacked = path.join(releaseRoot, "win-unpacked");
  const unpackedInspection = await inspectPayload(unpacked, "win-unpacked");
  pass("win-unpacked payload is self-contained and zero-Skill");
  const zipExtract = path.join(runRoot, "zip-extract");
  await powershellExpand(zipFile, zipExtract);
  const zipPayload = await findHarnessRoot(zipExtract);
  await inspectPayload(zipPayload, "zip");
  pass("zip payload is self-contained and zero-Skill");
  const resolverUrl = pathToFileURL(path.join(unpacked, "resources", "harness", "dist", "lib", "skill-resolver.js")).href;
  const resolver = await import(resolverUrl);
  ensure(typeof resolver.resolveSkills === "function", "packaged resolver import failed");
  pass("packaged resolver imports");

  const fixture = await makeFixture();

  // The delivered ZIP executable gets its own full lifecycle; static
  // equivalence with win-unpacked is not sufficient for Phase 4.
  const zipExe = path.join(zipPayload, "ChatGPT Web Harness.exe");
  await statFile(zipExe, "zip executable");
  const zipMcpPort = await findFreePort();
  let zipAdminPort = await findFreePort();
  while (zipAdminPort === zipMcpPort) zipAdminPort = await findFreePort();
  const zipUserData = path.join(runRoot, "zip user data with spaces");
  const zipWorkspace = path.join(runRoot, "zip workspace with spaces");
  await fs.mkdir(zipWorkspace, { recursive: true });
  let zipAppRun = null;
  try {
    zipAppRun = await launch(zipExe, zipUserData, zipWorkspace, zipMcpPort, zipAdminPort);
    const zipResult = await assertRunning(zipAppRun, fixture, zipUserData, zipMcpPort, zipAdminPort, "zip executable");
    pass("zip extracted executable isolated lifecycle", `tools=${zipResult.mcpHealth.runtime.tool_count}`);
  } finally {
    if (zipAppRun) await killTree(zipAppRun.child);
  }

  // Current-user NSIS lifecycle.  Only a fresh task directory is allowed;
  // pre-existing uninstall records, shortcuts, or named processes abort the
  // test rather than risking a global taskkill or key collision.
  const setupInstallRoot = path.join(runRoot, "setup-install with spaces");
  const setupUserData = path.join(runRoot, "setup user data with spaces");
  const setupWorkspace = path.join(runRoot, "setup workspace with spaces");
  const setupPreKeys = await uninstallSnapshot();
  const setupPreLinks = await shortcutSnapshot();
  await assertNoNamedProcesses("before NSIS install");
  ensure(setupPreKeys.length === 0, `pre-existing ChatGPT Web Harness uninstall records: ${JSON.stringify(setupPreKeys)}`);
  ensure(setupPreLinks.length === 0, `pre-existing ChatGPT Web Harness shortcuts: ${JSON.stringify(setupPreLinks)}`);
  let setupInstalled = false;
  let setupAppRun = null;
  let setupUninstaller = "";
  try {
    // NSIS extraction can be delayed by host AV scanning; keep the bound
    // finite, but allow the authorized current-user install enough time.
    await runBounded(setupExe, ["/S", `/D=${setupInstallRoot}`], { timeout: nsisTimeout });
    setupInstalled = true;
    const installedExe = path.join(setupInstallRoot, "ChatGPT Web Harness.exe");
    await statFile(installedExe, "installed setup executable");
    await inspectPayload(setupInstallRoot, "NSIS installed");
    const setupKeys = await uninstallSnapshot();
    const setupLinks = await shortcutSnapshot();
    ensure(setupKeys.length === 1, `NSIS uninstall registry record count=${setupKeys.length}`);
    ensure(setupLinks.length >= 1, `NSIS shortcut creation missing: ${JSON.stringify(setupLinks)}`);
    for (const link of setupLinks) ensure(pathInside(setupInstallRoot, link.target), `shortcut target escaped install root: ${JSON.stringify(link)}`);
    setupUninstaller = (await fs.readdir(setupInstallRoot)).map((name) => path.join(setupInstallRoot, name)).find((file) => /^uninstall.*\.exe$/i.test(path.basename(file))) || "";
    await statFile(setupUninstaller, "NSIS uninstaller");

    const setupMcpPort = await findFreePort();
    let setupAdminPort = await findFreePort();
    while (setupAdminPort === setupMcpPort) setupAdminPort = await findFreePort();
    await fs.mkdir(setupWorkspace, { recursive: true });
    setupAppRun = await launch(installedExe, setupUserData, setupWorkspace, setupMcpPort, setupAdminPort);
    const setupResult = await assertRunning(setupAppRun, fixture, setupUserData, setupMcpPort, setupAdminPort, "NSIS installed executable");
    pass("NSIS current-user installed executable lifecycle", `tools=${setupResult.mcpHealth.runtime.tool_count}; key=${setupKeys[0].key}; shortcuts=${JSON.stringify(setupLinks)}`);
    await killTree(setupAppRun.child);
    setupAppRun = null;
    await assertNoNamedProcesses("before NSIS silent uninstall");

    // No --delete-app-data: silent customUnInstall is intentionally the
    // keep-data branch.  The disposable userData is removed by this test's
    // finally block only after the installed program/registry/shortcut checks.
    // Keep the inherited working directory outside the tree being removed.
    // NSIS launches a temporary child to remove its original executable.
    await runBounded(setupUninstaller, ["/S"], { timeout: nsisTimeout, cwd: runRoot });
    await assertNoNamedProcesses("after NSIS silent uninstall");
    if (!(await waitForGone(setupInstallRoot, nsisRemovalTimeout))) {
      const remaining = (await listFiles(setupInstallRoot)).map((file) => path.relative(setupInstallRoot, file));
      throw new Error(`NSIS install directory remains after uninstall: ${JSON.stringify(remaining.slice(0, 30))}`);
    }
    // NSIS may leave a short-lived self-delete helper after the uninstaller
    // process exits; wait for its registry/shortcut cleanup before deciding
    // that the uninstall record or links were retained.
    const setupAfter = await waitForUninstallArtifactsGone();
    const setupAfterKeys = setupAfter.keys;
    const setupAfterLinks = setupAfter.links;
    ensure(setupAfterKeys.length === 0, `NSIS uninstall registry record remains: ${JSON.stringify(setupAfterKeys)}`);
    ensure(setupAfterLinks.length === 0, `NSIS task shortcuts remain: ${JSON.stringify(setupAfterLinks)}`);
    ensure(await exists(setupUserData), "silent KEEP-DATA branch unexpectedly removed isolated userData");
    pass("NSIS silent uninstall removes only program/registry/shortcuts and preserves data", `userData=${setupUserData}`);
    setupInstalled = false;
  } finally {
    if (setupAppRun) await killTree(setupAppRun.child);
    if (setupInstalled && setupUninstaller && await exists(setupUninstaller)) {
      try {
        await assertNoNamedProcesses("NSIS cleanup before retry");
        await runBounded(setupUninstaller, ["/S"], { timeout: nsisTimeout, cwd: runRoot });
        await waitForGone(setupInstallRoot);
      } catch (error) {
        fail("NSIS cleanup", error);
      }
    }
    // Both paths are created by this test under runRoot; delete only those
    // exact disposable paths, never the user's real AppData directories.
    if (pathInside(runRoot, setupUserData)) await removeTaskTree(runRoot, setupUserData);
    if (pathInside(runRoot, setupInstallRoot)) await removeTaskTree(runRoot, setupInstallRoot);
  }

  const mcpPort = await findFreePort();
  let adminPort = await findFreePort();
  while (adminPort === mcpPort) adminPort = await findFreePort();
  const userData = path.join(runRoot, "user data with spaces");
  const workspace = path.join(runRoot, "workspace with spaces");
  await fs.mkdir(workspace, { recursive: true });
  const firstExe = path.join(runRoot, "portable copy with spaces.exe");
  await fs.copyFile(portableExe, firstExe);
  const concurrentTemp = path.join(runRoot, "portable concurrent temp");
  const concurrentAppData = path.join(runRoot, "portable concurrent appdata");
  const concurrentLocalAppData = path.join(runRoot, "portable concurrent localappdata");
  await fs.mkdir(concurrentTemp, { recursive: true });
  await fs.mkdir(concurrentAppData, { recursive: true });
  await fs.mkdir(concurrentLocalAppData, { recursive: true });
  // Leave an incomplete old-looking directory behind.  With a private
  // $PLUGINSDIR per launch it must not be selected as the live payload.
  await fs.mkdir(path.join(concurrentTemp, "stale-unpack", "resources"), { recursive: true });
  await fs.writeFile(path.join(concurrentTemp, "stale-unpack", "resources", "app.asar"), "stale", "utf8");
  const concurrentOneExe = path.join(runRoot, "portable concurrent one.exe");
  const concurrentTwoExe = path.join(runRoot, "portable concurrent two.exe");
  await fs.copyFile(portableExe, concurrentOneExe);
  await fs.copyFile(portableExe, concurrentTwoExe);
  const concurrentEnv = {
    TEMP: concurrentTemp,
    TMP: concurrentTemp,
    APPDATA: concurrentAppData,
    LOCALAPPDATA: concurrentLocalAppData,
  };
  const concurrentMcpOne = await findFreePort();
  let concurrentAdminOne = await findFreePort();
  while (concurrentAdminOne === concurrentMcpOne) concurrentAdminOne = await findFreePort();
  const concurrentMcpTwo = await findFreePort();
  let concurrentAdminTwo = await findFreePort();
  while (concurrentAdminTwo === concurrentMcpTwo) concurrentAdminTwo = await findFreePort();
  const concurrentUserOne = path.join(runRoot, "portable concurrent user one");
  const concurrentUserTwo = path.join(runRoot, "portable concurrent user two");
  const concurrentWorkspaceOne = path.join(runRoot, "portable concurrent workspace one");
  const concurrentWorkspaceTwo = path.join(runRoot, "portable concurrent workspace two");
  await fs.mkdir(concurrentWorkspaceOne, { recursive: true });
  await fs.mkdir(concurrentWorkspaceTwo, { recursive: true });
  let concurrentRunOne = null;
  let concurrentRunTwo = null;
  try {
    [concurrentRunOne, concurrentRunTwo] = await Promise.all([
      launch(concurrentOneExe, concurrentUserOne, concurrentWorkspaceOne, concurrentMcpOne, concurrentAdminOne, concurrentEnv),
      launch(concurrentTwoExe, concurrentUserTwo, concurrentWorkspaceTwo, concurrentMcpTwo, concurrentAdminTwo, concurrentEnv),
    ]);
    await Promise.all([
      assertRunning(concurrentRunOne, fixture, concurrentUserOne, concurrentMcpOne, concurrentAdminOne, "portable concurrent one"),
      assertRunning(concurrentRunTwo, fixture, concurrentUserTwo, concurrentMcpTwo, concurrentAdminTwo, "portable concurrent two"),
    ]);
    const extracted = await findExtractedPayloads(concurrentTemp);
    ensure(extracted.length === 2, `portable concurrent extraction roots=${extracted.length}`);
    const extractedStats = await Promise.all(extracted.map(async (root) => ({
      root,
      tree: await payloadTreeStats(root),
      manifest: (await inspectPayload(root, "portable concurrent")).manifestStats,
      contains: await assertPayloadContains(unpacked, root, "portable concurrent"),
    })));
    for (const item of extractedStats) {
      ensure(item.manifest.file_count === unpackedInspection.manifestStats.file_count && item.manifest.total_bytes === unpackedInspection.manifestStats.total_bytes,
        `portable concurrent harness tree mismatch: ${JSON.stringify(item)}`);
    }
    pass("portable concurrent cold-start/reentry keeps two complete isolated trees", JSON.stringify({
      roots: extractedStats.map((item) => item.root),
      files: extractedStats[0].tree.files,
      bytes: extractedStats[0].tree.bytes,
      stale_ignored: true,
    }));
  } finally {
    if (concurrentRunOne) await killTree(concurrentRunOne.child);
    if (concurrentRunTwo) await killTree(concurrentRunTwo.child);
  }
  const portableTemp = path.join(runRoot, "portable temp");
  const portableAppData = path.join(runRoot, "portable appdata");
  const portableLocalAppData = path.join(runRoot, "portable localappdata");
  await fs.mkdir(portableTemp, { recursive: true });
  await fs.mkdir(portableAppData, { recursive: true });
  await fs.mkdir(portableLocalAppData, { recursive: true });
  const portableEnv = {
    TEMP: portableTemp,
    TMP: portableTemp,
    APPDATA: portableAppData,
    LOCALAPPDATA: portableLocalAppData,
  };
  let appRun = null;
  try {
    appRun = await launch(firstExe, userData, workspace, mcpPort, adminPort, portableEnv);
    const first = await assertRunning(appRun, fixture, userData, mcpPort, adminPort, "portable");
    const portableExtracted = await findExtractedPayloads(portableTemp);
    ensure(portableExtracted.length === 1, `portable extraction roots=${portableExtracted.length}`);
    const portableTree = await payloadTreeStats(portableExtracted[0]);
    const portableContains = await assertPayloadContains(unpacked, portableExtracted[0], "portable");
    const portableManifest = (await inspectPayload(portableExtracted[0], "portable")).manifestStats;
    ensure(portableManifest.file_count === unpackedInspection.manifestStats.file_count && portableManifest.total_bytes === unpackedInspection.manifestStats.total_bytes,
      `portable harness tree mismatch: ${JSON.stringify({ portableManifest, expected: unpackedInspection.manifestStats })}`);
    pass("portable extracted runtime tree is complete", JSON.stringify({ root: portableExtracted[0], ...portableTree, ...portableContains }));
    pass("portable isolated MCP/Admin/install/load lifecycle", `tools=${first.mcpHealth.runtime.tool_count}`);
    const manifestFile = path.join(userData, "runtime", "profiles", ".seed-manifest.json");
    const manifestBefore = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    ensure(manifestBefore.harness_version === "1.0.0", "initial seed manifest version mismatch");
    await killTree(appRun.child);
    appRun = null;
    const second = await launch(firstExe, userData, workspace, mcpPort, adminPort, portableEnv);
    appRun = second;
    await assertRunning(appRun, fixture, userData, mcpPort, adminPort, "portable restart");
    pass("portable restart preserves installed Skill and health");
    await killTree(appRun.child);
    appRun = null;

    const thirdExe = path.join(runRoot, "third copy with spaces.exe");
    await fs.copyFile(portableExe, thirdExe);
    appRun = await launch(thirdExe, userData, workspace, mcpPort, adminPort, portableEnv);
    await assertRunning(appRun, fixture, userData, mcpPort, adminPort, "third copy");
    pass("third portable copy reuses isolated userData");
    await killTree(appRun.child);
    appRun = null;

    const secondBuildRoot = path.join(runRoot, "second build with spaces");
    await fs.cp(unpacked, secondBuildRoot, { recursive: true });
    const secondManifest = path.join(secondBuildRoot, "resources", "harness", "harness-version.json");
    const nextManifest = JSON.parse(await fs.readFile(secondManifest, "utf8"));
    // Keep the replacement at the same byte length so the immutable payload
    // manifest remains valid while exercising versioned runtime seeding.
    nextManifest.harness_version = "1.0.1";
    await fs.writeFile(secondManifest, JSON.stringify(nextManifest, null, 2), "utf8");
    const secondExe = path.join(secondBuildRoot, "ChatGPT Web Harness.exe");
    appRun = await launch(secondExe, userData, workspace, mcpPort, adminPort);
    await assertRunning(appRun, fixture, userData, mcpPort, adminPort, "second build");
    const manifestAfter = JSON.parse(await fs.readFile(manifestFile, "utf8"));
    ensure(manifestAfter.harness_version === "1.0.1", "seed manifest did not update for second harness version");
    pass("versioned restart updates seed manifest without losing Skill");
  } finally {
    if (appRun) await killTree(appRun.child);
  }
  const artifactSummary = {};
  for (const file of [portableExe, setupExe, zipFile]) {
    const stat = await fs.stat(file);
    artifactSummary[path.basename(file)] = { bytes: stat.size, sha256: await sha256(file) };
  }
  pass("artifact SHA-256 manifest", JSON.stringify(artifactSummary));
  const failed = checks.filter((item) => !item.ok);
  console.log(`\\n${checks.length - failed.length}/${checks.length} acceptance checks passed`);
  if (failed.length) throw new Error(failed.map((item) => `${item.name}: ${item.detail}`).join("; "));
}

try {
  await main();
} finally {
  if (process.env.KEEP_ACCEPTANCE_TMP === "1" || process.argv.includes("--keep")) {
    console.log(`acceptance temp retained for diagnosis: ${runRoot}`);
  } else {
    await fs.rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }
}
