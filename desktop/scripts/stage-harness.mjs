// 打包前把 harness 运行所需文件整理到 desktop/staging/harness：
//   dist/、bin/tunnel-client.exe、profiles/（只含通用 json/txt，不含个人 yaml/Skill）、public/、
//   bundled-plugins/、vendor/、package.json、.env.example，并安装生产依赖（--omit=dev）。
// Always compile into an isolated clean temporary directory, leaving any running checkout untouched.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createRequire } from "node:module";
import { assertStagingSafe } from "./lib/sanitize-profiles.mjs";
import { shouldPruneRuntimeFile } from "./lib/runtime-file-policy.mjs";
import { archiveBrowserRuntime } from "./lib/browser-runtime-archive.mjs";
import { writeBuildManifest } from "../../scripts/write-build-manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const staging = path.join(desktopRoot, "staging", "harness");
const args = new Set(process.argv.slice(2));
for (const arg of args) if (arg !== "--build") throw new Error(`Unknown staging option: ${arg}`);
const { includeDist, includeProfile } = createRequire(import.meta.url)("../../.release-tools/build-policy.cjs");
const manifestName = "harness-files.json";

// A distributable desktop build must contain the audited Tunnel client.
// Verify before clearing a previous staging directory.
const tunnelExe = path.join(repoRoot, "bin", "tunnel-client.exe");
const tunnelProvenance = JSON.parse(fs.readFileSync(
  path.join(repoRoot, "third-party", "tunnel-client", "PROVENANCE.json"), "utf8"));
const expectedTunnelSize = Number(tunnelProvenance.derived_executable_size);
const expectedTunnelHash = String(tunnelProvenance.derived_executable_sha256 || "").toLowerCase();
if (!Number.isSafeInteger(expectedTunnelSize) || expectedTunnelSize <= 0 ||
    !/^[a-f0-9]{64}$/.test(expectedTunnelHash)) {
  throw new Error("Invalid pinned Tunnel client provenance");
}
function verifyTunnelBinary(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`Missing required Tunnel client: ${file}`);
  }
  const actualSize = fs.statSync(file).size;
  const actualHash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actualSize !== expectedTunnelSize || actualHash !== expectedTunnelHash) {
    throw new Error(`Tunnel client integrity mismatch: ${file}`);
  }
}
verifyTunnelBinary(tunnelExe);

function log(msg) {
  console.log(`[stage] ${msg}`);
}

function run(cmd, cmdArgs, cwd) {
  // npm is a Windows command shim; node itself must be spawned directly so
  // its Program Files path is not split by cmd.exe.
  const res = spawnSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "npm", windowsHide: true });
  if (res.status !== 0) throw new Error(`${cmd} ${cmdArgs.join(" ")} 失败 (exit ${res.status})`);
}

function copy(rel, opts = {}) {
  const from = path.join(repoRoot, rel);
  const to = path.join(staging, rel);
  if (!fs.existsSync(from)) {
    if (opts.optional) { log(`跳过（不存在）: ${rel}`); return; }
    throw new Error(`缺少必需文件: ${from}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, filter: opts.filter });
  log(`复制 ${rel}`);
}

// A fresh output directory eliminates orphaned output without deleting shared dist.
const compileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "harness-stage-compile-"));
try {
  log("执行隔离 tsc 构建 ...");
  run(process.execPath, [path.join(repoRoot, "node_modules/typescript/bin/tsc"), "--outDir", path.join(compileRoot, "dist")], repoRoot);
  const freshDist = path.join(compileRoot, "dist");
  if (!fs.existsSync(path.join(freshDist, "index.js"))) throw new Error("Fresh compilation did not produce dist/index.js");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.cpSync(freshDist, path.join(staging, "dist"), { recursive: true, filter: source => {
    const relative = path.relative(freshDist, source).split(path.sep).join("/");
    return includeDist(relative);
  }});
} finally { fs.rmSync(compileRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
// The detached recovery host is launched from the packaged harness runtime.
// Keep its script beside dist/ so service-recovery-supervisor can resolve it
// after packaging, not only from the source checkout.
copy("scripts/service-recovery-host.mjs");
copy("scripts/service-recovery-worker.mjs");
copy("scripts/service-recovery-guardian.mjs");
copy("bin/tunnel-client.exe");
verifyTunnelBinary(path.join(staging, "bin", "tunnel-client.exe"));
// The two audited provider Skills and their launch metadata are part of the
// product. User-installed Skills remain runtime-owned and are never staged.
copy("bundled-plugins");
copy("skills");
copy("public", { optional: true });
copy(".env.example");
copy("LICENSE");
copy("third-party");
// Browser Use is an installed product capability. A release assembled without
// its pinned runtime is invalid rather than a reduced-feature package.
copy("vendor");
copy("icon.png", { optional: true });
copy("profiles", {
  filter: (src) => includeProfile(path.relative(path.join(repoRoot, "profiles"), src)),
});

// Replace source-machine profile data with release-safe empty defaults. This
// also makes a missing source profile deterministic for fresh packages.
const stagedProfiles = path.join(staging, "profiles");
fs.mkdirSync(stagedProfiles, { recursive: true });
fs.writeFileSync(path.join(stagedProfiles, "plugins.json"), JSON.stringify({
  schema_version: 2,
  computer_use: { enabled: false },
  browser_use: { enabled: false },
  skills: [],
}, null, 2) + "\n");
fs.writeFileSync(path.join(stagedProfiles, "mcp-upstream.json"), JSON.stringify({ version: 1, servers: [] }, null, 2) + "\n");
assertStagingSafe(staging);

// Keep the declared graph aligned with the audited lock. npm ci --omit=dev
// installs only production packages, without floating to newer versions.
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const slim = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  main: pkg.main,
  dependencies: pkg.dependencies,
  devDependencies: pkg.devDependencies,
};
fs.writeFileSync(path.join(staging, "package.json"), JSON.stringify(slim, null, 2));

const lockPath = path.join(repoRoot, "package-lock.json");
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
if (lock.lockfileVersion !== 3 || !lock.packages?.[""]) throw new Error("A valid npm v3 lockfile is required for release staging");
for (const [key, entry] of Object.entries(lock.packages)) {
  if (key && (!key.startsWith("node_modules/") || entry.link || !entry.integrity || !String(entry.resolved || "").startsWith("https://"))) {
    throw new Error(`Non-registry or unlocked dependency in release lock: ${key}`);
  }
}
fs.copyFileSync(lockPath, path.join(staging, "package-lock.json"));
log("安装锁定的生产依赖（npm ci --omit=dev --ignore-scripts）...");
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], staging);

// The production dependency tree includes documentation-only examples,
// declaration files, source maps, and Playwright's bundled Skill reference
// pages. They are never imported by the harness at runtime, but their deep
// paths can push a portable launcher's temporary extraction tree over the
// legacy Windows MAX_PATH boundary. Prune them after npm has resolved the
// exact production graph so setup, portable, and ZIP artifacts share the same
// smaller, runnable payload.
function pruneNonRuntimeFiles(root) {
  let removed = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/").toLowerCase();
      const inDependencies = rel.startsWith("node_modules/");
      const isPlaywrightReference = rel.includes("node_modules/playwright-core/lib/tools/skills/");
      if (inDependencies && (rel.split("/").includes("examples") || isPlaywrightReference)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (shouldPruneRuntimeFile(rel)) {
        fs.rmSync(full, { force: true });
        removed += 1;
      }
    }
  }
  visit(root);
  log(`移除非运行时依赖文件: ${removed}`);
}

pruneNonRuntimeFiles(staging);

// The MCP SDK is imported by runtime JavaScript using package subpaths. Move
// it to a short, private package name in the release payload and rewrite only
// the emitted runtime imports. Keeping the package contents and exports
// unchanged avoids dropping required server middleware while reclaiming the
// 17 characters in the scoped directory name that matter to MAX_PATH.
function shortenMcpSdkPath(root) {
  const source = path.join(root, "node_modules", "@modelcontextprotocol", "sdk");
  const target = path.join(root, "node_modules", "mcp-sdk");
  if (!fs.existsSync(source)) throw new Error(`缺少 MCP SDK 生产依赖: ${source}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(path.dirname(source), { recursive: true, force: true });

  let rewritten = 0;
  for (const file of collectFiles(path.join(root, "dist"))) {
    if (path.extname(file).toLowerCase() !== ".js") continue;
    const content = fs.readFileSync(file, "utf8");
    const next = content.replaceAll("@modelcontextprotocol/sdk", "mcp-sdk");
    if (next !== content) {
      fs.writeFileSync(file, next, "utf8");
      rewritten += 1;
    }
  }
  log(`压缩 MCP SDK 路径: ${rewritten} 个运行时导入`);
}

function collectFiles(dir) {
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
      else throw new Error(`staging 中存在不支持的文件类型: ${full}`);
    }
  }
  visit(dir);
  return files;
}

shortenMcpSdkPath(staging);

// Playwright's browser runtime is also imported by the browser and visual
// tools. Keep its complete package (including trace/recorder assets), but
// shorten the package directory so those assets remain extractable below
// MAX_PATH in deeply nested temporary directories.
function shortenPlaywrightPath(root) {
  const source = path.join(root, "node_modules", "playwright-core");
  const target = path.join(root, "node_modules", "pw");
  if (!fs.existsSync(source)) throw new Error(`缺少 Playwright 生产依赖: ${source}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(source, { recursive: true, force: true });

  let rewritten = 0;
  for (const file of collectFiles(path.join(root, "dist"))) {
    if (path.extname(file).toLowerCase() !== ".js") continue;
    const content = fs.readFileSync(file, "utf8");
    const next = content.replaceAll("\"playwright-core\"", "\"pw\"").replaceAll("'playwright-core'", "'pw'");
    if (next !== content) {
      fs.writeFileSync(file, next, "utf8");
      rewritten += 1;
    }
  }
  for (const name of ["playwright-core", "playwright-core.cmd", "playwright-core.ps1"]) {
    const file = path.join(root, "node_modules", ".bin", name);
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, "utf8");
    const next = content.replaceAll("..\\playwright-core\\", "..\\pw\\");
    if (next !== content) fs.writeFileSync(file, next, "utf8");
  }
  log(`压缩 Playwright 路径: ${rewritten} 个运行时导入`);
}

shortenPlaywrightPath(staging);

// Dependency aliases above change the emitted JavaScript. Fingerprint the
// final staged bytes, not the source checkout's pre-rewrite dist tree.
const runtimeBuild = await writeBuildManifest(staging);

const buildHash = createHash("sha256").update(fs.readFileSync(path.join(staging, "dist", "index.js"))).digest("hex").slice(0, 16);
const computerManifest = JSON.parse(fs.readFileSync(path.join(staging, "bundled-plugins", "computer-use", "manifest.json"), "utf8"));
const browserManifest = JSON.parse(fs.readFileSync(path.join(staging, "bundled-plugins", "browser-use", "manifest.json"), "utf8"));
const browserProvenance = JSON.parse(fs.readFileSync(path.join(staging, "vendor", "browser-use", "provenance.json"), "utf8"));
const fileSha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(path.join(staging, "harness-version.json"), JSON.stringify({
  harness_version: pkg.version,
  dist_index_sha256_16: buildHash,
  runtime_content_sha256: runtimeBuild.content_sha256,
  providers: {
    computer_use: {
      id: computerManifest.id,
      version: computerManifest.version,
      protocol_version: computerManifest.protocol_version,
      provider: computerManifest.provider,
      helper_sha256: fileSha256(path.join(staging, "bundled-plugins", "computer-use", "windows-action.ps1")),
      health_check: { tool: "computer_use", input: { action: "status" } },
      default_enabled: false,
    },
    browser_use: {
      id: browserManifest.id,
      version: browserManifest.version,
      protocol_version: browserManifest.protocol_version,
      provider: browserManifest.provider,
      browser_use_version: browserProvenance.browser_use.version,
      browser_harness_version: browserProvenance.browser_harness.version,
      python_version: browserProvenance.python.version,
      chrome_version: browserProvenance.chrome_for_testing.version,
      runtime_lock_sha256: fileSha256(path.join(staging, "bundled-plugins", "browser-use", "runtime-lock.json")),
      health_check: { tool: "browser_use_screenshot", input: { full: false, max_dim: 1200 } },
      telemetry_default: browserProvenance.telemetry_default,
      default_enabled: false,
    },
  },
  staged_at: new Date().toISOString(),
}, null, 2));

// Preserve the complete offline provider, but avoid extracting its thousands
// of files before the desktop window can open. Runtime expands it on first use.
const browserArchive = archiveBrowserRuntime(staging, { desktopRoot });
log(`浏览器运行时延迟展开: ${browserArchive.file_count} files -> ${browserArchive.bytes} byte ZIP`);

const size = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? size(full) : fs.statSync(full).size;
  }
  return total;
};

const manifestPath = path.join(staging, manifestName);
const manifestFiles = collectFiles(staging)
  .filter((file) => path.resolve(file) !== path.resolve(manifestPath))
  .map((file) => ({
    path: path.relative(staging, file).split(path.sep).join("/"),
    bytes: fs.statSync(file).size,
    sha256: fileSha256(file),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));
fs.writeFileSync(manifestPath, JSON.stringify({
  schema_version: 1,
  file_count: manifestFiles.length,
  total_bytes: manifestFiles.reduce((sum, entry) => sum + entry.bytes, 0),
  files: manifestFiles,
}, null, 2) + "\n");
log(`写入完整性清单 ${manifestName}: ${manifestFiles.length} files`);
log(`完成: ${staging} (${Math.round(size(staging) / 1048576)} MB)`);
