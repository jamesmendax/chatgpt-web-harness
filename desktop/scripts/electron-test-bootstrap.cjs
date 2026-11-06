"use strict";
// The default Electron regression boundary. The real main/preload/renderer and
// safeStorage run; window visibility, native notifications and clipboard are
// component fixtures. This is not native desktop-input/clipboard acceptance.
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const { EventEmitter } = require("node:events");
const electron = require("electron");
const { initialPorts, componentElectronTests } = require("./lib/test-isolation.cjs");
const [,, entry, ...args] = process.argv;
const target = path.resolve(entry || "");
const desktop = path.resolve(__dirname, "..");
if (path.dirname(target) !== __dirname || !componentElectronTests.includes(path.basename(target))) throw new Error("Expected a default component Electron test entrypoint");
const scope = path.resolve(process.env.HARNESS_ELECTRON_TEST_SCOPE || "");
if (!scope.split(path.sep).includes(".validation")) throw new Error("Missing isolated Electron fixture scope");
const ports = initialPorts();
const initialConfigTest = /^(test-(?:aura-(?:boot|ui|feedback|quality-ui)|account-(?:setup|import)-ui|setup-runtime|isolated-ui|renderer-memory-recovery))\./.test(path.basename(target));
const configModuleFile = path.join(desktop, "src", "config.js");
const adaptedConfigs = new WeakSet();
function fixturePath(value) {
  const root = path.resolve(value), relative = path.relative(path.resolve(process.env.HARNESS_TEST_OUTPUT_ROOT), root);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("UI fixture escaped its output scope");
  return root;
}
let clipboardText = "";
const clipboard = { writeText(text) { clipboardText = String(text); }, readText() { return clipboardText; }, clear() { clipboardText = ""; } };
class HiddenWindow extends electron.BrowserWindow {
  constructor(options = {}) { super({ ...options, show: false, focusable: false }); }
  // Electron's native static filter excludes named subclasses. Keep discovery
  // tied to actual BrowserWindow instances, including further test subclasses.
  static getAllWindows() { return electron.BaseWindow.getAllWindows().filter(window => window instanceof electron.BrowserWindow); }
  static fromId(id) { const window = electron.BaseWindow.fromId(id); return window instanceof electron.BrowserWindow ? window : null; }
  show() {} showInactive() {} focus() {} moveTop() {} setAlwaysOnTop() {}
}
class FixtureTray extends EventEmitter { setToolTip() {} setContextMenu() {} destroy() {} }
class FixtureNotification extends EventEmitter { static isSupported() { return true; } show() { this.emit("show"); } close() { this.emit("close"); } }
const patchedElectron = { ...electron, BrowserWindow: HiddenWindow, Tray: FixtureTray, Notification: FixtureNotification, clipboard };
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === "electron" && parent?.filename.startsWith(desktop + path.sep)) return patchedElectron;
  const result = load.call(this, request, parent, isMain);
  if (initialConfigTest && result && result === require.cache[configModuleFile]?.exports && !adaptedConfigs.has(result)) {
    adaptedConfigs.add(result);
    const realLoad = result.load;
    result.load = function(...args) {
      const file = fixturePath(require("../src/paths").configPath());
      const existed = fs.existsSync(file);
      const config = realLoad.apply(this, args);
      const accountId = require("../src/account-context").current()?.id;
      // Supply only absent default-account configuration with private ports.
      // Never prewrite config.json: AccountManager intentionally treats an
      // existing config without accounts.json as a legacy default account.
      // Existing/imported profiles and the frozen production DEFAULTS remain
      // untouched, and real bootstrap persists its own config normally.
      return !existed && (!accountId || accountId === "default")
        ? { ...config, mcpPort: ports[0], adminPort: ports[1], tunnelPort: ports[2] }
        : config;
    };
  }
  return result;
};
const setPath = electron.app.setPath.bind(electron.app);
electron.app.setPath = (name, value) => {
  setPath(name, value);
  if (name === "userData" && initialConfigTest) {
    fs.mkdirSync(fixturePath(value), { recursive: true });
  }
};
fs.mkdirSync(path.join(scope, "appdata"), { recursive: true });
fs.mkdirSync(path.join(scope, "userData"), { recursive: true });
setPath("appData", path.join(scope, "appdata"));
setPath("userData", path.join(scope, "userData"));
electron.app.on("browser-window-created", (_event, window) => {
  window.on("show", () => { throw new Error("Default desktop regression unexpectedly showed a native window"); });
});
process.argv = [process.execPath, target, ...args];
console.log("DESKTOP_COMPONENT_BOUNDARY " + JSON.stringify({ target: path.basename(target), scope, hidden: true, clipboard: "in-memory", initialPorts: ports,
  freshConfig: "private ports in memory only when default config is absent", nativeInputAcceptance: false }));
require(target);
