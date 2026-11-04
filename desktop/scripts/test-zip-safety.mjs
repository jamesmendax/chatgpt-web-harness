import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_ZIP_ENTRIES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  assertZipEntryName,
  validateZipEntryMetadata,
  assertExtractedTreeContained,
} from "../src/zip-safety.js";

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "clc-zip-safety-"));
const root = path.join(tmp, "extract");
const outside = path.join(tmp, "outside");
await fsp.mkdir(root, { recursive: true });
await fsp.mkdir(outside, { recursive: true });
await fsp.writeFile(path.join(root, "SKILL.md"), "# safe\n", "utf8");

try {
  for (const name of ["package/SKILL.md", "package/", "中文/参考资料.md", "a.b-c_1/file.md"]) {
    assert.doesNotThrow(() => assertZipEntryName(name), `valid ZIP name rejected: ${name}`);
  }
  for (const name of [
    "../escape",
    "package/../escape",
    "package/./escape",
    "package//escape",
    "/absolute",
    "\\absolute",
    "C:/absolute",
    "C:relative",
    "package:stream",
    "package/file<bad>.md",
    "package/file?.md",
    "package/file.md ",
    "package./file.md",
    "CON/SKILL.md",
    "package/aux.txt",
    "package/COM1.md",
  ]) {
    assert.throws(() => assertZipEntryName(name), /不安全路径/, `unsafe ZIP name accepted: ${name}`);
  }

  assert.deepEqual(validateZipEntryMetadata([
    { name: "package/", length: 0 },
    { name: "package/SKILL.md", length: 32 },
  ]), { count: 2, uncompressedBytes: 32 });
  assert.throws(() => validateZipEntryMetadata([{ name: "package/SKILL.md", length: MAX_ZIP_UNCOMPRESSED_BYTES + 1 }]), /解压大小/);
  assert.throws(() => validateZipEntryMetadata([
    { name: "package/a", length: MAX_ZIP_UNCOMPRESSED_BYTES / 2 },
    { name: "package/b", length: MAX_ZIP_UNCOMPRESSED_BYTES / 2 + 1 },
  ]), /解压大小/);
  assert.throws(() => validateZipEntryMetadata(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `p/${i}`, length: 0 }))), /条目过多/);
  assert.throws(() => validateZipEntryMetadata([{ name: "package:bad", length: 0 }]), /不安全路径/);

  assert.equal(assertExtractedTreeContained(root), true);
  const linked = path.join(root, "linked-outside");
  fs.symlinkSync(outside, linked, "junction");
  assert.throws(() => assertExtractedTreeContained(root), /符号链接|真实路径/);
  fs.unlinkSync(linked);
  console.log("zip-safety: traversal, ADS/invalid Win32 names, reserved devices, expansion budget, and post-extract realpath containment OK");
} finally {
  await fsp.rm(tmp, { recursive: true, force: true });
}
