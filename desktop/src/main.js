"use strict";
// Private one-shot source-context decryption helper. It must bypass the app
// startup, single-instance lock and all account/service initialization.
if (process.argv.includes("--wh-internal-crypto-bridge")) {
  require("./legacy-crypto-worker").run();
  return;
}
const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, nativeTheme, clipboard, powerMonitor } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { iconPath, createTrayIcon } = require("./app-icons");
const { applyTaskbarIdentity, resolveTaskbarAppId } = require("./taskbar-identity");
const { createIdleNotifier } = require("./idle-notification");
const { createNotificationSound } = require("./notification-sound");
const { SOUND_CHOICES, SOUND_IDS } = require("./notification-sound");
const { customPath, importCustomWav } = require("./notification-audio-store");
const { ensureNotificationShortcut } = require("./notification-identity");
// Capture the Windows roaming folder before a portable profile changes paths.
const notificationAppDataDir = app.getPath("appData");

const { profile } = require("./app-profile");
if (profile.isolated) {
  try { require("./isolated-runtime").initializeIsolatedRuntime(app); }
  catch (error) {
    dialog.showErrorBox("隔离版启动被阻止", error.message);
    app.exit(1);
    return;
  }
}
const taskbarAppId = resolveTaskbarAppId(profile.appId, { isPackaged: app.isPackaged });
const paths = require("./paths");
const configStore = require("./config");
const computerUseRuntime = require("./computer-use-runtime");
const { validateProxyUrl, validateProxySettings } = require("./tunnel-proxy");
const legacy = require("./legacy");
const { AccountManager } = require("./accounts");
const accountContext = require("./account-context");
const skills = require("./skills");
const { MAX_ZIP_BYTES, MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES, assertExtractedTreeContained } = require("./zip-safety");
const { psQuote, runPowershell } = require("./shell-util");
const { IdleWatch, IDLE_REMINDER_CHOICES, reminderMinutes } = require("./idle-watch");
const { ConversationIndex } = require("./conversation-index");
const { auraUrl, isTrustedIpcSource, installNavigationGuard } = require("./ipc-source");
const auraFile = path.join(__dirname, "..", "renderer", "v3", "aura", "index.html");
const expectedAuraUrl = auraUrl(auraFile);

const APP_NAME = profile.displayName;
let mainWindow = null;
let tray = null;
let quitting = false;
let statusTimer = null;
let lastComputerUseRefreshAt = 0;
let powerRecoveryRegistered = false;
let lastPowerRecoveryAt = 0;
const accounts = new AccountManager({ app });
const conversationIndex = new ConversationIndex({ rootFor: id => accounts.scope(id).dataDir });
const services = accounts.services;
const feeds = accounts.feeds;
// 每个账户、每个 ChatGPT 对话各自计时：开始调用工具后静默满设定时间，提醒一次。
const idleWatch = new IdleWatch({
  minutesFor: (id) => reminderMinutes(accounts.readConfig(id)),
  onRemind: (reminder, delivery) => remindIdle(reminder, delivery),
});
let idleTimer = null;
let conversationCleanupTimer = null;
function cleanupConversationIndexes() {
  if (!accounts.registry) return;
  for (const row of accounts.registry.accounts) {
    try { conversationIndex.cleanup(row.id); }
    catch (error) {
      try { accounts.run(row.id, () => services.note("[提醒] 旧会话显示缓存清理失败：" + error.message)); }
      catch { /* a bad profile must not prevent other accounts */ }
    }
  }
}
const pendingSkillSourcesByAccount = new Map();
function skillSources() {
  const id = accounts.currentId;
  if (!pendingSkillSourcesByAccount.has(id)) pendingSkillSourcesByAccount.set(id, new Set());
  return pendingSkillSourcesByAccount.get(id);
}

function refreshAllComputerUseRuntimes() {
  for (const [id, item] of accounts.instances) {
    if (!item.services.mcp.isAlive()) continue;
    try { accounts.run(id, () => computerUseRuntime.refresh()); }
    catch (error) {
      item.services.note(`Computer Use renewal failed: ${error.message}`);
    }
  }
}

function registerPowerRecovery() {
  if (powerRecoveryRegistered) return;
  powerRecoveryRegistered = true;
  const refreshAfterResume = () => {
    const now = Date.now();
    if (now - lastPowerRecoveryAt < 1_000) return;
    lastPowerRecoveryAt = now;
    refreshAllComputerUseRuntimes();
  };
  powerMonitor.on("resume", refreshAfterResume);
  powerMonitor.on("unlock-screen", refreshAfterResume);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    try {
      // Validate the extracted resources before any window or managed service
      // is created.  This turns a partial portable copy into an observable
      // startup failure instead of a UI with broken dynamic imports.
      paths.validatePackagedPayload();
    } catch (error) {
      dialog.showErrorBox("ChatGPT Web Harness 启动失败", `安装包解包不完整，已阻止启动。\n\n${error.message}`);
      app.quit();
      return;
    }
    try {
      accounts.init();
      accounts.run(accounts.selectedId, () => bootstrap()).catch((error) => {
        dialog.showErrorBox("账号初始化失败", error.message);
        app.quit();
      });
    } catch (error) {
      dialog.showErrorBox("账号索引读取失败", error.message);
      app.quit();
    }
  });
}

function createWindow() {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    show: false,
    icon: icon || undefined,
    // Aura follows the Windows light/dark setting by default; match it before the first paint.
    backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? "#0c0d12" : "#faf9f6",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (app.isPackaged) applyTaskbarIdentity(mainWindow, { appId: taskbarAppId, displayName: APP_NAME });
  mainWindow.setMenuBarVisibility(false);
  installNavigationGuard(mainWindow.webContents, expectedAuraUrl);
  mainWindow.loadFile(auraFile, {
    query: { desktop: "1" },
  });
  mainWindow.show();
  mainWindow.on("close", (event) => {
    if (quitting) return;
    let cfg;
    try {
      cfg = accounts.readConfig(accounts.selectedId);
    } catch (error) {
      notice("error", `配置读取失败，无法判断窗口关闭策略: ${error.message}`);
      return;
    }
    const anyManaged = accounts.anyAlive();
    if (cfg.minimizeToTray && anyManaged && tray) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    // 服务未运行时关闭窗口即退出。
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function createTray() {
  const image = createTrayIcon(nativeImage);
  if (!image || image.isEmpty()) return;
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示窗口", click: showWindow },
    { type: "separator" },
    { label: "启动当前账号", click: () => accounts.run(accounts.selectedId, async () => services.startAll()).catch((e) => notice("error", e.message)) },
    { label: "停止当前账号", click: () => accounts.run(accounts.selectedId, async () => { idleWatch.forget(accounts.selectedId); return services.stopAll(); }).catch((e) => notice("error", e.message)) },
    { type: "separator" },
    { label: "退出（停止本程序管理的所有账号）", click: () => requestQuit() },
  ]));
  tray.on("click", showWindow);
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function send(channel, payload) {
  if (payload && !Array.isArray(payload) && !payload.accountId && ["notice", "setup:progress"].includes(channel)) {
    payload = { ...payload, accountId: accountContext.current()?.id || accounts.selectedId };
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function notice(level, message) {
  send("notice", { level, message, at: Date.now() });
}

function remindIdle({ accountId, conversation, tool, summary, lastAt, idleMinutes }, { attempt = 1 } = {}) {
  if (quitting) return false;
  let name;
  try { name = accounts.record(accountId).name; } catch { return false; }
  const clock = new Date(lastAt).toLocaleTimeString("en-GB", { hour12: false }).slice(0, 5);
  let display = null;
  try { display = conversationIndex.lookup(accountId, conversation); } catch { /* still notify */ }
  const title = display
    ? `账户「${name}」 · ${display.display} · ${idleMinutes} 分钟未调用工具`
    : conversation ? `账户「${name}」 · 未命名会话 · ${idleMinutes} 分钟未调用工具`
      : `账户「${name}」已 ${idleMinutes} 分钟没有调用工具`;
  const last = `最后一次是 ${clock} 的 ${tool}${summary ? `（${summary}）` : ""}`;
  const body = conversation ? `账户「${name}」，${last}。` : `${last}。`;
  try { accounts.run(accountId, () => services.note(`[提醒] ${title}。${body}`)); } catch {}
  send("notice", { accountId, level: "info", message: `${title}。${body}`, at: Date.now() });
  const visible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  if (visible && !mainWindow.isFocused()) {
    mainWindow.flashFrame(true);
    mainWindow.once("focus", () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(false); });
  }
  return showSystemNotice(title, body, accountId, attempt === 1);
}

const reminderSound = createNotificationSound({
  getSelection: accountId => {
    const id = accountId || accounts.selectedId;
    const cfg = accounts.readConfig(id);
    return { id: cfg.notificationSound || "glass", volume: cfg.notificationVolume ?? 100,
      customPath: customPath(accounts.scope(id).dataDir) };
  },
});
const idleNotifier = createIdleNotifier({ Notification, playReminderSound: accountId => reminderSound.play(accountId), getTray: () => tray, iconPath, showWindow });
function showSystemNotice(title, body, accountId, playSound) {
  const messages = {
    "sound-requested": "已请求播放专属清脆提示音", "sound-played": "专属提示音播放调用已完成", "sound-failed": "专属提示音播放失败",
    "native-shown": "Windows 已接收通知", "native-failed": "Windows 通知失败",
    "balloon-shown": "托盘提醒已显示", "balloon-failed": "托盘提醒失败",
    "delivery-failed": "提醒未送达，本次空档最多尝试三次",
  };
  return idleNotifier.show({ title, body, accountId, playSound, log: (event, detail) => {
    try { accounts.run(accountId, () => services.note(`[提醒通知] ${messages[event] || event}${detail ? `：${detail}` : ""}`)); } catch {}
  } });
}

function pathInside(parent, target) {
  const base = path.resolve(parent);
  const candidate = path.resolve(target);
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function localSkillsDir() {
  return path.join(paths.runtimeDir(), "profiles", "local-skills");
}

function isTemporarySkillPath(value) {
  const resolved = path.resolve(value);
  return pathInside(localSkillsDir(), resolved) && /^\.staging-(?:extract-)?/i.test(path.basename(resolved));
}

function discardTemporarySkillPath(value) {
  if (!value || !isTemporarySkillPath(value)) return false;
  skillSources().delete(path.resolve(value));
  fs.rmSync(path.resolve(value), { recursive: true, force: true });
  return true;
}

function cleanupTemporarySkillSources() {
  for (const source of [...skillSources()]) discardTemporarySkillPath(source);
  const root = localSkillsDir();
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.staging-(?:extract-)?/i.test(entry.name)) {
      discardTemporarySkillPath(path.join(root, entry.name));
    }
  }
}

async function assertZipArchiveSafe(source) {
  const archiveSize = fs.lstatSync(source).size;
  if (archiveSize > MAX_ZIP_BYTES) throw new Error(`Skill 压缩包过大（上限 ${MAX_ZIP_BYTES} 字节）。`);
  // Validate central-directory names before Expand-Archive creates anything.
  // The PowerShell check is intentionally fail-closed and emits no entry
  // names, avoiding unbounded output for hostile archives.
  await runPowershell([
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$zip = [IO.Compression.ZipFile]::OpenRead('${psQuote(source)}')`,
    "try {",
    "  $count = 0",
    "  $total = [Int64]0",
    "  foreach ($entry in $zip.Entries) {",
    "    $count++",
    `    if ($count -gt ${MAX_ZIP_ENTRIES}) { throw '压缩包条目过多' }`,
    "    $name = $entry.FullName.Replace('\\', '/')",
    "    $parts = $name.Split('/')",
    "    if ([string]::IsNullOrWhiteSpace($name) -or $name.StartsWith('/') -or $name.StartsWith('//') -or $name -match '^[A-Za-z]:' -or $name.IndexOf([char]0) -ge 0) { throw ('压缩包包含不安全路径') }",
    "    for ($i = 0; $i -lt $parts.Length; $i++) {",
    "      $part = $parts[$i]",
    "      if ($i -lt ($parts.Length - 1) -and [string]::IsNullOrEmpty($part)) { throw ('压缩包包含不安全路径') }",
    "      if ($part -and ($part -eq '.' -or $part -eq '..' -or $part -match '[<>:\"|?*]' -or $part -match '[ .]$' -or $part -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$')) { throw ('压缩包包含不安全路径') }",
    "    }",
    `    $length = [Int64]$entry.Length; if ($length -lt 0 -or $length -gt ${MAX_ZIP_UNCOMPRESSED_BYTES}) { throw '压缩包解压大小超过上限' }; if ($total -gt ([Int64]${MAX_ZIP_UNCOMPRESSED_BYTES} - $length)) { throw '压缩包解压大小超过上限' }; $total += $length`,
    "  }",
    "} finally { $zip.Dispose() }",
  ].join(";"));
}

async function extractSkillZip(zipFile) {
  const raw = String(zipFile || "").trim();
  if (!path.isAbsolute(raw) || path.extname(raw).toLowerCase() !== ".zip") {
    throw new Error("Skill 压缩包必须是 .zip 绝对路径。");
  }
  const source = path.resolve(raw);
  if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink() || !fs.statSync(source).isFile()) throw new Error(`找不到 Skill 压缩包: ${source}`);
  await assertZipArchiveSafe(source);
  paths.ensureRuntimeDir();
  cleanupTemporarySkillSources();
  const destination = path.join(localSkillsDir(), `.staging-extract-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(destination, { recursive: true });
  skillSources().add(destination);
  try {
    await runPowershell(`Expand-Archive -LiteralPath '${psQuote(source)}' -DestinationPath '${psQuote(destination)}' -Force`);
    assertExtractedTreeContained(destination);
    return destination;
  } catch (error) {
    discardTemporarySkillPath(destination);
    throw error;
  }
}

async function prepareSkillSource(source) {
  const raw = String(source || "").trim();
  if (!path.isAbsolute(raw)) throw new Error("Skill source 必须是绝对路径。");
  const resolved = path.resolve(raw);
  if (skillSources().has(resolved) && fs.existsSync(resolved)) return resolved;
  for (const pending of [...skillSources()]) discardTemporarySkillPath(pending);
  return path.extname(resolved).toLowerCase() === ".zip" ? extractSkillZip(resolved) : resolved;
}

async function requestQuit() {
  if (quitting) return;
  quitting = true;
  try {
    await services.shutdown();
  } catch {}
  app.quit();
}

// 日志批量推送：避免每行一次 IPC。
const pendingLogs = [];
let logFlushTimer = null;
function scheduleLogFlush() {
  if (logFlushTimer) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    const batch = pendingLogs.splice(0, pendingLogs.length).filter((entry) => entry.accountId === accounts.selectedId);
    if (batch.length) send("log", batch);
  }, 150);
}
services.on("log", (entry) => {
  pendingLogs.push(entry);
  scheduleLogFlush();
  idleWatch.observe(entry.accountId, entry.name, entry.line);
});
services.on("status", (snapshot) => send("status", snapshot));
// 外部进程（旧脚本/手动启动）没有可继承的 stdout，实时信息改从 HTTP 活动源拉取。
feeds.on("lines", ({ name, lines, accountId }) => {
  for (const line of lines) {
    pendingLogs.push({ name, line, accountId });
    idleWatch.observe(accountId, name, line);
  }
  scheduleLogFlush();
});
feeds.on("activity", entry => {
  if (!idleWatch.observeIdentity(entry.accountId,entry)) return;
  try {
    conversationIndex.observe(entry.accountId,entry.conversationId,{hint:entry.hint,tool:entry.tool,at:entry.at});
  } catch (error) {
    try { accounts.run(entry.accountId,()=>services.note("[提醒] 会话名称索引暂不可写：" + error.message)); } catch {}
  }
});

let accountListTimer = null;
accounts.on("accounts-changed", () => {
  if (accountListTimer || quitting) return;
  accountListTimer = setTimeout(() => {
    accountListTimer = null;
    try { send("accounts:changed", accounts.list()); }
    catch (error) { notice("error", error.message); }
  }, 150);
});
accounts.on("account-error", ({ accountId, message }) => {
  send("notice", { accountId, level: "error", message: `[${accounts.record(accountId).name}] ${message}`, at: Date.now() });
});

async function bootstrap() {
  app.setAppUserModelId(taskbarAppId);
  if (app.isPackaged) {
    try {
      ensureNotificationShortcut({ shell, appDataDir: notificationAppDataDir,
        executable: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
        appId: taskbarAppId, displayName: APP_NAME });
    } catch (error) { services.note(`[提醒通知] Windows 通知注册失败：${error.message}`); }
  }
  migrateLegacyUserData();
  try { configStore.load(); }
  catch (error) {
    dialog.showErrorBox("ChatGPT Web Harness 配置读取失败", error.message);
    app.quit();
    return;
  }
  try {
    const cfg = configStore.load();
    const hadStoredToken = Boolean(cfg.adminTokenEnc);
    configStore.ensureAdminToken(cfg);
    if (!hadStoredToken && (profile.isolated || accountContext.current() || !process.env.ADMIN_TOKEN) && cfg.adminTokenEnc) configStore.save(cfg);
  } catch (err) {
    if (err && err.code === "CONFIG_READ_FAILED") {
      dialog.showErrorBox("ChatGPT Web Harness 配置读取失败", err.message);
      app.quit();
      return;
    }
    // Do not silently start an unauthenticated Admin server when the
    // per-user token cannot be protected; mcpSpawnSpec repeats this guard on
    // service start and reports a clear error to the UI.
    services.note(`Admin token 初始化失败: ${err.message}`);
  }
  try {
    paths.ensureRuntimeDir();
  } catch (err) {
    services.note(`初始化运行目录失败: ${err.message}`);
  }
  createWindow();
  createTray();
  registerIpc();
  registerPowerRecovery();

  statusTimer = setInterval(() => {
    accounts.refreshAll().catch(() => {});
    if (Date.now() - lastComputerUseRefreshAt >= 60_000) {
      lastComputerUseRefreshAt = Date.now();
      refreshAllComputerUseRuntimes();
    }
  }, 3000);
  idleTimer = setInterval(() => idleWatch.tick(), 15_000);
  cleanupConversationIndexes();
  conversationCleanupTimer = setInterval(cleanupConversationIndexes,24*60*60*1000);
  conversationCleanupTimer.unref?.();
  accounts.refreshAll().catch(() => {});

  accounts.autoStart().catch((error) => notice("error", error.message));
}

/**
 * 应用改名后 userData 目录也会变（Electron 用 package.json 的 name）。
 * 若新目录还没有配置、旧目录有，就搬过来——safeStorage 的密文绑定 Windows 用户而非路径，仍可解密。
 */
function migrateLegacyUserData() {
  // A preview must never import the installed app's ports, tokens or auto-start.
  if (!profile.allowLegacyMigration || accounts.currentId !== "default") return;
  try {
    const target = paths.configPath();
    if (fs.existsSync(target)) return;
    const legacyDir = path.join(path.dirname(app.getPath("userData")), "chatgpt-local-coder-desktop");
    const legacyConfig = path.join(legacyDir, "config.json");
    if (!fs.existsSync(legacyConfig)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacyConfig, target);
    services.note(`已从旧版目录迁移配置: ${legacyConfig}`);
  } catch (err) {
    services.note(`迁移旧配置失败（可重新初始化）: ${err.message}`);
  }
}

function wrap(handler) {
  return async (event, payload) => {
    try {
      if (!isTrustedIpcSource(event, mainWindow, expectedAuraUrl)) throw new Error("IPC_SOURCE_REJECTED");
      if (quitting) throw new Error("程序正在退出。");
      const id = payload && typeof payload._accountId === "string" ? payload._accountId : accounts.selectedId;
      const result = await accounts.run(id, () => handler(payload));
      return { ok: true, result, accountId: id };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

function registerIpc() {
  const accountImports = new (require("./account-import").AccountImport)({ accounts, config: configStore });
  ipcMain.handle("accounts:list", wrap(async () => accounts.list()));
  ipcMain.handle("accounts:create", wrap(async (payload) => accounts.create(payload || {})));
  ipcMain.handle("accounts:select", wrap(async (payload) => accounts.select(String(payload?.id || ""))));
  ipcMain.handle("accounts:rename", wrap(async (payload) => accounts.rename(String(payload?.id || ""), payload?.name)));
  ipcMain.handle("accounts:remove", wrap(async (payload) => accounts.remove(String(payload?.id || ""))));
  ipcMain.handle("accounts:inspectImport", wrap(async () => {
    const picked = await dialog.showOpenDialog(mainWindow, { title: "选择旧版的 .data 文件夹或账户配置目录", properties: ["openDirectory"] });
    if (picked.canceled || !picked.filePaths.length) return null;
    return accountImports.inspect(picked.filePaths[0]);
  }));
  ipcMain.handle("accounts:import", wrap(async payload => accountImports.complete(payload || {})));
  ipcMain.handle("conversations:list", wrap(async () => conversationIndex.list(accounts.currentId)));
  ipcMain.handle("conversations:rename", wrap(async payload =>
    conversationIndex.rename(accounts.currentId,String(payload?.id || ""),payload?.alias)));
  ipcMain.handle("conversations:pin", wrap(async payload =>
    conversationIndex.pin(accounts.currentId,String(payload?.id || ""),payload?.enabled===true)));
  ipcMain.handle("conversations:clearInactive", wrap(async () =>
    conversationIndex.cleanup(accounts.currentId,{clearUnpinned:true})));
  ipcMain.handle("notification:sounds", wrap(async () => {
    const cfg=configStore.load(),file=customPath(accounts.scope(accounts.currentId).dataDir);
    return {choices:SOUND_CHOICES,selected:cfg.notificationSound||"glass",
      volume:cfg.notificationVolume??100,hasCustom:fs.existsSync(file)};
  }));
  ipcMain.handle("notification:selectSound",wrap(async payload=>{
    const id=String(payload?.id||"");
    if(!SOUND_IDS.has(id))throw Error("未知通知提示音");
    if(id==="custom"&&!fs.existsSync(customPath(accounts.scope(accounts.currentId).dataDir)))
      throw Error("尚未导入自定义提示音");
    const cfg=configStore.load();cfg.notificationSound=id;configStore.save(cfg);
    accounts.emit("accounts-changed");
    return {selected:id};
  }));
  ipcMain.handle("notification:setVolume",wrap(async payload=>{
    const volume=Number(payload?.volume);
    if(!Number.isInteger(volume)||volume<0||volume>100)throw Error("音量必须为 0–100");
    const cfg=configStore.load();cfg.notificationVolume=volume;configStore.save(cfg);
    accounts.emit("accounts-changed");
    return {volume};
  }));
  ipcMain.handle("notification:preview",wrap(async payload=>{
    const id=String(payload?.id||"glass");
    if(!SOUND_IDS.has(id))throw Error("未知试听音效");
    return {played:await reminderSound.play(accounts.currentId,id)};
  }));
  ipcMain.handle("notification:importAudio",wrap(async payload=>{
    const cfg=configStore.load();
    const saved=importCustomWav({
      accountDataDir:accounts.scope(accounts.currentId).dataDir,
      audioBase64:payload?.wavBase64,
      commitConfig:()=>configStore.save({...cfg,notificationSound:"custom"}),
    });
    accounts.emit("accounts-changed");
    return {selected:"custom",durationMs:saved.durationMs,bytes:saved.bytes};
  }));

  ipcMain.handle("app:info", wrap(async () => ({
    name: APP_NAME,
    accountId: accounts.currentId,
    accountName: accounts.record(accounts.currentId).name,
    multiAccount: true,
    isolated: profile.isolated,
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    isPackaged: paths.isPackaged(),
    userDataDir: app.getPath("userData"),
    accountDataDir: accounts.scope(accounts.currentId).dataDir,
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE || null,
    codeRoot: paths.codeRoot(),
    runtimeDir: paths.runtimeDir(),
    logsDir: paths.logsDir(),
    configPath: paths.configPath(),
    encryptionAvailable: configStore.encryptionAvailable(),
    legacyKeys: paths.isPackaged() || profile.isolated || accounts.currentId !== "default" ? [] : legacy.legacyKeyFiles().map((k) => k.label),
    legacyTunnelId: paths.isPackaged() || profile.isolated || accounts.currentId !== "default" ? "" : (legacy.readDotEnvValue("OPENAI_TUNNEL_ID") || legacy.readProfileTunnelId("business-local.yaml")),
    legacyWorkspace: paths.isPackaged() || profile.isolated || accounts.currentId !== "default" ? "" : legacy.readDotEnvValue("WORKSPACE_PATH"),
    migration: paths.getMigrationStatus(),
  })));

  ipcMain.handle("config:get", wrap(async () => configStore.publicView(accounts.readConfig())));

  ipcMain.handle("config:save", wrap(async (payload) => {
    const cfg = configStore.load();
    // A read-only status poll does not own configuration. Still reject setup,
    // lifecycle transitions and every actually running owned process.
    accounts.assertStopped(accounts.currentId, { allowStatusRefresh: true });
    applyConfigPayload(cfg, payload || {});
    accounts.validateConfig(accounts.currentId, cfg);
    configStore.save(cfg);
    accounts.emit("accounts-changed");
    services.refresh().catch(() => {});
    return configStore.publicView(cfg);
  }));

  // Desktop-only preference: no service reads it, so it may change while services run.
  ipcMain.handle("config:setIdleReminder", wrap(async (payload) => {
    const minutes = Number(payload && payload.minutes);
    if (!IDLE_REMINDER_CHOICES.includes(minutes)) throw new Error("提醒间隔只能是 5 分钟、10 分钟、15 分钟或不提醒。");
    const cfg = configStore.load();
    cfg.idleReminderMinutes = minutes;
    configStore.save(cfg);
    return configStore.publicView(cfg);
  }));

  ipcMain.handle("config:importLegacyKey", wrap(async (payload) => {
    if (paths.isPackaged() || profile.isolated || accounts.currentId !== "default") throw new Error("打包版、隔离版和新增账号不支持导入原仓库密钥。");
    accounts.assertStopped();
    const label = payload && payload.label;
    const entry = legacy.legacyKeyFiles().find((k) => k.label === label);
    if (!entry) throw new Error(`未找到 ${label} 的旧密钥文件。`);
    const key = await legacy.readLegacyKey(entry.file);
    const cfg = configStore.load();
    cfg.apiKeyEnc = configStore.encryptKey(key);
    configStore.save(cfg);
    services.note(`已从旧的 ${label} 密钥文件导入 Runtime API Key（已用 safeStorage 重新加密）。`);
    return { imported: true };
  }));

  ipcMain.handle("dialog:pickFolder", wrap(async (payload) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 ChatGPT 默认操作的工作区目录",
      defaultPath: payload && payload.current ? payload.current : undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));

  ipcMain.handle("tunnel:download", wrap(async () => {
    const file = await services.downloadTunnelClient((p) => send("setup:progress", { stage: "download", ...p }));
    services.note(`tunnel-client 已就绪: ${file}`);
    return file;
  }));

  ipcMain.handle("setup:run", wrap(async (payload) => {
    accounts.assertStopped();
    return services.withBusy(() => runSetup(payload || {}));
  }));

  ipcMain.handle("status:get", wrap(async () => services.collectStatus()));
  ipcMain.handle("skills:catalog", wrap(async () => {
    const cfg = configStore.load();
    return skills.catalog(cfg.workspacePath);
  }));
  ipcMain.handle("skills:save", wrap(async (payload) => {
    const cfg = configStore.load();
    return skills.save({ ...payload, workspacePath: cfg.workspacePath });
  }));
  ipcMain.handle("skills:pickFile", wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择本地 SKILL.md",
      properties: ["openFile"],
      filters: [{ name: "Skill 文件", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const file = result.filePaths[0];
    if (path.basename(file) !== "SKILL.md") throw new Error("请选择名为 SKILL.md 的文件。");
    return file;
  }));
  ipcMain.handle("skills:pickFolder", wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Skill 包目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));
  ipcMain.handle("skills:pickZip", wrap(async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Skill 压缩包",
      properties: ["openFile"],
      filters: [{ name: "Skill 压缩包", extensions: ["zip"] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  }));
  ipcMain.handle("skills:inspectSource", wrap(async (payload) => {
    const source = await prepareSkillSource(payload && payload.source);
    const inspected = await skills.inspectSource(source);
    return { ...inspected, source, temporary: skillSources().has(path.resolve(source)) };
  }));
  ipcMain.handle("skills:discardSource", wrap(async (payload) => {
    const source = payload && payload.source;
    if (source) discardTemporarySkillPath(source);
    else cleanupTemporarySkillSources();
    return true;
  }));
  ipcMain.handle("skills:install", wrap(async (payload) => {
    const source = await prepareSkillSource(payload && payload.source);
    try {
      const result = await skills.install({
        source,
        id: typeof payload?.id === "string" ? payload.id : undefined,
        overwrite: payload?.overwrite !== false,
      });
      const cfg = configStore.load();
      return { result, catalog: await skills.catalog(cfg.workspacePath) };
    } finally {
      discardTemporarySkillPath(source);
    }
  }));
  ipcMain.handle("skills:uninstall", wrap(async (payload) => {
    const result = await skills.uninstall(String(payload?.id || ""));
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("skills:setEnabled", wrap(async (payload) => {
    const result = await skills.setEnabled({
      id: String(payload?.id || ""),
      enabled: payload?.enabled === true,
      source: payload?.source,
    });
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("skills:setComputerUse", wrap(async (payload) => {
    const result = await skills.setComputerUseEnabled(payload?.enabled === true);
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("skills:setBrowserUse", wrap(async (payload) => {
    const result = await skills.setBrowserUseEnabled(payload?.enabled === true);
    const cfg = configStore.load();
    return { result, catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("profiles:reset", wrap(async () => {
    const reset = paths.resetRuntimeProfiles();
    const cfg = configStore.load();
    return { reset, migration: paths.getMigrationStatus(), catalog: await skills.catalog(cfg.workspacePath) };
  }));
  ipcMain.handle("app:uninstall", wrap(async () => {
    const userData = path.resolve(app.getPath("userData"));
    const runtime = accounts.run("default", () => path.resolve(paths.runtimeDir()));
    const override = String(process.env.CLC_RUNTIME_DIR || "").trim();
    const deleteOptions = { userData, runtime, packaged: paths.isPackaged(), override };
    const result = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "卸载并清理数据",
      message: "确定删除此应用中所有账号的配置、日志和已安装 Skill？",
      detail: `${userData}\n\nportable/zip 版不会删除 EXE 文件；完成后可手动删除它。此操作不可撤销。`,
      buttons: ["取消", "删除数据并退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return { canceled: true };
    await paths.uninstallUserData({
      ...deleteOptions,
      stopExternal: undefined,
      shutdown: () => services.shutdown(),
      stopFeeds: () => feeds.stop(),
    });
    quitting = true;
    setImmediate(() => app.quit());
    return { removed: userData, restartRequired: false };
  }));
  ipcMain.handle("services:startAll", wrap(async () => services.startAll()));
  ipcMain.handle("services:stopAll", wrap(async () => { idleWatch.forget(accounts.currentId); return services.stopAll(); }));
  ipcMain.handle("services:stopExternal", wrap(async () => {
    if (profile.isolated) throw new Error("隔离版不接管或终止外部进程。");
    return services.stopExternal();
  }));
  ipcMain.handle("mcp:start", wrap(async () => services.withBusy(() => services.startMcp())));
  ipcMain.handle("mcp:stop", wrap(async () => { idleWatch.forget(accounts.currentId); return services.withBusy(() => services.stopMcp()); }));
  ipcMain.handle("mcp:restart", wrap(async () => services.restartMcp()));
  ipcMain.handle("tunnel:start", wrap(async () => services.withBusy(() => services.startTunnel())));
  ipcMain.handle("tunnel:stop", wrap(async () => { idleWatch.forget(accounts.currentId); return services.withBusy(() => services.stopTunnel()); }));

  ipcMain.handle("logs:get", wrap(async () => ({
    mcp: services.mcp.lines.slice(),
    tunnel: services.tunnel.lines.slice(),
    launcher: services.launcherLines.slice(),
  })));
  ipcMain.handle("logs:openFile", wrap(async (payload) => {
    const name = payload && payload.name === "tunnel" ? "tunnel" : "mcp";
    const file = path.join(paths.logsDir(), `${name}.log`);
    if (!fs.existsSync(file)) throw new Error(`日志文件还不存在: ${file}`);
    await shell.openPath(file);
    return file;
  }));
  ipcMain.handle("logs:clear", wrap(async (payload) => {
    const name = payload && payload.name;
    if (name === "mcp") services.mcp.lines.length = 0;
    else if (name === "tunnel") services.tunnel.lines.length = 0;
    else if (name === "launcher") services.launcherLines.length = 0;
    return true;
  }));

  ipcMain.handle("shell:openExternal", wrap(async (payload) => {
    const url = payload && payload.url;
    if (!/^https?:\/\//i.test(url || "")) throw new Error("只允许打开 http/https 链接。");
    await shell.openExternal(url);
    return true;
  }));
  ipcMain.handle("shell:openLogs", wrap(async () => {
    fs.mkdirSync(paths.logsDir(), { recursive: true });
    await shell.openPath(paths.logsDir());
    return true;
  }));
  ipcMain.handle("shell:openRuntime", wrap(async () => {
    await shell.openPath(paths.runtimeDir());
    return true;
  }));
  ipcMain.handle("clipboard:copy", wrap(async (payload) => {
    clipboard.writeText(String((payload && payload.text) || ""));
    return true;
  }));
}

function applyConfigPayload(cfg, payload) {
  if (typeof payload.tunnelId === "string") {
    const value = payload.tunnelId.trim();
    if (value && !configStore.validateTunnelId(value)) throw new Error("Tunnel ID 格式不正确，应为 tunnel_ + 32 位十六进制。");
    cfg.tunnelId = value;
  }
  if (typeof payload.apiKey === "string" && payload.apiKey.trim()) {
    cfg.apiKeyEnc = configStore.encryptKey(payload.apiKey.trim());
  }
  if (typeof payload.workspacePath === "string" && payload.workspacePath.trim()) {
    const value = payload.workspacePath.trim();
    // 必须是绝对路径：`D:web-local` 这类驱动器相对路径会解析到当前目录，不是用户想要的。
    if (!path.isAbsolute(value)) throw new Error(`工作区必须是绝对路径，例如 C:\\Users\\你\\Documents\\项目（收到: ${value}）`);
    cfg.workspacePath = path.resolve(value);
  }
  for (const key of ["mcpPort", "adminPort", "tunnelPort"]) {
    if (payload[key] !== undefined && payload[key] !== "") {
      if (!configStore.validatePort(payload[key])) throw new Error(`${key} 端口无效。`);
      cfg[key] = Number(payload[key]);
    }
  }
  if (typeof payload.tunnelProxyMode === "string") cfg.tunnelProxyMode = payload.tunnelProxyMode;
  if (typeof payload.tunnelProxyUrl === "string") cfg.tunnelProxyUrl = payload.tunnelProxyUrl.trim() ? validateProxyUrl(payload.tunnelProxyUrl) : "";
  validateProxySettings(cfg);
  if (payload.toolProfile === "slim" || payload.toolProfile === "full") cfg.toolProfile = payload.toolProfile;
  if (typeof payload.autoStart === "boolean") cfg.autoStart = payload.autoStart;
  if (typeof payload.minimizeToTray === "boolean") cfg.minimizeToTray = payload.minimizeToTray;
  if (typeof payload.setupDone === "boolean") cfg.setupDone = payload.setupDone;
  const ports = new Set([cfg.mcpPort, cfg.adminPort, cfg.tunnelPort]);
  if (ports.size !== 3) throw new Error("MCP、Admin、Tunnel 三个端口不能相同。");
}

async function runSetup(payload) {
  const progress = (stage, message) => send("setup:progress", { stage, message });
  let stage = "config";
  try {
    const cfg = configStore.load();
    applyConfigPayload(cfg, payload);
    accounts.validateConfig(accounts.currentId, cfg);
    if (!cfg.tunnelId) throw new Error("请填写 Tunnel ID。");
    if (!cfg.apiKeyEnc) throw new Error("请填写 Runtime API Key。");
    if (!cfg.workspacePath) throw new Error("请选择工作区目录。");

    stage = "workspace";
    progress(stage, `准备工作区 ${cfg.workspacePath}`);
    fs.mkdirSync(cfg.workspacePath, { recursive: true });
    paths.ensureRuntimeDir();
    require("./harness").ensureDotEnv();

    if (!fs.existsSync(paths.distEntry())) {
      throw new Error(`找不到 MCP 构建产物 ${paths.distEntry()}。开发模式下请先在仓库运行 npm run build。`);
    }

    if (!fs.existsSync(paths.tunnelClientPath())) {
      stage = "download";
      progress("download", "下载 tunnel-client ...");
      await services.downloadTunnelClient((p) => send("setup:progress", { stage: "download", ...p }));
    }

    const result = await require("./setup").initializeAccount({
      cfg, skipDoctor: !!payload.skipDoctor, services,
      saveConfig: value => configStore.save(value),
      decryptKey: value => configStore.decryptKey(value),
      publicView: value => configStore.publicView(value), progress,
    });
    if (!result.ok) return result;
    accounts.emit("accounts-changed");
    services.note("初始化完成。");
    services.refresh().catch(() => {});
    return result;
  } catch (error) {
    const message = require("./setup").redactSetupText(error?.message || String(error), [payload.apiKey]);
    return { ok: false, stage, code: "SETUP_PREPARATION_FAILED", title: "初始化准备失败", message,
      nextAction: "根据上述原因修正对应设置或文件后重试；不会标记为初始化成功。", checks: [], details: message, doctor: "" };
  }
}

app.on("before-quit", () => {
  quitting = true;
  idleNotifier.dispose();
  reminderSound.dispose();
  if (statusTimer) clearInterval(statusTimer);
  if (idleTimer) clearInterval(idleTimer);
  if (conversationCleanupTimer) clearInterval(conversationCleanupTimer);
  feeds.stop();
  if (accountListTimer) clearTimeout(accountListTimer);
  if (accounts.registry) for (const row of accounts.registry.accounts) {
    try { accounts.run(row.id, () => { cleanupTemporarySkillSources(); }); } catch { /* never clean another account on failure */ }
  }
});
app.on("will-quit", (event) => {
  if (accounts.anyAlive()) {
    event.preventDefault();
    services.shutdown().finally(() => app.exit(0));
  }
});
app.on("window-all-closed", () => {
  // 服务仍在运行时窗口已被隐藏而非关闭；到这里说明用户确实要退出。
  requestQuit();
});
