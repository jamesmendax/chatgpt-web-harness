"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { runPowershell, psQuote } = require("../src/shell-util");
const { archiveDescriptor, materializeBrowserRuntime } = require("../src/lazy-browser-runtime");
const base = require("./lib/test-isolation.cjs").artifactRoot("lazy-browser-runtime");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

async function fixture(t, longEntry = false) {
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "lazy-browser-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, "vendor");
  const source = path.join(root, "source");
  fs.mkdirSync(vendor);
  const files = ["python/python.exe", "site-packages/browser_use/__init__.py", "site-packages/browser_harness/__init__.py", "chrome/chrome-win64/chrome.exe", "provenance.json", "SBOM.spdx.json"].map(name => {
    const bytes = Buffer.from(`fixture ${name}`);
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  });
  const archive = path.join(vendor, "browser-use.runtime.zip");
  await runPowershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${psQuote(source)}','${psQuote(archive)}')`);
  if (longEntry) {
    const name = `${'a'.repeat(60)}/${'b'.repeat(60)}/${'c'.repeat(60)}/tiny.txt`;
    const data = 'owned long entry fixture';
    await runPowershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open('${psQuote(archive)}','Update'); try { $e=$z.CreateEntry('${name}'); $w=New-Object IO.StreamWriter($e.Open()); $w.Write('${data}'); $w.Dispose() } finally { $z.Dispose() }`);
    files.push({ path: name, bytes: Buffer.byteLength(data), sha256: digest(data) });
  }
  const bytes = fs.readFileSync(archive);
  const metadata = { schema_version: 1, archive: "browser-use.runtime.zip", sha256: digest(bytes), bytes: bytes.length, total_bytes: files.reduce((sum, file) => sum + file.bytes, 0), file_count: files.length, files };
  fs.writeFileSync(path.join(vendor, "browser-use.archive.json"), JSON.stringify(metadata));
  return { root, vendor, archive, metadata, cacheBase: path.join(root, "cache") };
}

test("first browser use verifies and atomically expands once across concurrent callers", { skip: process.platform !== "win32" }, async t => {
  const input = await fixture(t);
  const notes = [];
  const first = materializeBrowserRuntime({ ...input, note: message => notes.push(message) });
  const second = materializeBrowserRuntime(input);
  assert.equal(first, second);
  const root = await first;
  assert.equal(fs.readFileSync(path.join(root, "python/python.exe"), "utf8"), "fixture python/python.exe");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".runtime-complete.json"))).sha256, input.metadata.sha256);
  assert.equal(notes.length, 2);
  assert.deepEqual(fs.readdirSync(input.cacheBase), [path.basename(root)]);
  // Deduplicate only in-flight work: later starts must revalidate this cache.
  fs.unlinkSync(path.join(root, "python/python.exe"));
  await assert.rejects(materializeBrowserRuntime(input));
  assert.equal(fs.existsSync(path.join(root, "python/python.exe")), false);
  fs.writeFileSync(path.join(root, "python/python.exe"), "fixture python/python.exe");
  // A fresh process/module must reject modified cache files before MCP use.
  fs.writeFileSync(path.join(root, "python/python.exe"), "corrupted");
  const modulePath = require.resolve("../src/lazy-browser-runtime");
  delete require.cache[modulePath];
  await assert.rejects(require(modulePath).materializeBrowserRuntime(input), /verification failed/);
});

test("corrupt archive fails SHA256 before extracting or publishing a cache", { skip: process.platform !== "win32" }, async t => {
  const input = await fixture(t);
  const bytes = fs.readFileSync(input.archive);
  bytes[0] ^= 1;
  fs.writeFileSync(input.archive, bytes);
  await assert.rejects(materializeBrowserRuntime(input), /SHA256/);
  assert.equal(fs.existsSync(input.cacheBase), false);
});

test("stream extraction supports nested archive entries and portable cache paths beyond MAX_PATH", { skip: process.platform !== "win32" }, async t => {
  const input = await fixture(t, true);
  // Keep the long-path precondition independent of the source checkout length.
  const longPathParent = path.join(input.root, "long-path-fixture-" + "x".repeat(64));
  for (const padding of [35, 70]) {
    input.cacheBase = path.join(longPathParent, "portable-parent-" + "p".repeat(padding), "canonical-portable-name-" + "n".repeat(padding), "appdata", "chatgpt-web-harness-isolated", "br");
    const root = await materializeBrowserRuntime(input);
    const file = path.join(root, "site-packages/browser_harness/__init__.py");
    assert.ok(file.length > 280, `Expected long portable path, got ${file.length}`);
    assert.equal(fs.readFileSync(file, "utf8"), "fixture site-packages/browser_harness/__init__.py");
  }
});

test("archive metadata rejects traversal and mismatched inventory totals", { skip: process.platform !== "win32" }, async t => {
  const input = await fixture(t);
  input.metadata.files[0].path = "../escape.exe";
  fs.writeFileSync(path.join(input.vendor, "browser-use.archive.json"), JSON.stringify(input.metadata));
  assert.throws(() => archiveDescriptor(input.vendor), /不安全路径/);
  input.metadata.files[0].path = "python/python.exe";
  input.metadata.total_bytes++;
  fs.writeFileSync(path.join(input.vendor, "browser-use.archive.json"), JSON.stringify(input.metadata));
  assert.throws(() => archiveDescriptor(input.vendor), /totals differ/);
});

test("ZIP local-header and encryption failures publish no extracted files", { skip: process.platform !== "win32" }, async t => {
  for (const corruption of ['local-name', 'encrypted', 'overlap']) {
    const input = await fixture(t);
    const bytes = fs.readFileSync(input.archive);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (corruption === 'local-name') bytes[30] ^= 1;
    if (corruption === 'encrypted') bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
    if (corruption === 'overlap') bytes.writeUInt32LE(0xffffffff, central + 20);
    fs.writeFileSync(input.archive, bytes);
    input.metadata.sha256 = digest(bytes);
    fs.writeFileSync(path.join(input.vendor, 'browser-use.archive.json'), JSON.stringify(input.metadata));
    await assert.rejects(materializeBrowserRuntime(input), /Browser ZIP/);
    assert.deepEqual(fs.readdirSync(input.cacheBase), []);
  }
});

test("per-file hash failure removes partial extraction without a completion marker", { skip: process.platform !== "win32" }, async t => {
  const input = await fixture(t);
  input.metadata.files[0].sha256 = "0".repeat(64);
  fs.writeFileSync(path.join(input.vendor, "browser-use.archive.json"), JSON.stringify(input.metadata));
  await assert.rejects(materializeBrowserRuntime(input), /file verification failed/);
  assert.deepEqual(fs.readdirSync(input.cacheBase), []);
});

test("disabled account plugin never invokes archive preparation", async () => {
  const filename = path.resolve(__dirname, "../src/paths.js");
  const realRequire = createRequire(filename);
  const module = { exports: {} };
  let preparations = 0;
  const context = { module, exports: module.exports, __dirname: path.dirname(filename), process,
    require(request) {
      if (request === "electron") return { app: { isPackaged: true, getPath: () => base } };
      if (request === "fs") return { ...fs, promises: { ...fs.promises, readFile: async () => JSON.stringify({ browser_use: { enabled: false } }) } };
      if (request === "./lazy-browser-runtime") return { materializeBrowserRuntime() { preparations++; throw Error("must not extract"); } };
      return realRequire(request);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), context, { filename });
  assert.equal(await module.exports.ensureBrowserUseRuntime(), null);
  assert.equal(preparations, 0);
});
