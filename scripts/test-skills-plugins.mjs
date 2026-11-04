import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "skills-plugins");
await fs.rm(tmpRoot, { recursive: true, force: true });

const workspace = path.join(tmpRoot, "workspace");
const projectSkillDir = path.join(workspace, ".claude", "skills", "project-fixture");
const externalSkillDir = path.join(tmpRoot, "open-source-fixture");
const externalReferenceDir = path.join(externalSkillDir, "references");
const registryPath = path.join(tmpRoot, "plugins.json");
const installedDir = path.join(tmpRoot, "local-skills");
const installedSkillDir = path.join(installedDir, "presentation");
const brokenSkillDir = path.join(installedDir, "broken");
const codexHome = path.join(tmpRoot, "codex-home");
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated skill installation and enablement fixtures",
  scope: ["temporary skills/plugin fixture"],
  out_of_scope: [], deliverables: ["skill lifecycle assertions"],
  success_criteria: ["install, disable, list, and uninstall behave deterministically"],
  constraints: [], protected_resources: [], known_facts: ["all mutations are isolated under tmpRoot"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

await fs.mkdir(projectSkillDir, { recursive: true });
await fs.mkdir(externalReferenceDir, { recursive: true });
await fs.mkdir(path.join(installedSkillDir, "workflows"), { recursive: true });
await fs.mkdir(brokenSkillDir, { recursive: true });
await fs.mkdir(codexHome, { recursive: true });
await fs.mkdir(path.join(installedDir, ".staging-fixture"), { recursive: true });
await fs.writeFile(
  path.join(projectSkillDir, "SKILL.md"),
  [
    "---",
    "name: project-fixture",
    "description: Project-local skill fixture",
    "---",
    "",
    "Use the project fixture workflow.",
  ].join("\n")
);
await fs.writeFile(
  path.join(externalSkillDir, "SKILL.md"),
  [
    "---",
    "name: open-source-fixture",
    "description: Adapted open-source skill fixture",
    "---",
    "",
    "Follow the adapted open-source workflow.",
  ].join("\n")
);
await fs.writeFile(path.join(externalReferenceDir, "usage.md"), "Reference: adapted usage contract\n");
await fs.writeFile(
  path.join(installedSkillDir, "SKILL.md"),
  [
    "---",
    "name: ppt-master",
    "description: >",
    "  AI-driven presentation workflow",
    "  requests that mention ppt-master",
    "metadata:",
    "  version: 5.1.0",
    "---",
    "",
    "Use installed presentation workflow.",
  ].join("\n")
);
await fs.writeFile(path.join(installedSkillDir, "workflows", "routing.md"), "routing\n");

const previous = {
  config: process.env.CHATGPT_PLUGINS_CONFIG,
  codexHome: process.env.CODEX_HOME,
};
process.env.CHATGPT_PLUGINS_CONFIG = registryPath;
process.env.CODEX_HOME = codexHome;
await fs.writeFile(
  registryPath,
  JSON.stringify(
    {
      computer_use: { enabled: false },
      browser_use: { enabled: false },
      skills: [
        { name: "open-source-fixture", path: path.join(externalSkillDir, "SKILL.md"), enabled: true },
        { name: "disabled-fixture", path: path.join(tmpRoot, "disabled", "SKILL.md"), enabled: false },
        { name: "missing-fixture", path: path.join(tmpRoot, "missing", "SKILL.md"), enabled: true },
        { name: "invalid-fixture", path: path.join(tmpRoot, "not-a-skill.md"), enabled: true },
        { id: "presentation", source: "installed", enabled: true, version: "5.1.0" },
        { id: "visual-qa", source: "builtin", enabled: true },
      ],
    },
    null,
    2
  )
);

try {
  const { getLocalPluginsConfig, getRegisteredSkills, saveLocalPluginsConfig } = await import("../dist/lib/plugin-config.js");
  const { resolveSkills } = await import("../dist/lib/skill-resolver.js");
  assert.equal(getRegisteredSkills().length, 3, "invalid and disabled registrations must not enter the skill surface");

  saveLocalPluginsConfig({ ...getLocalPluginsConfig(), computer_use: { enabled: true }, browser_use: { enabled: true } });
  const savedConfig = getLocalPluginsConfig();
  assert.equal(savedConfig.computer_use?.enabled, true, "Computer Use toggle failed");
  assert.equal(savedConfig.browser_use?.enabled, true, "Browser Use toggle failed");
  assert.equal(savedConfig.skills?.length, 6, "Computer Use toggle dropped the generic skill registry");
  assert.ok(savedConfig.skills.some((skill) => skill.id === "presentation" && skill.source === "installed"));
  assert.ok(savedConfig.skills.some((skill) => skill.id === "visual-qa" && skill.source === "builtin"));
  const resolved = await resolveSkills({
    workspaceRoot: workspace,
    codeRoot: root,
    installedDir,
    registry: savedConfig,
    codexHome,
    platform: process.platform,
  });
  const installed = resolved.find((skill) => skill.id === "presentation");
  assert.equal(installed?.source, "installed");
  assert.deepEqual(installed?.aliases, ["ppt-master"]);
  assert.match(installed?.description || "", /AI-driven presentation workflow requests that mention ppt-master/);
  assert.deepEqual(installed?.layout.workflows, ["routing.md"]);
  assert.equal(resolved.find((skill) => skill.id === "broken")?.error, "SKILL.md not found");
  assert.equal(resolved.some((skill) => skill.dir.includes(".staging-fixture")), false);

  const { createMcpServer } = await import("../dist/server-factory.js");
  const server = createMcpServer(workspace, 30_000, [workspace], true);
  const client = new Client({ name: "skills-plugin-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  serverTransport.sessionId = "skills-plugin-test-session";

  try {
    const listed = await client.callTool({ name: "list_skills", arguments: {} });
    const skills = listed.structuredContent?.data?.skills ?? [];
    const projectSkill = skills.find((skill) => skill.name === "project-fixture");
    const externalSkill = skills.find((skill) => skill.name === "open-source-fixture");
    const installedSkill = skills.find((skill) => skill.name === "presentation");
    assert.equal(projectSkill?.source, "project", "project skill was not discovered");
    assert.equal(externalSkill?.source, "external", "registered local skill was not discovered");
    assert.equal(installedSkill?.source, "installed", "installed Skill was not discovered");
    assert.deepEqual(installedSkill?.aliases, ["ppt-master"]);
    assert.match(installedSkill?.description ?? "", /requests that mention ppt-master/);
    assert.ok(installedSkill?.dir.endsWith(path.join("local-skills", "presentation")));
    assert.ok(!skills.some((skill) => skill.name === "disabled-fixture"), "disabled skill leaked into list_skills");
    assert.ok(!skills.some((skill) => skill.name === "missing-fixture"), "missing registration leaked into list_skills");
    assert.ok(!skills.some((skill) => skill.name === "invalid-fixture"), "non-SKILL.md path leaked into list_skills");

    const loaded = await client.callTool({
      name: "load_skill",
      arguments: { name: "ppt-master" },
    });
    const data = loaded.structuredContent?.data;
    assert.equal(loaded.structuredContent?.ok, true, "load_skill failed for a registered local skill");
    assert.match(data?.content ?? "", /Use installed presentation workflow\./);
    assert.deepEqual(
      (data?.reference_paths ?? []).map((file) => path.basename(file)),
      [],
      "installed skill reference manifest should be empty for this fixture"
    );
    assert.equal(data?.resolved_via, "alias");
    assert.ok(data?.layout?.workflows?.includes("routing.md"));

    const installSource = path.join(tmpRoot, "new-skill-source");
    await fs.mkdir(installSource, { recursive: true });
    await fs.writeFile(path.join(installSource, "SKILL.md"), "---\nname: new-alias\ndescription: new skill\n---\n# new\n");
    const installedByTool = await client.callTool({ name: "install_skill", arguments: { source: installSource, id: "new-skill", _intent: TEST_INTENT } });
    assert.equal(installedByTool.structuredContent?.ok, true);
    const afterInstall = await client.callTool({ name: "list_skills", arguments: {} });
    assert.ok((afterInstall.structuredContent?.data?.skills ?? []).some((skill) => skill.name === "new-skill"));
    const disabledByTool = await client.callTool({ name: "set_skill_enabled", arguments: { id: "new-skill", enabled: false, _intent: TEST_INTENT } });
    assert.equal(disabledByTool.structuredContent?.ok, true);
    const hidden = await client.callTool({ name: "list_skills", arguments: {} });
    assert.ok(!(hidden.structuredContent?.data?.skills ?? []).some((skill) => skill.name === "new-skill"));
    const removedByTool = await client.callTool({ name: "uninstall_skill", arguments: { id: "new-skill", _intent: TEST_INTENT } });
    assert.equal(removedByTool.structuredContent?.ok, true);
    assert.equal(await fs.stat(path.join(installedDir, "new-skill")).then(() => true).catch(() => false), false);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }

  console.log("skills-plugins: project, registered local, disabled/invalid exclusion, MCP list/load, and config preservation OK");
} finally {
  if (previous.config === undefined) delete process.env.CHATGPT_PLUGINS_CONFIG;
  else process.env.CHATGPT_PLUGINS_CONFIG = previous.config;
  if (previous.codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previous.codexHome;
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
