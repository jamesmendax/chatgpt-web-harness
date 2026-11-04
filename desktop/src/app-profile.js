"use strict";
// Keep preview builds separate from the user's installed desktop and credentials.
const metadata = require("../package.json");

function resolveAppProfile(pkg = metadata) {
  const isolated = pkg.harnessVariant === "isolated";
  return Object.freeze({
    isolated,
    displayName: isolated ? "ChatGPT Web Harness Isolated" : "ChatGPT Web Harness",
    appId: isolated ? "com.chatgpt-web-harness.isolated" : "com.chatgpt-web-harness.desktop",
    allowLegacyMigration: !isolated,
    userDataBasenames: Object.freeze(isolated
      ? ["chatgpt-web-harness-isolated", "chatgpt web harness isolated"]
      : ["chatgpt-web-harness-desktop", "chatgpt web harness"]),
    defaultPorts: Object.freeze(isolated
      ? { mcpPort: 3300, adminPort: 3301, tunnelPort: 8380 }
      : { mcpPort: 3000, adminPort: 3001, tunnelPort: 8080 }),
  });
}

module.exports = { profile: resolveAppProfile(), resolveAppProfile };
