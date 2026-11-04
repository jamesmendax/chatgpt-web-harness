import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "wh-skill-resources-"));
const saved = { config: process.env.CHATGPT_PLUGINS_CONFIG, codex: process.env.CODEX_HOME, audit: process.env.AUDIT_LOG_PATH };
try {
  const workspace = path.join(fixture, "workspace");
  const profile = path.join(fixture, "profile");
  const dir = path.join(profile, "local-skills", "finance-sheet");
  const registry = path.join(profile, "plugins.json");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(path.join(dir, "references/a"), { recursive: true });
  await fs.mkdir(path.join(dir, "references/b"), { recursive: true });
  const body = "---\nname: finance-sheet\ndescription: Create financial Excel spreadsheets and 财务表格 with audited formulas.\n---\n" + "连续字节🙂中英 mixed instructions\n".repeat(40);
  await fs.writeFile(path.join(dir, "SKILL.md"), body);
  await fs.writeFile(path.join(dir, "references/a/check.md"), "A checklist 中文🙂\n".repeat(10));
  await fs.writeFile(path.join(dir, "references/b/check.md"), "B checklist\n");
  for (let i = 0; i < 24; i++) await fs.writeFile(path.join(dir, `references/note-${i}.md`), `note ${i}`);
  const config = { schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: false }, skills: [{ id: "finance-sheet", source: "installed", enabled: true }] };
  await fs.writeFile(registry, JSON.stringify(config));
  process.env.CHATGPT_PLUGINS_CONFIG = registry;
  process.env.CODEX_HOME = path.join(fixture, "codex");
  process.env.AUDIT_LOG_PATH = path.join(fixture, "audit.jsonl");
  const { loadProjectSkill, loadProjectSkills } = await import("../dist/lib/skills-loader.js");
  const { routeSkills } = await import("../dist/lib/skill-routing.js");
  const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
  const { registerContextTools } = await import("../dist/tools/context.js");
  const { selectSkillContent, readSelectedResource } = await import("../dist/lib/skill-selection.js");
  const scope = (session = "session-a", principalId = "account-a", goalId = "goal-a") => ({ ...createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace], principalId }, { sessionId: session }), goalId });
  const run = (fn, s = scope()) => runWithRuntimeScope(s, fn);
  const skills = await loadProjectSkills(workspace);
  for (const task of ["制作财务 Excel 表格", "Create financial Excel spreadsheets", "生成财务表格"]) {
    assert.equal(routeSkills(skills, { task }).primary?.id, "finance-sheet", task);
  }
  const first = await run(() => loadProjectSkill(workspace, "finance-sheet", 128, { mode: "implicit", phase: "implement" }));
  assert.equal(first.content_receipt.sha256, createHash("sha256").update(body).digest("hex"), "raw body bytes hash is separate from policy/version hash");
  assert.notEqual(first.content_sha256, first.content_receipt.sha256);
  assert.equal(first.content_receipt.coverage_complete, false);
  assert.ok(first.layout.references.includes("a/check.md"));
  assert.ok(first.layout.references.includes("b/check.md"));
  assert.equal(first.resource_catalog.total, 26);
  assert.equal(first.resource_catalog.next_offset, 20);
  const lastPage = await run(() => loadProjectSkill(workspace, "finance-sheet", 4, { mode: "implicit", selection_id: first.selection_id, offset_bytes: Buffer.byteLength(body), resource_offset: 20 }));
  assert.equal(lastPage.content_complete, true, "legacy field still means chunk at EOF");
  assert.equal(lastPage.content_receipt.coverage_complete, false, "jumping to EOF does not imply full body coverage");
  assert.equal(lastPage.resource_catalog.entries.length, 6);
  let page = first;
  let reconstructed = first.content;
  while (page.continuation) {
    page = await run(() => loadProjectSkill(workspace, "finance-sheet", 128, { ...page.continuation, mode: "implicit" }));
    reconstructed += page.content;
  }
  assert.equal(reconstructed, body);
  assert.equal(page.content_receipt.coverage_complete, true);
  assert.equal(page.content_receipt.kind, "server_content_constructed");
  const reference = await run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit", selection_id: first.selection_id, resource_path: "references/a/check.md" }));
  assert.ok(reference.resource_sha256);
  assert.equal(reference.content_receipt.coverage_complete, false);
  await fs.writeFile(path.join(dir, "references/a/check.md"), "changed reference, body unchanged");
  await assert.rejects(run(() => loadProjectSkill(workspace, "finance-sheet", 32, { ...reference.continuation, mode: "implicit" })), /RESOURCE_VERSION_CHANGED/);
  for (const resource_path of ["../outside.md", path.join(fixture, "outside.md"), "references\\a\\check.md", "references/missing.md"]) {
    await assert.rejects(run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit", selection_id: first.selection_id, resource_path })), /RESOURCE_/);
  }
  for (const other of [scope("session-b"), scope("session-a", "account-b"), scope("session-a", "account-a", "goal-b")]) {
    await assert.rejects(run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit", selection_id: first.selection_id }), other), /SELECTION_INVALID/);
  }
  const outside = path.join(fixture, "outside-dir");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "check.md"), "outside");
  // A mapped file replaced by a link must not turn selection scope into a general file read.
  await fs.unlink(path.join(dir, "references/b/check.md"));
  await fs.rmdir(path.join(dir, "references/b"));
  await fs.symlink(outside, path.join(dir, "references/b"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit", selection_id: first.selection_id, resource_path: "references/b/check.md" })), /OUTSIDE_ROOT/);
  const definitions = new Map();
  registerContextTools({ registerTool(name, _config, handler) { definitions.set(name, handler); return {}; } }, workspace);
  const artifact = path.join(workspace, "report.txt");
  await fs.writeFile(artifact, "verified artifact bytes");
  const hash = createHash("sha256").update(await fs.readFile(artifact)).digest("hex");
  const args = { name: "finance-sheet", invocation_mode: "implicit", selection_id: first.selection_id, max_bytes: 4, offset_bytes: 0 };
  const declared = await run(() => definitions.get("load_skill")({ ...args, evidence_action: "declare_application", statement: "Applied formula review guidance" }));
  assert.equal(declared.structuredContent.data.evidence.kind, "model_application_declared");
  assert.equal(declared.structuredContent.data.evidence.independently_verified, false);
  const verified = await run(() => definitions.get("load_skill")({ ...args, evidence_action: "verify_artifact", artifact_path: artifact, expected_artifact_sha256: hash }));
  assert.equal(verified.structuredContent.data.evidence.hash_matches, true);
  assert.equal(verified.structuredContent.data.evidence.workflow_quality_verified, false);
  const originalSkill = skills.find(item => item.id === "finance-sheet");
  const substitute = path.join(fixture, "same-content-other-package");
  await fs.mkdir(substitute);
  await fs.writeFile(path.join(substitute, "SKILL.md"), body);
  await assert.rejects(run(() => selectSkillContent(workspace, { ...originalSkill, dir: substitute, path: path.join(substitute, "SKILL.md") }, "implicit", first.selection_id)), /SELECTION_INVALID/);
  const moved = dir + "-moved";
  await fs.rename(dir, moved);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "SKILL.md"), body);
  try {
    await assert.rejects(run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit", selection_id: first.selection_id })), /SELECTION_INVALID/);
    const savedSelection = await run(() => selectSkillContent(workspace, { ...originalSkill, dir: moved, path: path.join(moved, "SKILL.md") }, "implicit"));
    await fs.rename(moved, moved + "-again");
    await fs.mkdir(moved);
    await assert.rejects(readSelectedResource(savedSelection, "references/a/check.md"), /ROOT_CHANGED/);
    await fs.rmdir(moved);
    await fs.rename(moved + "-again", moved);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(moved, dir);
  }
  config.computer_use.enabled = true;
  config.browser_use.enabled = true;
  await fs.writeFile(registry, JSON.stringify(config));
  for (const name of ["computer-use", "browser-use"]) {
    const provider = await run(() => loadProjectSkill(workspace, name, 128, { mode: "implicit" }));
    assert.ok(provider.reference_continuations.length > 0, "small body budget exposes required provider continuations");
    const next = provider.reference_continuations[0];
    assert.equal(next.tool, "load_skill");
    assert.equal(next.selection_id, provider.selection_id);
    assert.ok(next.resource_path.startsWith("@provider-docs/"));
    assert.match(next.expected_resource_sha256, /^[a-f0-9]{64}$/);
    assert.equal(next.offset_bytes, 0);
    const chunk = await run(() => loadProjectSkill(workspace, name, 32, { ...next, mode: "implicit" }));
    assert.equal(chunk.resource_sha256, next.expected_resource_sha256);
    assert.equal(chunk.content_receipt.resource_path, next.resource_path);
    assert.equal(chunk.continuation?.tool, "load_skill");
    assert.equal(chunk.continuation?.offset_bytes, chunk.end_bytes);
  }
  const { createDurableTask } = await import("../dist/lib/durable-tasks.js");
  const taskScope = scope("task-session", "account-a", undefined);
  delete taskScope.goalId;
  const task = await run(() => createDurableTask(workspace, { goal: "Synthetic Skill evidence task" }), taskScope);
  const taskRead = await run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit" }), taskScope);
  assert.equal(taskRead.content_receipt.task_id, task.id, "attach only a real existing session-visible task");
  config.skills[0].enabled = false;
  await fs.writeFile(registry, JSON.stringify(config));
  await assert.rejects(run(() => loadProjectSkill(workspace, "finance-sheet", 32, { mode: "implicit", selection_id: first.selection_id })), /disabled|not found|Unknown Skill/i);
  console.log("skill-resources: routing, nested names, >20 resources, UTF-8, skipped pages, content mutation, scope, policy, traversal and separate evidence PASS");
} finally {
  for (const [env, value] of [["CHATGPT_PLUGINS_CONFIG", saved.config], ["CODEX_HOME", saved.codex], ["AUDIT_LOG_PATH", saved.audit]]) {
    if (value === undefined) delete process.env[env]; else process.env[env] = value;
  }
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
