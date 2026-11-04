"use strict";
// This version describes the *application storage contract*, not Electron's
// internal cipher algorithm or any release number. New EXE filenames must not
// be used to choose credential decryption.
const CURRENT = Object.freeze({
  schema: 1,
  provider: "electron-safe-storage",
  encoding: "base64",
  scope: "electron-user-data",
});
const SUPPORTED = new Set(["electron-safe-storage"]);
function describe(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("账户配置格式无效，已拒绝读取密钥。");
  }
  if (!Object.prototype.hasOwnProperty.call(raw, "credentialFormat")) {
    // 3.0.2 and older deployments stored the same Electron safeStorage bytes
    // directly as base64 without an explicit descriptor.
    return { ...CURRENT, schema: 0, legacy: true };
  }
  const value = raw.credentialFormat;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isSafeInteger(value.schema) ||
      value.schema !== CURRENT.schema ||
      !SUPPORTED.has(value.provider) ||
      value.provider !== CURRENT.provider ||
      value.encoding !== CURRENT.encoding ||
      value.scope !== CURRENT.scope) {
    const error = new Error("来源账户采用当前版本不支持的密钥存储格式，请使用支持该格式的版本导入；原配置未修改。");
    error.code = "UNSUPPORTED_CREDENTIAL_FORMAT";
    throw error;
  }
  return { ...CURRENT, legacy: false };
}
function markForSave(config) {
  const meta = describe(config);
  if (!config.apiKeyEnc && !config.adminTokenEnc) {
    return { ...config };
  }
  // Unmarked legacy source data uses the exact same public safeStorage
  // contract; the marker records its storage contract, not a new key.
  return { ...config, credentialFormat: { ...CURRENT } };
}
module.exports = { CURRENT, describe, markForSave };
