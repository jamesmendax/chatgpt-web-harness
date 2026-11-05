import fs from "node:fs/promises";
import path from "node:path";
import type { ResolvedSkill } from "./skill-resolver.js";

const fileCache = new Map<string, { stamp: string; bytes: Buffer }>();
let cachedBytes = 0;
async function stamp(file: string): Promise<string> {
  try {
    const value = await fs.stat(file);
    return `${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}
/** Discovery reads changed files only; instruction loading bypasses this cache. */
export async function readIndexedSkillFile(file: string): Promise<Buffer> {
  let bytes: Buffer | undefined;
  let signature = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    signature = await stamp(file);
    const previous = fileCache.get(file);
    if (previous?.stamp === signature) return previous.bytes;
    const candidate = await fs.readFile(file);
    if (signature === await stamp(file)) { bytes = candidate; break; }
  }
  if (!bytes) throw new Error(`Skill file changed repeatedly while reading: ${file}`);
  const replaced = fileCache.get(file);
  if (replaced) cachedBytes -= replaced.bytes.length;
  fileCache.delete(file);
  fileCache.set(file, { stamp: signature, bytes });
  cachedBytes += bytes.length;
  while (fileCache.size > 512 || cachedBytes > 32 * 1024 * 1024) {
    const oldest = fileCache.keys().next().value!;
    cachedBytes -= fileCache.get(oldest)!.bytes.length;
    fileCache.delete(oldest);
  }
  return bytes;
}

interface Index { paths: string[]; signature: string; skills: ResolvedSkill[] }
const indexes = new Map<string, Promise<Index>>();
async function signature(paths: string[]): Promise<string> {
  return JSON.stringify(await Promise.all(paths.map(stamp)));
}
async function watchPaths(roots: string[], skills: ResolvedSkill[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const root of roots) paths.add(path.join(root, "anthropic-official-skills", "children.json"));
  const addSkill = (file: string) => {
    paths.add(file);
    paths.add(path.dirname(file));
    paths.add(path.join(path.dirname(file), "agents", "openai.yaml"));
  };
  async function visit(dir: string, depth: number): Promise<void> {
    paths.add(dir);
    if (depth > 4) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (entries.some(entry => entry.isFile() && entry.name === "SKILL.md")) { addSkill(path.join(dir, "SKILL.md")); return; }
    for (const entry of entries) if (entry.isDirectory()) await visit(path.join(dir, entry.name), depth + 1);
  }
  for (const root of roots) await visit(root, 0);
  for (const skill of skills) if (skill.path) addSkill(skill.path);
  return [...paths].sort();
}

/** Directory/file stamps invalidate the index; unchanged calls never reread bodies. */
export async function indexedSkills(key: string, roots: string[], load: () => Promise<ResolvedSkill[]>): Promise<ResolvedSkill[]> {
  const existing = indexes.get(key);
  if (existing) {
    const previous = await existing;
    if (previous.signature === await signature(previous.paths)) return structuredClone(previous.skills);
  }
  const pending = (async () => {
    // Discovery and all data read by load must belong to one observed snapshot.
    // Newly returned paths are included in the next attempt's initial snapshot.
    let extraPaths: string[] = existing ? (await existing).paths : [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const beforePaths = [...new Set([...(await watchPaths(roots, [])), ...extraPaths])].sort();
      const before = await signature(beforePaths);
      const skills = await load();
      const afterPaths = [...new Set([...(await watchPaths(roots, skills)), ...extraPaths])].sort();
      const after = await signature(afterPaths);
      if (JSON.stringify(beforePaths) === JSON.stringify(afterPaths) && before === after) {
        return { skills, paths: afterPaths, signature: after };
      }
      extraPaths = afterPaths;
    }
    throw new Error("Skill index changed repeatedly while loading");
  })();
  indexes.delete(key);
  indexes.set(key, pending);
  while (indexes.size > 32) indexes.delete(indexes.keys().next().value!);
  try { return structuredClone((await pending).skills); }
  catch (error) { if (indexes.get(key) === pending) indexes.delete(key); throw error; }
}
