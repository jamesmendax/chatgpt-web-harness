import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSkillDir, writeRegistryV2 } from "./lib/skill-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, ".tool-test-tmp", "skill-installer");
await fs.rm(tmp, { recursive: true, force: true });
const source = path.join(tmp, "ppt-master-main");
const localSkillsDir = path.join(tmp, "runtime", "profiles", "local-skills");
const registryPath = path.join(tmp, "runtime", "profiles", "plugins.json");
await fs.mkdir(localSkillsDir, { recursive: true });
await writeRegistryV2(registryPath);
await makeSkillDir(tmp, "ppt-master-main", {
  frontmatterName: "presentation",
  description: "Fixture presentation workflow",
  version: "1.2.3",
  references: { "LICENSE.md": "license bytes\n" },
  workflows: { "routing.md": "route\n" },
  scripts: { "check.mjs": "console.log('fixture')\n" },
  body: "# Preserve this exact body\n",
});

try {
  const installer = await import("../dist/lib/skill-installer.js");
  const resolver = await import("../dist/lib/skill-resolver.js");
  const pluginConfig = await import("../dist/lib/plugin-config.js");
  const located = installer.locatePackageRoot(source);
  assert.equal(located.root, source);
  const installed = await installer.installSkill({ source, localSkillsDir, registryPath });
  assert.equal(installed.id, "ppt-master");
  assert.deepEqual(installed.aliases, ["presentation"]);
  assert.equal(await fs.readFile(path.join(localSkillsDir, "ppt-master", "SKILL.md"), "utf8"), await fs.readFile(path.join(source, "SKILL.md"), "utf8"));
  assert.equal(await fs.readFile(path.join(localSkillsDir, "ppt-master", "references", "LICENSE.md"), "utf8"), "license bytes\n");
  let config = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(config.schema_version, 2);
  assert.equal(config.skills[0].source, "installed");
  assert.equal(config.skills[0].version, "1.2.3");

  await installer.setSkillEnabled({ id: "ppt-master", enabled: false, localSkillsDir, registryPath });
  config = JSON.parse(await fs.readFile(registryPath, "utf8"));
  assert.equal(config.skills[0].enabled, false);
  const disabled = await resolver.resolveSkills({ workspaceRoot: tmp, codeRoot: root, installedDir: localSkillsDir, registry: config, codexHome: path.join(tmp, "codex"), platform: process.platform });
  assert.equal(disabled.find((skill) => skill.id === "ppt-master")?.enabled, false);
  await installer.setSkillEnabled({ id: "ppt-master", enabled: true, localSkillsDir, registryPath });

  const externalFile = path.join(tmp, "external", "SKILL.md");
  await fs.mkdir(path.dirname(externalFile), { recursive: true });
  await fs.writeFile(externalFile, "---\nname: outside\n---\n# outside\n", "utf8");
  await fs.writeFile(registryPath, JSON.stringify({ schema_version: 2, computer_use: { enabled: false }, skills: [{ id: "outside", source: "external", path: externalFile }] }, null, 2) + "\n");
  await installer.uninstallSkill({ id: "outside", localSkillsDir, registryPath });
  assert.equal(await fs.readFile(externalFile, "utf8").then(() => true), true, "external file must remain");

  await assert.rejects(() => installer.installSkill({ source: localSkillsDir, localSkillsDir, registryPath }), /local-skills/);
  for (const id of ["Presentation", "..", "%2e%2e", "CON", "computer-use"]) {
    await assert.rejects(() => installer.installSkill({ source, id, localSkillsDir, registryPath }), /Skill id|保留/);
  }

  // A Windows junction is reported by lstat as a symbolic link.  Both the
  // package root and nested entries must be rejected before any copy occurs.
  const linkedRoot = path.join(tmp, "linked-source");
  nodeFs.symlinkSync(source, linkedRoot, "junction");
  assert.throws(() => installer.locatePackageRoot(linkedRoot), /普通目录|符号链接|junction/);
  nodeFs.unlinkSync(linkedRoot);
  const nestedJunction = path.join(source, "references", "outside-junction");
  nodeFs.symlinkSync(tmp, nestedJunction, "junction");
  await assert.rejects(() => installer.installSkill({ source, id: "nested-link", localSkillsDir, registryPath }), /符号链接|junction/);
  nodeFs.unlinkSync(nestedJunction);

  // A project copy shadows an installed copy, but uninstalling the installed
  // layer must still remove only that layer and preserve the project files.
  const projectWorkspace = path.join(tmp, "project-workspace");
  const projectCopy = await makeSkillDir(path.join(projectWorkspace, ".claude", "skills"), "same-id", { body: "# project copy\n" });
  const installedCopy = await makeSkillDir(tmp, "same-id-source", { body: "# installed copy\n" });
  await installer.installSkill({ source: installedCopy, id: "same-id", localSkillsDir, registryPath });
  await installer.uninstallSkill({ id: "same-id", localSkillsDir, registryPath, workspaceRoot: projectWorkspace, codeRoot: root });
  assert.equal((await fs.readFile(path.join(projectCopy, "SKILL.md"), "utf8")).includes("project copy"), true);
  assert.equal(await fs.stat(path.join(localSkillsDir, "same-id")).then(() => true).catch(() => false), false);

  const rollbackRegistry = path.join(tmp, "rollback", "plugins.json");
  const rollbackDir = path.join(tmp, "rollback", "local-skills");
  await writeRegistryV2(rollbackRegistry);
  const originalBytes = await fs.readFile(rollbackRegistry);
  let copies = 0;
  const failCopy = (from, to) => {
    copies += 1;
    if (copies === 2) throw new Error("injected copy failure");
    return nodeFs.copyFileSync(from, to);
  };
  await assert.rejects(() => installer.installSkill({
    source,
    id: "rollback",
    localSkillsDir: rollbackDir,
    registryPath: rollbackRegistry,
    fsOps: { copyFileSync: failCopy },
  }), /injected copy failure/);
  assert.deepEqual(await fs.readFile(rollbackRegistry), originalBytes);
  assert.equal((await fs.readdir(rollbackDir)).some((name) => name.startsWith(".staging-")), false);

  const oldDir = await makeSkillDir(rollbackDir, "replace-me", { body: "# old\n" });
  const replacement = await makeSkillDir(tmp, "replacement", { body: "# new\n" });
  await fs.writeFile(path.join(replacement, "LICENSE.md"), "new license\n", "utf8");
  await writeRegistryV2(path.join(tmp, "replace-registry.json"), [{ id: "replace-me", source: "installed", enabled: true }]);
  const replaceRegistry = path.join(tmp, "replace-registry.json");
  copies = 0;
  await assert.rejects(() => installer.installSkill({
    source: replacement,
    id: "replace-me",
    localSkillsDir: rollbackDir,
    registryPath: replaceRegistry,
    fsOps: { copyFileSync: failCopy },
  }), /injected copy failure/);
  assert.match(await fs.readFile(path.join(oldDir, "SKILL.md"), "utf8"), /# old\n$/);
  assert.equal((await fs.readdir(rollbackDir)).some((name) => name.startsWith(".backup-") || name.startsWith(".staging-")), false);

  // The failure can also happen after the old target has already been moved
  // aside.  The transaction must restore that target and leave no staging or
  // backup residue when publishing the replacement fails.
  const renameRollbackDir = path.join(tmp, "rename-rollback-local-skills");
  const renameRollbackRegistry = path.join(tmp, "rename-rollback-registry.json");
  const renameRollbackOld = await makeSkillDir(renameRollbackDir, "rename-id", { body: "# rename old\n" });
  const renameRollbackSource = await makeSkillDir(tmp, "rename-source", { body: "# rename new\n" });
  await writeRegistryV2(renameRollbackRegistry, [{ id: "rename-id", source: "installed", enabled: true }]);
  let renameRollbackCalls = 0;
  const failAfterOldRename = {
    renameSync(from, to) {
      renameRollbackCalls += 1;
      if (renameRollbackCalls === 2) { const error = new Error("injected target publish failure"); error.code = "EPERM"; throw error; }
      return nodeFs.renameSync(from, to);
    },
  };
  await assert.rejects(() => installer.installSkill({ source: renameRollbackSource, id: "rename-id", localSkillsDir: renameRollbackDir, registryPath: renameRollbackRegistry, fsOps: failAfterOldRename }), /target publish failure/);
  assert.match(await fs.readFile(path.join(renameRollbackOld, "SKILL.md"), "utf8"), /# rename old/);
  assert.equal((await fs.readdir(renameRollbackDir)).some((name) => name.startsWith(".backup-") || name.startsWith(".staging-")), false);

  // Windows path comparison is case-insensitive: a differently-cased
  // existing directory is the same Skill and must honor overwrite=false.
  const caseDir = path.join(tmp, "case-local-skills");
  const caseRegistry = path.join(tmp, "case-registry.json");
  await makeSkillDir(caseDir, "Presentation", { body: "# case old\n" });
  await writeRegistryV2(caseRegistry, [{ id: "presentation", source: "installed", enabled: true }]);
  await assert.rejects(() => installer.installSkill({ source, id: "presentation", localSkillsDir: caseDir, registryPath: caseRegistry, overwrite: false }), /已存在/);

  // Registry publication is committed before old-backup cleanup.  A cleanup
  // failure therefore leaves the new target/metadata plus a recoverable old
  // backup, instead of rolling back files behind the registry's back.
  const cleanupFailureRegistry = path.join(tmp, "cleanup-failure-registry.json");
  const cleanupFailureDir = path.join(tmp, "cleanup-failure-local-skills");
  await makeSkillDir(cleanupFailureDir, "cleanup-id", { body: "# old cleanup\n" });
  await writeRegistryV2(cleanupFailureRegistry, [{ id: "cleanup-id", source: "installed", enabled: true }]);
  const cleanupSource = await makeSkillDir(tmp, "cleanup-source", { body: "# new cleanup\n" });
  const cleanupFsOps = {
    rmSync(file, options) {
      if (String(file).includes(".backup-")) throw new Error("injected backup cleanup failure");
      return nodeFs.rmSync(file, options);
    },
  };
  const cleanupResult = await installer.installSkill({ source: cleanupSource, id: "cleanup-id", localSkillsDir: cleanupFailureDir, registryPath: cleanupFailureRegistry, fsOps: cleanupFsOps });
  assert.match(cleanupResult.warnings.join("\n"), /备份清理失败/);
  assert.match(await fs.readFile(path.join(cleanupFailureDir, "cleanup-id", "SKILL.md"), "utf8"), /new cleanup/);
  assert.equal(JSON.parse(await fs.readFile(cleanupFailureRegistry, "utf8")).skills.find((row) => row.id === "cleanup-id")?.source, "installed");
  assert.equal((await fs.readdir(cleanupFailureDir)).some((name) => name.startsWith(".backup-")), true);

  const atomicFile = path.join(tmp, "atomic", "plugins.json");
  await fs.mkdir(path.dirname(atomicFile), { recursive: true });
  await fs.writeFile(atomicFile, "OLD-BYTES\n", "utf8");
  let renameCalls = 0;
  const publishFailureOps = {
    renameSync(from, to) {
      renameCalls += 1;
      if (renameCalls === 1) { const error = new Error("injected publish conflict"); error.code = "EPERM"; throw error; }
      if (renameCalls === 3) { const error = new Error("injected publish failure"); error.code = "EPERM"; throw error; }
      return nodeFs.renameSync(from, to);
    },
  };
  assert.throws(() => pluginConfig.atomicWriteJsonAt(atomicFile, { newer: true }, publishFailureOps), /injected publish failure/);
  assert.equal(await fs.readFile(atomicFile, "utf8"), "OLD-BYTES\n");
  assert.equal((await fs.readdir(path.dirname(atomicFile))).some((name) => name.endsWith(".tmp") || name.endsWith(".bak")), false);

  const backupKeptFile = path.join(tmp, "atomic", "backup-kept.json");
  await fs.writeFile(backupKeptFile, "old\n", "utf8");
  renameCalls = 0;
  const cleanupBackupOps = {
    renameSync(from, to) {
      renameCalls += 1;
      if (renameCalls === 1) { const error = new Error("injected replace conflict"); error.code = "EPERM"; throw error; }
      return nodeFs.renameSync(from, to);
    },
    rmSync(file, options) {
      if (String(file).endsWith(".bak")) throw new Error("injected backup retention");
      return nodeFs.rmSync(file, options);
    },
  };
  pluginConfig.atomicWriteJsonAt(backupKeptFile, { fresh: true }, cleanupBackupOps);
  assert.match(await fs.readFile(backupKeptFile, "utf8"), /fresh/);
  assert.equal((await fs.readdir(path.dirname(backupKeptFile))).some((name) => name.startsWith("backup-kept.json.") && name.endsWith(".bak")), true);

  const builtinRegistry = path.join(tmp, "builtin-registry.json");
  await writeRegistryV2(builtinRegistry, [{ id: "built-in", source: "builtin", enabled: true }]);
  await assert.rejects(() => installer.uninstallSkill({ id: "built-in", localSkillsDir, registryPath: builtinRegistry, codeRoot: root }), /不可卸载/);
  await installer.uninstallSkill({ id: "ppt-master", localSkillsDir, registryPath });
  assert.equal(await fs.stat(path.join(localSkillsDir, "ppt-master")).then(() => true).catch(() => false), false);

  console.log("skill-installer: install byte preservation, metadata, enable/disable, external retention, id/path guards, rollback, builtin protection OK");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
