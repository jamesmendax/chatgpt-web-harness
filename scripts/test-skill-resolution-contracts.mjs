import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-skill-resolution-"));

async function skill(dir, id, body, frontmatterName = id) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${frontmatterName}\ndescription: ${id} fixture\n---\n${body}\n`, "utf8");
}

try {
  const { resolveSkills, selectSkill } = await import("../dist/lib/skill-resolver.js");

  const workspace = path.join(tmp, "priority-workspace");
  const installedDir = path.join(tmp, "priority-installed");
  const externalDir = path.join(tmp, "priority-external");
  const codeRoot = path.join(tmp, "priority-code");
  await skill(path.join(workspace, ".claude", "skills", "layered"), "layered", "# project layer", "project-layer");
  await skill(path.join(installedDir, "layered"), "layered", "# installed layer", "installed-layer");
  await skill(externalDir, "layered", "# external layer", "external-layer");
  await skill(path.join(codeRoot, "skills", "layered"), "layered", "# builtin layer", "builtin-layer");
  const externalPath = path.join(externalDir, "SKILL.md");
  const registry = {
    schema_version: 2,
    computer_use: { enabled: false },
    browser_use: { enabled: false },
    skills: [
      { id: "layered", source: "installed", enabled: true },
      { id: "layered", source: "external", path: externalPath, enabled: true },
    ],
  };
  const baseInput = { workspaceRoot: workspace, codeRoot, installedDir, registry, codexHome: path.join(tmp, "no-codex"), platform: "win32" };
  let resolved = await resolveSkills(baseInput);
  assert.equal(selectSkill(resolved, "layered").source, "project", "project must win over installed/external/builtin");
  assert.equal(resolved.find((item) => item.source === "installed" && item.id === "layered")?.shadowedBy, "project");
  assert.equal(resolved.find((item) => item.source === "external" && item.id === "layered")?.shadowedBy, "project");
  assert.equal(resolved.find((item) => item.source === "builtin" && item.id === "layered")?.shadowedBy, "project");

  // Exercise the real load_skill path across a live registry change: a
  // disabled installed row is unavailable, then becomes loadable immediately
  // after re-enable without restarting the process.
  const liveWorkspace = path.join(tmp, "live-workspace");
  const liveRegistryPath = path.join(tmp, "live", "plugins.json");
  const liveInstalledDir = path.join(tmp, "live", "local-skills");
  await skill(path.join(liveInstalledDir, "live-skill"), "live-skill", "# live content");
  await fs.mkdir(path.dirname(liveRegistryPath), { recursive: true });
  await fs.writeFile(liveRegistryPath, JSON.stringify({ schema_version: 2, computer_use: { enabled: false }, skills: [{ id: "live-skill", source: "installed", enabled: false }] }), "utf8");
  const previousLiveConfig = process.env.CHATGPT_PLUGINS_CONFIG;
  process.env.CHATGPT_PLUGINS_CONFIG = liveRegistryPath;
  try {
    const { loadProjectSkill } = await import("../dist/lib/skills-loader.js");
    await assert.rejects(() => loadProjectSkill(liveWorkspace, "live-skill"), /Unknown Skill/);
    await fs.writeFile(liveRegistryPath, JSON.stringify({ schema_version: 2, computer_use: { enabled: false }, skills: [{ id: "live-skill", source: "installed", enabled: true }] }), "utf8");
    const liveLoaded = await loadProjectSkill(liveWorkspace, "live-skill");
    assert.equal(liveLoaded.skill.id, "live-skill");
    assert.match(liveLoaded.content, /live content/);
  } finally {
    if (previousLiveConfig === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
    else process.env.CHATGPT_PLUGINS_CONFIG = previousLiveConfig;
  }

  await fs.rm(path.join(workspace, ".claude", "skills", "layered"), { recursive: true, force: true });
  resolved = await resolveSkills({ ...baseInput, registry: { ...registry, skills: registry.skills.map((row) => row.source === "installed" ? { ...row, enabled: false } : row) } });
  assert.equal(selectSkill(resolved, "layered").source, "external", "disabled installed must not suppress external");
  assert.equal(resolved.find((item) => item.source === "installed" && item.id === "layered")?.shadowedBy, undefined);
  resolved = await resolveSkills({ ...baseInput, registry: { ...registry, skills: registry.skills.map((row) => ({ ...row, enabled: false })) } });
  assert.equal(selectSkill(resolved, "layered").source, "builtin", "disabled layers must reveal builtin");

  const actualBuiltinWorkspace = path.join(tmp, "actual-builtin-workspace");
  const actualBuiltin = await resolveSkills({
    workspaceRoot: actualBuiltinWorkspace,
    codeRoot: root,
    installedDir: path.join(tmp, "actual-builtin-installed"),
    registry: { schema_version: 2, computer_use: { enabled: false }, skills: [] },
    codexHome: path.join(tmp, "no-computer-use"),
    platform: "win32",
  });
  const visual = selectSkill(actualBuiltin, "visual-qa");
  assert.equal(visual.source, "builtin");
  const builtinVisualPath = path.join(root, "skills", "visual-qa", "SKILL.md");
  assert.equal(path.resolve(visual.path), path.resolve(builtinVisualPath), "real builtin-name content must resolve to the builtin file");
  assert.match(await fs.readFile(visual.path, "utf8"), /# Visual review/, "load the current visual guidance");
  const switchWorkspace = path.join(tmp, "builtin-switch-workspace");
  const switchInstalled = path.join(tmp, "builtin-switch-installed");
  await skill(path.join(switchWorkspace, ".claude", "skills", "visual-qa"), "visual-qa", "# project visual layer");
  await skill(path.join(switchInstalled, "visual-qa"), "visual-qa", "# installed visual layer");
  const switchRegistry = { schema_version: 2, computer_use: { enabled: false }, skills: [{ id: "visual-qa", source: "installed", enabled: true }] };
  let switched = await resolveSkills({ workspaceRoot: switchWorkspace, codeRoot: root, installedDir: switchInstalled, registry: switchRegistry, codexHome: path.join(tmp, "none"), platform: "win32" });
  assert.equal(selectSkill(switched, "visual-qa").source, "project");
  await fs.rm(path.join(switchWorkspace, ".claude", "skills", "visual-qa"), { recursive: true, force: true });
  switched = await resolveSkills({ workspaceRoot: switchWorkspace, codeRoot: root, installedDir: switchInstalled, registry: switchRegistry, codexHome: path.join(tmp, "none"), platform: "win32" });
  assert.equal(selectSkill(switched, "visual-qa").source, "installed");
  await fs.rm(path.join(switchInstalled, "visual-qa"), { recursive: true, force: true });
  switched = await resolveSkills({ workspaceRoot: switchWorkspace, codeRoot: root, installedDir: switchInstalled, registry: { ...switchRegistry, skills: [] }, codexHome: path.join(tmp, "none"), platform: "win32" });
  assert.equal(selectSkill(switched, "visual-qa").source, "builtin");
  assert.equal(path.resolve(selectSkill(switched, "visual-qa").path), path.resolve(builtinVisualPath));
  assert.match(await fs.readFile(selectSkill(switched, "visual-qa").path, "utf8"), /# Visual review/);

  const aliasWorkspace = path.join(tmp, "alias-workspace");
  const aliasCode = path.join(tmp, "alias-code");
  await skill(path.join(aliasWorkspace, ".claude", "skills", "ppt-master"), "ppt-master", "# canonical id");
  await skill(path.join(aliasWorkspace, ".claude", "skills", "forked-skill"), "forked-skill", "# alias holder", "ppt-master");
  const aliases = await resolveSkills({ workspaceRoot: aliasWorkspace, codeRoot: aliasCode, installedDir: path.join(tmp, "alias-installed"), registry: { schema_version: 2, computer_use: { enabled: false }, skills: [] }, codexHome: path.join(tmp, "none"), platform: "win32" });
  assert.equal(selectSkill(aliases, "ppt-master").id, "ppt-master", "canonical id must beat another skill's alias");

  const computerWorkspace = path.join(tmp, "computer-workspace");
  const computerHome = path.join(tmp, "codex-home");
  const providerCode = path.join(tmp, "provider-code");
  const computerVersion = path.join(providerCode, "bundled-plugins", "computer-use");
  const browserVersion = path.join(providerCode, "bundled-plugins", "browser-use");
  await skill(path.join(computerWorkspace, ".claude", "skills", "computer-use"), "computer-use", "# fake reserved shadow");
  await skill(path.join(computerWorkspace, ".claude", "skills", "browser-use"), "browser-use", "# fake browser reserved shadow");
  await skill(path.join(computerVersion, "skills", "computer-use"), "computer-use", "# fake computer-use plugin");
  await skill(path.join(browserVersion, "skills", "browser-use"), "browser-use", "# fake browser-use plugin");
  await fs.mkdir(path.join(computerVersion, "docs"), { recursive: true });
  for (const name of ["guidance.md", "api.md", "confirmations.md"]) await fs.writeFile(path.join(computerVersion, "docs", name), `# ${name}\n`, "utf8");
  await fs.mkdir(path.join(browserVersion, "docs"), { recursive: true });
  await fs.writeFile(path.join(browserVersion, "docs", "provenance.md"), "# provenance.md\n", "utf8");
  const computerRegistryPath = path.join(tmp, "computer-plugins.json");
  const providerRegistry = { schema_version: 2, computer_use: { enabled: true }, browser_use: { enabled: true }, skills: [] };
  await fs.writeFile(computerRegistryPath, JSON.stringify(providerRegistry), "utf8");
  const computer = await resolveSkills({ workspaceRoot: computerWorkspace, codeRoot: providerCode, installedDir: path.join(tmp, "empty-installed"), registry: providerRegistry, codexHome: computerHome, platform: "win32" });
  assert.equal(selectSkill(computer, "computer-use").source, "computer-use", "bundled Computer Use must own its reserved id");
  assert.equal(computer.find((item) => item.source === "project" && item.id === "computer-use")?.shadowedBy, "computer-use");
  assert.equal(selectSkill(computer, "browser-use").source, "browser-use", "bundled Browser Use must own its reserved id");
  assert.equal(computer.find((item) => item.source === "project" && item.id === "browser-use")?.shadowedBy, "browser-use");
  const previousConfig = process.env.CHATGPT_PLUGINS_CONFIG;
  const previousHome = process.env.CODEX_HOME;
  process.env.CHATGPT_PLUGINS_CONFIG = computerRegistryPath;
  process.env.CODEX_HOME = computerHome;
  try {
    const { loadProjectSkill } = await import("../dist/lib/skills-loader.js");
    const loaded = await loadProjectSkill(computerWorkspace, "computer-use", 100_000);
    assert.equal(loaded.skill.source, "computer-use");
    assert.deepEqual((loaded.references ?? []).map((entry) => path.basename(entry.path)), ["guidance.md", "api.md", "confirmations.md"]);
    const browserLoaded = await loadProjectSkill(computerWorkspace, "browser-use", 100_000);
    assert.equal(browserLoaded.skill.source, "browser-use");
    assert.deepEqual((browserLoaded.references ?? []).map((entry) => path.basename(entry.path)), ["provenance.md"]);
  } finally {
    if (previousConfig === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
    else process.env.CHATGPT_PLUGINS_CONFIG = previousConfig;
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
  }
  console.log("skill-resolution: live disabled-load eligibility, project>installed>external>builtin, builtin content, canonical-id precedence, and bundled Computer/Browser reserved shadow/reference loading OK");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
