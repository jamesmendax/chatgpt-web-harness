import fs from "fs/promises";
import path from "path";
import { Router, type Request, type Response } from "express";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import {
  defaultUpstreamConfig,
  discoverMcpConfigs,
  findMcpConfigForSource,
  importMcpConfigFromFile,
  type McpImportSource,
  type UpstreamServerConfig,
} from "../lib/mcp-upstream-config.js";
import { getDefaultCwd, getFullDiskAccess } from "../lib/path-security.js";
import { getCheckpointConfig } from "../lib/checkpoint.js";
import { getLocalPluginsConfig, getLocalPluginsConfigPath, getRegistryEntries, saveLocalPluginsConfig } from "../lib/plugin-config.js";
import { getSkillCodeRoot, getSkillInstalledDir, resolveAllSkills } from "../lib/skills-loader.js";
import { installSkill, setSkillEnabled, SkillInstallerError, uninstallSkill } from "../lib/skill-installer.js";
import { getCodexHooks, saveCodexHooks } from "../lib/codex-hooks.js";
import { recoveryNonMcpHttpFence } from "../lib/recovery-non-mcp-fence.js";
import {
  getRecentActivity,
  loadAuditHistory,
  subscribeActivity,
  type ActivityEntry,
} from "../lib/activity-log.js";

// RI strict mode cannot be enabled safely after the main server has already
// initialized its HTTP routes and background workers. Operator-side control
// inputs also must not be rebound by the same generic Admin env writer.
const RECOVERY_IMMUTABLE_ENV_KEYS = new Set([
  "HARNESS_RECOVERY_SCOPE_MODE",
  "HARNESS_RECOVERY_ISOLATED",
  "HARNESS_RECOVERY_HMAC_KEY",
  "HARNESS_RECOVERY_GRANT_FILE",
  "HARNESS_RECOVERY_HEAD_PATH",
  "HARNESS_RECOVERY_ATTESTATION_FILE",
]);

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function serializeDotEnv(values: Record<string, string>, original: string): string {
  const lines = original.split("\n");
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      result.push(line);
      continue;
    }
    const key = trimmed.split("=")[0].trim();
    if (key in values) {
      result.push(`${key}=${values[key]}`);
      seen.add(key);
    } else {
      result.push(line);
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) result.push(`${key}=${value}`);
  }

  return result.join("\n");
}

export function createAdminRouter(manager: McpUpstreamManager, options: {
  mcpPort: number;
  pid: number;
  sessionCount: () => number;
  workspaceRoot?: string;
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}): Router {
  const router = Router();
  // Also protect direct router mounts outside startAdminServer.
  router.use(recoveryNonMcpHttpFence);
  const envPath = path.resolve(process.cwd(), ".env");

  router.get("/health", async (_req: Request, res: Response) => {
    const upstream = await manager.listStatuses();
    res.json({
      status: "ok",
      name: "codex-mcp-admin",
      pid: options.pid,
      mcp_port: options.mcpPort,
      active_sessions: options.sessionCount(),
      default_cwd: getDefaultCwd(),
      full_disk_access: getFullDiskAccess(),
      upstream,
      checkpoint: getCheckpointConfig(),
      instructions: options.instructionSummary?.() ?? null,
    });
  });

  router.get("/api/instructions/preview", (_req, res) => {
    const text = options.instructionsPreview?.() ?? "";
    const summary = options.instructionSummary?.() ?? {};
    res.json({
      ok: true,
      summary,
      preview: text.slice(0, 12000),
      truncated: text.length > 12000,
      total_chars: text.length,
    });
  });

  router.get("/api/config/env", async (_req, res) => {
    try {
      const text = await fs.readFile(envPath, "utf-8");
      res.json({ ok: true, path: envPath, values: parseDotEnv(text) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.json({ ok: true, path: envPath, values: {} });
        return;
      }
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.put("/api/config/env", async (req, res) => {
    try {
      const values = req.body?.values as Record<string, string>;
      if (!values || typeof values !== "object") {
        res.status(400).json({ ok: false, error: "values object required" });
        return;
      }
      // On Windows process.env is case-insensitive. Reject mixed-case aliases
      // as well, and reject the entire transaction before any file/env write.
      if (Object.keys(values).some((key) => RECOVERY_IMMUTABLE_ENV_KEYS.has(key.toUpperCase()))) {
        res.status(409).json({
          ok: false,
          error: "RI_CONTROL_PLANE_IMMUTABLE",
          detail: "Recovery Integrity mode and operator authority controls are startup-only; configure them out of band and restart under verified launch policy.",
        });
        return;
      }
      let original = "";
      try {
        original = await fs.readFile(envPath, "utf-8");
      } catch {}
      const next = serializeDotEnv(values, original || "");
      await fs.writeFile(envPath, next, "utf-8");
      for (const [k, v] of Object.entries(values)) {
        process.env[k] = v;
      }
      res.json({ ok: true, path: envPath });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  router.get("/api/upstream", async (_req, res) => {
    res.json({ ok: true, config: manager.getConfig(), path: manager.getConfigPath() });
  });

  router.get("/api/plugins", (_req, res) => {
    res.json({
      ok: true,
      config: getLocalPluginsConfig(),
      available: { computer_use: process.platform === "win32", browser_use: process.platform === "win32" },
      registered_skill_count: getRegistryEntries().length,
    });
  });

  router.put("/api/plugins", (req, res) => {
    const computerUseEnabled = req.body?.config?.computer_use?.enabled === true;
    const browserUseEnabled = req.body?.config?.browser_use?.enabled === true;
    const next = {
      ...getLocalPluginsConfig(),
      computer_use: { enabled: computerUseEnabled },
      browser_use: { enabled: browserUseEnabled },
    };
    saveLocalPluginsConfig(next);
    res.json({ ok: true, config: next, restart_required: "Open a new ChatGPT MCP session after changing plugin state." });
  });

  const skillPaths = () => ({
    workspaceRoot: path.resolve(options.workspaceRoot || process.env.WORKSPACE_PATH || process.cwd()),
    codeRoot: getSkillCodeRoot(),
    installedDir: getSkillInstalledDir(),
    registryPath: getLocalPluginsConfigPath(),
  });
  const installerError = (err: unknown): { status: number; error: string; candidates?: string[] } => {
    if (err instanceof SkillInstallerError) return { status: err.status, error: err.message, ...(err.candidates ? { candidates: err.candidates } : {}) };
    return { status: 500, error: err instanceof Error ? err.message : String(err) };
  };

  router.get("/api/skills", async (_req: Request, res: Response) => {
    try {
      const paths = skillPaths();
      const skills = await resolveAllSkills(paths.workspaceRoot);
      res.json({ ok: true, skills, paths });
    } catch (err) {
      const failure = installerError(err);
      res.status(failure.status).json({ ok: false, error: failure.error, ...(failure.candidates ? { candidates: failure.candidates } : {}) });
    }
  });

  router.post("/api/skills/install", async (req: Request, res: Response) => {
    try {
      const source = typeof req.body?.source === "string" ? req.body.source.trim() : "";
      if (!source || !path.isAbsolute(source)) {
        res.status(400).json({ ok: false, error: "source must be an absolute local directory" });
        return;
      }
      const paths = skillPaths();
      const result = await installSkill({
        source,
        id: typeof req.body.id === "string" ? req.body.id : undefined,
        overwrite: req.body.overwrite !== false,
        localSkillsDir: paths.installedDir,
        registryPath: paths.registryPath,
      });
      res.status(201).json({ ok: true, result, skills: await resolveAllSkills(paths.workspaceRoot) });
    } catch (err) {
      const failure = installerError(err);
      res.status(failure.status).json({ ok: false, error: failure.error, ...(failure.candidates ? { candidates: failure.candidates } : {}) });
    }
  });

  router.delete("/api/skills/:id", async (req: Request, res: Response) => {
    try {
      const paths = skillPaths();
      const result = await uninstallSkill({
        id: String(req.params.id),
        localSkillsDir: paths.installedDir,
        registryPath: paths.registryPath,
        codeRoot: paths.codeRoot,
        workspaceRoot: paths.workspaceRoot,
      });
      res.json({ ok: true, result });
    } catch (err) {
      const failure = installerError(err);
      res.status(failure.status).json({ ok: false, error: failure.error, ...(failure.candidates ? { candidates: failure.candidates } : {}) });
    }
  });

  router.put("/api/skills/:id/enabled", async (req: Request, res: Response) => {
    try {
      if (typeof req.body?.enabled !== "boolean") {
        res.status(400).json({ ok: false, error: "enabled must be boolean" });
        return;
      }
      const paths = skillPaths();
      const source = req.body.source === undefined ? undefined : req.body.source;
      if (source !== undefined && !["installed", "external", "builtin"].includes(source)) {
        res.status(400).json({ ok: false, error: "source must be installed, external, or builtin" });
        return;
      }
      const result = await setSkillEnabled({
        id: String(req.params.id),
        enabled: req.body.enabled,
        source,
        localSkillsDir: paths.installedDir,
        registryPath: paths.registryPath,
        codeRoot: paths.codeRoot,
        workspaceRoot: paths.workspaceRoot,
      });
      res.json({ ok: true, result });
    } catch (err) {
      const failure = installerError(err);
      res.status(failure.status).json({ ok: false, error: failure.error, ...(failure.candidates ? { candidates: failure.candidates } : {}) });
    }
  });

  router.get("/api/codex-hooks", async (_req, res) => {
    try {
      res.json({ ok: true, hooks: await getCodexHooks() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/codex-hooks", async (req, res) => {
    try {
      res.json({ ok: true, hooks: await saveCodexHooks(req.body?.enabled) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/local-tools", async (_req, res) => {
    try {
      const { LOCAL_TOOL_CATALOG } = await import("../lib/tool-profile.js");
      const configPath = path.resolve(process.cwd(), "profiles", "tool-overrides.json");
      let overrides: { enabled?: string[]; disabled?: string[] } = {};
      try {
        overrides = JSON.parse(await fs.readFile(configPath, "utf-8"));
      } catch {}
      res.json({ ok: true, tools: LOCAL_TOOL_CATALOG, overrides });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/local-tools", async (req, res) => {
    try {
      const { LOCAL_TOOL_CATALOG } = await import("../lib/tool-profile.js");
      const known = new Set(LOCAL_TOOL_CATALOG);
      const names = (value: unknown) => Array.isArray(value)
        ? [...new Set(value.filter((name): name is string => typeof name === "string" && known.has(name)))]
        : [];
      const enabled = names(req.body?.overrides?.enabled);
      const disabled = names(req.body?.overrides?.disabled).filter((name) => !enabled.includes(name));
      const configPath = path.resolve(process.cwd(), "profiles", "tool-overrides.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify({ enabled, disabled }, null, 2) + "\n", "utf-8");
      res.json({ ok: true, overrides: { enabled, disabled }, restart_required: "Open a new ChatGPT MCP session after changing local tool visibility." });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put("/api/upstream", async (req, res) => {
    try {
      const config = req.body?.config ?? defaultUpstreamConfig();
      const saved = await manager.updateConfig(config);
      res.json({ ok: true, config: saved });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream", async (req, res) => {
    try {
      const server = req.body?.server as UpstreamServerConfig;
      if (!server?.id) {
        res.status(400).json({ ok: false, error: "server.id required" });
        return;
      }
      await manager.upsertServer(server);
      res.json({ ok: true, config: manager.getConfig() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete("/api/upstream/:id", async (req, res) => {
    const removed = await manager.removeServer(req.params.id);
    if (!removed) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    res.json({ ok: true, config: manager.getConfig() });
  });

  router.post("/api/upstream/:id/test", async (req, res) => {
    try {
      const status = await manager.checkHealth(req.params.id);
      res.json({ ok: status.health === "connected", status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/oauth/status", async (req, res) => {
    try {
      res.json({ ok: true, status: await manager.oauthStatus(req.params.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream/:id/oauth/start", async (req, res) => {
    try {
      const status = await manager.startOAuth(req.params.id, req.body?.reset !== false);
      res.json({ ok: true, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/upstream/:id/oauth/disconnect", async (req, res) => {
    try {
      await manager.disconnectOAuth(req.params.id);
      res.json({ ok: true, status: await manager.oauthStatus(req.params.id) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/upstream/:id/tools", async (req, res) => {
    try {
      const tools = await manager.listTools(req.params.id);
      const config = manager.getServerConfig(req.params.id);
      res.json({
        ok: true,
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
        proxied_tools: config ? manager.getProxiedToolNames(config, tools) : [],
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/import/sources", async (_req, res) => {
    try {
      const sources = await discoverMcpConfigs();
      res.json({ ok: true, sources });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  async function handleImport(
    source: McpImportSource,
    body: { path?: string; merge?: boolean; enable?: boolean }
  ) {
    const configPath = body.path || (await findMcpConfigForSource(source));
    if (!configPath) throw new Error(`${source} MCP config not found on this machine`);
    return importMcpConfigFromFile(configPath, source, {
      merge: body.merge !== false,
      enableImported: Boolean(body.enable),
    });
  }

  router.post("/api/import/:source", async (req, res) => {
    try {
      const source = req.params.source as McpImportSource;
      if (!["cursor", "claude", "opencode", "file"].includes(source)) {
        res.status(400).json({ ok: false, error: "Unknown import source" });
        return;
      }
      const filePath = req.body?.path as string | undefined;
      if (source === "file" && !filePath) {
        res.status(400).json({ ok: false, error: "path required for file import" });
        return;
      }
      const detectSource: McpImportSource =
        source === "file" ? (req.body?.detect_as as McpImportSource) || "cursor" : source;
      const result = await importMcpConfigFromFile(filePath || (await findMcpConfigForSource(source))!, detectSource, {
        merge: req.body?.merge !== false,
        enableImported: Boolean(req.body?.enable),
      });
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/import/cursor", async (req, res) => {
    try {
      const result = await handleImport("cursor", req.body ?? {});
      await manager.reloadConfig();
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  function filterActivity(
    entries: ActivityEntry[],
    opts: { kind?: string; status?: string; tool?: string; q?: string }
  ): ActivityEntry[] {
    let out = entries;
    if (opts.kind && opts.kind !== "all") {
      out = out.filter((e) => e.kind === opts.kind);
    }
    if (opts.status === "error") {
      out = out.filter((e) => e.status === "error" || e.status === "blocked");
    }
    if (opts.tool) {
      const needle = opts.tool.toLowerCase();
      out = out.filter((e) => e.tool?.toLowerCase().includes(needle));
    }
    if (opts.q) {
      const needle = opts.q.toLowerCase();
      out = out.filter((e) => {
        const hay = [e.tool, e.action, e.target, e.summary, e.client, e.session_id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }
    return out;
  }

  router.get("/api/activity", (req, res) => {
    const limit = Math.min(parseInt(String(req.query.limit || "100"), 10) || 100, 500);
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const entries = filterActivity(getRecentActivity(limit, since), {
      kind: typeof req.query.kind === "string" ? req.query.kind : undefined,
      status: typeof req.query.status === "string" ? req.query.status : undefined,
      tool: typeof req.query.tool === "string" ? req.query.tool : undefined,
      q: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    res.json({ ok: true, entries, count: entries.length });
  });

  router.get("/api/activity/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(String(req.query.limit || "80"), 10) || 80, 500);
      const entries = await loadAuditHistory(limit);
      res.json({ ok: true, entries, source: "audit_file" });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/api/activity/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (entry: ActivityEntry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };

    for (const entry of getRecentActivity(30).reverse()) send(entry);

    const unsub = subscribeActivity(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      unsub();
      clearInterval(ping);
    });
  });

  return router;
}
