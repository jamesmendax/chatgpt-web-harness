import type { FileHandle } from "node:fs/promises";
import { physicalPromises as fs } from "./physical-fs.js";
import physicalFs from "./physical-fs.js";
const { createReadStream } = physicalFs;
import { createHash, randomUUID } from "node:crypto";
import { publishNewFile, withCanonicalFileLock } from "./safe-text-write.js";

type Meta = { version: 1; target: string; size: number; expectedHash: string | null; baseline: string | null; stagingIdentity: string; finalHash?: string };
type Input = { target: string; buffer: Buffer; offset: number; truncate: boolean; expectedSize: number; expectedHash?: string; transferId?: string; checkpoint: (target: string) => Promise<string | undefined> };

async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function targetHash(file: string): Promise<string | null> {
  try {
    const before = await fs.stat(file);
    if (!before.isFile()) throw new Error("WRITE_CONFLICT: target is not a regular file");
    const hash = await hashFile(file);
    const after = await fs.stat(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("WRITE_CONFLICT: target changed while reading");
    return hash;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
export async function writeAll(handle: Pick<FileHandle, "write">, buffer: Buffer, offset: number): Promise<void> {
  let done = 0;
  while (done < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, done, buffer.length - done, offset + done);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > buffer.length - done) throw new Error("UPLOAD_WRITE_FAILED: zero or invalid write progress");
    done += bytesWritten;
  }
}

/** Serialized among cooperating writers. External writers are detected before replacement,
 * but an uncooperative writer can still race the final rename on existing targets. */
export async function writeStagedBinary(input: Input) {
  return withCanonicalFileLock(input.target, async target => {
    const isNew = !input.transferId;
    if (isNew && (!input.truncate || input.offset !== 0)) throw new Error("UPLOAD_ID_REQUIRED: start with truncate=true, offset=0; use transfer_id for continuation");
    if (input.transferId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.transferId)) throw new Error("Invalid transfer_id");
    const id = input.transferId ?? randomUUID();
    const stage = `${target}.upload-${id}.part`;
    const metadata = `${target}.upload-${id}.json`;
    let meta: Meta;
    let checkpointId: string | undefined;
    if (isNew) {
      const baseline = await targetHash(target);
      checkpointId = await input.checkpoint(target);
      const h = await fs.open(stage, "wx", 0o600);
      const stageStat = await h.stat();
      await h.close();
      meta = { version: 1, target, size: input.expectedSize, expectedHash: input.expectedHash?.toLowerCase() ?? null, baseline,
        stagingIdentity: `${stageStat.dev}:${stageStat.ino}` };
      try { await fs.writeFile(metadata, JSON.stringify(meta), { flag: "wx", mode: 0o600 }); }
      catch (e) { await fs.unlink(stage).catch(() => undefined); throw e; }
    } else {
      try { meta = JSON.parse(await fs.readFile(metadata, "utf8")) as Meta; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("UPLOAD_UNKNOWN: transfer_id not found for target"); throw e; }
      if (meta.version !== 1 || meta.target !== target || meta.size !== input.expectedSize || meta.expectedHash !== (input.expectedHash?.toLowerCase() ?? null)) throw new Error("UPLOAD_CONFLICT: target or transfer parameters differ");
    }
    try {
      let handle;
      try { handle = await fs.open(stage, "r+"); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !meta.finalHash) throw e;
        const final = await targetHash(target);
        if (final !== meta.finalHash) throw new Error("UPLOAD_CONFLICT: finalized target has changed");
        const f = await fs.open(target, "r");
        try { const existing = Buffer.alloc(input.buffer.length); const { bytesRead } = await f.read(existing, 0, existing.length, input.offset); if (bytesRead !== existing.length || !existing.equals(input.buffer)) throw new Error("UPLOAD_CONFLICT: retry payload differs"); }
        finally { await f.close(); }
        return { path: target, transfer_id: id, bytes_written: 0, offset: input.offset, next_offset: meta.size, file_size: meta.size, expected_size: meta.size, sha256: final, finalized: true, idempotent_retry: true };
      }
      let currentSize: number;
      let retry = false;
      try {
        const opened = await handle.stat();
        const named = await fs.lstat(stage);
        if (!opened.isFile() || !named.isFile() || named.isSymbolicLink() || opened.nlink !== 1 ||
            `${opened.dev}:${opened.ino}` !== meta.stagingIdentity || opened.dev !== named.dev || opened.ino !== named.ino) {
          throw new Error("UPLOAD_CONFLICT: staging file was linked or replaced; abandon transfer");
        }
        currentSize = opened.size;
        if (input.offset > currentSize) throw new Error(`UPLOAD_OFFSET: current size is ${currentSize}`);
        if (input.offset < currentSize) {
          if (input.offset + input.buffer.length > currentSize) throw new Error("UPLOAD_CONFLICT: chunk overlaps existing EOF");
          const existing = Buffer.alloc(input.buffer.length);
          const { bytesRead } = await handle.read(existing, 0, existing.length, input.offset);
          if (bytesRead !== existing.length || !existing.equals(input.buffer)) throw new Error("UPLOAD_CONFLICT: retry payload differs");
          retry = true;
        } else {
          try { await writeAll(handle, input.buffer, input.offset); }
          catch (e) { try { await handle.truncate(currentSize); } catch { throw new Error("UPLOAD_WRITE_FAILED: partial write could not be rolled back; abandon transfer"); } throw e; }
          currentSize += input.buffer.length;
        }
      } finally { await handle.close(); }
      let sha256: string | undefined;
      let finalized = false;
      if (currentSize === meta.size) {
        sha256 = await hashFile(stage);
        if (meta.expectedHash && sha256 !== meta.expectedHash) throw new Error(`SHA256 mismatch: expected ${meta.expectedHash}, got ${sha256}`);
        if (await targetHash(target) !== meta.baseline) throw new Error("WRITE_CONFLICT: target changed since transfer started");
        // Persist the digest before publication so a lost final response is recoverable.
        meta.finalHash = sha256;
        const nextMetadata = `${metadata}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(nextMetadata, JSON.stringify(meta), { flag: "wx", mode: 0o600 });
          await fs.rename(nextMetadata, metadata);
        } finally { await fs.unlink(nextMetadata).catch(() => undefined); }
        if (meta.baseline === null) {
          // Hard link, or an exclusive copy on volumes without links (FAT32/exFAT).
          await publishNewFile(stage, target);
          await fs.unlink(stage).catch(() => undefined);
        } else await fs.rename(stage, target);
        finalized = true;
      }
      return { path: target, transfer_id: id, bytes_written: retry ? 0 : input.buffer.length, offset: input.offset, next_offset: currentSize, file_size: currentSize, expected_size: meta.size, sha256, finalized, staging_path: finalized ? undefined : stage, idempotent_retry: retry, checkpoint_id: checkpointId };
    } catch (e) {
      if (isNew) { await fs.unlink(stage).catch(() => undefined); await fs.unlink(metadata).catch(() => undefined); }
      throw e;
    }
  });
}
