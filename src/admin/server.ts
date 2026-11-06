import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { createAdminRouter } from "./routes.js";
import { adminAuth, localhostOnly } from "./localhost-guard.js";
import { createBrowserRequestGuard } from "../lib/browser-request-guard.js";
import { recoveryNonMcpHttpFence } from "../lib/recovery-non-mcp-fence.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AdminServerOptions {
  host?: string;
  port: number;
  mcpPort: number;
  pid: number;
  manager: McpUpstreamManager;
  sessionCount: () => number;
  workspaceRoot?: string;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}

export function startAdminServer(options: AdminServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const app = express();
  // Precede OAuth (effectful GET), Companion, Admin and static routes.
  app.use(recoveryNonMcpHttpFence);
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnly);
  // A DNS-rebound page passes the socket-address check (it connects from
  // 127.0.0.1); its Origin gives it away. The admin UI's loopback origin, the
  // Browser Companion's extension origin and OAuth redirects (no Origin) pass.
  app.use(createBrowserRequestGuard(() => false, "Admin"));

  // Product action approval routes are retired, including legacy env opt-ins.

  // OAuth callbacks must not require ADMIN_TOKEN: OAuth providers redirect the browser here.
  // The route is still loopback-only and protected by the per-flow OAuth state value.
  app.get("/oauth/callback/:id", async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    const errorDescription = typeof req.query.error_description === "string" ? req.query.error_description : undefined;
    if (error) {
      res.status(400).send(`<h2>OAuth failed</h2><p>${escapeHtml(errorDescription || error)}</p><p>You can close this tab.</p>`);
      return;
    }
    if (!code) {
      res.status(400).send("<h2>OAuth failed</h2><p>Missing authorization code.</p>");
      return;
    }
    try {
      const status = await options.manager.finishOAuth(req.params.id, code, state);
      res.send(`<h2>OAuth connected</h2><p>${escapeHtml(req.params.id)}: ${status.tool_count} tools available.</p><p>You can close this tab.</p>`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).send(`<h2>OAuth failed</h2><pre>${escapeHtml(message)}</pre><p>You can close this tab.</p>`);
    }
  });

  app.use(adminAuth);

  const uiDir = path.resolve(__dirname, "../../public/ui");
  app.use("/ui", express.static(uiDir));
  app.get("/", (_req, res) => res.redirect("/ui/"));

  app.use(createAdminRouter(options.manager, {
    mcpPort: options.mcpPort,
    pid: options.pid,
    sessionCount: options.sessionCount,
    workspaceRoot: options.workspaceRoot,
    instructionSummary: options.instructionSummary,
    instructionsPreview: options.instructionsPreview,
  }));

  return app.listen(options.port, host, () => {
    console.log(`  Admin UI:  http://${host}:${options.port}/ui`);
    console.log(`  Admin API: http://${host}:${options.port}/health`);
  });
}
