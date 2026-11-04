"use strict";
// 服务编排：启动/停止 MCP 与 Tunnel，识别外部进程，聚合状态，初始化校验与下载。
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ManagedProcess, killTree, sleep } = require("./processes");
const { OwnedServiceRecovery } = require("./service-recovery");
const status = require("./status");
const { parseManagedDiagnostic } = require("./tunnel-health");
const harness = require("./harness");
const paths = require("./paths");
const configStore = require("./config");
const { profile } = require("./app-profile");
const accountContext = require("./account-context");
const computerUseRuntime = require("./computer-use-runtime");

const MCP_PATTERN = /dist[\\/]index\.js/i;
const TUNNEL_PATTERN = /tunnel-client(\.exe)?/i;
const SETUP_MCP = Symbol("temporary setup MCP");

// Every account managed by AccountManager owns its process pair. Reusing or
// terminating a process discovered only by port/command-line heuristics would
// blur that ownership boundary, even for the legacy/default profile.
function ownershipIsolated() {
  return profile.isolated || Boolean(accountContext.current());
}

class Services extends EventEmitter {
  constructor() {
    super();
    // Managed-process events run in the emitter's current async context, which
    // may belong to another account.  Keep the immutable owner scope captured
    // when AccountManager creates this service pair and re-enter it for every
    // credential revocation.
    this.accountScope = accountContext.current();
    this.mcp = new ManagedProcess("mcp");
    this.tunnel = new ManagedProcess("tunnel");
    this.launcherLines = [];
    for (const proc of [this.mcp, this.tunnel]) {
      proc.on("log", (line) => this.emit("log", { name: proc.name, line }));
      proc.on("state", () => { this.refresh().catch(() => {}); });
    }
    // 控制平面认证诊断：只从当前隧道进程的日志推导，进程重启时清空。
    this.tunnelDiagnostics = [];
    this.tunnel.on("log", (line) => {
      const item = parseManagedDiagnostic(line);
      if (item) {
        this.tunnelDiagnostics.push(item);
        if (this.tunnelDiagnostics.length > 64) this.tunnelDiagnostics.shift();
      }
    });
    this.lastStatus = null;
    this.statusInFlight = null;
    this.refreshInFlight = null;
    this.busy = false;
    this.shuttingDown = false;
    this.startingServices = new Set();
    this.recovery = {};
    for (const name of ["mcp", "tunnel"]) {
      this.recovery[name] = new OwnedServiceRecovery({
        name,
        isAlive: () => this[name].isAlive(),
        isBusy: () => this.busy || this.startingServices.size > 0,
        isBlocked: () => this.shuttingDown || (name === "tunnel" &&
          this.tunnelDiagnostics.some((item) => item.kind === "authError")),
        restart: (guard) => this.startManaged(name, guard),
        note: (text) => this.note(text),
      });
      this[name].on("unexpected-exit", (event) => {
        if (name === "mcp") this.revokeMcpCapabilities();
        this.recovery[name].onUnexpectedExit(event);
      });
    }
  }

  runInOwnerScope(fn) {
    return this.accountScope ? accountContext.run(this.accountScope, fn) : fn();
  }

  revokeMcpCapabilities() {
    return this.runInOwnerScope(() => {
      computerUseRuntime.revoke();
    });
  }

  note(text) {
    const line = `${new Date().toLocaleTimeString("en-GB", { hour12: false })}   ${text}`;
    this.launcherLines.push(line);
    if (this.launcherLines.length > 1000) this.launcherLines.shift();
    this.emit("log", { name: "launcher", line });
  }

  config() {
    return configStore.load();
  }

  collectStatus() {
    // Timer, IPC and managed-process events can all request the same slow poll.
    // Share only the active snapshot; actions perform their own fresh checks.
    if (this.statusInFlight) return this.statusInFlight;
    const pending = Promise.resolve().then(() => this.collectStatusSnapshot()).finally(() => {
      if (this.statusInFlight === pending) this.statusInFlight = null;
    });
    this.statusInFlight = pending;
    return pending;
  }

  async collectStatusSnapshot() {
    const cfg = this.config();
    const managedAtStart = [this.mcp, this.tunnel].map((proc) => ({
      alive: proc.isAlive(), pid: proc.pid, startedAt: proc.startedAt,
    }));
    const [health, tunnelProbe, mcpOwner, tunnelOwner] = await Promise.all([
      status.probeMcp(cfg.mcpPort),
      status.probeTunnel(cfg.tunnelPort, {
        expectedTunnelId: cfg.tunnelId,
        // Keep the most recent owned generation's sanitized control-plane
        // diagnosis available even if startup has already failed and cleaned
        // up the child. A later daemon generation is protected by startedAt/
        // instance/tunnel scoping inside probeTunnel().
        managedStartedAt: this.tunnel.startedAt || null,
        managedDiagnostics: this.tunnelDiagnostics,
      }),
      this.mcp.isAlive() ? null : status.classifyPortOwner(cfg.mcpPort, MCP_PATTERN),
      this.tunnel.isAlive() ? null : status.classifyPortOwner(cfg.tunnelPort, TUNNEL_PATTERN),
    ]);
    // A save or process transition may join this flight while probes await I/O.
    // Retry serially rather than publishing old-port/old-process observations.
    const currentCfg = this.config();
    const changedConfig = ["mcpPort", "tunnelPort", "tunnelId"].some((key) => cfg[key] !== currentCfg[key]);
    const changedProcess = [this.mcp, this.tunnel].some((proc, i) =>
      proc.isAlive() !== managedAtStart[i].alive || proc.pid !== managedAtStart[i].pid || proc.startedAt !== managedAtStart[i].startedAt);
    if (changedConfig || changedProcess) return this.collectStatusSnapshot();
    const mcpManaged = this.mcp.isAlive();
    const tunnelManaged = this.tunnel.isAlive();

    const result = {
      at: Date.now(),
      busy: this.busy,
      config: configStore.publicView(currentCfg),
      mcp: {
        state: this.mcp.state,
        managed: mcpManaged,
        pid: mcpManaged
          ? this.mcp.pid
          : (health && health.runtime ? health.runtime.pid : (mcpOwner && mcpOwner.pid) || null),
        healthy: Boolean(health),
        external: !mcpManaged && Boolean(health),
        externalRecognized: Boolean(!ownershipIsolated() && !mcpManaged && mcpOwner && mcpOwner.recognized),
        ownerProbeError: !mcpManaged && mcpOwner ? mcpOwner.error : null,
        portOccupiedByUnknown: Boolean(!mcpManaged && !health && mcpOwner && mcpOwner.pid),
        build: health && health.runtime ? health.runtime.build_id : null,
        toolCount: health && health.runtime ? health.runtime.tool_count : null,
        toolProfile: health ? health.toolProfile : null,
        staleBuild: health && health.runtime ? Boolean(health.runtime.stale_build) : null,
        auth: health ? health.auth : null,
        providers: health ? health.providers || null : null,
        startedAt: health && health.runtime ? health.runtime.started_at : null,
        lastExit: this.mcp.lastExit,
        recovery: this.recovery.mcp.snapshot(),
      },
      tunnel: {
        state: this.tunnel.state,
        managed: tunnelManaged,
        pid: tunnelManaged ? this.tunnel.pid : (tunnelOwner && tunnelOwner.pid) || null,
        reachable: tunnelProbe.reachable,
        ready: tunnelProbe.ready,
        // Cloud state comes from real poll metrics plus scoped errors, including external daemons.
        cloudState: tunnelProbe.cloudState,
        lastPollSuccessAt: tunnelProbe.lastPollSuccessAt,
        instanceId: tunnelProbe.instanceId,
        proxyRoute: tunnelProbe.proxyRoute,
        authError: tunnelProbe.authError,
        metaError: tunnelProbe.metaError,
        external: !tunnelManaged && tunnelProbe.ready,
        externalRecognized: Boolean(!ownershipIsolated() && !tunnelManaged && tunnelOwner && tunnelOwner.recognized),
        ownerProbeError: !tunnelManaged && tunnelOwner ? tunnelOwner.error : null,
        portOccupiedByUnknown: Boolean(!tunnelManaged && !tunnelProbe.ready && tunnelOwner && tunnelOwner.pid),
        lastExit: this.tunnel.lastExit,
        recovery: this.recovery.tunnel.snapshot(),
      },
      paths: {
        codeRoot: paths.codeRoot(),
        runtimeDir: paths.runtimeDir(),
        logsDir: paths.logsDir(),
        tunnelClient: paths.tunnelClientPath(),
        tunnelClientExists: fs.existsSync(paths.tunnelClientPath()),
        distExists: fs.existsSync(paths.distEntry()),
      },
    };
    this.lastStatus = result;
    return result;
  }

  refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    const pending = this.collectStatus().then((snapshot) => {
      this.emit("status", snapshot);
      return snapshot;
    }).finally(() => {
      if (this.refreshInFlight === pending) this.refreshInFlight = null;
    });
    this.refreshInFlight = pending;
    return pending;
  }

  async withBusy(fn) {
    if (this.busy) throw new Error("上一个操作还在进行中，请稍候。");
    this.busy = true;
    try {
      this.emit("status", await this.collectStatus());
      return await fn();
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  async waitFor(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.shuttingDown) return false;
      if (await check()) return true;
      await sleep(500);
    }
    this.note(`等待 ${label} 超时（${Math.round(timeoutMs / 1000)}s）`);
    return false;
  }

  async startManaged(name, recoveryGuard = null) {
    if (this.startingServices.has(name)) throw new Error("Service startup already in progress.");
    const controller = this.recovery[name];
    const scope = accountContext.current();
    const run = (fn) => scope ? accountContext.run(scope, fn) : fn();
    const signature = () => {
      const cfg = this.config();
      return JSON.stringify([cfg.mcpPort, cfg.adminPort, cfg.tunnelPort, cfg.workspacePath,
        cfg.toolProfile, cfg.tunnelId, cfg.tunnelProxyMode, cfg.tunnelProxyUrl]);
    };
    const initial = signature();
    const guard = recoveryGuard || controller.arm({ run,
      valid: () => !this.shuttingDown && signature() === initial });
    this.startingServices.add(name);
    try {
      if (!guard()) throw new Error("Service startup cancelled by ownership/configuration change.");
      return await (name === "mcp" ? this.startMcpOwned(guard) : this.startTunnelOwned(guard));
    } catch (error) {
      if (name === "mcp") this.revokeMcpCapabilities();
      if (!recoveryGuard) controller.disarm("initial_start_failed");
      throw error;
    } finally {
      this.startingServices.delete(name);
    }
  }

  startMcp() { return this.startManaged("mcp"); }
  startTunnel() { return this.startManaged("tunnel"); }

  // Called inside setup:run's existing busy/account boundary. Never nests withBusy,
  // starts a Tunnel, adopts an external listener, or arms automatic recovery.
  async withSetupMcp(check) {
    if (this.shuttingDown || this.startingServices.has("mcp")) throw new Error("MCP setup startup cancelled or already in progress.");
    if (this.mcp.isAlive()) {
      const child = this.mcp.child, pid = this.mcp.pid;
      const health = await status.probeMcp(this.config().mcpPort);
      if (!health || health.runtime?.pid !== pid || !this.mcp.isAlive() || this.mcp.child !== child || this.shuttingDown) throw new Error("Owned MCP is not ready or its process identity changed.");
      return check(); // Preserve an already-owned process, including on doctor failure.
    }
    this.startingServices.add("mcp");
    this.recovery.mcp.disarm("temporary_setup");
    let createdChild = null;
    try {
      const cfg = this.config();
      const signature = JSON.stringify([cfg.mcpPort, cfg.adminPort, cfg.workspacePath]);
      const guard = () => {
        const current = this.config();
        return !this.shuttingDown && signature === JSON.stringify([current.mcpPort, current.adminPort, current.workspacePath]);
      };
      // MCP binds both ports. A foreign Admin listener must also remain untouched.
      const adminOwner = await status.classifyPortOwner(cfg.adminPort, MCP_PATTERN, { fresh: true });
      if (adminOwner.error || adminOwner.pid) throw new Error(`Admin 端口 ${cfg.adminPort} 被占用或状态无法确认，未启动 MCP，未终止外部进程。`);
      await this.startMcpOwned(guard, SETUP_MCP, child => { createdChild = child; });
      return await check();
    } finally {
      try {
        // Object identity, not a recycled PID or port, grants cleanup ownership.
        if (createdChild && this.mcp.child === createdChild) {
          await this.mcp.stop();
          this.revokeMcpCapabilities();
        }
      } finally {
        this.startingServices.delete("mcp");
      }
    }
  }

  async startMcpOwned(guard, mode, onCreated) {
    const cfg = this.config();
    if (!cfg.setupDone && mode !== SETUP_MCP) throw new Error("请先完成初始化。");
    if (this.mcp.isAlive()) { this.note("MCP 已由启动器管理，跳过。"); return; }
    const health = await status.probeMcp(cfg.mcpPort);
    if (health) {
      if (mode === SETUP_MCP || ownershipIsolated()) throw new Error("隔离版不复用外部 MCP；多账号模式同样要求当前账号使用独立端口，且不会接管或终止任何外部进程。");
      this.note(`端口 ${cfg.mcpPort} 已有健康的 MCP（PID ${health.runtime && health.runtime.pid}），沿用该外部进程。`);
      this.recovery.mcp.disarm("external_process_not_owned");
      return;
    }
    const owner = await status.classifyPortOwner(cfg.mcpPort, MCP_PATTERN, { fresh: true });
    if (owner.error) throw new Error(`无法确认端口 ${cfg.mcpPort} 的占用状态（${owner.error}），未启动 MCP。`);
    if (owner.pid) {
      throw new Error(`端口 ${cfg.mcpPort} 被 PID ${owner.pid}（${owner.info ? owner.info.name : "未知"}）占用且不是健康的 MCP，未做任何终止。`);
    }
    if (!fs.existsSync(paths.distEntry())) throw new Error(`找不到 MCP 构建产物: ${paths.distEntry()}`);
    paths.ensureRuntimeDir();
    await paths.ensureBrowserUseRuntime((message) => this.note(message));
    if (!guard() || this.shuttingDown) throw new Error("MCP startup cancelled while preparing browser components.");
    harness.ensureDotEnv();
    if (this.shuttingDown) throw new Error("程序正在退出，已取消 MCP 启动。");
    const spec = harness.mcpSpawnSpec(cfg);
    if (!guard()) throw new Error("MCP startup cancelled before spawn.");
    const pid = this.mcp.start(spec);
    if (onCreated) onCreated(this.mcp.child);
    this.note(`MCP 已启动，PID ${pid}，等待 /health ...`);
    const ok = await this.waitFor(async () => {
      const health = await status.probeMcp(cfg.mcpPort);
      return Boolean(health && (mode !== SETUP_MCP || health.runtime?.pid === pid));
    }, 45000, "MCP /health");
    if (!ok) {
      if (mode !== SETUP_MCP && this.mcp.isAlive()) await this.mcp.stop();
      throw new Error("MCP 未在 45 秒内就绪，请查看 MCP 日志。");
    }
    if (!guard() || !this.mcp.isAlive()) throw new Error("MCP startup cancelled or process exited.");
    this.mcp.markRunning();
    const h = await status.probeMcp(cfg.mcpPort);
    if (h && h.runtime) {
      this.note(`MCP 就绪: build ${h.runtime.build_id}，${h.runtime.tool_count} tools，stale_build=${h.runtime.stale_build}`);
    }
  }

  async startTunnelOwned(guard) {
    const cfg = this.config();
    if (!cfg.setupDone) throw new Error("请先完成初始化。");
    if (this.tunnel.isAlive()) { this.note("Tunnel 已由启动器管理，跳过。"); return; }
    const probe = await status.probeTunnel(cfg.tunnelPort, { expectedTunnelId: cfg.tunnelId });
    if (probe.metaError?.code === "tunnel_mismatch") throw new Error("本地端口上的 Tunnel ID 与配置不符；未终止外部进程，请检查端口或配置。");
    if (probe.ready) {
      if (ownershipIsolated()) throw new Error("隔离版不复用外部 Tunnel；多账号模式同样要求当前账号使用独立端口，且不会接管或终止任何外部进程。");
      this.note(`端口 ${cfg.tunnelPort} 已有就绪的隧道，沿用该外部进程。`);
      this.recovery.tunnel.disarm("external_process_not_owned");
      return;
    }
    const owner = await status.classifyPortOwner(cfg.tunnelPort, TUNNEL_PATTERN, { fresh: true });
    if (owner.error) throw new Error(`无法确认端口 ${cfg.tunnelPort} 的占用状态（${owner.error}），未启动 Tunnel。`);
    if (owner.pid) {
      throw new Error(`端口 ${cfg.tunnelPort} 被 PID ${owner.pid}（${owner.info ? owner.info.name : "未知"}）占用且未就绪，未做任何终止。`);
    }
    if (!fs.existsSync(paths.tunnelClientPath())) throw new Error("找不到 tunnel-client.exe，请先在初始化页下载。");
    const apiKey = configStore.decryptKey(cfg);
    if (!apiKey) throw new Error("尚未保存 Runtime API Key。");
    this.tunnelDiagnostics = [];
    const spec = await harness.tunnelSpawnSpec(cfg, apiKey, "run");
    this.note(`Tunnel 出站策略：${spec.proxyInfo.mode === "proxy" ? spec.proxyInfo.url : "直连"}（${spec.proxyInfo.source}）；本地 MCP 直连。`);
    if (this.shuttingDown) throw new Error("程序正在退出，已取消隧道启动。");
    if (!guard()) throw new Error("Tunnel startup cancelled before spawn.");
    const pid = this.tunnel.start(spec);
    this.note(`Tunnel 已启动，PID ${pid}，等待 /readyz ...`);
    let startupAuthError = null;
    const ok = await this.waitFor(async () => {
      startupAuthError = [...this.tunnelDiagnostics].reverse().find((item) => item.kind === "authError") || null;
      if (startupAuthError) return true;
      return (await status.probeTunnel(cfg.tunnelPort)).ready;
    }, 60000, "Tunnel /readyz");
    if (startupAuthError) {
      if (this.tunnel.isAlive()) await this.tunnel.stop();
      throw new Error("Tunnel 控制平面认证失败（401/403）；请检查 Tunnel ID 与 Runtime API Key。");
    }
    if (!ok) {
      if (this.tunnel.isAlive()) await this.tunnel.stop();
      throw new Error("Tunnel 未在 60 秒内就绪，请检查 Tunnel 日志（常见原因：Tunnel ID / Runtime Key 错误或网络不通）。");
    }
    if (!guard() || !this.tunnel.isAlive()) throw new Error("Tunnel startup cancelled or process exited.");
    this.tunnel.markRunning();
    // This short settle may surface an auth failure; it is not cloud-success evidence.
    await sleep(2500);
    const cloud = await status.probeTunnel(cfg.tunnelPort, { expectedTunnelId: cfg.tunnelId,
      managedStartedAt: this.tunnel.startedAt, managedDiagnostics: this.tunnelDiagnostics });
    if (cloud.authError) {
      this.note("警告：隧道本地已就绪，但控制平面拒绝了凭据（401/403）。请检查 Tunnel ID 与 Runtime API Key。");
    } else if (cloud.metaError) {
      this.note("警告：本地 ready，但云端连接异常，正在退避重试；请检查 Tunnel 出站代理和网络。");
    } else if (cloud.cloudState === "online") {
      this.note("Tunnel 已完成真实云端轮询，本地 MCP 也已就绪。");
    } else {
      this.note("Tunnel 本地已就绪；正在等待首轮云端轮询确认（通常约 30 秒），尚不表示云端在线。");
    }
  }

  async startAll() {
    return this.withBusy(async () => {
      await this.startMcp();
      await this.startTunnel();
    });
  }

  async stopTunnel() {
    this.recovery.tunnel.disarm();
    if (this.tunnel.isAlive()) {
      await this.tunnel.stop();
      this.note("Tunnel 已停止。");
    } else {
      this.note("Tunnel 不是由启动器管理的进程，未停止。若要停止外部进程请使用“接管外部进程”。");
    }
    // Explicit user/application stop dismisses the previous owned generation's
    // diagnostic. Failed startup cleanup calls ManagedProcess.stop() directly,
    // so its useful diagnosis remains visible until the next explicit action.
    this.tunnelDiagnostics = [];
  }

  async stopMcp() {
    this.recovery.mcp.disarm();
    if (this.mcp.isAlive()) {
      await this.mcp.stop();
      this.note("MCP 已停止。");
    } else {
      this.note("MCP 不是由启动器管理的进程，未停止。");
    }
    this.revokeMcpCapabilities();
  }

  async stopAll() {
    this.recovery.tunnel.disarm();
    this.recovery.mcp.disarm();
    return this.withBusy(async () => {
      await this.stopTunnel();
      await this.stopMcp();
    });
  }

  async restartMcp() {
    this.recovery.mcp.disarm("explicit_restart");
    return this.withBusy(async () => {
      if (this.mcp.isAlive()) await this.mcp.stop();
      this.revokeMcpCapabilities();
      await this.startMcp();
    });
  }

  /** 明确的用户操作：终止已识别的外部 MCP / Tunnel 进程（只终止命令行匹配的进程）。 */
  async stopExternal() {
    // Isolation is an ownership boundary, not a heuristic command-name match.
    if (ownershipIsolated()) throw new Error("隔离版不接管或终止外部进程；多账号模式也只管理当前账号由本程序启动的服务。");
    return this.withBusy(async () => {
      const cfg = this.config();
      const targets = [
        ["Tunnel", cfg.tunnelPort, TUNNEL_PATTERN],
        ["MCP", cfg.mcpPort, MCP_PATTERN],
      ];
      for (const [label, port, pattern] of targets) {
        const owner = await status.classifyPortOwner(port, pattern, { fresh: true });
        if (owner.error) {
          this.note(`${label} 端口 ${port} 的占用状态无法确认（${owner.error}），未终止任何进程。`);
          continue;
        }
        if (!owner.pid) continue;
        if (!owner.recognized || !owner.creationDate) {
          this.note(`${label} 端口 ${port} 的占用者 PID ${owner.pid} 身份未完整确认，跳过。`);
          continue;
        }
        // Bypass both the display cache and earlier in-flight polls again.
        // PID + CreationDate detects PID reuse even when the new command matches.
        const current = await status.processInfo(owner.pid, { fresh: true });
        if (!current || current.ProcessId !== owner.pid || current.CreationDate !== owner.creationDate ||
            current.Name !== owner.info.name || current.CommandLine !== owner.info.commandLine) {
          this.note(`${label} 端口 ${port} 的占用者在校验期间变化或无法确认，未终止任何进程。`);
          continue;
        }
        // CIM can be slow: check the actual listener AFTER the last identity
        // query too, so a port reassigned during that query cannot authorize a kill.
        const pids = await status.listeningPids(port, { fresh: true }).catch(() => null);
        if (!pids || pids.length !== 1 || pids[0] !== owner.pid) {
          this.note(`${label} 端口 ${port} 的占用者已变化或无法确认，未终止任何进程。`);
          continue;
        }
        // Never promote ParentProcessId to a kill target: its original process
        // may have exited and that PID may now belong to an unrelated shell.
        this.note(`终止外部 ${label} 进程树 PID ${owner.pid} ...`);
        killTree(owner.pid);
        await this.waitFor(async () => {
          try { return (await status.listeningPids(port, { fresh: true })).length === 0; }
          catch { return false; } // A failed netstat is not proof the port is free.
        }, 10000, `${label} 端口释放`);
      }
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    this.recovery.tunnel.disarm("shutdown");
    this.recovery.mcp.disarm("shutdown");
    if (this.tunnel.isAlive()) await this.tunnel.stop(5000);
    if (this.mcp.isAlive()) await this.mcp.stop(5000);
    this.revokeMcpCapabilities();
  }

  /** doctor validates local preflight; only successful polling proves remote authentication. */
  async runDoctor(cfg, apiKey, onLine) {
    const spec = await harness.tunnelSpawnSpec(cfg, apiKey, "doctor");
    const { redactSetupText } = require("./setup");
    const { StringDecoder } = require("node:string_decoder");
    return new Promise((resolve) => {
      let output = "";
      let child;
      try {
        child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, windowsHide: true });
      } catch (err) {
        resolve({ ok: false, output: redactSetupText(`无法启动 doctor: ${err.message}`, [apiKey]) });
        return;
      }
      const streams = [child.stdout, child.stderr].map(stream => ({ stream, decoder: new StringDecoder("utf8"), pending: "" }));
      let settled = false;
      const publish = line => {
        const safe = redactSetupText(line, [apiKey]);
        output += safe + "\n";
        if (onLine && safe.trim()) onLine(safe);
      };
      const finish = (code, error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        for (const stream of streams) {
          stream.pending += stream.decoder.end();
          if (stream.pending) publish(stream.pending.replace(/\r$/, ""));
          stream.pending = "";
        }
        if (error) publish(error.message);
        resolve({ ok: code === 0 && !error, output, code });
      };
      const timer = setTimeout(() => { try { child.kill(); } catch {} finish(null, new Error("初始化检查超时（90 秒）。")); }, 90000);
      for (const stream of streams) stream.stream.on("data", chunk => {
        if (settled) return;
        stream.pending += stream.decoder.write(chunk);
        let end;
        while ((end = stream.pending.indexOf("\n")) >= 0) {
          publish(stream.pending.slice(0, end).replace(/\r$/, ""));
          stream.pending = stream.pending.slice(end + 1);
        }
      });
      child.on("error", error => finish(null, error));
      child.on("close", code => finish(code));
    });
  }

  /**
   * Return the verified tunnel-client shipped with this application.
   *
   * The old fallback downloaded an older upstream client when the file was missing.
   * That can silently downgrade the response-delivery resilience fix.  A
   * missing bundled runtime is now a fail-closed installation error instead
   * of an implicit network download to an older executable.
   */
  async downloadTunnelClient(onProgress) {
    const bundled = paths.tunnelClientPath();
    if (!fs.existsSync(bundled)) {
      throw new Error("内置 tunnel-client.exe 缺失，请重新安装或修复本应用；为避免网络韧性降级，本版本不会自动下载旧版客户端。");
    }
    const total = fs.statSync(bundled).size;
    if (onProgress) onProgress({ received: total, total });
    return bundled;
  }
}

module.exports = { Services, MCP_PATTERN, TUNNEL_PATTERN };
