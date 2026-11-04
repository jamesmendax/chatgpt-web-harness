import fs from "node:fs/promises";
import path from "node:path";

export async function makeSkillDir(root, id, options = {}) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  const name = options.frontmatterName || id;
  const description = options.foldedDescription
    ? ["description: >", "  " + options.foldedDescription, "  Fixture workflow."].join("\n")
    : "description: " + (options.description || "Fixture Skill");
  const metadata = options.version ? ["metadata:", "  version: " + options.version] : [];
  const frontmatter = ["---", "name: " + name, description, ...metadata, "---", ""].join("\n");
  await fs.writeFile(path.join(dir, "SKILL.md"), frontmatter + (options.body || "# Fixture Skill\n"), "utf8");
  for (const [relative, content] of Object.entries(options.references || {})) {
    const file = path.join(dir, "references", relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  for (const [relative, content] of Object.entries(options.workflows || {})) {
    const file = path.join(dir, "workflows", relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  for (const [relative, content] of Object.entries(options.scripts || {})) {
    const file = path.join(dir, "scripts", relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
  }
  return dir;
}

export async function writeRegistryV2(file, skills = [], computerUse = false, browserUse = false) {
  const value = { schema_version: 2, computer_use: { enabled: computerUse }, browser_use: { enabled: browserUse }, skills };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
  return value;
}
