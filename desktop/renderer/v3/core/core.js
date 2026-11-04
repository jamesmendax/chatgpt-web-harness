/* Web Harness v3 front-end core.
 * One runtime contract for two back ends:
 *   - Electron: the production preload bridge `window.launcher` (desktop/src/preload.js), same channels
 *     and payloads as desktop/renderer/app.js, including per-account request scoping.
 *   - Preview: the in-browser simulation in shared/sim.js (no network, files or services).
 * Views subscribe to events and render; they never touch IPC directly. */
(function (global) {
  "use strict";
  const Sim = global.HarnessSim;
  const { hms, relative, duration } = Sim.fmt;

  /* ---------- log parsing shared by both back ends ---------- */
  const levelOf = text => (/\b(error|failed|fatal|exit 1|401|EOF|refused)\b/i.test(text) || /\[(blocked|failure)\]|\bstatus=failure\b/i.test(text)) ? "error" : /\[warn(ing)?\]|stale|backing off|occupied/i.test(text) ? "warn" : "info";
  const isHealth = text => /\/health|\/readyz|\[poll\] ok/i.test(text);
  let seq = 0;
  function parseLine(source, line, reference = Date.now()) {
    const m = /^(\d{2}:\d{2}:\d{2})\s+(.*)$/.exec(String(line));
    const text = (m ? m[2] : String(line)).replace(/^!\s+/, "");
    let ts = reference;
    if (m) {
      const parts = m[1].split(":").map(Number), date = new Date(reference);
      if (parts[0] < 24 && parts[1] < 60 && parts[2] < 60) {
        date.setHours(parts[0], parts[1], parts[2], 0);
        // Collection timestamps have no date. Choose the latest occurrence,
        // including yesterday for a buffer crossing midnight.
        if (date.getTime() > reference) date.setDate(date.getDate() - 1);
        ts = date.getTime();
      }
    }
    return { seq: ++seq, ts, time: m ? m[1] : hms(reference), source, text, level: levelOf(text), health: isHealth(text) };
  }
  function parseHistory(source, lines) {
    let reference = Date.now();
    return [...lines].reverse().map(line => {
      const entry = parseLine(source, line, reference);
      reference = entry.ts;
      return entry;
    }).reverse();
  }
  // A production TOOL line carries no duration; the HTTP-level [MCP] line written
  // when the same call's response finishes does.
  function timedCall(text) {
    const m = /^\[MCP\] \[(?:ok|transport_ok)\] tools\/call ([\w.-]+)(?: — .*?)? (\d+)ms(?: session=\S+)?(?: conv=[0-9a-f]+)?$/.exec(text);
    return m ? { tool: m[1], ms: Number(m[2]) } : null;
  }
  // Canonical invocation identity is the only safe way to pair concurrent calls.
  function invocationDiagnostic(text) {
    const values = Object.fromEntries(text.trim().split(/\s+/).filter(Boolean).map(token => token.split("=")));
    return {
      outcomeKind: ["needs_input", "review_rejected", "blocked", "execution_error"].includes(values.outcome) ? values.outcome : undefined,
      errorCode: /^[A-Z][A-Z0-9_]{1,79}$/.test(values.code || "") ? values.code : undefined,
      failurePhase: ["admission", "validation", "execution", "postprocessing"].includes(values.phase) ? values.phase : undefined,
      operationStarted: values.started === "true" ? true : values.started === "false" ? false : undefined,
      retryPolicy: ["retry_with_changed_args", "refresh_state", "inspect_original_result", "repair_then_review", "none"].includes(values.retry) ? values.retry : undefined
    };
  }
  function invocationFromLine(text) {
    const stdout = /^\[(TOOL|MCP)\] \[(running|ok|transport_ok|error|blocked|failed|failure)\] (?:tools\/call )?([\w.-]+)(.*)$/.exec(text);
    const error = /^\[MCP ERROR\](?: HTTP \d+)? tools\/call ([\w.-]+)(.*)$/.exec(text);
    const feed = /^\[(tool|mcp)\] tools\/call ([\w.-]+) (running|ok|transport_ok|error|blocked|failed|failure) (\d+)ms((?: (?:outcome|code|phase|started|retry)=[A-Za-z0-9_]+)*) call=([^\s]+)(?: client=\S+)?(?: session=\S+)?(?: conv=[0-9a-f]+)?(?: — (.*))?$/.exec(text);
    let status, tool, ms, callId, summary, transport, diagnostic;
    if (stdout || error) {
      const rest = stdout ? stdout[4] : error[2];
      const tail = / (\d+)ms((?: (?:outcome|code|phase|started|retry)=[A-Za-z0-9_]+)*) call=([^\s]+)(?: session=\S+)?(?: conv=[0-9a-f]+)?$/.exec(rest);
      if (!tail) return null;
      status = stdout ? stdout[2] : "error"; tool = stdout ? stdout[3] : error[1];
      transport = !stdout || stdout[1] === "MCP";
      ms = Number(tail[1]); diagnostic = tail[2]; callId = tail[3]; summary = rest.slice(0, tail.index).replace(/^ — /, "");
    } else if (feed) {
      let kind; [, kind, tool, status, ms, diagnostic, callId, summary = ""] = feed;
      transport = kind === "mcp"; ms = Number(ms);
    } else return null;
    return { callId, tool, phase: status === "running" ? "running" : /^(ok|transport_ok)$/.test(status) ? "done" : "failed", ms, target: summary, summary, transport, ...invocationDiagnostic(diagnostic || "") };
  }
  // Production TOOL lines already describe completed invocations. Preview
  // emits pairs without IDs; only pair these when exactly one call is open.
  function activityFromLogs(entries, into = [], changes = []) {
    for (const e of entries) {
      // Optional trace and normal TOOL output describe the same call but only
      // trace has an invocation ID. Keep diagnostics in logs, avoid double count.
      if (/^\[HARNESS\]/.test(e.text)) continue;
      const invocation = invocationFromLine(e.text);
      if (invocation) {
        const known = into.find(x => x.callId === invocation.callId);
        // Gateway lifecycle is authoritative; HTTP is only a fallback when it was absent.
        if (known && !known.transport && invocation.transport) continue;
        // Replayed starts cannot reopen canonical terminal records. A late canonical
        // start may supersede a transport-only fallback with the same exact ID.
        if (known && !known.transport && known.phase !== "running" && invocation.phase === "running") continue;
        if (known && known.transport === invocation.transport && known.phase === invocation.phase && known.ms === invocation.ms && known.summary === invocation.summary &&
          ["outcomeKind", "errorCode", "failurePhase", "operationStarted", "retryPolicy"].every(key => known[key] === invocation[key])) continue;
        const record = known || { id: "C" + invocation.callId, callId: invocation.callId, startedAt: e.ts - invocation.ms };
        const wasRunning = known && known.phase === "running";
        const replacingFallback = known && known.transport && !invocation.transport;
        Object.assign(record, invocation, { ok: invocation.phase === "running" ? null : invocation.phase === "done", endedAt: invocation.phase === "running" ? null : e.ts });
        if (invocation.phase !== "running") record.startedAt = e.ts - invocation.ms;
        if (!known) into.push(record);
        changes.push({ kind: (!known || replacingFallback) && invocation.phase === "running" ? "start" : invocation.phase !== "running" && (!known || wasRunning) ? "end" : "update", record });
        continue;
      }
      // HTTP timing without an invocation ID cannot be assigned to a tool record.
      if (timedCall(e.text)) continue;
      if (/^\[TOOL\] \[running\]/.test(e.text)) continue;
      const completed = /^\[TOOL\](?:\s*\[([^\]]+)\])?\s+([\w.-]+)(?:\s+—\s+(.*?))?(?:\s+(\d+)ms)?(?:\s+session=\S+)?(?:\s+conv=[0-9a-f]+)?$/.exec(e.text);
      const failed = /^\[MCP ERROR\](?:\s+HTTP\s+\d+)?\s+tools\/call\s+([\w.-]+)(?:\s+—\s+(.*?))?(?:\s+(\d+)ms)?(?:\s+session=\S+)?(?:\s+conv=[0-9a-f]+)?$/.exec(e.text);
      if (completed || failed) {
        const ok = !failed && !/^(error|blocked|failed|failure)$/i.test(completed[1] || "");
        const tool = failed ? failed[1] : completed[2];
        const summary = (failed ? failed[2] : completed[3]) || "";
        const msText = failed ? failed[3] : completed[4], ms = msText == null ? null : Number(msText);
        const record = { id: "L" + e.seq, tool, target: summary, startedAt: ms == null ? e.ts : e.ts - ms, endedAt: e.ts, ms, ok, summary, phase: ok ? "done" : "failed" };
        into.push(record); changes.push({ kind: "end", record });
        continue;
      }
      const t = /^\[tool\]\s+([\w.-]+)\s*(?:·\s*(.*))?$/.exec(e.text);
      if (t) { const record = { id: "L" + e.seq, tool: t[1], target: t[2] || "", startedAt: e.ts, endedAt: null, ms: null, ok: null, summary: "", phase: "running" }; into.push(record); changes.push({ kind: "start", record }); continue; }
      const r = /^\[result\]\s+(Completed|Failed)\s+in\s+(\d+)\s*ms\s*(?:·\s*(.*))?$/i.exec(e.text);
      if (r) {
        const candidates = into.filter(x => x.phase === "running");
        const open = candidates.length === 1 ? candidates[0] : null;
        if (open) { Object.assign(open, { endedAt: e.ts, ms: Number(r[2]), ok: /completed/i.test(r[1]), summary: r[3] || "", phase: /completed/i.test(r[1]) ? "done" : "failed" }); changes.push({ kind: "end", record: open }); }
      }
    }
    return into;
  }

  /* ---------- settings schema (production config keys) ---------- */
  const SETTINGS = [
    { id: "credentials", title: "凭据与工作区", fields: [
      { key: "tunnelId", label: "Tunnel ID", type: "text", placeholder: "tunnel_ 后接 32 位十六进制", mono: true, link: ["获取 Tunnel ID", "https://platform.openai.com/settings/organization/tunnels"] },
      { key: "apiKey", label: "Runtime API Key", type: "password", placeholder: "sk-…", mono: true, secret: true, link: ["获取 Runtime API Key", "https://platform.openai.com/settings/organization/api-keys"] },
      { key: "workspacePath", label: "工作区目录", type: "path", placeholder: "例如 C:\\Users\\你\\Documents\\项目", mono: true, help: "ChatGPT 操作的项目目录，不要选择本软件源码目录。" }
    ] },
    { id: "network", title: "端口与网络", fields: [
      { key: "mcpPort", label: "MCP 端口", type: "port" },
      { key: "tunnelPort", label: "Tunnel 健康端口", type: "port" },
      { key: "adminPort", label: "Admin UI 端口", type: "port" },
      { key: "toolProfile", label: "工具集", type: "choice", options: [["slim", "slim", "30 个工具，日常推荐"], ["full", "full", "全部 77 个工具"]], help: "重启 MCP 后生效。" },
      { key: "tunnelProxyMode", label: "Tunnel 出站代理", type: "choice", options: [["auto", "自动", "环境变量，再系统代理/PAC"], ["direct", "直连", "不使用代理"], ["custom", "自定义", "填写下方地址"]] },
      { key: "tunnelProxyUrl", label: "自定义代理地址", type: "text", placeholder: "http://127.0.0.1:7890", mono: true, help: "不含用户名或密码。只影响 Tunnel 出站，不修改系统代理。", when: c => c.tunnelProxyMode === "custom" }
    ] },
    { id: "desktop", title: "桌面偏好", fields: [
      { key: "autoStart", label: "打开启动器时自动启动服务", type: "switch" },
      { key: "minimizeToTray", label: "服务运行时关闭窗口，最小化到托盘", type: "switch" },
      { key: "skipDoctor", label: "跳过初始化检查（tunnel-client doctor）", type: "switch" }
    ] }
  ];
  const GUIDE = [
    a => `确认账户“${a.name}”的 MCP 与 Tunnel 均已就绪。`,
    () => "打开 ChatGPT 设置中的 Connectors，先在 Security and login 里开启 Developer mode。",
    a => `新建连接器，建议命名为“Web Harness ${a.name}”。Connection 选择 Tunnel，不要填 localhost，选中当前账户的 tunnel 或粘贴 Tunnel ID。`,
    () => "Authentication 保持默认，点击 Create，再点 Connect。",
    () => "在 Settings 的 Apps 里找到这个应用，权限设为 Allow all actions / Never ask，否则 Goal 连续执行会被反复打断。",
    () => "新开对话并添加该应用，先发一条只读探针：请只读取工作区目录列表，不要修改任何文件。看到工具卡片和文件列表即成功。",
    () => "其他账户：新建账户，配置独立凭据，再创建对应的 Connector。"
  ];
  function validate(patch) {
    const ports = ["mcpPort", "tunnelPort", "adminPort"].map(k => Number(patch[k]));
    if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== 3) return "端口必须是 1024–65535 之间互不相同的整数。";
    if (patch.tunnelId && !/^tunnel_[0-9a-z-]{8,}$/i.test(patch.tunnelId)) return "Tunnel ID 应以 tunnel_ 开头。";
    if (patch.tunnelProxyMode === "custom" && /@/.test(patch.tunnelProxyUrl || "")) return "代理地址不能包含用户名或密码。";
    return null;
  }

  /* ---------- Electron back end (production preload) ---------- */
  function electronBackend() {
    const L = global.launcher;
    const ACCOUNT_METHODS = new Set(["listAccounts", "createAccount", "selectAccount", "renameAccount", "removeAccount", "inspectAccountImport", "importAccount"]);
    const st = { info: null, accounts: null, accountId: null, config: null, status: null, logs: { mcp: [], tunnel: [], launcher: [] }, catalog: null, activity: [], drafts: null };
    const bus = makeBus();
    let epoch = 0, selecting = false, selectionQueue = Promise.resolve(), loading = null, statusRevision = 0, setupStreamed = false;
    const stale = () => Object.assign(new Error("账号已切换，已忽略上一账号的返回结果。"), { code: "STALE" });
    function changeAccount(id) {
      epoch++; st.accountId = id;
      Object.assign(st, { info: null, config: null, status: null, catalog: null, drafts: null, activity: [], logs: { mcp: [], tunnel: [], launcher: [] } });
      // Clear the previous account from the view before waiting for the new IPC data.
      bus.emit("change");
    }
    async function call(name, payload, expectedEpoch = epoch) {
      const scoped = !ACCOUNT_METHODS.has(name), acct = scoped ? st.accountId : null;
      if (scoped && expectedEpoch !== epoch) throw stale();
      let body = payload;
      if (scoped && acct) body = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...payload, _accountId: acct } : { _accountId: acct };
      if (typeof L[name] !== "function") throw new Error(`桌面连接缺少 ${name} 方法，请重新启动或更新应用。`);
      let res;
      try { res = await L[name](body); }
      catch (err) { if (scoped && expectedEpoch !== epoch) throw stale(); throw err; }
      if (scoped && (expectedEpoch !== epoch || acct !== st.accountId || (res && res.accountId && res.accountId !== acct))) {
        if (name === "inspectSkillSource" && res && res.ok && res.result && res.result.temporary && res.result.source) {
          L.discardSkillSource({ source: res.result.source, _accountId: acct }).catch(() => {});
        }
        throw stale();
      }
      if (!res || !res.ok) throw new Error((res && res.error) || "未知错误");
      return res.result;
    }
    async function loadAccount() {
      const expected = epoch, revision = statusRevision, buffer = { epoch: expected, logs: [] };
      loading = buffer;
      try {
        const [info, config, logs, status] = await Promise.all([call("appInfo"), call("getConfig"), call("getLogs"), call("getStatus")]);
        if (epoch !== expected) throw stale();
        Object.assign(st, { info, config, catalog: null, drafts: null });
        if (revision === statusRevision) st.status = status;
        if (st.status && st.status.config) st.config = st.status.config;
        st.logs = { mcp: [], tunnel: [], launcher: [] };
        for (const k of Object.keys(st.logs)) {
          const history = (logs && logs[k]) || [], queued = buffer.logs.filter(x => x.name === k).map(x => x.line);
          let overlap = Math.min(history.length, queued.length);
          while (overlap && !history.slice(-overlap).every((line, i) => line === queued[i])) overlap--;
          st.logs[k] = parseHistory(k, [...history, ...queued.slice(overlap)]).slice(-3000);
        }
        st.activity = activityFromLogs(st.logs.mcp);
        if (loading === buffer) loading = null;
        try { const catalog = await call("getSkillCatalog"); if (epoch !== expected) throw stale(); st.catalog = catalog; }
        catch (err) { if (err.code === "STALE") throw err; bus.emit("notice", { message: `能力库读取失败：${err.message}`, level: "error" }); }
      } finally { if (loading === buffer) loading = null; }
    }
    const refresh = async (expected = epoch) => { const revision = statusRevision; try { const status = await call("getStatus", undefined, expected); if (revision !== statusRevision) return; st.status = status; if (status.config) st.config = status.config; bus.emit("change"); } catch (_) {} };
    L.on("status", s => { if (!s || s.accountId !== st.accountId) return; statusRevision++; st.status = s; if (s.config) st.config = s.config; bus.emit("change"); });
    L.on("log", batch => {
      for (const item of Array.isArray(batch) ? batch : []) {
        if (!item || item.accountId !== st.accountId || !["mcp", "tunnel", "launcher"].includes(item.name) || typeof item.line !== "string") continue;
        if (loading && loading.epoch === epoch) { loading.logs.push(item); continue; }
        const list = st.logs[item.name] || (st.logs[item.name] = []);
        const entry = parseLine(item.name, item.line); list.push(entry);
        if (list.length > 3000) list.splice(0, list.length - 3000);
        bus.emit("log", entry);
        if (item.name === "mcp") {
          const changes = [];
          activityFromLogs([entry], st.activity, changes);
          if (st.activity.length > 3000) st.activity.splice(0, st.activity.length - 3000);
          for (const change of changes) bus.emit("activity", change);
        }
      }
    });
    L.on("notice", n => { if (!n || n.accountId !== st.accountId) return; bus.emit("notice", { message: n.message, level: n.level === "error" ? "error" : "info" }); });
    L.on("setup:progress", p => { if (!p || p.accountId !== st.accountId) return; if (p.stage === "doctor-line") setupStreamed = true; bus.emit("setup-progress", p.stage === "download" && p.total ? `准备 tunnel-client… ${Math.round(p.received / p.total * 100)}%` : p.message || ""); });
    L.on("accounts:changed", snap => { if (snap && Array.isArray(snap.accounts)) { st.accounts = snap; if (!selecting && st.accountId && snap.selectedId && snap.selectedId !== st.accountId) { changeAccount(snap.selectedId); loadAccount().then(() => { bus.emit("account"); bus.emit("change"); }).catch(err => { if (err.code !== "STALE") bus.emit("notice", { message: err.message, level: "error" }); }); } bus.emit("change"); } });
    setInterval(() => { if (!document.hidden && st.accountId) refresh(); }, 8000);

    const pending = new Set();
    async function guarded(name, fn) {
      const key = `${epoch}:${name}`;
      if (pending.has(key)) return;
      pending.add(key); bus.emit("change");
      try { return await fn(); }
      catch (err) { if (err.code !== "STALE") bus.emit("notice", { message: err.message, level: "error" }); throw err; }
      finally { pending.delete(key); bus.emit("change"); }
    }
    const service = (name, label) => () => guarded(name, async () => { const expected = epoch; await call(name, undefined, expected); await refresh(expected); if (epoch !== expected) throw stale(); bus.emit("notice", { message: `${label}请求已处理；运行结果以服务状态为准。`, level: "info" }); });
    function account() {
      const row = st.accounts && st.accounts.accounts.find(a => a.id === st.accountId) || { id: st.accountId, name: "当前账户" };
      let mcp = (st.status && st.status.mcp) || {}, tunnel = (st.status && st.status.tunnel) || {};
      // collectStatus intentionally probes listeners outside this account. In
      // isolated/multi-account mode those are collisions, never owned readiness.
      // Preserve the observed values separately for diagnostics, without letting
      // raw view fields (or Sim.derive) light this account's connection indicator.
      // While a new account's appInfo is loading, fail closed for ownership too.
      if (!st.info || st.info.isolated || st.info.multiAccount) {
        if (!mcp.managed) {
          const occupied = !!(mcp.external || mcp.healthy || mcp.pid || mcp.portOccupiedByUnknown);
          mcp = { ...mcp, observedExternal: mcp, healthy: false, external: occupied, externalRecognized: false,
            portOccupiedByUnknown: occupied, toolCount: null, toolProfile: null, build: null, staleBuild: null,
            auth: null, providers: null, startedAt: null,
            ownershipReason: occupied ? "MCP 端口被外部进程占用，不属于当前账户；请选择独立端口。" : null };
        }
        if (!tunnel.managed) {
          const occupied = !!(tunnel.external || tunnel.reachable || tunnel.ready || tunnel.pid || tunnel.portOccupiedByUnknown);
          tunnel = { ...tunnel, observedExternal: tunnel, ready: false, reachable: false, external: occupied, externalRecognized: false,
            cloudState: "offline", lastPollSuccessAt: null, instanceId: null, proxyRoute: null, authError: null, metaError: null,
            portOccupiedByUnknown: occupied,
            ownershipReason: occupied ? "隧道端口被外部进程占用，不属于当前账户；请选择独立端口。" : null };
        }
      }
      return { id: row.id, name: row.name, config: st.config || {}, mcp, tunnel };
    }
    function deriveAccount(a) {
      const d = Sim.derive(a), reason = "外部进程占用（不属于当前账户）";
      if (a.mcp.ownershipReason && d.mcp) d.mcp = { ...d.mcp, source: reason };
      if (a.tunnel.ownershipReason && d.tunnel) d.tunnel = { ...d.tunnel, source: reason, readyText: "端口被外部进程占用", cloudText: "当前账户尚未连接；外部进程的轮询不计入本账户。" };
      return d;
    }
    // External registrations are edited as a draft until saved; a catalog refresh must not drop those edits.
    let draftsDirty = false;
    const catalog = () => {
      const c = st.catalog || { computerUse: {}, browserUse: {}, installed: [], external: [], project: [], builtin: [], configPath: "profiles/plugins.json" };
      if (!st.drafts) { st.drafts = (c.external || []).map(x => ({ ...x })); draftsDirty = false; }
      return { ...c, external: st.drafts };
    };
    const setCatalog = c => { st.catalog = c; st.drafts = null; draftsDirty = false; bus.emit("change"); };
    const actions = {
      startAll: service("startAll", "启动"), stopAll: service("stopAll", "停止"), startMcp: service("startMcp", "启动 MCP"), stopMcp: service("stopMcp", "停止 MCP"),
      restartMcp: service("restartMcp", "重启 MCP"), startTunnel: service("startTunnel", "启动 Tunnel"), stopTunnel: service("stopTunnel", "停止 Tunnel"), stopExternal: service("stopExternal", "接管外部进程"),
      selectAccount(id) {
        const task = selectionQueue.catch(() => {}).then(async () => {
          selecting = true;
          try {
            const snap = await call("selectAccount", { id });
            st.accounts = snap;
            if (st.accountId !== snap.selectedId) { changeAccount(snap.selectedId); await loadAccount(); bus.emit("account"); }
            bus.emit("change");
          } finally { selecting = false; }
        });
        selectionQueue = task;
        return task;
      },
      async createAccount(name) { const created = await call("createAccount", { name }); await actions.selectAccount(created.id); bus.emit("notice", { message: `已创建账户“${name}”。它不会复制其他账户的密钥。`, level: "info" }); },
      async renameAccount(id, name) { st.accounts = await call("renameAccount", { id, name }); bus.emit("change"); },
      async inspectAccountImport() { const expected = epoch, result = await call("inspectAccountImport"); if (epoch !== expected) throw stale(); return result; },
      importAccount(payload) {
        const task = selectionQueue.catch(() => {}).then(async () => {
          selecting = true;
          try {
            const result = await call("importAccount", payload);
            st.accounts = await call("selectAccount", { id: result.accountId });
            changeAccount(result.accountId); await loadAccount(); bus.emit("account"); bus.emit("change");
            const profileFiles=Number(result.profileFiles)||0;
            bus.emit("notice", { message: result.reused
              ? (profileFiles ? `已补齐已有账户的 ${profileFiles} 项文件，原密钥和端口保持不变。请检查服务配置。` : "已切换已有账户，配置和文件无需覆盖。")
              : `账号已导入，已携带 ${profileFiles} 项关联文件；服务尚未自动启动，请核验连接。`, level: "info" });
            return result;
          } finally { selecting = false; }
        });
        selectionQueue = task; return task;
      },
      removeAccount(id) {
        const task = selectionQueue.catch(() => {}).then(async () => {
          selecting = true;
          try {
            const result = await call("removeAccount", { id });
            st.accounts = result;
            if (st.accountId !== result.selectedId) { changeAccount(result.selectedId); await loadAccount(); bus.emit("account"); }
            bus.emit("change");
            bus.emit("notice", { message: "账户已移除。", level: "info" });
            return result;
          } finally { selecting = false; }
        });
        selectionQueue = task;
        return task;
      },
      // Desktop-only preference: saved on its own so it can change while services run.
      async setIdleReminder(minutes) { const expected = epoch, saved = await call("setIdleReminder", { minutes }, expected); if (epoch !== expected) throw stale(); st.config = saved; bus.emit("change"); return saved.idleReminderMinutes; },
      async getNotificationSounds() { const expected=epoch; return call("getNotificationSounds",undefined,expected); },
      async selectNotificationSound(id) {
        const expected=epoch,saved=await call("selectNotificationSound",{id},expected);
        st.config=await call("getConfig",undefined,expected);bus.emit("change");return saved;
      },
      async setNotificationVolume(volume) {
        const expected=epoch,saved=await call("setNotificationVolume",{volume},expected);
        st.config=await call("getConfig",undefined,expected);bus.emit("change");return saved;
      },
      async previewNotificationSound(id) {
        const expected=epoch;return call("previewNotificationSound",{id},expected);
      },
      async importNotificationAudio(wavBase64) {
        const expected=epoch,saved=await call("importNotificationAudio",{wavBase64},expected);
        st.config=await call("getConfig",undefined,expected);bus.emit("change");return saved;
      },
      async listConversationNames() { const expected=epoch;return call("listConversationNames",undefined,expected); },
      async renameConversation(id,alias) {const expected=epoch;return call("renameConversation",{id,alias},expected);},
      async pinConversation(id,enabled) {const expected=epoch;return call("pinConversation",{id,enabled},expected);},
      async clearInactiveConversations() {const expected=epoch;return call("clearInactiveConversations",undefined,expected);},
      async saveConfig(patch) { const expected = epoch, err = validate(patch); if (err) throw new Error(err); const body = { ...patch }; if (!body.apiKey) delete body.apiKey; await call("saveConfig", body, expected); st.config = await call("getConfig", undefined, expected); bus.emit("change"); bus.emit("notice", { message: "设置已保存。端口与工具集在重启服务后生效。", level: "info" }); },
      runSetup: patch => guarded("runSetup", async () => {
        const expected = epoch, err = validate(patch); if (err) throw new Error(err);
        if (!patch.tunnelId) throw new Error("请填写 Tunnel ID。");
        const existing = st.accounts?.accounts.find(row => row.id !== st.accountId && row.config?.tunnelId === patch.tunnelId.trim());
        if (existing) throw Object.assign(new Error(`账户「${existing.name}」已保存此 Tunnel，MCP 端口 ${existing.config.mcpPort}。`), { code: "EXISTING_ACCOUNT", title: "已有可用的账户配置", stage: "config", existingAccountId: existing.id, nextAction: "切回已有账户。", checks: [] });
        if (!patch.apiKey && !(st.config && st.config.hasApiKey)) throw new Error("请填写 Runtime API Key。");
        setupStreamed = false;
        const result = await call("runSetup", patch, expected);
        if (result && result.doctor && !setupStreamed) bus.emit("setup-progress", `doctor：${result.doctor}`);
        try { st.config = await call("getConfig", undefined, expected); bus.emit("change"); }
        catch (error) { if (error.code === "STALE" || result?.ok) throw error; }
        if (!result || !result.ok) {
          const failure = new Error((result && result.message) || "初始化未完成，请查看诊断详情。");
          for (const key of ["stage", "code", "title", "nextAction", "checks", "details", "existingAccountId"]) if (result && result[key] != null) failure[key] = result[key];
          throw failure;
        }
        if (!result.doctor) bus.emit("setup-progress", "初始化完成。");
        bus.emit("notice", { message: "初始化完成，接下来请在 ChatGPT 网页端添加应用。", level: "info" });
      }),
      // Skills installed outside this window (MCP install_skill, files copied by hand) appear on the next read.
      async refreshCatalog() {
        const expected = epoch, fresh = await call("getSkillCatalog", undefined, expected);
        if (epoch !== expected) throw stale();
        st.catalog = fresh;
        if (!draftsDirty) st.drafts = null;
        bus.emit("change");
        return fresh;
      },
      async setSkillEnabled(source, id, enabled) { setCatalog((await call("setSkillEnabled", { id, source, enabled })).catalog); },
      async setEngine(name, enabled) { setCatalog((await call(name === "computerUse" ? "setComputerUseEnabled" : "setBrowserUseEnabled", { enabled })).catalog); },
      async inspectSource(kind) {
        const expected = epoch, accountId = st.accountId;
        const source = await call(kind === "zip" ? "pickSkillZip" : "pickSkillFolder", undefined, expected);
        if (!source) return null;
        const meta = await call("inspectSkillSource", { source }, expected);
        return { ...meta, source: meta.source || source, accountId, warnings: meta.warnings || [] };
      },
      discardSource(src) { if (src && src.source) return L.discardSkillSource({ source: src.source, _accountId: src.accountId || st.accountId }).catch(() => {}); },
      async installSkill(id, src) { if (src.accountId && src.accountId !== st.accountId) throw stale(); const r = await call("installSkill", { source: src.source, id, overwrite: true }); setCatalog(r.catalog); bus.emit("notice", { message: `已安装 ${r.result.id}。新建 MCP 会话后可用。`, level: "info" }); },
      async uninstallSkill(id) { setCatalog((await call("uninstallSkill", { id })).catalog); bus.emit("notice", { message: `已卸载 ${id}。`, level: "info" }); },
      addExternal(name, path) {
        path = String(path || "").trim();
        if (!/^[a-z]:\\/i.test(path) || !/SKILL\.md$/i.test(path)) throw new Error("请填写 SKILL.md 的绝对路径。");
        const id = (String(name || "").trim() || path.split("\\").slice(-2, -1)[0] || "external").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        const list = catalog().external;
        if (list.some(s => s.id === id)) throw new Error(`外部注册里已有 ${id}。`);
        list.push({ id, path, enabled: true, description: "保存后读取 SKILL.md", unsaved: true }); draftsDirty = true; bus.emit("change");
      },
      removeExternal(id) { st.drafts = catalog().external.filter(s => s.id !== id); draftsDirty = true; bus.emit("change"); },
      setExternalEnabled(id, enabled) { const row = catalog().external.find(s => s.id === id); if (row) { row.enabled = enabled; row.unsaved = true; draftsDirty = true; bus.emit("change"); } },
      async saveExternal() {
        const c = catalog();
        const r = await call("saveSkillCatalog", { registrations: c.external.map(({ id, path, enabled }) => ({ id, path, enabled })), computerUseEnabled: !!c.computerUse.enabled, browserUseEnabled: !!c.browserUse.enabled });
        setCatalog(r.catalog); bus.emit("notice", { message: "外部注册已保存。", level: "info" });
      },
      async resetProfiles() { setCatalog((await call("resetProfiles")).catalog); bus.emit("notice", { message: "Skill / 插件配置已重置为默认。", level: "info" }); },
      async clearLogs(source) { await call("clearLogs", { name: source }); st.logs[source] = []; if (source === "mcp") st.activity = []; bus.emit("change"); },
      openLogFile: source => source === "launcher" ? call("openLogsFolder") : call("openLogFile", { name: source }),
      openLogsFolder: () => call("openLogsFolder"),
      openRuntime: () => call("openRuntimeFolder"),
      openExternal: url => call("openExternal", { url }),
      async copyText(text, what) { await call("copyText", { text }); bus.emit("notice", { message: `已复制${what || ""}。`, level: "info" }); },
      pickFolder: current => call("pickFolder", { current }),
      pickSkillFile: () => call("pickSkillFile"),
      uninstallApp: () => call("uninstallApp"),
      setScenario: null, simulateCall: null
    };
    return {
      mode: "electron", bus, actions,
      async init() { st.accounts = await call("listAccounts"); st.accountId = st.accounts.selectedId; await loadAccount(); },
      snapshot() {
        const a = account();
        const currentPending = new Set([...pending].filter(key => key.startsWith(`${epoch}:`)).map(key => key.slice(key.indexOf(":") + 1)));
        return { account: a, accounts: (st.accounts && st.accounts.accounts) || [], selectedId: st.accountId, info: st.info || {}, derived: deriveAccount(a), catalog: catalog(), logs: st.logs, activity: st.activity, pending: currentPending, scenario: null };
      }
    };
  }

  /* ---------- preview back end (simulation) ---------- */
  function previewBackend(scenario) {
    const sim = Sim.create({ scenario });
    const bus = makeBus();
    ["change", "log", "activity", "notice", "setup-progress", "account"].forEach(ev => sim.on(ev, payload => bus.emit(ev, payload)));
    const A = sim.actions;
    const actions = Object.assign({}, A, {
      async inspectSource(kind) { return Object.assign(await A.inspectSource(kind), { source: "preview-token" }); },
      async refreshCatalog() { bus.emit("change"); return sim.snapshot().catalog; },
      async setIdleReminder(minutes) { sim.snapshot().account.config.idleReminderMinutes = minutes; bus.emit("change"); return minutes; },
      discardSource() {},
      async inspectAccountImport() { throw new Error("请在桌面版中选择旧版数据目录；网页预览不读取本机账户。"); },
      async importAccount() { throw new Error("网页预览不导入真实账户。"); },
      setExternalEnabled: (id, enabled) => A.setSkillEnabled("external", id, enabled),
      openLogFile: source => A.record(`打开 ${source} 日志文件`),
      openLogsFolder: () => A.record("打开日志目录"),
      openRuntime: () => A.record("打开运行目录"),
      openExternal: url => A.record(`打开 ${url}`),
      copyText: (text, what) => A.copy(String(text).split("\n").length, what || "内容"),
      pickFolder: async () => "D:\\Projects\\web-harness",
      pickSkillFile: async () => "D:\\Projects\\shared\\team-conventions\\SKILL.md",
      saveConfig: async patch => { const err = validate(Object.assign({}, sim.snapshot().account.config, patch)); if (err) throw new Error(err); return A.saveConfig(patch); },
      runSetup: async patch => { const err = validate(Object.assign({}, sim.snapshot().account.config, patch)); if (err) { bus.emit("notice", { message: err, level: "error" }); throw new Error(err); } return A.runSetup(Object.assign({}, patch, { markSetup: true })); }
    });
    return { mode: "preview", bus, actions, sim, async init() {}, snapshot: () => sim.snapshot() };
  }

  function makeBus() {
    const map = {};
    return {
      on(ev, fn) { (map[ev] = map[ev] || []).push(fn); return () => { map[ev] = map[ev].filter(f => f !== fn); }; },
      emit(ev, payload) { (map[ev] || []).forEach(fn => { try { fn(payload); } catch (err) { console.error(err); } }); }
    };
  }

  /* ---------- public entry ---------- */
  async function start(opts = {}) {
    const params = new URLSearchParams(location.search);
    const desktop = params.get("desktop") === "1";
    if (desktop && (!global.launcher || typeof global.launcher.on !== "function")) throw new Error("桌面连接未加载，无法读取真实运行状态。请关闭并重新打开应用；请勿在浏览器中使用桌面入口。");
    const backend = global.launcher && (desktop || !params.has("preview")) ? electronBackend() : previewBackend(params.get("scenario") || opts.scenario || "online");
    await backend.init();
    return {
      mode: backend.mode,
      on: backend.bus.on,
      snapshot: backend.snapshot,
      act: backend.actions,
      scenarios: Sim.SCENARIOS,
      settings: SETTINGS, guide: GUIDE, validate,
      fmt: { hms, relative, duration },
      filterLogs(entries, { query = "", level = "all", hideHealth = false } = {}) {
        const q = query.trim().toLowerCase();
        return entries.filter(e => (level === "all" || e.level === level) && (!hideHealth || !e.health) && (!q || (e.time + " " + e.text).toLowerCase().includes(q)));
      },
      urls(cfg) {
        return { health: `http://127.0.0.1:${cfg.mcpPort}/health`, admin: `http://127.0.0.1:${cfg.adminPort}/ui`, readyz: `http://127.0.0.1:${cfg.tunnelPort}/readyz`, tunnelUi: `http://127.0.0.1:${cfg.tunnelPort}/ui` };
      },
      // Chinese verb for a tool, used when narrating activity.
      describe(rec) {
        const VERB = { read_text_file: "读取", list_directory: "查看目录", directory_tree: "查看目录树", search_files: "搜索", project_context: "梳理项目概况", git_status: "查看 Git 状态", git_diff: "查看改动", git_log: "查看提交记录", run_command: "运行", apply_patch: "修改", code_intelligence: "检查代码", node_repl: "运行 Node 脚本", load_skill: "加载 Skill", list_skills: "列出 Skill", agent_status: "检查运行状态", computer_use: "操作桌面", goal: "查看 Goal" };
        return { verb: VERB[rec.tool] || rec.tool, target: rec.target || "" };
      }
    };
  }

  global.HarnessCore = { start, parseLine, activityFromLogs, timedCall, invocationFromLine };
})(window);
