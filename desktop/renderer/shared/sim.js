/* Web Harness UI prototypes: simulated desktop runtime.
 * Status decisions mirror desktop/renderer/ui.js (updateStatus) and app.js (badge text)
 * of 0.2.9-rc.9. Nothing here touches the network, files, credentials or real services. */
(function (global) {
  "use strict";

  const SCENARIOS = [
    ["online", "已连接"], ["waiting", "等待云端确认"], ["starting", "启动中"], ["stopping", "停止中"],
    ["stopped", "未启动"], ["auth-error", "凭据失败"], ["network-error", "网络失败"], ["stale", "轮询过期"],
    ["crashed", "异常退出"], ["port-conflict", "端口冲突"], ["unconfigured", "未配置"], ["long-path", "长路径"]
  ];

  const INFO = { name: "ChatGPT Web Harness Isolated", version: "0.2.9-rc.9", build: "6eee3e9b81e34a4a", node: "v24.18.0" };
  const CLOUD_DELAY = 5200; // real first poll is about 30 s; shortened for the prototype

  const rint = (a, b) => Math.round(a + Math.random() * (b - a));
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const pad = n => String(n).padStart(2, "0");
  const hms = ts => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const hmsUTC = ts => { const d = new Date(ts); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`; };

  function relative(ts, now = Date.now()) {
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 5) return "刚刚";
    if (s < 60) return `${s} 秒前`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} 分钟前`;
    return `${Math.round(m / 60)} 小时前`;
  }
  function duration(ms) {
    if (ms == null) return "—";
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return `${m}:${pad(s)}`;
  }

  // Tool calls the real runtime exposes (names from src/tools). Weighted by how often a coding session uses them.
  const CALLS = [
    { tool: "read_text_file", w: 10, targets: ["src/lib/runtime-scope.ts", "desktop/renderer/app.js", "src/tools/node-repl.ts", "docs/RELEASE.md", "package.json", "src/lib/provider-health.ts"], ms: [6, 70],
      done: () => { const n = rint(40, 640); return { summary: `${n} 行`, log: `${n} lines returned` }; } },
    { tool: "search_files", w: 6, targets: ["\"cloudState\"", "\"toolProfile\"", "\"lastPollSuccessAt\"", "\"skill-discovery\""], ms: [20, 180],
      done: () => { const n = rint(2, 31); return { summary: `${n} 处匹配`, log: `${n} matches in ${rint(2, 9)} files` }; } },
    { tool: "list_directory", w: 4, targets: ["src/tools", "desktop/renderer", "docs", "scripts"], ms: [4, 30],
      done: () => { const n = rint(6, 42); return { summary: `${n} 项`, log: `${n} entries` }; } },
    { tool: "project_context", w: 3, targets: ["source inventory", "workspace summary"], ms: [30, 260],
      done: () => ({ summary: "8 个文件 · 3.2 KB", log: "8 matching files · 3.2 KB returned" }) },
    { tool: "git_status", w: 3, targets: ["source/rc9-20261024"], ms: [30, 120],
      done: () => ({ summary: "工作树干净", log: "working tree clean" }) },
    { tool: "git_diff", w: 2, targets: ["desktop/renderer/styles.css", "src/lib/provider-health.ts"], ms: [20, 90],
      done: () => { const a = rint(4, 60), d = rint(0, 30); return { summary: `+${a} −${d}`, log: `+${a} -${d} lines` }; } },
    { tool: "run_command", w: 3, targets: ["npm run build", "node --test scripts/test-provider-health.mjs", "npm --prefix desktop run test:renderer"], ms: [2600, 9000], fail: 0.22,
      done: ok => ok ? { summary: "退出码 0", log: "exit 0" } : { summary: "退出码 1", log: "exit 1 · 1 failing assertion", level: "error" } },
    { tool: "apply_patch", w: 2, targets: ["src/lib/provider-health.ts", "desktop/renderer/ui.js"], ms: [10, 45],
      done: () => ({ summary: "1 个文件已修改", log: "1 file changed" }) },
    { tool: "code_intelligence", w: 2, targets: ["diagnostics src/lib"], ms: [220, 900],
      done: () => ({ summary: "0 个错误", log: "0 errors · 2 warnings" }) },
    { tool: "node_repl", w: 1, targets: ["status"], ms: [40, 320],
      done: () => ({ summary: "返回 1.2 KB", log: "1.2 KB returned" }) },
    { tool: "load_skill", w: 1, targets: ["archify", "visual-qa", "project-engineering"], ms: [5, 25],
      done: () => ({ summary: "已读取 SKILL.md", log: "SKILL.md loaded" }) },
    { tool: "list_skills", w: 1, targets: ["enabled"], ms: [5, 20],
      done: () => ({ summary: "6 个已启用", log: "6 enabled skills" }) },
    { tool: "agent_status", w: 1, targets: ["runtime"], ms: [3, 12],
      done: () => ({ summary: "构建最新", log: "77 tools · stale_build=false" }) },
    { tool: "computer_use", w: 1, targets: ["screenshot"], ms: [700, 1700], needs: "computerUse",
      done: () => ({ summary: "1 张截图", log: "1 screenshot returned" }) },
    { tool: "goal", w: 1, targets: ["status"], ms: [5, 30],
      done: () => ({ summary: "无进行中的 Goal", log: "no active goal" }) }
  ];

  function initialCatalog() {
    const base = "%APPDATA%\\chatgpt-web-harness-isolated\\runtime\\profiles\\local-skills\\";
    return {
      computerUse: { enabled: true, available: true },
      browserUse: { enabled: true, available: true, runtimeReady: true },
      configPath: "runtime\\profiles\\plugins.json",
      installed: [
        { id: "archify", version: "2.17", enabled: true, path: base + "archify\\SKILL.md", description: "按需生成架构图、流程图、时序图、数据流与状态图，输出可交互 HTML 和导出文件。" },
        { id: "huashu-art-motion", version: "—", enabled: true, path: base + "huashu-art-motion\\SKILL.md", description: "艺术与视频动画：拆解并复刻动画，含实做风格、解说动画语法和框景检查。" },
        { id: "ielts-notion-workbench", version: "—", enabled: true, path: base + "ielts-notion-workbench\\SKILL.md", description: "维护雅思 300 天 Notion 学习工作台，按水平生成机考练习、批改并同步进度。" },
        { id: "new-words", version: "—", enabled: true, path: base + "new-words\\SKILL.md", description: "从图片或单词维护 Notion 英语生词本：用法研究、发音辅助和复习进度。" }
      ],
      external: [
        { id: "release-checklist", enabled: false, path: "D:\\Projects\\shared\\release-checklist\\SKILL.md", description: "把构建、版本和发布检查整理为可重复执行的流程。" }
      ],
      project: [
        { id: "project-context", description: "当前工作区的项目约定，来自工作区 .harness 目录，只读。" }
      ],
      builtin: [
        { id: "codex-execution", description: "以显式状态、检查点、可见进度和有界验证执行长时间本地工程任务。" },
        { id: "project-engineering", description: "按仓库约定修改真实代码库：先读说明和依赖，小步修改，运行项目自己的测试。" },
        { id: "visual-qa", description: "把网页、SVG、图表等渲染结果的真实图像交回模型，按实际所见迭代。" }
      ]
    };
  }

  function makeAccount(id, name, config) {
    return {
      id, name,
      config: Object.assign({
        setupDone: true, hasApiKey: true, workspacePath: "", mcpPort: 3300, adminPort: 3301, tunnelPort: 8380,
        tunnelId: "", toolProfile: "full", tunnelProxyMode: "auto", tunnelProxyUrl: "",
        relayEnabled: false, relayAuto: false, relayRecovery: false, relayAutomationEnabled: false, relayAutoRecoveryEnabled: false, autoStart: false, tray: true, minimizeToTray: true, skipDoctor: false, idleReminderMinutes: 5
      }, config),
      mcp: { managed: false, healthy: false, state: "stopped", pid: null, build: null, toolCount: null, toolProfile: config.toolProfile || "full", staleBuild: null, auth: "none", portOccupiedByUnknown: false },
      tunnel: { managed: false, ready: false, reachable: false, state: "stopped", pid: null, cloudState: "unknown", lastPollSuccessAt: null, authError: null, metaError: null, proxyRoute: { mode: "proxy", url: "http://127.0.0.1:7890", source: "system" }, portOccupiedByUnknown: false },
      logs: { mcp: [], tunnel: [], launcher: [] },
      activity: [],
      catalog: initialCatalog(),
      credentialFixed: false
    };
  }

  function levelOf(text) {
    if (/\b(error|failed|fatal|exit 1|401|EOF|refused)\b/i.test(text) || /\[error\]/i.test(text)) return "error";
    if (/\[warn(ing)?\]|stale|backing off|occupied/i.test(text)) return "warn";
    return "info";
  }
  const isHealth = text => /\/health|\/readyz|\[poll\] ok/i.test(text);

// Status derivation in the production decision order (desktop/renderer/ui.js updateStatus + app.js badges).
function deriveStatus(account) {
    const m = account.mcp, t = account.tunnel, config = account.config;
    const cloudOnline = Boolean(t.ready && t.cloudState === "online" && !t.authError && !t.metaError);
    let title = "服务未启动", description = "", tone = "idle";
    if (!config.setupDone) { title = "账户未配置"; tone = "warn"; }
    else if (m.state === "stopping" || t.state === "stopping") { title = "正在停止当前账户服务"; tone = "busy"; }
    else if (m.state === "starting" || t.state === "starting") { title = "服务启动中"; tone = "busy"; }
    else if (t.authError) { title = "云端认证失败"; description = "请核对 API Key 和 Tunnel ID。"; tone = "err"; }
    else if (m.state === "error" || t.state === "error") { title = "服务异常退出"; description = "请查看运行日志。"; tone = "err"; }
    else if (m.portOccupiedByUnknown || t.portOccupiedByUnknown) { title = "监听端口被占用"; description = "请检查端口设置；不会终止外部进程。"; tone = "warn"; }
    else if (t.metaError || t.cloudState === "error" || t.cloudState === "stale") { title = "云端连接待恢复"; description = "请检查代理、网络或隧道日志。"; tone = "warn"; }
    else if (m.healthy && cloudOnline) { title = "服务已就绪"; tone = m.staleBuild ? "warn" : "ok"; }
    else if (m.healthy && t.ready) { title = "本地已就绪，等待云端确认"; tone = "warn"; }
    else if (m.healthy) { title = "MCP 运行中"; description = "隧道未连接。"; tone = "idle"; }

    let caption = "启动当前账户，将工作空间连接到 ChatGPT。";
    if (!config.setupDone) caption = "完成账户连接配置，再启动本地服务。";
    else if (m.state === "stopping" || t.state === "stopping") caption = "正在停止当前账户的服务，请等待进程退出。";
    else if (m.state === "starting" || t.state === "starting") caption = "正在建立本地服务与隧道，连接状态将自动更新。";
    else if (t.authError) caption = "更新账户凭据后重新连接云端。";
    else if (m.state === "error" || t.state === "error") caption = "检查最近的错误记录，再重启异常服务。";
    else if (m.portOccupiedByUnknown || t.portOccupiedByUnknown) caption = "确认端口使用情况，或在设置中选择可用端口。";
    else if (t.metaError || t.cloudState === "error" || t.cloudState === "stale") caption = "连接恢复后，将通过成功的云端轮询重新确认状态。";
    else if (m.healthy && cloudOnline) caption = "本地工具与云端通道已就绪，可以开始工作。";
    else if (m.healthy && t.ready) caption = "本地链路已通，收到成功的云端轮询后确认连接。";
    else if (m.healthy) caption = "本地工具已可用，启动隧道以连接 ChatGPT。";

    const cloudState = cloudOnline ? "online" : t.authError ? "auth-error" : (t.metaError || t.cloudState === "error") ? "error" : t.cloudState === "stale" ? "stale" : t.ready ? "waiting" : "offline";

    const stages = {
      mcp: { label: m.state === "starting" ? "启动中" : m.state === "stopping" ? "停止中" : m.healthy ? "运行中" : m.state === "error" ? "异常退出" : m.portOccupiedByUnknown ? "端口被占用" : "未运行",
             tone: m.healthy ? "ok" : ["starting", "stopping"].includes(m.state) ? "busy" : m.state === "error" ? "err" : m.portOccupiedByUnknown ? "warn" : "idle" },
      local: { label: t.state === "starting" ? "连接中" : t.state === "stopping" ? "停止中" : t.ready ? "本地就绪" : "未就绪",
               tone: t.ready ? "ok" : ["starting", "stopping"].includes(t.state) ? "busy" : t.state === "error" ? "err" : "idle" },
      cloud: { label: t.authError ? "凭据被拒" : cloudOnline ? "已连接" : (t.metaError || t.cloudState === "error") ? "连接异常" : t.cloudState === "stale" ? "状态过期" : t.ready ? "等待确认" : "未连接",
               tone: t.authError ? "err" : cloudOnline ? "ok" : (t.ready || t.metaError) ? "warn" : "idle" }
    };

    let mcpTone = "idle", mcpText = "未运行";
    if (m.managed && m.state === "starting") { mcpTone = "busy"; mcpText = "启动中"; }
    else if (m.managed && m.state === "stopping") { mcpTone = "busy"; mcpText = "停止中"; }
    else if (m.healthy && m.staleBuild) { mcpTone = "warn"; mcpText = "运行中（旧构建）"; }
    else if (m.healthy) { mcpTone = "ok"; mcpText = "运行中"; }
    else if (m.portOccupiedByUnknown) { mcpTone = "warn"; mcpText = "端口被占用"; }
    else if (m.state === "error") { mcpTone = "err"; mcpText = "异常退出"; }

    let tTone = "idle", tText = "未运行";
    if (t.managed && t.state === "starting") { tTone = "busy"; tText = "连接中"; }
    else if (t.managed && t.state === "stopping") { tTone = "busy"; tText = "停止中"; }
    else if (t.authError) { tTone = "err"; tText = "凭据被拒 (401)"; }
    else if (t.metaError || t.cloudState === "error") { tTone = "warn"; tText = "云端连接异常"; }
    else if (t.ready && t.cloudState === "online") { tTone = "ok"; tText = "云端已连接"; }
    else if (t.ready && t.cloudState === "stale") { tTone = "warn"; tText = "轮询状态过期"; }
    else if (t.ready) { tTone = "warn"; tText = "本地就绪，云端待确认"; }
    else if (t.reachable) { tTone = "warn"; tText = "未就绪"; }
    else if (t.portOccupiedByUnknown) { tTone = "warn"; tText = "端口被占用"; }
    else if (t.state === "error") { tTone = "err"; tText = "异常退出"; }

    const cloudError = t.authError || t.metaError;
    const cloudText = cloudError ? (t.authError ? "认证失败，请检查 Runtime Key / Tunnel ID" : "连接中断，正在退避重试；请检查代理或网络")
      : t.cloudState === "online" ? `最近成功 ${hms(t.lastPollSuccessAt)}`
      : t.cloudState === "stale" ? "长时间未收到成功轮询，请检查代理或网络"
      : t.ready ? "等待首轮成功（通常约 30 秒）" : "尚未连接";

    const route = t.proxyRoute;
    const problem = !config.setupDone ? "unconfigured" : t.authError ? "auth" : (m.state === "error" || t.state === "error") ? "crash"
      : (m.portOccupiedByUnknown || t.portOccupiedByUnknown) ? "port" : (t.metaError || t.cloudState === "error") ? "network" : t.cloudState === "stale" ? "stale" : null;

    return {
      title, description, tone, caption, cloudState, cloudOnline, stages, problem,
      busy: ["starting", "stopping"].includes(m.state) || ["starting", "stopping"].includes(t.state),
      headerStatus: { text: tone === "ok" ? "环境已就绪" : tone === "err" ? "需要处理" : "状态已同步", tone },
      mcpBadge: { tone: mcpTone, text: mcpText }, tunnelBadge: { tone: tTone, text: tText },
      mcp: {
        tools: m.toolCount != null ? `${m.toolCount}（${m.toolProfile}）` : "—", toolCount: m.toolCount,
        source: m.managed ? "本启动器" : m.healthy ? "外部进程（旧脚本/手动启动）" : "—",
        build: m.build || "—", stale: m.staleBuild == null ? "—" : m.staleBuild ? "需重启更新" : "当前构建",
        auth: m.healthy ? m.auth : "—", pid: m.pid || "—", port: config.mcpPort
      },
      tunnel: {
        pid: t.pid || "—", port: config.tunnelPort, source: t.managed ? "本启动器" : t.ready ? "外部进程（旧脚本/手动启动）" : "—",
        route: route ? (route.mode === "proxy" ? `代理 ${route.url}` : "直连") : "—",
        tunnelId: config.tunnelId || "（未配置）", workspace: config.workspacePath || "—",
        readyText: t.ready ? "已就绪（仅本地）" : t.reachable ? "尚未就绪" : "不可达", cloudText,
        errorLine: cloudError ? cloudError.line : "", lastPoll: t.lastPollSuccessAt
      }
    };
  }


  function create(options = {}) {
    const listeners = {};
    const pending = new Set();
    let seq = 0, fixtureAccountSequence = 0, timer = null, ambient = null, callTimers = [];

    const accounts = [
      makeAccount("default", "默认账号（原配置）", { workspacePath: "D:\\Projects\\web-harness", mcpPort: 3300, adminPort: 3301, tunnelPort: 8380, tunnelId: "tunnel_00000000000000000000000000000000", toolProfile: "full" }),
      makeAccount("business", "Business", { workspacePath: "D:\\Work\\business-ops", mcpPort: 3310, adminPort: 3311, tunnelPort: 8390, tunnelId: "tunnel_11111111111111111111111111111111", toolProfile: "slim" }),
      makeAccount("lab", "实验室", { setupDone: false, hasApiKey: false, workspacePath: "", mcpPort: 3320, adminPort: 3321, tunnelPort: 8400, tunnelId: "", toolProfile: "slim" })
    ];
    let selectedId = "default";
    let scenario = options.scenario || "online";

    const emit = (name, payload) => (listeners[name] || []).forEach(fn => { try { fn(payload); } catch (err) { console.error(err); } });
    const on = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); return () => { listeners[name] = listeners[name].filter(f => f !== fn); }; };
    const current = () => accounts.find(a => a.id === selectedId);
    const changed = () => emit("change", snapshot());
    const notice = (message, level = "info") => emit("notice", { message, level });
    const wait = ms => new Promise(r => setTimeout(r, ms));

    function log(source, text, account = current(), ts = Date.now()) {
      const entry = { seq: ++seq, ts, time: hms(ts), source, text, level: levelOf(text), health: isHealth(text) };
      const list = account.logs[source];
      list.push(entry);
      if (list.length > 3000) list.splice(0, list.length - 3000);
      if (account === current()) emit("log", entry);
      return entry;
    }

    // --- status derivation (production decision order) ---------------------------------------
    function derive(account = current()) { return deriveStatus(account); }

    // --- scenarios ----------------------------------------------------------------------------
    function resetServices(a) {
      Object.assign(a.mcp, { managed: false, healthy: false, state: "stopped", pid: null, build: null, toolCount: null, staleBuild: null, portOccupiedByUnknown: false });
      Object.assign(a.tunnel, { managed: false, ready: false, reachable: false, state: "stopped", pid: null, cloudState: "unknown", lastPollSuccessAt: null, authError: null, metaError: null, portOccupiedByUnknown: false });
    }
    function mcpUp(a) {
      Object.assign(a.mcp, { managed: true, healthy: true, state: "running", pid: a.mcp.pid || rint(30000, 46000), build: INFO.build, toolCount: a.config.toolProfile === "slim" ? 30 : 77, toolProfile: a.config.toolProfile, staleBuild: false, portOccupiedByUnknown: false });
    }
    function tunnelUp(a, cloud) {
      Object.assign(a.tunnel, { managed: true, ready: true, reachable: true, state: "running", pid: a.tunnel.pid || rint(30000, 46000), cloudState: cloud || "unknown", authError: null, metaError: null });
      if (cloud === "online") a.tunnel.lastPollSuccessAt = Date.now() - rint(1000, 6000);
    }

    function applyScenario(name, a = current()) {
      scenario = name;
      clearTimers();
      resetServices(a);
      if (a.id === "default") { a.config.workspacePath = "D:\\Projects\\web-harness"; a.config.tunnelId = "tunnel_00000000000000000000000000000000"; a.config.setupDone = true; a.config.hasApiKey = true; }
      switch (name) {
        case "online": case "long-path": mcpUp(a); tunnelUp(a, "online"); break;
        case "waiting": mcpUp(a); tunnelUp(a); break;
        case "starting": Object.assign(a.mcp, { managed: true, state: "starting" }); Object.assign(a.tunnel, { managed: true, state: "starting" }); break;
        case "stopping": mcpUp(a); tunnelUp(a, "online"); a.mcp.state = "stopping"; a.tunnel.state = "stopping"; break;
        case "stopped": break;
        case "auth-error": mcpUp(a); tunnelUp(a, "error"); a.tunnel.authError = { line: "HTTP 401 · Runtime API Key rejected for this tunnel" }; break;
        case "network-error": mcpUp(a); tunnelUp(a, "error"); a.tunnel.metaError = { line: "poll failed; backing off: unexpected EOF" }; break;
        case "stale": mcpUp(a); tunnelUp(a, "stale"); a.tunnel.lastPollSuccessAt = Date.now() - 184000; break;
        case "crashed": Object.assign(a.mcp, { state: "error" }); Object.assign(a.tunnel, { state: "error" }); break;
        case "port-conflict": a.mcp.portOccupiedByUnknown = true; break;
        case "unconfigured": Object.assign(a.config, { setupDone: false, hasApiKey: false, tunnelId: "", workspacePath: "" }); break;
      }
      if (name === "long-path") {
        a.config.workspacePath = "D:\\工程与研究\\" + "very-long-workspace-segment\\".repeat(6) + "web-harness";
        a.config.tunnelId = "tunnel_" + "long-identifier-".repeat(5) + "0f";
      }
      seedHistory(a, name);
      if (a.tunnel.cloudState === "online") startTraffic();
      if (name === "waiting") timer = setTimeout(() => cloudOnline(a), CLOUD_DELAY + 3000);
      changed();
    }

    function seedHistory(a, name) {
      a.logs = { mcp: [], tunnel: [], launcher: [] };
      a.activity = [];
      const now = Date.now(), t0 = now - 9 * 60000;
      log("launcher", "[launcher] Isolated profile loaded · account " + a.id, a, t0 - 4000);
      if (["stopped", "unconfigured", "port-conflict"].includes(name)) {
        if (name === "port-conflict") log("launcher", `[warning] 127.0.0.1:${a.config.mcpPort} is occupied by an unknown process`, a, now - 3000);
        if (name === "unconfigured") log("launcher", "[launcher] Account is not configured · Tunnel ID and API key missing", a, now - 2000);
        return;
      }
      if (name === "crashed") {
        log("mcp", "[runtime] MCP server initialized · profile=" + a.config.toolProfile, a, t0);
        log("mcp", "[error] Runtime exited unexpectedly · code 3221225477", a, now - 42000);
        log("tunnel", "[error] Upstream closed · tunnel-client exited", a, now - 41000);
        return;
      }
      if (name === "starting") { log("launcher", `[launcher] Starting MCP runtime on 127.0.0.1:${a.config.mcpPort}`, a, now - 500); return; }
      const tools = a.config.toolProfile === "slim" ? 30 : 77;
      log("mcp", "[runtime] MCP server initialized · profile=" + a.config.toolProfile, a, t0);
      log("mcp", `[tools] Registered ${tools} tools from local providers`, a, t0 + 300);
      log("mcp", `[HTTP] Listening on 127.0.0.1:${a.config.mcpPort}`, a, t0 + 900);
      log("tunnel", "[tunnel] Local upstream configured", a, t0 + 1200);
      log("tunnel", "[readyz] Local MCP connection ready", a, t0 + 1600);
      log("tunnel", "[route] Outbound requests use system proxy http://127.0.0.1:7890", a, t0 + 1700);
      if (name === "waiting") { log("tunnel", "[poll] Waiting for cloud acknowledgement", a, now - 2000); return; }
      log("tunnel", "[poll] Cloud acknowledged · tunnel online", a, t0 + 31000);
      log("mcp", "[session] New workspace session established", a, t0 + 33000);
      // a few minutes of past tool calls
      let ts = t0 + 40000;
      const history = [
        ["project_context", "source inventory", 212, true, "8 个文件 · 3.2 KB", "8 matching files · 3.2 KB returned"],
        ["read_text_file", "src/lib/runtime-scope.ts", 18, true, "142 行", "142 lines returned"],
        ["search_files", "\"cloudState\"", 64, true, "11 处匹配", "11 matches in 4 files"],
        ["read_text_file", "desktop/renderer/app.js", 22, true, "512 行", "512 lines returned"],
        ["git_status", "source/rc9-20261024", 48, true, "工作树干净", "working tree clean"],
        ["run_command", "npm run build", 7420, true, "退出码 0", "exit 0"],
        ["apply_patch", "src/lib/provider-health.ts", 16, true, "1 个文件已修改", "1 file changed"],
        ["run_command", "node --test scripts/test-provider-health.mjs", 3180, false, "退出码 1", "exit 1 · expected disabled, got missing"],
        ["read_text_file", "src/lib/provider-health.ts", 12, true, "96 行", "96 lines returned"],
        ["code_intelligence", "diagnostics src/lib", 640, true, "0 个错误", "0 errors · 2 warnings"]
      ];
      for (const [tool, target, ms, ok, summary, text] of history) {
        ts += rint(28000, 52000);
        if (ts > now - 8000) break;
        const rec = { id: "c" + (++seq), tool, target, startedAt: ts, endedAt: ts + ms, ms, ok, summary, phase: ok ? "done" : "failed" };
        a.activity.push(rec);
        log("mcp", `[tool] ${tool} · ${target}`, a, ts);
        log("mcp", `[result] ${ok ? "Completed" : "Failed"} in ${ms}ms · ${text}`, a, ts + ms);
      }
      log("mcp", "[HTTP] GET /health 200 2ms", a, now - 14000);
      if (name === "auth-error") log("tunnel", "[error] HTTP 401 · Runtime API Key rejected for this tunnel", a, now - 6000);
      if (name === "network-error") log("tunnel", "[warning] poll failed; backing off: unexpected EOF", a, now - 5000);
      if (name === "stale") log("tunnel", "[warning] No successful poll for 3 minutes · stale", a, now - 4000);
      log("mcp", "[runtime] Waiting for the next tool invocation", a, now - 1200);
    }

    // --- live traffic -------------------------------------------------------------------------
    function clearTimers() {
      clearTimeout(timer); timer = null;
      clearTimeout(ambient); ambient = null;
      callTimers.forEach(clearTimeout); callTimers = [];
    }
    let manualTraffic = false;
    function startTraffic() {
      clearTimeout(ambient);
      if (manualTraffic) return;
      const a = current();
      const tick = () => {
        if (!(a === current() && a.tunnel.cloudState === "online" && a.mcp.healthy)) return;
        if (Math.random() < 0.16) log("mcp", `[HTTP] GET /health 200 ${rint(1, 4)}ms`, a);
        else if (Math.random() < 0.06) log("mcp", "[warning] Workspace index is refreshing; cached results remain available", a);
        else if (Math.random() < 0.12) log("tunnel", `[poll] ok · ${rint(1, 3)} request relayed`, a);
        else call(a);
        ambient = setTimeout(tick, rint(2400, 6200));
      };
      ambient = setTimeout(tick, rint(1200, 2600));
    }
    function call(a, forced, options = {}) {
      if (callTimers.length >= 64) return null;
      const pool = CALLS.filter(c => !c.needs || a.catalog[c.needs]?.enabled);
      let spec = forced ? pool.find(c => c.tool === forced) : null;
      if (!spec) { const total = pool.reduce((s, c) => s + c.w, 0); let r = Math.random() * total; spec = pool.find(c => (r -= c.w) < 0) || pool[0]; }
      const target = pick(spec.targets), ms = Number.isFinite(options.durationMs)
        ? Math.max(450, Math.min(12000, options.durationMs)) : rint(spec.ms[0], spec.ms[1]);
      const rec = { id: "c" + (++seq), tool: spec.tool, target, startedAt: Date.now(), endedAt: null, ms: null, ok: null, summary: "", phase: "running" };
      a.activity.push(rec);
      if (a.activity.length > 400) a.activity.splice(0, a.activity.length - 400);
      log("mcp", `[tool] ${spec.tool} · ${target}`, a);
      emit("activity", { kind: "start", record: rec });
      const handle = setTimeout(() => {
        const at = callTimers.indexOf(handle); if (at >= 0) callTimers.splice(at, 1);
        finish(a, rec, spec, ms, options.ok);
      }, ms);
      callTimers.push(handle);
      return rec;
    }
    function finish(a, rec, spec, ms, forcedOk) {
      if (rec.phase !== "running") return;
      const ok = typeof forcedOk === "boolean" ? forcedOk : !(spec.fail && Math.random() < spec.fail);
      const out = spec.done(ok);
      Object.assign(rec, { endedAt: Date.now(), ms, ok, summary: out.summary, phase: ok ? "done" : "failed" });
      log("mcp", `[result] ${ok ? "Completed" : "Failed"} in ${ms}ms · ${out.log}`, a);
      emit("activity", { kind: "end", record: rec });
    }
    function interruptCalls(a) {
      for (const rec of a.activity) if (rec.phase === "running") {
        Object.assign(rec, { endedAt: Date.now(), ms: Date.now() - rec.startedAt, ok: false, summary: "服务停止，调用中断", phase: "failed" });
        emit("activity", { kind: "end", record: rec });
      }
      callTimers.forEach(clearTimeout); callTimers = [];
    }
    function cloudOnline(a) {
      if (!a.tunnel.ready || a.tunnel.authError || a.tunnel.metaError) return;
      a.tunnel.cloudState = "online"; a.tunnel.lastPollSuccessAt = Date.now();
      log("tunnel", "[poll] Cloud acknowledged · tunnel online", a);
      changed();
      if (a === current()) { startTraffic(); timer = setTimeout(() => call(a, "project_context"), 1400); }
    }

    // --- actions ------------------------------------------------------------------------------
    async function guarded(name, fn) {
      if (pending.has(name)) return;
      pending.add(name); changed();
      try { return await fn(); }
      catch (err) { notice(err.message, "error"); throw err; }
      finally { pending.delete(name); changed(); }
    }
    async function bootMcp(a) {
      if (a.mcp.portOccupiedByUnknown || scenario === "port-conflict" && a === current() && !a.mcp.healthy) {
        a.mcp.portOccupiedByUnknown = true;
        log("launcher", `[error] 127.0.0.1:${a.config.mcpPort} is occupied by an unknown process`, a);
        changed();
        throw new Error(`MCP 端口 ${a.config.mcpPort} 已被其他进程占用。请在连接设置中更换端口。`);
      }
      Object.assign(a.mcp, { managed: true, healthy: false, state: "starting", pid: null });
      log("launcher", `[launcher] Starting MCP runtime on 127.0.0.1:${a.config.mcpPort}`, a); changed();
      await wait(1100);
      mcpUp(a); a.mcp.pid = rint(30000, 46000);
      log("mcp", "[runtime] MCP server initialized · profile=" + a.config.toolProfile, a);
      log("mcp", `[tools] Registered ${a.mcp.toolCount} tools from local providers`, a);
      log("mcp", `[HTTP] Listening on 127.0.0.1:${a.config.mcpPort}`, a);
      if (a.tunnel.state === "running" && !a.tunnel.ready) { a.tunnel.ready = true; log("tunnel", "[readyz] Local MCP connection ready", a); }
      changed();
    }
    async function bootTunnel(a) {
      Object.assign(a.tunnel, { managed: true, ready: false, reachable: false, state: "starting", pid: null, cloudState: "unknown", authError: null, metaError: null });
      log("launcher", "[launcher] Starting tunnel-client", a); changed();
      await wait(800);
      Object.assign(a.tunnel, { state: "running", reachable: true, pid: rint(30000, 46000), ready: a.mcp.healthy });
      log("tunnel", "[tunnel] Local upstream configured", a);
      if (a.mcp.healthy) log("tunnel", "[readyz] Local MCP connection ready", a);
      if (scenario === "auth-error" && !a.credentialFixed && a.id === "default") {
        a.tunnel.cloudState = "error"; a.tunnel.authError = { line: "HTTP 401 · Runtime API Key rejected for this tunnel" };
        log("tunnel", "[error] HTTP 401 · Runtime API Key rejected for this tunnel", a); changed(); return;
      }
      log("tunnel", "[poll] Waiting for cloud acknowledgement", a); changed();
      clearTimeout(timer);
      timer = setTimeout(() => cloudOnline(a), CLOUD_DELAY);
    }
    async function haltMcp(a) {
      a.mcp.state = "stopping"; changed();
      interruptCalls(a);
      await wait(650);
      Object.assign(a.mcp, { managed: false, healthy: false, state: "stopped", pid: null, toolCount: null, build: null, staleBuild: null });
      if (a.tunnel.state === "running") { a.tunnel.ready = false; }
      log("launcher", "[launcher] MCP runtime stopped", a); changed();
    }
    async function haltTunnel(a) {
      a.tunnel.state = "stopping"; changed();
      clearTimeout(timer); clearTimeout(ambient);
      await wait(550);
      Object.assign(a.tunnel, { managed: false, ready: false, reachable: false, state: "stopped", pid: null, cloudState: "unknown", authError: null, metaError: null });
      log("launcher", "[launcher] tunnel-client stopped", a); changed();
    }
    const requireSetup = a => { if (!a.config.setupDone) throw new Error("账户未配置：请先在连接设置中填写 Tunnel ID、API Key 和工作区。"); };

    const actions = {
      startAll: () => guarded("startAll", async () => {
        const a = current(); requireSetup(a);
        if (!a.mcp.healthy) await bootMcp(a);
        if (a.tunnel.state !== "running") await bootTunnel(a);
        notice("已请求启动当前账户。");
      }),
      stopAll: () => guarded("stopAll", async () => {
        const a = current();
        if (a.tunnel.state === "running" || a.tunnel.state === "error") await haltTunnel(a);
        if (a.mcp.healthy || a.mcp.state === "error") await haltMcp(a);
        resetServices(a); changed();
        notice("当前账户的服务已停止。");
      }),
      startMcp: () => guarded("startMcp", async () => { const a = current(); requireSetup(a); await bootMcp(a); notice("MCP Runtime 已启动。"); }),
      stopMcp: () => guarded("stopMcp", async () => { await haltMcp(current()); notice("MCP Runtime 已停止。"); }),
      restartMcp: () => guarded("restartMcp", async () => {
        const a = current(); requireSetup(a);
        if (a.mcp.healthy) await haltMcp(a);
        await bootMcp(a);
        if (a.tunnel.ready && a.tunnel.cloudState === "online") startTraffic();
        notice("MCP Runtime 已重启。");
      }),
      startTunnel: () => guarded("startTunnel", async () => { const a = current(); requireSetup(a); await bootTunnel(a); notice("已请求启动 Secure Tunnel。"); }),
      stopTunnel: () => guarded("stopTunnel", async () => { await haltTunnel(current()); notice("Secure Tunnel 已停止。"); }),
      stopExternal: () => guarded("stopExternal", async () => { await wait(200); throw new Error("原型不会接管或结束外部进程。"); }),

      selectAccount: id => {
        if (!accounts.some(a => a.id === id) || id === selectedId) return;
        clearTimers(); selectedId = id;
        const a = current();
        if (!a.logs.launcher.length) {
          resetServices(a);
          seedHistory(a, a.config.setupDone ? "stopped" : "unconfigured");
        }
        if (a.tunnel.cloudState === "online") startTraffic();
        emit("account", snapshot()); changed();
      },
      createAccount: name => {
        name = String(name || "").trim();
        if (!name) throw new Error("名称不能为空。");
        if (accounts.length >= 16) throw new Error("最多 16 个账户。");
        const n = accounts.length;
        const a = makeAccount(`fixture-account-${++fixtureAccountSequence}`, name, { setupDone: false, hasApiKey: false, mcpPort: 3300 + n * 10, adminPort: 3301 + n * 10, tunnelPort: 8380 + n * 10, toolProfile: "slim" });
        accounts.push(a);
        actions.selectAccount(a.id);
        notice(`已创建账户“${name}”。它不会复制其他账户的密钥。`);
        return a.id;
      },
      renameAccount: (id, name) => {
        name = String(name || "").trim();
        const a = accounts.find(x => x.id === id);
        if (!a || !name) throw new Error("名称不能为空。");
        a.name = name; changed(); notice("账户已重命名。");
      },
      removeAccount: id => {
        const index = accounts.findIndex(a => a.id === id);
        if (index < 0) throw new Error("账户不存在。");
        const a = accounts[index];
        if ([a.mcp, a.tunnel].some(s => ["starting", "running", "stopping"].includes(s.state))) throw new Error("请先停止此账户的 MCP 和隧道，再移除账户。");
        if (id === selectedId) clearTimers();
        accounts.splice(index, 1);
        if (!accounts.length) accounts.push(makeAccount(`fixture-account-${++fixtureAccountSequence}`, "新账户", { setupDone: false, hasApiKey: false }));
        if (id === selectedId) { selectedId = accounts[0].id; emit("account", snapshot()); }
        changed(); notice("预览账户已移除；没有操作真实文件。");
        return { removedId: id, selectedId, accounts, backup: { created: false, path: null, recoverable: false } };
      },

      saveConfig: patch => {
        const a = current(), cfg = a.config;
        const ports = [patch.mcpPort ?? cfg.mcpPort, patch.adminPort ?? cfg.adminPort, patch.tunnelPort ?? cfg.tunnelPort].map(Number);
        if (ports.some(p => !Number.isInteger(p) || p < 1024 || p > 65535) || new Set(ports).size !== 3) throw new Error("端口必须为 1024–65535 之间互不相同的整数。");
        if (patch.tunnelId && !/^tunnel_[0-9a-z-]{8,}$/i.test(patch.tunnelId)) throw new Error("Tunnel ID 格式应为 tunnel_ 后接 32 位十六进制。");
        if (patch.tunnelProxyMode === "custom" && patch.tunnelProxyUrl && /@/.test(patch.tunnelProxyUrl)) throw new Error("代理地址不能包含用户名或密码。");
        const portMoved = patch.mcpPort != null && Number(patch.mcpPort) !== cfg.mcpPort;
        for (const key of Object.keys(cfg)) if (key in patch && key !== "hasApiKey" && key !== "setupDone") cfg[key] = key.endsWith("Port") ? Number(patch[key]) : patch[key];
        if (portMoved && a.mcp.portOccupiedByUnknown) { a.mcp.portOccupiedByUnknown = false; if (scenario === "port-conflict") scenario = "stopped"; }
        if (patch.apiKey) { cfg.hasApiKey = true; a.credentialFixed = true; }
        a.mcp.toolProfile = cfg.toolProfile;
        if (cfg.tunnelId && cfg.hasApiKey && cfg.workspacePath && !cfg.setupDone && patch.markSetup) cfg.setupDone = true;
        changed(); notice("设置已保存。端口和工具集在重启服务后生效。");
        return cfg;
      },
      runSetup: async patch => guarded("runSetup", async () => {
        const a = current();
        actions.saveConfig(Object.assign({}, patch));
        const cfg = a.config;
        const step = async (line, ms = 420) => { emit("setup-progress", line); await wait(ms); };
        await step("校验 Tunnel ID 格式…");
        if (!cfg.tunnelId) throw new Error("请填写 Tunnel ID。");
        await step("检查 Runtime API Key…");
        if (!cfg.hasApiKey) throw new Error("请填写 Runtime API Key。");
        await step("确认工作区目录可读…");
        if (!cfg.workspacePath) throw new Error("请选择工作区目录。");
        await step(cfg.skipDoctor ? "已跳过初始化检查（tunnel-client doctor）。" : "tunnel-client doctor：模拟校验通过（原型不联网）。", 600);
        cfg.setupDone = true; changed();
        emit("setup-progress", "初始化完成。");
        notice("初始化完成，可以启动当前账户。");
      }),

      setSkillEnabled: (source, id, enabled) => {
        const row = current().catalog[source]?.find(s => s.id === id);
        if (!row) throw new Error("Skill 不存在。");
        row.enabled = enabled; changed();
        notice(`${id} 已${enabled ? "启用" : "停用"}。新建 MCP 会话后生效。`);
      },
      setEngine: (name, enabled) => {
        const engine = current().catalog[name];
        engine.enabled = enabled; changed();
        notice(`${name === "computerUse" ? "Computer Use" : "Browser Use"} 已${enabled ? "启用" : "停用"}。启用后需新建 MCP 会话。`);
      },
      inspectSource: async kind => {
        await wait(260);
        return { kind, root: "D:\\Downloads\\release-notes-writer", skillPath: "D:\\Downloads\\release-notes-writer\\SKILL.md", id: "release-notes-writer", version: "1.0.0",
          description: "根据 Git 提交和合并记录起草中文发布说明。", warnings: ["包内含 scripts/ 目录；安装只读取 SKILL.md 元数据，不会运行脚本。"] };
      },
      installSkill: async (id, source) => {
        await wait(320);
        const cat = current().catalog;
        if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(id)) throw new Error("id 只能包含小写字母、数字和连字符。");
        if (cat.installed.some(s => s.id === id)) throw new Error(`已存在名为 ${id} 的 Skill。`);
        cat.installed.push({ id, version: source.version || "1.0.0", enabled: true, path: "%APPDATA%\\chatgpt-web-harness-isolated\\runtime\\profiles\\local-skills\\" + id + "\\SKILL.md", description: source.description });
        changed(); notice(`已安装 ${id}。新建 MCP 会话后可用。`);
      },
      uninstallSkill: async id => {
        await wait(240);
        const cat = current().catalog;
        cat.installed = cat.installed.filter(s => s.id !== id);
        changed(); notice(`已卸载 ${id}。`);
      },
      addExternal: (name, path) => {
        path = String(path || "").trim();
        if (!/^[a-z]:\\/i.test(path) || !/SKILL\.md$/i.test(path)) throw new Error("请填写 SKILL.md 的绝对路径。");
        const cat = current().catalog;
        const id = (String(name || "").trim() || path.split("\\").slice(-2, -1)[0] || "external").toLowerCase().replace(/[^a-z0-9-]+/g, "-");
        if (cat.external.some(s => s.id === id)) throw new Error(`外部注册里已有 ${id}。`);
        cat.external.push({ id, path, enabled: true, description: "外部注册的 Skill（保存后写入 plugins.json）。", unsaved: true });
        changed();
      },
      removeExternal: id => { const cat = current().catalog; cat.external = cat.external.filter(s => s.id !== id); changed(); },
      saveExternal: async () => {
        await wait(260);
        current().catalog.external.forEach(s => { delete s.unsaved; });
        changed(); notice("外部注册已保存到 plugins.json。");
      },
      resetProfiles: async () => { await wait(260); const cat = current().catalog; cat.external = []; changed(); notice("Skill / 插件配置已重置为默认。"); },
      clearLogs: source => { current().logs[source] = []; changed(); },
      record: what => notice(`原型：已记录“${what}”请求，未访问真实文件或网页。`),
      copy: (count, what = "日志") => notice(`原型：已准备复制 ${count} 行${what}，未写入系统剪贴板。`),
      uninstallApp: async () => { await wait(200); throw new Error("原型不会卸载桌面端或删除数据。"); },
      setScenario: name => applyScenario(name),
      setTraffic: enabled => { manualTraffic = !enabled; clearTimeout(ambient); ambient = null; clearTimeout(timer); timer = null; if (enabled) startTraffic(); },
      simulateCall: (tool, options) => { const a = current(); if (a.tunnel.cloudState === "online" && a.mcp.healthy) return call(a, tool, options); }
    };

    function snapshot() {
      const a = current();
      return { account: a, accounts, selectedId, info: INFO, derived: derive(a), catalog: a.catalog, logs: a.logs, activity: a.activity, scenario, pending };
    }

    document.addEventListener("visibilitychange", () => emit("visibility", document.hidden));

    applyScenario(scenario, accounts[0]);
    // other accounts start quiet
    for (const a of accounts.slice(1)) seedHistory(a, a.config.setupDone ? "stopped" : "unconfigured");

    return { on, snapshot, derive, actions, scenarios: SCENARIOS, info: INFO, isPending: n => pending.has(n) };
  }

  global.HarnessSim = { create, derive: deriveStatus, SCENARIOS, fmt: { hms, hmsUTC, relative, duration } };
})(window);
