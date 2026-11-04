import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { validateSkillId } from "./skill-resolver.js";

export type SkillSource = "project" | "installed" | "external" | "builtin" | "computer-use" | "browser-use";

export interface PluginSkillEntry {
  id: string;
  source: Exclude<SkillSource, "project" | "computer-use" | "browser-use">;
  aliases?: string[];
  path?: string;
  enabled?: boolean;
  installed_at?: string;
  version?: string;
  origin?: string;
  warnings?: string[];
  error?: string;
}

export interface LocalPluginsConfig {
  schema_version: 2;
  computer_use: { enabled: boolean };
  browser_use: { enabled: boolean };
  skills: PluginSkillEntry[];
}

const EMPTY_REGISTRY: LocalPluginsConfig = {
  schema_version: 2,
  computer_use: { enabled: false },
  browser_use: { enabled: false },
  skills: [],
};

export function getLocalPluginsConfigPath(): string {
  return process.env.CHATGPT_PLUGINS_CONFIG
    ? path.resolve(process.env.CHATGPT_PLUGINS_CONFIG)
    : path.resolve(process.cwd(), "profiles", "plugins.json");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: unknown[], exclude?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = asString(value);
    if (!text || (exclude && text.toLowerCase() === exclude.toLowerCase())) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function sourceOf(value: unknown): PluginSkillEntry["source"] {
  return value === "installed" || value === "builtin" || value === "external" ? value : "external";
}

function idFromRaw(raw: Record<string, unknown>): string {
  const explicit = asString(raw.id);
  if (explicit) return explicit;
  const skillPath = asString(raw.path);
  if (skillPath) return path.basename(path.dirname(skillPath));
  const legacyName = asString(raw.name);
  if (legacyName) return legacyName;
  return "unknown-skill";
}

function normalizeEntry(value: unknown): PluginSkillEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const candidateId = idFromRaw(raw).trim().toLowerCase();
  let id: string;
  try { id = validateSkillId(candidateId); } catch { return undefined; }
  const source = sourceOf(raw.source);
  const entry: PluginSkillEntry = { id, source, enabled: raw.enabled !== false };
  const aliases = uniqueStrings([
    ...(Array.isArray(raw.aliases) ? raw.aliases : []),
    raw.name,
  ], id);
  if (aliases.length) entry.aliases = aliases;
  const skillPath = asString(raw.path);
  if (skillPath) {
    entry.path = path.resolve(skillPath);
    if (source === "external" && !path.isAbsolute(skillPath)) entry.error = "external 注册路径必须是绝对路径";
  }
  for (const key of ["installed_at", "version", "origin", "error"] as const) {
    const text = asString(raw[key]);
    if (text) entry[key] = text;
  }
  if (Array.isArray(raw.warnings)) {
    const warnings = uniqueStrings(raw.warnings).slice(0, 32);
    if (warnings.length) entry.warnings = warnings;
  }
  return entry;
}

/** Normalize both legacy v1 {name,path,enabled} and registry v2 entries. */
export function normalizeRegistry(input: unknown): LocalPluginsConfig {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const rawComputerUse = raw.computer_use && typeof raw.computer_use === "object"
    ? raw.computer_use as Record<string, unknown>
    : {};
  const rawBrowserUse = raw.browser_use && typeof raw.browser_use === "object"
    ? raw.browser_use as Record<string, unknown>
    : {};
  const rawSkills = Array.isArray(raw.skills) ? raw.skills : [];
  const skills = rawSkills.map(normalizeEntry).filter((entry): entry is PluginSkillEntry => Boolean(entry));
  return {
    schema_version: 2,
    computer_use: { enabled: rawComputerUse.enabled === true },
    browser_use: { enabled: rawBrowserUse.enabled === true },
    skills,
  };
}

export function readLocalPluginsConfig(file = getLocalPluginsConfigPath()): LocalPluginsConfig {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("配置必须是 JSON 对象");
    return normalizeRegistry(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Skill 配置读取失败，原文件已保留 (${path.resolve(file)}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return {
      ...EMPTY_REGISTRY,
      computer_use: { ...EMPTY_REGISTRY.computer_use },
      browser_use: { ...EMPTY_REGISTRY.browser_use },
      skills: [],
    };
  }
}

interface AtomicFsOps {
  mkdirSync: typeof fs.mkdirSync;
  writeFileSync: typeof fs.writeFileSync;
  existsSync: typeof fs.existsSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
}

const defaultAtomicFsOps: AtomicFsOps = {
  mkdirSync: fs.mkdirSync,
  writeFileSync: fs.writeFileSync,
  existsSync: fs.existsSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
};

/**
 * Publish a JSON registry without deleting the previous version first.
 * POSIX keeps the direct same-directory rename path; Windows fallback moves
 * the old file to a same-directory backup and restores it if publication
 * fails.  A cleanup failure leaves the backup (safe, recoverable) while the
 * new registry remains the committed state.
 */
export function atomicWriteJsonAt(file: string, value: unknown, customOps?: Partial<AtomicFsOps>): void {
  const io = { ...defaultAtomicFsOps, ...(customOps ?? {}) } as AtomicFsOps;
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.${process.pid}.${Date.now()}.bak`;
  let movedOld = false;
  let published = false;
  try {
    io.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
    try {
      io.renameSync(tmp, file);
      published = true;
    } catch (error) {
      if (!(error && typeof error === "object" && ["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code || ""))) throw error;
      if (!io.existsSync(file)) throw error;
      io.renameSync(file, backup);
      movedOld = true;
      try {
        io.renameSync(tmp, file);
        published = true;
      } catch (publishError) {
        try {
          io.renameSync(backup, file);
          movedOld = false;
        } catch (restoreError) {
          throw new Error(`注册表发布失败且旧文件恢复失败；旧文件备份保留于 ${backup}: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
        }
        throw publishError;
      }
    }
    if (published && movedOld) {
      try { io.rmSync(backup, { force: true }); } catch { /* retain recoverable backup */ }
    }
  } finally {
    try { io.rmSync(tmp, { force: true }); } catch {}
  }
}

export function saveLocalPluginsConfigAt(file: string, next: unknown): LocalPluginsConfig {
  readLocalPluginsConfig(file); // A damaged existing registry must never become an empty replacement.
  const normalized = normalizeRegistry(next);
  atomicWriteJsonAt(path.resolve(file), normalized);
  return normalized;
}

export function getLocalPluginsConfig(): LocalPluginsConfig {
  return readLocalPluginsConfig();
}

export function saveLocalPluginsConfig(next: LocalPluginsConfig): void {
  saveLocalPluginsConfigAt(getLocalPluginsConfigPath(), next);
}

/** All registry rows, including disabled/missing rows, for resolver/catalog use. */
export function getRegistryEntries(): PluginSkillEntry[] {
  return getLocalPluginsConfig().skills;
}

/** Legacy compatibility: enabled rows with a non-empty path. */
export function getRegisteredSkills(): PluginSkillEntry[] {
  return getRegistryEntries().filter((skill) => skill.enabled !== false && typeof skill.path === "string" && skill.path.trim());
}

export function isComputerUseEnabled(): boolean {
  return process.platform === "win32" && getLocalPluginsConfig().computer_use.enabled === true;
}

export function isBrowserUseEnabled(): boolean {
  return process.platform === "win32" && getLocalPluginsConfig().browser_use.enabled === true;
}

function bundledSkillPath(id: "computer-use" | "browser-use"): string {
  const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(codeRoot, "bundled-plugins", id, "skills", id, "SKILL.md");
}

export async function resolveComputerUseSkillPath(): Promise<string | undefined> {
  if (!isComputerUseEnabled()) return undefined;
  const candidate = bundledSkillPath("computer-use");
  return fs.existsSync(candidate) ? candidate : undefined;
}

export async function resolveBrowserUseSkillPath(): Promise<string | undefined> {
  if (!isBrowserUseEnabled()) return undefined;
  const candidate = bundledSkillPath("browser-use");
  return fs.existsSync(candidate) ? candidate : undefined;
}

export { EMPTY_REGISTRY };
