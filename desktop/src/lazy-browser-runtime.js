"use strict";
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { extractRuntimeArchive } = require("./browser-runtime-zip");
const { assertZipEntryName, validateZipEntryMetadata, MAX_ZIP_BYTES } = require("./zip-safety");

const jobs = new Map();
const descriptors = new Map();
const MARKER = ".runtime-complete.json";
const REQUIRED = ["python/python.exe", "site-packages/browser_use/__init__.py", "site-packages/browser_harness/__init__.py", "chrome/chrome-win64/chrome.exe", "provenance.json", "SBOM.spdx.json"];

function archiveDescriptor(vendor) {
  const file = path.join(vendor, "browser-use.archive.json");
  const stat = fs.statSync(file);
  const key = `${file}:${stat.size}:${stat.mtimeMs}`;
  if (descriptors.has(key)) return descriptors.get(key);
  const raw = fs.readFileSync(file, "utf8");
  const metadata = JSON.parse(raw);
  if (metadata.schema_version !== 1 || metadata.archive !== "browser-use.runtime.zip" || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes > MAX_ZIP_BYTES || !Array.isArray(metadata.files)) throw new Error("Browser runtime archive metadata is invalid");
  const names = new Set();
  for (const item of metadata.files) {
    const name = assertZipEntryName(item.path);
    if (name.endsWith("/") || names.has(name.toLowerCase()) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("Browser runtime archive inventory is invalid");
    names.add(name.toLowerCase());
  }
  if (!REQUIRED.every(file => names.has(file.toLowerCase()))) throw new Error("Browser runtime archive critical files are missing");
  const summary = validateZipEntryMetadata(metadata.files.map(item => ({ name: item.path, length: item.bytes })));
  if (summary.count !== metadata.file_count || summary.uncompressedBytes !== metadata.total_bytes) throw new Error("Browser runtime archive inventory totals differ");
  const archive = path.join(vendor, metadata.archive);
  if (fs.statSync(archive).size !== metadata.bytes) throw new Error("Browser runtime archive size differs");
  const result = { metadata, archive, metadataHash: crypto.createHash("sha256").update(raw).digest("hex") };
  descriptors.set(key, result);
  return result;
}

function cacheRoot(cacheBase, descriptor) {
  return path.join(cacheBase, descriptor.metadata.sha256.slice(0, 20));
}

function completedCache(root, descriptor) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(root, MARKER), "utf8"));
    return marker.sha256 === descriptor.metadata.sha256 && marker.metadataHash === descriptor.metadataHash && REQUIRED.every(file => fs.statSync(path.join(root, file)).isFile());
  } catch { return false; }
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertUnlinked(target) {
  let current = path.resolve(target);
  const root = path.parse(current).root;
  while (true) {
    if (current === root) return;
    try { if ((await fsp.lstat(current)).isSymbolicLink()) throw new Error(`Browser runtime path contains a link: ${current}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function validateTree(root, descriptor) {
  await assertUnlinked(root);
  const expected = new Map(descriptor.metadata.files.map(file => [file.path, file]));
  let count = 0;
  async function visit(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const name = path.relative(root, target).split(path.sep).join("/");
      assertZipEntryName(name);
      const stat = await fsp.lstat(target);
      if (stat.isSymbolicLink()) throw new Error("Browser runtime contains a link");
      if (stat.isDirectory()) { await visit(target); continue; }
      if (name === MARKER) continue;
      const item = expected.get(name);
      if (!stat.isFile() || !item || stat.size !== item.bytes || await sha256(target) !== item.sha256) throw new Error(`Browser runtime file verification failed: ${name}`);
      count++;
    }
  }
  await visit(root);
  if (count !== expected.size) throw new Error("Browser runtime files are missing");
}

function materializeBrowserRuntime({ vendor, cacheBase, note = () => {} }) {
  const descriptor = archiveDescriptor(vendor);
  const target = cacheRoot(cacheBase, descriptor);
  if (jobs.has(target)) return jobs.get(target);
  const job = (async () => {
    await assertUnlinked(cacheBase);
    if (completedCache(target, descriptor)) {
      await validateTree(target, descriptor);
      return target;
    }
    note("首次使用浏览器工具，正在准备组件…");
    if (await sha256(descriptor.archive) !== descriptor.metadata.sha256) throw new Error("Browser runtime archive SHA256 verification failed");
    await fsp.mkdir(cacheBase, { recursive: true });
    const temporary = await fsp.mkdtemp(path.toNamespacedPath(path.join(cacheBase, ".prepare-")));
    try {
      await extractRuntimeArchive(descriptor, temporary);
      note("浏览器组件已解压，正在校验完整性…");
      await validateTree(temporary, descriptor);
      await fsp.writeFile(path.join(temporary, MARKER), JSON.stringify({ sha256: descriptor.metadata.sha256, metadataHash: descriptor.metadataHash }));
      // Concurrent application processes may have completed the same cache.
      try { await fsp.rename(temporary, target); }
      catch (error) {
        if (!completedCache(target, descriptor)) throw error;
        await validateTree(target, descriptor);
      }
      return target;
    } finally {
      // Only this call's mkdtemp child is removed; never remove a cache target.
      await fsp.rm(temporary, { recursive: true, force: true });
    }
  })();
  jobs.set(target, job);
  const clear = () => { if (jobs.get(target) === job) jobs.delete(target); };
  job.then(clear, clear);
  return job;
}

module.exports = { archiveDescriptor, cacheRoot, completedCache, materializeBrowserRuntime, validateTree };
