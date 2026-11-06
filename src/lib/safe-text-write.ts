import { physicalPromises as fs } from "./physical-fs.js";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface SafeTextWriteOptions {
  readonly expectedSha256?: string;
  readonly createOnly?: boolean;
  readonly beforePublish?: () => Promise<void>;
  /** Revalidate action authorization under the lock before each publish attempt. */
  readonly beforeCommit?: () => Promise<void>;
  /** Byte revision read by an edit before it computes the replacement. */
  readonly expectedRevision?: SafeFileRevision;
  /** Preserve the source's mode when an edit is published to a new path. */
  readonly mode?: number;
}

export interface SafeFileRevision {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly identity: string;
  readonly mode: number;
}

export interface SafeTextWriteResult {
  readonly bytes: number;
  readonly previous_sha256: string | null;
  readonly sha256: string;
  readonly created: boolean;
  readonly expected_sha256_checked: boolean;
  readonly create_only_checked: boolean;
  readonly publish_strategy: "rename_replace" | "link_create" | "copy_create";
}

const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;
const LEGACY_LOCK_RECLAIM_AGE_MS = 30_000;

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly acquired_at: string;
}

interface LockSnapshot {
  readonly raw: string;
  readonly size: number;
  readonly mtime_ms: number;
  readonly owner: LockOwner | null;
}

const REALPATH_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EACCES", "UNKNOWN"]);

// CodexPro fsOps.ts: canonicalize an existing target or its deepest existing
// parent so path aliases share a lock. Only ENOENT permits parent traversal.
async function canonicalTarget(file: string): Promise<string> {
  let current = path.resolve(file);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Some RAM disks and virtual drives reject the native realpath
      // (GetFinalPathNameByHandle). Lock the resolved path there instead of
      // refusing every write; only alias canonicalization is lost.
      if (code && REALPATH_UNSUPPORTED.has(code)) return path.join(current, ...suffix);
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM/EACCES proves that a process exists but cannot be signalled. Only
    // ESRCH is positive evidence that the recorded writer is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseLockOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || !Number.isInteger(value.pid) || Number(value.pid) <= 0 ||
        typeof value.token !== "string" || value.token.length < 8 ||
        typeof value.acquired_at !== "string" || !Number.isFinite(Date.parse(value.acquired_at))) return null;
    return { version: 1, pid: Number(value.pid), token: value.token, acquired_at: value.acquired_at };
  } catch {
    return null;
  }
}

async function readLockSnapshot(lockPath: string): Promise<LockSnapshot | null> {
  try {
    const handle = await fs.open(lockPath, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile()) return null;
      const raw = await handle.readFile("utf8");
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
      return { raw, size: after.size, mtime_ms: after.mtimeMs, owner: parseLockOwner(raw) };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameLockSnapshot(left: LockSnapshot | null, right: LockSnapshot | null): boolean {
  return Boolean(left && right && left.raw === right.raw && left.size === right.size && left.mtime_ms === right.mtime_ms);
}

async function legacyDeadWriterTemps(target: string): Promise<Array<{ file: string; pid: number }> | null> {
  const prefix = `${path.basename(target)}.`;
  const suffix = ".cas-tmp";
  const matches: Array<{ file: string; pid: number }> = [];
  for (const entry of await fs.readdir(path.dirname(target), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
    const middle = entry.name.slice(prefix.length, -suffix.length);
    const separator = middle.indexOf(".");
    if (separator <= 0 || !/^\d+$/.test(middle.slice(0, separator)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(middle.slice(separator + 1))) continue;
    const pid = Number(middle.slice(0, separator));
    if (!Number.isSafeInteger(pid) || pid <= 0 || isProcessAlive(pid)) return null;
    matches.push({ file: path.join(path.dirname(target), entry.name), pid });
  }
  // Old releases created an empty lock and later created a PID-bearing temp.
  // Without that exact dead-writer evidence an empty/malformed lock remains
  // fail-closed; age alone never authorizes deletion.
  return matches.length > 0 ? matches : null;
}

async function reclaimDeadLock(target: string, lockPath: string): Promise<boolean> {
  const reaperPath = `${lockPath}.reaper`;
  let reaper;
  try {
    reaper = await fs.open(reaperPath, "wx", 0o600);
  } catch (error) {
    if (["EEXIST", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")) return false;
    throw error;
  }
  let finished = false;
  try {
    await reaper.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, token: randomUUID(), acquired_at: new Date().toISOString() })}\n`, "utf8");
    await reaper.sync();
    const first = await readLockSnapshot(lockPath);
    if (!first) {
      finished = true;
      return true;
    }

    let legacyTemps: Array<{ file: string; pid: number }> | null = null;
    if (first.owner) {
      if (isProcessAlive(first.owner.pid)) {
        finished = true;
        return false;
      }
    } else {
      const ageMs = Date.now() - first.mtime_ms;
      if (first.raw.length !== 0 || !Number.isFinite(ageMs) || ageMs < LEGACY_LOCK_RECLAIM_AGE_MS) {
        finished = true;
        return false;
      }
      legacyTemps = await legacyDeadWriterTemps(target);
      if (!legacyTemps) {
        finished = true;
        return false;
      }
    }

    // Re-read under the exclusive reaper marker. A changed owner or a revived
    // PID makes recovery fail closed rather than deleting a current writer.
    const second = await readLockSnapshot(lockPath);
    if (!sameLockSnapshot(first, second) || (second?.owner && isProcessAlive(second.owner.pid))) {
      finished = true;
      return false;
    }
    if (legacyTemps) {
      const confirmed = await legacyDeadWriterTemps(target);
      if (!confirmed || confirmed.map((item) => item.file).sort().join("\n") !== legacyTemps.map((item) => item.file).sort().join("\n")) {
        finished = true;
        return false;
      }
    }
    await fs.unlink(lockPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    if (legacyTemps) {
      await Promise.all(legacyTemps.map((item) => fs.unlink(item.file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      })));
    }
    finished = true;
    return true;
  } finally {
    await reaper.close().catch(() => undefined);
    if (finished) await fs.unlink(reaperPath).catch(() => undefined);
  }
}

async function acquireLock(target: string): Promise<() => Promise<void>> {
  const key = process.platform === "win32" ? target.toLowerCase() : target;
  const lockPath = path.join(path.dirname(target), `.cas-${sha256(key)}.lock`);
  const started = Date.now();
  for (;;) {
    const token = randomUUID();
    let handle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimDeadLock(target, lockPath)) continue;
      if (Date.now() - started >= LOCK_WAIT_MS) throw new Error("WRITE_LOCK_BUSY: live or unverifiable writer lock requires reconciliation");
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      const owner: LockOwner = { version: 1, pid: process.pid, token, acquired_at: new Date().toISOString() };
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
      throw error;
    }
    return async () => {
      await handle.close().catch(() => undefined);
      // Failure after commit must not turn a successful mutation into a retry.
      // Delete only the lock carrying our nonce; never unlink a replacement.
      const current = await readLockSnapshot(lockPath).catch(() => null);
      if (current?.owner?.token === token) await fs.unlink(lockPath).catch(() => undefined);
    };
  }
}

/** Share the same per-target lock with streaming writers without buffering
 * their entire file. The callback owns neither another writer's temp nor lock. */
export async function withCanonicalFileLock<T>(file: string, action: (target: string) => Promise<T>): Promise<T> {
  const target = await canonicalTarget(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const release = await acquireLock(target);
  try { return await action(target); }
  finally { await release(); }
}

export interface CanonicalFileLockScope {
  /** Publishes only to a target held by this scope, without reacquiring it. */
  writeBytes(file: string, content: Buffer, options?: SafeTextWriteOptions): Promise<SafeTextWriteResult>;
}

/** Moves hold both source and destination in a stable order. Canonical aliases
 * are deduplicated so a scope never waits on its own per-file lock. */
export async function withCanonicalFileLocks<T>(files: readonly string[], action: (scope: CanonicalFileLockScope) => Promise<T>): Promise<T> {
  const targets = new Map<string, string>();
  for (const file of files) {
    const target = await canonicalTarget(file);
    targets.set(process.platform === "win32" ? target.toLowerCase() : target, target);
  }
  const ordered = [...targets.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const releases: Array<() => Promise<void>> = [];
  let active = true;
  try {
    for (const [, target] of ordered) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      releases.push(await acquireLock(target));
    }
    return await action({ writeBytes: async (file, content, options = {}) => {
      if (!active) throw new Error("WRITE_LOCK_BUSY: file lock scope has ended");
      const bytes = Buffer.from(content);
      const resolved = await canonicalTarget(file);
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      const target = targets.get(key);
      if (!target) throw new Error("WRITE_CONFLICT: publication target is not locked by this scope");
      return writeFileBytesCasLocked(file, target, bytes, options);
    } });
  } finally {
    active = false;
    for (const release of releases.reverse()) await release();
  }
}

async function readExisting(file: string, retainBytes = false) {
  let handle;
  try { handle = await fs.open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    const namedBefore = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || !namedBefore.isFile() || namedBefore.isSymbolicLink() ||
        before.dev !== namedBefore.dev || before.ino !== namedBefore.ino) throw new Error("WRITE_CONFLICT: target is not the same regular file");
    const data = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fs.lstat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.mode !== after.mode ||
        !namedAfter.isFile() || namedAfter.isSymbolicLink() || after.dev !== namedAfter.dev || after.ino !== namedAfter.ino ||
        after.size !== namedAfter.size || after.mtimeNs !== namedAfter.mtimeNs || after.ctimeNs !== namedAfter.ctimeNs) {
      throw new Error("WRITE_CONFLICT: target changed during read");
    }
    return { data: retainBytes ? data : null, sha256: sha256(data), mode: Number(before.mode), identity: `${before.dev}:${before.ino}` };
  } finally { await handle.close(); }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
}

/** Capture exact encoded bytes and physical identity before computing an edit. */
export async function readFileForEdit(file: string): Promise<{ bytes: Buffer; revision: SafeFileRevision }> {
  const target = await canonicalTarget(file);
  const value = await readExisting(target, true);
  if (!value) throw new Error("WRITE_CONFLICT: edit target is missing");
  if (!samePath(await canonicalTarget(file), target)) throw new Error("WRITE_CONFLICT: edit target path changed during read");
  return { bytes: value.data!, revision: { canonicalPath: target, sha256: value.sha256, identity: value.identity, mode: value.mode } };
}

export async function assertFileRevision(file: string, revision: SafeFileRevision): Promise<void> {
  const target = await canonicalTarget(file);
  if (!samePath(target, revision.canonicalPath)) throw new Error("WRITE_CONFLICT: edit target path changed since it was read");
  await assertPrecondition(target, { expectedRevision: revision });
}

async function assertPrecondition(file: string, options: SafeTextWriteOptions) {
  const value = await readExisting(file);
  if (options.createOnly && value) throw new Error("WRITE_CONFLICT: create_only target already exists");
  if (options.expectedSha256 !== undefined && value?.sha256 !== options.expectedSha256.toLowerCase()) {
    throw new Error(`WRITE_CONFLICT: expected_sha256=${options.expectedSha256}, actual_sha256=${value?.sha256 ?? "missing"}`);
  }
  if (options.expectedRevision && (!samePath(file, options.expectedRevision.canonicalPath) ||
      value?.sha256 !== options.expectedRevision.sha256 || value?.identity !== options.expectedRevision.identity || value?.mode !== options.expectedRevision.mode)) {
    throw new Error("WRITE_CONFLICT: edit target bytes, identity or mode changed since it was read");
  }
  return value;
}

function sameRevision(left: Awaited<ReturnType<typeof readExisting>>, right: Awaited<ReturnType<typeof readExisting>>): boolean {
  return left?.sha256 === right?.sha256 && left?.identity === right?.identity && left?.mode === right?.mode;
}

/** Atomic publication between cooperating writers, with bounded external-edit
 * detection. Arbitrary programs that ignore the lock are not transactional. */
// FAT32/exFAT, many network shares and virtual drives cannot create hard
// links, so no new file could be written there at all. An exclusive copy keeps
// the no-clobber guarantee (EEXIST when a racing creator won); only those
// volumes lose atomic publication of the new file's content.
const LINK_UNSUPPORTED = new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR", "EXDEV", "EINVAL"]);

export async function publishNewFile(source: string, target: string): Promise<"link_create" | "copy_create"> {
  try {
    await fs.link(source, target);
    return "link_create";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") throw new Error("WRITE_CONFLICT: target created during publication");
    if (!LINK_UNSUPPORTED.has(code)) throw error;
  }
  try {
    await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
    return "copy_create";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("WRITE_CONFLICT: target created during publication");
    throw error;
  }
}

export async function writeTextFileCas(file: string, content: string, options: SafeTextWriteOptions = {}): Promise<SafeTextWriteResult> {
  return writeFileBytesCas(file, Buffer.from(content, "utf8"), options);
}

/** Publish already-encoded bytes; edit callers keep GBK, UTF-16 and BOM exactly. */
export async function writeFileBytesCas(file: string, content: Buffer, options: SafeTextWriteOptions = {}): Promise<SafeTextWriteResult> {
  const bytes = Buffer.from(content);
  if (options.expectedSha256 !== undefined &&
      (typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedSha256))) {
    throw new Error("Invalid expected_sha256");
  }
  return withCanonicalFileLock(file, target => writeFileBytesCasLocked(file, target, bytes, options));
}

async function writeFileBytesCasLocked(file: string, target: string, content: Buffer, options: SafeTextWriteOptions): Promise<SafeTextWriteResult> {
  const buffer = content;
  const contentSha256 = sha256(buffer);
  if (options.expectedSha256 !== undefined &&
      (typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedSha256))) {
    throw new Error("Invalid expected_sha256");
  }
  if (options.expectedRevision && !samePath(target, options.expectedRevision.canonicalPath)) throw new Error("WRITE_CONFLICT: edit target path changed since it was read");
  let temporary: string | undefined;
  let temporaryIdentity: string | undefined;
  try {
    const initial = await assertPrecondition(target, options);
    await options.beforePublish?.();
    temporary = `${target}.${process.pid}.${randomUUID()}.cas-tmp`;
    const mode = initial?.mode ?? options.mode ?? 0o600;
    const handle = await fs.open(temporary, "wx", mode);
    try {
      const created = await handle.stat({ bigint: true }); temporaryIdentity = `${created.dev}:${created.ino}`;
      await handle.writeFile(buffer);
      // Creation is subject to umask; restore the old file's exact mode before
      // publication rather than letting an edit silently remove execute bits.
      if (initial || options.mode !== undefined) await handle.chmod(mode & 0o7777);
      await handle.sync();
    }
    finally { await handle.close(); }
    const current = await assertPrecondition(target, options);
    if (!sameRevision(initial, current)) throw new Error("WRITE_CONFLICT: target changed during write preparation");
    const beforePublication = async () => {
      await options.beforeCommit?.();
      const staged = await fs.lstat(temporary!, { bigint: true });
      if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1n || `${staged.dev}:${staged.ino}` !== temporaryIdentity) {
        throw new Error("WRITE_CONFLICT: prepared file was linked or replaced");
      }
      const prepared = await readExisting(temporary!);
      if (prepared?.identity !== temporaryIdentity || prepared.sha256 !== contentSha256) throw new Error("WRITE_CONFLICT: prepared bytes changed before publication");
      if (!samePath(await canonicalTarget(file), target)) throw new Error("WRITE_CONFLICT: target path changed during write preparation");
      const latest = await assertPrecondition(target, options);
      if (!sameRevision(initial, latest)) throw new Error("WRITE_CONFLICT: target changed before publication");
    };
    let strategy: SafeTextWriteResult["publish_strategy"];
    if (!current) {
      // Atomic no-clobber publication; rename alone overwrites a racing creator.
      await beforePublication();
      strategy = await publishNewFile(temporary, target);
    } else {
      // A Windows reader can briefly prevent replacement. Keep our lock and
      // recheck the revision before retrying; never move/delete the old target.
      const attempts = process.platform === "win32" ? 10 : 1;
      for (let attempt = 0; ; attempt++) {
        await beforePublication();
        try { await fs.rename(temporary, target); break; }
        catch (error) {
          if (attempt + 1 >= attempts || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await sleep(10 * (attempt + 1));
          const latest = await assertPrecondition(target, options);
          if (!sameRevision(initial, latest)) throw new Error("WRITE_CONFLICT: target changed while publication was blocked");
        }
      }
      strategy = "rename_replace";
    }
    return { bytes: buffer.length, previous_sha256: initial?.sha256 ?? null, sha256: contentSha256, created: !initial,
      expected_sha256_checked: options.expectedSha256 !== undefined, create_only_checked: options.createOnly === true, publish_strategy: strategy };
  } finally {
    if (temporary && temporaryIdentity) {
      const staged = await fs.lstat(temporary, { bigint: true }).catch(() => null);
      if (staged?.isFile() && !staged.isSymbolicLink() && `${staged.dev}:${staged.ino}` === temporaryIdentity) {
        await fs.unlink(temporary).catch(() => undefined);
      }
    }
  }
}
