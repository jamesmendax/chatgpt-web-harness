import type { NextFunction, Request, Response } from "express";

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

// Extension pages and service workers (the Browser Companion); no web page can claim these.
const EXTENSION_ORIGIN = /^(?:chrome|edge|moz|safari-web)-extension:\/\/[^/\s]+$/i;

/**
 * DNS rebinding: a web page whose domain later resolves to 127.0.0.1 can send
 * same-origin requests to this loopback server; CORS only hides the response,
 * the request itself still runs (run_command included). Every such request
 * that can change anything (POST, DELETE) carries the page's Origin, which the
 * page cannot forge. Refuse a request whose Origin is neither loopback, a
 * browser extension, nor allow-listed. Requests without Origin pass: the
 * tunnel client, local tools, OAuth navigations and same-origin GETs. The Host
 * header is not checked: a tunnel or reverse proxy may forward its public
 * name, and browsers send no Sec-Fetch-* to plain-http DNS names, so a Host
 * check would only refuse legitimate traffic. MCP_BROWSER_GUARD=off disables it.
 */
export function createBrowserRequestGuard(isAllowedOrigin: (origin: string) => boolean, label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if ((process.env.MCP_BROWSER_GUARD || "").trim().toLowerCase() === "off") { next(); return; }
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin === undefined || isLoopbackOrigin(origin) || EXTENSION_ORIGIN.test(origin) || isAllowedOrigin(origin)) { next(); return; }
    console.warn(`[${label}] Refused a browser request from origin ${origin} for host ${req.headers.host ?? "(none)"} (DNS-rebinding guard; MCP_BROWSER_GUARD=off disables it).`);
    res.status(403).json({ ok: false, error: "BROWSER_REQUEST_REFUSED", reason: "origin_not_allowed" });
  };
}
