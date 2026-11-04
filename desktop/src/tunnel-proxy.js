"use strict";
// Proxy policy is scoped to tunnel-client's CONTROL PLANE only. Never change
// Electron/Windows global proxy settings or route the loopback MCP via a proxy.
const TARGET = "https://api.openai.com";
const PROXY_ENV = "CLC_TUNNEL_HTTP_PROXY";
const MODES = new Set(["auto", "direct", "custom"]);

function validateProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text || /[\r\n\x00]/.test(text)) throw new Error("请填写有效代理地址，例如 http://127.0.0.1:7890。");
  let url;
  try { url = new URL(text); } catch { throw new Error("代理地址必须是完整 URL，例如 http://127.0.0.1:7890。"); }
  if (!["http:", "https:", "socks5:"].includes(url.protocol) || !url.hostname || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("代理仅支持 http://、https:// 或 socks5:// 的主机与端口，不能包含路径或参数。");
  }
  // Saved settings and tunnel-client logs are not a credential store for proxy passwords.
  if (url.username || url.password) throw new Error("代理地址不能包含用户名或密码；请使用本机无认证代理端口。");
  return url.href.replace(/\/$/, "");
}

function validateProxySettings(config) {
  if (!MODES.has(config.tunnelProxyMode || "auto")) throw new Error("Tunnel 代理模式无效。");
  if (config.tunnelProxyMode === "custom") validateProxyUrl(config.tunnelProxyUrl);
}

function envValue(env, name) {
  const entry = Object.entries(env).find(([key, value]) => key.toUpperCase() === name && String(value || "").trim());
  return entry ? String(entry[1]).trim() : "";
}

function bypassesControlPlane(value) {
  const target = new URL(TARGET);
  return String(value || "").split(/[ ,]+/).some((part) => {
    let token = part.trim().toLowerCase();
    if (token === "*") return true;
    if (!token) return false;
    const colon = token.lastIndexOf(":");
    if (colon > -1) {
      if (token.slice(colon + 1) !== "443") return false;
      token = token.slice(0, colon);
    }
    token = token.replace(/^\*?\./, "");
    return target.hostname === token || target.hostname.endsWith("." + token);
  });
}

function parseSystemProxy(value) {
  // Chromium resolves Windows static proxies and PAC against this exact target.
  // Preserve PAC priority; never skip a proxy to silently fall through to DIRECT.
  const first = String(value || "").split(";").map(p => p.trim()).find(Boolean);
  if (!first) throw new Error("系统未返回代理策略，请选择直连或填写自定义代理。");
  if (first.toUpperCase() === "DIRECT") return { mode: "direct", source: "system", url: "" };
  const match = /^(PROXY|HTTPS|SOCKS5)\s+(\S+)$/i.exec(first);
  if (!match) throw new Error("系统代理类型不受支持，请填写 HTTP/HTTPS/SOCKS5 自定义代理。");
  const scheme = { PROXY: "http", HTTPS: "https", SOCKS5: "socks5" }[match[1].toUpperCase()];
  return { mode: "proxy", source: "system", url: validateProxyUrl(scheme + "://" + match[2]) };
}

async function resolveTunnelProxy(config = {}, options = {}) {
  validateProxySettings(config);
  const mode = config.tunnelProxyMode || "auto";
  if (mode === "direct") return { mode: "direct", source: "settings", url: "" };
  if (mode === "custom") return { mode: "proxy", source: "settings", url: validateProxyUrl(config.tunnelProxyUrl) };
  const env = options.env || process.env;
  if (bypassesControlPlane(envValue(env, "NO_PROXY"))) return { mode: "direct", source: "NO_PROXY", url: "" };
  for (const name of [PROXY_ENV, "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
    const value = envValue(env, name);
    if (value) return { mode: "proxy", source: name, url: validateProxyUrl(value) };
  }
  const resolveSystem = options.resolveSystem || ((url) => require("electron").session.defaultSession.resolveProxy(url));
  let timer;
  try {
    const policy = await Promise.race([
      Promise.resolve().then(() => resolveSystem(TARGET)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("系统代理解析超时，请选择直连或自定义代理。")), options.timeoutMs ?? 5000); }),
    ]);
    return parseSystemProxy(policy);
  } finally { clearTimeout(timer); }
}

function applyTunnelProxy(env, args, proxy) {
  // Remove only this child's inherited proxy variables: native Go proxy handling
  // must not override the user's explicit direct/custom decision or leak to MCP.
  for (const name of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|no_proxy|clc_tunnel_http_proxy)$/i.test(name)) delete env[name];
  }
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  if (proxy.mode === "proxy") {
    env[PROXY_ENV] = validateProxyUrl(proxy.url);
    args.push("--control-plane.http-proxy", "env:" + PROXY_ENV);
  }
  return { env, args };
}

module.exports = { TARGET, PROXY_ENV, validateProxyUrl, validateProxySettings, bypassesControlPlane, parseSystemProxy, resolveTunnelProxy, applyTunnelProxy };
