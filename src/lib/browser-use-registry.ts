import crypto from "node:crypto";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  BrowserUseProvider,
  browserUseProvisioning,
  type BrowserUseProviderOptions,
  type BrowserUseProvisioning,
} from "./browser-use-provider.js";
import { currentProviderScope, type ProviderScope } from "./provider-scope.js";
type BrowserTool = "browser_exec" | "browser_screenshot";

interface ProviderHandle {
  call(tool: BrowserTool, args: Record<string, unknown>, signal?: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<CallToolResult>;
  status(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface BrowserUseRegistryOptions {
  /** Dependency seams used by deterministic tests; production uses validated provisioning. */
  createProvider?: (options: BrowserUseProviderOptions) => ProviderHandle;
  provisioning?: () => BrowserUseProvisioning;
  now?: () => number;
  idleTimeoutMs?: number;
  sweepIntervalMs?: number;
  maxEntries?: number;
}

interface Entry {
  readonly key: string;
  serial: Promise<void>;
  pending: number;
  lastUsedAt: number;
  binding?: string;
  provisioning?: string;
  provider?: ProviderHandle;
  retiring?: Promise<void>;
}

/**
 * Conversation ownership outlives a disposable HTTP/MCP transport.
 * One queue owns each base scope, including Goal/provisioning transitions.
 * Only idle entries expire; capacity fails closed instead of killing accepted work.
 */
export class BrowserUseRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly createProvider: (options: BrowserUseProviderOptions) => ProviderHandle;
  private readonly provisioning: () => BrowserUseProvisioning;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private readonly maxEntries: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(options: BrowserUseRegistryOptions = {}) {
    this.createProvider = options.createProvider ?? ((providerOptions) => new BrowserUseProvider(providerOptions));
    this.provisioning = options.provisioning ?? browserUseProvisioning;
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 30_000;
    this.maxEntries = options.maxEntries ?? 8;
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0 ||
        !Number.isFinite(this.sweepIntervalMs) || this.sweepIntervalMs <= 0 ||
        !Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error("Invalid Browser Use registry limits");
    }
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweepExpired().catch((error) => {
        console.warn("[Browser Use] Scoped idle cleanup failed:", error instanceof Error ? error.name : "unknown");
      });
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  private stopEmptyTimer(): void {
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async call(scope: ProviderScope, tool: BrowserTool, args: Record<string, unknown>): Promise<CallToolResult> {
    if (this.disposed) throw new Error("BROWSER_USE_REGISTRY_CLOSED");
    if (!/^[a-f0-9]{64}$/.test(scope.key) || !/^[a-f0-9]{64}$/.test(scope.binding)) {
      throw new Error("BROWSER_USE_TRUSTED_SCOPE_REQUIRED");
    }
    let entry = this.entries.get(scope.key);
    if (entry?.retiring) {
      await entry.retiring;
      return this.call(scope, tool, args);
    }
    if (!entry) {
      if (this.entries.size >= this.maxEntries) {
        throw new Error("BROWSER_USE_CAPACITY_BUSY: all retained browser scopes occupy the bounded registry");
      }
      entry = { key: scope.key, serial: Promise.resolve(), pending: 0, lastUsedAt: this.now() };
      this.entries.set(scope.key, entry);
      this.startTimer();
    }
    const owned = entry;
    owned.pending++;
    const run = owned.serial.then(async () => {
      if (scope.signal?.aborted) throw new Error("BROWSER_USE_REQUEST_ABORTED: queued browser call was cancelled before dispatch");
      await scope.beforeDispatch?.();
      if (scope.signal?.aborted) throw new Error("BROWSER_USE_REQUEST_ABORTED: queued browser call was cancelled before dispatch");
      let provision: BrowserUseProvisioning;
      try {
        provision = this.provisioning();
      } catch (error) {
        // Invalid provisioning revokes an existing namespace before propagating.
        const previous = owned.provider;
        owned.provider = undefined;
        owned.binding = undefined;
        owned.provisioning = undefined;
        if (previous) await previous.close();
        throw error;
      }
      if (owned.binding !== scope.binding || owned.provisioning !== provision.identity) {
        const previous = owned.provider;
        owned.provider = undefined;
        owned.binding = undefined;
        owned.provisioning = undefined;
        if (previous) await previous.close();
      }
      if (!owned.provider) {
        // The random generation prevents a later Goal/close/expiry from reopening
        // the profile, daemon files, or Python namespace of an old owner.
        const dataDirectory = path.join(provision.dataRoot, "sessions", scope.key, crypto.randomUUID());
        owned.provider = this.createProvider({ dataDirectory, idleTimeoutMs: 0 });
        owned.binding = scope.binding;
        owned.provisioning = provision.identity;
      }
      if (scope.signal?.aborted) throw new Error("BROWSER_USE_REQUEST_ABORTED: queued browser call was cancelled before dispatch");
      return owned.provider.call(tool, args, scope.signal, scope.beforeDispatch);
    });
    owned.serial = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      owned.pending--;
      owned.lastUsedAt = this.now();
    }
  }

  private retire(entry: Entry): Promise<void> {
    if (entry.retiring) return entry.retiring;
    entry.retiring = entry.serial.then(async () => {
      const provider = entry.provider;
      entry.provider = undefined;
      if (provider) await provider.close();
    }).finally(() => {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      this.stopEmptyTimer();
    });
    return entry.retiring;
  }

  async sweepExpired(): Promise<number> {
    const now = this.now();
    const expired = [...this.entries.values()].filter((entry) =>
      entry.pending === 0 && !entry.retiring && now - entry.lastUsedAt >= this.idleTimeoutMs);
    await Promise.all(expired.map((entry) => this.retire(entry)));
    return expired.length;
  }

  async close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (entry) await this.retire(entry);
  }

  async status(key: string): Promise<Record<string, unknown> | undefined> {
    const entry = this.entries.get(key);
    if (!entry || entry.retiring) return undefined;
    await entry.serial;
    return entry.provider?.status();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    await Promise.all([...this.entries.values()].map((entry) => this.retire(entry)));
  }
}

const registry = new BrowserUseRegistry();
const serverScopes = new WeakMap<McpServer, Set<string>>();

export function attachBrowserUseProvider(server: McpServer): void {
  serverScopes.set(server, new Set());
}

export function callBrowserUseProvider(
  server: McpServer,
  tool: BrowserTool,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const scope = currentProviderScope();
  const scopes = serverScopes.get(server) ?? new Set<string>();
  scopes.add(scope.key);
  serverScopes.set(server, scopes);
  return registry.call(scope, tool, args);
}

/** Transport expiry/DELETE detaches its handle; scoped idle ownership does cleanup. */
export async function disposeBrowserUseProvider(server: McpServer): Promise<void> {
  serverScopes.delete(server);
}

export async function browserUseProviderStatusForTests(server: McpServer): Promise<Record<string, unknown> | undefined> {
  const key = [...(serverScopes.get(server) ?? [])].at(-1);
  return key ? registry.status(key) : undefined;
}
