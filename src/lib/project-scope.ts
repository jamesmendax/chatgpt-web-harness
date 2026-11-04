import fs from "node:fs/promises";
import path from "node:path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
];

function normalizePath(value: string): string {
  return path.resolve(value);
}

function pathKey(value: string): string {
  const resolved = normalizePath(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  // win32 path.relative is case-sensitive; tool arguments rarely match the
  // project root's exact casing, so fold case before comparing on Windows.
  const fold = (value: string) => {
    const normalized = normalizePath(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const relative = path.relative(fold(root), fold(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isPathWithinRoots(candidate: string, roots: string[]): boolean {
  return roots.some((root) => isPathWithinRoot(candidate, root));
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

async function candidateDirectory(value: string): Promise<string | null> {
  if (!path.isAbsolute(value)) return null;
  let resolved = normalizePath(value);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isFile()) resolved = path.dirname(resolved);
  } catch {
    resolved = path.extname(resolved) ? path.dirname(resolved) : resolved;
  }
  return resolved;
}

export async function detectProjectRoot(candidate: string, fallback?: string): Promise<string | null> {
  let current = await candidateDirectory(candidate);
  if (!current) return fallback ? normalizePath(fallback) : null;
  const floor = path.parse(current).root;
  while (true) {
    for (const marker of PROJECT_MARKERS) {
      if (await pathExists(path.join(current, marker))) return current;
    }
    if (current === floor) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fallback ? normalizePath(fallback) : await candidateDirectory(candidate);
}

function trimCandidate(value: string): string {
  return value.replace(/[),.;:]+$/g, "").trim();
}

export function extractAbsolutePathsFromText(text: string): string[] {
  const found: string[] = [];
  const quoted = [...text.matchAll(/[`"']([A-Za-z]:\\[^`"']+|\/[^`"']+)[`"']/g)].map((match) => match[1]);
  const windows = text.match(/[A-Za-z]:\\[^\s,;，。；)\]}]+/g) ?? [];
  const posix = [...text.matchAll(/(?:^|[\s(])((?:\/[^\s,;，。；)\]}]+)+)/gm)].map((match) => match[1]);
  for (const raw of [...quoted, ...windows, ...posix]) {
    const cleaned = trimCandidate(raw.trim());
    if (path.isAbsolute(cleaned)) found.push(normalizePath(cleaned));
  }
  return [...new Map(found.map((item) => [pathKey(item), item])).values()];
}

export async function inferProjectScope(
  workspaceRoot: string,
  texts: Array<string | undefined | null>
): Promise<{ roots: string[]; locked: boolean; source: "explicit" | "workspace" }> {
  const candidates = texts.flatMap((text) => text ? extractAbsolutePathsFromText(text) : []);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const detected = await detectProjectRoot(candidate);
    if (!detected) continue;
    const key = pathKey(detected);
    if (seen.has(key)) continue;
    roots.push(detected);
    seen.add(key);
  }
  if (roots.length) return { roots: roots.slice(0, 8), locked: true, source: "explicit" };
  return { roots: [normalizePath(workspaceRoot)], locked: false, source: "workspace" };
}

export async function inferProjectRootsFromPaths(paths: string[], fallback: string): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    if (!path.isAbsolute(candidate)) continue;
    const detected = await detectProjectRoot(candidate, fallback);
    if (!detected) continue;
    const key = pathKey(detected);
    if (seen.has(key)) continue;
    roots.push(detected);
    seen.add(key);
  }
  return roots.slice(0, 8);
}
