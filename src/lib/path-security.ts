import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let defaultCwd = path.resolve(process.cwd());
let fullDiskAccess = true;
let allowedRoots: string[] = [defaultCwd];
let rootsExplicitlyConfigured = false;

function dedupeResolved(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const resolved = path.resolve(value);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

export function setDefaultCwd(cwd: string): void {
  defaultCwd = path.resolve(cwd);
  if (!rootsExplicitlyConfigured) allowedRoots = [defaultCwd];
}

export function getDefaultCwd(): string {
  return defaultCwd;
}

/** Configure the roots used when full-disk access is disabled. Passing an
 * empty list resets the strict boundary to the default workspace. */
export function setAllowedRoots(roots: string[]): void {
  const normalized = dedupeResolved(roots.filter((root) => root.trim()));
  allowedRoots = normalized.length > 0 ? normalized : [defaultCwd];
  rootsExplicitlyConfigured = roots.length > 0;
}

export function getAllowedRoots(): string[] {
  return [...allowedRoots];
}

export function setFullDiskAccess(enabled: boolean): void {
  fullDiskAccess = enabled;
}

export function getFullDiskAccess(): boolean {
  return fullDiskAccess;
}

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = comparable(root);
  const normalizedTarget = comparable(target);
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Resolve the deepest existing ancestor through realpath, then append the
 * still-missing suffix. This closes the common "nonexistent target below a
 * symlink" escape while still allowing creation of new files. */
async function canonicalBoundaryPath(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fsp.realpath(current);
      return path.join(real, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function canonicalRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const root of allowedRoots) {
    try { roots.push(await fsp.realpath(root)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      roots.push(path.resolve(root));
    }
  }
  return dedupeResolved(roots);
}

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(defaultCwd, trimmed);

  if (fullDiskAccess) return resolved;

  const [target, roots] = await Promise.all([canonicalBoundaryPath(resolved), canonicalRoots()]);
  if (!roots.some((root) => isInside(root, target))) {
    throw new Error(`PATH_OUTSIDE_ALLOWED_ROOTS: ${resolved}`);
  }
  return target;
}

export function getMachineRoots(): string[] {
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        fs.accessSync(`${letter}:\\`, fs.constants.R_OK);
        drives.push(`${letter}:\\`);
      } catch {}
    }
    return drives.length ? drives : ["C:\\"];
  }
  return ["/", os.homedir()];
}