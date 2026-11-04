"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = 60 * 60_000;
const REFRESH_WINDOW_MS = 5 * 60_000;
const records = new Map();

function normalizedAccountId(value) {
  const id = String(value || "default").trim();
  if (!/^(?:default|[a-f0-9]{32})$/.test(id)) throw new Error("Invalid Computer Use capability account id");
  return id;
}

function issue(accountId, helperSha256, options = {}) {
  const id = normalizedAccountId(accountId);
  const hash = String(helperSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid Computer Use helper SHA-256");
  const now = Number.isFinite(options.now) ? Math.trunc(options.now) : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.min(Math.max(Math.trunc(options.ttlMs), 60_000), 4 * 60 * 60_000)
    : DEFAULT_TTL_MS;
  const existing = records.get(id);
  const expiring = !existing || Date.parse(existing.expires_at) - now <= REFRESH_WINDOW_MS;
  if (existing && existing.helper_sha256 === hash && !options.rotate && !(options.refreshIfExpiring && expiring) && Date.parse(existing.expires_at) > now) {
    return existing;
  }
  const record = Object.freeze({
    schema_version: 1,
    provider: "computer-use",
    account_id: id,
    instance_id: `cui_${crypto.randomBytes(16).toString("hex")}`,
    token: crypto.randomBytes(32).toString("base64url"),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    helper_sha256: hash,
  });
  records.set(id, record);
  return record;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const backup = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.bak`;
  let movedOld = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, file); }
    catch (error) {
      if (!["EEXIST", "EPERM"].includes(error?.code) || !fs.existsSync(file)) throw error;
      fs.renameSync(file, backup);
      movedOld = true;
      try { fs.renameSync(temporary, file); }
      catch (publishError) {
        try { fs.renameSync(backup, file); movedOld = false; }
        catch (restoreError) { throw new Error(`Computer Use capability restore failed: ${restoreError.message}`); }
        throw publishError;
      }
    }
    try { fs.chmodSync(file, 0o600); } catch {}
    if (movedOld) try { fs.rmSync(backup, { force: true }); } catch {}
    return file;
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

// Renewal belongs to the Desktop process that issued the live capability.
// Keep its identity: the running MCP has the token/instance in immutable env.
// A revoked capability can only be recreated by an explicit MCP start.
function renew(accountId, helperSha256, options = {}) {
  const id = normalizedAccountId(accountId);
  const existing = records.get(id);
  if (!existing) return null;
  if (existing.helper_sha256 !== String(helperSha256).trim().toLowerCase()) {
    throw new Error("Computer Use helper changed; restart MCP to provision the new helper");
  }
  const now = Number.isFinite(options.now) ? Math.trunc(options.now) : Date.now();
  if (Date.parse(existing.expires_at) - now > REFRESH_WINDOW_MS) return existing;
  const next = Object.freeze({ ...existing, expires_at: new Date(now + DEFAULT_TTL_MS).toISOString() });
  records.set(id, next);
  return next;
}

function materialize(file, record) {
  if (!record || record.schema_version !== 1 || record.provider !== "computer-use" || !record.token || !record.instance_id) {
    throw new Error("Invalid Computer Use capability record");
  }
  return atomicWrite(file, record);
}

function revoke(accountId, file) {
  records.delete(normalizedAccountId(accountId));
  if (file) try { fs.rmSync(file, { force: true }); } catch {}
}

module.exports = { DEFAULT_TTL_MS, REFRESH_WINDOW_MS, issue, renew, materialize, revoke };
