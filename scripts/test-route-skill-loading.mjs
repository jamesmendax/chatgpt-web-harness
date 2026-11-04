import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "wh-route-skills-"));
const originalConfig = process.env.CHATGPT_PLUGINS_CONFIG;
const originalCodexHome = process.env.CODEX_HOME;
try {
  const profile = path.join(fixture, "profiles");
  const workspace = path.join(fixture, "workspace");
  const id = "ui-ux-pro-max";
  const skillDir = path.join(profile, "local-skills", id);
  const registryPath = path.join(profile, "plugins.json");
  fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const content = [
    "---", "name: ui-ux-pro-max",
    "description: UI/UX design intelligence for refining interfaces, web UI, components, alignment, spacing and typography.",
    "---", "# Local synthetic UI fixture",
    "Before editing, inspect the original Aura styles and rendered controls.",
    "Read references/checklist.md for verification requirements.", "",
  ].join("\n");
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
  fs.writeFileSync(path.join(skillDir, "references", "checklist.md"), "# Real pixel alignment verification\n");
  const registry = {
    schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: false },
    skills: [{ id, source: "installed", enabled: true }],
  };
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  process.env.CHATGPT_PLUGINS_CONFIG = registryPath;
  process.env.CODEX_HOME = path.join(fixture, "codex");
  const { registerContextTools } = await import("../dist/tools/context.js");
  const definitions = new Map();
  registerContextTools({ registerTool(name, config, handler) {
    definitions.set(name, { config, handler });
    return { remove() {}, update() {}, enable() {}, disable() {} };
  } }, workspace);
  assert.equal(typeof definitions.get("route_skills")?.handler, "function");
  const handler = definitions.get("route_skills").handler;
  const args = { task: "请修整设置页 UI 控件、字号和输入对齐", phase: "design",
    max_results: 3, max_content_bytes: 14000 };
  const first = await handler(args);
  const data = first.structuredContent?.data;
  assert.equal(data.status, "matched");
  assert.equal(data.primary.id, id);
  assert.equal(data.loaded_primary.id, id);
  assert.equal(data.loaded_primary.content_complete, true);
  assert.ok(data.loaded_primary.content.includes("Before editing, inspect the original Aura styles"));
  assert.equal(data.loaded_primary.content_sha256, data.primary.content_sha256);
  assert.ok(data.loaded_primary.reference_paths.some(p => p.endsWith("checklist.md")));
  assert.equal(data.loaded_primary.reference_count, 1);
  assert.equal(data.primary.invocation_mode, "implicit");
  assert.equal(data.supporting.length, 0, "no need to force unrelated skills");
  const suppression = (await handler({ ...args, task: "请不要使用任何 Skill，只回答问题" }))
    .structuredContent.data;
  assert.equal(suppression.status, "suppressed");
  assert.equal(suppression.loaded_primary, null);
  registry.skills[0].enabled = false;
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  const disabled = (await handler(args)).structuredContent.data;
  assert.notEqual(disabled.primary?.id, id, "disabled installed Skill must never load implicitly");
  assert.notEqual(disabled.loaded_primary?.id, id, "disabled installed Skill must not be read");
  assert.ok(!disabled.supporting.some((row) => row.id === id));
  assert.ok(["matched", "no_match"].includes(disabled.status), "a different enabled builtin is a valid fallback");
  console.log("route_skills integrated: current registry, exact-hash primary body, reference paths, disabled and explicit-no-Skill PASS");
} finally {
  if (originalConfig === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
  else process.env.CHATGPT_PLUGINS_CONFIG = originalConfig;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  fs.rmSync(fixture, { recursive: true, force: true });
}
