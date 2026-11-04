import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OwnedChromeProcess } from "./browser-use-chrome.js";

const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 90_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;
const ownedProcessRoots = new Map<number, (() => number | undefined) | undefined>();
let exitCleanupInstalled = false;

interface RuntimeProvenance {
  schema_version: number;
  browser_use: { version: string; commit: string };
  browser_harness: { version: string; commit: string };
  python: { version: string };
  chrome_for_testing: { version: string };
  critical_files: Record<string, string>;
  telemetry_default: string;
}

interface Connection {
  client: Client;
  transport: StdioClientTransport;
  chrome: ChildProcess;
  chromeOwner?: OwnedChromeProcess;
  chromePid: number;
  cdpPort: number;
  provenance: RuntimeProvenance;
  daemonStarted: boolean;
  broken?: boolean;
}

export interface BrowserUseProviderOptions {
  /** Registry-owned private generation directory; direct callers keep the legacy default. */
  dataDirectory?: string;
  /** Zero delegates idle lifetime to the scoped registry. */
  idleTimeoutMs?: number;
}

export interface BrowserUseProvisioning {
  readonly dataRoot: string;
  readonly identity: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Browser Use provider is not provisioned: ${name} is missing`);
  return value;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function pathInside(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Chromium's Windows storage APIs still need headroom below MAX_PATH.
 * The full digest binds the provisioned account + scope + generation. Existing
 * long-path profiles are never moved, copied, deleted, or implicitly adopted.
 */
export function browserUsePhysicalDataDirectory(logicalDirectory: string): string {
  const logical = path.resolve(logicalDirectory);
  if (process.platform !== "win32" || path.join(logical, "profile").length <= 150) return logical;
  const local = path.resolve(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"));
  const root = path.join(local, "wbh-bu");
  const identity = crypto.createHash("sha256").update(JSON.stringify(["browser-use-physical-v1", logical.toLowerCase()])).digest("hex");
  const physical = path.join(root, identity);
  if (path.join(physical, "profile").length > 150) throw new Error("Browser Use needs a shorter per-user LOCALAPPDATA path");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Browser Use short-path root must not be a reparse link");
  const marker = path.join(physical, "owner.json");
  const expected = JSON.stringify({ schema_version: 1, logical_generation_sha256: identity });
  let created = false;
  try { fs.mkdirSync(physical, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!fs.lstatSync(physical).isDirectory() || fs.lstatSync(physical).isSymbolicLink()) throw new Error("Browser Use short-path generation is not an owned directory");
  if (created) fs.writeFileSync(marker, expected, { flag: "wx", encoding: "utf8", mode: 0o600 });
  else if (!fs.existsSync(marker) || fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, "utf8") !== expected) {
    throw new Error("Browser Use short-path ownership mismatch; existing data was not adopted");
  }
  return physical;
}

function runtimePaths() {
  const root = path.resolve(requiredEnv("HARNESS_BROWSER_USE_RUNTIME_ROOT"));
  const python = path.join(root, "python", "python.exe");
  const sitePackages = path.join(root, "site-packages");
  const chrome = path.join(root, "chrome", "chrome-win64", "chrome.exe");
  const provenance = path.join(root, "provenance.json");
  const lock = path.resolve(requiredEnv("HARNESS_BROWSER_USE_RUNTIME_LOCK"));
  for (const file of [python, chrome, provenance]) {
    if (!pathInside(root, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`Bundled Browser Use runtime is incomplete: ${file}`);
    }
  }
  if (!fs.existsSync(sitePackages) || !fs.statSync(sitePackages).isDirectory()) {
    throw new Error(`Bundled Browser Use site-packages are missing: ${sitePackages}`);
  }
  const expectedLock = path.join(path.resolve(root, "..", ".."), "bundled-plugins", "browser-use", "runtime-lock.json");
  const bundledLock = fileURLToPath(new URL("../../bundled-plugins/browser-use/runtime-lock.json", import.meta.url));
  if (![expectedLock, bundledLock].some(candidate => path.resolve(lock) === path.resolve(candidate)) || !fs.existsSync(lock) || !fs.statSync(lock).isFile()) {
    throw new Error(`Bundled Browser Use runtime lock is missing or outside the packaged layout: ${lock}`);
  }
  return { root, python, sitePackages, chrome, provenance, lock };
}

function verifyRuntime(paths: ReturnType<typeof runtimePaths>): RuntimeProvenance {
  const provenance = JSON.parse(fs.readFileSync(paths.provenance, "utf8")) as RuntimeProvenance;
  const provenanceRecord = provenance as unknown as Record<string, unknown>;
  const lockText = fs.readFileSync(paths.lock, "utf8");
  const expectedLockHash = requiredEnv("HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedLockHash) || crypto.createHash("sha256").update(lockText).digest("hex") !== expectedLockHash) {
    throw new Error("Bundled Browser Use runtime lock integrity check failed");
  }
  const lock = JSON.parse(lockText) as Record<string, unknown>;
  if (provenance.schema_version !== 1 || provenance.browser_use?.version !== "0.13.10" || provenance.browser_harness?.version !== "0.1.13") {
    throw new Error("Bundled Browser Use provenance has an unsupported version");
  }
  if (provenance.telemetry_default !== "disabled") throw new Error("Bundled Browser Use runtime does not declare telemetry disabled");
  for (const key of ["schema_version", "browser_use", "browser_harness", "python", "chrome_for_testing", "wheels"]) {
    if (JSON.stringify(provenanceRecord[key]) !== JSON.stringify(lock[key])) {
      throw new Error(`Bundled Browser Use provenance differs from runtime lock: ${key}`);
    }
  }
  for (const [relative, expected] of Object.entries(provenance.critical_files ?? {})) {
    const file = path.resolve(paths.root, relative);
    if (!pathInside(paths.root, file) || !fs.existsSync(file) || sha256File(file) !== expected.toLowerCase()) {
      throw new Error(`Bundled Browser Use integrity check failed: ${relative}`);
    }
  }
  return provenance;
}

/** Validate the pinned runtime before using a retained browser capability. */
export function browserUseProvisioning(): BrowserUseProvisioning {
  const paths = runtimePaths();
  verifyRuntime(paths);
  const dataRoot = path.resolve(requiredEnv("HARNESS_BROWSER_USE_DATA_DIR"));
  const identity = crypto.createHash("sha256").update(JSON.stringify([
    "browser-use-provisioning-v1",
    process.env.HARNESS_ACCOUNT_ID?.trim() || "",
    paths.root, paths.lock,
    requiredEnv("HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256").toLowerCase(),
    dataRoot, process.env.HARNESS_BROWSER_USE_HEADLESS?.trim() || "",
  ])).digest("hex");
  return { dataRoot, identity };
}

async function freeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function killOwnedTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const root = process.env.SystemRoot || "C:\\Windows";
    const taskkill = path.win32.join(root, "System32", "taskkill.exe");
    spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 8000, stdio: "ignore" });
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function trackOwnedProcess(pid: number, confirm?: () => number | undefined): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  ownedProcessRoots.set(pid, confirm);
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  // Browser Harness deliberately detaches its daemon from terminal signals.
  // Retain the exact process ancestry roots so a sudden MCP exit still tears
  // down only the Chrome/Python trees created by this process.
  process.once("exit", () => {
    for (const [ownedPid, confirm] of [...ownedProcessRoots]) {
      try { const confirmed = confirm ? confirm() : ownedPid; if (confirmed) killOwnedTree(confirmed); } catch { /* Unknown identity never authorizes termination. */ }
    }
  });
}

/** Probe only the owned loopback port, with no redirects, proxy, or unbounded body. */
export async function probeOwnedChromeCdp(port: number, timeoutMs = 1500): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid owned Chrome CDP port");
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const request = http.get({ hostname: "127.0.0.1", port, path: "/json/version", agent: false }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", (error) => finish(error));
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 32768) { request.destroy(new Error("CDP version response exceeds 32 KiB")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          if (response.statusCode !== 200) throw new Error(`CDP HTTP ${response.statusCode}`);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (typeof body.webSocketDebuggerUrl !== "string") throw new Error("CDP browser websocket is missing");
          const endpoint = new URL(body.webSocketDebuggerUrl);
          if (endpoint.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
            || Number(endpoint.port) !== port || !endpoint.pathname.startsWith("/devtools/browser/")
            || endpoint.username || endpoint.password) throw new Error("CDP endpoint does not identify the owned loopback browser");
          finish();
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("CDP loopback probe deadline exceeded")), Math.max(50, Math.min(5000, timeoutMs)));
    request.on("error", (error) => finish(error));
  });
}

async function waitForCdp(port: number, owner: OwnedChromeProcess): Promise<void> {
  const deadline = Date.now() + 25_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    const chrome = owner.launcher;
    const alive = await owner.refresh();
    if (!alive && (chrome.signalCode !== null || (chrome.exitCode !== null && chrome.exitCode !== 0))) {
      throw new Error(`Bundled Chrome exited before CDP became ready (${chrome.exitCode ?? chrome.signalCode})`);
    }
    try {
      if (!alive) throw new Error("Waiting for the owned Chrome replacement process");
      await probeOwnedChromeCdp(port);
      if (!(await owner.ownsListener())) throw new Error("CDP listener does not belong to this Chrome launch");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Bundled Chrome CDP did not become ready: ${lastError}`);
}

function cleanEnvironment(paths: ReturnType<typeof runtimePaths>, dataDir: string, cdpPort: number): Record<string, string> {
  const keep = ["SystemRoot", "WINDIR", "TEMP", "TMP", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"];
  const env: Record<string, string> = {};
  for (const key of keep) if (process.env[key]) env[key] = process.env[key]!;
  env.PATH = [path.dirname(paths.python), path.join(env.SystemRoot || "C:\\Windows", "System32")].join(";");
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONUTF8 = "1";
  env.PYTHONPATH = paths.sitePackages;
  env.BU_CDP_URL = `http://127.0.0.1:${cdpPort}`;
  env.BU_AUTOSPAWN = "0";
  env.BU_NAME = "harness";
  env.BH_CLIENT = "chatgpt-web-harness";
  env.BH_CLIENT_VERSION = "1.0.0";
  env.BH_HOME = path.join(dataDir, "home");
  env.BH_RUNTIME_DIR = path.join(dataDir, "runtime");
  env.BH_TMP_DIR = path.join(dataDir, "tmp");
  env.BH_AGENT_WORKSPACE = path.join(dataDir, "agent-workspace");
  env.BH_CHROME_PATH = paths.chrome;
  env.BH_TELEMETRY = "0";
  env.BROWSER_HARNESS_TELEMETRY = "0";
  env.ANONYMIZED_TELEMETRY = "false";
  env.BROWSER_USE_CLOUD_SYNC = "false";
  env.BH_UPDATE_CHECK = "0";
  env.BH_DOMAIN_SKILLS = "0";
  env.BH_OPEN_LIVE_URL = "0";
  env.BH_RECORD = "0";
  env.BH_TAB_MARKER = "0";
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = env.NO_PROXY;
  return env;
}

function audit(tool: string, input: Record<string, unknown>, status: "ok" | "error", error?: string): void {
  const file = process.env.HARNESS_BROWSER_USE_AUDIT_LOG?.trim();
  if (!file) return;
  const safeInput = tool === "browser_use_exec" && typeof input.code === "string"
    ? { code: { redacted: true, chars: input.code.length, sha256: crypto.createHash("sha256").update(input.code).digest("hex") } }
    : input;
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.appendFileSync(path.resolve(file), `${JSON.stringify({
      at: new Date().toISOString(), provider: "browser-use", tool, input: safeInput, status,
      ...(error ? { error: error.slice(0, 500) } : {}),
    })}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}

export class BrowserUseProvider {
  private connection: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private revoked = false;
  private provisioningIdentity: string | undefined;

  constructor(private readonly options: BrowserUseProviderOptions = {}) {}

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const timeout = this.options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    if (timeout <= 0 || this.closed) { this.idleTimer = null; return; }
    this.idleTimer = setTimeout(() => { void this.close().catch(() => undefined); }, timeout);
    this.idleTimer.unref?.();
  }

  /** Protected seams let deterministic lifecycle tests avoid any real process/UI. */
  protected readProvisioningIdentity(): string {
    return browserUseProvisioning().identity;
  }

  private async assertProvisioning(): Promise<void> {
    let identity: string;
    try {
      identity = this.readProvisioningIdentity();
    } catch (error) {
      this.revoked = true;
      this.closed = true;
      await this.releaseConnection();
      this.provisioningIdentity = undefined;
      throw error;
    }
    if (this.provisioningIdentity && this.provisioningIdentity !== identity) {
      this.revoked = true;
      this.closed = true;
      await this.releaseConnection();
      this.provisioningIdentity = undefined;
      throw new Error("BROWSER_USE_PROVISIONING_CHANGED: open a fresh scoped browser provider");
    }
    this.provisioningIdentity = identity;
  }

  protected async createConnection(): Promise<Connection> {
    if (process.platform !== "win32") throw new Error("The bundled Browser Use runtime currently supports Windows x64 only");
    const paths = runtimePaths();
    const provenance = verifyRuntime(paths);
    const dataRoot = path.resolve(requiredEnv("HARNESS_BROWSER_USE_DATA_DIR"));
    const logicalDataDir = this.options.dataDirectory ? path.resolve(this.options.dataDirectory) : dataRoot;
    if (!pathInside(dataRoot, logicalDataDir)) throw new Error("Browser Use generation directory is outside its provisioned data root");
    const dataDir = browserUsePhysicalDataDirectory(logicalDataDir);
    for (const leaf of ["profile", "home", "runtime", "tmp", "agent-workspace"]) {
      fs.mkdirSync(path.join(dataDir, leaf), { recursive: true, mode: 0o700 });
    }
    const cdpPort = await freeLoopbackPort();
    const chromeArgs = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${path.join(dataDir, "profile")}`,
      "--remote-allow-origins=http://127.0.0.1",
      "--no-first-run", "--no-default-browser-check", "--disable-default-apps",
      "--disable-component-update", "--disable-sync", "--metrics-recording-only",
      "--disable-background-mode", "--disable-features=OptimizationHints,MediaRouter",
      "about:blank",
    ];
    if (/^(?:1|true|yes)$/i.test(process.env.HARNESS_BROWSER_USE_HEADLESS || "")) {
      chromeArgs.unshift("--headless=new", "--disable-gpu", "--hide-scrollbars");
    }
    const startedAtMs = Date.now();
    const chrome = spawn(paths.chrome, chromeArgs, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const startupAt = new Date(startedAtMs).toISOString();
    let startupStderr = "";
    let startupPending = true;
    const captureStartup = (chunk: Buffer) => {
      if (startupPending) startupStderr = (startupStderr + chunk.toString("utf8")).slice(-8192);
    };
    chrome.stderr?.on("data", captureStartup);
    chrome.on("error", (error) => {
      if (startupPending) startupStderr = (startupStderr + "\n" + error.message).slice(-8192);
    });
    if (!chrome.pid) throw new Error("Failed to start bundled Chrome for Testing");
    const chromeOwner = new OwnedChromeProcess(chrome, {
      launcher_pid: chrome.pid, executable: paths.chrome, profile: path.join(dataDir, "profile"),
      port: cdpPort, started_at_ms: startedAtMs,
    }, trackOwnedProcess, pid => { ownedProcessRoots.delete(pid); }, killOwnedTree);
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    try {
      await waitForCdp(cdpPort, chromeOwner);
      startupPending = false;
      startupStderr = ""; // Do not retain later page/network diagnostics or browsing data.
      audit("browser_use_lifecycle", { event: "cdp_ready", pid: chromeOwner.pid, launcher_pid: chrome.pid, port: cdpPort, generation: path.basename(dataDir) }, "ok");
      transport = new StdioClientTransport({
        command: paths.python,
        args: ["-m", "browser_use.cli", "--cli-mcp"],
        env: cleanEnvironment(paths, dataDir, cdpPort),
        cwd: paths.root,
        stderr: "pipe",
        maxBufferSize: 16 * 1024 * 1024,
      });
      const stderr: string[] = [];
      transport.stderr?.on("data", (chunk) => {
        stderr.push(String(chunk));
        if (stderr.join("").length > 32_768) stderr.shift();
      });
      client = new Client({ name: "chatgpt-web-harness-browser-use", version: "1.0.0" });
      const connect = client.connect(transport);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        connect,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser Use MCP connect timed out: ${stderr.join("").slice(-2000)}`)), CONNECT_TIMEOUT_MS); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      const mcpPid = transport.pid;
      if (mcpPid) trackOwnedProcess(mcpPid);
      const listed = await client.listTools(undefined, { timeout: 20_000 });
      const names = new Set((listed.tools ?? []).map((tool) => tool.name));
      if (!names.has("browser_exec") || !names.has("browser_screenshot")) {
        await client.close().catch(() => undefined);
        throw new Error(`Bundled Browser Use MCP exposed an unexpected catalog: ${[...names].join(", ")}`);
      }
      if (!(await chromeOwner.refresh())) throw new Error("Owned Chrome exited during Browser Use MCP setup");
      const connection: Connection = { client, transport, chrome, chromeOwner, chromePid: chromeOwner.pid, cdpPort, provenance, daemonStarted: false };
      const previousOnClose = transport.onclose;
      transport.onclose = () => {
        previousOnClose?.();
        if (mcpPid) ownedProcessRoots.delete(mcpPid);
        connection.broken = true;
        audit("browser_use_lifecycle", { event: "upstream_closed", pid: mcpPid, generation: path.basename(dataDir) }, "ok");
      };
      chrome.once("exit", () => {
        if (chromeOwner.relaunched || chrome.exitCode !== 0 || chrome.signalCode !== null) ownedProcessRoots.delete(chrome.pid!);
        if (!chromeOwner.relaunched && (chrome.exitCode !== 0 || chrome.signalCode !== null)) connection.broken = true;
        audit("browser_use_lifecycle", { event: "chrome_launcher_exited", pid: chrome.pid, exit_code: chrome.exitCode, signal: chrome.signalCode, generation: path.basename(dataDir) }, "ok");
      });
      return connection;
    } catch (error) {
      let diagnosticPath: string | undefined;
      if (startupPending) {
        diagnosticPath = path.join(dataDir, `chrome-startup-${crypto.randomUUID()}.json`);
        try {
          fs.writeFileSync(diagnosticPath, JSON.stringify({
            schema_version: 1, started_at: startupAt, failed_at: new Date().toISOString(),
            chrome_pid: chromeOwner.pid, launcher_pid: chrome.pid, port: cdpPort, profile_path_chars: path.join(dataDir, "profile").length,
            exit_code: chrome.exitCode, signal: chrome.signalCode, stderr: startupStderr,
            error: error instanceof Error ? error.message : String(error),
            browser_exec_dispatched: false,
          }, null, 2), { encoding: "utf8", flag: "wx", mode: 0o600 });
        } catch { diagnosticPath = undefined; }
      }
      startupPending = false;
      const mcpPid = transport?.pid;
      if (mcpPid) {
        killOwnedTree(mcpPid);
        ownedProcessRoots.delete(mcpPid);
      }
      await client?.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      try { await chromeOwner.close(); }
      catch (cleanupError) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; owned Chrome cleanup not confirmed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}${diagnosticPath ? "; startup diagnostic: " + diagnosticPath : ""}`);
      }
      if (diagnosticPath) throw new Error(`${error instanceof Error ? error.message : String(error)}; startup diagnostic: ${diagnosticPath}`);
      throw error;
    }
  }

  private async connect(): Promise<Connection> {
    if (this.connection && !this.connection.broken && (this.connection.chromeOwner
      ? await this.connection.chromeOwner.refresh()
      : this.connection.chrome.exitCode === null && this.connection.chrome.signalCode === null)) {
      if (this.connection.chromeOwner) this.connection.chromePid = this.connection.chromeOwner.pid;
      this.touch();
      return this.connection;
    }
    if (this.connecting) return this.connecting;
    await this.releaseConnection();
    this.connecting = this.createConnection().then((connection) => {
      this.connection = connection;
      this.touch();
      return connection;
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation);
    this.serial = next.catch(() => undefined);
    return next;
  }

  async call(tool: "browser_exec" | "browser_screenshot", args: Record<string, unknown>, signal?: AbortSignal, beforeDispatch?: () => Promise<void>): Promise<CallToolResult> {
    if (this.closed) throw new Error("BROWSER_USE_PROVIDER_CLOSED: use a fresh scoped browser provider");
    const assertNotCancelled = () => {
      if (signal?.aborted) throw new Error("BROWSER_USE_REQUEST_ABORTED: browser call was cancelled before upstream dispatch");
    };
    return this.enqueue(async () => {
      const publicTool = tool === "browser_exec" ? "browser_use_exec" : "browser_use_screenshot";
      try {
        assertNotCancelled();
        await beforeDispatch?.();
        assertNotCancelled();
        if (this.revoked) throw new Error("BROWSER_USE_PROVIDER_REVOKED: queued calls cannot reopen the old namespace");
        await this.assertProvisioning();
        const connection = await this.connect();
        let dispatched = false;
        const invoke = async () => {
          // Connection setup can be slow. Cancellation before this boundary
          // prevents dispatch; a mutation already sent is never replayed.
          dispatched = false;
          assertNotCancelled();
          await beforeDispatch?.();
          assertNotCancelled();
          connection.daemonStarted = true;
          dispatched = true;
          return connection.client.callTool(
            { name: tool, arguments: args },
            undefined,
            { timeout: CALL_TIMEOUT_MS }
          ) as Promise<CallToolResult>;
        };
        let result: CallToolResult;
        try {
          result = await invoke();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!dispatched || tool !== "browser_screenshot" || !/timeout|timed out|temporar|connection reset|closed/i.test(message)) throw error;
          // Screenshot has no browser-side effect. One same-session replay is
          // safe; browser_exec is never replayed because it may have mutated a
          // page or external system before its response was lost.
          await new Promise((resolve) => setTimeout(resolve, 300));
          result = await invoke();
        }
        this.touch();
        audit(publicTool, args, result.isError ? "error" : "ok", result.isError ? "upstream tool returned isError" : undefined);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        audit(publicTool, args, "error", message);
        throw error;
      }
    });
  }

  async status(): Promise<Record<string, unknown>> {
    return this.enqueue(async () => {
      // A cold health check can be repaired without inheriting any browser state.
      // Once connected, a health failure must revoke the retained capability.
      if (this.connection) await this.assertProvisioning();
      const paths = runtimePaths();
      const provenance = verifyRuntime(paths);
      const browserAlive = Boolean(this.connection && !this.connection.broken && (this.connection.chromeOwner
        ? await this.connection.chromeOwner.refresh() && await this.connection.chromeOwner.ownsListener()
        : this.connection.chrome.exitCode === null && this.connection.chrome.signalCode === null));
      if (this.connection?.chromeOwner) this.connection.chromePid = this.connection.chromeOwner.pid;
      return {
        provider: "browser-use-official",
        connected: browserAlive,
        browser_use_version: provenance.browser_use.version,
        browser_harness_version: provenance.browser_harness.version,
        python_version: provenance.python.version,
        chrome_version: provenance.chrome_for_testing.version,
        telemetry: "disabled",
        ...(this.connection ? {
          owned_chrome_pid: this.connection.chromePid,
          owned_mcp_pid: this.connection.transport.pid,
          cdp_port: this.connection.cdpPort,
        } : {}),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    // Queue behind every call accepted before close, including connection setup.
    // New calls are fenced synchronously above; no late connection can escape.
    this.closing = this.enqueue(async () => {
      await this.releaseConnection();
      this.provisioningIdentity = undefined;
    });
    return this.closing;
  }

  private async releaseConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection) await this.disposeConnection(connection);
  }

  protected async disposeConnection(connection: Connection): Promise<void> {
    if (connection.daemonStarted && !connection.broken) {
      try {
        await connection.client.callTool(
          { name: "browser_exec", arguments: { code: "restart_daemon()" } },
          undefined,
          { timeout: 8000 }
        );
      } catch {}
    }
    const mcpPid = connection.transport.pid;
    if (mcpPid && ownedProcessRoots.has(mcpPid)) {
      // Keep the Python parent alive until the official daemon stop returns,
      // then kill its exact tree before SDK close can orphan a detached daemon.
      killOwnedTree(mcpPid);
      ownedProcessRoots.delete(mcpPid);
    }
    try { await connection.client.close(); } catch { try { await connection.transport.close(); } catch {} }
    if (connection.chromeOwner) await connection.chromeOwner.close();
    else if (ownedProcessRoots.has(connection.chromePid) && connection.chrome.exitCode === null && connection.chrome.signalCode === null) {
      killOwnedTree(connection.chromePid);
    }
    ownedProcessRoots.delete(connection.chromePid);
  }
}
