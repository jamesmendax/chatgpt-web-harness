import fs from "fs/promises";
import path from "path";

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let regex = "";

  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index++;
      if (normalized[index + 1] === "/") {
        // `**/` matches zero or more complete path segments, so patterns such
        // as `**/*.ts` also include files at the search root.
        index++;
        regex += "(?:.*/)?";
      } else {
        regex += ".*";
      }
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${regex}$`, "i");
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === "build";
}

export async function globFiles(
  rootDir: string,
  pattern: string,
  maxResults: number
): Promise<Array<{ path: string; mtimeMs: number }>> {
  if (!Number.isFinite(maxResults) || maxResults <= 0) return [];
  const resultLimit = Math.floor(maxResults);
  if (resultLimit <= 0) return [];
  const matcher = globToRegExp(pattern.replace(/\\/g, "/"));
  const matches: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= resultLimit) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= resultLimit) return;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(fullPath);
        continue;
      }

      if (!matcher.test(rel) && !matcher.test(entry.name)) continue;

      try {
        const stat = await fs.stat(fullPath);
        matches.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }

  await walk(rootDir);
  matches.sort((left, right) => {
    const byMtime = right.mtimeMs - left.mtimeMs;
    return byMtime !== 0 ? byMtime : left.path.localeCompare(right.path);
  });
  return matches;
}
