import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readIndexedSkillFile } from "./skill-index.js";

export type ResolvedSkillSource = "project" | "installed" | "external" | "builtin" | "computer-use" | "browser-use";

export interface SkillLayout {
  references: string[];
  workflows: string[];
  scripts: string[];
}

export interface SkillInvocationPolicy {
  allow_implicit: boolean;
  allow_explicit: boolean;
}

export type SkillInvocationMode = "explicit" | "implicit";

export interface ResolvedSkill {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  path: string;
  dir: string;
  source: ResolvedSkillSource;
  enabled: boolean;
  version?: string;
  installed_at?: string;
  shadowedBy?: ResolvedSkillSource;
  warnings?: string[];
  error?: string;
  layout: SkillLayout;
  /** Omitted by older callers; omitted values retain the portable default. */
  invocation_policy?: SkillInvocationPolicy;
  /** Claude's slash-menu visibility flag, not a permission to load the Skill. */
  user_invocable?: boolean;
  /** Signature of exact SKILL.md and optional agents/openai.yaml bytes. */
  content_sha256?: string;
}

export interface SkillResolverRegistryEntry {
  id?: string;
  name?: string;
  source?: "installed" | "external" | "builtin";
  aliases?: string[];
  path?: string;
  enabled?: boolean;
  installed_at?: string;
  version?: string;
  origin?: string;
  warnings?: string[];
  error?: string;
}

export interface SkillResolverRegistry {
  schema_version?: number;
  computer_use?: { enabled?: boolean };
  browser_use?: { enabled?: boolean };
  skills?: SkillResolverRegistryEntry[];
}

export interface ResolveSkillsInput {
  workspaceRoot: string;
  codeRoot: string;
  installedDir: string;
  registry: SkillResolverRegistry;
  codexHome: string;
  /** @deprecated Retained for callers from 0.2.8; bundled providers no longer inspect host Codex. */
  computerUseCodexHome?: string;
  platform: string;
  /** Compact discovery does not need to recursively enumerate asset directories. */
  includeLayout?: boolean;
}

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  invocation_policy?: SkillInvocationPolicy;
  user_invocable?: boolean;
  warnings?: string[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const SOURCE_PRIORITY: Record<ResolvedSkillSource, number> = {
  project: 4,
  installed: 3,
  external: 2,
  builtin: 1,
  "computer-use": 5,
  "browser-use": 5,
};

export function validateSkillId(value: string): string {
  if (typeof value !== "string" || value !== value.trim() || !ID_PATTERN.test(value)) {
    throw new Error("Skill id 必须匹配 ^[a-z0-9][a-z0-9._-]{0,63}$。");
  }
  if (value === "." || value === ".." || WINDOWS_RESERVED.test(value) || ["computer-use", "browser-use"].includes(value.toLowerCase())) {
    throw new Error(`保留的 Skill id 不可用: ${value}`);
  }
  if (/[ .]$/.test(value)) throw new Error("Skill id 不得以空格或句点结尾。");
  return value;
}

function indentation(line: string): number {
  const prefix = line.match(/^[ \t]*/)?.[0] ?? "";
  return prefix.replace(/\t/g, "  ").length;
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) && trimmed.length >= 2) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function withoutYamlComment(value: string): string {
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote === '"' && character === "\\") { index++; continue; }
    if (quote === "'" && character === "'" && value[index + 1] === "'") { index++; continue; }
    if (quote && character === quote) { quote = undefined; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    if (!quote && character === "#" && (index === 0 || /\s/.test(value[index - 1]))) return value.slice(0, index).trim();
  }
  return value.trim();
}

function mappingEntry(line: string): { indent: number; key: string; value: string } | undefined {
  const match = line.match(/^([ \t]*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9_.-]+|<<)[ \t]*:[ \t]*(.*)$/);
  return match ? { indent: indentation(line), key: scalar(match[2]), value: withoutYamlComment(match[3]) } : undefined;
}

function yamlBoolean(value: string): boolean | undefined {
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  return undefined;
}

function rootIndentation(lines: string[]): number {
  const relevant = lines.filter((line) => line.trim() && !line.trimStart().startsWith("#") && !/^(?:---|\.\.\.)\s*$/.test(line.trim()) && !line.trimStart().startsWith("%"));
  return relevant.length ? Math.min(...relevant.map(indentation)) : 0;
}

function indentedBlock(lines: string[], start: number, parentIndent: number): { lines: string[]; end: number } {
  const body: string[] = [];
  let end = start;
  for (let index = start + 1; index < lines.length; index++) {
    const candidate = lines[index];
    if (candidate.trim() && indentation(candidate) <= parentIndent) {
      if (!candidate.trimStart().startsWith("#")) break;
      end = index;
      continue;
    }
    body.push(candidate);
    end = index;
  }
  return { lines: body, end };
}

/** Parse the intentionally small frontmatter subset used by portable Skills. */
export function parseSkillFrontmatter(content: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) {
    return /^---[ \t]*\r?\n/.test(normalized)
      ? { invocation_policy: { allow_implicit: false, allow_explicit: true }, warnings: ["Unclosed Skill frontmatter; implicit invocation is disabled."] }
      : {};
  }
  const lines = match[1].split(/\r?\n/);
  const rootIndent = rootIndentation(lines);
  const result: ParsedFrontmatter = {};
  const policy: SkillInvocationPolicy = { allow_implicit: true, allow_explicit: true };
  const warnings: string[] = [];
  let sawPolicy = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const parsed = mappingEntry(line);
    // Nested metadata and literal-block text must never redefine root directives.
    if (!parsed) {
      if (indentation(line) === rootIndent) {
        sawPolicy = true;
        policy.allow_implicit = false;
        warnings.push("Unsupported Skill frontmatter syntax; implicit invocation is disabled.");
      }
      continue;
    }
    if (parsed.indent !== rootIndent) continue;
    const { key, value } = parsed;

    if (key === "metadata" && !value) {
      const block = indentedBlock(lines, index, rootIndent);
      const children = block.lines.filter((item) => item.trim() && !item.trimStart().startsWith("#"));
      const childIndent = children.length ? Math.min(...children.map(indentation)) : undefined;
      for (const child of children) {
        const item = mappingEntry(child);
        if (item && item.indent === childIndent && item.key === "version") {
          const version = scalar(item.value);
          if (version) result.version = version;
        }
      }
      index = block.end;
      continue;
    }
    if (key === "<<") {
      sawPolicy = true;
      policy.allow_implicit = false;
      warnings.push("Unsupported Skill frontmatter merge; implicit invocation is disabled.");
      continue;
    }
    if (key === "disable-model-invocation") {
      sawPolicy = true;
      const disabled = yamlBoolean(value);
      // Duplicate directives cannot undo an earlier denial; unsupported syntax fails closed.
      if (disabled !== false) policy.allow_implicit = false;
      if (disabled === undefined) warnings.push("Invalid disable-model-invocation boolean; implicit invocation is disabled.");
      continue;
    }
    if (key === "user-invocable") {
      const visible = yamlBoolean(value);
      result.user_invocable = result.user_invocable !== false && visible === true;
      if (visible === undefined) warnings.push("Invalid user-invocable boolean; the Skill is hidden from direct-command menus.");
      continue;
    }
    if (key !== "name" && key !== "description") continue;

    if (key === "description" && /^[>|][+-]?$/.test(value)) {
      const marker = value[0];
      const block = indentedBlock(lines, index, rootIndent);
      const body = block.lines.map((candidate) => candidate.trim());
      index = block.end;
      const nonEmpty = body.filter((item, position) => item || body.slice(position + 1).some(Boolean));
      result.description = marker === ">" ? nonEmpty.join(" ").trim() : nonEmpty.join("\n").trim();
    } else {
      const valueText = scalar(value);
      if (valueText) result[key] = valueText;
    }
  }
  if (sawPolicy) result.invocation_policy = policy;
  if (warnings.length) result.warnings = [...new Set(warnings)];
  return result;
}

/** Read-only policy subset: no aliases, merge keys, tags, or YAML code execution. */
export function parseCodexInvocationPolicy(content: string): { allow_implicit: boolean; warnings: string[] } {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const rootIndent = rootIndentation(lines);
  let allowImplicit = true;
  const warnings: string[] = [];
  const reject = (reason: string): void => {
    allowImplicit = false;
    warnings.push(reason);
  };
  const acceptBoolean = (value: string): void => {
    const allowed = yamlBoolean(value);
    if (allowed !== true) allowImplicit = false;
    if (allowed === undefined) reject("Invalid policy.allow_implicit_invocation boolean; implicit invocation is disabled.");
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith("#") || /^(?:---|\.\.\.)\s*$/.test(line.trim()) || line.trimStart().startsWith("%")) continue;
    const entry = mappingEntry(line);
    if (!entry) {
      if (indentation(line) === rootIndent) reject("Unsupported agents/openai.yaml root syntax; implicit invocation is disabled.");
      continue;
    }
    if (entry.indent !== rootIndent) continue;
    if (entry.key === "<<") {
      reject("Unsupported agents/openai.yaml root merge; implicit invocation is disabled.");
      continue;
    }
    if (entry.key !== "policy") continue;
    if (entry.value) {
      if (entry.value === "{}") continue;
      const inline = entry.value.match(/^\{\s*(?:["']?allow_implicit_invocation["']?)\s*:\s*(true|false)\s*,?\s*\}$/i);
      if (inline) acceptBoolean(inline[1]);
      else reject("Unsupported agents/openai.yaml policy syntax; implicit invocation is disabled.");
      continue;
    }
    const block = indentedBlock(lines, index, rootIndent);
    const children = block.lines.filter((line) => line.trim() && !line.trimStart().startsWith("#"));
    const childIndent = children.length ? Math.min(...children.map(indentation)) : undefined;
    for (const line of children) {
      const child = mappingEntry(line);
      if (!child) {
        if (indentation(line) === childIndent) reject("Unsupported agents/openai.yaml policy syntax; implicit invocation is disabled.");
        continue;
      }
      if (child.indent !== childIndent) continue;
      if (/^[ \t]*\t/.test(line) || child.key === "<<") {
        reject("Unsupported agents/openai.yaml policy indentation or merge; implicit invocation is disabled.");
      } else if (child.key === "allow_implicit_invocation") {
        acceptBoolean(child.value);
      }
    }
    index = block.end;
  }
  return { allow_implicit: allowImplicit, warnings: [...new Set(warnings)] };
}

/** Length-delimited raw bytes distinguish absent policy files from empty files. */
export function computeSkillContentHash(content: string | Buffer, policyContent?: string | Buffer): string {
  const body = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  const policy = typeof policyContent === "string" ? Buffer.from(policyContent, "utf8") : policyContent;
  const hash = createHash("sha256").update("web-harness-skill-v1\0").update(String(body.length)).update("\0").update(body);
  if (policy === undefined) hash.update("\0policy:absent");
  else hash.update("\0policy:present\0").update(String(policy.length)).update("\0").update(policy);
  return hash.digest("hex");
}

async function readFile(file: string): Promise<Buffer | undefined> {
  try { return await fs.readFile(file); } catch { return undefined; }
}

async function isDirectory(dir: string): Promise<boolean> {
  try { return (await fs.stat(dir)).isDirectory(); } catch { return false; }
}

async function hasFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function entries(dir: string): Promise<import("node:fs").Dirent[]> {
  try { return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
}

async function collectLayout(dir: string): Promise<SkillLayout> {
  const layout: SkillLayout = { references: [], workflows: [], scripts: [] };
  for (const bucket of ["references", "workflows", "scripts"] as const) {
    const root = path.join(dir, bucket);
    const visit = async (current: string): Promise<void> => {
      for (const entry of await entries(current)) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await visit(full);
        else if (entry.isFile()) layout[bucket].push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    if (await isDirectory(root)) await visit(root);
    layout[bucket] = [...new Set(layout[bucket])].sort((a, b) => a.localeCompare(b));
  }
  return layout;
}

async function findSkillFiles(root: string, maxDepth = 6): Promise<string[]> {
  const found: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory() || entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const candidate = path.join(full, "SKILL.md");
      if (await hasFile(candidate)) found.push(candidate);
      else await visit(full, depth + 1);
    }
  };
  if (await isDirectory(root)) {
    const direct = path.join(root, "SKILL.md");
    if (await hasFile(direct)) found.push(direct);
    else await visit(root, 0);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

function fallbackDescription(content: string, id: string): string {
  const normalized = content.replace(/^\uFEFF/, "");
  const marker = normalized.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/)?.[0] ?? "";
  const body = normalized.slice(marker.length).split(/\r?\n/).find((line) => line.trim() && !line.trimStart().startsWith("#"));
  return body?.trim() || id;
}

function aliasesFor(id: string, values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) continue;
    const alias = value.trim();
    if (alias.toLowerCase() === id.toLowerCase() || seen.has(alias.toLowerCase())) continue;
    seen.add(alias.toLowerCase());
    out.push(alias);
  }
  return out;
}

async function makeSkill(args: {
  id: string;
  source: ResolvedSkillSource;
  skillPath: string;
  enabled?: boolean;
  aliases?: unknown[];
  version?: string;
  installed_at?: string;
  warnings?: string[];
  error?: string;
  readFrontmatter?: boolean;
  includeLayout?: boolean;
}): Promise<ResolvedSkill> {
  const skillPath = args.skillPath ? path.resolve(args.skillPath) : "";
  const dir = skillPath ? path.dirname(skillPath) : "";
  let contentBytes: Buffer | undefined;
  if (skillPath && args.readFrontmatter !== false) {
    if (args.includeLayout === false) {
      try { contentBytes = await readIndexedSkillFile(skillPath); } catch {}
    } else contentBytes = await readFile(skillPath);
  }
  const content = contentBytes?.toString("utf8");
  const frontmatter = content ? parseSkillFrontmatter(content) : {};
  let policyBytes: Buffer | undefined;
  let policyReadFailed = false;
  if (contentBytes) {
    try {
      const file = path.join(dir, "agents", "openai.yaml");
      policyBytes = args.includeLayout === false ? await readIndexedSkillFile(file) : await fs.readFile(file);
    }
    catch (error) { policyReadFailed = (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  }
  const codexPolicy = policyBytes ? parseCodexInvocationPolicy(policyBytes.toString("utf8")) : undefined;
  const invocationPolicy: SkillInvocationPolicy = {
    allow_implicit: !policyReadFailed && frontmatter.invocation_policy?.allow_implicit !== false && codexPolicy?.allow_implicit !== false,
    allow_explicit: frontmatter.invocation_policy?.allow_explicit !== false,
  };
  const warnings = [...new Set([
    ...(args.warnings ?? []),
    ...(frontmatter.warnings ?? []),
    ...(codexPolicy?.warnings ?? []),
    ...(policyReadFailed ? ["agents/openai.yaml is unreadable; implicit invocation is disabled."] : []),
  ])];
  const id = args.id;
  const aliases = aliasesFor(id, [
    ...(args.aliases ?? []),
    frontmatter.name,
  ]);
  const providerDescription = args.source === "computer-use"
    ? "Control an explicitly selected Windows desktop or window through the bundled Harness provider"
    : args.source === "browser-use"
      ? "Control the bundled Browser Use runtime and managed Chrome for Testing"
      : undefined;
  const description = providerDescription || frontmatter.description || (content ? fallbackDescription(content, id) : id);
  const error = args.error || (!content ? "SKILL.md 不存在或不可读" : undefined);
  const layout = content && args.includeLayout !== false ? await collectLayout(dir) : { references: [], workflows: [], scripts: [] };
  const skill: ResolvedSkill = {
    id,
    name: id,
    aliases,
    description,
    path: skillPath,
    dir,
    source: args.source,
    enabled: args.enabled !== false,
    layout,
    invocation_policy: invocationPolicy,
    user_invocable: frontmatter.user_invocable !== false,
    ...(contentBytes && !policyReadFailed ? { content_sha256: computeSkillContentHash(contentBytes, policyBytes) } : {}),
    ...(frontmatter.version || args.version ? { version: args.version || frontmatter.version } : {}),
    ...(args.installed_at !== undefined ? { installed_at: args.installed_at } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(error ? { error } : {}),
  };
  return skill;
}

async function scanTree(root: string, source: "project" | "builtin", registryEntries: SkillResolverRegistryEntry[] = [], includeLayout = true): Promise<ResolvedSkill[]> {
  const found: ResolvedSkill[] = [];
  const registryById = new Map(registryEntries.filter((entry) => entry.source === source).map((entry) => [String(entry.id || "").toLowerCase(), entry]));
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    for (const entry of await entries(dir)) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const skillPath = path.join(full, "SKILL.md");
      if (await hasFile(skillPath)) {
        const registered = registryById.get(entry.name.toLowerCase());
        found.push(await makeSkill({
          id: entry.name,
          source,
          skillPath,
          enabled: registered?.enabled !== false,
          aliases: registered?.aliases,
          version: registered?.version,
          installed_at: registered?.installed_at,
          warnings: registered?.warnings,
          includeLayout,
        }));
      } else {
        await visit(full, depth + 1);
      }
    }
  };
  if (await isDirectory(root)) await visit(root, 0);
  return found;
}

async function scanInstalled(root: string, registryEntries: SkillResolverRegistryEntry[] = [], includeLayout = true): Promise<ResolvedSkill[]> {
  const found: ResolvedSkill[] = [];
  const registryById = new Map(registryEntries.filter((entry) => entry.source === "installed").map((entry) => [String(entry.id || "").toLowerCase(), entry]));
  for (const entry of await entries(root)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = path.join(root, entry.name);
    const direct = path.join(dir, "SKILL.md");
    const registered = registryById.get(entry.name.toLowerCase());
    if (await hasFile(direct)) {
      found.push(await makeSkill({
        id: entry.name,
        source: "installed",
        skillPath: direct,
        enabled: registered?.enabled !== false,
        aliases: registered?.aliases,
        version: registered?.version,
        installed_at: registered?.installed_at,
        warnings: registered?.warnings,
        includeLayout,
      }));
      continue;
    }
    const candidates = await findSkillFiles(dir);
    if (candidates.length === 1) {
      found.push(await makeSkill({
        id: entry.name,
        source: "installed",
        skillPath: candidates[0],
        enabled: registered?.enabled !== false,
        version: registered?.version,
        installed_at: registered?.installed_at,
        error: "package root not at top level",
        includeLayout,
      }));
    } else {
      found.push(await makeSkill({
        id: entry.name,
        source: "installed",
        skillPath: direct,
        enabled: registered?.enabled !== false,
        version: registered?.version,
        installed_at: registered?.installed_at,
        error: candidates.length > 1 ? "multiple SKILL.md files found" : "SKILL.md not found",
        includeLayout,
      }));
    }
  }
  return found;
}

async function scanExternal(entriesToScan: SkillResolverRegistryEntry[], includeLayout = true): Promise<ResolvedSkill[]> {
  const found: ResolvedSkill[] = [];
  for (const entry of entriesToScan) {
    if (entry.source !== "external") continue;
    const id = String(entry.id || entry.name || (entry.path ? path.basename(path.dirname(entry.path)) : "unknown-skill"));
    const skillPath = entry.path ? path.resolve(entry.path) : "";
    found.push(await makeSkill({
      id,
      source: "external",
      skillPath,
      enabled: entry.enabled !== false,
      aliases: [...(entry.aliases ?? []), entry.name],
      version: entry.version,
      installed_at: entry.installed_at,
      warnings: entry.warnings,
      error: entry.error || (!skillPath ? "external registration requires path" : undefined),
      includeLayout,
    }));
  }
  return found;
}

async function findBundledProviderSkill(input: {
  codeRoot: string;
  platform: string;
  id: "computer-use" | "browser-use";
}): Promise<string | undefined> {
  if (input.platform !== "win32") return undefined;
  const candidate = path.join(path.resolve(input.codeRoot), "bundled-plugins", input.id, "skills", input.id, "SKILL.md");
  return await hasFile(candidate) ? candidate : undefined;
}

export async function findComputerUseSkill(input: { codeRoot: string; platform: string }): Promise<string | undefined> {
  return findBundledProviderSkill({ ...input, id: "computer-use" });
}

export async function findBrowserUseSkill(input: { codeRoot: string; platform: string }): Promise<string | undefined> {
  return findBundledProviderSkill({ ...input, id: "browser-use" });
}

function applyShadowing(skills: ResolvedSkill[]): ResolvedSkill[] {
  const groups = new Map<string, ResolvedSkill[]>();
  for (const skill of skills) {
    const key = skill.id.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(skill);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const eligible = group.filter((skill) => skill.enabled && !skill.error);
    const winner = [...eligible].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))[0];
    for (const skill of group) {
      const reservedSource = skill.id.toLowerCase() === "computer-use"
        ? "computer-use"
        : skill.id.toLowerCase() === "browser-use" ? "browser-use" : undefined;
      if (reservedSource && skill.source !== reservedSource && group.some((item) => item.source === reservedSource && item.enabled && !item.error)) {
        skill.shadowedBy = reservedSource;
      } else if (winner && skill !== winner && skill.enabled && !skill.error) {
        skill.shadowedBy = winner.source;
      }
    }
  }
  return skills;
}

export async function resolveSkills(input: ResolveSkillsInput): Promise<ResolvedSkill[]> {
  const registryEntries = input.registry.skills ?? [];
  const includeLayout = input.includeLayout !== false;
  const project = await scanTree(path.join(path.resolve(input.workspaceRoot), ".claude", "skills"), "project", [], includeLayout);
  const installed = await scanInstalled(path.resolve(input.installedDir), registryEntries, includeLayout);
  const external = await scanExternal(input.registry.skills ?? [], includeLayout);
  const builtin = await scanTree(path.join(path.resolve(input.codeRoot), "skills"), "builtin", registryEntries, includeLayout);
  const all = [...project, ...installed, ...external, ...builtin];
  const computerPath = await findComputerUseSkill({
    codeRoot: input.codeRoot,
    platform: input.platform,
  });
  if (computerPath) {
    all.push(await makeSkill({
      id: "computer-use",
      source: "computer-use",
      skillPath: computerPath,
      enabled: input.registry.computer_use?.enabled === true,
      includeLayout,
    }));
  }
  const browserPath = await findBrowserUseSkill({
    codeRoot: input.codeRoot,
    platform: input.platform,
  });
  if (browserPath) {
    all.push(await makeSkill({
      id: "browser-use",
      source: "browser-use",
      skillPath: browserPath,
      enabled: input.registry.browser_use?.enabled === true,
      includeLayout,
    }));
  }
  return applyShadowing(all);
}

function selectable(skills: ResolvedSkill[]): ResolvedSkill[] {
  return skills.filter((skill) => skill.enabled && !skill.shadowedBy && !skill.error);
}

export function selectSkill(skills: ResolvedSkill[], requested: string, mode: SkillInvocationMode = "explicit"): ResolvedSkill {
  const value = requested.trim().toLowerCase();
  const available = selectable(skills);
  const exact = available.filter((skill) => skill.id.toLowerCase() === value);
  const candidates = exact.length
    ? exact
    : available.filter((skill) => skill.aliases.some((alias) => alias.toLowerCase() === value));
  const selected = [...candidates].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source] || a.id.localeCompare(b.id) || a.path.localeCompare(b.path))[0];
  if (!selected) {
    const names = available.flatMap((skill) => [skill.id, ...skill.aliases]).join(", ");
    throw new Error(`Unknown Skill: ${requested}. Available ids/aliases: ${names || "(none)"}`);
  }
  // Resolve precedence before enforcing policy. Filtering first could silently
  // fall back to a lower-priority copy and bypass the intended Skill's denial.
  const allowed = mode === "implicit" ? selected.invocation_policy?.allow_implicit : selected.invocation_policy?.allow_explicit;
  if (allowed === false) throw new Error(`Skill ${selected.id} does not allow ${mode} invocation.`);
  return selected;
}

export function resolvedVia(skill: ResolvedSkill, requested: string): "id" | "alias" {
  return skill.id.toLowerCase() === requested.trim().toLowerCase() ? "id" : "alias";
}
