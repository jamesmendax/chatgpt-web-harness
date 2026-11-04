"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createInflateRaw } = require("node:zlib");
const { assertZipEntryName, validateZipEntryMetadata, MAX_ZIP_BYTES } = require("./zip-safety");
const MAX_CENTRAL_BYTES = 8 * 1024 * 1024;

async function readAt(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (!result.bytesRead) throw new Error("Browser ZIP is truncated");
    read += result.bytesRead;
  }
  return buffer;
}

// Validate the entire index and every local header before writing any entry.
async function inspectArchive(handle, descriptor) {
  const size = (await handle.stat()).size;
  if (size !== descriptor.metadata.bytes || size < 22 || size > MAX_ZIP_BYTES) throw new Error("Browser ZIP size differs");
  const tailSize = Math.min(size, 65557);
  const tail = await readAt(handle, tailSize, size - tailSize);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) throw new Error("Browser ZIP end record missing");
  const disk = tail.readUInt16LE(end + 4), centralDisk = tail.readUInt16LE(end + 6);
  const count = tail.readUInt16LE(end + 10), diskCount = tail.readUInt16LE(end + 8);
  const centralBytes = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
  if (disk || centralDisk || count !== diskCount || count === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff || centralBytes > MAX_CENTRAL_BYTES || centralOffset + centralBytes !== size - tailSize + end) throw new Error("Browser ZIP multidisk, ZIP64 or index bounds unsupported");
  const central = await readAt(handle, centralBytes, centralOffset);
  const expected = new Map(descriptor.metadata.files.map(file => [file.path, file.bytes]));
  const entries = [], names = new Set();
  let cursor = 0, fileCount = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Browser ZIP central header invalid");
    const flags = central.readUInt16LE(cursor + 8), method = central.readUInt16LE(cursor + 10);
    const compressed = central.readUInt32LE(cursor + 20), length = central.readUInt32LE(cursor + 24);
    const nameSize = central.readUInt16LE(cursor + 28), extraSize = central.readUInt16LE(cursor + 30), commentSize = central.readUInt16LE(cursor + 32);
    const attributes = central.readUInt32LE(cursor + 38), offset = central.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > central.length || !nameSize || flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || central.readUInt16LE(cursor + 34) || [compressed, length, offset].includes(0xffffffff)) throw new Error("Browser ZIP entry encoding or bounds unsupported");
    let extra = cursor + 46 + nameSize;
    const extraEnd = extra + extraSize;
    while (extra < extraEnd) {
      if (extra + 4 > extraEnd || extra + 4 + central.readUInt16LE(extra + 2) > extraEnd || central.readUInt16LE(extra) === 1) throw new Error("Browser ZIP extra field invalid or ZIP64");
      extra += 4 + central.readUInt16LE(extra + 2);
    }
    const rawName = central.subarray(cursor + 46, cursor + 46 + nameSize);
    const decoded = rawName.toString("utf8");
    if (!Buffer.from(decoded, "utf8").equals(rawName)) throw new Error("Browser ZIP filename encoding invalid");
    const name = assertZipEntryName(decoded);
    if (names.has(name.toLowerCase()) || ((attributes >>> 16) & 0xf000) === 0xa000) throw new Error("Browser ZIP duplicate or symlink entry");
    names.add(name.toLowerCase());
    const directory = name.endsWith("/");
    if (directory ? length !== 0 : expected.get(name) !== length) throw new Error(`Browser ZIP inventory differs: ${name}`);
    if (!directory) fileCount++;
    if (offset + 30 > centralOffset) throw new Error("Browser ZIP local header bounds invalid");
    const local = await readAt(handle, 30, offset);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || local.readUInt16LE(26) !== nameSize) throw new Error("Browser ZIP local header differs");
    const dataOffset = offset + 30 + nameSize + local.readUInt16LE(28);
    if (dataOffset + compressed > centralOffset || !rawName.equals(await readAt(handle, nameSize, offset + 30))) throw new Error("Browser ZIP local name or data bounds differ");
    if (!(flags & 8) && (local.readUInt32LE(18) !== compressed || local.readUInt32LE(22) !== length)) throw new Error("Browser ZIP local sizes differ");
    if (method === 0 && compressed !== length) throw new Error("Browser ZIP stored size differs");
    entries.push({ name, length, compressed, method, offset, dataOffset, directory });
    cursor = next;
  }
  if (cursor !== central.length || fileCount !== expected.size) throw new Error("Browser ZIP inventory incomplete");
  validateZipEntryMetadata(entries);
  const fileNames = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().split("/");
    if (entry.directory && fileNames.has(parts.slice(0, -1).join("/"))) throw new Error("Browser ZIP file/directory conflict");
    for (let depth = 1; depth < parts.length; depth++) if (fileNames.has(parts.slice(0, depth).join("/"))) throw new Error("Browser ZIP file ancestor conflict");
  }
  const ranges = [...entries].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].dataOffset + ranges[i - 1].compressed) throw new Error("Browser ZIP entry ranges overlap");
  return entries;
}

async function extractRuntimeArchive(descriptor, target) {
  const archive = path.toNamespacedPath(descriptor.archive);
  const handle = await fs.promises.open(archive, "r");
  try {
    const entries = await inspectArchive(handle, descriptor);
    for (const entry of entries) {
      const output = path.toNamespacedPath(path.join(target, entry.name));
      if (entry.directory) { await fs.promises.mkdir(output, { recursive: true }); continue; }
      await fs.promises.mkdir(path.dirname(output), { recursive: true });
      let expanded = 0;
      const limit = new Transform({ transform(chunk, encoding, callback) {
        expanded += chunk.length;
        callback(expanded > entry.length ? new Error("Browser ZIP expanded size exceeds inventory") : null, chunk);
      } });
      const destination = fs.createWriteStream(output, { flags: "wx" });
      if (entry.compressed === 0) {
        await pipeline(require("node:stream").Readable.from([]), limit, destination);
      } else {
        const source = fs.createReadStream(archive, { start: entry.dataOffset, end: entry.dataOffset + entry.compressed - 1 });
        await pipeline(...(entry.method === 8 ? [source, createInflateRaw(), limit, destination] : [source, limit, destination]));
      }
      if (expanded !== entry.length) throw new Error("Browser ZIP expanded size differs");
    }
  } finally { await handle.close(); }
}

module.exports = { extractRuntimeArchive };
