"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = 4 * 60 * 60_000;
const REFRESH_WINDOW_MS = 10 * 60_000;
const records = new Map();

function normalizedAccountId(value) {
  const id = String(value || "default").trim();
  if (!/^(?:default|[a-f0-9]{32})$/.test(id)) throw new Error("Invalid Companion capability account id");
  return id;
}

function issue(accountId, options = {}) {
  const id = normalizedAccountId(accountId);
  const now = Number.isFinite(options.now) ? Math.trunc(options.now) : Date.now();
  const ttlMs = Number.isFinite(options.ttlMs)
    ? Math.min(Math.max(Math.trunc(options.ttlMs), 60_000), 24 * 60 * 60_000)
    : DEFAULT_TTL_MS;
  const existing = records.get(id);
  const expiring = !existing || Date.parse(existing.expires_at) - now <= REFRESH_WINDOW_MS;
  if (existing && !options.rotate && !(options.refreshIfExpiring && expiring) && Date.parse(existing.expires_at) > now) {
    return existing;
  }
  const record = Object.freeze({
    schema_version: 1,
    account_id: id,
    instance_id: `cpi_${crypto.randomBytes(16).toString("hex")}`,
    token: crypto.randomBytes(32).toString("base64url"),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
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
        catch (restoreError) { throw new Error(`Companion capability restore failed: ${restoreError.message}`); }
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

function materialize(file, record) {
  if (!record || record.schema_version !== 1 || !record.token || !record.instance_id) {
    throw new Error("Invalid Companion capability record");
  }
  return atomicWrite(file, record);
}

function revoke(accountId, file) {
  records.delete(normalizedAccountId(accountId));
  if (file) try { fs.rmSync(file, { force: true }); } catch {}
}

module.exports = { DEFAULT_TTL_MS, REFRESH_WINDOW_MS, issue, materialize, revoke };

