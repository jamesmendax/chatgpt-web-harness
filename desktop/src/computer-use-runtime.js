"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const accountContext = require("./account-context");
const paths = require("./paths");
const capabilities = require("./computer-use-capability");

function accountId() { return accountContext.current()?.id || "default"; }

function enabled() {
  try {
    const file = path.join(paths.runtimeDir(), "profiles", "plugins.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).computer_use?.enabled === true;
  } catch { return false; }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function revoke() {
  capabilities.revoke(accountId(), paths.computerUseCapabilityPath());
}

function prepare(options = {}) {
  const helper = paths.computerUseHelperPath();
  if (!enabled()) {
    revoke();
    return { enabled: false, credential: null, helper };
  }
  if (!fs.existsSync(helper) || !fs.statSync(helper).isFile()) throw new Error(`Computer Use helper is missing: ${helper}`);
  const helperSha256 = sha256(helper);
  const credential = capabilities.issue(accountId(), helperSha256, {
    rotate: options.rotate === true,
    refreshIfExpiring: options.refreshIfExpiring === true,
  });
  capabilities.materialize(paths.computerUseCapabilityPath(), credential);
  return { enabled: true, credential, helper, helperSha256 };
}

function refresh() {
  if (!enabled()) { revoke(); return; }
  const helper = paths.computerUseHelperPath();
  const credential = capabilities.renew(accountId(), sha256(helper));
  if (!credential) return;
  const file = paths.computerUseCapabilityPath();
  let previous;
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  if (previous?.expires_at !== credential.expires_at || previous?.token !== credential.token) {
    capabilities.materialize(file, credential);
  }
}

module.exports = { enabled, prepare, refresh, revoke };
