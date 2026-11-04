"use strict";
// 路径解析：区分开发模式（直接跑仓库）与打包模式（resources/harness + userData/runtime）。
const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { validatePayload } = require("./payload-manifest");
const { profile } = require("./app-profile");
const accountContext = require("./account-context");
const lazyBrowserRuntime = require("./lazy-browser-runtime");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
// Electron normally derives userData from the package name, but a packaged
// build may use productName instead.  Keep this allowlist exact and narrow;
// `--user-data-dir` must never turn app:uninstall into arbitrary path deletion.
const APP_USER_DATA_BASENAMES = new Set(profile.userDataBasenames);

function isPackaged() {
  return app.isPackaged;
}

/** 只读代码根：包含 dist/、node_modules/、bin/、skills/、public/。 */
function codeRoot() {
  return isPackaged() ? path.join(process.resourcesPath, "harness") : REPO_ROOT;
}

/**
 * 可写运行目录（MCP 的 cwd）：包含 .env、profiles/、审计日志、checkpoint 等。
 * 开发模式下直接复用仓库根，便于沿用已有 .env 与 profiles；
 * CLC_RUNTIME_DIR 可覆盖（测试用）。
 */
function runtimeDir() {
  const account = accountContext.current();
  if (account && account.id !== "default") return accountContext.assertUnlinked(path.join(account.dataDir, "runtime"));
  if (profile.isolated) return accountPath("runtime");
  const override = (process.env.CLC_RUNTIME_DIR || "").trim();
  if (override) return path.resolve(override);
  return isPackaged() ? path.join(app.getPath("userData"), "runtime") : REPO_ROOT;
}

function accountPath(leaf) {
  const target = path.join(accountContext.dataDir(app.getPath("userData")), leaf);
  return accountContext.current() ? accountContext.assertUnlinked(target) : target;
}
function logsDir() { return accountPath("logs"); }
function configPath() { return accountPath("config.json"); }

function distEntry() {
  return path.join(codeRoot(), "dist", "index.js");
}

function resolverPath() {
  return path.join(codeRoot(), "dist", "lib", "skill-resolver.js");
}

function installerPath() {
  return path.join(codeRoot(), "dist", "lib", "skill-installer.js");
}

function bundledPluginsDir() { return path.join(codeRoot(), "bundled-plugins"); }
function computerUseHelperPath() { return path.join(bundledPluginsDir(), "computer-use", "windows-action.ps1"); }
function computerUseCapabilityPath() { return accountPath(path.join("computer-use", "capability.json")); }
function computerUseAuditLogPath() { return path.join(logsDir(), "computer-use.audit.jsonl"); }
function browserUseRuntimeVendor() { return path.join(codeRoot(), "vendor"); }
function browserUseRuntimeCache() { return path.join(app.getPath("userData"), "br"); }
function browserUseRuntimeRoot() {
  const legacy = path.join(browserUseRuntimeVendor(), "browser-use");
  if (fs.existsSync(path.join(legacy, "python", "python.exe"))) return legacy;
  try {
    const descriptor = lazyBrowserRuntime.archiveDescriptor(browserUseRuntimeVendor());
    const cached = lazyBrowserRuntime.cacheRoot(browserUseRuntimeCache(), descriptor);
    if (lazyBrowserRuntime.completedCache(cached, descriptor)) return cached;
  } catch { /* An absent or invalid archive is not an expanded runtime. */ }
  return legacy;
}
function browserUseRuntimeLockPath() { return path.join(bundledPluginsDir(), "browser-use", "runtime-lock.json"); }
function browserUseDataDir() { return accountPath("browser-use"); }
function browserUseAuditLogPath() { return path.join(logsDir(), "browser-use.audit.jsonl"); }
function browserUseRuntimeReady() {
  const root = browserUseRuntimeRoot();
  return [
    path.join(root, "python", "python.exe"),
    path.join(root, "site-packages", "browser_use", "__init__.py"),
    path.join(root, "site-packages", "browser_harness", "__init__.py"),
    path.join(root, "chrome", "chrome-win64", "chrome.exe"),
    path.join(root, "provenance.json"),
    path.join(root, "SBOM.spdx.json"),
    browserUseRuntimeLockPath(),
  ].every((file) => fs.existsSync(file));
}

function browserUseRuntimeAvailable() {
  if (browserUseRuntimeReady()) return true;
  try {
    lazyBrowserRuntime.archiveDescriptor(browserUseRuntimeVendor());
    return fs.existsSync(browserUseRuntimeLockPath());
  } catch { return false; }
}

async function ensureBrowserUseRuntime(note) {
  const plugins = JSON.parse(await fs.promises.readFile(path.join(runtimeDir(), "profiles", "plugins.json"), "utf8"));
  if (plugins.browser_use?.enabled !== true) return null;
  const legacy = path.join(browserUseRuntimeVendor(), "browser-use");
  if (browserUseRuntimeRoot() === legacy && browserUseRuntimeReady()) return legacy;
  const root = await lazyBrowserRuntime.materializeBrowserRuntime({ vendor: browserUseRuntimeVendor(), cacheBase: browserUseRuntimeCache(), note });
  if (!browserUseRuntimeReady()) throw new Error(`Browser Use 运行时不完整: ${root}`);
  return root;
}

function tunnelClientPath() {
  const bundled = path.join(codeRoot(), "bin", "tunnel-client.exe");
  if (fs.existsSync(bundled)) return bundled;
  const local = path.join(runtimeDir(), "bin", "tunnel-client.exe");
  return local;
}

function tunnelProfilePath() {
  return path.join(runtimeDir(), "profiles", "launcher.yaml");
}

const EMPTY_PLUGINS = {
  schema_version: 2,
  computer_use: { enabled: false },
  browser_use: { enabled: false },
  skills: [],
};
const EMPTY_UPSTREAM = { version: 1, servers: [] };
const LEGACY_UPSTREAM_SEED_SHA256 = "B4477E75C61B4AF8929E98AEC00C979847A2AD12A7F18F47CAFB032538992599";
const migrationByRuntime = new Map();

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.${process.pid}.${Date.now()}.bak`;
  let movedOld = false;
  let published = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    try {
      fs.renameSync(tmp, file);
      published = true;
    } catch (err) {
      if (!err || !["EEXIST", "EPERM"].includes(err.code)) throw err;
      if (!fs.existsSync(file)) throw err;
      fs.renameSync(file, backup);
      movedOld = true;
      try {
        fs.renameSync(tmp, file);
        published = true;
      } catch (publishError) {
        try {
          fs.renameSync(backup, file);
          movedOld = false;
        } catch (restoreError) {
          throw new Error(`配置发布失败且旧文件恢复失败；旧文件备份保留于 ${backup}: ${restoreError.message}`);
        }
        throw publishError;
      }
    }
    if (published && movedOld) {
      try { fs.rmSync(backup, { force: true }); } catch { /* retain recoverable backup */ }
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function hashFile(file) {
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function copyBackup(file, suffix) {
  if (!fs.existsSync(file)) return "";
  const backup = `${file}.${suffix}`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  return backup;
}

function pathInside(parent, target) {
  const base = path.resolve(parent);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canDeleteUserData(userData, runtime, options = {}) {
  const target = path.resolve(userData || "");
  const root = path.parse(target).root;
  if (!target || target === root || target.length <= root.length + 1) return false;
  if ((options.packaged === true || profile.isolated) && !APP_USER_DATA_BASENAMES.has(path.basename(target).toLowerCase())) return false;
  if (!options.packaged && (!options.override || !pathInside(target, runtime))) return false;
  // Refuse a final or ancestor reparse point so an app-uninstall request can
  // never recursively follow a junction into unrelated user data.
  let current = target;
  while (current && current !== root) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if (error.code !== "ENOENT") return false;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

/**
 * Stop the caller's services and remove only a guarded, disposable userData
 * directory.  Keeping the orchestration here makes the destructive boundary
 * unit-testable without opening the renderer's confirmation dialog.
 */
async function uninstallUserData({ userData, runtime, packaged, override, stopExternal, shutdown, stopFeeds }) {
  const target = path.resolve(userData || "");
  const options = { packaged: packaged === true, override: String(override || "").trim() };
  if (!canDeleteUserData(target, runtime, options)) {
    throw new Error(options.packaged
      ? "打包版只允许删除当前应用 userData 目录；当前路径不在应用目录白名单中。"
      : "开发模式不允许删除真实仓库或用户数据；请在打包版或隔离 CLC_RUNTIME_DIR 中操作。");
  }
  if (typeof stopExternal === "function") await stopExternal();
  if (typeof shutdown === "function") await shutdown();
  if (typeof stopFeeds === "function") stopFeeds();
  // Re-check after asynchronous shutdown hooks: a reparse point introduced
  // during teardown must fail closed instead of redirecting recursive rm.
  if (!canDeleteUserData(target, runtime, options)) {
    throw new Error(options.packaged
      ? "用户数据目录在卸载过程中不再满足当前应用目录白名单。"
      : "用户数据目录在卸载过程中不再满足安全路径约束。");
  }
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

function seedArchify(dir) {
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, "SKILL.md"))) return false;
  if (!fs.existsSync(path.join(dir, "archify.zip")) || !fs.existsSync(path.join(dir, ".git"))) return false;
  const nested = path.join(dir, "archify", "skill-release.json");
  try {
    const value = JSON.parse(fs.readFileSync(nested, "utf8"));
    return value.skillId === "archify";
  } catch { return false; }
}

function migrateV1Registry(file, runtime, codeRoot) {
  if (!fs.existsSync(file)) {
    atomicWriteJson(file, EMPTY_PLUGINS);
    return true;
  }
  const raw = readJson(file, null);
  if (!raw) return false;
  if (Number(raw.schema_version) >= 2) {
    const filtered = (Array.isArray(raw.skills) ? raw.skills : []).filter((item) => {
      const id = String(item?.id || "").trim().toLowerCase();
      const name = String(item?.name || "").trim().toLowerCase();
      return id !== "archify" && id !== "archify-github" && name !== "archify" && name !== "archify-github";
    });
    const hasBrowserUse = raw.browser_use && typeof raw.browser_use === "object";
    if (filtered.length === (Array.isArray(raw.skills) ? raw.skills.length : 0) && hasBrowserUse) return false;
    copyBackup(file, "v2-before-archify-clean.bak");
    atomicWriteJson(file, {
      ...raw,
      schema_version: 2,
      computer_use: { enabled: raw.computer_use?.enabled === true },
      browser_use: { enabled: raw.browser_use?.enabled === true },
      skills: filtered,
    });
    return true;
  }
  copyBackup(file, "v1.bak");
  const rows = [];
  for (const item of Array.isArray(raw.skills) ? raw.skills : []) {
    const originalPath = typeof item?.path === "string" ? item.path.trim() : "";
    const absolute = originalPath ? path.resolve(originalPath) : "";
    const lower = absolute.toLowerCase().replace(/\\/g, "/");
    if (lower.includes("/profiles/local-skills/archify/")) continue;
    if (String(item?.id || "").trim().toLowerCase() === "archify" || String(item?.name || "").trim().toLowerCase() === "archify-github") continue;
    const localMatch = lower.match(/\/profiles\/local-skills\/([^/]+)\//);
    const localId = localMatch?.[1];
    if (localId && fs.existsSync(path.join(runtime, "profiles", "local-skills", localId, "SKILL.md"))) {
      rows.push({
        id: localId,
        source: "installed",
        enabled: item.enabled !== false,
        ...(typeof item.name === "string" && item.name.trim().toLowerCase() !== localId.toLowerCase() ? { aliases: [item.name.trim()] } : {}),
      });
      continue;
    }
    if (localId) continue;
    if (absolute && pathInside(path.join(codeRoot, "skills"), absolute)) continue;
    if (absolute && path.basename(absolute).toLowerCase() === "skill.md") {
      rows.push({
        id: String(item.name || path.basename(path.dirname(absolute))),
        source: "external",
        enabled: item.enabled !== false,
        path: absolute,
        ...(typeof item.name === "string" ? { aliases: [item.name] } : {}),
        ...(!fs.existsSync(absolute) ? { error: "注册路径不存在" } : {}),
      });
    }
  }
  atomicWriteJson(file, { ...EMPTY_PLUGINS, skills: rows });
  return true;
}

function migrateUpstreamConfig(file) {
  if (!fs.existsSync(file)) {
    atomicWriteJson(file, EMPTY_UPSTREAM);
    return true;
  }
  const raw = readJson(file, EMPTY_UPSTREAM);
  if (hashFile(file)?.toUpperCase() === LEGACY_UPSTREAM_SEED_SHA256) {
    copyBackup(file, "v1.bak");
    atomicWriteJson(file, EMPTY_UPSTREAM);
    return true;
  }
  const servers = Array.isArray(raw.servers) ? raw.servers : [];
  const badIds = new Set(["ghidra-mcp", "hexstrike-ai", "open-design"]);
  const filtered = servers.filter((server) => {
    if (!badIds.has(String(server?.id || ""))) return true;
    const values = [server.command, ...(Array.isArray(server.args) ? server.args : []), server.cwd, server.env, server.headers, server.url];
    return !values.some((value) => /[A-Za-z]:[\\/]/.test(JSON.stringify(value ?? "")));
  });
  if (filtered.length === servers.length) return false;
  copyBackup(file, "v1.bak");
  atomicWriteJson(file, { ...raw, version: 1, servers: filtered });
  return true;
}

function migrateRuntimeProfiles() {
  const dir = runtimeDir();
  fs.mkdirSync(path.join(dir, "profiles"), { recursive: true });
  fs.mkdirSync(logsDir(), { recursive: true });
  const installed = path.join(dir, "profiles", "local-skills");
  fs.mkdirSync(installed, { recursive: true });
  const pluginFile = path.join(dir, "profiles", "plugins.json");
  const upstreamFile = path.join(dir, "profiles", "mcp-upstream.json");
  const errors = [];
  let changed = false;

  try {
    const seed = path.join(installed, "archify");
    if (seedArchify(seed)) {
      const trash = path.join(installed, `.trash-archify-${Date.now()}`);
      fs.renameSync(seed, trash);
      fs.rmSync(trash, { recursive: true, force: true });
      changed = true;
    }
  } catch (err) { errors.push(`清理 Skill 种子失败: ${err.message}`); }
  try { changed = migrateV1Registry(pluginFile, dir, codeRoot()) || changed; } catch (err) { errors.push(`迁移 plugins.json 失败: ${err.message}`); }
  try { changed = migrateUpstreamConfig(upstreamFile) || changed; } catch (err) { errors.push(`迁移 mcp-upstream.json 失败: ${err.message}`); }

  const versionFile = path.join(codeRoot(), "harness-version.json");
  const version = readJson(versionFile, {});
  const manifestFile = path.join(dir, "profiles", ".seed-manifest.json");
  const manifest = {
    desktop_version: app.getVersion(),
    harness_version: version.harness_version || "1.0.0",
    plugins_sha256: hashFile(pluginFile),
    upstream_sha256: hashFile(upstreamFile),
    updated_at: new Date().toISOString(),
  };
  const previous = readJson(manifestFile, null);
  if (!previous || previous.desktop_version !== manifest.desktop_version || previous.harness_version !== manifest.harness_version || previous.plugins_sha256 !== manifest.plugins_sha256 || previous.upstream_sha256 !== manifest.upstream_sha256) {
    try { atomicWriteJson(manifestFile, manifest); changed = true; } catch (err) { errors.push(`写入播种清单失败: ${err.message}`); }
  }
  migrationByRuntime.set(runtimeDir(), { changed, errors, manifest });
  return dir;
}

function ensureRuntimeDir() {
  const dir = migrateRuntimeProfiles();
  const envExample = path.join(codeRoot(), ".env.example");
  if (fs.existsSync(envExample) && !fs.existsSync(path.join(dir, ".env.example"))) {
    fs.copyFileSync(envExample, path.join(dir, ".env.example"));
  }
  return dir;
}

function resetRuntimeProfiles() {
  const dir = runtimeDir();
  const profiles = path.join(dir, "profiles");
  fs.mkdirSync(path.join(profiles, "local-skills"), { recursive: true });
  const plugins = path.join(profiles, "plugins.json");
  const upstream = path.join(profiles, "mcp-upstream.json");
  if (fs.existsSync(plugins)) copyBackup(plugins, `reset-${Date.now()}.bak`);
  if (fs.existsSync(upstream)) copyBackup(upstream, `reset-${Date.now()}.bak`);
  atomicWriteJson(plugins, EMPTY_PLUGINS);
  atomicWriteJson(upstream, EMPTY_UPSTREAM);
  migrationByRuntime.set(runtimeDir(), { changed: true, errors: [], manifest: null });
  return { plugins, upstream, localSkillsDir: path.join(profiles, "local-skills") };
}

function getMigrationStatus() {
  const migrationStatus = migrationByRuntime.get(runtimeDir()) || { changed: false, errors: [], manifest: null };
  return { ...migrationStatus, errors: [...migrationStatus.errors] };
}

function validatePackagedPayload() {
  if (!isPackaged()) return { file_count: 0, total_bytes: 0 };
  try {
    return validatePayload(codeRoot());
  } catch (error) {
    throw new Error(`发布 payload 完整性校验失败: ${error.message}`);
  }
}

module.exports = {
  REPO_ROOT,
  isPackaged,
  codeRoot,
  runtimeDir,
  logsDir,
  configPath,
  distEntry,
  resolverPath,
  installerPath,
  bundledPluginsDir,
  computerUseHelperPath,
  computerUseCapabilityPath,
  computerUseAuditLogPath,
  browserUseRuntimeRoot,
  browserUseRuntimeLockPath,
  browserUseDataDir,
  browserUseAuditLogPath,
  browserUseRuntimeReady,
  browserUseRuntimeAvailable,
  ensureBrowserUseRuntime,
  tunnelClientPath,
  tunnelProfilePath,
  migrateRuntimeProfiles,
  resetRuntimeProfiles,
  getMigrationStatus,
  ensureRuntimeDir,
  canDeleteUserData,
  uninstallUserData,
  validatePackagedPayload,
};
