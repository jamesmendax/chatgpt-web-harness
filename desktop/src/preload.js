"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("launcher", {
  listAccounts: invoke("accounts:list"),
  createAccount: invoke("accounts:create"),
  selectAccount: invoke("accounts:select"),
  renameAccount: invoke("accounts:rename"),
  removeAccount: invoke("accounts:remove"),
  inspectAccountImport: invoke("accounts:inspectImport"),
  importAccount: invoke("accounts:import"),
  appInfo: invoke("app:info"),
  getConfig: invoke("config:get"),
  saveConfig: invoke("config:save"),
  setIdleReminder: invoke("config:setIdleReminder"),
  listConversationNames: invoke("conversations:list"),
  renameConversation: invoke("conversations:rename"),
  pinConversation: invoke("conversations:pin"),
  clearInactiveConversations: invoke("conversations:clearInactive"),
  getNotificationSounds: invoke("notification:sounds"),
  selectNotificationSound: invoke("notification:selectSound"),
  setNotificationVolume: invoke("notification:setVolume"),
  previewNotificationSound: invoke("notification:preview"),
  importNotificationAudio: invoke("notification:importAudio"),
  importLegacyKey: invoke("config:importLegacyKey"),
  pickFolder: invoke("dialog:pickFolder"),
  runSetup: invoke("setup:run"),
  downloadTunnelClient: invoke("tunnel:download"),
  getStatus: invoke("status:get"),
  getSkillCatalog: invoke("skills:catalog"),
  saveSkillCatalog: invoke("skills:save"),
  pickSkillFile: invoke("skills:pickFile"),
  pickSkillFolder: invoke("skills:pickFolder"),
  pickSkillZip: invoke("skills:pickZip"),
  inspectSkillSource: invoke("skills:inspectSource"),
  discardSkillSource: invoke("skills:discardSource"),
  installSkill: invoke("skills:install"),
  uninstallSkill: invoke("skills:uninstall"),
  setSkillEnabled: invoke("skills:setEnabled"),
  setComputerUseEnabled: invoke("skills:setComputerUse"),
  setBrowserUseEnabled: invoke("skills:setBrowserUse"),
  resetProfiles: invoke("profiles:reset"),
  uninstallApp: invoke("app:uninstall"),
  startAll: invoke("services:startAll"),
  stopAll: invoke("services:stopAll"),
  startMcp: invoke("mcp:start"),
  stopMcp: invoke("mcp:stop"),
  restartMcp: invoke("mcp:restart"),
  startTunnel: invoke("tunnel:start"),
  stopTunnel: invoke("tunnel:stop"),
  stopExternal: invoke("services:stopExternal"),
  getLogs: invoke("logs:get"),
  clearLogs: invoke("logs:clear"),
  openLogFile: invoke("logs:openFile"),
  openExternal: invoke("shell:openExternal"),
  openLogsFolder: invoke("shell:openLogs"),
  openRuntimeFolder: invoke("shell:openRuntime"),
  copyText: invoke("clipboard:copy"),
  getGraphicsState: invoke("graphics:state"),
  restoreGraphics: invoke("graphics:restore"),
  on(channel, callback) {
    const allowed = new Set(["status", "log", "setup:progress", "notice", "accounts:changed"]);
    if (!allowed.has(channel)) return () => {};
    const listener = (_event, data) => callback(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

// Read-only memory attribution (V8 heap vs Blink) for the main-process memory
// guard's evidence file. No IPC, files or account data.
contextBridge.exposeInMainWorld("launcherDiagnostics", {
  memory() {
    const read = fn => { try { return fn(); } catch (error) { return { error: String((error && error.message) || error) }; } };
    return { heap: read(() => process.getHeapStatistics()), blink: read(() => process.getBlinkMemoryInfo()) };
  },
});
