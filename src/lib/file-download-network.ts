import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Agent, request } from "node:https";
import { Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const run = promisify(execFile);
export interface FileProxySettings { enabled: boolean; server: string; bypass: string; pac: string }
export interface FileProxyRoute { mode: "direct" | "proxy"; source: string; url?: string }

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return String(env[name.toLowerCase()] ?? env[name] ?? "").trim();
}
export function validateFileProxy(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password ||
      url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("FILE_PROXY_INVALID: file downloads require an authorized HTTP/HTTPS proxy without embedded credentials or URL paths");
  }
  return url.href.replace(/\/$/, "");
}
export function fileProxyBypass(hostname: string, port: string, value: string): boolean {
  return value.split(/[;,\s]+/).filter(Boolean).some((entry) => {
    if (entry === "*") return true;
    let token = entry.toLowerCase();
    if (token === "<local>") return !hostname.includes(".");
    const match = /^([^:]+):(\d+)$/.exec(token);
    if (match) { if (match[2] !== port) return false; token = match[1]; }
    token = token.replace(/^\*?\./, "");
    return hostname === token || hostname.endsWith("." + token);
  });
}
export function parseWindowsFileProxy(settings: FileProxySettings, url: URL, pacProxy?: string): FileProxyRoute {
  // A PAC script is not evaluated here, and refusing outright failed every
  // download for anyone whose proxy tool publishes one (Clash, v2rayN in PAC
  // mode). Those PACs send foreign hosts such as the ChatGPT file host through
  // the local proxy they name, so use that proxy; otherwise use the manual
  // proxy, or go direct and let the transfer report its own network error.
  if (settings.pac.trim() && pacProxy) return { mode: "proxy", source: "windows-pac", url: validateFileProxy(pacProxy) };
  if (!settings.enabled || !settings.server.trim() || fileProxyBypass(url.hostname, url.port || "443", settings.bypass)) {
    return { mode: "direct", source: "windows-system" };
  }
  let server = settings.server.trim();
  if (server.includes("=")) {
    server = server.split(";").map(x => x.trim()).find(x => /^https=/i.test(x))?.replace(/^https=/i, "") || "";
    if (!server) return { mode: "direct", source: "windows-system" };
  }
  return { mode: "proxy", source: "windows-system", url: validateFileProxy(/^[a-z]+:\/\//i.test(server) ? server : "http://" + server) };
}
async function readWindowsProxy(signal?: AbortSignal): Promise<FileProxySettings> {
  const { stdout } = await run("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
    { windowsHide: true, timeout: 3000, maxBuffer: 32768, signal });
  const value = (name: string) => new RegExp("^\\s*" + name + "\\s+REG_\\w+\\s+(.*)$", "im").exec(stdout)?.[1]?.trim() || "";
  return { enabled: /^(?:0x)?1$/i.test(value("ProxyEnable")), server: value("ProxyServer"), bypass: value("ProxyOverride"), pac: value("AutoConfigURL") };
}
export async function resolveFileProxy(url: URL, options: {
  env?: NodeJS.ProcessEnv; platform?: string; signal?: AbortSignal;
  readSystem?: () => Promise<FileProxySettings>;
  readPacProxy?: (pacUrl: string, signal?: AbortSignal) => Promise<string | undefined>;
} = {}): Promise<FileProxyRoute> {
  const env = options.env || process.env;
  const explicit = env.HARNESS_FILE_DOWNLOAD_PROXY?.trim();
  if (explicit === "direct") return { mode: "direct", source: "file-setting" };
  if (explicit) return { mode: "proxy", source: "file-setting", url: validateFileProxy(explicit) };
  if (fileProxyBypass(url.hostname, url.port || "443", envValue(env, "NO_PROXY"))) return { mode: "direct", source: "NO_PROXY" };
  const inherited = envValue(env, "HTTPS_PROXY") || envValue(env, "HTTP_PROXY");
  if (inherited) return { mode: "proxy", source: "environment", url: validateFileProxy(inherited) };
  if ((options.platform || process.platform) !== "win32") return { mode: "direct", source: "default" };
  const settings = await (options.readSystem ? options.readSystem() : readWindowsProxy(options.signal));
  const pacProxy = settings.pac.trim()
    ? await (options.readPacProxy ?? pacProxyHint)(settings.pac.trim(), options.signal).catch(() => undefined)
    : undefined;
  return parseWindowsFileProxy(settings, url, pacProxy);
}

/** The first PROXY/HTTPS directive of a PAC script, read as text (never executed). */
export async function pacProxyHint(pacUrl: string, signal?: AbortSignal): Promise<string | undefined> {
  const url = new URL(pacUrl);
  let text: string;
  if (url.protocol === "file:") {
    text = (await readFile(fileURLToPath(url))).subarray(0, 1024 * 1024).toString("utf8");
  } else if (url.protocol === "http:" || url.protocol === "https:") {
    const timeout = AbortSignal.timeout(3000);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "follow" });
    if (!response.ok) return undefined;
    text = (await response.text()).slice(0, 1024 * 1024);
  } else return undefined;
  const match = /\b(PROXY|HTTPS)\s+(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})\b/i.exec(text);
  return match ? `${match[1].toUpperCase() === "HTTPS" ? "https" : "http"}://${match[2]}:${match[3]}` : undefined;
}

/** Download-only routing. No global agent, Windows settings, Tunnel config,
 * process-wide proxy variables or local MCP requests are changed. URL/SSRF
 * validation remains the caller's responsibility before every redirect. */
export async function fetchFileResponse(url: URL, signal: AbortSignal, resolvedRoute?: FileProxyRoute): Promise<Response> {
  const route = resolvedRoute ?? await resolveFileProxy(url, { signal });
  signal.throwIfAborted();
  const headers = { "User-Agent": "chatgpt-local-coder/1.0", "Accept-Encoding": "identity" };
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21))) {
    throw new Error("FILE_PROXY_RUNTIME_UNSUPPORTED: requires Node 22.21+ or Node 24.5+; no unproxied fallback was attempted");
  }
  // Always use a dedicated agent: global fetch may inherit NODE_USE_ENV_PROXY
  // and silently bypass a resolved NO_PROXY or Windows bypass decision.
  const agent = new Agent({ proxyEnv: route.mode === "proxy"
    ? { HTTPS_PROXY: validateFileProxy(route.url || "") } : {} });
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: "GET", agent, signal, headers }, (res) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      const status = res.statusCode || 502;
      res.once("close", () => agent.destroy());
      // Null-body statuses must be drained without constructing a decoder. An
      // empty 204 carrying Content-Encoding otherwise raises a decoder error.
      if ([204,205,304].includes(status)) { res.once("error", () => agent.destroy()); res.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return; }
      const encoding = String(res.headers["content-encoding"] || "identity").trim().toLowerCase();
      let body: Readable = res;
      if (encoding === "gzip") body = res.pipe(createGunzip());
      else if (encoding === "deflate") body = res.pipe(createInflate());
      else if (encoding === "br") body = res.pipe(createBrotliDecompress());
      else if (encoding !== "identity") { res.destroy(); agent.destroy(); reject(new Error("FILE_DOWNLOAD_ENCODING_UNSUPPORTED")); return; }
      if (body !== res) {
        res.on("error", (error) => body.destroy(error));
        res.once("aborted", () => body.destroy(Object.assign(new Error("File response aborted"), { code: "ECONNRESET" })));
        body.once("close", () => { if (!res.complete) res.destroy(); });
      }
      resolve(new Response(Readable.toWeb(body) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
    });
    req.once("error", (error) => { agent.destroy(); reject(error); });
    req.end();
  });
}
