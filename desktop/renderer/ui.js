/* Presentation-only design system. No service, account or filesystem authority. */
"use strict";
const HarnessUI = (() => {
  const byId = id => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const paths = {
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    layers: "m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5",
    terminal: "M3 5h18v14H3zM7 9l3 3-3 3M13 15h4",
    sliders: "M4 6h7m4 0h5M4 12h3m4 0h9M4 18h11m4 0h1M11 3v6M7 9v6M15 15v6",
    plus: "M12 5v14M5 12h14", folder: "M3 7V5h6l2 3h10v11H3V7Z",
    external: "M14 3h7v7M21 3l-11 11M10 5H3v16h16v-7",
    shield: "m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6",
    server: "M3 3h18v7H3zM3 14h18v7H3zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6",
    cloud: "M7 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11H7Z",
    activity: "M2 12h5l3-8 4 16 3-8h5", info: "M12 8h.01M12 11v6M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z",
    search: "M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm5.5 13 5 5",
    copy: "M8 8h13v13H8zM16 8V3H3v13h5", trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    expand: "M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5", collapse: "M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3",
    monitor: "M3 3h18v14H3zM12 17v4M8 21h8", globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM2 12h20M12 2c6 6 6 14 0 20-6-6-6-14 0-20Z",
    keyboard: "M2 5h20v14H2zM6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16h8",
    check: "m5 12 4 4L19 6", warning: "m12 3 10 18H2L12 3Zm0 5v6m0 3h.01", close: "m6 6 12 12M6 18 18 6"
  };
  function icon(name) {
    const svg = document.createElementNS(NS, "svg");
    for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(key, value);
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", paths[name] || paths.grid);
    svg.appendChild(p);
    return svg;
  }
  function paintIcons() { document.querySelectorAll("[data-icon]").forEach(el => { el.replaceChildren(icon(el.dataset.icon)); }); }
  let ctx, mounted = false, confirmResolve, returnFocus;
  let logQuery = "", logLevel = "all", hideHealth = false;
  const priorLabels = new Map();
  const viewScroll = new Map();
  let currentView = "dashboard", filterFrame = 0;
  function setLoading(value) { document.body.classList.toggle("is-loading", value); document.querySelectorAll(".sidebar,.page-header,main").forEach(el => { el.inert = value; }); }
  function text(id, value) { const el = byId(id); const next = value == null ? "—" : String(value); if (el && el.textContent !== next) el.textContent = next; }
  function tone(id, value) { const el = byId(id); if (el) el.dataset.tone = value; }
  function severity(line) {
    if (/^\d\d:\d\d:\d\d ! |\b(error|failed|failure|exception|fatal)\b|错误|失败|异常/i.test(line)) return "error";
    if (/\b(warn(?:ing)?|retry|backoff|backing off|stale)\b|警告|重试|过期/i.test(line)) return "warn";
    return "info";
  }
  function matchesLog(line) {
    const s = String(line);
    return (!logQuery || s.toLocaleLowerCase().includes(logQuery)) && (logLevel === "all" || severity(s) === logLevel) && (!hideHealth || !/\bGET\s+\/(health|readyz)\b/i.test(s));
  }
  function decorateLog(el, line) {
    el.className = "log-line " + severity(line);
    const match = String(line).match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/s);
    const timestamp = document.createElement("span"), message = document.createElement("span");
    timestamp.className = "log-time";
    timestamp.textContent = match ? match[1] : "·";
    const marker = document.createElement("span");
    marker.className = "log-severity";
    marker.textContent = severity(line) === "error" ? "ERR" : severity(line) === "warn" ? "WRN" : "INF";
    message.className = "log-message";
    message.textContent = (match ? match[2] : String(line)) + "\n";
    el.replaceChildren(timestamp, marker, message);
  }
  function updateLogMeta(state) {
    const total = (state.logs[state.activeLog] || []).length;
    const visible = byId("log-view").children.length;
    text("log-count", visible === total ? `${total.toLocaleString()} 行` : `${visible.toLocaleString()} / ${total.toLocaleString()} 行`);
    const empty = byId("log-empty");
    empty.hidden = visible > 0;
    text("log-empty-title", total ? "没有匹配的日志" : "暂无日志");
    text("log-empty-detail", total ? "请调整搜索或筛选条件。" : "");
    byId("btn-copy-log").disabled = visible === 0;
    byId("btn-clear-log").disabled = total === 0;
    byId("log-hint").title = byId("log-hint").textContent;
    document.querySelectorAll("[data-log]").forEach(el => {
      const active = el.dataset.log === state.activeLog;
      el.setAttribute("aria-selected", String(active));
      el.tabIndex = active ? 0 : -1;
    });
  }
  function updateAccounts(state) {
    renderActionErrors(state, state.status);
    const accounts = state.accounts?.accounts || [];
    const account = accounts.find(a => a.id === state.accountId);
    text("account-count", `${accounts.length} 个`);
    text("account-avatar", String(account?.name || "H").slice(0, 1).toUpperCase());
    text("current-account-name", account?.name || "选择工作账户");
    text("current-account-id", account ? (account.id === "default" ? "default" : String(account.id).slice(0, 8)) : "—");
    byId("account-select").title = account ? `${account.name} · ${account.id}` : "选择工作账户";
    byId("dashboard-account-detail").title = account?.config?.workspacePath || "未配置工作区";
    byId("dashboard-account-id").title = account?.id || "";
    document.body.classList.toggle("account-switching", Boolean(state.accountSwitching));
  }
  function onView(name) {
    const main = byId("main-content");
    if (currentView !== name) { viewScroll.set(currentView, main.scrollTop); main.scrollTop = viewScroll.get(name) || 0; }
    currentView = name;
    const slot = byId(name === "logs" ? "full-log-slot" : "dashboard-log-slot");
    const panel = byId("log-panel");
    if (panel.parentElement !== slot) slot.appendChild(panel);
    byId("btn-expand-log").setAttribute("aria-label", name === "logs" ? "收起日志控制台" : "展开日志控制台");
    byId("btn-expand-log").title = name === "logs" ? "返回工作台" : "展开日志控制台";
    byId("btn-expand-log").replaceChildren(icon(name === "logs" ? "collapse" : "expand"));
    document.querySelectorAll(".nav-item").forEach(el => {
      if (el.dataset.view === name) el.setAttribute("aria-current", "page"); else el.removeAttribute("aria-current");
    });
    document.body.dataset.view = name;
    text("page-context", ({ dashboard: "连接与运行环境", skills: "能力与本地扩展", logs: "运行事件与诊断", settings: "账户与连接偏好" })[name] || "");
  }
  function onSettingsTab(name) {
    document.querySelectorAll("[data-settings-tab]").forEach(el => {
      el.setAttribute("aria-selected", String(el.dataset.settingsTab === name));
      el.tabIndex = el.dataset.settingsTab === name ? 0 : -1;
    });
  }
  function filterSkills() {
    const query = byId("skill-search").value.trim().toLocaleLowerCase();
    let count = 0, total = 0;
    document.querySelectorAll("#installed-skills-list .skill-row").forEach(row => {
      const match = !query || (row.textContent + " " + [...row.querySelectorAll("input[type=text]")].map(x => x.value).join(" ")).toLocaleLowerCase().includes(query);
      row.hidden = !match;
      total++; if (match) count++;
    });
    text("skills-filter-count", query ? `${count} / ${total} 个匹配` : `${total} 个已安装`);
    let empty = byId("skill-search-empty");
    if (!empty) { empty = document.createElement("div"); empty.id = "skill-search-empty"; empty.className = "empty"; empty.textContent = "没有匹配的 Skill"; byId("installed-skills-list").after(empty); }
    empty.hidden = !query || count > 0;
  }
  function onCatalog(catalog) {
    for (const [id, data] of [["computer-use-state", catalog.computerUse], ["browser-use-state", catalog.browserUse]]) {
      const unavailable = data?.available === false || data?.runtimeReady === false;
      text(id, unavailable ? "运行时缺失" : data?.enabled ? "已启用" : "未启用");
      tone(id, unavailable ? "warn" : data?.enabled ? "ok" : "idle");
    }
    const total = [catalog.installed, catalog.external || catalog.registered, catalog.project, catalog.builtin].reduce((n, list) => n + (list?.length || 0), 0);
    text("skills-total", `${total} 个 Skill`);
    filterSkills();
  }
  function decorateSkill(row, skill) {
    const checkbox = row.querySelector("input[type=checkbox]");
    if (checkbox) checkbox.setAttribute("aria-label", `启用 ${skill.id || skill.name || "Skill"}`);
    const field = row.querySelector("input[type=text]");
    if (field) field.setAttribute("aria-label", "外部 Skill 标识");
    row.dataset.enabled = String(skill.enabled !== false);
  }
  function stage(id, label, value) { tone(`flow-${id}`, value); text(`flow-${id}-label`, label); }
  function updateStatus(s, state) {
    renderActionErrors(state, s);
    const m = s.mcp || {}, t = s.tunnel || {}, config = s.config || {};
    const cloudOnline = Boolean(t.ready && t.cloudState === "online" && !t.authError && !t.metaError);
    let title = "服务未启动", description = "", statusTone = "idle";
    if (!config.setupDone) { title = "账户未配置"; description = ""; statusTone = "warn"; }
    else if (m.state === "stopping" || t.state === "stopping") { title = "正在停止当前账户服务"; description = ""; statusTone = "busy"; }
    else if (m.state === "starting" || t.state === "starting") { title = "服务启动中"; description = ""; statusTone = "busy"; }
    else if (t.authError) { title = "云端认证失败"; description = "请核对 API Key 和 Tunnel ID。"; statusTone = "err"; }
    else if (m.state === "error" || t.state === "error") { title = "服务异常退出"; description = "请查看运行日志。"; statusTone = "err"; }
    else if (m.portOccupiedByUnknown || t.portOccupiedByUnknown) { title = "监听端口被占用"; description = "请检查端口设置；不会终止外部进程。"; statusTone = "warn"; }
    else if (t.metaError || t.cloudState === "error" || t.cloudState === "stale") { title = "云端连接待恢复"; description = "请检查代理、网络或隧道日志。"; statusTone = "warn"; }
    else if (m.healthy && cloudOnline) { title = "服务已就绪"; description = ""; statusTone = m.staleBuild ? "warn" : "ok"; }
    else if (m.healthy && t.ready) { title = "本地已就绪，等待云端确认"; description = ""; statusTone = "warn"; }
    else if (m.healthy) { title = "MCP 运行中"; description = "隧道未连接。"; statusTone = "idle"; }
    tone("overview-panel", statusTone); text("overview-title", title); text("overview-description", description); byId("overview-description").hidden = !description;
    // Project the same status decision into the connection canvas; local
    // readiness alone must never illuminate the cloud segment as connected.
    document.body.dataset.cloudState = cloudOnline ? "online" : t.authError ? "auth-error" : t.metaError || t.cloudState === "error" ? "error" : t.cloudState === "stale" ? "stale" : t.ready ? "waiting" : "offline";
    let connectionCaption = "启动当前账户，将工作空间连接到 ChatGPT。";
    if (!config.setupDone) connectionCaption = "完成账户连接配置，再启动本地服务。";
    else if (m.state === "stopping" || t.state === "stopping") connectionCaption = "正在停止当前账户的服务，请等待进程退出。";
    else if (m.state === "starting" || t.state === "starting") connectionCaption = "正在建立本地服务与隧道，连接状态将自动更新。";
    else if (t.authError) connectionCaption = "更新账户凭据后重新连接云端。";
    else if (m.state === "error" || t.state === "error") connectionCaption = "检查最近的错误记录，再重启异常服务。";
    else if (m.portOccupiedByUnknown || t.portOccupiedByUnknown) connectionCaption = "确认端口使用情况，或在设置中选择可用端口。";
    else if (t.metaError || t.cloudState === "error" || t.cloudState === "stale") connectionCaption = "连接恢复后，将通过成功的云端轮询重新确认状态。";
    else if (m.healthy && cloudOnline) connectionCaption = "本地工具与云端通道已就绪，可以开始工作。";
    else if (m.healthy && t.ready) connectionCaption = "本地链路已通，收到成功的云端轮询后确认连接。";
    else if (m.healthy) connectionCaption = "本地工具已可用，启动隧道以连接 ChatGPT。";
    text("connection-caption", connectionCaption);
    text("header-status", state.accountSwitching ? "账户切换中" : statusTone === "ok" ? "环境已就绪" : statusTone === "err" ? "需要处理" : "状态已同步");
    tone("header-status", statusTone);
    stage("mcp", m.state === "starting" ? "启动中" : m.state === "stopping" ? "停止中" : m.healthy ? "运行中" : m.state === "error" ? "异常退出" : "未运行", m.healthy ? "ok" : ["starting", "stopping"].includes(m.state) ? "busy" : m.state === "error" ? "err" : "idle");
    stage("local", t.state === "starting" ? "连接中" : t.state === "stopping" ? "停止中" : t.ready ? "本地就绪" : "未就绪", t.ready ? "ok" : ["starting", "stopping"].includes(t.state) ? "busy" : "idle");
    stage("cloud", t.authError ? "凭据被拒" : cloudOnline ? "已连接" : t.metaError || t.cloudState === "error" ? "连接异常" : t.cloudState === "stale" ? "状态过期" : t.ready ? "等待确认" : "未连接", t.authError ? "err" : cloudOnline ? "ok" : t.ready || t.metaError ? "warn" : "idle");
    for (const name of ["mcp", "tunnel"]) {
      const dot = byId(`badge-${name}`).querySelector(".dot");
      const value = [...dot.classList].find(c => c !== "dot") || "idle";
      tone(`badge-${name}`, value); tone(`card-${name}`, value); tone(`pill-${name}`, value);
    }
    text("mcp-tool-count", m.toolCount); text("mcp-listen-port", config.mcpPort);
    byId("footer").title = byId("footer").textContent;
    byId("mcp-build").title = m.build || "";
    document.querySelectorAll(".technical-grid dd").forEach(el => { el.title = el.textContent; });
    text("app-version", state.info?.version ? `v${state.info.version}` : "—");
    const timestamp = Number(new Date(s.at));
    byId("header-status").title = Number.isFinite(timestamp) ? `上次状态同步：${new Date(timestamp).toLocaleTimeString()}` : "状态时间未提供";
    setLoading(false);
  }
  function showDiagnostics() {
    const s = ctx.state.status, info = ctx.state.info;
    const list = byId("diagnostics-content");
    list.replaceChildren();
    const account = ctx.state.accounts?.accounts?.find(a => a.id === ctx.state.accountId);
    const rows = [["账户", account?.name], ["账户 ID", ctx.state.accountId], ["应用版本", info?.version], ["代码目录", s?.paths?.codeRoot], ["运行目录", s?.paths?.runtimeDir || info?.runtimeDir], ["MCP / Admin / Tunnel", s?.config ? `${s.config.mcpPort} / ${s.config.adminPort} / ${s.config.tunnelPort}` : null], ["状态时间", s?.at ? new Date(s.at).toLocaleString() : null]];
    for (const [label, value] of rows) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = label; dd.textContent = value || "尚未提供"; list.append(dt, dd); }
    byId("diagnostics-dialog").showModal();
  }
  function confirm(title, description, submitLabel = "确认") {
    if (confirmResolve) finishConfirm(false);
    returnFocus = document.activeElement;
    text("confirm-title", title); text("confirm-description", description); text("confirm-submit", submitLabel);
    byId("confirm-dialog").showModal();
    byId("confirm-cancel").focus();
    return new Promise(resolve => { confirmResolve = resolve; });
  }
  function finishConfirm(value) {
    byId("confirm-dialog").close();
    const resolve = confirmResolve; confirmResolve = null;
    if (resolve) resolve(value);
    if (returnFocus?.isConnected) returnFocus.focus();
  }
  function decorateToast(el, level) {
    const message = el.textContent;
    el.setAttribute("role", level === "error" ? "alert" : "status");
    const content = document.createElement("span"); content.textContent = message;
    const close = document.createElement("button"); close.type = "button"; close.className = "toast-close"; close.setAttribute("aria-label", "关闭通知"); close.append(icon("close")); close.addEventListener("click", () => el.remove());
    el.replaceChildren(icon(level === "success" ? "check" : level === "error" ? "warning" : "info"), content, close);
  }
  const actionButtons = {startAll:"btn-start-all",stopAll:"btn-stop-all",startMcp:"btn-mcp-start",stopMcp:"btn-mcp-stop",restartMcp:"btn-mcp-restart",startTunnel:"btn-tunnel-start",stopTunnel:"btn-tunnel-stop"};

  // Account/action records are presentation state; launcher history remains intact.
  const actionErrors = new Map();
  function actionTargets(name, error = "") {
    if (/All$/.test(name)) {
      if (/Tunnel|隧道/i.test(error)) return ["tunnel"];
      if (/MCP/i.test(error)) return ["mcp"];
      return ["mcp", "tunnel"]; // Explicitly combined action, never silently MCP-only.
    }
    return [/Tunnel/.test(name) ? "tunnel" : "mcp"];
  }
  function processGeneration(service) {
    return service?.instanceId || (service?.pid ? String(service.pid) + ":" + (service.lastExit?.at || "") : null);
  }
  function renderActionErrors(state, snapshot) {
    const account = state?.accountId;
    for (const service of ["mcp", "tunnel"]) {
      const messages = [];
      for (const [key, record] of actionErrors) {
        if (record.account !== account || !record.targets.includes(service)) continue;
        const current = snapshot?.[service];
        const at = Number(snapshot?.at) || Date.parse(snapshot?.at);
        const generation = processGeneration(current);
        // Only the exact local startup-timeout class can self-resolve. Auth,
        // configuration, stop and cloud errors require explicit action handling.
        const recovered = record.targets.length === 1 && record.localTimeout &&
          at > record.at && generation && generation !== record.generation &&
          (service === "mcp" ? current.healthy : current.ready) &&
          current.state === "running" && !current.authError;
        if (recovered) { actionErrors.delete(key); continue; }
        messages.push(record.message);
      }
      const target = byId(service + "-action-error");
      if (target) { target.textContent = messages.join("\n"); target.hidden = !messages.length; }
    }
  }

  function pending(name, on, error, scope) {
    const el = byId(actionButtons[name]);
    if (el) {
      if (on && !priorLabels.has(name)) priorLabels.set(name, el.textContent);
      if (on) { el.textContent = /stop/i.test(name) ? "正在停止…" : /restart/i.test(name) ? "正在重启…" : "正在启动…"; el.setAttribute("aria-busy", "true"); }
      else { if (priorLabels.has(name)) { el.textContent = priorLabels.get(name); priorLabels.delete(name); } el.removeAttribute("aria-busy"); }
    }
    const state = scope || ctx?.state;
    if (!state) return;
    if (on) actionErrors.delete(JSON.stringify([state.accountId, name]));
    if (error && state.accountId === ctx?.state?.accountId) {
      const targets = actionTargets(name, error);
      const service = targets.length === 1 ? targets[0] : null;
      const localTimeout = service === "tunnel" ? /^Tunnel 未在 60 秒内就绪/.test(error)
        : service === "mcp" && /^MCP 未在 45 秒内就绪/.test(error);
      actionErrors.set(JSON.stringify([state.accountId, name]), {
        account: state.accountId, targets, message: /All$/.test(name) ? "[全部服务操作] " + error : error,
        at: Date.now(), generation: processGeneration(state.status?.[service]), localTimeout,
      });
    }
    renderActionErrors(ctx?.state || state, (ctx?.state || state).status);
  }
  function ready(state, error) {
    setLoading(false);
    byId("preview-label").hidden = state.info?.isPreview !== true;
    text("app-version", state.info?.version ? `v${state.info.version}` : "—");
    byId("runtime-notice").hidden = !error;
    text("runtime-notice", error || "");
    if (error) { text("header-status", "运行时未连接"); tone("header-status", "err"); }
    if (ctx?.offline) document.querySelectorAll("button:not([data-view]):not([data-settings-tab]):not([data-close-dialog]), input, select").forEach(el => { el.disabled = true; });
  }
  function mount(context) {
    ctx = context;
    if (mounted) return;
    mounted = true;
    setLoading(!context.offline);
    paintIcons();
    const accountPopover = byId("account-popover");
    if (accountPopover) {
      const accountSummary = accountPopover.querySelector("summary");
      const closeAccountPopover = (restoreFocus = false) => {
        if (!accountPopover.open) return;
        accountPopover.open = false;
        if (restoreFocus) accountSummary?.focus();
      };
      byId("account-select").addEventListener("change", () => closeAccountPopover(true));
      document.addEventListener("click", event => {
        if (!accountPopover.contains(event.target)) {
          closeAccountPopover(accountPopover.contains(document.activeElement));
        }
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && accountPopover.open && !document.querySelector("dialog[open]")) {
          event.preventDefault();
          closeAccountPopover(true);
        }
      });
    }
    byId("btn-expand-log").addEventListener("click", () => ctx.showView(ctx.state.view === "logs" ? "dashboard" : "logs"));
    byId("btn-diagnostics").addEventListener("click", showDiagnostics);
    byId("btn-shortcuts").addEventListener("click", () => byId("shortcuts-dialog").showModal());
    document.querySelectorAll("[data-close-dialog]").forEach(el => el.addEventListener("click", () => byId(el.dataset.closeDialog).close()));
    byId("confirm-form").addEventListener("submit", e => { e.preventDefault(); finishConfirm(true); });
    byId("confirm-cancel").addEventListener("click", () => finishConfirm(false));
    byId("confirm-dialog").addEventListener("cancel", e => { e.preventDefault(); finishConfirm(false); });
    const filter = () => {
      logQuery = byId("log-search").value.trim().toLocaleLowerCase(); logLevel = byId("log-level").value; hideHealth = byId("log-hide-health").checked;
      cancelAnimationFrame(filterFrame);
      filterFrame = requestAnimationFrame(() => ctx.renderLog(ctx.state.activeLog, true));
    };
    byId("log-search").addEventListener("input", filter);
    byId("log-level").addEventListener("change", filter);
    byId("log-hide-health").addEventListener("change", filter);
    byId("log-autoscroll").addEventListener("change", () => { if (byId("log-autoscroll").checked) byId("log-view").scrollTop = byId("log-view").scrollHeight; });
    byId("skill-search").addEventListener("input", filterSkills);
    byId("btn-copy-log").addEventListener("click", async () => {
      try {
        const lines = (ctx.state.logs[ctx.state.activeLog] || []).filter(matchesLog);
        if (!lines.length) return;
        await ctx.call("copyText", { text: lines.join("\n") });
        ctx.toast(`已复制 ${lines.length} 行日志。`, "success", 2500);
      } catch (err) { ctx.toast(err.message, "error", 7000); }
    });
    document.addEventListener("keydown", e => {
      const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if (document.querySelector("dialog[open]")) return;
      if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f" && ["dashboard", "logs"].includes(ctx.state.view)) { e.preventDefault(); byId("log-search").focus(); byId("log-search").select(); }
      else if (!editing && e.altKey && /^[1-4]$/.test(e.key)) { e.preventDefault(); ctx.showView(["dashboard", "skills", "logs", "settings"][Number(e.key)-1]); }
      else if (!editing && e.key === "?") { e.preventDefault(); byId("shortcuts-dialog").showModal(); }
    });
    for (const group of document.querySelectorAll('[role="tablist"]')) group.addEventListener("keydown", e => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      const tabs = [...group.querySelectorAll('[role="tab"]')]; const i = tabs.indexOf(document.activeElement); if (i < 0) return;
      e.preventDefault(); const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length-1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); tabs[next].click();
    });
    if (context.offline) {
      document.querySelectorAll(".nav-item[data-view]").forEach(b => b.addEventListener("click", () => { if (b.dataset.view !== "skills") ctx.showView(b.dataset.view); }));
      document.querySelectorAll("[data-settings-tab]").forEach(b => b.addEventListener("click", () => ctx.showSettingsTab(b.dataset.settingsTab)));
    }
  }
  return { isLogFiltered: () => Boolean(logQuery || logLevel !== "all" || hideHealth), icon, mount, ready, confirm, updateAccounts, onView, onSettingsTab, onCatalog, decorateSkill, updateStatus, matchesLog, updateLogMeta, decorateLog, decorateToast, pending };
})();
