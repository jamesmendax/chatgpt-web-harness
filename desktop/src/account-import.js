"use strict";
// Explicit folder selection only. Tokens and source credentials never leave main.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const context = require("./account-context");
const profileTransfer = require("./account-profile-transfer");
const credentialFormat = require("./credential-format");
const pending = new WeakMap();
const BASENAMES = ["chatgpt-web-harness-isolated", "chatgpt web harness isolated", "chatgpt-web-harness-desktop", "chatgpt web harness"];
function read(file) {
  context.assertUnlinked(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("导入配置必须是小于 2 MiB 的普通文件。");
  return fs.readFileSync(file, "utf8");
}
function json(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("导入配置 JSON 无效；原配置未修改。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导入配置格式无效。");
  return value;
}
function safeConfiguration(raw, config, validate = true) {
  const cfg = { ...config.DEFAULTS, apiKeyEnc: "", adminTokenEnc: "", autoStart: false };
  for (const key of ["tunnelId", "workspacePath", "tunnelProxyMode", "tunnelProxyUrl", "toolProfile"]) if (typeof raw[key] === "string") cfg[key] = raw[key];
  for (const key of ["mcpPort", "adminPort", "tunnelPort", "idleReminderMinutes", "notificationVolume"]) if (Number.isInteger(raw[key])) cfg[key] = raw[key];
  if (typeof raw.notificationSound === "string") cfg.notificationSound = raw.notificationSound;
  for (const key of ["setupDone", "minimizeToTray"]) if (typeof raw[key] === "boolean") cfg[key] = raw[key];
  if (!validate) return cfg;
  if (!config.validateTunnelId(cfg.tunnelId)) throw new Error("旧账户的 Tunnel ID 无效；请选择已有有效配置的账户。");
  if (!cfg.workspacePath || !path.isAbsolute(cfg.workspacePath)) throw new Error("旧账户的工作区必须是绝对路径。");
  if (!["auto", "direct", "custom"].includes(cfg.tunnelProxyMode)) throw new Error("旧账户的代理模式无效。");
  if (!["slim", "full"].includes(cfg.toolProfile)) throw new Error("旧账户的工具配置无效。");
  if (!require("./notification-sound").SOUND_IDS.has(cfg.notificationSound) ||
      !Number.isInteger(cfg.notificationVolume) || cfg.notificationVolume < 0 || cfg.notificationVolume > 100)
    throw new Error("旧账户的提示音或音量配置无效；未进行导入。");
  require("./tunnel-proxy").validateProxySettings(cfg);
  return cfg;
}
class AccountImport {
  constructor({ accounts, config, legacyCrypto }) {
    this.accounts = accounts;
    this.config = config;
    this.legacyCrypto = legacyCrypto || require("./legacy-crypto");
    pending.set(this, new Map());
  }
  inspect(folder) {
    if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("请通过选择文件夹指定旧账户配置位置。");
    const selected = context.assertUnlinked(folder);
    if (!fs.statSync(selected).isDirectory()) throw new Error("请选择配置文件夹。");
    const hasProfile = root => {
      context.assertUnlinked(root);
      return ["config.json", "accounts.json"].some(name => fs.existsSync(path.join(root, name)));
    };
    // Only inspect explicit, bounded portable layouts beneath the chosen folder.
    // A packaged executable owns <executable stem>.data, rather than a literal .data.
    let roots;
    if (hasProfile(selected)) roots = [selected];
    else {
      const candidates = BASENAMES.flatMap(name => [path.join(selected, name), path.join(selected, "appdata", name), path.join(selected, ".data", "appdata", name)]);
      const children = fs.readdirSync(selected, { withFileTypes: true }).filter(entry => entry.name.toLowerCase().endsWith(".data"));
      if (children.length > 64) throw new Error("所选目录含过多便携配置目录，请直接选择所需 .data 文件夹。");
      for (const child of children) for (const name of BASENAMES) candidates.push(path.join(selected, child.name, "appdata", name));
      roots = [...new Set(candidates)].filter(hasProfile);
    }
    if (roots.length !== 1) throw new Error(roots.length ? "找到多个旧配置位置，请直接选择所需配置目录。" : "所选目录中没有受支持的账户配置；请选择含 config.json 或 accounts.json 的目录，或旧便携版根目录。");
    const root = context.assertUnlinked(roots[0]), snapshots = new Map();
    const take = file => { const text = read(file); snapshots.set(file, text); return json(text); };
    let rows = [{ id: "default", name: "旧账户" }];
    const registryFile = path.join(root, "accounts.json");
    if (fs.existsSync(registryFile)) {
      const registry = take(registryFile);
      if (registry.version !== 1 || !Array.isArray(registry.accounts) || !registry.accounts.length || registry.accounts.length > 16) throw new Error("旧账户索引格式无效。");
      const ids = new Set();
      rows = registry.accounts.map(row => {
        if (!row || !context.ID_RE.test(row.id) || ids.has(row.id) || typeof row.name !== "string" || !row.name.trim()) throw new Error("旧账户索引含无效或重复账户。");
        ids.add(row.id); return { id: row.id, name: row.name.trim() };
      });
    }
    const entries = rows.map(row => {
      const file = path.join(root, ...(row.id === "default" ? [] : ["accounts", row.id]), "config.json");
      const raw = take(file), cfg = safeConfiguration(raw, this.config, false);
      credentialFormat.describe(raw);
      const profile = profileTransfer.scan(path.dirname(file));
      if (cfg.notificationSound === "custom" && !profile.summary.hasCustomAudio)
        throw new Error("旧账号选择了自定义提示音，但对应音频不存在；请修复来源配置后重试。");
      return { sourceId: row.id, name: row.name, raw, cfg, file, profile };
    });
    const token = crypto.randomBytes(24).toString("hex"), records = pending.get(this);
    const targetId = this.accounts.selectedId, targetConfig = JSON.stringify(this.accounts.readConfig(targetId));
    records.clear(); records.set(token, { sourceFolder: root, entries, snapshots, created: Date.now(), targetId, targetConfig });
    const local = this.accounts.list().accounts;
    return { token, sourceFolder: root, accounts: entries.map(entry => {
      const cfg = entry.cfg, existing = local.find(row => row.config.tunnelId === cfg.tunnelId);
      return { sourceId: entry.sourceId, name: entry.name, tunnelId: cfg.tunnelId, workspacePath: cfg.workspacePath,
        mcpPort: cfg.mcpPort, adminPort: cfg.adminPort, tunnelPort: cfg.tunnelPort, setupDone: cfg.setupDone,
        hasApiKey: typeof entry.raw.apiKeyEnc === "string" && Boolean(entry.raw.apiKeyEnc),
        installedSkills: entry.profile.summary.installedSkills,
        registeredSkills: entry.profile.summary.registeredSkills,
        mcpServers: entry.profile.summary.mcpServers,
        skillFiles: entry.profile.summary.skillFiles,
        hasCustomAudio: entry.profile.summary.hasCustomAudio,
        hasConversationNames: entry.profile.summary.hasConversationNames,
        soundChoice: cfg.notificationSound,
        soundVolume: cfg.notificationVolume,
        hasProviderSettings: entry.profile.plugins?.computer_use?.enabled === true ||
          entry.profile.plugins?.browser_use?.enabled === true,
        ...(existing && cfg.tunnelId ? { existingAccountId: existing.id, warning: "此 Tunnel 已存在：仅补齐缺失的 Skills/MCP/自定义文件，保留现有密钥与端口；有冲突时拒绝覆盖。需要补齐时请先停止该账号服务。" } : !cfg.tunnelId || !entry.raw.apiKeyEnc ? { warning: "旧账户配置不完整，请选择已有 Tunnel 和密钥的账户。" } : {}) };
    }) };
  }
  complete({ token, sourceId } = {}) {
    const records = pending.get(this), inspected = records.get(token);
    records.delete(token);
    if (!inspected || Date.now() - inspected.created > 10 * 60 * 1000) throw new Error("导入预览已失效，请重新选择配置文件夹。");
    const entry = inspected.entries.find(row => row.sourceId === sourceId);
    if (!entry) throw new Error("请选择预览中的账户。");
    return this.accounts.importConfiguration({ name: entry.name, tunnelId: entry.cfg.tunnelId, targetId: inspected.targetId, targetConfig: inspected.targetConfig, sourceFiles: [...inspected.snapshots.keys()],
      verify: () => {
        for (const [file, text] of inspected.snapshots) if (read(file) !== text) throw new Error("旧配置在预览后发生变化，请重新选择并预览；没有导入任何配置。");
        profileTransfer.verify(entry.profile);
      },
      prepareProfile: (targetDataDir) => profileTransfer.makePlan(entry.profile,targetDataDir),
      prepare: async () => {
        let secrets;
        // Older direct-DPAPI profiles may not have Local State. Try the current
        // context only in that legacy case; a different Local State must be
        // opened in a separate Electron source context, never overwritten.
        if (fs.existsSync(path.join(inspected.sourceFolder, "Local State"))) {
          secrets = await this.legacyCrypto.decryptFromSource({
            sourceRoot: inspected.sourceFolder,
            apiKeyEnc: entry.raw.apiKeyEnc,
            adminTokenEnc: entry.raw.adminTokenEnc || "",
          });
        } else {
          try {
            secrets = {
              apiKey: this.config.decryptKey({ apiKeyEnc: entry.raw.apiKeyEnc }),
              adminToken: entry.raw.adminTokenEnc ? this.config.decryptAdminToken(entry.raw) : "",
            };
          } catch {
            throw new Error("旧版密钥解密失败：缺少旧版加密上下文或密文格式不兼容，原配置未修改。");
          }
        }
        if (typeof secrets.apiKey !== "string" || !secrets.apiKey.trim()) {
          throw new Error("旧账户没有可读取的 Runtime API Key；未导入任何不完整的密钥。");
        }
        return {
          ...safeConfiguration(entry.raw, this.config),
          apiKeyEnc: this.config.encryptKey(secrets.apiKey),
          adminTokenEnc: secrets.adminToken ? this.config.encryptKey(secrets.adminToken) : "",
          credentialFormat: { ...credentialFormat.CURRENT },
          autoStart: false,
        };
      },
    });
  }
}
module.exports = { AccountImport };
