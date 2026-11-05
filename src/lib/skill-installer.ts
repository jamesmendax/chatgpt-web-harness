import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  normalizeRegistry,
  readLocalPluginsConfig,
  saveLocalPluginsConfigAt,
  type LocalPluginsConfig,
  type PluginSkillEntry,
} from "./plugin-config.js";
import { parseSkillFrontmatter, validateSkillId } from "./skill-resolver.js";

export interface SkillFsOps {
  existsSync: typeof fs.existsSync;
  mkdirSync: typeof fs.mkdirSync;
  readdirSync: typeof fs.readdirSync;
  lstatSync: typeof fs.lstatSync;
  realpathSync: typeof fs.realpathSync;
  readFileSync: typeof fs.readFileSync;
  copyFileSync: typeof fs.copyFileSync;
  renameSync: typeof fs.renameSync;
  rmSync: typeof fs.rmSync;
}

const defaultFsOps: SkillFsOps = {
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  readdirSync: fs.readdirSync,
  lstatSync: fs.lstatSync,
  realpathSync: fs.realpathSync,
  readFileSync: fs.readFileSync,
  copyFileSync: fs.copyFileSync,
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
};

export class SkillInstallerError extends Error {
  readonly status: number;
  readonly candidates?: string[];

  constructor(message: string, status = 400, candidates?: string[]) {
    super(message);
    this.name = "SkillInstallerError";
    this.status = status;
    this.candidates = candidates;
  }
}

export interface LocatePackageResult {
  root: string;
  skillPath: string;
}

export interface DependencyCheckResult {
  warnings: string[];
}

export interface InstallSkillOptions {
  source: string;
  id?: string;
  localSkillsDir: string;
  registryPath: string;
  overwrite?: boolean;
  fsOps?: Partial<SkillFsOps>;
}

export interface InstalledSkillResult {
  ok: true;
  id: string;
  source: "installed";
  dir: string;
  path: string;
  aliases: string[];
  version?: string;
  warnings: string[];
}

export interface UninstallSkillOptions {
  id: string;
  localSkillsDir: string;
  registryPath: string;
  codeRoot?: string;
  workspaceRoot?: string;
  fsOps?: Partial<SkillFsOps>;
}

export interface SetSkillEnabledOptions extends UninstallSkillOptions {
  enabled: boolean;
  source?: "installed" | "external" | "builtin";
}

function opsFor(value?: Partial<SkillFsOps>): SkillFsOps {
  return { ...defaultFsOps, ...(value ?? {}) } as SkillFsOps;
}

function randomSuffix(): string {
  return randomBytes(8).toString("hex");
}

function inside(parent: string, target: string): boolean {
  const base = path.resolve(parent);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function childDirectory(root: string, id: string, fileOps: SkillFsOps): string | undefined {
  if (!fileOps.existsSync(root)) return undefined;
  for (const entry of fileOps.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.toLowerCase() !== id.toLowerCase()) continue;
    const candidate = path.join(root, entry.name);
    let stat: fs.Stats;
    try { stat = fileOps.lstatSync(candidate); } catch { continue; }
    if (stat.isSymbolicLink()) {
      throw new SkillInstallerError(`安装目录包含不支持的符号链接或 junction: ${entry.name}`, 400);
    }
    if (!stat.isDirectory()) continue;
    return candidate;
  }
  return undefined;
}

function realPath(file: string, fileOps: SkillFsOps): string {
  try { return path.resolve(fileOps.realpathSync(file)); }
  catch { throw new SkillInstallerError(`无法解析安装路径的真实路径: ${file}`, 400); }
}

function assertRealPathInside(rootReal: string, candidate: string, fileOps: SkillFsOps, label: string): string {
  const candidateReal = realPath(candidate, fileOps);
  if (!inside(rootReal, candidateReal)) {
    throw new SkillInstallerError(`${label}真实路径逃逸安装包根目录: ${candidate}`, 400);
  }
  return candidateReal;
}

function assertDirectoryRoot(dir: string, fileOps: SkillFsOps, label: string): string {
  let stat: fs.Stats;
  try { stat = fileOps.lstatSync(dir); }
  catch { throw new SkillInstallerError(`${label}不存在: ${dir}`, 400); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SkillInstallerError(`${label}必须是普通目录，不能是符号链接或 junction: ${dir}`, 400);
  }
  // A normal final directory can still be reached through a junction in one
  // of its parents.  Walk the existing ancestor chain before any rename or
  // copy so installer writes cannot escape the caller's intended tree.
  let current = path.resolve(dir);
  const root = path.parse(current).root;
  while (current && current !== root) {
    let ancestor: fs.Stats;
    try { ancestor = fileOps.lstatSync(current); } catch { break; }
    if (ancestor.isSymbolicLink()) throw new SkillInstallerError(`${label}路径祖先不能是符号链接或 junction: ${current}`, 400);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realPath(dir, fileOps);
}

function readText(file: string, fileOps: SkillFsOps): string {
  try { return fileOps.readFileSync(file, "utf8") as string; } catch { return ""; }
}

/** Find the unique directory that owns SKILL.md without following symlinks. */
export function locatePackageRoot(source: string, fsOps?: Partial<SkillFsOps>): LocatePackageResult {
  const fileOps = opsFor(fsOps);
  if (!path.isAbsolute(source)) throw new SkillInstallerError("安装 source 必须是绝对路径。", 400);
  const root = path.resolve(source);
  let rootStat: fs.Stats;
  try { rootStat = fileOps.lstatSync(root); } catch { throw new SkillInstallerError(`找不到安装 source: ${root}`, 400); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new SkillInstallerError("安装 source 必须是普通目录，不能是符号链接或 junction。", 400);
  const rootReal = realPath(root, fileOps);

  const candidates: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > 8) return;
    const dirStat = fileOps.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;
    assertRealPathInside(rootReal, dir, fileOps, "安装包目录");
    const direct = path.join(dir, "SKILL.md");
    try {
      const directStat = fileOps.lstatSync(direct);
      if (directStat.isSymbolicLink()) {
        throw new SkillInstallerError(`安装包含不支持的符号链接或 junction: ${path.relative(root, direct)}`, 400);
      }
      if (directStat.isFile()) {
        assertRealPathInside(rootReal, direct, fileOps, "SKILL.md");
        candidates.push(direct);
      }
    } catch (error) {
      if (error instanceof SkillInstallerError) throw error;
    }
    let entries: fs.Dirent[];
    try { entries = [...fileOps.readdirSync(dir, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = path.join(dir, entry.name);
      let childStat: fs.Stats;
      try { childStat = fileOps.lstatSync(child); } catch { continue; }
      if (childStat.isSymbolicLink()) {
        throw new SkillInstallerError(`安装包含不支持的符号链接或 junction: ${path.relative(root, child)}`, 400);
      }
      if (childStat.isDirectory()) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  const unique = [...new Set(candidates.map((file) => path.resolve(file)))];
  if (unique.length === 0) throw new SkillInstallerError("安装 source 中找不到 SKILL.md。", 400);
  if (unique.length > 1) {
    throw new SkillInstallerError("安装 source 中有多个 SKILL.md，请指定唯一包目录。", 409, unique.map((file) => path.dirname(file)));
  }
  return { root: path.dirname(unique[0]), skillPath: unique[0] };
}

function commandAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 4000,
    shell: false,
  });
  return result.status === 0;
}

/** Dependency checks are interpreter/version probes only; package scripts never run. */
export function checkDependencies(packageRoot: string): DependencyCheckResult {
  const warnings: string[] = [];
  let python: string | undefined;
  for (const candidate of process.platform === "win32" ? ["python", "python3"] : ["python3", "python"]) {
    if (commandAvailable(candidate, ["--version"])) { python = candidate; break; }
  }
  const requirements = path.join(packageRoot, "requirements.txt");
  if (fs.existsSync(requirements)) {
    if (!python) warnings.push("缺少 Python（requirements.txt）");
    else {
      const firstPackage = fs.readFileSync(requirements, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim().split(/[<>=!~]/)[0])
        .find((line) => /^[A-Za-z][A-Za-z0-9_.-]*$/.test(line) && !line.startsWith("#"));
      const importName = firstPackage ? ({ "python-pptx": "pptx" } as Record<string, string>)[firstPackage.toLowerCase()] || firstPackage.replace(/-/g, "_") : undefined;
      if (importName && !commandAvailable(python, ["-c", `import ${importName}`])) warnings.push(`缺少 Python 依赖: ${importName}`);
    }
  }
  if (fs.existsSync(path.join(packageRoot, "package.json")) || fs.existsSync(path.join(packageRoot, "bin"))) {
    if (!commandAvailable("node", ["--version"])) warnings.push("缺少 Node.js；桌面端将尝试提供内置 Node shim");
  }
  return { warnings };
}

export function deriveSkillId(packageRoot: string, sourceRoot: string, skillText: string): string {
  const frontmatter = parseSkillFrontmatter(skillText);
  let base = path.basename(packageRoot === sourceRoot ? sourceRoot : packageRoot);
  if (frontmatter.name && base !== frontmatter.name) {
    base = base.replace(/-(?:main|master|v\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.]+)?)$/i, "");
  }
  return base;
}

export interface SkillPackageInspection {
  root: string;
  skillPath: string;
  id: string;
  aliases: string[];
  version?: string;
  description: string;
  warnings: string[];
}

/** Inspect exactly the package that installSkill would copy. */
export function inspectSkillPackage(source: string, fsOps?: Partial<SkillFsOps>): SkillPackageInspection {
  const fileOps = opsFor(fsOps);
  const sourceRoot = path.resolve(source);
  const located = locatePackageRoot(sourceRoot, fileOps);
  const skillText = readText(located.skillPath, fileOps);
  if (!skillText) throw new SkillInstallerError(`无法读取 SKILL.md: ${located.skillPath}`, 400);
  const frontmatter = parseSkillFrontmatter(skillText);
  const id = deriveSkillId(located.root, sourceRoot, skillText);
  validateSkillId(id);
  const warnings = checkDependencies(located.root).warnings;
  return {
    ...located,
    id,
    aliases: frontmatter.name && frontmatter.name.toLowerCase() !== id.toLowerCase() ? [frontmatter.name] : [],
    ...(frontmatter.version ? { version: frontmatter.version } : {}),
    description: frontmatter.description || "",
    warnings,
  };
}

function copyTree(source: string, target: string, fileOps: SkillFsOps, sourceRootReal: string): void {
  const sourceStat = fileOps.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new SkillInstallerError(`安装源包含不支持的符号链接或非目录: ${source}`, 400);
  }
  assertRealPathInside(sourceRootReal, source, fileOps, "安装源");
  fileOps.mkdirSync(target, { recursive: true });
  let entries: fs.Dirent[];
  try { entries = [...fileOps.readdirSync(source, { withFileTypes: true })].sort((a, b) => a.name.localeCompare(b.name)); } catch (error) { throw error; }
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name.toLowerCase().endsWith(".zip")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    let stat: fs.Stats;
    try { stat = fileOps.lstatSync(from); } catch (error) { throw error; }
    if (stat.isSymbolicLink()) {
      throw new SkillInstallerError(`安装包含不支持的符号链接或 junction: ${entry.name}`, 400);
    }
    if (stat.isDirectory()) {
      copyTree(from, to, fileOps, sourceRootReal);
    } else if (stat.isFile()) {
      assertRealPathInside(sourceRootReal, from, fileOps, "安装文件");
      fileOps.copyFileSync(from, to);
    } else {
      throw new SkillInstallerError(`安装源包含不支持的文件类型: ${entry.name}`, 400);
    }
  }
}

function registry(file: string): LocalPluginsConfig {
  return readLocalPluginsConfig(path.resolve(file));
}

function replaceInstalledRow(config: LocalPluginsConfig, row: PluginSkillEntry): LocalPluginsConfig {
  const rows = config.skills.filter((item) => !(item.id.toLowerCase() === row.id.toLowerCase() && item.source === "installed"));
  return { ...config, skills: [...rows, row] };
}

export async function installSkill(options: InstallSkillOptions): Promise<InstalledSkillResult> {
  const fileOps = opsFor(options.fsOps);
  const source = path.resolve(options.source);
  const localSkillsDir = path.resolve(options.localSkillsDir);
  const registryPath = path.resolve(options.registryPath);
  const previousRegistry = registry(registryPath); // Validate before copying or replacing installed files.
  if (!path.isAbsolute(options.source)) throw new SkillInstallerError("安装 source 必须是绝对路径。", 400);
  if (inside(localSkillsDir, source) && !/^\.staging-extract-/i.test(path.basename(source))) {
    throw new SkillInstallerError("不能把 local-skills 内的包安装到自身。", 400);
  }
  const located = locatePackageRoot(source, fileOps);
  fileOps.mkdirSync(localSkillsDir, { recursive: true });
  assertDirectoryRoot(localSkillsDir, fileOps, "local-skills");
  const skillText = readText(located.skillPath, fileOps);
  const frontmatter = parseSkillFrontmatter(skillText);
  const rawId = options.id?.trim() || deriveSkillId(located.root, source, skillText);
  validateSkillId(rawId);
  const id = rawId;
  const target = path.join(localSkillsDir, id);
  const oldTarget = childDirectory(localSkillsDir, id, fileOps);
  if (oldTarget && options.overwrite === false) throw new SkillInstallerError(`Skill 已存在: ${id}`, 409);

  const dependency = checkDependencies(located.root);
  const staging = path.join(localSkillsDir, `.staging-${id}-${randomSuffix()}`);
  const backup = oldTarget ? path.join(localSkillsDir, `.backup-${id}-${randomSuffix()}`) : undefined;
  let movedOld = false;
  let movedNew = false;
  let registrySaved = false;
  const warnings = [...dependency.warnings];
  try {
    copyTree(located.root, staging, fileOps, realPath(located.root, fileOps));
    if (oldTarget && backup) {
      fileOps.renameSync(oldTarget, backup);
      movedOld = true;
      const previousEnv = path.join(backup, ".env");
      const nextEnv = path.join(staging, ".env");
      if (fileOps.existsSync(previousEnv) && !fileOps.existsSync(nextEnv)) fileOps.copyFileSync(previousEnv, nextEnv);
    }
    fileOps.renameSync(staging, target);
    movedNew = true;
    const row: PluginSkillEntry = {
      id,
      source: "installed",
      enabled: previousRegistry.skills.find((item) => item.source === "installed" && item.id.toLowerCase() === id.toLowerCase())?.enabled ?? true,
      installed_at: new Date().toISOString(),
      origin: source,
      ...(frontmatter.version ? { version: frontmatter.version } : {}),
      ...(dependency.warnings.length ? { warnings: dependency.warnings } : {}),
    };
    saveLocalPluginsConfigAt(registryPath, replaceInstalledRow(registry(registryPath), row));
    registrySaved = true;
    if (backup) {
      try {
        fileOps.rmSync(backup, { recursive: true, force: true });
      } catch (error) {
        // The new target and registry are already committed. Keep the old
        // backup rather than rolling back only the files and leaving metadata
        // pointing at a non-existent installation.
        warnings.push(`旧 Skill 备份清理失败（已保留备份）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      ok: true,
      id,
      source: "installed",
      dir: target,
      path: path.join(target, "SKILL.md"),
      aliases: frontmatter.name && frontmatter.name !== id ? [frontmatter.name] : [],
      ...(frontmatter.version ? { version: frontmatter.version } : {}),
      warnings,
    };
  } catch (error) {
    if (registrySaved) throw error;
    try { if (!movedNew) fileOps.rmSync(staging, { recursive: true, force: true }); } catch {}
    try {
      if (movedNew && fileOps.existsSync(target)) fileOps.rmSync(target, { recursive: true, force: true });
      if (movedOld && backup && fileOps.existsSync(backup)) fileOps.renameSync(backup, oldTarget!);
    } catch {}
    throw error;
  } finally {
    try { fileOps.rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}

function rowsFor(config: LocalPluginsConfig, id: string): PluginSkillEntry[] {
  return config.skills.filter((entry) => entry.id.toLowerCase() === id.toLowerCase());
}

export async function uninstallSkill(options: UninstallSkillOptions): Promise<{ ok: true; id: string; removed: boolean; source?: string }> {
  const fileOps = opsFor(options.fsOps);
  validateSkillId(options.id);
  const id = options.id;
  const config = registry(options.registryPath);
  const rows = rowsFor(config, id);
  const installedRow = rows.find((row) => row.source === "installed");
  const localDir = path.resolve(options.localSkillsDir);
  if (fileOps.existsSync(localDir)) assertDirectoryRoot(localDir, fileOps, "local-skills");
  const target = childDirectory(localDir, id, fileOps);
  // An installed copy is an independently managed layer.  It must remain
  // removable even when a project or builtin copy with the same (case
  // insensitive) id is present and therefore wins resolution.
  if (installedRow || target) {
    if (!target) {
      const next = { ...config, skills: config.skills.filter((row) => row.id.toLowerCase() !== id.toLowerCase() || row.source !== "installed") };
      saveLocalPluginsConfigAt(options.registryPath, next);
      return { ok: true, id, removed: false, source: "installed" };
    }
    const trash = path.join(path.dirname(target), `.trash-${id}-${randomSuffix()}`);
    fileOps.renameSync(target, trash);
    let registrySaved = false;
    try {
      const next = { ...config, skills: config.skills.filter((row) => row.id.toLowerCase() !== id.toLowerCase() || row.source !== "installed") };
      saveLocalPluginsConfigAt(options.registryPath, next);
      registrySaved = true;
      try { fileOps.rmSync(trash, { recursive: true, force: true }); } catch {
        // Metadata already no longer points at the old directory.  Keep the
        // trash copy for a later cleanup rather than restoring a directory
        // that the registry no longer describes.
      }
      return { ok: true, id, removed: true, source: "installed" };
    } catch (error) {
      if (registrySaved) throw error;
      try { if (fileOps.existsSync(trash)) fileOps.renameSync(trash, target); } catch {}
      throw error;
    }
  }
  if (rows.some((row) => row.source === "builtin")) throw new SkillInstallerError("builtin Skill 不可卸载。", 409);
  const builtinPath = options.codeRoot ? path.join(path.resolve(options.codeRoot), "skills", id, "SKILL.md") : "";
  const projectPath = options.workspaceRoot ? path.join(path.resolve(options.workspaceRoot), ".claude", "skills", id, "SKILL.md") : "";
  if ((builtinPath && fs.existsSync(builtinPath)) || (projectPath && fs.existsSync(projectPath))) {
    throw new SkillInstallerError("project/builtin Skill 不可卸载。", 409);
  }
  if (rows.some((row) => row.source === "external")) {
    saveLocalPluginsConfigAt(options.registryPath, { ...config, skills: config.skills.filter((row) => !(row.id.toLowerCase() === id.toLowerCase() && row.source === "external")) });
    return { ok: true, id, removed: true, source: "external" };
  }
  if (rows.length) saveLocalPluginsConfigAt(options.registryPath, { ...config, skills: config.skills.filter((row) => row.id.toLowerCase() !== id.toLowerCase()) });
  return { ok: true, id, removed: false };
}

function builtinExists(codeRoot: string | undefined, id: string): boolean {
  if (!codeRoot) return false;
  const skillsRoot = path.join(path.resolve(codeRoot), "skills");
  if (fs.existsSync(path.join(skillsRoot, id, "SKILL.md"))) return true;
  const slug = /^anthropic\.([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(id)?.[1];
  if (!slug) return false;
  const root = path.join(skillsRoot, "anthropic-official-skills");
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "children.json"), "utf8"));
    return Array.isArray(manifest.children) && manifest.children.includes(slug) &&
      fs.existsSync(path.join(root, "references", "skills", slug, "SKILL.md"));
  } catch { return false; }
}

function sourceForId(options: SetSkillEnabledOptions, config: LocalPluginsConfig, id: string, fileOps: SkillFsOps): "installed" | "external" | "builtin" {
  if (options.source) return options.source;
  if (childDirectory(path.resolve(options.localSkillsDir), id, fileOps)) return "installed";
  const row = rowsFor(config, id)[0];
  if (row?.source) return row.source;
  if (builtinExists(options.codeRoot, id)) return "builtin";
  return "external";
}

export async function setSkillEnabled(options: SetSkillEnabledOptions): Promise<{ ok: true; id: string; source: string; enabled: boolean }> {
  const fileOps = opsFor(options.fsOps);
  validateSkillId(options.id);
  const localDir = path.resolve(options.localSkillsDir);
  if (fileOps.existsSync(localDir)) assertDirectoryRoot(localDir, fileOps, "local-skills");
  const config = registry(options.registryPath);
  const source = sourceForId({ ...options, localSkillsDir: localDir }, config, options.id, fileOps);
  if (source === "builtin") {
    if (!builtinExists(options.codeRoot, options.id)) throw new SkillInstallerError("builtin Skill 不存在。", 404);
  }
  if (source === "installed" && !childDirectory(localDir, options.id, fileOps)) {
    throw new SkillInstallerError(`installed Skill 不存在: ${options.id}`, 404);
  }
  const current = rowsFor(config, options.id).find((row) => row.source === source);
  const nextRow: PluginSkillEntry = {
    ...(current ?? { id: options.id, source }),
    id: options.id,
    source,
    enabled: options.enabled,
  };
  const nextRows = config.skills.filter((row) => !(row.id.toLowerCase() === options.id.toLowerCase() && row.source === source));
  saveLocalPluginsConfigAt(options.registryPath, { ...config, skills: [...nextRows, nextRow] });
  return { ok: true, id: options.id, source, enabled: options.enabled };
}

export function defaultInstallerPaths(registryPath: string): { localSkillsDir: string; registryPath: string } {
  const resolved = path.resolve(registryPath);
  return { registryPath: resolved, localSkillsDir: path.join(path.dirname(resolved), "local-skills") };
}

export { inside as isPathInside };
