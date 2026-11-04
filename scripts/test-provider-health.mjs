import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-provider-health-"));
const codeRoot = path.join(tmp, "fixture-code");
const config = path.join(tmp, "plugins.json");
const capability = path.join(tmp, "computer-capability.json");
const helper = path.join(codeRoot, "bundled-plugins", "computer-use", "windows-action.ps1");
const runtime = path.join(codeRoot, "vendor", "browser-use");
const lock = path.join(codeRoot, "bundled-plugins", "browser-use", "runtime-lock.json");
const names = [
  "CHATGPT_PLUGINS_CONFIG", "HARNESS_ACCOUNT_ID",
  "HARNESS_COMPUTER_USE_HELPER", "HARNESS_COMPUTER_USE_HELPER_SHA256",
  "HARNESS_COMPUTER_USE_CAPABILITY_FILE", "HARNESS_COMPUTER_USE_TOKEN",
  "HARNESS_COMPUTER_USE_INSTANCE_ID", "HARNESS_COMPUTER_USE_EXPIRES_AT",
  "HARNESS_BROWSER_USE_RUNTIME_ROOT", "HARNESS_BROWSER_USE_RUNTIME_LOCK",
  "HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256", "HARNESS_BROWSER_USE_DATA_DIR",
];
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

try {
  // Health metadata fixtures only: none of these fake executables are launched.
  for (const [relative, text] of Object.entries({
    "bundled-plugins/computer-use/manifest.json": '{"version":"fixture","provider":"fixture","protocol_version":1}',
    "bundled-plugins/browser-use/manifest.json": '{"version":"fixture","provider":"fixture","protocol_version":1}',
    "bundled-plugins/computer-use/windows-action.ps1": "fixture helper bytes",
    "bundled-plugins/browser-use/runtime-lock.json": "{}",
    "vendor/browser-use/python/python.exe": "fixture executable metadata only",
    "vendor/browser-use/chrome/chrome-win64/chrome.exe": "fixture executable metadata only",
    "vendor/browser-use/provenance.json": "{}",
    "vendor/browser-use/SBOM.spdx.json": "{}",
  })) {
    const file = path.join(codeRoot, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  process.env.CHATGPT_PLUGINS_CONFIG = config;
  await fs.writeFile(config, JSON.stringify({ schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: false }, skills: [] }));
  const { getProviderHealth } = await import("../dist/lib/provider-health.js");
  const disabled = getProviderHealth(codeRoot);
  assert.equal(disabled.computer_use.status, process.platform === "win32" ? "disabled" : "unsupported");
  assert.equal(disabled.browser_use.status, process.platform === "win32" ? "disabled" : "unsupported");
  const missing = getProviderHealth(path.join(tmp, "missing-code"));
  assert.equal(missing.browser_use.available, false);
  assert.equal(missing.browser_use.enabled, false);
  assert.equal(missing.browser_use.status, process.platform === "win32" ? "missing" : "unsupported");
  // A source checkout can honestly lack the vendor runtime while remaining disabled.
  const sourceOnly = getProviderHealth();
  assert.equal(sourceOnly.browser_use.enabled, false);
  assert.equal(sourceOnly.browser_use.ready, false);
  // The packaged deferred runtime is one intact archive, prepared only on first use: disabled, not missing.
  const archiveOnly = path.join(tmp, "archive-code");
  for (const [relative, text] of Object.entries({
    "bundled-plugins/browser-use/manifest.json": '{"version":"fixture","provider":"fixture","protocol_version":1}',
    "bundled-plugins/browser-use/runtime-lock.json": "{}",
    "vendor/browser-use.runtime.zip": "fixture archive bytes",
  })) {
    const file = path.join(archiveOnly, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const archiveMeta = { schema_version: 1, archive: "browser-use.runtime.zip", sha256: "a".repeat(64), bytes: Buffer.byteLength("fixture archive bytes") };
  await fs.writeFile(path.join(archiveOnly, "vendor", "browser-use.archive.json"), JSON.stringify(archiveMeta));
  const packaged = getProviderHealth(archiveOnly);
  assert.equal(packaged.browser_use.available, process.platform === "win32");
  assert.equal(packaged.browser_use.status, process.platform === "win32" ? "disabled" : "unsupported");
  await fs.writeFile(path.join(archiveOnly, "vendor", "browser-use.archive.json"), JSON.stringify({ ...archiveMeta, bytes: archiveMeta.bytes + 1 }));
  assert.equal(getProviderHealth(archiveOnly).browser_use.status, process.platform === "win32" ? "missing" : "unsupported", "a truncated archive is missing");

  await fs.writeFile(config, JSON.stringify({ schema_version: 2, computer_use: { enabled: true }, browser_use: { enabled: true }, skills: [] }));
  Object.assign(process.env, {
    HARNESS_ACCOUNT_ID: "a".repeat(32),
    HARNESS_COMPUTER_USE_HELPER: helper,
    HARNESS_COMPUTER_USE_HELPER_SHA256: crypto.createHash("sha256").update(await fs.readFile(helper)).digest("hex"),
    HARNESS_COMPUTER_USE_CAPABILITY_FILE: capability,
    HARNESS_COMPUTER_USE_TOKEN: "fixture-token",
    HARNESS_COMPUTER_USE_INSTANCE_ID: "fixture-instance",
    HARNESS_COMPUTER_USE_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
    HARNESS_BROWSER_USE_RUNTIME_ROOT: runtime,
    HARNESS_BROWSER_USE_RUNTIME_LOCK: lock,
    HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256: crypto.createHash("sha256").update(await fs.readFile(lock)).digest("hex"),
    HARNESS_BROWSER_USE_DATA_DIR: path.join(tmp, "browser-data"),
  });
  await fs.writeFile(capability, JSON.stringify({ schema_version: 1, provider: "computer-use", account_id: process.env.HARNESS_ACCOUNT_ID,
    token: process.env.HARNESS_COMPUTER_USE_TOKEN, instance_id: process.env.HARNESS_COMPUTER_USE_INSTANCE_ID,
    helper_sha256: process.env.HARNESS_COMPUTER_USE_HELPER_SHA256, issued_at: new Date().toISOString(), expires_at: process.env.HARNESS_COMPUTER_USE_EXPIRES_AT }));
  const ready = getProviderHealth(codeRoot);
  if (process.platform === "win32") {
    assert.equal(ready.computer_use.status, "ready");
    assert.equal(ready.browser_use.status, "ready");
    assert.deepEqual(ready.computer_use.health_check, { tool: "computer_use", input: { action: "status" } });
  }
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = "0".repeat(64);
  assert.equal(getProviderHealth(codeRoot).browser_use.ready, false);
  assert.equal(getProviderHealth(codeRoot).browser_use.status, process.platform === "win32" ? "misconfigured" : "unsupported");
  // Deferred runtime health uses a completed, code-bound cache, without launching binaries.
  const archiveHash = "a".repeat(64);
  const archiveMetadata = JSON.stringify({ schema_version: 1, sha256: archiveHash });
  const cache = path.join(tmp, "cache", archiveHash.slice(0, 20));
  await fs.cp(runtime, cache, { recursive: true });
  for (const name of ["browser_use", "browser_harness"]) {
    await fs.mkdir(path.join(cache, "site-packages", name), { recursive: true });
    await fs.writeFile(path.join(cache, "site-packages", name, "__init__.py"), "# metadata fixture");
  }
  await fs.rm(runtime, { recursive: true });
  await fs.writeFile(path.join(codeRoot, "vendor", "browser-use.archive.json"), archiveMetadata);
  const marker = { sha256: archiveHash, metadataHash: crypto.createHash("sha256").update(archiveMetadata).digest("hex") };
  const markerPath = path.join(cache, ".runtime-complete.json");
  await fs.writeFile(markerPath, JSON.stringify(marker));
  process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT = cache;
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = crypto.createHash("sha256").update(await fs.readFile(lock)).digest("hex");
  assert.equal(getProviderHealth(codeRoot).browser_use.ready, process.platform === "win32");
  await fs.rm(markerPath);
  assert.equal(getProviderHealth(codeRoot).browser_use.available, false);
  for (const bad of [{ ...marker, sha256: "b".repeat(64) }, { ...marker, metadataHash: "0".repeat(64) }]) {
    await fs.writeFile(markerPath, JSON.stringify(bad));
    assert.equal(getProviderHealth(codeRoot).browser_use.available, false);
  }
  await fs.writeFile(markerPath, JSON.stringify(marker));
  const moved = path.join(tmp, "wrong-cache-name");
  await fs.rename(cache, moved);
  process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT = moved;
  assert.equal(getProviderHealth(codeRoot).browser_use.available, false);
  await fs.rename(moved, cache);
  process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT = cache;
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = "0".repeat(64);
  assert.equal(getProviderHealth(codeRoot).browser_use.ready, false);
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = crypto.createHash("sha256").update(await fs.readFile(lock)).digest("hex");
  const copiedLock = path.join(tmp, "copied-lock.json");
  await fs.copyFile(lock, copiedLock);
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = copiedLock;
  assert.equal(getProviderHealth(codeRoot).browser_use.ready, false);
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = lock;
  assert.equal(getProviderHealth(codeRoot).browser_use.ready, process.platform === "win32");
  console.log("provider-health: disabled/ready/integrity states and secret-free health contract PASS");
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
