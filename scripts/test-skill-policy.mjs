import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Default to the compiled delivery; --source permits the same assertions on Node 24.
if (process.argv.includes("--source")) {
  const { registerHooks } = await import("node:module");
  const sourceRoot = new URL("../src/", import.meta.url).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && /^\.{1,2}\//.test(specifier) && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    return nextResolve(specifier, context);
  } });
}
const resolverUrl = new URL(process.argv.includes("--source") ? "../src/lib/skill-resolver.ts" : "../dist/lib/skill-resolver.js", import.meta.url);
const { parseSkillFrontmatter, parseCodexInvocationPolicy, computeSkillContentHash, resolveSkills, selectSkill } = await import(resolverUrl.href);
const checked = [];
async function check(name, run) {
  await run();
  checked.push(name);
}
const frontmatter = (directives = [], body = "Follow the fixture workflow.") => ["---", ...directives, "---", body, ""].join("\n");

await check("BOM, folded description, comments, and top-level isolation", () => {
  const parsed = parseSkillFrontmatter("\uFEFF" + frontmatter([
    "name: actual-skill",
    "description: >- # folded text",
    "  Create diagrams in 中文",
    "  using current source evidence.",
    "# outside the scalar",
    "metadata:",
    "  version: 1.2.3",
    "  name: must-not-replace-root",
    "  description: must-not-replace-root",
    "  disable-model-invocation: true",
    "disable-model-invocation: false # automatic invocation is permitted",
  ]));
  assert.equal(parsed.name, "actual-skill");
  assert.equal(parsed.description, "Create diagrams in 中文 using current source evidence.");
  assert.equal(parsed.version, "1.2.3");
  assert.deepEqual(parsed.invocation_policy, { allow_implicit: true, allow_explicit: true });
});

await check("literal description and quoted hashes remain text", () => {
  const parsed = parseSkillFrontmatter(frontmatter(["name: 'literal#name' # comment", "description: |-", "  First line", "  # literal content", "  Second line"]));
  assert.equal(parsed.name, "literal#name");
  assert.equal(parsed.description, "First line\n# literal content\nSecond line");
  assert.equal(parseSkillFrontmatter(frontmatter(['description: "Keep # inside" # discard'])).description, "Keep # inside");
});

await check("Claude disable wins across duplicate directives", () => {
  const parsed = parseSkillFrontmatter(frontmatter(["disable-model-invocation: TRUE # deny", "disable-model-invocation: false"]));
  assert.deepEqual(parsed.invocation_policy, { allow_implicit: false, allow_explicit: true });
});

await check("user-invocable only controls direct-command visibility", () => {
  const parsed = parseSkillFrontmatter(frontmatter(["user-invocable: false", "user-invocable: true", "disable-model-invocation: false"]));
  assert.equal(parsed.user_invocable, false);
  assert.deepEqual(parsed.invocation_policy, { allow_implicit: true, allow_explicit: true });
});

await check("malformed directives and unclosed headers fail closed for automatic use", () => {
  for (const content of [
    frontmatter(['disable-model-invocation: "false"']),
    frontmatter(["disable-model-invocation: !!bool false"]),
    frontmatter(["disable-model-invocation false"]),
    frontmatter(["<<: *shared-policy"]),
    "---\nname: unclosed\ndisable-model-invocation: false\n",
  ]) {
    const parsed = parseSkillFrontmatter(content);
    assert.equal(parsed.invocation_policy?.allow_implicit, false);
    assert.equal(parsed.invocation_policy?.allow_explicit, true);
    assert.ok(parsed.warnings?.length);
  }
});

await check("Codex policies respect root scope, BOM, comments, and quoted keys", () => {
  assert.equal(parseCodexInvocationPolicy("\uFEFFinterface:\n  policy:\n    allow_implicit_invocation: false\npolicy:\n  allow_implicit_invocation: true # allowed\n").allow_implicit, true);
  assert.equal(parseCodexInvocationPolicy('"policy":\n  "allow_implicit_invocation": false # denied\n').allow_implicit, false);
  assert.equal(parseCodexInvocationPolicy("  policy:\n    allow_implicit_invocation: false\n").allow_implicit, false);
  assert.equal(parseCodexInvocationPolicy("policy: { allow_implicit_invocation: false } # denied\n").allow_implicit, false);
  assert.equal(parseCodexInvocationPolicy("policy: {}\n").allow_implicit, true);
});

await check("Codex explicit denials cannot be overwritten or inherited through unsafe YAML", () => {
  const duplicate = "policy:\n  allow_implicit_invocation: false\n  allow_implicit_invocation: true\npolicy:\n  allow_implicit_invocation: true\n";
  assert.equal(parseCodexInvocationPolicy(duplicate).allow_implicit, false);
  for (const content of [
    "policy:\n  allow_implicit_invocation: maybe\n",
    "policy: *shared\n",
    "policy:\n  <<: *shared\n",
    "<<: *shared\n",
    "policy:\n  - allow_implicit_invocation: true\n",
    "policy:\n  allow_implicit_invocation true\n",
  ]) {
    const parsed = parseCodexInvocationPolicy(content);
    assert.equal(parsed.allow_implicit, false);
    assert.ok(parsed.warnings.length);
  }
});

await check("raw-byte signatures include YAML presence and same-policy edits", () => {
  const body = Buffer.from("# Skill\n", "utf8");
  const yaml = Buffer.from("policy:\n  allow_implicit_invocation: true\n", "utf8");
  const hash = computeSkillContentHash(body, yaml);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, computeSkillContentHash(body.toString(), yaml.toString()));
  assert.notEqual(hash, computeSkillContentHash(Buffer.from("# Skill\r\n"), yaml));
  assert.notEqual(hash, computeSkillContentHash(body, Buffer.concat([yaml, Buffer.from("# same effective policy\n")])));
  assert.notEqual(computeSkillContentHash(body), computeSkillContentHash(body, Buffer.alloc(0)));
  assert.notEqual(computeSkillContentHash(Buffer.from([0xff])), computeSkillContentHash(Buffer.from([0xfe])));
});

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "web-harness-skill-policy-"));
try {
  const workspaceRoot = path.join(tmpRoot, "workspace");
  const codeRoot = path.join(tmpRoot, "code");
  const installedDir = path.join(tmpRoot, "installed");
  const externalDir = path.join(tmpRoot, "external");
  async function writeSkill(dir, directives = [], yaml) {
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), frontmatter(directives));
    await fs.writeFile(path.join(dir, "references", "usage.md"), "Fixture reference.\n");
    if (yaml !== undefined) {
      await fs.mkdir(path.join(dir, "agents"), { recursive: true });
      await fs.writeFile(path.join(dir, "agents", "openai.yaml"), yaml);
    }
  }
  const defaultDir = path.join(installedDir, "default");
  const codexDir = path.join(installedDir, "codex-policy");
  await writeSkill(defaultDir, ["name: default", "description: Default portable skill"]);
  await writeSkill(codexDir, ["name: codex-policy"], "policy:\n  allow_implicit_invocation: false\n");
  await writeSkill(path.join(installedDir, "claude-policy"), ["disable-model-invocation: true"], "policy:\n  allow_implicit_invocation: true\n");
  await writeSkill(path.join(installedDir, "menu-hidden"), ["user-invocable: false"]);
  await writeSkill(path.join(installedDir, "disabled"), ["name: disabled"]);
  await writeSkill(path.join(workspaceRoot, ".claude", "skills", "shared"), ["name: shared-alias", "disable-model-invocation: true"]);
  await writeSkill(path.join(installedDir, "shared"), ["name: shared-alias"]);
  await writeSkill(path.join(installedDir, "alias-fallback"), ["name: shared-alias"]);
  await writeSkill(path.join(codeRoot, "skills", "builtin-fixture"), ["name: builtin-fixture"]);
  await writeSkill(externalDir, ["name: external-fixture"]);
  await writeSkill(path.join(codeRoot, "bundled-plugins", "computer-use", "skills", "computer-use"), ["name: computer-use"]);
  await writeSkill(path.join(codeRoot, "bundled-plugins", "browser-use", "skills", "browser-use"), ["name: browser-use"]);
  const unreadablePolicyDir = path.join(installedDir, "unreadable-policy");
  await writeSkill(unreadablePolicyDir, ["name: unreadable-policy"]);
  await fs.mkdir(path.join(unreadablePolicyDir, "agents", "openai.yaml"), { recursive: true });
  const input = {
    workspaceRoot,
    codeRoot,
    installedDir,
    codexHome: path.join(tmpRoot, "codex-home"),
    platform: "win32",
    registry: {
      computer_use: { enabled: true },
      browser_use: { enabled: true },
      skills: [
        { id: "disabled", source: "installed", enabled: false },
        { id: "external-fixture", source: "external", path: path.join(externalDir, "SKILL.md"), enabled: true },
      ],
    },
  };
  const skills = await resolveSkills(input);

  await check("unconfigured Skills default to both invocation modes", () => {
    const skill = selectSkill(skills, "default");
    assert.deepEqual(skill.invocation_policy, { allow_implicit: true, allow_explicit: true });
    assert.equal(skill.user_invocable, true);
    assert.equal(selectSkill(skills, "default", "implicit"), skill);
  });

  await check("Claude and Codex policy denials combine without denying explicit use", () => {
    for (const id of ["claude-policy", "codex-policy"]) {
      assert.equal(selectSkill(skills, id).id, id);
      assert.throws(() => selectSkill(skills, id, "implicit"), /does not allow implicit invocation/);
    }
    const hidden = selectSkill(skills, "menu-hidden");
    assert.equal(hidden.user_invocable, false);
    assert.equal(selectSkill(skills, "menu-hidden", "implicit"), hidden);
  });

  await check("winner policy cannot be bypassed by a shadowed copy or competing alias", () => {
    assert.equal(selectSkill(skills, "shared").source, "project");
    assert.equal(selectSkill(skills, "shared-alias").id, "shared");
    assert.equal(skills.find((skill) => skill.id === "shared" && skill.source === "installed")?.shadowedBy, "project");
    assert.throws(() => selectSkill(skills, "shared", "implicit"), /does not allow implicit invocation/);
    assert.throws(() => selectSkill(skills, "shared-alias", "implicit"), /does not allow implicit invocation/);
  });

  await check("disabled Skills remain unavailable regardless of invocation mode", () => {
    assert.equal(skills.find((skill) => skill.id === "disabled")?.enabled, false);
    assert.throws(() => selectSkill(skills, "disabled"), /Unknown Skill/);
    assert.throws(() => selectSkill(skills, "disabled", "implicit"), /Unknown Skill/);
  });

  await check("unreadable policy cannot be treated as an absent permissive policy", () => {
    const skill = skills.find((item) => item.id === "unreadable-policy");
    assert.equal(skill?.invocation_policy?.allow_implicit, false);
    assert.equal(skill?.content_sha256, undefined);
    assert.ok(skill?.warnings?.some((warning) => warning.includes("unreadable")));
    assert.throws(() => selectSkill(skills, "unreadable-policy", "implicit"), /does not allow implicit invocation/);
  });

  await check("compact discovery preserves identity and policies while skipping all layout walks", async () => {
    const compact = await resolveSkills({ ...input, includeLayout: false });
    assert.equal(compact.length, skills.length);
    assert.ok(skills.every((skill) => skill.layout.references.includes("usage.md")));
    for (let index = 0; index < skills.length; index++) {
      const { layout: fullLayout, ...fullMetadata } = skills[index];
      const { layout: compactLayout, ...compactMetadata } = compact[index];
      assert.deepEqual(compactMetadata, fullMetadata);
      assert.deepEqual(compactLayout, { references: [], workflows: [], scripts: [] });
      assert.ok(fullLayout.references.length);
    }
  });

  await check("fresh resolve reflects actual policy changes and exact raw-byte signatures", async () => {
    const original = selectSkill(skills, "codex-policy");
    const body = await fs.readFile(path.join(codexDir, "SKILL.md"));
    const oldYaml = await fs.readFile(path.join(codexDir, "agents", "openai.yaml"));
    assert.equal(original.content_sha256, computeSkillContentHash(body, oldYaml));
    await fs.writeFile(path.join(codexDir, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: true # now enabled\n");
    const changed = selectSkill(await resolveSkills({ ...input, includeLayout: false }), "codex-policy", "implicit");
    assert.notEqual(changed.content_sha256, original.content_sha256);
    await fs.appendFile(path.join(codexDir, "agents", "openai.yaml"), "# same effective policy, changed bytes\n");
    const commentChanged = selectSkill(await resolveSkills({ ...input, includeLayout: false }), "codex-policy", "implicit");
    assert.notEqual(commentChanged.content_sha256, changed.content_sha256);
    await fs.appendFile(path.join(codexDir, "SKILL.md"), "Updated workflow.\n");
    const bodyChanged = selectSkill(await resolveSkills({ ...input, includeLayout: false }), "codex-policy", "implicit");
    assert.notEqual(bodyChanged.content_sha256, commentChanged.content_sha256);
  });

  await check("older in-memory fixtures retain permissive policy defaults", () => {
    const legacy = { ...selectSkill(skills, "default") };
    delete legacy.invocation_policy;
    delete legacy.content_sha256;
    delete legacy.user_invocable;
    assert.equal(selectSkill([legacy], "default", "implicit"), legacy);
    assert.equal(selectSkill([legacy], "default"), legacy);
  });
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true, test: "skill-policy", passed: checked.length, checks: checked }, null, 2));
