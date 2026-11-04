import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const releaseRoot = process.env.HARNESS_RELEASE_ROOT
  ? path.resolve(process.env.HARNESS_RELEASE_ROOT)
  : path.join(desktopRoot, "release");
const desktopPackage = JSON.parse(fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const version = desktopPackage.version;

const portable = path.join(releaseRoot, `ChatGPT Web Harness Isolated-${version}-portable.exe`);
const setup = path.join(releaseRoot, `ChatGPT Web Harness Isolated-${version}-setup.exe`);
const unpacked = path.join(releaseRoot, "win-unpacked");
const packagedHarness = path.join(unpacked, "resources", "harness");
const packagedDist = path.join(packagedHarness, "dist");
const packagedCompanion = path.join(unpacked, "resources", "browser-companion");

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertPe(file) {
  assert.ok(fs.existsSync(file), `missing release executable: ${file}`);
  const stat = fs.statSync(file);
  assert.ok(stat.size > 10 * 1024 * 1024, `release executable is unexpectedly small: ${file}`);
  const head = fs.readFileSync(file).subarray(0, 2).toString("ascii");
  assert.equal(head, "MZ", `release executable is not a PE image: ${file}`);
  return { path: file, bytes: stat.size, sha256: sha256(file) };
}

function runFixture(scriptName, extraEnv) {
  const script = path.join(repoRoot, "scripts", scriptName);
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${scriptName} failed against packaged runtime (exit ${result.status})\n${result.stdout || ""}\n${result.stderr || ""}`
    );
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
}

const portableInfo = assertPe(portable);
const setupInfo = assertPe(setup);
assert.ok(fs.existsSync(path.join(packagedDist, "index.js")), "packaged harness dist/index.js is missing");
for (const rel of [
  "lib/relay-manager.js",
  "lib/driver-lease.js",
  "lib/handoff-store.js",
  "lib/execution-contract.js",
  "tools/goal.js",
  "admin/companion.js",
]) {
  assert.ok(fs.existsSync(path.join(packagedDist, ...rel.split("/"))), `packaged relay runtime is missing ${rel}`);
}

const harnessVersion = JSON.parse(fs.readFileSync(path.join(packagedHarness, "harness-version.json"), "utf8"));
assert.equal(harnessVersion.harness_version, version, "desktop and packaged harness versions must match");
const rootPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
assert.equal(rootPackage.version, version, "root and desktop release versions must match");

const extensionManifestPath = path.join(packagedCompanion, "manifest.json");
assert.ok(fs.existsSync(extensionManifestPath), "Browser Companion was not packaged into resources/browser-companion");
const extensionManifest = JSON.parse(fs.readFileSync(extensionManifestPath, "utf8"));
assert.equal(extensionManifest.manifest_version, 3);
const expectedExtensionVersion = version.replace(/-rc\.(\d+)$/i, ".$1");
assert.equal(extensionManifest.version, expectedExtensionVersion);
assert.equal(extensionManifest.version_name, version, "packaged Companion version_name must match the desktop release");
assert.ok(!extensionManifest.permissions.includes("activeTab"), "packaged Relay Companion must not depend on activeTab user gestures");

const computerHelper = path.join(packagedHarness, "bundled-plugins", "computer-use", "windows-action.ps1");
const browserLock = path.join(packagedHarness, "bundled-plugins", "browser-use", "runtime-lock.json");
for (const file of [
  computerHelper,
  browserLock,
  path.join(packagedHarness, "vendor", "browser-use", "python", "python.exe"),
  path.join(packagedHarness, "vendor", "browser-use", "chrome", "chrome-win64", "chrome.exe"),
  path.join(packagedHarness, "vendor", "browser-use", "SBOM.spdx.json"),
  path.join(packagedHarness, "vendor", "browser-use", "licenses", "Browser-Use-LICENSE.txt"),
  path.join(packagedHarness, "vendor", "browser-use", "licenses", "Browser-Harness-LICENSE.txt"),
  path.join(packagedHarness, "vendor", "browser-use", "licenses", "Python-LICENSE.txt"),
  path.join(packagedHarness, "vendor", "browser-use", "licenses", "Chrome-for-Testing-NOTICE.txt"),
]) assert.ok(fs.existsSync(file) && fs.statSync(file).size > 0, `packaged provider runtime is missing ${file}`);
assert.equal(harnessVersion.providers?.computer_use?.helper_sha256, sha256(computerHelper));
assert.deepEqual(harnessVersion.providers?.computer_use?.health_check, { tool: "computer_use", input: { action: "status" } });
assert.equal(harnessVersion.providers?.browser_use?.runtime_lock_sha256, sha256(browserLock));
assert.deepEqual(harnessVersion.providers?.browser_use?.health_check, { tool: "browser_use_screenshot", input: { full: false, max_dim: 1200 } });
assert.equal(harnessVersion.providers?.browser_use?.telemetry_default, "disabled");

// Run the same bidirectional A -> B -> A safety fixture against the exact
// JavaScript staged inside win-unpacked, not the source-tree dist directory.
runFixture("test-relay-manager.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
});

// Exercise the packaged HTTP Companion API using a dedicated bearer and
// isolated temporary CODEX_HOME/workspace/ports.
runFixture("test-companion-api.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
  HARNESS_TEST_RUNTIME_ROOT: packagedHarness,
});

// Validate the exact extension bytes that ship beside the executable.
runFixture("test-browser-companion.mjs", {
  HARNESS_TEST_BROWSER_COMPANION_ROOT: packagedCompanion,
});

// Prove that both bundled providers execute from the exact packaged runtime,
// without resolving a host Codex plugin, global Python or user Chrome.
runFixture("test-packaged-runtime-fingerprint.mjs", {
  HARNESS_TEST_RUNTIME_ROOT: packagedHarness,
});
runFixture("test-node-repl-lifecycle.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
});
runFixture("test-computer-use-session-persistence.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
  HARNESS_TEST_RUNTIME_ROOT: packagedHarness,
});
runFixture("test-browser-use-session-lifecycle.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
  HARNESS_TEST_RUNTIME_ROOT: packagedHarness,
});
runFixture("test-computer-use-provider.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
  HARNESS_TEST_RUNTIME_ROOT: packagedHarness,
});
runFixture("test-browser-use-provider.mjs", {
  HARNESS_TEST_DIST_ROOT: packagedDist,
  HARNESS_TEST_RUNTIME_ROOT: packagedHarness,
});

const result = {
  version,
  portable: portableInfo,
  setup: setupInfo,
  harness_version: harnessVersion,
  browser_companion: {
    manifest_version: extensionManifest.manifest_version,
    version: extensionManifest.version,
    path: packagedCompanion,
  },
  packaged_relay_runtime: "passed",
  bidirectional_relay: "passed",
  companion_api: "passed",
  browser_companion_contract: "passed",
  bundled_computer_use: "passed",
  bundled_browser_use: "passed",
  bundled_computer_use_sessions: "passed",
  bundled_browser_use_sessions: "passed",
};

console.log(`PACKAGED_RELAY_ACCEPTANCE ${JSON.stringify(result, null, 2)}`);
