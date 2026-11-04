"use strict";
// 启动器配置：普通字段明文保存在 userData/config.json；Runtime API Key 用 Electron safeStorage
// （Windows 下即 DPAPI，绑定当前用户）加密后以 base64 存放，绝不明文落盘、绝不回传渲染进程。
const { safeStorage } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { configPath } = require("./paths");
const { profile } = require("./app-profile");
const accountContext = require("./account-context");
const credentialFormat = require("./credential-format");

const DEFAULTS = Object.freeze({
  version: 1,
  setupDone: false,
  tunnelId: "",
  apiKeyEnc: "",
  workspacePath: "",
  ...profile.defaultPorts,
  tunnelProxyMode: "auto",
  tunnelProxyUrl: "",
  toolProfile: "slim",
  autoStart: false,
  minimizeToTray: true,
  idleReminderMinutes: 5,
  notificationSound: "glass",
  notificationVolume: 100,
});

const TUNNEL_ID_RE = /^tunnel_[0-9a-f]{32}$/;

function load() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid configuration object");
    credentialFormat.describe(parsed);
    const config = { ...DEFAULTS, ...parsed };
    // Retire old feature flags in memory, without rewriting the source file
    // merely because a legacy account was opened.
    for (const key of ["relayEnabled", "relayAutomationEnabled", "relayAutoRecoveryEnabled"]) delete config[key];
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULTS };
    const failure = new Error(`无法读取启动器配置（${error.code || "INVALID_JSON"}）。原配置未被重置；请检查文件权限或恢复有效配置。`);
    failure.code = "CONFIG_READ_FAILED";
    throw failure;
  }
}

function save(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.${process.pid}.${Date.now()}.bak`;
  let movedOld = false;
  let published = false;
  try {
    const stored = credentialFormat.markForSave(config);
    for (const key of ["relayEnabled", "relayAutomationEnabled", "relayAutoRecoveryEnabled"]) delete stored[key];
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), "utf8");
    try {
      fs.renameSync(tmp, file);
      published = true;
    } catch (error) {
      if (!error || !["EEXIST", "EPERM"].includes(error.code)) throw error;
      if (!fs.existsSync(file)) throw error;
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

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptKey(plain) {
  if (!encryptionAvailable()) {
    throw new Error("当前系统不支持安全存储（safeStorage 不可用），无法保存 Runtime API Key。");
  }
  return safeStorage.encryptString(plain).toString("base64");
}

function decryptKey(config) {
  if (!config.apiKeyEnc) return "";
  if (!encryptionAvailable()) {
    throw new Error("safeStorage 不可用，无法解密已保存的 Runtime API Key。");
  }
  return safeStorage.decryptString(Buffer.from(config.apiKeyEnc, "base64"));
}

function decryptAdminToken(config) {
  if (!config.adminTokenEnc) return "";
  if (!encryptionAvailable()) {
    throw new Error("safeStorage 不可用，无法解密已保存的 Admin token。");
  }
  try {
    return safeStorage.decryptString(Buffer.from(config.adminTokenEnc, "base64"));
  } catch (error) {
    throw new Error(`已保存的 Admin token 无法解密: ${error.message}`);
  }
}

/**
 * Resolve the loopback Admin bearer token.  ADMIN_TOKEN is an explicit
 * process-level override for tests/operators; a normal packaged first run
 * receives a per-user random token encrypted by Electron safeStorage.
 */
function getAdminToken(config) {
  const override = profile.isolated || accountContext.current()?.id !== undefined ? "" : String(process.env.ADMIN_TOKEN || "").trim();
  return override || decryptAdminToken(config || {});
}

function ensureAdminToken(config) {
  const override = profile.isolated || accountContext.current()?.id !== undefined ? "" : String(process.env.ADMIN_TOKEN || "").trim();
  if (override) return override;
  const existing = decryptAdminToken(config || {});
  if (existing) return existing;
  if (!encryptionAvailable()) {
    throw new Error(profile.isolated
      ? "隔离版需要可用的系统安全存储来生成自己的 Admin token，不能借用父进程令牌。"
      : "当前系统不支持安全存储（safeStorage 不可用），无法生成 Admin token；请使用仅限测试的 ADMIN_TOKEN 环境变量。");
  }
  const token = crypto.randomBytes(32).toString("hex");
  config.adminTokenEnc = safeStorage.encryptString(token).toString("base64");
  return token;
}

/** 返回给渲染进程的安全视图：不包含密钥密文。 */
function publicView(config) {
  const { apiKeyEnc, adminTokenEnc, adminToken,
    relayEnabled, relayAutomationEnabled, relayAutoRecoveryEnabled, ...rest } = config;
  return { ...rest, hasApiKey: Boolean(apiKeyEnc) };
}

function validateTunnelId(value) {
  return TUNNEL_ID_RE.test(String(value || "").trim());
}

function validatePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

module.exports = {
  DEFAULTS,
  load,
  save,
  encryptKey,
  decryptKey,
  decryptAdminToken,
  getAdminToken,
  ensureAdminToken,
  publicView,
  validateTunnelId,
  validatePort,
  encryptionAvailable,
};
