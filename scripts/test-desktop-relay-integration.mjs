import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "desktop");
const read = (relative) => fs.readFile(path.join(root, relative), "utf8");

for (const relative of [
  "desktop/src/config.js",
  "desktop/src/paths.js",
  "desktop/src/harness.js",
  "desktop/src/companion-capability.js",
  "desktop/src/companion-runtime.js",
  "desktop/src/isolated-runtime.js",
  "desktop/src/services.js",
  "desktop/src/main.js",
  "desktop/src/preload.js",
  "desktop/renderer/app.js",
]) {
  execFileSync(process.execPath, ["--check", path.join(root, relative)], { stdio: "pipe" });
}

const configSource = await read("desktop/src/config.js");
const harnessSource = await read("desktop/src/harness.js");
const isolatedSource = await read("desktop/src/isolated-runtime.js");
const mainSource = await read("desktop/src/main.js");
const preloadSource = await read("desktop/src/preload.js");
const rendererSource = await read("desktop/renderer/app.js");
const html = await read("desktop/renderer/index.html");
const builder = await read("desktop/electron-builder.yml");
const pathsSource = await read("desktop/src/paths.js");
const capabilitySource = await read("desktop/src/companion-capability.js");
const companionRuntimeSource = await read("desktop/src/companion-runtime.js");

assert.ok(configSource.includes("relayEnabled: false"));
assert.ok(configSource.includes("relayAutomationEnabled: false"));
assert.ok(configSource.includes("relayAutoRecoveryEnabled: false"));
assert.equal(configSource.includes("deriveCompanionToken"), false, "Companion bearer must no longer be derived from the long-lived Admin token");
assert.ok(capabilitySource.includes("crypto.randomBytes(32)"));
assert.ok(capabilitySource.includes("expires_at"));
assert.ok(harnessSource.includes('env.HARNESS_RELAY_ENABLED = "true"'));
assert.ok(harnessSource.includes('env.HARNESS_COMPANION_ENABLED = "true"'));
assert.ok(harnessSource.includes("env.HARNESS_RELAY_AUTO_RECOVERY_ENABLED = config.relayAutomationEnabled === true && config.relayAutoRecoveryEnabled === true"));
assert.ok(harnessSource.includes("env.HARNESS_COMPANION_TOKEN = companion.credential.token"));
assert.ok(harnessSource.includes("env.HARNESS_COMPANION_CAPABILITY_FILE = paths.companionCapabilityPath()"));
assert.ok(harnessSource.includes("delete env.HARNESS_COMPANION_TOKEN"), "Tunnel and disabled MCP paths must strip companion token");
assert.ok(isolatedSource.includes('"HARNESS_COMPANION_TOKEN"'));
assert.ok(isolatedSource.includes('"HARNESS_RELAY_ENABLED"'));
assert.ok(mainSource.includes('ipcMain.handle("relay:copyCompanionToken"'));
assert.ok(mainSource.includes("clipboard.writeText(token)"));
assert.ok(mainSource.includes("fingerprint"));
assert.equal(mainSource.includes("return { copied: true, token"), false, "renderer must never receive the companion bearer value");
assert.ok(preloadSource.includes("copyCompanionToken"));
assert.ok(preloadSource.includes("openCompanionFolder"));
assert.ok(rendererSource.includes('$("f-relay-enabled")'));
assert.ok(rendererSource.includes('$("f-relay-recovery")'));
assert.ok(rendererSource.includes("Companion Token 已复制"));
assert.ok(html.includes('id="f-relay-enabled"'), "Relay toggle must remain wired in the current UI");
assert.ok(html.includes('id="f-relay-recovery"'));
assert.ok(pathsSource.includes("browserCompanionDir"));
assert.ok(pathsSource.includes("companionCapabilityPath"));
assert.ok(companionRuntimeSource.includes("refreshIfExpiring"));
assert.ok(builder.includes('from: "../browser-companion"'));
assert.ok(builder.includes('to: "browser-companion"'));

const manifest = JSON.parse(await read("browser-companion/manifest.json"));
assert.equal(manifest.manifest_version, 3);
assert.ok(Array.isArray(manifest.host_permissions));
assert.ok(await fs.stat(path.join(desktop, "..", "browser-companion", "manifest.json")));

console.log("desktop-relay-integration: default-off config, random expiring companion capability, MCP-only env injection, secret non-export, UI wiring, and packaged extension resource passed");
