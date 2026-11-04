"use strict";
const fs = require("node:fs");
const path = require("node:path");

// A portable launch must not inherit the installed/legacy taskbar group's icon.
// Keep its identity stable across wrapper renames, extraction paths and upgrades.
function resolveTaskbarAppId(baseAppId, {
  isPackaged = false,
  portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE,
} = {}) {
  if (!isPackaged || typeof portableExecutable !== "string" || !path.isAbsolute(portableExecutable)) return baseAppId;
  try {
    if (!fs.statSync(portableExecutable).isFile()) return baseAppId;
  } catch {
    return baseAppId;
  }
  return baseAppId.endsWith(".portable") ? baseAppId : `${baseAppId}.portable`;
}

// The taskbar group uses Shell properties, independently of BrowserWindow.icon.
// Portable extraction paths disappear on exit; its outer EXE is the stable
// relaunch target and already contains the same Aura icon resource.
function applyTaskbarIdentity(window, {
  appId,
  displayName,
  platform = process.platform,
  execPath = process.execPath,
  portableExecutable = process.env.PORTABLE_EXECUTABLE_FILE,
} = {}) {
  if (platform !== "win32") return;
  const executable = portableExecutable || execPath;
  window.setAppDetails({
    appId,
    appIconPath: executable,
    appIconIndex: 0,
    relaunchCommand: `"${executable}"`,
    relaunchDisplayName: displayName,
  });
}

module.exports = { applyTaskbarIdentity, resolveTaskbarAppId };
