import { timingSafeEqual } from "node:crypto";
import { recoveryNonMcpHttpFence } from "../lib/recovery-non-mcp-fence.js";
import { currentRelayGoal, listRelayGoalIds, resolveRelayGoalForTransition, withRelayGoal } from "../lib/relay-scope.js";
import fs from "node:fs";
import { Router, type NextFunction, type Request, type Response } from "express";
import { readDriverLease } from "../lib/driver-lease.js";
import {
  acknowledgeRelayCommand,
  assessRelayControlPlane,
  claimCompanionCommand,
  claimRelayCommand,
  getRelayGateStatus,
  readRelayManagerState,
  recordRelayLaneHeartbeat,
  relayAutomationEnabled,
  relayCompanionEnabled,
  requestRelayLaneReplacement,
  type RelayAdapterConfidence,
  type RelayLaneId,
} from "../lib/relay-manager.js";
import { readHandoffSnapshot } from "../lib/handoff-store.js";
import { summarizeVisibleFeedbackLedger } from "../lib/visible-feedback-ledger.js";
import {
  readWorkerRegistry,
  type WorkerConversationSurface,
  type WorkerRecord,
  type WorkerRegistryState,
} from "../lib/worker-registry.js";

const ALLOWED_EXTENSION_ORIGIN = /^(?:chrome|edge)-extension:\/\/[a-z0-9_-]+$/i;

interface CompanionCredential {
  readonly token: string;
  readonly instanceId: string | null;
  readonly expiresAt: string | null;
}

function companionCredential(): CompanionCredential | null {
  const capabilityFile = process.env.HARNESS_COMPANION_CAPABILITY_FILE?.trim();
  if (capabilityFile) {
    try {
      const value = JSON.parse(fs.readFileSync(capabilityFile, "utf8")) as Record<string, unknown>;
      const token = typeof value.token === "string" ? value.token.trim() : "";
      const instanceId = typeof value.instance_id === "string" ? value.instance_id.trim() : "";
      const expiresAt = typeof value.expires_at === "string" ? value.expires_at.trim() : "";
      if (value.schema_version !== 1 || !token || !instanceId || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null;
      return { token, instanceId, expiresAt };
    } catch {
      // A missing/revoked/corrupt Desktop capability must fail closed. Never
      // fall back to the process environment when a capability file is named.
      return null;
    }
  }
  const token = process.env.HARNESS_COMPANION_TOKEN?.trim() || "";
  if (!token) return null;
  return {
    token,
    instanceId: process.env.HARNESS_COMPANION_INSTANCE_ID?.trim() || null,
    expiresAt: process.env.HARNESS_COMPANION_TOKEN_EXPIRES_AT?.trim() || null,
  };
}

function validLane(value: unknown): value is RelayLaneId {
  return value === "A" || value === "B";
}

function validConfidence(value: unknown): value is RelayAdapterConfidence {
  return value === "high" || value === "medium" || value === "low" || value === "unknown";
}

function validConversationSurface(value: unknown): value is WorkerConversationSurface {
  return value === "CHAT" || value === "WORK" || value === "UNKNOWN";
}

function safeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function companionWorkerView(worker: WorkerRecord): Record<string, unknown> {
  return {
    worker_id: worker.worker_id,
    lane: worker.lane,
    generation: worker.generation,
    state: worker.state,
    record_revision: worker.record_revision,
    goal_id: worker.goal_id,
    companion_instance_id: worker.companion_instance_id,
    tab_instance_id: worker.tab_instance_id,
    conversation_url: worker.conversation_url,
    adapter_version: worker.adapter_version,
    adapter_confidence: worker.adapter_confidence,
    conversation_surface: worker.conversation_surface ?? "UNKNOWN",
    composer_ready: worker.composer_ready,
    generation_active: worker.generation_active,
    connection_interrupted: worker.connection_interrupted,
    activity_revision: worker.activity_revision,
    turn_id: worker.turn_id ?? null,
    turn_started_at: worker.turn_started_at ?? null,
    stop_button_visible: worker.stop_button_visible ?? false,
    retry_visible: worker.retry_visible ?? false,
    tool_inflight_count: worker.tool_inflight_count ?? 0,
    assistant_token_revision: worker.assistant_token_revision ?? 0,
    feedback_ledger: summarizeVisibleFeedbackLedger(worker.feedback_ledger),
    last_dom_activity_at: worker.last_dom_activity_at ?? null,
    last_assistant_token_at: worker.last_assistant_token_at ?? null,
    stable_observation_windows: worker.stable_observation_windows ?? 0,
    provision_id: worker.provision_id,
    provision_attempt_id: worker.provision_attempt_id,
    provision_reason: worker.provision_reason,
    claim_kind: worker.claim_kind,
    claim_handoff_id: worker.claim_handoff_id,
    claim_expires_at: worker.claim_expires_at,
    claim_consumed_at: worker.claim_consumed_at,
    created_at: worker.created_at,
    updated_at: worker.updated_at,
    ready_at: worker.ready_at,
    activated_at: worker.activated_at,
    last_browser_seen_at: worker.last_browser_seen_at,
    last_mcp_seen_at: worker.last_mcp_seen_at,
    last_capability_probe_id: worker.last_capability_probe_id,
    last_capability_at: worker.last_capability_at,
    successor_worker_id: worker.successor_worker_id,
    retired_at: worker.retired_at,
    death_reason: worker.death_reason,
  };
}

function companionWorkerRegistryView(registry: WorkerRegistryState): Record<string, unknown> {
  return {
    goal_id: registry.goal_id,
    schema_version: registry.schema_version,
    revision: registry.revision,
    lanes: registry.lanes,
    workers: Object.fromEntries(
      Object.entries(registry.workers).map(([workerId, worker]) => [workerId, companionWorkerView(worker)])
    ),
    updated_at: registry.updated_at,
  };
}

function setCompanionCors(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_EXTENSION_ORIGIN.test(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-companion-token,x-companion-instance,x-relay-goal-id");
  res.setHeader("Access-Control-Max-Age", "600");
  res.setHeader("Vary", "Origin");
  return true;
}

export function companionAccessGuard(req: Request, res: Response, next: NextFunction): void {
  if (!relayCompanionEnabled()) {
    res.status(503).json({ ok: false, error: "Browser Companion is disabled" });
    return;
  }
  if (!setCompanionCors(req, res)) {
    res.status(403).json({ ok: false, error: "Browser Companion origin is not allowed" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const credential = companionCredential();
  if (!credential) {
    res.status(503).json({ ok: false, error: "Browser Companion capability is unavailable" });
    return;
  }
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
    res.status(401).json({ ok: false, error: "Browser Companion capability expired" });
    return;
  }
  const expected = credential.token;
  const header = req.headers["x-companion-token"];
  const provided = Array.isArray(header) ? header[0] : header;
  let valid = false;
  if (typeof provided === "string" && provided.length === expected.length) {
    try {
      valid = timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      valid = false;
    }
  }
  if (!valid) {
    res.status(401).json({ ok: false, error: "Browser Companion authentication failed" });
    return;
  }
  if (credential.instanceId) {
    const instanceHeader = req.headers["x-companion-instance"];
    const providedInstance = Array.isArray(instanceHeader) ? instanceHeader[0] : instanceHeader;
    if (providedInstance !== credential.instanceId) {
      res.status(401).json({ ok: false, error: "Browser Companion instance binding failed" });
      return;
    }
  }
  next();
}

export function createCompanionRouter(workspaceRoot?: string): Router {
  const router = Router();
  // GET /sync and GET /command consume commands; never assume GET is pure.
  router.use(recoveryNonMcpHttpFence);
  // Read-only loopback diagnostics: no Goal selection, Companion capability,
  // worker identity or credential is required or returned for this summary.
  router.get("/gate-status", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, gate_status: getRelayGateStatus() });
  });
  router.use(companionAccessGuard);
  router.use(async (req, res, next) => {
    if (!workspaceRoot) { next(); return; }
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const selectors = [req.query.goal_id, req.headers["x-relay-goal-id"], body?.goal_id]
        .filter((value) => value !== undefined);
      if (selectors.some((value) => typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f]/.test(value))) {
        res.status(400).json({ ok: false, error: "RELAY_GOAL_SCOPE_INVALID" }); return;
      }
      const ids = new Set((selectors as string[]).map((value) => value.trim()));
      if (ids.size > 1) { res.status(409).json({ ok: false, error: "RELAY_GOAL_SCOPE_MISMATCH" }); return; }
      let goalId = [...ids][0];
      const ack = /^\/commands\/([^/]+)\/ack$/.exec(req.path);
      if (ack) {
        const commandGoal = await resolveRelayGoalForTransition(workspaceRoot, decodeURIComponent(ack[1]));
        if (commandGoal && goalId && commandGoal !== goalId) {
          res.status(409).json({ ok: false, error: "RELAY_COMMAND_GOAL_SCOPE_MISMATCH" }); return;
        }
        goalId = goalId || commandGoal || "";
      }
      if (!goalId) {
        if (req.method === "GET" && req.path === "/status") {
          res.json({ ok: true, discovery_only: true, goal_id: null, goals: await listRelayGoalIds(workspaceRoot),
            automation_enabled: false, manager: null, workers: null, driver: null, prepared_handoff: null });
        } else res.status(409).json({ ok: false, error: "RELAY_GOAL_SCOPE_REQUIRED: select the Goal for this Companion request" });
        return;
      }
      withRelayGoal(workspaceRoot, goalId, () => next());
    } catch (error) {
      res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/status", async (_req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    try {
      const [manager, driver, workers] = await Promise.all([
        readRelayManagerState(workspaceRoot),
        readDriverLease(workspaceRoot),
        readWorkerRegistry(workspaceRoot),
      ]);
      const prepared = driver?.prepared_handoff_id
        ? await readHandoffSnapshot(workspaceRoot, driver.prepared_handoff_id)
        : null;
      const controlPlane = assessRelayControlPlane(manager, workers, driver);
      const managerView = {
        goal_id: manager.goal_id,
        schema_version: manager.schema_version,
        revision: manager.revision,
        active_lane: manager.active_lane,
        lanes: Object.fromEntries((["A", "B"] as const).map((lane) => {
          const laneState = manager.lanes[lane];
          const workerId = laneState.active_worker_id || laneState.standby_worker_id || laneState.replacement_worker_id;
          const worker = workerId ? workers.workers[workerId] : undefined;
          const compatibilityObservation = laneState.observation || (worker ? {
            lane,
            tab_instance_id: worker.tab_instance_id,
            conversation_url: worker.conversation_url,
            adapter_version: worker.adapter_version,
            adapter_confidence: worker.adapter_confidence,
            conversation_surface: worker.conversation_surface ?? "UNKNOWN",
            composer_ready: worker.composer_ready,
            generation_active: worker.generation_active,
            connection_interrupted: worker.connection_interrupted,
            activity_revision: worker.activity_revision,
            turn_id: worker.turn_id ?? null,
            turn_started_at: worker.turn_started_at ?? null,
            stop_button_visible: worker.stop_button_visible ?? false,
            retry_visible: worker.retry_visible ?? false,
            tool_inflight_count: worker.tool_inflight_count ?? 0,
            assistant_token_revision: worker.assistant_token_revision ?? 0,
            last_dom_activity_at: worker.last_dom_activity_at ?? null,
            last_assistant_token_at: worker.last_assistant_token_at ?? null,
            last_mcp_activity_at: worker.last_mcp_seen_at,
            stable_observation_windows: worker.stable_observation_windows ?? 0,
            last_seen_at: worker.last_browser_seen_at,
          } : null);
          return [lane, {
            ...laneState,
            ...(compatibilityObservation || {}),
          }];
        })),
        updated_at: manager.updated_at,
        migrated_from_v1: manager.migrated_from_v1,
      };
      res.json({
        ok: true,
        goal_id: currentRelayGoal(workspaceRoot),
        automation_enabled: relayAutomationEnabled(),
        control_plane: controlPlane,
        // Keep the v1 lane observation fields at manager.lanes.<lane> while
        // exposing the v2 Worker projection. This lets an old Companion read
        // tab_instance_id/conversation_url during the rolling upgrade without
        // making browser identity authoritative again.
        manager: managerView,
        // Browser Companion only needs operational Worker identity/status.
        // Session bindings and claim-token material stay on the trusted MCP
        // side even though the loopback endpoint is bearer protected.
        workers: companionWorkerRegistryView(workers),
        driver: driver ? {
          goal_id: driver.goal_id,
          epoch: driver.epoch,
          state: driver.state,
          prepared_handoff_id: driver.prepared_handoff_id,
        } : null,
        prepared_handoff: prepared ? {
          handoff_id: prepared.handoff_id,
          goal_id: prepared.goal_id,
          goal_revision: prepared.goal_revision,
          state: prepared.state,
        } : null,
      });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  // v2 Goal sync is owned by the extension service worker, not a Chat tab.
  // It is the wake-up/reconciliation path when all ChatGPT tabs are gone.
  router.get("/sync", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const companionInstanceId = typeof req.query.companion_instance_id === "string"
      ? req.query.companion_instance_id.trim()
      : "";
    if (!companionInstanceId) {
      res.status(400).json({ ok: false, error: "companion_instance_id is required" });
      return;
    }
    try {
      const [command, manager, workers] = await Promise.all([
        claimCompanionCommand(workspaceRoot, companionInstanceId),
        readRelayManagerState(workspaceRoot),
        readWorkerRegistry(workspaceRoot),
      ]);
      res.json({ ok: true, goal_id: currentRelayGoal(workspaceRoot), command, manager_revision: manager.revision, worker_registry_revision: workers.revision });
    } catch (error) {
      res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/workers", async (_req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    try {
      res.json({ ok: true, registry: companionWorkerRegistryView(await readWorkerRegistry(workspaceRoot)) });
    } catch (error) {
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/lanes/:lane/replace", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const lane = req.params.lane;
    if (!validLane(lane)) {
      res.status(400).json({ ok: false, error: "lane must be A or B" });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 300) : "operator_replace";
    try {
      const result = await requestRelayLaneReplacement(workspaceRoot, lane, reason);
      res.status(202).json({ ok: true, worker: result.worker, command: result.command, manager: result.manager });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.startsWith("COMPANION_DISABLED") ? 503 : 409).json({ ok: false, error: message });
    }
  });

  router.post("/lanes/:lane/heartbeat", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const lane = req.params.lane;
    const body = req.body as Record<string, unknown> | undefined;
    if (!validLane(lane) || !body ||
        typeof body.tab_instance_id !== "string" ||
        typeof body.conversation_url !== "string" ||
        typeof body.adapter_version !== "string" ||
        typeof body.composer_ready !== "boolean" ||
        typeof body.generation_active !== "boolean" ||
        typeof body.connection_interrupted !== "boolean" ||
        (body.conversation_surface !== undefined && !validConversationSurface(body.conversation_surface)) ||
        (body.adapter_confidence !== undefined && !validConfidence(body.adapter_confidence)) ||
        (body.tool_inflight_count !== undefined && safeInteger(body.tool_inflight_count) === undefined) ||
        (body.tool_activity_count !== undefined && safeInteger(body.tool_activity_count) === undefined) ||
        (body.activity_revision !== undefined && safeInteger(body.activity_revision) === undefined) ||
        (body.assistant_token_revision !== undefined && safeInteger(body.assistant_token_revision) === undefined) ||
        (body.turn_id !== undefined && body.turn_id !== null && typeof body.turn_id !== "string") ||
        (body.turn_started_at !== undefined && body.turn_started_at !== null && typeof body.turn_started_at !== "string") ||
        (body.stop_button_visible !== undefined && typeof body.stop_button_visible !== "boolean") ||
        (body.retry_visible !== undefined && typeof body.retry_visible !== "boolean") ||
        (body.feedback_ledger !== undefined && (!body.feedback_ledger || typeof body.feedback_ledger !== "object" || Array.isArray(body.feedback_ledger)))) {
      res.status(400).json({ ok: false, error: "Invalid Browser Companion heartbeat" });
      return;
    }
    try {
      const state = await recordRelayLaneHeartbeat(workspaceRoot, {
        lane,
        tab_instance_id: body.tab_instance_id,
        conversation_url: body.conversation_url,
        adapter_version: body.adapter_version,
        adapter_confidence: body.adapter_confidence as RelayAdapterConfidence | undefined,
        conversation_surface: validConversationSurface(body.conversation_surface) ? body.conversation_surface : "UNKNOWN",
        composer_ready: body.composer_ready,
        generation_active: body.generation_active,
        connection_interrupted: body.connection_interrupted,
        tool_inflight_count: safeInteger(body.tool_inflight_count),
        tool_activity_count: safeInteger(body.tool_activity_count),
        activity_revision: safeInteger(body.activity_revision),
        turn_id: typeof body.turn_id === "string" ? body.turn_id : null,
        turn_started_at: typeof body.turn_started_at === "string" ? body.turn_started_at : null,
        stop_button_visible: body.stop_button_visible as boolean | undefined,
        retry_visible: body.retry_visible as boolean | undefined,
        assistant_token_revision: safeInteger(body.assistant_token_revision),
        feedback_ledger: body.feedback_ledger,
      });
      res.json({ ok: true, lane: state.lanes[lane], active_lane: state.active_lane });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.startsWith("RELAY_LANE_CONFLICT") ? 409 : 400).json({ ok: false, error: message });
    }
  });

  router.post("/workers/:workerId/heartbeat", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const workerId = req.params.workerId;
    const body = req.body as Record<string, unknown> | undefined;
    const lane = body?.lane;
    const generation = safeInteger(body?.generation);
    if (!body || !validLane(lane) || generation === undefined || generation < 1 ||
        typeof body.provision_id !== "string" ||
        typeof body.tab_instance_id !== "string" ||
        typeof body.conversation_url !== "string" ||
        typeof body.adapter_version !== "string" ||
        typeof body.composer_ready !== "boolean" ||
        typeof body.generation_active !== "boolean" ||
        typeof body.connection_interrupted !== "boolean" ||
        (body.conversation_surface !== undefined && !validConversationSurface(body.conversation_surface)) ||
        (body.companion_instance_id !== undefined && typeof body.companion_instance_id !== "string") ||
        (body.adapter_confidence !== undefined && !validConfidence(body.adapter_confidence)) ||
        (body.tool_inflight_count !== undefined && safeInteger(body.tool_inflight_count) === undefined) ||
        (body.activity_revision !== undefined && safeInteger(body.activity_revision) === undefined) ||
        (body.assistant_token_revision !== undefined && safeInteger(body.assistant_token_revision) === undefined) ||
        (body.turn_id !== undefined && body.turn_id !== null && typeof body.turn_id !== "string") ||
        (body.turn_started_at !== undefined && body.turn_started_at !== null && typeof body.turn_started_at !== "string") ||
        (body.stop_button_visible !== undefined && typeof body.stop_button_visible !== "boolean") ||
        (body.retry_visible !== undefined && typeof body.retry_visible !== "boolean") ||
        (body.feedback_ledger !== undefined && (!body.feedback_ledger || typeof body.feedback_ledger !== "object" || Array.isArray(body.feedback_ledger)))) {
      res.status(400).json({ ok: false, error: "Invalid Worker heartbeat" });
      return;
    }
    try {
      const state = await recordRelayLaneHeartbeat(workspaceRoot, {
        lane,
        worker_id: workerId,
        generation,
        provision_id: body.provision_id,
        companion_instance_id: typeof body.companion_instance_id === "string" ? body.companion_instance_id : undefined,
        tab_instance_id: body.tab_instance_id,
        conversation_url: body.conversation_url,
        adapter_version: body.adapter_version,
        adapter_confidence: body.adapter_confidence as RelayAdapterConfidence | undefined,
        conversation_surface: validConversationSurface(body.conversation_surface) ? body.conversation_surface : "UNKNOWN",
        composer_ready: body.composer_ready,
        generation_active: body.generation_active,
        connection_interrupted: body.connection_interrupted,
        tool_inflight_count: safeInteger(body.tool_inflight_count),
        activity_revision: safeInteger(body.activity_revision),
        turn_id: typeof body.turn_id === "string" ? body.turn_id : null,
        turn_started_at: typeof body.turn_started_at === "string" ? body.turn_started_at : null,
        stop_button_visible: body.stop_button_visible as boolean | undefined,
        retry_visible: body.retry_visible as boolean | undefined,
        assistant_token_revision: safeInteger(body.assistant_token_revision),
        feedback_ledger: body.feedback_ledger,
      });
      const registry = await readWorkerRegistry(workspaceRoot);
      res.json({ ok: true, worker: registry.workers[workerId] ?? null, lane: state.lanes[lane], active_lane: state.active_lane });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.startsWith("WORKER_NOT_FOUND") ? 404 : message.startsWith("VISIBLE_FEEDBACK_LEDGER_INVALID") ? 400 : 409).json({ ok: false, error: message });
    }
  });

  router.get("/lanes/:lane/command", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const lane = req.params.lane;
    const tabInstanceId = typeof req.query.tab_instance_id === "string" ? req.query.tab_instance_id.trim() : "";
    if (!validLane(lane) || !tabInstanceId) {
      res.status(400).json({ ok: false, error: "lane and tab_instance_id are required" });
      return;
    }
    try {
      const workerId = typeof req.query.worker_id === "string" ? req.query.worker_id.trim() : undefined;
      const command = await claimRelayCommand(workspaceRoot, lane, tabInstanceId, workerId);
      res.json({ ok: true, command });
    } catch (error) {
      res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get("/workers/:workerId/command", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const lane = typeof req.query.lane === "string" ? req.query.lane : "";
    const tabInstanceId = typeof req.query.tab_instance_id === "string" ? req.query.tab_instance_id.trim() : "";
    if (!validLane(lane) || !tabInstanceId) {
      res.status(400).json({ ok: false, error: "lane and tab_instance_id are required" });
      return;
    }
    try {
      const command = await claimRelayCommand(workspaceRoot, lane, tabInstanceId, req.params.workerId);
      res.json({ ok: true, command });
    } catch (error) {
      res.status(409).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/commands/:commandId/ack", async (req, res) => {
    if (!workspaceRoot) {
      res.status(503).json({ ok: false, error: "Workspace root is unavailable" });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const tabInstanceId = typeof body?.tab_instance_id === "string" ? body.tab_instance_id.trim() : "";
    const companionInstanceId = typeof body?.companion_instance_id === "string" ? body.companion_instance_id.trim() : "";
    const status = body?.status;
    const detail = typeof body?.detail === "string" ? body.detail : undefined;
    const claimant = tabInstanceId || companionInstanceId;
    if (!claimant || (status !== "sent" && status !== "failed" && status !== "ambiguous")) {
      res.status(400).json({ ok: false, error: "tab_instance_id or companion_instance_id and status=sent|failed|ambiguous are required" });
      return;
    }
    try {
      const command = await acknowledgeRelayCommand(
        workspaceRoot,
        req.params.commandId,
        claimant,
        status,
        detail
      );
      res.json({ ok: true, command });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(message.startsWith("RELAY_COMMAND_NOT_FOUND") ? 404 : 409).json({ ok: false, error: message });
    }
  });

  return router;
}
