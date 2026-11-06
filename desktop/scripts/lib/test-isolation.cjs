"use strict";
// Test-owned filesystem and loopback endpoints. This file is never loaded by the app.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const repo = path.resolve(__dirname, "../../..");
const componentElectronTests = Object.freeze([
  "smoke.js", "test-setup-runtime.cjs", "test-account-setup-ui.cjs", "test-account-import-ui.cjs",
  "test-migration.js", "test-node-shim.js", "test-isolated-ui.cjs", "test-aura-boot.cjs",
  "test-aura-ui.cjs", "test-aura-feedback.cjs", "test-aura-preferences.cjs",
  "test-renderer-memory-recovery.cjs", "test-aura-quality-ui.cjs",
]);

function artifactRoot(label) {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid test artifact label");
  const base = path.resolve(process.env.HARNESS_TEST_OUTPUT_ROOT || path.join(repo, ".validation", "desktop-fixtures"));
  if (!base.split(path.sep).includes(".validation")) throw new Error("Desktop test output must be inside a .validation directory");
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, label + "-"));
}

async function privatePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

function initialPorts() {
  const ports = JSON.parse(process.env.HARNESS_TEST_INITIAL_PORTS || "null");
  if (!Array.isArray(ports) || ports.length !== 3 || new Set(ports).size !== 3 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) {
    throw new Error("Run this Electron fixture with scripts/run-electron.cjs; private initial ports are required");
  }
  return ports;
}

module.exports = { artifactRoot, privatePorts, initialPorts, componentElectronTests };
