import { physicalPromises as fs } from "./physical-fs.js";
import path from "path";
import { randomUUID, createHash } from "node:crypto";
import { withCanonicalFileLock } from "./safe-text-write.js";

export interface CheckpointFileSnapshot {
  path: string;
  existed: boolean;
  is_directory?: boolean;
  encoding?: "utf-8" | "base64";
  content?: string;
  children?: CheckpointFileSnapshot[];
  skipped?: boolean;
  skip_reason?: string;
  blob?: string;
  checkpoint_id?: string;
}

export interface CheckpointSummary {
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: string[];
  file_count: number;
  complete?: boolean;
  skipped?: Array<{ path: string; reason: string }>;
}

interface CheckpointManifest {
  version: 1 | 2;
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: CheckpointFileSnapshot[];
}

interface CheckpointIndex {
  version: 1;
  checkpoints: CheckpointSummary[];
}

const INDEX_VERSION = 1 as const;
const DEFAULT_MAX_COUNT = 500;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 32;

function isEnabled(): boolean {
  const raw = (process.env.CHECKPOINT_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function getStoreRoot(): string {
  return process.env.CHECKPOINT_PATH || path.resolve(process.cwd(), ".mcp-checkpoints");
}

function getMaxCount(): number {
  const n = parseInt(process.env.CHECKPOINT_MAX_COUNT || String(DEFAULT_MAX_COUNT), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COUNT;
}

function getRetentionDays(): number {
  const n = parseInt(process.env.CHECKPOINT_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function getMaxFileBytes(): number {
  const n = parseInt(process.env.CHECKPOINT_MAX_FILE_BYTES || String(DEFAULT_MAX_FILE_BYTES), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

function checkpointDir(id: string): string {
  return path.join(getStoreRoot(), "data", id);
}

function indexPath(): string {
  return path.join(getStoreRoot(), "index.json");
}

function manifestPath(id: string): string {
  return path.join(checkpointDir(id), "manifest.json");
}

function isUtf8(buffer: Buffer): boolean {
  try {
    const text = buffer.toString("utf-8");
    return Buffer.from(text, "utf-8").equals(buffer);
  } catch {
    return false;
  }
}

async function readIndex(): Promise<CheckpointIndex> {
  try {
    const raw = await fs.readFile(indexPath(), "utf-8");
    const parsed = JSON.parse(raw) as CheckpointIndex;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.checkpoints)) {
      return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { version: INDEX_VERSION, checkpoints: [] };
}

async function writeIndex(index: CheckpointIndex): Promise<void> {
  const root = getStoreRoot();
  await fs.mkdir(root, { recursive: true });
  const temp = path.join(root, `.index-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(index, null, 2), "utf-8");
    await fs.rename(temp, indexPath());
  } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}

async function withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
  await fs.mkdir(getStoreRoot(), { recursive: true });
  return withCanonicalFileLock(path.join(getStoreRoot(), ".checkpoint-index-lock"), operation);
}

async function readManifest(id: string): Promise<CheckpointManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(id), "utf-8");
    const parsed = JSON.parse(raw) as CheckpointManifest;
    if (parsed.version === 2) {
      const lines = await fs.readFile(path.join(checkpointDir(id), "entries.jsonl"), "utf8");
      parsed.files = lines.split("\n").filter(Boolean).map(line => ({ ...JSON.parse(line), checkpoint_id: id }));
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function snapshotFile(filePath: string): Promise<CheckpointFileSnapshot> {
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return snapshotDirectory(resolved, 0);
    }
    if (stat.size > getMaxFileBytes()) {
      return {
        path: resolved,
        existed: true,
        skipped: true,
        skip_reason: `file exceeds CHECKPOINT_MAX_FILE_BYTES (${stat.size} bytes)`,
      };
    }
    const buffer = await fs.readFile(resolved);
    if (isUtf8(buffer)) {
      return { path: resolved, existed: true, encoding: "utf-8", content: buffer.toString("utf-8") };
    }
    return { path: resolved, existed: true, encoding: "base64", content: buffer.toString("base64") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: resolved, existed: false };
    }
    throw err;
  }
}

async function snapshotDirectory(dirPath: string, depth: number): Promise<CheckpointFileSnapshot> {
  if (depth > MAX_DIRECTORY_DEPTH) {
    return {
      path: dirPath,
      existed: true,
      is_directory: true,
      skipped: true,
      skip_reason: `directory depth exceeds ${MAX_DIRECTORY_DEPTH}`,
      children: [],
    };
  }

  const children: CheckpointFileSnapshot[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      children.push(await snapshotDirectory(full, depth + 1));
    } else if (entry.isFile()) {
      children.push(await snapshotFile(full));
    }
  }

  return { path: dirPath, existed: true, is_directory: true, children };
}

async function restoreSnapshot(snapshot: CheckpointFileSnapshot): Promise<void> {
  const target = snapshot.path;

  if (!snapshot.existed) {
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }

  if (snapshot.skipped) {
    throw new Error(`Cannot restore skipped snapshot for ${target}: ${snapshot.skip_reason || "unknown"}`);
  }

  if (snapshot.is_directory) {
    await fs.mkdir(target, { recursive: true });
    for (const child of snapshot.children || []) {
      await restoreSnapshot(child);
    }
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  if (snapshot.blob && snapshot.checkpoint_id) {
    await fs.copyFile(path.join(checkpointDir(snapshot.checkpoint_id), snapshot.blob), target);
    return;
  }
  const buffer =
    snapshot.encoding === "base64"
      ? Buffer.from(snapshot.content || "", "base64")
      : Buffer.from(snapshot.content || "", "utf-8");
  await fs.writeFile(target, buffer);
}

async function removeCheckpointData(id: string): Promise<void> {
  await fs.rm(checkpointDir(id), { recursive: true, force: true });
}

async function pruneCheckpoints(index: CheckpointIndex): Promise<CheckpointIndex> {
  const maxCount = getMaxCount();
  const retentionMs = getRetentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  let checkpoints = [...index.checkpoints];
  const toDelete: string[] = [];

  checkpoints = checkpoints.filter((cp) => {
    const created = Date.parse(cp.created_at);
    if (Number.isFinite(created) && created < cutoff) {
      toDelete.push(cp.id);
      return false;
    }
    return true;
  });

  while (checkpoints.length > maxCount) {
    const removed = checkpoints.shift();
    if (removed) toDelete.push(removed.id);
  }

  for (const id of toDelete) {
    await removeCheckpointData(id);
  }

  return { version: INDEX_VERSION, checkpoints };
}

function buildSummary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    id: manifest.id,
    created_at: manifest.created_at,
    tool: manifest.tool,
    summary: manifest.summary,
    files: manifest.files.map((f) => f.path),
    file_count: manifest.files.length,
  };
}

export function getCheckpointConfig(): Record<string, unknown> {
  return {
    enabled: isEnabled(),
    store_path: getStoreRoot(),
    max_count: getMaxCount(),
    retention_days: getRetentionDays(),
    max_file_bytes: getMaxFileBytes(),
    note: "Only file-editing MCP tools are tracked. Shell/bash file changes are not captured.",
  };
}

export interface CheckpointAttempt { id: string | null; complete: boolean; skipped: Array<{ path: string; reason: string }>; error?: string }
export async function checkpointBeforeDetailed(
  tool: string, paths: string[], options?: { summary?: string; dry_run?: boolean }
): Promise<CheckpointAttempt> {
  if (!isEnabled() || options?.dry_run || !paths.length) return { id: null, complete: true, skipped: [] };
  const uniquePaths = [...new Set(paths.map(p => path.resolve(p)))];
  const store = path.resolve(getStoreRoot());
  const overlaps = uniquePaths.find(item => {
    const relative = path.relative(item, store);
    const reverse = path.relative(store, item);
    const inside = (value: string) => value === "" || (!value.startsWith(".."+path.sep) && value !== ".." && !path.isAbsolute(value));
    return inside(relative) || inside(reverse);
  });
  if (overlaps) return { id: null, complete: false, skipped: [{ path: overlaps, reason: "checkpoint store overlaps target" }], error: "Checkpoint store overlaps target; snapshot was not created" };
  const id = `cp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const dir = checkpointDir(id);
  const skipped: Array<{ path: string; reason: string }> = [];
  let entries: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await fs.mkdir(path.join(dir, "blobs"), { recursive: true });
    entries = await fs.open(path.join(dir, "entries.jsonl"), "wx");
    let sequence = 0;
    const record = async (entry: CheckpointFileSnapshot) => {
      if (entry.skipped) skipped.push({ path: entry.path, reason: entry.skip_reason || "unknown" });
      await entries!.writeFile(JSON.stringify(entry) + "\n");
    };
    const walk = async (filePath: string, depth: number): Promise<void> => {
      let stat: Awaited<ReturnType<typeof fs.lstat>>;
      try { stat = await fs.lstat(filePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return record({ path: filePath, existed: false });
        return record({ path: filePath, existed: true, skipped: true, skip_reason: String(error) });
      }
      if (stat.isSymbolicLink()) return record({ path: filePath, existed: true, skipped: true, skip_reason: "symbolic link not captured" });
      if (stat.isDirectory()) {
        if (depth > MAX_DIRECTORY_DEPTH) return record({ path: filePath, existed: true, is_directory: true, skipped: true, skip_reason: `directory depth exceeds ${MAX_DIRECTORY_DEPTH}` });
        await record({ path: filePath, existed: true, is_directory: true });
        try { const dirHandle = await fs.opendir(filePath); for await (const entry of dirHandle) await walk(path.join(filePath, entry.name), depth + 1); }
        catch (error) { await record({ path: filePath, existed: true, skipped: true, skip_reason: `directory enumeration: ${String(error)}` }); }
        return;
      }
      if (!stat.isFile() || stat.size > getMaxFileBytes()) return record({ path: filePath, existed: true, skipped: true,
        skip_reason: stat.isFile() ? `file exceeds CHECKPOINT_MAX_FILE_BYTES (${stat.size} bytes)` : "unsupported file type" });
      const blob = `blobs/${sequence++}`;
      try { await fs.copyFile(filePath, path.join(dir, blob)); await record({ path: filePath, existed: true, blob }); }
      catch (error) { await record({ path: filePath, existed: true, skipped: true, skip_reason: String(error) }); }
    };
    for (const item of uniquePaths) await walk(item, 0);
    await entries.close(); entries = undefined;
    const manifest: CheckpointManifest = { version: 2, id, created_at: new Date().toISOString(), tool,
      summary: options?.summary || `${tool}: ${uniquePaths.length} path(s)`, files: uniquePaths.map(p => ({ path: p, existed: true })) };
    await fs.writeFile(manifestPath(id), JSON.stringify(manifest), "utf8");
    await withIndexLock(async () => {
      const index = await readIndex();
      index.checkpoints.push({ ...buildSummary(manifest), complete: skipped.length === 0, skipped });
      await writeIndex(await pruneCheckpoints(index));
    });
    return { id, complete: skipped.length === 0, skipped };
  } catch (error) {
    await entries?.close().catch(() => undefined);
    return { id: null, complete: false, skipped, error: String(error) };
  }
}
export async function checkpointBefore(tool: string, paths: string[], options?: { summary?: string; dry_run?: boolean }): Promise<string | null> {
  const attempt = await checkpointBeforeDetailed(tool, paths, options);
  if (attempt.error) console.warn(`[checkpoint] ${tool}: ${attempt.error}`);
  return attempt.id;
}

export async function listCheckpoints(limit = 50): Promise<CheckpointSummary[]> {
  const index = await readIndex();
  return [...index.checkpoints].reverse().slice(0, Math.max(1, limit));
}

export async function getCheckpoint(id: string): Promise<CheckpointSummary | null> {
  const index = await readIndex();
  return index.checkpoints.find((cp) => cp.id === id) ?? null;
}

function findCheckpointIndex(checkpoints: CheckpointSummary[], id: string): number {
  return checkpoints.findIndex((cp) => cp.id === id);
}

async function collectRestorePlan(targetId: string): Promise<{
  target: CheckpointSummary;
  files: Map<string, CheckpointFileSnapshot>;
  skipped: CheckpointFileSnapshot[];
}> {
  const index = await readIndex();
  const targetIndex = findCheckpointIndex(index.checkpoints, targetId);
  if (targetIndex < 0) {
    throw new Error(`Checkpoint not found: ${targetId}`);
  }

  const target = index.checkpoints[targetIndex];
  const affected = index.checkpoints.slice(targetIndex);
  const files = new Map<string, CheckpointFileSnapshot>();
  const skipped: CheckpointFileSnapshot[] = [];

  const add = (snapshot: CheckpointFileSnapshot) => {
    if (snapshot.skipped) {
      skipped.push(snapshot);
      // Preserve an enumeration error even when the directory entry preceded it.
      if (!files.has(snapshot.path) || files.get(snapshot.path)?.is_directory) files.set(snapshot.path, snapshot);
    } else if (!files.has(snapshot.path)) {
      files.set(snapshot.path, { ...snapshot, children: undefined });
    }
    for (const child of snapshot.children || []) add(child);
  };
  for (const checkpoint of affected) {
    const manifest = await readManifest(checkpoint.id);
    if (!manifest) {
      const missing = { path: `[checkpoint ${checkpoint.id}]`, existed: true, skipped: true, skip_reason: "manifest or entries missing" };
      skipped.push(missing); files.set(missing.path, missing); continue;
    }
    for (const snapshot of manifest.files) add(snapshot);
  }

  return { target, files, skipped };
}

export async function previewRestore(targetId: string): Promise<{
  checkpoint: CheckpointSummary;
  changes: Array<{
    path: string;
    action: "restore" | "delete" | "skip";
    existed_before_edit: boolean;
    reason?: string;
  }>;
  skipped_snapshots: Array<{ path: string; reason?: string }>;
}> {
  const { target, files, skipped } = await collectRestorePlan(targetId);
  const changes: Array<{
    path: string;
    action: "restore" | "delete" | "skip";
    existed_before_edit: boolean;
    reason?: string;
  }> = [];

  for (const [filePath, snapshot] of files) {
    if (snapshot.skipped) {
      changes.push({
        path: filePath,
        action: "skip",
        existed_before_edit: snapshot.existed,
        reason: snapshot.skip_reason,
      });
      continue;
    }

    let existsNow = false;
    try {
      await fs.access(filePath);
      existsNow = true;
    } catch {}

    if (!snapshot.existed) {
      changes.push({
        path: filePath,
        action: existsNow ? "delete" : "skip",
        existed_before_edit: false,
        reason: existsNow ? "file was created after checkpoint" : "already absent",
      });
      continue;
    }

    changes.push({
      path: filePath,
      action: "restore",
      existed_before_edit: true,
    });
  }

  return {
    checkpoint: target,
    changes,
    skipped_snapshots: skipped.map((s) => ({ path: s.path, reason: s.skip_reason })),
  };
}

export async function restoreToCheckpoint(targetId: string): Promise<{
  checkpoint: CheckpointSummary;
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason?: string }>;
}> {
  const { target, files } = await collectRestorePlan(targetId);
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason?: string }> = [];

  // Apply in reverse path order so nested directory restores stay consistent.
  const ordered = [...files.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [filePath, snapshot] of ordered) {
    if (snapshot.skipped) {
      skipped.push({ path: filePath, reason: snapshot.skip_reason });
      continue;
    }

    if (!snapshot.existed) {
      try {
        await fs.rm(filePath, { recursive: true, force: true });
        deleted.push(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") skipped.push({ path: filePath, reason: String(err) });
      }
      continue;
    }

    try { await restoreSnapshot(snapshot); restored.push(filePath); }
    catch (error) { skipped.push({ path: filePath, reason: String(error) }); }
  }

  // Remove checkpoints after the restore point (they are now stale).
  if (skipped.length) return { checkpoint: target, restored, deleted, skipped };
  await withIndexLock(async () => {
    const index = await readIndex();
    const targetIndex = findCheckpointIndex(index.checkpoints, targetId);
    if (targetIndex < 0) return;
    const removed = index.checkpoints.splice(targetIndex);
    for (const cp of removed) await removeCheckpointData(cp.id);
    await writeIndex(index);
  });

  return { checkpoint: target, restored, deleted, skipped };
}

export async function clearCheckpoints(): Promise<number> {
  return withIndexLock(async () => {
    const index = await readIndex();
    const count = index.checkpoints.length;
    for (const cp of index.checkpoints) await removeCheckpointData(cp.id);
    await writeIndex({ version: INDEX_VERSION, checkpoints: [] });
    return count;
  });
}

export function checkpointFingerprint(paths: string[]): string {
  const normalized = [...new Set(paths.map((p) => path.resolve(p)))].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 12);
}