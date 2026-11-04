import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.CHATGPT_TOOL_PROFILE = "slim";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const overridesPath = path.join(root, "profiles", "tool-overrides.json");
const previousOverrides = await fs.readFile(overridesPath, "utf-8").catch(() => null);
const previousPluginsConfig = process.env.CHATGPT_PLUGINS_CONFIG;
const pluginFixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-manifest-plugins-"));
const pluginFixturePath = path.join(pluginFixtureRoot, "plugins.json");

try {
  await fs.writeFile(pluginFixturePath, JSON.stringify({
    schema_version: 2,
    computer_use: { enabled: false },
    browser_use: { enabled: false },
    skills: [],
  }), "utf-8");
  process.env.CHATGPT_PLUGINS_CONFIG = pluginFixturePath;
  await fs.writeFile(overridesPath, "{}\n", "utf-8");
  const { getRuntimeManifest } = await import(`../dist/lib/runtime-manifest.js?test=${Date.now()}`);
  const manifest = getRuntimeManifest();
  assert.equal(manifest.tool_profile, "slim");
  assert.equal(manifest.tool_count, 34);
  assert.ok(manifest.tool_names.includes("recovery_submit"));
  assert.ok(manifest.tool_names.includes("recovery_status"));
  assert.ok(manifest.tool_names.includes("code_intelligence"));
  assert.ok(manifest.tool_names.includes("route_skills"));
  assert.ok(manifest.tool_names.includes("visual_review"));
  assert.ok(manifest.tool_names.includes("rewind"));
  assert.ok(!manifest.tool_names.includes("open_image"));
  assert.equal(manifest.stale_build, false);
  assert.match(manifest.build_id, /^[a-f0-9]{16}$/);
  assert.match(manifest.tool_manifest_hash, /^[a-f0-9]{64}$/);
  console.log(`runtime-manifest: build=${manifest.build_id} tools=${manifest.tool_count} hash=${manifest.tool_manifest_hash.slice(0, 12)} OK`);
} finally {
  if (previousOverrides === null) await fs.rm(overridesPath, { force: true });
  else await fs.writeFile(overridesPath, previousOverrides, "utf-8");
  if (previousPluginsConfig === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
  else process.env.CHATGPT_PLUGINS_CONFIG = previousPluginsConfig;
  await fs.rm(pluginFixtureRoot, { recursive: true, force: true });
}
