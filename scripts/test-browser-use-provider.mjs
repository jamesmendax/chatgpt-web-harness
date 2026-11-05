import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.HARNESS_TEST_RUNTIME_ROOT
  ? path.resolve(process.env.HARNESS_TEST_RUNTIME_ROOT)
  : sourceRoot;
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT)
  : path.join(sourceRoot, "dist");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-browser-use-"));
const dataDir = path.join(tmp, "account-browser-use");
const auditLog = path.join(tmp, "browser-use.audit.jsonl");
const runtimeLock = path.join(runtimeRoot, "bundled-plugins", "browser-use", "runtime-lock.json");
const secretMarker = `browser-secret-${Date.now()}`;

// A materialized cache is intentionally outside the vendor tree. Its lock
// remains anchored to the provider code, never to an arbitrary supplied path.
async function testCachedRuntimeProvisioning() {
  const { browserUseProvisioning } = await import(pathToFileURL(path.join(distRoot, "lib", "browser-use-provider.js")).href);
  const bundledLock = path.resolve(distRoot, "..", "bundled-plugins", "browser-use", "runtime-lock.json");
  const lockBytes = await fs.readFile(bundledLock);
  const lock = JSON.parse(lockBytes);
  const cached = path.join(tmp, "materialized", "digest");
  const critical = {};
  for (const name of ["python/python.exe", "chrome/chrome-win64/chrome.exe"]) {
    const bytes = Buffer.from("status-only fixture; never execute");
    await fs.mkdir(path.dirname(path.join(cached, name)), { recursive: true });
    await fs.writeFile(path.join(cached, name), bytes);
    critical[name] = crypto.createHash("sha256").update(bytes).digest("hex");
  }
  await fs.mkdir(path.join(cached, "site-packages"), { recursive: true });
  await fs.writeFile(path.join(cached, "provenance.json"), JSON.stringify({ ...lock, telemetry_default: "disabled", critical_files: critical }));
  const fixtureEnv = {
    HARNESS_BROWSER_USE_RUNTIME_ROOT: cached,
    HARNESS_BROWSER_USE_RUNTIME_LOCK: bundledLock,
    HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256: crypto.createHash("sha256").update(lockBytes).digest("hex"),
    HARNESS_BROWSER_USE_DATA_DIR: path.join(tmp, "fixture-data"),
  };
  const saved = Object.fromEntries(Object.keys(fixtureEnv).map(name => [name, process.env[name]]));
  try {
    Object.assign(process.env, fixtureEnv);
    assert.equal(browserUseProvisioning().dataRoot, fixtureEnv.HARNESS_BROWSER_USE_DATA_DIR);
    process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = "0".repeat(64);
    assert.throws(() => browserUseProvisioning(), /runtime lock integrity/);
    process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = fixtureEnv.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256;
    const outside = path.join(tmp, "copied-runtime-lock.json");
    await fs.writeFile(outside, lockBytes);
    process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = outside;
    assert.throws(() => browserUseProvisioning(), /outside the packaged layout/);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  console.log("browser-use-provider: cached runtime accepts code-bundled lock; copied lock and wrong hash rejected PASS");
}

try { await testCachedRuntimeProvisioning(); }
catch (error) { await fs.rm(tmp, { recursive: true, force: true }); throw error; }
if (process.env.HARNESS_TEST_PROVISIONING_ONLY === "1") {
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(0);
}

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(`<!doctype html><html><head><title>Harness Browser Smoke</title></head>
    <body><input id="field"><button id="commit" onclick="document.querySelector('#out').textContent=document.querySelector('#field').value">Commit</button><output id="out"></output></body></html>`);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/`;

const envNames = [
  "HARNESS_BROWSER_USE_RUNTIME_ROOT", "HARNESS_BROWSER_USE_RUNTIME_LOCK", "HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256",
  "HARNESS_BROWSER_USE_DATA_DIR",
  "HARNESS_BROWSER_USE_AUDIT_LOG", "HARNESS_BROWSER_USE_HEADLESS",
];
const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT = path.join(runtimeRoot, "vendor", "browser-use");
process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = runtimeLock;
process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = crypto.createHash("sha256").update(await fs.readFile(runtimeLock)).digest("hex");
process.env.HARNESS_BROWSER_USE_DATA_DIR = dataDir;
process.env.HARNESS_BROWSER_USE_AUDIT_LOG = auditLog;
process.env.HARNESS_BROWSER_USE_HEADLESS = "true";

function textContent(result) {
  return (result.content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForExit(pid, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return !processAlive(pid);
}

let provider;
let chromePid;
let mcpPid;
let daemonPid;
try {
  const providerModule = pathToFileURL(path.join(distRoot, "lib", "browser-use-provider.js")).href;
  const { BrowserUseProvider } = await import(providerModule);
  provider = new BrowserUseProvider();
  const cold = await provider.status();
  assert.equal(cold.connected, false);
  assert.equal(cold.browser_use_version, "0.13.10");
  assert.equal(cold.browser_harness_version, "0.1.13");
  assert.equal(cold.telemetry, "disabled");
  const lockHash = process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256;
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = "0".repeat(64);
  await assert.rejects(() => provider.status(), /runtime lock integrity/);
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = lockHash;
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = path.join(tmp, "untrusted-runtime-lock.json");
  await fs.copyFile(runtimeLock, process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK);
  await assert.rejects(() => provider.status(), /outside the packaged layout/);
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = runtimeLock;

  console.log("browser-use-provider: browser_exec start");
  const execResult = await provider.call("browser_exec", {
    code: [
      `new_tab(${JSON.stringify(url)})`,
      "wait_for_load()",
      `js(${JSON.stringify(`document.querySelector('#field').value=${JSON.stringify(secretMarker)};document.querySelector('#commit').click()`)})`,
      "print(js(\"document.title + '|' + document.querySelector('#out').textContent\"))",
    ].join("\n"),
  });
  assert.notEqual(execResult.isError, true, textContent(execResult));
  const output = textContent(execResult);
  assert.doesNotMatch(output, /Traceback|Error:/i, output);
  assert.match(output, /Harness Browser Smoke/);
  assert.match(output, new RegExp(secretMarker));

  console.log("browser-use-provider: browser_exec complete; browser_screenshot start");
  const screenshot = await provider.call("browser_screenshot", { full: false, max_dim: 1200 });
  console.log("browser-use-provider: browser_screenshot complete");
  assert.notEqual(screenshot.isError, true, textContent(screenshot));
  const image = (screenshot.content ?? []).find((item) => item.type === "image");
  assert.ok(image?.data && Buffer.from(image.data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  const hot = await provider.status();
  assert.equal(hot.connected, true);
  chromePid = hot.owned_chrome_pid;
  mcpPid = hot.owned_mcp_pid;
  assert.equal(processAlive(chromePid), true);
  assert.equal(processAlive(mcpPid), true);
  try {
    const record = JSON.parse(await fs.readFile(path.join(dataDir, "runtime", "bu.pid"), "utf8"));
    daemonPid = Number(record.pid);
    assert.equal(processAlive(daemonPid), true);
  } catch {
    // A clean daemon may remove its ownership record between the last tool
    // response and this diagnostic read. The provider roots remain mandatory.
  }

  await provider.close();
  provider = undefined;
  assert.equal(await waitForExit(chromePid), true, "owned Chrome survived provider close");
  assert.equal(await waitForExit(mcpPid), true, "owned Browser Use MCP survived provider close");
  if (daemonPid) assert.equal(await waitForExit(daemonPid), true, "owned Browser Harness daemon survived provider close");

  const audit = await fs.readFile(auditLog, "utf8");
  assert.doesNotMatch(audit, new RegExp(secretMarker), "Browser audit leaked executed code");
  assert.match(audit, /"redacted":true/);
  assert.match(audit, /"browser_use_screenshot"/);
  console.log("browser-use-provider: pinned runtime, local navigation, stateful exec, screenshot, redacted audit, and exact owned-process teardown PASS");
} catch (error) {
  // Keep this fixture's startup diagnostics in the test log before its private
  // profile is removed. Diagnostic errors must not replace the original error.
  try {
    const names = (await fs.readdir(dataDir)).filter(name => /^chrome-startup-[a-f0-9-]+\.json$/i.test(name));
    for (const name of names) {
      try { console.error("browser-use-provider startup diagnostic " + name + "\n" + await fs.readFile(path.join(dataDir, name), "utf8")); }
      catch (diagnosticError) { console.error("browser-use-provider startup diagnostic read failed: " + String(diagnosticError)); }
    }
  } catch (diagnosticError) {
    if (diagnosticError?.code !== "ENOENT") console.error("browser-use-provider startup diagnostic listing failed: " + String(diagnosticError));
  }
  throw error;
} finally {
  if (provider) await provider.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
}
