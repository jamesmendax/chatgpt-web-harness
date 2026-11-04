import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

import {
  loadUpstreamConfig,
  saveUpstreamConfig,
  mutateUpstreamConfig,
  type UpstreamConfigFile,
  type UpstreamServerConfig,
  resolveUpstreamConfigPath,
} from "./mcp-upstream-config.js";
import { FileOAuthClientProvider } from "./mcp-oauth-provider.js";

export type UpstreamHealth = "unknown" | "connected" | "reachable" | "unreachable" | "disabled";

export interface UpstreamServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  auth: string;
  health: UpstreamHealth;
  connected: boolean;
  tool_count: number;
  expose: string;
  proxied_tools: string[];
  last_error?: string;
  pid?: number | null;
}

interface UpstreamConnection {
  config: UpstreamServerConfig;
  configGeneration: number;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: Tool[];
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastError?: string;
  connected: boolean;
  closing: boolean;
  activeOperations: number;
  closePromise?: Promise<void>;
}

let singleton: McpUpstreamManager | null = null;

export class McpUpstreamManager {
  private config: UpstreamConfigFile;
  private configPath: string;
  private connections = new Map<string, UpstreamConnection>();
  private connecting = new Map<string, Promise<UpstreamConnection>>();
  private servers = new Set<McpServer>();
  private toolsCache = new Map<string, { tools: Tool[]; expiresAt: number; configGeneration: number }>();
  private oauthProviders = new Map<string, FileOAuthClientProvider>();
  private configMutationChain: Promise<void> = Promise.resolve();
  private configGeneration = 0;
  private lifecycleGeneration = 0;
  private serverGenerations = new Map<string, number>();
  private shuttingDown = false;
  private reconfiguring = false;
  private shutdownPromise: Promise<void> | null = null;
  private readonly toolsCacheTtlMs = 60_000;
  private readonly connectTimeoutMs = Math.max(1_000, Number(process.env.MCP_UPSTREAM_CONNECT_TIMEOUT_MS) || 15_000);

  constructor(configPath = resolveUpstreamConfigPath()) {
    this.configPath = configPath;
    this.config = { version: 1, servers: [] };
  }

  async init(): Promise<void> {
    await this.withConfigMutation(async () => {
      this.config = await loadUpstreamConfig(this.configPath);
      this.configGeneration++;
      this.toolsCache.clear();
      this.oauthProviders.clear();
    });
  }

  private async withConfigMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.configMutationChain;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.configMutationChain = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  registerMcpServer(server: McpServer): void {
    this.servers.add(server);
  }

  unregisterMcpServer(server: McpServer): void {
    this.servers.delete(server);
  }

  getConfig(): UpstreamConfigFile {
    return this.config;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  getConfigGeneration(): number {
    return this.configGeneration;
  }

  listServerConfigs(): UpstreamServerConfig[] {
    return [...this.config.servers];
  }

  getServerConfig(serverId: string): UpstreamServerConfig | undefined {
    return this.config.servers.find((s) => s.id === serverId);
  }

  async reloadConfig(options?: RequestOptions): Promise<UpstreamConfigFile> {
    return this.withConfigMutation(async () => {
      this.throwIfAborted(options?.signal);
      const next = await loadUpstreamConfig(this.configPath);
      this.throwIfAborted(options?.signal);
      return this.replaceConfig(next, options);
    });
  }

  async updateConfig(next: UpstreamConfigFile, options?: RequestOptions): Promise<UpstreamConfigFile> {
    return this.withConfigMutation(async () => {
      this.throwIfAborted(options?.signal);
      await saveUpstreamConfig(next, this.configPath);
      const normalized = await loadUpstreamConfig(this.configPath);
      this.throwIfAborted(options?.signal);
      return this.replaceConfig(normalized, options);
    });
  }

  async upsertServer(server: UpstreamServerConfig): Promise<void> {
    await this.withConfigMutation(async () => {
      const next = await mutateUpstreamConfig((latest) => {
        const servers = [...latest.servers];
        const idx = servers.findIndex((s) => s.id === server.id);
        if (idx >= 0) servers[idx] = server;
        else servers.push(server);
        return { version: 1, servers };
      }, this.configPath);
      await this.replaceConfig(next);
    });
  }

  async removeServer(serverId: string): Promise<boolean> {
    return this.withConfigMutation(async () => {
      let removed = false;
      const next = await mutateUpstreamConfig((latest) => {
        const servers = latest.servers.filter((s) => s.id !== serverId);
        removed = servers.length !== latest.servers.length;
        return { version: 1, servers };
      }, this.configPath);
      await this.replaceConfig(next);
      return removed;
    });
  }

  private async updateConfigLocked(
    next: UpstreamConfigFile,
    options?: RequestOptions
  ): Promise<UpstreamConfigFile> {
    this.throwIfAborted(options?.signal);
    await saveUpstreamConfig(next, this.configPath);
    const normalized = await loadUpstreamConfig(this.configPath);
    this.throwIfAborted(options?.signal);
    return this.replaceConfig(normalized, options);
  }

  private async replaceConfig(
    next: UpstreamConfigFile,
    options?: RequestOptions
  ): Promise<UpstreamConfigFile> {
    this.throwIfAborted(options?.signal);
    const ids = new Set([
      ...this.config.servers.map((server) => server.id),
      ...next.servers.map((server) => server.id),
      ...this.connections.keys(),
      ...this.connecting.keys(),
    ]);
    this.configGeneration++;
    this.toolsCache.clear();
    for (const id of ids) this.invalidateServer(id);

    this.reconfiguring = true;
    try {
      await this.shutdown();
      this.throwIfAborted(options?.signal);
      this.config = next;
      this.oauthProviders.clear();
    } finally {
      this.reconfiguring = false;
    }
    this.throwIfAborted(options?.signal);
    await this.refreshAllProxies(options);
    return this.config;
  }

  private async disconnectDisabled(): Promise<void> {
    const enabledIds = new Set(this.config.servers.filter((s) => s.enabled).map((s) => s.id));
    for (const id of [...this.connections.keys()]) {
      if (!enabledIds.has(id)) await this.disconnect(id);
    }
  }

  private getEnabledServers(): UpstreamServerConfig[] {
    return this.config.servers.filter((s) => s.enabled);
  }

  private scheduleIdleDisconnect(serverId: string, conn: UpstreamConnection): void {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    if (conn.closing || conn.activeOperations > 0 || this.connections.get(serverId) !== conn) return;
    const timeoutSec = conn.config.idle_timeout_sec ?? 600;
    if (timeoutSec <= 0) return;
    conn.idleTimer = setTimeout(() => {
      if (conn.activeOperations === 0 && !conn.closing && this.connections.get(serverId) === conn) {
        void this.disconnect(serverId);
      }
    }, timeoutSec * 1000);
  }

  private touch(conn: UpstreamConnection): void {
    conn.lastUsedAt = Date.now();
    this.scheduleIdleDisconnect(conn.config.id, conn);
  }

  private closeConnection(conn: UpstreamConnection): Promise<void> {
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    conn.closing = true;
    conn.connected = false;
    if (!conn.closePromise) {
      conn.closePromise = Promise.resolve()
        .then(() => conn.transport.close())
        .catch(() => undefined);
    }
    return conn.closePromise;
  }

  private beginOperation(conn: UpstreamConnection): void {
    if (conn.closing || !conn.connected) throw new Error(`Upstream connection is closing: ${conn.config.id}`);
    if (conn.idleTimer) clearTimeout(conn.idleTimer);
    conn.idleTimer = null;
    conn.activeOperations++;
    conn.lastUsedAt = Date.now();
  }

  private endOperation(serverId: string, conn: UpstreamConnection): void {
    conn.activeOperations = Math.max(0, conn.activeOperations - 1);
    conn.lastUsedAt = Date.now();
    if (conn.activeOperations === 0) this.scheduleIdleDisconnect(serverId, conn);
  }

  private isCurrentConnection(serverId: string, conn: UpstreamConnection): boolean {
    return (
      this.connections.get(serverId) === conn &&
      conn.connected &&
      !conn.closing &&
      conn.configGeneration === this.configGeneration &&
      this.getServerConfig(serverId) === conn.config
    );
  }

  private shouldUseOAuth(config: UpstreamServerConfig): boolean {
    if (config.transport !== "http") return false;
    const mode = config.auth?.type ?? "auto";
    if (mode === "none") return false;
    if (mode === "oauth") return true;
    const hasHeaders = Object.keys(config.headers ?? {}).length > 0;
    return !hasHeaders && !config.bearer_token_env_var;
  }

  private getOAuthProvider(config: UpstreamServerConfig): FileOAuthClientProvider {
    let provider = this.oauthProviders.get(config.id);
    if (!provider) {
      provider = new FileOAuthClientProvider({
        serverId: config.id,
        scope: config.auth?.scope,
        openBrowser: false,
      });
      this.oauthProviders.set(config.id, provider);
    }
    return provider;
  }

  async oauthStatus(serverId: string) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (!this.shouldUseOAuth(config)) {
      return { configured: false, connected: false, pending: false, auth: config.auth?.type ?? "none" };
    }
    return { ...(await this.getOAuthProvider(config).authorizationStatus()), auth: config.auth?.type ?? "auto" };
  }

  async startOAuth(serverId: string, resetTokens = true) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (config.transport !== "http" || !config.url) throw new Error(`OAuth requires an HTTP upstream: ${serverId}`);
    if (!this.shouldUseOAuth(config)) throw new Error(`OAuth is disabled or static auth is configured for ${serverId}`);

    await this.disconnect(serverId);
    const provider = this.getOAuthProvider(config);
    await provider.beginAuthorization({ resetTokens });
    const result = await auth(provider, { serverUrl: config.url, scope: config.auth?.scope });
    const status = await provider.authorizationStatus();
    return { ...status, result };
  }

  async finishOAuth(serverId: string, authorizationCode: string, state?: string) {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (config.transport !== "http" || !config.url) throw new Error(`OAuth requires an HTTP upstream: ${serverId}`);
    const provider = this.getOAuthProvider(config);
    if (!(await provider.verifyState(state))) throw new Error("OAuth state mismatch or expired authorization flow");

    const result = await auth(provider, {
      serverUrl: config.url,
      authorizationCode,
      scope: config.auth?.scope,
    });
    if (result !== "AUTHORIZED") throw new Error(`OAuth authorization did not complete for ${serverId}`);
    await provider.completeAuthorization();
    await this.disconnect(serverId);
    return this.checkHealth(serverId);
  }

  async disconnectOAuth(serverId: string): Promise<void> {
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    const provider = this.getOAuthProvider(config);
    await provider.invalidateCredentials("tokens");
    await provider.invalidateCredentials("verifier");
    await provider.completeAuthorization();
    await this.disconnect(serverId);
  }

  private async createTransport(config: UpstreamServerConfig, options?: RequestOptions): Promise<{
    client: Client;
    transport: StdioClientTransport | StreamableHTTPClientTransport;
    pid: number | null;
  }> {
    const client = new Client({ name: "codex-mcp-hub", version: "2.0.0" });

    if (config.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: config.command!,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        stderr: "pipe",
      });
      await this.connectClient(client, transport, config.id, options);
      return { client, transport, pid: transport.pid };
    }

    const headers: Record<string, string> = { ...(config.headers ?? {}) };
    const bearerEnv = config.bearer_token_env_var?.trim();
    if (bearerEnv) {
      const token = process.env[bearerEnv]?.trim();
      if (!token) throw new Error(`Missing bearer token environment variable for ${config.id}: ${bearerEnv}`);
      if (!headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${token}`;
    }

    const transport = new StreamableHTTPClientTransport(new URL(config.url!), {
      authProvider: this.shouldUseOAuth(config) ? this.getOAuthProvider(config) : undefined,
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    });
    await this.connectClient(client, transport, config.id, options);
    return { client, transport, pid: null };
  }

  private async withConnectTimeout<T>(
    operation: Promise<T>,
    serverId: string,
    options?: RequestOptions
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timed = Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Upstream connection timed out after ${this.connectTimeoutMs}ms: ${serverId}`)),
            this.connectTimeoutMs
          );
        }),
      ]);
      return await this.waitWithSignal(timed, options?.signal);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getServerGeneration(serverId: string): number {
    return this.serverGenerations.get(serverId) ?? 0;
  }

  private invalidateServer(serverId: string): void {
    this.serverGenerations.set(serverId, this.getServerGeneration(serverId) + 1);
  }

  private abortReason(signal: AbortSignal): Error {
    if (signal.reason instanceof Error) return signal.reason;
    return new DOMException("The operation was aborted", "AbortError");
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.abortReason(signal);
  }

  private async waitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    this.throwIfAborted(signal);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.abortReason(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      operation.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  private discoveryRequestOptions(options?: RequestOptions): RequestOptions {
    return {
      ...options,
      timeout: options?.timeout ?? this.connectTimeoutMs,
      maxTotalTimeout: options?.maxTotalTimeout ?? this.connectTimeoutMs,
    };
  }

  private isConnectionAttemptCurrent(
    serverId: string,
    config: UpstreamServerConfig,
    lifecycleGeneration: number,
    serverGeneration: number,
    configGeneration: number
  ): boolean {
    return (
      !this.shuttingDown &&
      !this.reconfiguring &&
      this.lifecycleGeneration === lifecycleGeneration &&
      this.getServerGeneration(serverId) === serverGeneration &&
      this.configGeneration === configGeneration &&
      this.getServerConfig(serverId) === config &&
      config.enabled
    );
  }

  private async connectClient(
    client: Client,
    transport: StdioClientTransport | StreamableHTTPClientTransport,
    serverId: string,
    options?: RequestOptions
  ): Promise<void> {
    try {
      await this.withConnectTimeout(
        client.connect(transport, this.discoveryRequestOptions(options)),
        serverId,
        options
      );
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async connect(
    serverId: string,
    forceOrOptions: boolean | RequestOptions = false,
    options?: RequestOptions
  ): Promise<UpstreamConnection> {
    const force = typeof forceOrOptions === "boolean" ? forceOrOptions : false;
    const requestOptions = typeof forceOrOptions === "boolean" ? options : forceOrOptions;
    this.throwIfAborted(requestOptions?.signal);
    if (this.shuttingDown || this.reconfiguring) {
      throw new Error(`Upstream manager is changing configuration: ${serverId}`);
    }
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);
    if (!config.enabled) throw new Error(`Upstream server disabled: ${serverId}`);

    const pending = this.connecting.get(serverId);
    if (pending) {
      const connection = await this.waitWithSignal(pending, requestOptions?.signal);
      this.throwIfAborted(requestOptions?.signal);
      if (!force && this.isCurrentConnection(serverId, connection)) {
        this.touch(connection);
        return connection;
      }
      if (!force) return this.connect(serverId, false, requestOptions);
    }

    const existing = this.connections.get(serverId);
    if (
      existing &&
      existing.connected &&
      !existing.closing &&
      existing.configGeneration === this.configGeneration &&
      existing.config === config &&
      !force
    ) {
      this.touch(existing);
      return existing;
    }

    if (existing) {
      await this.disconnect(serverId);
      this.throwIfAborted(requestOptions?.signal);
      return this.connect(serverId, force, requestOptions);
    }

    const lifecycleGeneration = this.lifecycleGeneration;
    const serverGeneration = this.getServerGeneration(serverId);
    const configGeneration = this.configGeneration;
    const attempt = (async (): Promise<UpstreamConnection> => {
      let transport: StdioClientTransport | StreamableHTTPClientTransport | undefined;
      try {
        const created = await this.withConnectTimeout(
          this.createTransport(config, requestOptions),
          serverId,
          requestOptions
        );
        const { client, pid } = created;
        transport = created.transport;
        this.throwIfAborted(requestOptions?.signal);
        const list = await this.withConnectTimeout(
          client.listTools(undefined, this.discoveryRequestOptions(requestOptions)),
          serverId,
          requestOptions
        );
        this.throwIfAborted(requestOptions?.signal);
        const tools = list.tools ?? [];
        const conn: UpstreamConnection = {
          config,
          configGeneration,
          client,
          transport,
          tools,
          lastUsedAt: Date.now(),
          idleTimer: null,
          connected: true,
          closing: false,
          activeOperations: 0,
          lastError: undefined,
        };
        if (config.transport === "stdio" && pid) {
          (conn as UpstreamConnection & { pid?: number }).pid = pid;
        }

        if (!this.isConnectionAttemptCurrent(serverId, config, lifecycleGeneration, serverGeneration, configGeneration)) {
          await transport.close().catch(() => undefined);
          transport = undefined;
          throw new Error(`Upstream connection superseded before activation: ${serverId}`);
        }

        this.connections.set(serverId, conn);
        this.toolsCache.set(serverId, { tools, expiresAt: Date.now() + this.toolsCacheTtlMs, configGeneration });
        this.touch(conn);
        return conn;
      } catch (error) {
        if (transport) await transport.close().catch(() => undefined);
        throw error;
      }
    })();
    this.connecting.set(serverId, attempt);
    try {
      return await attempt;
    } finally {
      if (this.connecting.get(serverId) === attempt) this.connecting.delete(serverId);
    }
  }

  async disconnect(serverId: string): Promise<void> {
    this.invalidateServer(serverId);
    const conn = this.connections.get(serverId);
    const closePromise = conn ? this.closeConnection(conn) : Promise.resolve();
    if (this.connections.get(serverId) === conn) this.connections.delete(serverId);
    this.toolsCache.delete(serverId);

    const pending = this.connecting.get(serverId);
    await Promise.allSettled([
      closePromise,
      ...(pending ? [pending.catch(() => undefined)] : []),
    ]);
    if (this.connections.get(serverId) === conn) {
      this.connections.delete(serverId);
      this.toolsCache.delete(serverId);
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      this.shuttingDown = true;
      this.lifecycleGeneration++;
      const ids = new Set([...this.connections.keys(), ...this.connecting.keys()]);
      for (const id of ids) this.invalidateServer(id);
      try {
        const closing = [...this.connections.entries()].map(([id, conn]) => {
          if (this.connections.get(id) === conn) this.connections.delete(id);
          return this.closeConnection(conn);
        });
        const pending = [...this.connecting.values()].map((attempt) => attempt.catch(() => undefined));
        await Promise.allSettled([...closing, ...pending]);

        const leftovers = [...this.connections.entries()].map(([id, conn]) => {
          if (this.connections.get(id) === conn) this.connections.delete(id);
          return this.closeConnection(conn);
        });
        await Promise.allSettled(leftovers);
        this.connecting.clear();
        this.toolsCache.clear();
      } finally {
        this.shuttingDown = false;
      }
    })();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = null;
    }
  }

  async listTools(serverId: string, options?: RequestOptions): Promise<Tool[]> {
    this.throwIfAborted(options?.signal);
    const cached = this.toolsCache.get(serverId);
    const cachedConnection = this.connections.get(serverId);
    if (
      cached &&
      cached.configGeneration === this.configGeneration &&
      cached.expiresAt > Date.now() &&
      cachedConnection &&
      this.isCurrentConnection(serverId, cachedConnection)
    ) {
      this.touch(cachedConnection);
      return cached.tools;
    }
    if (cached && cached.configGeneration !== this.configGeneration) this.toolsCache.delete(serverId);

    const conn = await this.connect(serverId, options);
    this.throwIfAborted(options?.signal);
    const connectedCache = this.toolsCache.get(serverId);
    if (
      connectedCache &&
      connectedCache.configGeneration === this.configGeneration &&
      connectedCache.expiresAt > Date.now() &&
      this.isCurrentConnection(serverId, conn)
    ) {
      this.touch(conn);
      return connectedCache.tools;
    }

    this.beginOperation(conn);
    try {
      const list = await this.withConnectTimeout(
        conn.client.listTools(undefined, this.discoveryRequestOptions(options)),
        serverId,
        options
      );
      this.throwIfAborted(options?.signal);
      if (!this.isCurrentConnection(serverId, conn)) {
        throw new Error(`Upstream tool discovery superseded before activation: ${serverId}`);
      }
      const tools = list.tools ?? [];
      conn.tools = tools;
      this.toolsCache.set(serverId, {
        tools,
        expiresAt: Date.now() + this.toolsCacheTtlMs,
        configGeneration: this.configGeneration,
      });
      return tools;
    } finally {
      this.endOperation(serverId, conn);
    }
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    options?: RequestOptions
  ): Promise<unknown> {
    this.throwIfAborted(options?.signal);
    const conn = await this.connect(serverId, options);
    this.throwIfAborted(options?.signal);
    this.beginOperation(conn);
    try {
      const result = await this.waitWithSignal(
        conn.client.callTool({ name: toolName, arguments: args }, undefined, options),
        options?.signal
      );
      this.throwIfAborted(options?.signal);
      if (!this.isCurrentConnection(serverId, conn)) {
        throw new Error(`Upstream tool call superseded before completion: ${serverId}`);
      }
      return result;
    } finally {
      this.endOperation(serverId, conn);
    }
  }

  async checkHealth(serverId: string, options?: RequestOptions): Promise<UpstreamServerStatus> {
    this.throwIfAborted(options?.signal);
    const config = this.getServerConfig(serverId);
    if (!config) throw new Error(`Unknown upstream server: ${serverId}`);

    if (!config.enabled) {
      return this.buildStatus(config, "disabled", false, []);
    }

    try {
      const conn = await this.connect(serverId, options);
      this.throwIfAborted(options?.signal);
      return this.buildStatus(config, "connected", true, conn.tools, undefined, conn);
    } catch (err) {
      if (options?.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        throw options?.signal?.aborted ? this.abortReason(options.signal) : err;
      }
      const message = err instanceof Error ? err.message : String(err);
      return this.buildStatus(config, "unreachable", false, [], message);
    }
  }

  async listStatuses(options?: RequestOptions): Promise<UpstreamServerStatus[]> {
    this.throwIfAborted(options?.signal);
    return Promise.all(this.config.servers.map((config) => this.checkHealth(config.id, options)));
  }

  private buildStatus(
    config: UpstreamServerConfig,
    health: UpstreamHealth,
    connected: boolean,
    tools: Tool[],
    lastError?: string,
    conn?: UpstreamConnection
  ): UpstreamServerStatus {
    const proxied = this.getProxiedToolNames(config, tools);
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      transport: config.transport,
      auth: config.transport !== "http" ? "none" : this.shouldUseOAuth(config) ? "oauth" : (Object.keys(config.headers ?? {}).length || config.bearer_token_env_var) ? "static" : "none",
      health,
      connected,
      tool_count: tools.length,
      expose: config.expose,
      proxied_tools: proxied,
      last_error: lastError,
      pid: conn && "pid" in conn ? (conn as UpstreamConnection & { pid?: number }).pid ?? null : null,
    };
  }

  getProxiedToolNames(config: UpstreamServerConfig, tools: Tool[]): string[] {
    if (!config.enabled || config.expose === "none" || config.expose === "meta_only") return [];
    const prefix = `${config.tool_prefix ?? config.id}__`;
    return tools
      .filter((tool) => !(config.disabled_tools ?? []).includes(tool.name))
      .filter((tool) => config.expose === "all" || (config.tools ?? []).includes(tool.name))
      .map((tool) => `${prefix}${tool.name}`);
  }

  async refreshAllProxies(options?: RequestOptions): Promise<void> {
    const { refreshProxiedTools } = await import("./mcp-tool-proxy.js");
    for (const server of this.servers) {
      this.throwIfAborted(options?.signal);
      await refreshProxiedTools(server, this, options);
      this.throwIfAborted(options?.signal);
      server.sendToolListChanged();
    }
  }
}

export function getUpstreamManager(): McpUpstreamManager {
  if (!singleton) {
    singleton = new McpUpstreamManager();
  }
  return singleton;
}

export async function initUpstreamManager(): Promise<McpUpstreamManager> {
  const manager = getUpstreamManager();
  await manager.init();
  return manager;
}
