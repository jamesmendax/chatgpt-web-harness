"use strict";

const fs = require("fs");
const path = require("path");

const BOOTSTRAP_FILE = "runtime-bootstrap.json";

function normalizeLoopbackBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("Companion bootstrap endpoint is required");
  let url;
  try { url = new URL(raw); }
  catch { throw new Error("Companion bootstrap endpoint is not a valid URL"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Companion bootstrap endpoint must use http://127.0.0.1");
  }
  if (!/^\/companion\/v[12]$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error("Companion bootstrap endpoint must end with /companion/v1 or /companion/v2 and contain no credentials/query/hash");
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Companion bootstrap endpoint requires an explicit valid port");
  return `${url.protocol}//${url.hostname}:${port}${url.pathname}`;
}

function atomicWriteBootstrap(extensionDir, value) {
  fs.mkdirSync(extensionDir, { recursive: true });
  const file = path.join(extensionDir, BOOTSTRAP_FILE);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    return file;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function writeRuntimeBootstrap(extensionDir, input) {
  const token = String(input?.token || "").trim();
  if (!token) throw new Error("Companion bootstrap token is required");
  const baseUrl = normalizeLoopbackBaseUrl(input?.baseUrl);
  const value = {
    schema_version: 1,
    base_url: baseUrl,
    token,
    instance_id: input?.instanceId ? String(input.instanceId).slice(0, 128) : null,
    expires_at: input?.expiresAt ? String(input.expiresAt).slice(0, 64) : null,
    account_id: input?.accountId ? String(input.accountId).slice(0, 256) : null,
    app_version: input?.appVersion ? String(input.appVersion).slice(0, 64) : null,
    generated_at: new Date().toISOString(),
  };
  return { file: atomicWriteBootstrap(extensionDir, value), value };
}

function removeRuntimeBootstrap(extensionDir) {
  const file = path.join(extensionDir, BOOTSTRAP_FILE);
  try { fs.rmSync(file, { force: true }); } catch {}
  return file;
}

module.exports = {
  BOOTSTRAP_FILE,
  normalizeLoopbackBaseUrl,
  writeRuntimeBootstrap,
  removeRuntimeBootstrap,
};
