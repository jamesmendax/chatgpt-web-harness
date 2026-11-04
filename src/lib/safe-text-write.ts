import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface SafeTextWriteOptions {
  readonly expectedSha256?: string;
  readonly createOnly?: boolean;
  readonly beforePublish?: () => Promise<void>;
  /** Revalidate action authorization under the lock before each publish attempt. */
  readonly beforeCommit?: () => Promise<void>;
}

export interface SafeTextWriteResult {
  readonly bytes: number;
  readonly previous_sha256: string | null;
  readonly sha256: string;
  readonly created: boolean;
  readonly expected_sha256_checked: boolean;
  readonly create_only_checked: boolean;
  readonly publish_strategy: "rename_replace" | "link_create";
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

// CodexPro fsOps.ts: canonicalize an existing target or its deepest existing
// parent so path aliases share a lock. Only ENOENT permits parent traversal.
async function canonicalTarget(file: string): Promise<string> {
  let current = path.resolve(file);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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

async function readExisting(file: string) {
  let handle;
  try { handle = await fs.open(file, "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("WRITE_CONFLICT: target is not a regular file");
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("WRITE_CONFLICT: target changed during read");
    }
    return { sha256: sha256(data), mode: before.mode };
  } finally { await handle.close(); }
}

async function assertPrecondition(file: string, options: SafeTextWriteOptions) {
  const value = await readExisting(file);
  if (options.createOnly && value) throw new Error("WRITE_CONFLICT: create_only target already exists");
  if (options.expectedSha256 !== undefined && value?.sha256 !== options.expectedSha256.toLowerCase()) {
    throw new Error(`WRITE_CONFLICT: expected_sha256=${options.expectedSha256}, actual_sha256=${value?.sha256 ?? "missing"}`);
  }
  return value;
}

/** Atomic publication between cooperating writers, with bounded external-edit
 * detection. Arbitrary programs that ignore the lock are not transactional. */
export async function writeTextFileCas(file: string, content: string, options: SafeTextWriteOptions = {}): Promise<SafeTextWriteResult> {
  if (options.expectedSha256 !== undefined &&
      (typeof options.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(options.expectedSha256))) {
    throw new Error("Invalid expected_sha256");
  }
  const target = await canonicalTarget(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const release = await acquireLock(target);
  let temporary: string | undefined;
  try {
    const initial = await assertPrecondition(target, options);
    await options.beforePublish?.();
    const buffer = Buffer.from(content, "utf8");
    temporary = `${target}.${process.pid}.${randomUUID()}.cas-tmp`;
    const handle = await fs.open(temporary, "wx", initial?.mode ?? 0o600);
    try { await handle.writeFile(buffer); await handle.sync(); }
    finally { await handle.close(); }
    const current = await assertPrecondition(target, options);
    if (initial?.sha256 !== current?.sha256) throw new Error("WRITE_CONFLICT: target changed during write preparation");
    let strategy: SafeTextWriteResult["publish_strategy"];
    if (!current) {
      // Atomic no-clobber publication; rename alone overwrites a racing creator.
      await options.beforeCommit?.();
      try { await fs.link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("WRITE_CONFLICT: target created during publication");
        throw error;
      }
      strategy = "link_create";
    } else {
      // A Windows reader can briefly prevent replacement. Keep our lock and
      // recheck the revision before retrying; never move/delete the old target.
      const attempts = process.platform === "win32" ? 10 : 1;
      for (let attempt = 0; ; attempt++) {
        await options.beforeCommit?.();
        try { await fs.rename(temporary, target); break; }
        catch (error) {
          if (attempt + 1 >= attempts || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          await sleep(10 * (attempt + 1));
          const latest = await assertPrecondition(target, options);
          if (initial?.sha256 !== latest?.sha256) throw new Error("WRITE_CONFLICT: target changed while publication was blocked");
        }
      }
      strategy = "rename_replace";
    }
    return { bytes: buffer.length, previous_sha256: initial?.sha256 ?? null, sha256: sha256(buffer), created: !initial,
      expected_sha256_checked: options.expectedSha256 !== undefined, create_only_checked: options.createOnly === true, publish_strategy: strategy };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
    await release();
  }
}
