"use strict";
// One process pair per account. The registry contains labels/IDs only, never keys.
// Operational isolation is not a security sandbox for an untrusted Windows user.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { EventEmitter } = require("node:events");
const context = require("./account-context");
const importTransaction = require("./account-import-transaction");
const credentialFormat = require("./credential-format");
const deleteTransaction = require("./account-delete-transaction");
const MAX_ACCOUNTS = 16;
const PORT_KEYS = ["mcpPort", "adminPort", "tunnelPort"];
const START_METHODS = new Set(["startMcp", "startTunnel", "startAll", "restartMcp", "withSetupMcp"]);
// Only these profile-owned leaves may be archived. In particular, default's
// dataDir is the application root, never an account directory to move wholesale.
const ACCOUNT_LEAVES = ["config.json", "runtime", "logs", "browser-use", "computer-use", "notification-sounds"];
function containedTree(root, target) {
  const base = context.assertUnlinked(root), resolved = context.assertUnlinked(target);
  const relative = path.relative(base, resolved);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("账号归档路径超出配置目录。");
  const visit = file => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("账号归档不能包含符号链接或 junction。");
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    else if (!stat.isFile()) throw new Error("账号归档包含不明确的文件类型。");
  };
  try { visit(resolved); } catch (error) { if (error.code !== "ENOENT") throw error; }
  return resolved;
}

function checkedName(value) {
  if (typeof value !== "string") throw new Error("请填写账号名称。");
  const name = value.trim();
  if (!name || [...name].length > 60 || /[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)) {
    throw new Error("账号名称须为 1–60 个可见字符，不得包含控制字符。");
  }
  return name;
}
function canonicalDirectory(value) {
  if (!path.isAbsolute(value)) throw new Error("工作区必须是绝对路径。");
  let cursor = path.resolve(value);
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cursor);
      if (!fs.statSync(real).isDirectory()) throw new Error("工作区或其上级不是目录。");
      const resolved = path.resolve(real, ...tail);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}
function overlaps(a, b) {
  const inside = (base, target) => {
    const relative = path.relative(base, target);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  return inside(a, b) || inside(b, a);
}
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}
function atomicRegistry(file, text) {
  context.assertUnlinked(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const temporary = `${file}.${suffix}.tmp`;
  const backup = `${file}.${suffix}.bak`;
  let backedUp = false;
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, text, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, file); }
    catch (error) {
      if (!["EEXIST", "EPERM"].includes(error.code) || !fs.existsSync(file)) throw error;
      fs.renameSync(file, backup);
      backedUp = true;
      try { fs.renameSync(temporary, file); }
      catch (publishError) {
        try { fs.renameSync(backup, file); backedUp = false; }
        catch (restoreError) { throw new Error(`账号索引写入失败；旧文件保留于 ${backup}: ${restoreError.message}`); }
        throw publishError;
      }
    }
    if (backedUp) { try { fs.unlinkSync(backup); } catch { /* keep a recoverable backup */ } }
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") { /* retain for diagnostics */ } } }
}

class AccountManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.app = options.app || require("electron").app;
    this.config = options.config || require("./config");
    this.paths = options.paths || require("./paths");
    this.makeServices = options.makeServices || (() => new (require("./services").Services)());
    this.makeFeeds = options.makeFeeds || (() => new (require("./feeds").ActivityFeeds)());
    this.portFree = options.portFree || isPortFree;
    this.registry = null;
    this.registryText = null;
    this.importRecoveryChecked = false;
    this.instances = new Map();
    this.mutations = Promise.resolve();
    this.shuttingDown = false;
    this.refreshPromise = null;
    this.removingIds = new Set();
    this.services = this.facade("services");
    this.feeds = this.facade("feeds");
  }
  root() { return context.assertUnlinked(this.app.getPath("userData")); }
  registryFile() { return context.assertUnlinked(path.join(this.root(), "accounts.json")); }
  readRegistryText() {
    try { return fs.readFileSync(this.registryFile(), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  init() {
    if (this.registry) return this;
    // Restore an interrupted multi-file import before accepting the on-disk
    // registry. A corrupt recovery journal fails closed; never silently start
    // with a partially imported account.
    if (!this.importRecoveryChecked) {
      importTransaction.withLock(this.root(), () => {
        importTransaction.recoverPendingUnlocked(this.root());
        deleteTransaction.recoverPending(this.root());
      });
      this.importRecoveryChecked = true;
    }
    const text = this.readRegistryText();
    let registry;
    try {
      registry = text === null ? {
        version: 1, revision: 0, selectedId: "default",
        accounts: [{ id: "default", name: fs.existsSync(path.join(this.root(), "config.json")) ? "默认账号（原配置）" : "默认账户", createdAt: null }],
      } : JSON.parse(text);
      if (!registry || registry.version !== 1 || !Array.isArray(registry.accounts) ||
          !registry.accounts.length || registry.accounts.length > MAX_ACCOUNTS) throw new Error("不支持的索引格式");
      const ids = new Set(); const names = new Set();
      for (const row of registry.accounts) {
        if (!row || !context.ID_RE.test(row.id) || ids.has(row.id)) throw new Error("账号 ID 无效或重复");
        const name = checkedName(row.name);
        if (name !== row.name || names.has(name.toLowerCase())) throw new Error("账号名称无效或重复");
        ids.add(row.id); names.add(name.toLowerCase());
      }
      if (!ids.has(registry.selectedId)) throw new Error("当前账号缺失");
      if (!Number.isSafeInteger(registry.revision) || registry.revision < 0) throw new Error("索引版本无效");
    } catch (error) {
      throw new Error(`账号索引读取失败，未重置任何配置。请修复 ${this.registryFile()}: ${error.message}`);
    }
    this.registry = registry;
    this.registryText = text;
    return this;
  }
  get selectedId() { this.init(); return this.registry.selectedId; }
  get currentId() { return context.current()?.id || this.selectedId; }
  record(id) {
    this.init();
    const row = this.registry.accounts.find((item) => item.id === id);
    if (!row) throw new Error("该账号不存在或已移除，请刷新账号列表。");
    return row;
  }
  makeScope(id) {
    if (!context.ID_RE.test(id)) throw new Error("无效的账号 ID。");
    const root = this.root();
    const dataDir = context.assertUnlinked(id === "default" ? root : path.join(root, "accounts", id));
    return Object.freeze({ id, dataDir });
  }
  scope(id = this.currentId) { this.record(id); return this.makeScope(id); }
  run(id, fn) { return context.run(this.scope(id), fn); }
  readConfig(id = this.currentId) {
    return this.run(id, () => {
      if (id !== "default" && !fs.existsSync(this.paths.configPath())) {
        throw new Error(`账号「${this.record(id).name}」配置缺失，已阻止使用默认端口代替。`);
      }
      return this.config.load();
    });
  }
  publish(next, notify = true) {
    if (this.readRegistryText() !== this.registryText) throw new Error("账号索引被其他程序修改；未覆盖。请关闭并重新打开此程序后重试。");
    const value = { ...next, version: 1, revision: this.registry.revision + 1 };
    const text = JSON.stringify(value, null, 2) + "\n";
    importTransaction.withLock(this.root(), () => {
      if (this.readRegistryText() !== this.registryText) throw new Error("账号索引被其他程序修改；未覆盖。");
      atomicRegistry(this.registryFile(), text);
    });
    this.registry = value;
    this.registryText = text;
    if (notify) this.emit("accounts-changed");
  }
  enqueue(fn) {
    const result = this.mutations.then(() => {
      if (this.shuttingDown) throw new Error("程序正在退出，不能再修改账号。");
      this.init();
      return fn();
    });
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }
  async allocatePorts() {
    const used = new Set(this.registry.accounts.flatMap((row) => {
      const cfg = this.readConfig(row.id);
      return PORT_KEYS.map((key) => cfg[key]);
    }));
    // Bounded probing; never seize or kill an existing listener.
    for (let base = 3400; base < 4400; base += 10) {
      const ports = [base, base + 1, base + 2];
      if (ports.some((port) => used.has(port))) continue;
      if ((await Promise.all(ports.map((port) => this.portFree(port)))).every(Boolean)) {
        return Object.fromEntries(PORT_KEYS.map((key, index) => [key, ports[index]]));
      }
    }
    throw new Error("未找到三组可用端口；没有终止任何现有服务。");
  }
  validateConfig(id, cfg) {
    const ownPorts = PORT_KEYS.map((key) => cfg[key]);
    if (ownPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ownPorts).size !== 3) {
      throw new Error("MCP、Admin、Tunnel 必须使用三个不同的有效端口。");
    }
    if (cfg.tunnelId && !this.config.validateTunnelId(cfg.tunnelId)) throw new Error("Tunnel ID 格式不正确。");
    const ownWorkspace = cfg.workspacePath ? canonicalDirectory(cfg.workspacePath) : null;
    for (const other of this.registry.accounts) {
      if (other.id === id) continue;
      const saved = this.readConfig(other.id);
      if (PORT_KEYS.some((key) => ownPorts.includes(saved[key]))) throw new Error(`端口与账号「${other.name}」重复，请使用独立端口。`);
      if (cfg.tunnelId && cfg.tunnelId === saved.tunnelId) throw new Error(`Tunnel ID 已属于账号「${other.name}」，请切换到该已有账户继续使用；无需创建新 Tunnel。`);
      if (ownWorkspace && saved.workspacePath && overlaps(ownWorkspace, canonicalDirectory(saved.workspacePath))) {
        throw new Error(`工作区与账号「${other.name}」相同或互相包含，请选择互不重叠的目录。`);
      }
    }
    if (ownWorkspace && overlaps(ownWorkspace, canonicalDirectory(this.root()))) {
      throw new Error("工作区不能包含应用账号数据目录，也不能位于其中；请选择独立的项目目录。");
    }
    return cfg;
  }
  assertStopped(id = this.currentId, { allowStatusRefresh = false } = {}) {
    const item = this.instances.get(id);
    if (item && ((!allowStatusRefresh && item.refreshing) || item.services.busy || item.services.mcp.isAlive() || item.services.tunnel.isAlive())) {
      throw new Error(`请先停止账号「${this.record(id).name}」的 MCP 和隧道，再修改设置；其他账号无需停止。`);
    }
  }
  create(payload = {}) {
    return this.enqueue(async () => {
      const name = checkedName(payload.name);
      if (this.registry.accounts.length >= MAX_ACCOUNTS) throw new Error(`最多保留 ${MAX_ACCOUNTS} 个账号配置档。`);
      if (this.registry.accounts.some((row) => row.name.toLowerCase() === name.toLowerCase())) throw new Error("账号名称已存在。");
      const id = crypto.randomUUID().replace(/-/g, "");
      const scope = this.makeScope(id);
      const ports = await this.allocatePorts();
      const workspacePath = typeof payload.workspacePath === "string" && payload.workspacePath.trim()
        ? payload.workspacePath.trim() : path.join(this.app.getPath("documents"), "Web Harness Workspaces", id);
      if (this.shuttingDown) throw new Error("程序正在退出，已取消账号创建。");
      const cfg = { ...this.config.DEFAULTS, ...ports, workspacePath, setupDone: false, autoStart: false, tunnelId: "", apiKeyEnc: "" };
      this.validateConfig(id, cfg);
      context.run(scope, () => {
        fs.mkdirSync(scope.dataDir, { recursive: true });
        this.config.save(cfg);
        this.paths.ensureRuntimeDir();
      });
      this.publish({ ...this.registry, accounts: [...this.registry.accounts, { id, name, createdAt: new Date().toISOString() }] });
      return { id, name, config: this.config.publicView(cfg), dataDir: scope.dataDir };
    });
  }
  importConfiguration({ name, tunnelId, targetId, targetConfig, sourceFiles, verify, prepare, prepareProfile }) {
    return this.enqueue(async () => {
      const checkTarget = () => {
        if (this.shuttingDown) throw new Error("程序正在退出，已取消账户导入。");
        if (this.selectedId !== targetId || JSON.stringify(this.readConfig(targetId)) !== targetConfig)
          throw new Error("当前账户或配置在预览后发生变化，请重新预览导入。");
        if (this.readRegistryText() !== this.registryText) throw new Error("账号索引被其他程序修改；未覆盖。");
      };
      checkTarget();
      verify();
      const root = this.root();
      const oldRegistry = this.registry, oldText = this.registryText;
      const publishTransaction = (changes, next) => {
        const value = { ...next, version: 1, revision: this.registry.revision + 1 };
        const text = JSON.stringify(value, null, 2) + "\n";
        const expected = oldText === null ? { existed: false } : { existed: true, sha256: importTransaction.digest(Buffer.from(oldText)) };
        try {
          const result = importTransaction.commit(root, [...changes, { file: this.registryFile(), data: Buffer.from(text), expected }]);
          this.registry = value; this.registryText = text;
          return result;
        }
        catch (error) {
          // A failed journal restores accounts.json on disk. Never leave an
          // in-memory selection pointing at a rolled-back account.
          if (this.readRegistryText() !== oldText)
            throw new Error("账号导入中断且索引尚未安全恢复；请重新启动程序执行恢复检查，原备份已保留。");
          this.registry = oldRegistry;
          this.registryText = oldText;
          throw error;
        }
      };
      const profileChanges = async dataDir => {
        const plan = prepareProfile ? await prepareProfile(dataDir) : { changes: [] };
        if (!plan || !Array.isArray(plan.changes)) throw new Error("旧版 Skills/MCP 迁移清单无效；未执行导入。");
        return plan.changes;
      };
      const sameFile = file => sourceFiles.some(source => path.resolve(source).toLowerCase() === path.resolve(file).toLowerCase());
      const existing = tunnelId && this.registry.accounts.find(row => this.readConfig(row.id).tunnelId === tunnelId);
      if (existing) {
        const existingScope = this.scope(existing.id);
        const file = path.join(existingScope.dataDir, "config.json");
        if (sameFile(file)) throw new Error("导入来源已经是当前账户；请直接使用此账户。");
        const original = fs.readFileSync(file);
        const changes = await profileChanges(existingScope.dataDir);
        const saved = this.readConfig(existing.id);
        const credentialsImported = !saved.apiKeyEnc;
        if (credentialsImported) {
          // A same-Tunnel profile may have the address but no working key.
          // Fill only the absent credential, using source-context decryption
          // and target-context re-encryption; never replace a populated key.
          this.assertStopped(existing.id);
          const source = await prepare();
          if (!source?.apiKeyEnc) throw new Error("来源没有可迁移的 Runtime API Key；现有账号未修改。");
          const supplemented = {
            ...saved,
            apiKeyEnc: source.apiKeyEnc,
            adminTokenEnc: saved.adminTokenEnc || source.adminTokenEnc || "",
            credentialFormat: source.credentialFormat,
          };
          this.validateConfig(existing.id, supplemented);
          changes.unshift({ file, data: Buffer.from(JSON.stringify(credentialFormat.markForSave(supplemented), null, 2), "utf8"), expected: { existed: true, sha256: importTransaction.digest(original) } });
        }
        if (changes.length) this.assertStopped(existing.id);
        checkTarget();
        verify();
        if (!fs.readFileSync(file).equals(original) || this.readConfig(existing.id).tunnelId !== tunnelId)
          throw new Error("已有账户配置在预览后发生变化；没有合并来源资料。");
        if (changes.length || this.selectedId !== existing.id) {
          publishTransaction(changes, { ...this.registry, selectedId: existing.id });
        }
        try { this.emit("accounts-changed"); this.emit("selected", { id: existing.id }); } catch { /* committed */ }
        return { accountId: existing.id, reused: true, sourceName: name,
          profileFiles: changes.length - (credentialsImported ? 1 : 0), credentialsImported };
      }
      const current = this.readConfig(targetId);
      const adopt = !current.tunnelId && !current.apiKeyEnc && !current.setupDone;
      if (adopt) this.assertStopped(targetId);
      else if (this.registry.accounts.length >= MAX_ACCOUNTS) throw new Error(`最多保留 ${MAX_ACCOUNTS} 个账号配置档。`);
      const id = adopt ? targetId : crypto.randomUUID().replace(/-/g, "");
      const scope = this.makeScope(id), file = path.join(scope.dataDir, "config.json");
      if (!adopt && fs.existsSync(scope.dataDir)) throw new Error("导入目标已存在，未覆盖。");
      if (sameFile(file)) throw new Error("导入来源就是当前配置；请直接使用此账户，原文件未修改。");
      const original = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const cfg = await prepare();
      this.validateConfig(id, cfg);
      let uniqueName = checkedName(name), suffix = 1;
      while (this.registry.accounts.some(row => row.id !== id && row.name.toLowerCase() === uniqueName.toLowerCase()))
        uniqueName = checkedName(`${[...name].slice(0, 45).join("")}（导入 ${suffix++}）`);
      if (adopt) this.removingIds.add(id); // same start guard while awaiting port probes
      let profileCount = 0;
      try {
        const availability = await Promise.all(PORT_KEYS.map(async key => ({ key, port: cfg[key], free: await this.portFree(cfg[key]) })));
        const occupied = availability.filter(row => !row.free);
        if (occupied.length) throw new Error(`旧账户端口正被本机程序占用（${occupied.map(row => `${row.key}: ${row.port}`).join("、")}）；请先停止旧版服务后重试，将保留原端口。`);
        checkTarget();
        if (adopt) this.assertStopped(id);
        this.validateConfig(id, cfg);
        verify();
        const changes = await profileChanges(scope.dataDir);
        profileCount = changes.length;
        checkTarget();
        verify();
        const now = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (Boolean(now) !== Boolean(original) || (now && !now.equals(original))) throw new Error("导入目标配置被其他程序修改；未覆盖。");
        const serialized = Buffer.from(JSON.stringify(credentialFormat.markForSave(cfg), null, 2), "utf8");
        const row = { id, name: uniqueName, createdAt: new Date().toISOString() };
        const rows = adopt ? this.registry.accounts.map(item => item.id === id ? { ...item, name: uniqueName } : item)
          : [...this.registry.accounts, row];
        publishTransaction([{ file, data: serialized, expected: original === null ? { existed: false } : { existed: true, sha256: importTransaction.digest(original) } }, ...changes],
          { ...this.registry, accounts: rows, selectedId: id });
      } finally { if (adopt) this.removingIds.delete(id); }
      try { this.emit("accounts-changed"); this.emit("selected", { id }); } catch { /* registry already committed */ }
      return { accountId: id, reused: false, sourceName: name, profileFiles: profileCount };
    });
  }
  select(id) {
    return this.enqueue(() => {
      this.record(id);
      this.readConfig(id); // fail closed before changing the selection
      if (id !== this.registry.selectedId) this.publish({ ...this.registry, selectedId: id });
      this.emit("selected", { id });
      return this.list();
    });
  }
  rename(id, value) {
    return this.enqueue(() => {
      this.record(id);
      const name = checkedName(value);
      if (this.registry.accounts.some((row) => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) throw new Error("账号名称已存在。");
      this.publish({ ...this.registry, accounts: this.registry.accounts.map((row) => row.id === id ? { ...row, name } : row) });
      return this.list();
    });
  }
  remove(id) {
    return this.enqueue(async () => {
      this.record(id);
      this.assertStopped(id, { allowStatusRefresh: true });
      const root = this.root(), scope = this.scope(id);
      this.removingIds.add(id);
      let backup = null, replacement = null, replacementConfig = null, committed = false;
      try {
        // Reserve before awaiting: refreshAll and service starts skip this account.
        // Drain the current status batch before moving any profile-owned files.
        if (this.instances.get(id)?.refreshing && this.refreshPromise) {
          let timer;
          try {
            await Promise.race([this.refreshPromise, new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error("账号状态刷新尚未结束，未移除账号；请稍后重试。")), 15000);
            })]);
          } finally { clearTimeout(timer); }
        }
        if (this.shuttingDown) throw new Error("程序正在退出，已取消账号移除。");
        this.assertStopped(id);
        const recoveryRoot = containedTree(root, path.join(root, "account-recovery"));
        if (fs.existsSync(recoveryRoot) && !fs.statSync(recoveryRoot).isDirectory()) throw new Error("账号恢复备份位置不是目录。");
        let accounts = this.registry.accounts.filter(row => row.id !== id);
        if (!accounts.length) {
          const newId = crypto.randomUUID().replace(/-/g, "");
          const newScope = this.makeScope(newId);
          const ports = await this.allocatePorts();
          if (fs.existsSync(newScope.dataDir)) throw new Error("新账号目录已存在，未覆盖。");
          const cfg = { ...this.config.DEFAULTS, ...ports, workspacePath: path.join(this.app.getPath("documents"), "Web Harness Workspaces", newId), setupDone: false, autoStart: false, tunnelId: "", apiKeyEnc: "", adminTokenEnc: "" };
          this.validateConfig(newId, cfg);
          replacement = newScope;
          replacementConfig = cfg;
          accounts = [{ id: newId, name: "默认账户", createdAt: new Date().toISOString() }];
        }
        if (this.shuttingDown) throw new Error("程序正在退出，已取消账号移除。");
        this.assertStopped(id);
        const leaves = [...ACCOUNT_LEAVES];
        if (fs.existsSync(scope.dataDir)) for (const name of fs.readdirSync(scope.dataDir)) {
          if (/^config\.json\.\d+\.\d+\.bak$/.test(name)) leaves.push(name);
        }
        const sources = leaves.map(name => ({ name, file: containedTree(root, path.join(scope.dataDir, name)) }))
          .filter(row => fs.existsSync(row.file));
        // Workspace contents are never account-owned, including hand-edited
        // legacy configurations that place a workspace inside a profile leaf.
        for (const row of this.registry.accounts) {
          const cfg = this.readConfig(row.id);
          if (cfg.workspacePath && sources.some(source => overlaps(canonicalDirectory(cfg.workspacePath), path.join(canonicalDirectory(path.dirname(source.file)), path.basename(source.file))))) {
            throw new Error("账号数据与工作区重叠，已拒绝归档；请先将工作区移到独立目录。");
          }
        }
        if (this.readRegistryText() !== this.registryText) throw new Error("账号索引被其他程序修改；未覆盖。");
        const selectedId = this.registry.selectedId === id ? accounts[0].id : this.registry.selectedId;
        for (const row of accounts) if (row.id !== replacement?.id) this.readConfig(row.id);
        const value = { ...this.registry, selectedId, accounts, version: 1, revision: this.registry.revision + 1 };
        const text = JSON.stringify(value, null, 2) + "\n";
        backup = importTransaction.withLock(root, () => deleteTransaction.commit(root, id, sources, this.registryText, text,
          () => atomicRegistry(this.registryFile(), text), replacement && {
            id: replacement.id,
            prepare: stage => context.run({ id: replacement.id, dataDir: stage }, () => {
              fs.mkdirSync(stage, { recursive: true }); this.config.save(replacementConfig); this.paths.ensureRuntimeDir();
            }),
          }));
        this.registry = value;
        this.registryText = text;
        committed = true;
      } catch (error) {
        throw error;
      } finally { this.removingIds.delete(id); }
      if (committed) {
        const item = this.instances.get(id);
        if (item) {
          item.disposed = true;
          try { item.feeds.stop(); } catch { /* no process shutdown or external resource cleanup */ }
          item.services.removeAllListeners(); item.feeds.removeAllListeners();
          this.instances.delete(id);
        }
        // Observer errors cannot roll back an already committed registry.
        try { this.emit("accounts-changed"); this.emit("selected", { id: this.selectedId }); } catch { /* committed */ }
        return { removedId: id, ...this.list(), backup: { created: Boolean(backup), path: backup, recoverable: true } };
      }
    });
  }
  list() {
    this.init();
    return {
      selectedId: this.selectedId, maxAccounts: MAX_ACCOUNTS, registryPath: this.registryFile(),
      securityBoundary: "运行配置档隔离；不是 Windows 用户或系统安全沙箱",
      accounts: this.registry.accounts.map((row) => {
        const cfg = this.readConfig(row.id);
        const item = this.instances.get(row.id);
        return { ...row, config: this.config.publicView(cfg), dataDir: this.scope(row.id).dataDir,
          mcp: { state: item?.services.mcp.state || "stopped", pid: item?.services.mcp.pid || null, owned: Boolean(item?.services.mcp.isAlive()) },
          tunnel: { state: item?.services.tunnel.state || "stopped", pid: item?.services.tunnel.pid || null, owned: Boolean(item?.services.tunnel.isAlive()), cloudState: item?.snapshot?.tunnel?.cloudState || "unknown" },
          busy: Boolean(item?.services.busy), lastError: item?.lastError || "" };
      }),
    };
  }
  instance(id = this.currentId) {
    if (this.instances.has(id)) return this.instances.get(id);
    const scope = this.scope(id);
    return context.run(scope, () => {
      const service = this.makeServices();
      const feed = this.makeFeeds();
      const item = { services: service, feeds: feed, snapshot: null, scope, lastError: "" };
      this.instances.set(id, item);
      // Guard nested start calls as well, including startAll continuing during quit.
      for (const name of START_METHODS) {
        if (typeof service[name] !== "function") continue;
        const original = service[name].bind(service);
        service[name] = context.bind(scope, (...args) => {
          if (this.shuttingDown) throw new Error("程序正在退出，已取消后续启动。");
          if (this.removingIds.has(id)) throw new Error("账号正在移除，不能启动服务。");
          this.validateConfig(id, this.readConfig(id));
          return original(...args);
        });
      }
      service.on("log", context.bind(scope, (entry) => { if (!item.disposed) this.emit("log", { ...entry, accountId: id }); }));
      service.on("status", context.bind(scope, (snapshot) => {
        if (item.disposed) return;
        item.snapshot = { ...snapshot, accountId: id, accountName: this.record(id).name };
        this.syncFeed(item);
        if (id === this.selectedId) this.emit("status", item.snapshot);
        this.emit("accounts-changed");
      }));
      feed.on("lines", context.bind(scope, (entry) => { if (!item.disposed) this.emit("feed-lines", { ...entry, accountId: id }); }));
      feed.on("activity", context.bind(scope, (entry) => { if (!item.disposed) this.emit("feed-activity", { ...entry, accountId: id }); }));
      return item;
    });
  }
  syncFeed(item) {
    if (this.shuttingDown || (!item.services.mcp.isAlive() && !item.services.tunnel.isAlive())) { item.feeds.stop(); return; }
    try {
      const cfg = this.readConfig(item.scope.id);
      const adminToken = this.config.getAdminToken(cfg);
      item.feeds.configure({ adminPort: cfg.adminPort, tunnelPort: cfg.tunnelPort, adminToken, mcpOnStdout: item.services.mcp.isAlive() });
      item.feeds.start();
      item.lastError = "";
    } catch (error) {
      item.feeds.stop();
      item.lastError = error.message;
    }
  }
  facade(kind) {
    const manager = this;
    const emitter = kind === "services" ? { log: "log", status: "status" } : { lines: "feed-lines", activity: "feed-activity" };
    const proxy = new Proxy({}, {
      get(_target, key) {
        if (key === "on") return (event, handler) => { manager.on(emitter[event] || event, handler); return proxy; };
        if (kind === "services" && key === "shutdown") return () => manager.shutdownAll();
        if (kind === "feeds" && key === "stop") return () => manager.stopFeeds();
        const id = manager.currentId;
        const scope = manager.scope(id);
        return context.run(scope, () => {
          const target = manager.instance(id)[kind];
          const value = target[key];
          if (typeof value === "function") return context.bind(scope, (...args) => value.apply(target, args));
          if (kind === "services" && ["mcp", "tunnel"].includes(key)) {
            return new Proxy(value, { get(object, property) {
              return context.run(scope, () => typeof object[property] === "function" ? context.bind(scope, object[property].bind(object)) : object[property]);
            } });
          }
          return value;
        });
      },
    });
    return proxy;
  }
  async refreshAll() {
    if (this.shuttingDown) return;
    if (this.refreshPromise) return this.refreshPromise;
    this.instance(this.selectedId);
    this.refreshPromise = Promise.all([...this.instances].filter(([id, item]) => !this.removingIds.has(id) && (id === this.selectedId || item.services.busy || item.services.mcp.isAlive() || item.services.tunnel.isAlive()))
      .map(([id, item]) => this.run(id, async () => {
        item.refreshing = true;
        try { await item.services.refresh(); }
        catch (error) { item.lastError = error.message; }
        finally { item.refreshing = false; }
      }))).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
  async autoStart() {
    for (const row of this.registry.accounts) {
      if (this.shuttingDown) return;
      try {
        const cfg = this.readConfig(row.id);
        if (!cfg.setupDone || !cfg.autoStart) continue;
        await this.run(row.id, () => this.instance(row.id).services.startAll());
      } catch (error) { this.emit("account-error", { accountId: row.id, message: error.message }); }
    }
  }
  anyAlive() { return [...this.instances.values()].some((item) => item.services.mcp.isAlive() || item.services.tunnel.isAlive() || item.services.busy); }
  stopFeeds() { for (const [id, item] of this.instances) this.run(id, () => item.feeds.stop()); }
  async shutdownAll() {
    this.shuttingDown = true;
    this.stopFeeds();
    await Promise.all([...this.instances].map(([id, item]) => this.run(id, () => item.services.shutdown())));
  }
}
module.exports = { AccountManager, MAX_ACCOUNTS, PORT_KEYS, checkedName, canonicalDirectory, overlaps, isPortFree };
