"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { profile } = require("./app-profile");
const { resolveTaskbarAppId } = require("./taskbar-identity");

const DATA_NAME = "chatgpt-web-harness-isolated";
const CLEAN_HOST_MARKER = ".clean-host-fixture.json";
const CONTROLLED_ENV = new Set([
  "CLC_RUNTIME_DIR", "ADMIN_TOKEN", "MCP_TOKEN", "MCP_API_KEY", "RUNTIME_API_KEY",
  "ELECTRON_RUN_AS_NODE", "SMOKE_TUNNEL_DOCTOR", "NODE_OPTIONS", "NODE_PATH", "DOTENV_KEY",
  "AUDIT_LOG_PATH", "CHECKPOINT_PATH", "CODEX_HOME", "MCP_SHELL_STATE_DIR",
  "HARNESS_COMPUTER_USE_RUNTIME_ROOT", "HARNESS_COMPUTER_USE_HELPER", "HARNESS_COMPUTER_USE_HELPER_SHA256",
  "HARNESS_COMPUTER_USE_CAPABILITY_FILE", "HARNESS_COMPUTER_USE_TOKEN", "HARNESS_COMPUTER_USE_INSTANCE_ID",
  "HARNESS_COMPUTER_USE_EXPIRES_AT", "HARNESS_COMPUTER_USE_AUDIT_LOG",
  "HARNESS_BROWSER_USE_RUNTIME_ROOT", "HARNESS_BROWSER_USE_RUNTIME_LOCK", "HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256",
  "HARNESS_BROWSER_USE_DATA_DIR", "HARNESS_BROWSER_USE_AUDIT_LOG", "HARNESS_BROWSER_USE_HEADLESS",
  "HARNESS_RELAY_ENABLED", "HARNESS_COMPANION_ENABLED", "HARNESS_RELAY_AUTOMATION_ENABLED",
  "HARNESS_RELAY_AUTO_RECOVERY_ENABLED",
  "HARNESS_COMPANION_TOKEN", "HARNESS_COMPANION_INSTANCE_ID", "HARNESS_COMPANION_TOKEN_EXPIRES_AT",
  "HARNESS_COMPANION_CAPABILITY_FILE", "HARNESS_DRIVER_LEASE_TTL_MS", "HARNESS_DRIVER_DRAIN_TIMEOUT_MS",
  "HARNESS_RELAY_LANE_FRESH_MS", "HARNESS_RELAY_COMMAND_TTL_MS", "HARNESS_RELAY_RISK_THRESHOLD",
  "HARNESS_RELAY_AUTOMATION_POLL_MS", "HARNESS_RELAY_REPLACEMENT_PROGRESS_TIMEOUT_MS",
  "HARNESS_RECOVERY_SUPERVISOR_ENABLED", "HARNESS_RECOVERY_SUPERVISOR_STATE_DIR",
  "HARNESS_RECOVERY_ARTIFACT_ROOT",
  "HARNESS_CLEAN_HOST_SCOPE", "HARNESS_CLEAN_HOST_TOKEN",
  "EXTRA_WORKSPACE_PATHS", "WORKSPACE_PATHS", "ALLOWED_WORKSPACE_PATHS",
]);
function controlledKey(key) {
  const upper = key.toUpperCase();
  return CONTROLLED_ENV.has(upper) || upper.startsWith("DOTENV_CONFIG_");
}
function isolatedEnvironment(inherited, runtime) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) if (!controlledKey(key)) env[key] = value;
  // These variables are intentionally controlled, but must still cross the
  // desktop isolation boundary so the detached recovery supervisor can be
  // enabled for the packaged runtime.
  for (const key of [
    "HARNESS_RECOVERY_SUPERVISOR_ENABLED",
    "HARNESS_RECOVERY_SUPERVISOR_STATE_DIR",
    "HARNESS_RECOVERY_ARTIFACT_ROOT",
  ]) {
    if (Object.prototype.hasOwnProperty.call(inherited, key)) env[key] = inherited[key];
  }
  return Object.assign(env, {
    CLC_RUNTIME_DIR: runtime,
    AUDIT_LOG_PATH: path.join(runtime, ".mcp-audit.log"),
    CHECKPOINT_PATH: path.join(runtime, ".mcp-checkpoints"),
    CODEX_HOME: path.join(runtime, ".codex"),
    MCP_SHELL_STATE_DIR: path.join(runtime, ".mcp-state"),
  });
}
function samePath(a, b) {
  const normalize = (value) => path.resolve(value).toLowerCase();
  return normalize(a) === normalize(b);
}
function isolatedPaths({ appData, desktopRoot, isPackaged, requestedUserData = "" }) {
  const defaultRoot = path.join(path.resolve(appData), DATA_NAME);
  const localRoot = path.join(path.resolve(desktopRoot), ".isolated", DATA_NAME);
  const allowed = isPackaged ? [defaultRoot] : [defaultRoot, localRoot];
  if (requestedUserData && !path.isAbsolute(requestedUserData)) throw new Error("隔离版拒绝相对 user-data-dir。");
  const requested = requestedUserData ? path.resolve(requestedUserData) : defaultRoot;
  const userData = allowed.find((candidate) => samePath(candidate, requested));
  if (!userData) throw new Error("隔离版拒绝非专用数据目录；请使用默认目录或 Start-Isolated.cmd。");
  return { userData, runtime: path.join(userData, "runtime") };
}
function assertNoLinkedAncestor(target, fileSystem = fs) {
  let current = path.resolve(target);
  const root = path.parse(current).root;
  while (current && current !== root) {
    try {
      if (fileSystem.lstatSync(current).isSymbolicLink()) throw new Error("隔离数据目录不能经由符号链接或 junction。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
}
function acceptanceAppData({ isPackaged, requestedUserData, env, fileSystem }) {
  const rawScope = env.HARNESS_CLEAN_HOST_SCOPE;
  const token = env.HARNESS_CLEAN_HOST_TOKEN;
  if (!rawScope && !token) return null;
  const reject = () => { throw new Error("隔离版拒绝无效的 clean-host 测试目录。"); };
  if (!isPackaged || !rawScope || !path.isAbsolute(rawScope) || !/^[a-f0-9]{64}$/i.test(token || "")) reject();
  const scope = path.resolve(rawScope);
  const runRoot = path.dirname(scope);
  if (!/^harness-clean-host-[a-z0-9_-]{6,}$/i.test(path.basename(runRoot)) ||
      !["portable", "setup"].includes(path.basename(scope).toLowerCase())) reject();
  const appData = path.join(scope, "appdata");
  if (!samePath(env.APPDATA || "", appData) ||
      !samePath(env.LOCALAPPDATA || "", path.join(scope, "localappdata")) ||
      !samePath(env.TEMP || "", path.join(scope, "temp")) ||
      !samePath(env.TMP || "", path.join(scope, "temp")) ||
      !requestedUserData || !samePath(requestedUserData, path.join(appData, DATA_NAME))) reject();
  // A random, short-lived marker is created by the acceptance runner, never
  // by the app. Validate the whole ancestry before trusting the marker.
  assertNoLinkedAncestor(scope, fileSystem);
  const markerPath = path.join(scope, CLEAN_HOST_MARKER);
  assertNoLinkedAncestor(markerPath, fileSystem);
  let marker;
  try {
    if (!fileSystem.lstatSync(markerPath).isFile()) reject();
    marker = JSON.parse(fileSystem.readFileSync(markerPath, "utf8"));
  } catch { reject(); }
  const expected = Buffer.from(token.toLowerCase(), "hex");
  if (!/^[a-f0-9]{64}$/i.test(String(marker?.token || ""))) reject();
  const actual = Buffer.from(String(marker?.token || ""), "hex");
  const ageMs = Date.now() - Number(marker?.created_at);
  if (marker?.schema_version !== 1 || !path.isAbsolute(marker?.scope || "") ||
      !samePath(marker.scope, scope) ||
      actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected) ||
      !Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > 20 * 60_000) reject();
  return appData;
}
function portableAppData({ isPackaged, env, fileSystem }) {
  const executable = env.PORTABLE_EXECUTABLE_FILE;
  const directory = env.PORTABLE_EXECUTABLE_DIR;
  if (!isPackaged || (!executable && !directory)) return null;
  if (!executable || !directory || !path.isAbsolute(executable) || !path.isAbsolute(directory) ||
      !samePath(path.dirname(executable), directory) || path.extname(executable).toLowerCase() !== ".exe") {
    throw new Error("便携版启动路径无效，已阻止读取现有账户。");
  }
  assertNoLinkedAncestor(executable, fileSystem);
  if (!fileSystem.lstatSync(executable).isFile()) throw new Error("便携版启动文件不存在。");
  const name = path.basename(executable, path.extname(executable));
  const appData = path.join(directory, `${name}.data`, "appdata");
  assertNoLinkedAncestor(appData, fileSystem);
  return appData;
}
function initializeIsolatedRuntime(app, options = {}) {
  if (!profile.isolated) return null;
  const env = options.env || process.env;
  const fileSystem = options.fs || fs;
  const requestedUserData = app.commandLine.getSwitchValue("user-data-dir");
  const fixtureAppData = acceptanceAppData({ isPackaged: app.isPackaged, requestedUserData, env, fileSystem });
  const selectedAppData = fixtureAppData || portableAppData({ isPackaged: app.isPackaged, env, fileSystem });
  const roots = isolatedPaths({
    appData: selectedAppData || app.getPath("appData"),
    desktopRoot: options.desktopRoot || path.resolve(__dirname, ".."),
    isPackaged: app.isPackaged,
    requestedUserData,
  });
  // Validate before any config read, migration, service construction or instance lock.
  assertNoLinkedAncestor(roots.userData, fileSystem);
  assertNoLinkedAncestor(roots.runtime, fileSystem);
  fileSystem.mkdirSync(roots.userData, { recursive: true });
  assertNoLinkedAncestor(roots.userData, fileSystem);
  if (selectedAppData) app.setPath("appData", selectedAppData);
  app.setPath("userData", roots.userData);
  app.setPath("sessionData", roots.userData);
  const clean = isolatedEnvironment(env, roots.runtime);
  for (const key of Object.keys(env)) if (controlledKey(key)) delete env[key];
  Object.assign(env, clean);
  app.setAppUserModelId(resolveTaskbarAppId(profile.appId, {
    isPackaged: app.isPackaged,
    portableExecutable: env.PORTABLE_EXECUTABLE_FILE || "",
  }));
  // This override exists only after the nonce, ancestry and expiry checks above.
  // Normal Portable launches retain their Windows notification registration.
  return fixtureAppData ? { ...roots, notificationAppDataDir: fixtureAppData } : roots;
}

module.exports = { DATA_NAME, isolatedPaths, isolatedEnvironment, initializeIsolatedRuntime, assertNoLinkedAncestor };
