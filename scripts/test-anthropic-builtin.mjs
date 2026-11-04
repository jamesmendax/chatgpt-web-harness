import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// No installed user Skills, account config, network or model calls participate.
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codeRoot = process.env.HARNESS_TEST_RUNTIME_ROOT ? path.resolve(process.env.HARNESS_TEST_RUNTIME_ROOT) : source;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-anthropic-builtin-"));
process.env.CHATGPT_PLUGINS_CONFIG = path.join(temp, "profiles", "plugins.json");
process.env.CODEX_HOME = path.join(temp, "codex");
await fs.mkdir(path.dirname(process.env.CHATGPT_PLUGINS_CONFIG), { recursive: true });
await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG, JSON.stringify({ schema_version: 2, skills: [] }));
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace);
const expected = ["academy-guide", "algorithmic-art", "brand-guidelines", "canvas-design", "claude-api", "discernment-nudge", "frontend-design", "internal-comms", "mcp-builder", "skill-creator", "slack-gif-creator", "theme-factory", "web-artifacts-builder", "webapp-testing"];
try {
  const { resolveAllSkills, loadProjectSkill } = await import(pathToFileURL(path.join(codeRoot, "dist/lib/skills-loader.js")).href);
  const catalog = await resolveAllSkills(workspace);
  const skill = catalog.find(x => x.id === "anthropic-official-skills" && !x.shadowedBy);
  assert.ok(skill, "official collection must be discovered without user installation");
  assert.equal(skill.source, "builtin");
  assert.equal(skill.enabled, true);
  assert.ok(!skill.error, String(skill.error));
  assert.match(skill.content_sha256, /^[0-9a-f]{64}$/);
  const loaded = await loadProjectSkill(workspace, skill.id, 200000, { mode: "implicit", expected_content_sha256: skill.content_sha256 });
  assert.equal(loaded.content_complete, true);
  assert.match(loaded.content, /github\.com\/anthropics\/skills/);
  const root = path.join(codeRoot, "skills", "anthropic-official-skills");
  const refs = path.join(root, "references", "skills");
  const actual = (await fs.readdir(refs, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort();
  assert.deepEqual(actual, [...expected].sort());
  for (const id of expected) {
    const body = await fs.readFile(path.join(refs, id, "ANTHROPIC-SKILL.md"), "utf8");
    assert.ok(body.length > 50, `${id}: missing instruction body`);
    const license = await fs.readFile(path.join(refs, id, "LICENSE.txt"), "utf8");
    assert.match(license, /Apache License/);
  }
  for (const id of ["docx", "pdf", "pptx", "xlsx"]) assert.ok(!actual.includes(id), "restricted document package must not be silently redistributed");
  await fs.access(path.join(root, "THIRD_PARTY_NOTICES.md"));
  await fs.access(path.join(root, "references", "skills-index.md"));
  console.log(JSON.stringify({ passed: true, codeRoot, id: skill.id, source: skill.source, enabled: skill.enabled,
    content_complete: loaded.content_complete, bundled_subskills: expected.length, licenses_present: expected.length,
    real_model_evaluation: false }, null, 2));
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
