"use strict";
const { pathToFileURL } = require("node:url");

function auraUrl(file) {
  const url = pathToFileURL(file);
  url.searchParams.set("desktop", "1");
  return url.href;
}

function isTrustedIpcSource(event, window, expectedUrl) {
  if (!window || window.isDestroyed() || !event || !window.webContents) return false;
  const contents = window.webContents;
  if (contents.isDestroyed?.() || event.sender !== contents || !contents.mainFrame || event.senderFrame !== contents.mainFrame) return false;
  // Aura uses history.replaceState to retain the current view. It does not
  // navigate to another document; accept only its four exact view URLs.
  const actual = event.senderFrame.url;
  return contents.getURL() === actual && (actual === expectedUrl ||
    ["workspace", "skills", "logs", "settings"].some(view => actual === `${expectedUrl}&sheet=${view}`));
}

function installNavigationGuard(contents, expectedUrl) {
  const guard = (event, legacyUrl) => {
    const url = typeof event.url === "string" ? event.url : legacyUrl;
    // The main process may switch to its exact safe-graphics Aura URL after
    // renderer memory pressure; this does not allow arbitrary file navigation.
    const allowedUrl = typeof expectedUrl === "function" ? expectedUrl() : expectedUrl;
    if (url !== allowedUrl) event.preventDefault();
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-frame-navigate", guard);
}
module.exports = { auraUrl, isTrustedIpcSource, installNavigationGuard };
