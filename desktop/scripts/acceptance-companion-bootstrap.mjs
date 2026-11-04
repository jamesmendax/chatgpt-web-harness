import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const require = createRequire(import.meta.url);
const bootstrap = require(path.join(desktopRoot, "src", "companion-bootstrap.js"));

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-companion-bootstrap-"));
try {
  for (const port of [3301, 41001, 65535]) {
    assert.equal(
      bootstrap.normalizeLoopbackBaseUrl(`http://127.0.0.1:${port}/companion/v1`),
      `http://127.0.0.1:${port}/companion/v1`
    );
  }
  assert.throws(() => bootstrap.normalizeLoopbackBaseUrl("http://127.0.0.1/companion/v1"), /explicit valid port/);
  assert.throws(() => bootstrap.normalizeLoopbackBaseUrl("http://example.com:3301/companion/v1"), /127\.0\.0\.1/);
  assert.throws(() => bootstrap.normalizeLoopbackBaseUrl("https://127.0.0.1:3301/companion/v1"), /127\.0\.0\.1/);
  assert.throws(() => bootstrap.normalizeLoopbackBaseUrl("http://127.0.0.1:3301/other"), /companion\/v1/);

  const token = "acceptance-token-never-log-this";
  const first = bootstrap.writeRuntimeBootstrap(temp, {
    baseUrl: "http://127.0.0.1:3301/companion/v1",
    token,
    instanceId: "cpi_acceptance_first",
    expiresAt: "2026-09-15T00:00:00.000Z",
    accountId: "acceptance",
    appVersion: "0.2.8-rc.3",
  });
  const parsed = JSON.parse(await fs.readFile(first.file, "utf8"));
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.base_url, "http://127.0.0.1:3301/companion/v1");
  assert.equal(parsed.token, token);
  assert.equal(parsed.instance_id, "cpi_acceptance_first");
  assert.equal(parsed.expires_at, "2026-09-15T00:00:00.000Z");

  const second = bootstrap.writeRuntimeBootstrap(temp, {
    baseUrl: "http://127.0.0.1:45123/companion/v1",
    token: "rotated-session-token",
    instanceId: "cpi_acceptance_rotated",
    expiresAt: "2026-09-15T04:00:00.000Z",
    accountId: "acceptance",
    appVersion: "0.2.8-rc.3",
  });
  const rotated = JSON.parse(await fs.readFile(second.file, "utf8"));
  assert.equal(rotated.base_url, "http://127.0.0.1:45123/companion/v1", "dynamic Admin port must replace the prior endpoint");
  assert.equal(rotated.token, "rotated-session-token", "bootstrap token must rotate without user editing extension storage");
  assert.equal(rotated.instance_id, "cpi_acceptance_rotated", "bootstrap must bind the token to one Desktop capability instance");

  const serviceWorker = await fs.readFile(path.join(repoRoot, "browser-companion", "service-worker.js"), "utf8");
  const popup = await fs.readFile(path.join(repoRoot, "browser-companion", "popup.js"), "utf8");
  const content = await fs.readFile(path.join(repoRoot, "browser-companion", "content.js"), "utf8");
  const pathsSource = await fs.readFile(path.join(desktopRoot, "src", "paths.js"), "utf8");
  const mainSource = await fs.readFile(path.join(desktopRoot, "src", "main.js"), "utf8");
  const companionRuntime = await fs.readFile(path.join(desktopRoot, "src", "companion-runtime.js"), "utf8");
  const relayManager = await fs.readFile(path.join(repoRoot, "src", "lib", "relay-manager.ts"), "utf8");
  const relayControl = await fs.readFile(path.join(repoRoot, "src", "lib", "relay-control.ts"), "utf8");
  const goalTool = await fs.readFile(path.join(repoRoot, "src", "tools", "goal.ts"), "utf8");

  assert.equal(serviceWorker.includes("127.0.0.1:3001"), false, "service worker must never guess port 3001");
  assert.equal(popup.includes("127.0.0.1:3001"), false, "popup must never guess port 3001");
  assert.ok(serviceWorker.includes('chrome.runtime.getURL("runtime-bootstrap.json")'), "service worker must consume Desktop-managed runtime bootstrap");
  assert.ok(serviceWorker.includes("COMPANION_UNPAIRED"), "missing bootstrap must fail closed instead of guessing a port");
  assert.ok(pathsSource.includes('accountPath(path.join("browser-companion", "current"))'), "packaged Companion path must be stable across Portable cgh-* extraction");
  assert.ok(pathsSource.includes("materializeBrowserCompanion"), "Desktop must materialize packaged Companion into the stable path");
  assert.ok(mainSource.includes("prepareCompanionRuntime"), "Desktop must refresh Companion bootstrap from the actual runtime config");
  assert.ok(mainSource.includes('powerMonitor.on("resume"'), "Desktop must refresh expiring Companion capability immediately after system resume");
  assert.ok(mainSource.includes('powerMonitor.on("unlock-screen"'), "Desktop must refresh expiring Companion capability immediately after screen unlock");
  assert.ok(companionRuntime.includes("config.adminPort"), "Desktop bootstrap must derive the actual dynamic Admin port");
  assert.ok(serviceWorker.includes('headers.set("x-companion-instance"'), "Companion requests must carry the Desktop instance binding");

  for (const [name, source] of [["relay-manager", relayManager], ["relay-control", relayControl], ["goal", goalTool]]) {
    assert.equal(/computer\s+use/i.test(source), false, `${name} production control path must not depend on Computer Use`);
    assert.equal(/activeTab/.test(source), false, `${name} production control path must not depend on activeTab user gestures`);
  }
  assert.equal(/activeTab/.test(serviceWorker), false, "MV3 lifecycle service worker must not depend on activeTab");
  assert.equal(/activeTab/.test(content), false, "content control plane must not depend on activeTab");

  bootstrap.removeRuntimeBootstrap(temp);
  await assert.rejects(() => fs.readFile(path.join(temp, bootstrap.BOOTSTRAP_FILE), "utf8"), { code: "ENOENT" });

  console.log("Companion bootstrap acceptance: dynamic loopback endpoint, stable packaged path, resume/unlock credential refresh, no 3001 fallback, and zero Computer Use/activeTab dependency in the Relay control path passed");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
