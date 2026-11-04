"use strict";
const fs = require("fs");
const path = require("path");

const MAX_ZIP_ENTRIES = 20_000;
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
// Keep the expansion budget bounded independently of the compressed archive
// size.  A highly-compressible archive must not be able to consume an
// unbounded amount of the user's disk before post-extraction validation runs.
const MAX_ZIP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

function pathInside(parent, target) {
  const base = path.resolve(parent);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Validate a central-directory entry before any extraction occurs. */
function assertZipEntryName(name) {
  const normalized = String(name || "").replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`压缩包包含不安全路径: ${name}`);
  }
  // A trailing slash is a normal ZIP directory entry; empty interior
  // segments, dot segments, ADS/drive colons, Win32-invalid characters,
  // trailing spaces/dots, and device names are not portable filesystem paths.
  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index];
    if (!segment && index !== parts.length - 1) throw new Error(`压缩包包含不安全路径: ${name}`);
    if (!segment) continue;
    if (segment === "." || segment === ".." || /[<>:"|?*]/.test(segment) || /[ .]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) {
      throw new Error(`压缩包包含不安全路径: ${name}`);
    }
  }
  return normalized;
}

/** Validate bounded central-directory metadata without extracting an archive. */
function validateZipEntryMetadata(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ZIP_ENTRIES) throw new Error("压缩包条目过多");
  let uncompressedBytes = 0;
  for (const entry of entries) {
    assertZipEntryName(entry?.name ?? entry?.FullName ?? "");
    const length = Number(entry?.length ?? entry?.Length);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ZIP_UNCOMPRESSED_BYTES || uncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES - length) {
      throw new Error(`压缩包解压大小超过上限 ${MAX_ZIP_UNCOMPRESSED_BYTES} 字节`);
    }
    uncompressedBytes += length;
  }
  return { count: entries.length, uncompressedBytes };
}

/**
 * Validate the extracted tree with lstat + realpath.  This catches both
 * ordinary symlinks and Windows directory junctions, including links created
 * by an extractor after the archive-level check.
 */
function assertExtractedTreeContained(root) {
  const base = path.resolve(root);
  const baseStat = fs.lstatSync(base);
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) throw new Error("压缩包解压目录必须是普通目录");
  const baseReal = path.resolve(fs.realpathSync(base));
  const visit = (dir) => {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error(`压缩包解压树包含不支持的链接: ${path.relative(base, dir)}`);
    const dirReal = path.resolve(fs.realpathSync(dir));
    if (!pathInside(baseReal, dirReal)) throw new Error(`压缩包真实路径逃逸解压目录: ${path.relative(base, dir)}`);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      assertZipEntryName(path.relative(base, full).replace(/\\/g, "/"));
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`压缩包包含不支持的符号链接或 junction: ${entry.name}`);
      const real = path.resolve(fs.realpathSync(full));
      if (!pathInside(baseReal, real)) throw new Error(`压缩包真实路径逃逸解压目录: ${entry.name}`);
      if (stat.isDirectory()) visit(full);
      else if (!stat.isFile()) throw new Error(`压缩包包含不支持的文件类型: ${entry.name}`);
    }
  };
  visit(base);
  return true;
}

module.exports = { MAX_ZIP_ENTRIES, MAX_ZIP_BYTES, MAX_ZIP_UNCOMPRESSED_BYTES, assertZipEntryName, validateZipEntryMetadata, assertExtractedTreeContained };
