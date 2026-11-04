"use strict";
// Desktop adapter for the shared resolver/registry/installer. The renderer
// never owns registry semantics; it only edits external rows and invokes IPC.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const paths = require("./paths");
const accountContext = require("./account-context");

let resolverPromise;
let pluginConfigPromise;
let installerPromise;

function pluginsConfigPath() {
  return path.join(paths.runtimeDir(), "profiles", "plugins.json");
}

function resolverPath() {
  return paths.resolverPath();
}

function importOnce(file) {
  return import(pathToFileURL(file).href);
}

function loadResolver() {
  resolverPromise ||= importOnce(resolverPath());
  return resolverPromise;
}

function loadPluginConfig() {
  pluginConfigPromise ||= importOnce(path.join(path.dirname(resolverPath()), "plugin-config.js"));
  return pluginConfigPromise;
}

function loadInstaller() {
  installerPromise ||= importOnce(paths.installerPath());
  return installerPromise;
}

function runtimeSkillPaths() {
  const registryPath = pluginsConfigPath();
  return {
    registryPath,
    localSkillsDir: path.join(path.dirname(registryPath), "local-skills"),
  };
}

function readPluginsConfig() {
  try {
    return JSON.parse(fs.readFileSync(pluginsConfigPath(), "utf8"));
  } catch {
    return { schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: false }, skills: [] };
  }
}

function groupCatalog(all, config, workspacePath) {
  const group = (source) => all.filter((skill) => skill.source === source);
  const computer = all.find((skill) => skill.source === "computer-use");
  const browser = all.find((skill) => skill.source === "browser-use");
  const external = group("external");
  return {
    project: group("project"),
    installed: group("installed"),
    external,
    // Keep the old key for one release so an older renderer cannot silently
    // lose its rows; all new UI code uses external.
    registered: external,
    builtin: group("builtin"),
    computerUse: {
      available: Boolean(computer && fs.existsSync(paths.computerUseHelperPath())),
      enabled: config.computer_use?.enabled === true,
      path: computer?.path || "",
    },
    browserUse: {
      available: Boolean(browser),
      runtimeReady: paths.browserUseRuntimeAvailable(),
      enabled: config.browser_use?.enabled === true,
      path: browser?.path || "",
    },
    configPath: pluginsConfigPath(),
    localSkillsDir: runtimeSkillPaths().localSkillsDir,
    workspacePath,
  };
}

async function catalog(workspacePath) {
  const configModule = await loadPluginConfig();
  const resolver = await loadResolver();
  const config = configModule.readLocalPluginsConfig(pluginsConfigPath());
  const skillPaths = runtimeSkillPaths();
  const all = await resolver.resolveSkills({
    workspaceRoot: path.resolve(workspacePath || paths.runtimeDir()),
    codeRoot: paths.codeRoot(),
    installedDir: skillPaths.localSkillsDir,
    registry: config,
    codexHome: accountContext.current() ? path.join(paths.runtimeDir(), ".codex")
      : process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || paths.runtimeDir(), ".codex"),
    platform: process.platform,
  });
  return groupCatalog(all, config, workspacePath);
}

function normalizeExternalRegistration(registration, resolver) {
  const rawPath = String(registration.path || "").trim();
  if (!path.isAbsolute(rawPath) || path.basename(rawPath) !== "SKILL.md") {
    throw new Error("Skill 路径必须是指向 SKILL.md 的绝对路径。");
  }
  const skillPath = path.resolve(rawPath);
  if (!fs.existsSync(skillPath)) throw new Error(`找不到文件: ${skillPath}`);
  const content = fs.readFileSync(skillPath, "utf8");
  const frontmatter = resolver.parseSkillFrontmatter(content);
  const id = String(registration.id || registration.name || path.basename(path.dirname(skillPath))).trim();
  resolver.validateSkillId(id);
  return {
    id,
    source: "external",
    aliases: frontmatter.name && frontmatter.name.toLowerCase() !== id.toLowerCase() ? [frontmatter.name] : [],
    path: skillPath,
    enabled: registration.enabled !== false,
  };
}

async function save(payload) {
  if (!Array.isArray(payload?.registrations)) throw new Error("registrations 数组无效。");
  if (payload.computerUseEnabled !== undefined && typeof payload.computerUseEnabled !== "boolean") {
    throw new Error("computerUseEnabled 必须是布尔值。");
  }
  if (payload.browserUseEnabled !== undefined && typeof payload.browserUseEnabled !== "boolean") {
    throw new Error("browserUseEnabled 必须是布尔值。");
  }
  if (payload.browserUseEnabled === true && !paths.browserUseRuntimeAvailable()) {
    throw new Error(`Browser Use 运行时不完整: ${paths.browserUseRuntimeRoot()}`);
  }
  if (payload.computerUseEnabled === true && !fs.existsSync(paths.computerUseHelperPath())) {
    throw new Error(`Computer Use helper 不完整: ${paths.computerUseHelperPath()}`);
  }
  const configModule = await loadPluginConfig();
  const resolver = await loadResolver();
  const current = configModule.readLocalPluginsConfig(pluginsConfigPath());
  const external = payload.registrations.map((registration) => normalizeExternalRegistration(registration, resolver));
  const names = new Set();
  for (const row of external) {
    const key = row.id.toLowerCase();
    if (names.has(key)) throw new Error("外部注册的 Skill id 不能重复。");
    names.add(key);
  }
  const next = {
    ...current,
    computer_use: {
      enabled: payload.computerUseEnabled === undefined
        ? current.computer_use?.enabled === true
        : payload.computerUseEnabled,
    },
    browser_use: {
      enabled: payload.browserUseEnabled === undefined
        ? current.browser_use?.enabled === true
        : payload.browserUseEnabled,
    },
    skills: [...current.skills.filter((row) => row.source !== "external"), ...external],
  };
  configModule.saveLocalPluginsConfigAt(pluginsConfigPath(), next);
  return { ok: true, catalog: await catalog(payload.workspacePath || paths.runtimeDir()) };
}

async function install(payload) {
  const installer = await loadInstaller();
  return installer.installSkill({
    source: payload.source,
    id: payload.id,
    overwrite: payload.overwrite !== false,
    ...runtimeSkillPaths(),
  });
}

async function uninstall(id) {
  const installer = await loadInstaller();
  return installer.uninstallSkill({
    id,
    ...runtimeSkillPaths(),
    codeRoot: paths.codeRoot(),
  });
}

async function setEnabled(payload) {
  const installer = await loadInstaller();
  return installer.setSkillEnabled({
    id: payload.id,
    enabled: payload.enabled,
    source: payload.source,
    ...runtimeSkillPaths(),
    codeRoot: paths.codeRoot(),
  });
}

async function setComputerUseEnabled(enabled) {
  if (typeof enabled !== "boolean") throw new Error("Computer Use 开关必须是布尔值。");
  if (enabled && !fs.existsSync(paths.computerUseHelperPath())) throw new Error(`Computer Use helper 不完整: ${paths.computerUseHelperPath()}`);
  const configModule = await loadPluginConfig();
  const current = configModule.readLocalPluginsConfig(pluginsConfigPath());
  const next = configModule.saveLocalPluginsConfigAt(pluginsConfigPath(), {
    ...current,
    computer_use: { enabled },
  });
  return { ok: true, enabled: next.computer_use.enabled };
}

async function setBrowserUseEnabled(enabled) {
  if (typeof enabled !== "boolean") throw new Error("Browser Use 开关必须是布尔值。");
  if (enabled && !paths.browserUseRuntimeAvailable()) throw new Error(`Browser Use 运行时不完整: ${paths.browserUseRuntimeRoot()}`);
  const configModule = await loadPluginConfig();
  const current = configModule.readLocalPluginsConfig(pluginsConfigPath());
  const next = configModule.saveLocalPluginsConfigAt(pluginsConfigPath(), {
    ...current,
    browser_use: { enabled },
  });
  return { ok: true, enabled: next.browser_use.enabled };
}

async function inspectSource(source) {
  const installer = await loadInstaller();
  // Use the exact shared inspection/derivation path used by installSkill so
  // repository suffixes (for example `ppt-master-main`) and dependency
  // warnings cannot diverge between the preview and the committed install.
  return installer.inspectSkillPackage(source);
}

module.exports = { catalog, save, install, uninstall, setEnabled, setComputerUseEnabled, setBrowserUseEnabled, inspectSource, readPluginsConfig };
