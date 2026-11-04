"use strict";

const accountContext = require("./account-context");
const paths = require("./paths");
const bootstrap = require("./companion-bootstrap");
const capabilities = require("./companion-capability");

function accountId() { return accountContext.current()?.id || "default"; }

function revoke() {
  capabilities.revoke(accountId(), paths.companionCapabilityPath());
  bootstrap.removeRuntimeBootstrap(paths.browserCompanionDir());
}

function prepare(config, options = {}) {
  const extensionDir = paths.materializeBrowserCompanion();
  if (config?.relayEnabled !== true) {
    revoke();
    return { extensionDir, paired: false, credential: null };
  }
  const credential = capabilities.issue(accountId(), {
    rotate: options.rotate === true,
    refreshIfExpiring: options.refreshIfExpiring === true,
  });
  capabilities.materialize(paths.companionCapabilityPath(), credential);
  const companionApi = `http://127.0.0.1:${config.adminPort}/companion/v1`;
  bootstrap.writeRuntimeBootstrap(extensionDir, {
    baseUrl: companionApi,
    token: credential.token,
    instanceId: credential.instance_id,
    expiresAt: credential.expires_at,
    accountId: accountId(),
    appVersion: options.appVersion,
  });
  return { extensionDir, companionApi, paired: true, credential };
}

module.exports = { prepare, revoke };
