import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface LspServerSpec {
  id: string;
  extensions: string[];
  command: string;
  args?: string[];
  language_id?: string;
  cwd?: string;
  initialization_options?: unknown;
  enabled?: boolean;
  timeout_ms?: number;
}

export interface LspServerConfig {
  version: 1;
  servers: LspServerSpec[];
}

export interface LspLocation {
  file: string;
  line: number;
  character: number;
  end_line: number;
  end_character: number;
}

export interface LspQueryResult {
  backend: "lsp";
  server_id: string;
  capabilities: Record<string, unknown>;
  action: "definition" | "references" | "implementations" | "diagnostics";
  file: string;
  query?: string;
  locations?: LspLocation[];
  diagnostics?: Array<Record<string, unknown>>;
  symbol_position?: { line: number; character: number };
  content_modified_retries: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abortCleanup?: () => void;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
  method?: string;
  params?: any;
}

const CONTENT_MODIFIED = -32801;
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_CONTENT_MODIFIED_RETRIES = 3;

export function lspConfigLocation(root: string): { path: string; source: "env" | "project" | "user"; project_config_allowed: boolean } {
  const explicit = process.env.WEB_HARNESS_LSP_CONFIG?.trim();
  if (explicit) {
    return { path: path.resolve(explicit), source: "env", project_config_allowed: false };
  }

  const projectConfigAllowed = (process.env.WEB_HARNESS_LSP_ALLOW_PROJECT_CONFIG || "false").trim().toLowerCase() === "true";
  if (projectConfigAllowed) {
    return { path: path.join(path.resolve(root), "profiles", "lsp-servers.json"), source: "project", project_config_allowed: true };
  }

  // LSP configuration contains executable commands. Never trust a repository
  // checkout as executable configuration by default: use the user/runtime
  // configuration area unless project config is explicitly opted in.
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return { path: path.join(path.resolve(home), "lsp-servers.json"), source: "user", project_config_allowed: false };
}

export async function loadLspConfig(root: string): Promise<LspServerConfig> {
  const envJson = process.env.WEB_HARNESS_LSP_SERVERS?.trim();
  if (envJson) {
    const parsed = JSON.parse(envJson) as LspServerConfig;
    return normalizeConfig(parsed);
  }
  try {
    const parsed = JSON.parse(await fs.readFile(lspConfigLocation(root).path, "utf8")) as LspServerConfig;
    return normalizeConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, servers: [] };
    throw error;
  }
}

function normalizeConfig(config: LspServerConfig): LspServerConfig {
  if (config?.version !== 1 || !Array.isArray(config.servers)) throw new Error("Invalid LSP server config: expected version=1 and servers[]");
  return {
    version: 1,
    servers: config.servers.map((server) => ({
      ...server,
      id: String(server.id || "").trim(),
      command: String(server.command || "").trim(),
      extensions: Array.isArray(server.extensions) ? server.extensions.map((ext) => ext.toLowerCase().startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`) : [],
      args: Array.isArray(server.args) ? server.args.map(String) : [],
    })).filter((server) => server.id && server.command && server.extensions.length && server.enabled !== false),
  };
}

export async function lspSpecForFile(root: string, file: string): Promise<LspServerSpec | null> {
  const ext = path.extname(file).toLowerCase();
  const config = await loadLspConfig(root);
  return config.servers.find((server) => server.extensions.includes(ext)) ?? null;
}

class LspClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = Buffer.alloc(0);
  private capabilities: Record<string, unknown> = {};
  private publishedDiagnostics = new Map<string, unknown[]>();
  private retryCount = 0;

  constructor(private readonly spec: LspServerSpec, private readonly root: string) {}

  get metadata() {
    return { server_id: this.spec.id, capabilities: this.capabilities, content_modified_retries: this.retryCount };
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.child) return;
    if (signal?.aborted) throw new Error("LSP request aborted before server start");
    const cwd = this.spec.cwd ? path.resolve(this.root, this.spec.cwd) : this.root;
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", () => {});
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, childSignal) => this.failAll(new Error(`LSP server exited code=${code} signal=${childSignal ?? "none"}`)));

    const initialize = await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "chatgpt-web-harness", version: "0.2.7" },
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }],
      initializationOptions: this.spec.initialization_options,
      capabilities: {
        textDocument: {
          documentSymbol: {},
          definition: {},
          references: {},
          implementation: {},
          publishDiagnostics: {},
          diagnostic: {},
        },
        workspace: { workspaceFolders: true },
      },
    }, signal, false) as any;
    this.capabilities = initialize?.capabilities && typeof initialize.capabilities === "object" ? initialize.capabilities : {};
    this.notify("initialized", {});
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    try { await this.request("shutdown", null, undefined, false, 1500); } catch {}
    try { this.notify("exit", null); } catch {}
    this.child = null;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {}; resolve(); }, 500);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    }
  }

  async openDocument(file: string): Promise<string> {
    const text = await fs.readFile(file, "utf8");
    const uri = pathToFileURL(path.resolve(file)).href;
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.spec.language_id || path.extname(file).slice(1).toLowerCase() || "plaintext",
        version: 1,
        text,
      },
    });
    return text;
  }

  async request(method: string, params: unknown, signal?: AbortSignal, retryContentModified = true, timeoutOverride?: number): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.requestOnce(method, params, signal, timeoutOverride);
      } catch (error) {
        const code = (error as any)?.code;
        if (!retryContentModified || code !== CONTENT_MODIFIED || attempt >= MAX_CONTENT_MODIFIED_RETRIES) throw error;
        attempt += 1;
        this.retryCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
      }
    }
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  diagnosticsFor(uri: string): unknown[] {
    return this.publishedDiagnostics.get(uri) ?? [];
  }

  private requestOnce(method: string, params: unknown, signal?: AbortSignal, timeoutOverride?: number): Promise<unknown> {
    if (!this.child) return Promise.reject(new Error("LSP server is not running"));
    if (signal?.aborted) return Promise.reject(new Error("LSP request aborted"));
    const id = this.nextId++;
    const timeoutMs = Math.max(250, Math.min(timeoutOverride ?? this.spec.timeout_ms ?? DEFAULT_TIMEOUT_MS, 60_000));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.notify("$/cancelRequest", { id }); } catch {}
        const error = new Error(`LSP request timeout: ${method}`);
        (error as any).code = "LSP_TIMEOUT";
        reject(error);
      }, timeoutMs);
      let abortCleanup: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          clearTimeout(timer);
          try { this.notify("$/cancelRequest", { id }); } catch {}
          reject(new Error(`LSP request aborted: ${method}`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pending.set(id, { resolve, reject, timer, abortCleanup });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  private writeMessage(message: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("LSP stdin is not writable");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      try { this.handleMessage(JSON.parse(body.toString("utf8")) as JsonRpcResponse); } catch {}
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      if (message.error) {
        const error = new Error(message.error.message || `LSP error ${message.error.code}`);
        (error as any).code = message.error.code;
        (error as any).data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const uri = message.params?.uri;
      if (typeof uri === "string") this.publishedDiagnostics.set(uri, Array.isArray(message.params?.diagnostics) ? message.params.diagnostics : []);
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      pending.reject(error);
    }
  }
}

function flattenSymbols(value: any, out: any[] = []): any[] {
  if (!Array.isArray(value)) return out;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    out.push(item);
    if (Array.isArray(item.children)) flattenSymbols(item.children, out);
  }
  return out;
}

function symbolPosition(symbol: any): { line: number; character: number } | null {
  const pos = symbol?.selectionRange?.start ?? symbol?.range?.start ?? symbol?.location?.range?.start;
  return Number.isInteger(pos?.line) && Number.isInteger(pos?.character) ? { line: pos.line, character: pos.character } : null;
}

function textFallbackPosition(text: string, query: string): { line: number; character: number } | null {
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\b${escaped}\\b`).exec(text);
  if (!match) return null;
  const prefix = text.slice(0, match.index);
  const lines = prefix.split(/\r?\n/);
  return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function locationFrom(value: any): LspLocation | null {
  const uri = value?.uri ?? value?.targetUri;
  const range = value?.range ?? value?.targetSelectionRange ?? value?.targetRange;
  if (typeof uri !== "string" || !range?.start || !range?.end) return null;
  let file: string;
  try { file = uri.startsWith("file:") ? fileURLToPath(uri) : uri; } catch { file = uri; }
  return {
    file: path.resolve(file),
    line: Number(range.start.line) + 1,
    character: Number(range.start.character) + 1,
    end_line: Number(range.end.line) + 1,
    end_character: Number(range.end.character) + 1,
  };
}

function normalizeLocations(value: unknown, maxResults: number): LspLocation[] {
  const array = Array.isArray(value) ? value : value ? [value] : [];
  return array.map(locationFrom).filter((item): item is LspLocation => Boolean(item)).slice(0, maxResults);
}

export async function queryConfiguredLsp(options: {
  root: string;
  file: string;
  action: "definition" | "references" | "implementations" | "diagnostics";
  query?: string;
  maxResults?: number;
  signal?: AbortSignal;
}): Promise<LspQueryResult | null> {
  const file = path.resolve(options.file);
  const root = path.resolve(options.root);
  const spec = await lspSpecForFile(root, file);
  if (!spec) return null;
  const client = new LspClient(spec, root);
  const maxResults = Math.max(1, Math.min(options.maxResults ?? 100, 500));
  try {
    await client.start(options.signal);
    const text = await client.openDocument(file);
    const uri = pathToFileURL(file).href;
    if (options.action === "diagnostics") {
      let diagnostics: unknown[] = [];
      const caps = client.metadata.capabilities as any;
      if (caps?.diagnosticProvider) {
        try {
          const result = await client.request("textDocument/diagnostic", { textDocument: { uri } }, options.signal);
          diagnostics = Array.isArray((result as any)?.items) ? (result as any).items : [];
        } catch {
          diagnostics = client.diagnosticsFor(uri);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 75));
        diagnostics = client.diagnosticsFor(uri);
      }
      return { backend: "lsp", ...client.metadata, action: options.action, file, diagnostics: diagnostics.slice(0, maxResults) as Array<Record<string, unknown>> };
    }

    if (!options.query) throw new Error(`LSP ${options.action} requires query`);
    let position: { line: number; character: number } | null = null;
    try {
      const symbols = flattenSymbols(await client.request("textDocument/documentSymbol", { textDocument: { uri } }, options.signal));
      const exact = symbols.filter((symbol) => symbol?.name === options.query);
      if (exact.length === 1) position = symbolPosition(exact[0]);
      else if (exact.length > 1) throw new Error(`LSP_SYMBOL_AMBIGUOUS: ${options.query} has ${exact.length} document symbols`);
    } catch (error) {
      if (String((error as Error).message).startsWith("LSP_SYMBOL_AMBIGUOUS")) throw error;
    }
    position ??= textFallbackPosition(text, options.query);
    if (!position) throw new Error(`LSP_SYMBOL_NOT_FOUND: ${options.query}`);

    const params = options.action === "references"
      ? { textDocument: { uri }, position, context: { includeDeclaration: true } }
      : { textDocument: { uri }, position };
    const method = options.action === "definition" ? "textDocument/definition"
      : options.action === "references" ? "textDocument/references"
        : "textDocument/implementation";
    const result = await client.request(method, params, options.signal);
    return {
      backend: "lsp",
      ...client.metadata,
      action: options.action,
      file,
      query: options.query,
      symbol_position: { line: position.line + 1, character: position.character + 1 },
      locations: normalizeLocations(result, maxResults),
    };
  } finally {
    await client.stop();
  }
}

export async function probeConfiguredLsp(root: string, file: string, signal?: AbortSignal) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  const spec = await lspSpecForFile(resolvedRoot, resolvedFile);
  if (!spec) return null;
  const client = new LspClient(spec, resolvedRoot);
  try {
    await client.start(signal);
    return { backend: "lsp", configured: true, ...client.metadata, extensions: spec.extensions, command: spec.command };
  } finally { await client.stop(); }
}
