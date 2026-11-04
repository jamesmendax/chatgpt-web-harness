import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resetHarnessSnapshotRetention } from "./context-broker.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { refreshProxiedTools } from "./mcp-tool-proxy.js";
import { runCodexSessionStartHooks } from "./codex-hooks.js";
import { runWithMcpRequestIdentity } from "./mcp-request-identity.js";
import { PersistentMcpEventStore } from "./mcp-event-store.js";
import { disposeBrowserUseProvider } from "./browser-use-registry.js";


const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

function boundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

const SESSION_TTL_MS = boundedIntEnv("MCP_SESSION_TTL_MS", 300_000, 60_000, 604_800_000); // 1m..7d
const SESSION_CLEANUP_INTERVAL_MS = boundedIntEnv("MCP_SESSION_CLEANUP_MS", 30_000, 1_000, 3_600_000); // 1s..1h
const SESSION_DELETE_GRACE_MS = boundedIntEnv("MCP_SESSION_DELETE_GRACE_MS", 45_000, 0, 600_000); // 0..10m
const SESSION_MAX_COUNT = boundedIntEnv("MCP_SESSION_MAX_COUNT", 32, 4, 512);
const SSE_EVENT_STORE_ENABLED = process.env.MCP_SSE_EVENT_STORE_ENABLED !== "false";
const SSE_EVENT_MAX_COUNT = boundedIntEnv("MCP_SSE_EVENT_MAX_COUNT", 2048, 64, 16_384);
const SSE_EVENT_MAX_BYTES = boundedIntEnv("MCP_SSE_EVENT_MAX_BYTES", 16 * 1024 * 1024, 1024 * 1024, 128 * 1024 * 1024);
const SSE_EVENT_RETENTION_MS = boundedIntEnv("MCP_SSE_EVENT_RETENTION_MS", 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

/**
 * Gan Mcp-Session-Id vao request truoc khi day cho transport.
 *
 * SDK >=1.29 boc Node transport quanh WebStandardStreamableHTTPServerTransport
 * va dung @hono/node-server de doi IncomingMessage -> fetch Request. Hono dung
 * `incoming.rawHeaders`, KHONG dung `incoming.headers` — nen chi va req.headers
 * la vo tac dung. Phai va ca hai.
 */
function withSessionIdHeader(
  req: Request,
  sessionId: string,
  protocolVersion: string
): Request {
  const headers = {
    ...req.headers,
    "mcp-session-id": sessionId,
    "mcp-protocol-version": protocolVersion,
  };
  const drop = new Set(["mcp-session-id", "mcp-protocol-version"]);
  const raw: string[] = [];
  const existing = req.rawHeaders || [];
  for (let i = 0; i < existing.length; i += 2) {
    if (drop.has(existing[i]?.toLowerCase())) continue;
    raw.push(existing[i], existing[i + 1]);
  }
  raw.push("mcp-session-id", sessionId, "mcp-protocol-version", protocolVersion);
  return Object.assign(req, { headers, rawHeaders: raw });
}

/** Recovery must not silently rewrite an unsupported protocol header. */
function negotiateProtocolVersion(requested: string | undefined): string {
  if (requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested;
  }
  if (requested) throw new Error("MCP_UNSUPPORTED_PROTOCOL_VERSION");
  return DEFAULT_PROTOCOL_VERSION;
}

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
  createServer: (projectMemoryInstructions?: string) => McpServer;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  touch(sessionId: string): void;
  count(): number;
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(session: McpSession, req: Request, res: Response, body?: unknown): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  try {
    return {
      ok: response.ok,
      status: response.status,
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
    };
  } finally {
    // Recovery only needs response headers. Release the body so pooled sockets
    // are not retained by an unread initialization response.
    await response.body?.cancel().catch(() => undefined);
  }
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId || !lastTransportErrors[sessionId]) return undefined;
  const message = lastTransportErrors[sessionId];
  delete lastTransportErrors[sessionId];
  return message;
}

async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const sessions: Record<string, McpSession> = {};
  const pendingRecoveries: Record<string, McpSession> = {};
  const recoveryFlights = new Map<string, Promise<boolean>>();
  const deleteGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  const closingSessions = new Set<string>();
  const activeRequestCounts = new Map<string, number>();
  const initializingServers = new Set<McpServer>();
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function beginSessionRequest(sessionId: string): void {
    activeRequestCounts.set(sessionId, (activeRequestCounts.get(sessionId) ?? 0) + 1);
  }

  function endSessionRequest(sessionId: string): void {
    const next = (activeRequestCounts.get(sessionId) ?? 1) - 1;
    if (next > 0) activeRequestCounts.set(sessionId, next);
    else activeRequestCounts.delete(sessionId);
    enforceSessionLimit();
  }

  function isSessionBusy(sessionId: string): boolean {
    const session = sessions[sessionId];
    return (
      (activeRequestCounts.get(sessionId) ?? 0) > 0 ||
      sessionOpChains.has(sessionId) ||
      Boolean(session && initializingServers.has(session.server))
    );
  }

  function touch(sessionId: string): void {
    const session = sessions[sessionId];
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function cancelDeleteGrace(sessionId: string): void {
    const timer = deleteGraceTimers[sessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete deleteGraceTimers[sessionId];
  }

  function scheduleDeleteGrace(sessionId: string): void {
    if (!sessions[sessionId]) return;
    if (closingSessions.has(sessionId)) return;
    closingSessions.add(sessionId);
    console.log(
      `[MCP] Session DELETE — giữ ${SESSION_DELETE_GRACE_MS / 1000}s để tool call đang chạy: ${sessionId}`
    );
    const finalize = () => {
      delete deleteGraceTimers[sessionId];
      if (!sessions[sessionId]) {
        closingSessions.delete(sessionId);
        return;
      }
      if (isSessionBusy(sessionId)) {
        // DELETE is an admission fence, not permission to abandon an already
        // accepted side effect. Keep the transport alive until every request
        // that entered before DELETE has drained, while rejecting all new
        // requests below. This preserves the original result channel without
        // allowing the closed session to be revived.
        deleteGraceTimers[sessionId] = setTimeout(finalize, 50);
        deleteGraceTimers[sessionId].unref?.();
        return;
      }
      removeSession(sessionId, "client DELETE (grace expired)");
    };
    deleteGraceTimers[sessionId] = setTimeout(finalize, SESSION_DELETE_GRACE_MS);
    deleteGraceTimers[sessionId].unref?.();
  }

  function removeSession(sessionId: string, reason: string, closeTransport = false): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (!session) return;
    getUpstreamManager().unregisterMcpServer(session.server);
    void disposeBrowserUseProvider(session.server).catch((error) =>
      console.warn(`[MCP] Browser Use cleanup failed for ${sessionId}:`, error));
    delete sessions[sessionId];
    closingSessions.delete(sessionId);
    delete lastTransportErrors[sessionId];
    sessionOpChains.delete(sessionId);
    activeRequestCounts.delete(sessionId);
    initializingServers.delete(session.server);
    if (closeTransport) void session.transport.close().catch(() => undefined);
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
  }

  function clearPendingRecovery(sessionId: string, disposeReason?: string): void {
    const pending = pendingRecoveries[sessionId];
    if (!pending) return;
    delete pendingRecoveries[sessionId];
    const active = sessions[sessionId];
    if (disposeReason && (!active || active.server !== pending.server)) {
      getUpstreamManager().unregisterMcpServer(pending.server);
      void disposeBrowserUseProvider(pending.server).catch((error) =>
        console.warn(`[MCP] Pending Browser Use cleanup failed for ${sessionId}:`, error));
      initializingServers.delete(pending.server);
      void pending.transport.close().catch(() => undefined);
      console.log(`[MCP] Pending recovery disposed (${disposeReason}): ${sessionId}`);
    }
  }

  function enforceSessionLimit(protectedSessionId?: string): void {
    let count = Object.keys(sessions).length;
    if (count <= SESSION_MAX_COUNT) return;

    const candidates = Object.entries(sessions)
      .filter(([sid]) => sid !== protectedSessionId && !isSessionBusy(sid))
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    for (const [sid] of candidates) {
      if (count <= SESSION_MAX_COUNT) break;
      removeSession(sid, `LRU cap ${SESSION_MAX_COUNT}`, true);
      count--;
    }
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    const hookInstructions = await runCodexSessionStartHooks().catch((error) => {
      console.warn("[MCP] Codex SessionStart hook failed:", error);
      return "";
    });
    const mcpServer = config.createServer(
      [config.projectMemoryInstructions, hookInstructions].filter(Boolean).join("\n\n")
    );

    const transportSessionId = preferredSessionId ?? randomUUID();
    const eventStore = SSE_EVENT_STORE_ENABLED
      ? new PersistentMcpEventStore({
          workspaceRoot: config.workspaceRoot,
          sessionId: transportSessionId,
          maxEvents: SSE_EVENT_MAX_COUNT,
          maxBytes: SSE_EVENT_MAX_BYTES,
          retentionMs: SSE_EVENT_RETENTION_MS,
        })
      : undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => transportSessionId,
      enableJsonResponse: true,
      eventStore,
      onsessioninitialized: (sid) => {
        const existing = sessions[sid];
        sessions[sid] = {
          transport,
          server: mcpServer,
          lastAccessedAt: Date.now(),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        clearPendingRecovery(sid);
        enforceSessionLimit(sid);
        // Per-session snapshot retention: a fresh ChatGPT conversation must
        // re-receive the harness snapshot on its first tool result.
        resetHarnessSnapshotRetention(config.workspaceRoot, sid);
        console.log(`[MCP] Session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        if (sid && sessions[sid]) scheduleDeleteGrace(sid);
      },
    });

    transport.onerror = (error) => {
      const sid = transport.sessionId;
      const message = error.message || String(error);
      if (sid) lastTransportErrors[sid] = message;
    };

    // Keep session alive across transient SSE disconnects; explicit DELETE cleans up.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!sid || !sessions[sid]) return;
      console.log(`[MCP] Transport closed for ${sid} (session kept for recovery)`);
    };

    await mcpServer.connect(transport);
    // Native tools must be available immediately. Upstream discovery can spawn
    // local processes or wait on remote MCPs, so publish it when ready instead.
    void refreshProxiedTools(mcpServer, getUpstreamManager())
      .then(() => mcpServer.sendToolListChanged())
      .catch((error) => console.warn("[MCP] Upstream tool refresh failed:", error));

    const sid = transport.sessionId ?? preferredSessionId ?? randomUUID();
    return (
      sessions[sid] ?? {
        transport,
        server: mcpServer,
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
      }
    );
  }

  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "codex-mcp-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `[MCP] Recovery initialize failed: HTTP ${initResult.status} for ${staleSessionId}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `[MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions[staleSessionId]);
  }

  return {
    get(sessionId: string) {
      return sessions[sessionId];
    },

    touch,

    count() {
      return Object.keys(sessions).length;
    },

    sendSessionNotFound(res: Response, requestId: string | number | null = null) {
      const message =
        "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
      res.locals.mcpError = message;
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: requestId,
      });
    },

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        initializingServers.add(session.server);
        if (sid) beginSessionRequest(sid);
        try {
          await runWithMcpRequestIdentity(req.headers, sid, () =>
            session.transport.handleRequest(req, res, body)
          );
          const activeSid = session.transport.sessionId;
          if (activeSid) touch(activeSid);
        } finally {
          initializingServers.delete(session.server);
          if (sid) endSessionRequest(sid);
          else enforceSessionLimit();
        }
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);

      // Do not hand an explicit DELETE to the SDK transport while another
      // tools/call is active. StreamableHTTPServerTransport closes its response
      // machinery immediately, which can strand the already-running handler.
      // Acknowledge the client close, fence new admission, then close/remove
      // the transport only after the configured grace and active-request drain.
      if (sid && req.method === "DELETE") {
        scheduleDeleteGrace(sid);
        res.status(200).end();
        return;
      }
      if (sid && closingSessions.has(sid)) {
        const message =
          "Session not found. Session was closed by the client and is draining accepted work.";
        res.locals.mcpError = message;
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32001, message },
          id: extractRequestId(body),
        });
        return;
      }
      if (sid) touch(sid);
      const run = async () => {
        if (sid) beginSessionRequest(sid);
        try {
          await runWithMcpRequestIdentity(req.headers, sid, () =>
            session.transport.handleRequest(req, res, body)
          );
        } finally {
          if (sid) endSessionRequest(sid);
        }
      };
      // Only initialization changes transport setup. A long-running tools/call
      // must not hold status, ping, cancellation or unrelated RPCs behind it.
      // Tool mutations retain their own revision/CAS/ownership controls.
      if (sid && isInitializeRequest(body)) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (isInitializeRequest(body)) {
        return false;
      }

      console.log(`[MCP] Attempting session recovery for stale ID: ${staleSessionId}`);

      let protocolVersion: string;
      try {
        protocolVersion = negotiateProtocolVersion(req.headers["mcp-protocol-version"] as string | undefined);
      } catch {
        res.locals.mcpError = "Unsupported MCP protocol version";
        res.status(400).json({ jsonrpc: "2.0", id: extractRequestId(body),
          error: { code: -32600, message: "Unsupported MCP protocol version" } });
        return true;
      }
      const mcpPath = req.path || "/mcp";
      let flight = recoveryFlights.get(staleSessionId);
      if (!flight) {
        flight = (async () => {
          if (sessions[staleSessionId]) return true;
          try {
            const pending = await buildSession(staleSessionId);
            pendingRecoveries[staleSessionId] = pending;
            if (await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion)) return true;
          } catch (error) {
            // Never log the authenticated endpoint or request body.
            console.warn("[MCP] Session recovery failed:", error instanceof Error ? error.name : "unknown");
          }
          clearPendingRecovery(staleSessionId, "recovery failed before initialization");
          removeSession(staleSessionId, "recovery failed", true);
          return false;
        })();
        recoveryFlights.set(staleSessionId, flight);
      }
      let warmed: boolean;
      try { warmed = await flight; }
      finally { if (recoveryFlights.get(staleSessionId) === flight) recoveryFlights.delete(staleSessionId); }
      if (!warmed) return false;

      const recovered = sessions[staleSessionId];
      if (!recovered) {
        clearPendingRecovery(staleSessionId);
        return false;
      }

      touch(staleSessionId);
      console.log(`[MCP] Session recovered: ${staleSessionId}`);

      const patchedReq = withSessionIdHeader(req, staleSessionId, protocolVersion);
      beginSessionRequest(staleSessionId);
      try {
        await runWithMcpRequestIdentity(patchedReq.headers, staleSessionId, () =>
          recovered.transport.handleRequest(patchedReq, res, body)
        );
      } finally {
        endSessionRequest(staleSessionId);
      }
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of Object.entries(sessions)) {
          if (now - session.lastAccessedAt > SESSION_TTL_MS && !isSessionBusy(sid)) {
            removeSession(sid, "TTL expired", true);
          }
        }
        for (const [sid, pending] of Object.entries(pendingRecoveries)) {
          const orphanAge = Math.max(SESSION_CLEANUP_INTERVAL_MS * 2, 60_000);
          if (!sessions[sid] && now - pending.createdAt > orphanAge) {
            clearPendingRecovery(sid, "orphaned recovery cleanup");
          }
        }
        enforceSessionLimit();
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest };
