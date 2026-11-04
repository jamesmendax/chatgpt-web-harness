import fs from "fs/promises";
import path from "path";

const DIRECTORY_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;
const MAX_RULE_CHARS = 4_000;
const MAX_TOTAL_RULE_CHARS = 16_000;

export interface ApplicablePathRule {
  path: string;
  content: string;
  kind: "directory_instruction" | "path_rule";
  scope: string;
  depth: number;
}

function parseFrontmatter(content: string): { paths?: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const pathsLine = match[1].match(/^paths:\s*\n((?:\s+-\s*.+\n?)+)/m);
  if (!pathsLine) return {};
  const paths = [...pathsLine[1].matchAll(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1].trim());
  return { paths };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(",").map((s: string) => s.trim()).join("|")})`)
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(filePath: string, relativeFilePath: string, patterns: string[]): boolean {
  const absolute = filePath.replace(/\\/g, "/");
  const relative = relativeFilePath.replace(/\\/g, "/");
  return patterns.some((pattern) => {
    const regex = globToRegex(pattern.replace(/\\/g, "/"));
    return regex.test(relative) || regex.test(absolute) || regex.test(path.basename(relative));
  });
}

async function listRuleFiles(rulesDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  }
  await walk(rulesDir, 0);
  return found;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findScopeRoot(workspaceRoot: string, filePath: string): Promise<string> {
  const workspace = path.resolve(workspaceRoot);
  const target = path.resolve(filePath);
  if (isWithin(workspace, target)) return workspace;

  const start = path.dirname(target);
  let current = start;
  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

function directoriesFromRoot(root: string, targetDirectory: string): string[] {
  const relative = path.relative(root, targetDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [targetDirectory];
  const directories = [root];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

async function readRuleBody(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
    return body ? body.slice(0, MAX_RULE_CHARS) : null;
  } catch {
    return null;
  }
}

export async function loadPathRulesForFile(
  workspaceRoot: string,
  filePath: string
): Promise<ApplicablePathRule[]> {
  const target = path.resolve(filePath);
  const scopeRoot = await findScopeRoot(workspaceRoot, target);
  const targetDirectory = path.dirname(target);
  const matched: ApplicablePathRule[] = [];
  let totalChars = 0;

  const addRule = (rule: ApplicablePathRule): void => {
    if (totalChars >= MAX_TOTAL_RULE_CHARS) return;
    const remaining = MAX_TOTAL_RULE_CHARS - totalChars;
    const content = rule.content.slice(0, remaining);
    if (!content) return;
    matched.push({ ...rule, content });
    totalChars += content.length;
  };

  const directories = directoriesFromRoot(scopeRoot, targetDirectory);
  for (let depth = 0; depth < directories.length; depth++) {
    for (const fileName of DIRECTORY_INSTRUCTION_FILES) {
      const instructionPath = path.join(directories[depth], fileName);
      const content = await readRuleBody(instructionPath);
      if (!content) continue;
      addRule({
        path: instructionPath,
        content,
        kind: "directory_instruction",
        scope: directories[depth],
        depth,
      });
    }
  }

  const rulesDir = path.join(scopeRoot, ".claude", "rules");
  const relativeTarget = path.relative(scopeRoot, target);

  for (const ruleFile of await listRuleFiles(rulesDir)) {
    try {
      const raw = await fs.readFile(ruleFile, "utf-8");
      const fm = parseFrontmatter(raw);
      if (!fm.paths?.length) continue;
      if (!matchesAny(target, relativeTarget, fm.paths)) continue;
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (body) {
        addRule({
          path: ruleFile,
          content: body.slice(0, MAX_RULE_CHARS),
          kind: "path_rule",
          scope: scopeRoot,
          depth: directories.length,
        });
      }
    } catch {}
  }

  return matched;
}