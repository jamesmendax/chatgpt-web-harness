"use strict";
const fs = require("node:fs");
const path = require("node:path");

function assertUnlinked(target, fileSystem) {
  const resolved = path.resolve(target), root = path.parse(resolved).root;
  let cursor = root;
  // Inspect ancestors before descending, so checking a missing leaf never
  // traverses an AppData junction before the guard sees that junction.
  for (const part of ["", ...resolved.slice(root.length).split(path.sep).filter(Boolean)]) {
    if (part) cursor = path.join(cursor, part);
    try {
      if (fileSystem.lstatSync(cursor).isSymbolicLink()) throw new Error("Notification shortcut path cannot use a symbolic link or junction.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function samePath(a, b) {
  return typeof a === "string" && typeof b === "string" && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Windows toast routing requires an installed per-user Start Menu shortcut.
// A portable shortcut must point to the stable outer EXE, not its cgh-* runtime.
function ensureNotificationShortcut({
  shell, appDataDir, executable, appId, displayName,
  platform = process.platform, fs: fileSystem = fs,
} = {}) {
  if (platform !== "win32") return { path: null, created: false, updated: false, skipped: true };
  if (typeof appDataDir !== "string" || !path.isAbsolute(appDataDir)) throw new Error("Notification appData directory must be absolute.");
  if (typeof executable !== "string" || !path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== ".exe") throw new Error("Notification executable must be an absolute EXE path.");
  if (typeof displayName !== "string" || !displayName.trim() || displayName !== displayName.trim() || displayName.length > 100 || /[<>:"/\\|?*\u0000-\u001f]/.test(displayName) || /[. ]$/.test(displayName)) throw new Error("Invalid notification shortcut display name.");
  if (typeof appId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(appId)) throw new Error("Invalid notification AppUserModelID.");
  if (typeof shell?.readShortcutLink !== "function" || typeof shell?.writeShortcutLink !== "function") throw new Error("Windows shortcut Shell APIs are unavailable.");
  const target = path.resolve(executable), startMenu = path.join(path.resolve(appDataDir), "Microsoft", "Windows", "Start Menu", "Programs");
  const suffix = appId.endsWith(".portable") ? " Portable" : "";
  const shortcut = path.join(startMenu, `${displayName}${suffix}.lnk`);
  for (const candidate of [appDataDir, target, shortcut]) assertUnlinked(candidate, fileSystem);
  if (!fileSystem.statSync(target).isFile()) throw new Error("Notification target is not a regular executable.");
  let existing = null;
  if (fileSystem.existsSync(shortcut)) {
    if (!fileSystem.statSync(shortcut).isFile()) throw new Error("Notification shortcut path is not a regular file.");
    try { existing = shell.readShortcutLink(shortcut); }
    catch { throw new Error("Cannot inspect the existing notification shortcut; it was left unchanged."); }
    if (existing?.appUserModelId !== appId) throw new Error("Notification shortcut belongs to another AppUserModelID; it was left unchanged.");
    if (samePath(existing.target, target)) return { path: shortcut, created: false, updated: false, skipped: false };
  }
  fileSystem.mkdirSync(startMenu, { recursive: true });
  assertUnlinked(shortcut, fileSystem);
  const details = { target, cwd: path.dirname(target), icon: target, iconIndex: 0, appUserModelId: appId };
  // Updating only owned target/identity fields preserves arguments, description,
  // activation CLSID and other fields already present on a same-AppID link.
  if (!existing) { details.args = ""; details.description = displayName; }
  const operation = existing ? "update" : "create";
  if (shell.writeShortcutLink(shortcut, operation, details) !== true) throw new Error("Could not write the Windows notification shortcut.");
  let actual;
  try { actual = shell.readShortcutLink(shortcut); }
  catch { throw new Error("Could not verify Windows notification shortcut readback."); }
  if (actual.appUserModelId !== appId || !samePath(actual.target, target)) throw new Error("Windows notification shortcut readback does not match the requested target and AppID.");
  return { path: shortcut, created: !existing, updated: Boolean(existing), skipped: false };
}

module.exports = { ensureNotificationShortcut };
