"use strict";

const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const MANIFEST_NAME = "harness-files.json";
const REQUIRED_FILES = [
  "bin/tunnel-client.exe",
  "third-party/tunnel-client/PROVENANCE.json",
  "dist/index.js",
  "dist/lib/plugin-config.js",
  "dist/lib/skill-installer.js",
  "dist/lib/skill-resolver.js",
  "dist/lib/computer-use-provider.js",
  "dist/lib/browser-use-provider.js",
  "bundled-plugins/computer-use/manifest.json",
  "bundled-plugins/computer-use/windows-action.ps1",
  "bundled-plugins/browser-use/manifest.json",
  "bundled-plugins/browser-use/runtime-lock.json",
  "vendor/browser-use/python/python.exe",
  "vendor/browser-use/chrome/chrome-win64/chrome.exe",
  "vendor/browser-use/provenance.json",
  "vendor/browser-use/sbom.spdx.json",
  "vendor/browser-use/licenses/browser-use-license.txt",
  "vendor/browser-use/licenses/browser-harness-license.txt",
  "vendor/browser-use/licenses/python-license.txt",
  "vendor/browser-use/licenses/chrome-for-testing-notice.txt",
  "node_modules/express/package.json",
  "package.json",
  "profiles/mcp-upstream.json",
  "profiles/plugins.json",
];
const BROWSER_PREFIX = "vendor/browser-use/";
const BROWSER_ARCHIVE = "vendor/browser-use.runtime.zip";
const BROWSER_METADATA = "vendor/browser-use.archive.json";

function validateDeferredBrowserRuntime(root, actual) {
  if (!actual.has(BROWSER_ARCHIVE) || !actual.has(BROWSER_METADATA)) {
    throw new Error("Deferred browser runtime requires both archive and metadata");
  }
  if ([...actual.keys()].some(key => key.startsWith(BROWSER_PREFIX))) {
    throw new Error("Deferred browser runtime must not also include an expanded tree");
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(root, BROWSER_METADATA), "utf8"));
  if (metadata?.schema_version !== 1 || metadata.archive !== "browser-use.runtime.zip" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256 || "") ||
      !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes > 512 * 1024 ** 2 ||
      metadata.bytes !== actual.get(BROWSER_ARCHIVE) || !Array.isArray(metadata.files)) {
    throw new Error("Invalid deferred browser runtime archive metadata");
  }
  const files = new Map();
  for (const file of metadata.files) {
    const relative = file?.path;
    if (typeof relative !== "string" || !relative || /[\\\0\r\n:]/.test(relative) ||
        relative.startsWith("/") || relative.split("/").some(part => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256 || "") ||
        files.has(relative.toLowerCase())) {
      throw new Error("Invalid deferred browser runtime inventory entry");
    }
    files.set(relative.toLowerCase(), file.bytes);
  }
  const total = [...files.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (!files.size || files.size > 20000 || metadata.file_count !== files.size || metadata.total_bytes !== total ||
      !Number.isSafeInteger(total) || total > 1024 ** 3) {
    throw new Error("Invalid deferred browser runtime inventory totals");
  }
  const critical = REQUIRED_FILES.filter(file => file.startsWith(BROWSER_PREFIX))
    .map(file => file.slice(BROWSER_PREFIX.length));
  critical.push("site-packages/browser_use/__init__.py", "site-packages/browser_harness/__init__.py");
  for (const file of critical) {
    if (!(files.get(file.toLowerCase()) > 0)) throw new Error("Deferred browser runtime lacks critical file: " + file);
  }
  // Startup validates inventory and archive length, matching harness-files.
  // The runtime materializer verifies the archive SHA and each file on first use.
}

function collectPayloadFiles(root) {
  const files = new Map();
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`发布 payload 含不支持的链接: ${full}`);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        const relative = path.relative(root, full).split(path.sep).join("/").toLowerCase();
        if (relative !== MANIFEST_NAME) files.set(relative, fs.statSync(full).size);
      } else {
        throw new Error(`发布 payload 含不支持的文件类型: ${full}`);
      }
    }
  }
  visit(root);
  return files;
}

function validatePayload(root) {
  const resolvedRoot = path.resolve(root);
  const manifestPath = path.join(resolvedRoot, MANIFEST_NAME);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`发布 payload 完整性清单不可读: ${manifestPath} (${error.message})`);
  }
  if (manifest?.schema_version !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`发布 payload 完整性清单版本无效: ${manifestPath}`);
  }
  const expected = new Map();
  for (const item of manifest.files) {
    const raw = typeof item?.path === "string" ? item.path : "";
    const normalized = raw.replaceAll("\\", "/");
    const target = path.resolve(resolvedRoot, normalized);
    const relative = path.relative(resolvedRoot, target);
    if (!raw || raw.includes("\0") || path.isAbsolute(raw) || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === "") {
      throw new Error(`发布 payload 完整性清单含越界路径: ${raw}`);
    }
    const bytes = Number(item?.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`发布 payload 完整性清单含无效大小: ${raw}`);
    const key = relative.split(path.sep).join("/").toLowerCase();
    if (key === MANIFEST_NAME || expected.has(key)) throw new Error(`发布 payload 完整性清单含重复路径: ${raw}`);
    expected.set(key, bytes);
  }
  if (manifest.file_count !== expected.size) throw new Error(`发布 payload 清单数量字段不一致: ${manifest.file_count} != ${expected.size}`);
  const expectedBytes = [...expected.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (manifest.total_bytes !== expectedBytes) throw new Error(`发布 payload 清单字节字段不一致: ${manifest.total_bytes} != ${expectedBytes}`);

  let actual;
  try {
    actual = collectPayloadFiles(resolvedRoot);
  } catch (error) {
    throw new Error(`发布 payload 文件树不可验证: ${error.message}`);
  }
  if (actual.size !== expected.size) throw new Error(`发布 payload 解包不完整: 文件数 ${actual.size}/${expected.size}`);
  const actualBytes = [...actual.values()].reduce((sum, bytes) => sum + bytes, 0);
  if (actualBytes !== expectedBytes) throw new Error(`发布 payload 解包不完整: 字节数 ${actualBytes}/${expectedBytes}`);
  for (const [key, bytes] of expected) {
    if (!actual.has(key)) throw new Error(`发布 payload 缺少文件: ${key}`);
    if (actual.get(key) !== bytes) throw new Error(`发布 payload 文件大小不符: ${key} (${actual.get(key)}/${bytes})`);
  }
  const deferredBrowser = actual.has(BROWSER_ARCHIVE) || actual.has(BROWSER_METADATA);
  if (deferredBrowser) validateDeferredBrowserRuntime(resolvedRoot, actual);
  for (const required of REQUIRED_FILES) {
    if (deferredBrowser && required.startsWith(BROWSER_PREFIX)) continue;
    const key = required.toLowerCase();
    if (!actual.has(key) || actual.get(key) <= 0) throw new Error(`发布 payload 缺少关键运行模块: ${required}`);
  }
  // The manifest checks structure/lengths. Pin the native executable to the
  // bundled provenance as well, so an executable of equal size cannot pass.
  const provenance = JSON.parse(fs.readFileSync(
    path.join(resolvedRoot, "third-party", "tunnel-client", "PROVENANCE.json"), "utf8"));
  const expectedSize = Number(provenance.derived_executable_size);
  const expectedHash = String(provenance.derived_executable_sha256 || "").toLowerCase();
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 ||
      !/^[a-f0-9]{64}$/.test(expectedHash)) {
    throw new Error("Invalid Tunnel client provenance in packaged payload");
  }
  const tunnelBinary = path.join(resolvedRoot, "bin", "tunnel-client.exe");
  const actualHash = createHash("sha256").update(fs.readFileSync(tunnelBinary)).digest("hex");
  if (actual.get("bin/tunnel-client.exe") !== expectedSize || actualHash !== expectedHash) {
    throw new Error("Packaged Tunnel client integrity mismatch");
  }
  return { file_count: actual.size, total_bytes: actualBytes };
}

module.exports = { MANIFEST_NAME, REQUIRED_FILES, collectPayloadFiles, validatePayload };
