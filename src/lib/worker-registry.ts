import { currentRelayGoal, requireRelayGoal, withRelayGoal, withResolvedRelayGoal, relayGoalPath, relayScopeKey, readRelayStateText, ensureRelayGoalStorage, resolveRelayGoalForTransition, resolveRelayGoalForSession, listRelayGoalIds } from "./relay-scope.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTextFileCas } from "./safe-text-write.js";
import { normalizeVisibleFeedbackLedger, type VisibleFeedbackLedger } from "./visible-feedback-ledger.js";

const WORKER_REGISTRY_SCHEMA_VERSION = 1 as const;
const MAX_WORKERS = 96;
const MAX_JOURNAL_EVENTS = 512;
const DEFAULT_CLAIM_TTL_MS = 3 * 60_000;

export type WorkerLaneId = "A" | "B";
export type WorkerConversationSurface = "CHAT" | "WORK" | "UNKNOWN";
export type WorkerState =
  | "REQUESTED"
  | "PROVISIONING"
  | "TAB_CREATED"
  | "READY_BLANK"
  | "ACTIVATING"
  | "READY"
  | "ACTIVE"
  | "DRAINING"
  | "RETIRED"
  | "PROVISION_AMBIGUOUS"
  | "SUSPECT"
  | "ORPHAN_CANDIDATE"
  | "DEAD"
  | "FAILED";
export type WorkerClaimKind = "PROBE" | "HANDOFF" | "RECOVERY";

export interface WorkerRecord {
  readonly worker_id: string;
  readonly lane: WorkerLaneId;
  readonly generation: number;
  readonly state: WorkerState;
  readonly record_revision: number;
  readonly goal_id: string | null;
  readonly bound_session_id: string | null;
  readonly companion_instance_id: string | null;
  readonly tab_instance_id: string | null;
  readonly conversation_url: string | null;
  readonly adapter_version: string | null;
  readonly adapter_confidence: "high" | "medium" | "low" | "unknown";
  readonly conversation_surface: WorkerConversationSurface;
  readonly composer_ready: boolean;
  readonly generation_active: boolean;
  readonly connection_interrupted: boolean;
  readonly activity_revision: number;
  readonly turn_id: string | null;
  readonly turn_started_at: string | null;
  readonly stop_button_visible: boolean;
  readonly retry_visible: boolean;
  readonly tool_inflight_count: number;
  readonly assistant_token_revision: number;
  readonly feedback_ledger?: VisibleFeedbackLedger;
  readonly last_dom_activity_at: string | null;
  readonly last_assistant_token_at: string | null;
  readonly stable_observation_windows: number;
  readonly provision_id: string;
  readonly provision_attempt_id: string;
  readonly provision_reason: string;
  readonly claim_kind: WorkerClaimKind | null;
  readonly claim_nonce: string | null;
  readonly claim_token_hash: string | null;
  readonly claim_handoff_id: string | null;
  readonly claim_expires_at: string | null;
  readonly claim_consumed_at: string | null;
  readonly claim_session_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly ready_at: string | null;
  readonly activated_at: string | null;
  readonly last_browser_seen_at: string | null;
  readonly last_mcp_seen_at: string | null;
  readonly last_capability_probe_id: string | null;
  readonly last_capability_at: string | null;
  readonly successor_worker_id: string | null;
  readonly retired_at: string | null;
  readonly death_reason: string | null;
}

export interface WorkerLaneState {
  readonly active_worker_id: string | null;
  readonly standby_worker_id: string | null;
  readonly next_generation: number;
}

export interface WorkerRegistryEvent {
  readonly goal_id?: string;
  readonly event_id: string;
  readonly registry_revision: number;
  readonly worker_id: string;
  readonly lane: WorkerLaneId;
  readonly kind: string;
  readonly from_state: WorkerState | null;
  readonly to_state: WorkerState;
  readonly detail: string | null;
  readonly at: string;
}

export interface WorkerRegistryState {
  readonly goal_id: string;
  readonly fenced_at?: string;
  readonly fence_reason?: string;
  readonly schema_version: typeof WORKER_REGISTRY_SCHEMA_VERSION;
  readonly revision: number;
  readonly lanes: Readonly<Record<WorkerLaneId, WorkerLaneState>>;
  readonly workers: Readonly<Record<string, WorkerRecord>>;
  readonly journal: readonly WorkerRegistryEvent[];
  readonly updated_at: string;
}

export interface LegacyWorkerObservation {
  readonly tab_instance_id: string;
  readonly conversation_url: string;
  readonly adapter_version?: string;
  readonly adapter_confidence?: "high" | "medium" | "low" | "unknown";
  readonly conversation_surface?: WorkerConversationSurface;
  readonly composer_ready: boolean;
  readonly generation_active: boolean;
  readonly connection_interrupted?: boolean;
  readonly activity_revision?: number;
  readonly turn_id?: string | null;
  readonly turn_started_at?: string | null;
  readonly stop_button_visible?: boolean;
  readonly retry_visible?: boolean;
  readonly tool_inflight_count?: number;
  readonly assistant_token_revision?: number;
  readonly last_dom_activity_at?: string | null;
  readonly last_assistant_token_at?: string | null;
  readonly stable_observation_windows?: number;
  readonly last_seen_at: string;
}

export interface WorkerClaimTicket {
  readonly goal_id: string;
  readonly worker_id: string;
  readonly lane: WorkerLaneId;
  readonly generation: number;
  readonly kind: WorkerClaimKind;
  readonly handoff_id: string;
  readonly token: string;
  readonly expires_at: string;
  readonly registry_revision: number;
}

interface StateFile {
  readonly state: WorkerRegistryState;
  readonly sha256: string;
}

const mutationChains = new Map<string, Promise<void>>();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

function projectSlug(workspaceRoot: string): string {
  return sha256(workspaceKey(workspaceRoot)).slice(0, 12);
}

function relayRoot(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", projectSlug(workspaceRoot), "relay");
}

export function workerRegistryPath(workspaceRoot: string, goalId?: string): string {
  return relayGoalPath(workspaceRoot, "workers.json", goalId);
}

/**
 * Long-lived lifecycle history. workers.json intentionally keeps a bounded
 * diagnostic journal, while this append-only stream survives registry
 * compaction and is the recovery/audit source for Worker transitions.
 */
export function workerTransitionJournalPath(workspaceRoot: string, goalId?: string): string {
  return relayGoalPath(workspaceRoot, "transitions.ndjson", goalId);
}

function initialState(goalId: string, now = new Date().toISOString()): WorkerRegistryState {
  return Object.freeze({
    schema_version: WORKER_REGISTRY_SCHEMA_VERSION,
    goal_id: goalId,
    revision: 0,
    lanes: Object.freeze({
      A: Object.freeze({ active_worker_id: null, standby_worker_id: null, next_generation: 1 }),
      B: Object.freeze({ active_worker_id: null, standby_worker_id: null, next_generation: 1 }),
    }),
    workers: Object.freeze({}),
    journal: Object.freeze([]),
    updated_at: now,
  });
}

function validLane(value: unknown): value is WorkerLaneId {
  return value === "A" || value === "B";
}

const WORKER_STATES = new Set<WorkerState>([
  "REQUESTED", "PROVISIONING", "TAB_CREATED", "READY_BLANK", "ACTIVATING", "READY", "ACTIVE",
  "DRAINING", "RETIRED", "PROVISION_AMBIGUOUS", "SUSPECT", "ORPHAN_CANDIDATE", "DEAD", "FAILED",
]);
const WORKER_CONVERSATION_SURFACES = new Set<WorkerConversationSurface>(["CHAT", "WORK", "UNKNOWN"]);

function parseState(raw: string, file: string): WorkerRegistryState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`WORKER_REGISTRY_UNREADABLE: invalid JSON at ${file}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WORKER_REGISTRY_UNREADABLE: invalid state at ${file}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== WORKER_REGISTRY_SCHEMA_VERSION ||
    !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 ||
    !record.lanes || typeof record.lanes !== "object" || Array.isArray(record.lanes) ||
    !record.workers || typeof record.workers !== "object" || Array.isArray(record.workers) ||
    !Array.isArray(record.journal) || typeof record.updated_at !== "string"
  ) {
    throw new Error(`WORKER_REGISTRY_UNREADABLE: unsupported or malformed state at ${file}`);
  }
  const lanes = record.lanes as Record<string, unknown>;
  for (const lane of ["A", "B"] as const) {
    const laneValue = lanes[lane];
    if (!laneValue || typeof laneValue !== "object" || Array.isArray(laneValue)) {
      throw new Error(`WORKER_REGISTRY_UNREADABLE: missing lane ${lane} at ${file}`);
    }
    const laneRecord = laneValue as Record<string, unknown>;
    if (
      !(laneRecord.active_worker_id === null || typeof laneRecord.active_worker_id === "string") ||
      !(laneRecord.standby_worker_id === null || typeof laneRecord.standby_worker_id === "string") ||
      !Number.isSafeInteger(laneRecord.next_generation) || Number(laneRecord.next_generation) < 1
    ) {
      throw new Error(`WORKER_REGISTRY_UNREADABLE: malformed lane ${lane} at ${file}`);
    }
  }
  const workers = record.workers as Record<string, unknown>;
  for (const [workerId, rawWorker] of Object.entries(workers)) {
    if (!rawWorker || typeof rawWorker !== "object" || Array.isArray(rawWorker)) {
      throw new Error(`WORKER_REGISTRY_UNREADABLE: malformed worker ${workerId} at ${file}`);
    }
    const worker = rawWorker as Record<string, unknown>;
    if (worker.goal_id !== record.goal_id &&
        (worker.goal_id || !["RETIRED", "DEAD", "FAILED"].includes(String(worker.state)))) {
      throw new Error(`WORKER_GOAL_SCOPE_MISMATCH: ${workerId}`);
    }
    if (
      worker.worker_id !== workerId || !validLane(worker.lane) ||
      !Number.isSafeInteger(worker.generation) || Number(worker.generation) < 1 ||
      !WORKER_STATES.has(worker.state as WorkerState) ||
      !Number.isSafeInteger(worker.record_revision) || Number(worker.record_revision) < 1 ||
      typeof worker.provision_id !== "string" || typeof worker.provision_attempt_id !== "string" ||
      typeof worker.created_at !== "string" || typeof worker.updated_at !== "string"
    ) {
      throw new Error(`WORKER_REGISTRY_UNREADABLE: malformed worker ${workerId} at ${file}`);
    }
    if (worker.conversation_surface !== undefined && !WORKER_CONVERSATION_SURFACES.has(worker.conversation_surface as WorkerConversationSurface)) {
      throw new Error(`WORKER_REGISTRY_UNREADABLE: invalid conversation surface for ${workerId} at ${file}`);
    }
  }
  return {
    ...record,
    workers: Object.fromEntries(Object.entries(workers).map(([workerId, rawWorker]) => [
      workerId,
      { ...(rawWorker as Record<string, unknown>), conversation_surface: (rawWorker as Record<string, unknown>).conversation_surface ?? "UNKNOWN" },
    ])),
  } as unknown as WorkerRegistryState;
}

async function readStateFile(workspaceRoot: string): Promise<StateFile | null> {
  const file = workerRegistryPath(workspaceRoot);
  try {
    const raw = await readRelayStateText(workspaceRoot, "workers.json");
    if (raw === null) return null;
    const state = parseState(raw, file);
    if (state.goal_id !== requireRelayGoal(workspaceRoot)) throw new Error("WORKER_GOAL_SCOPE_MISMATCH");
    return { state, sha256: sha256(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withMutationLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = relayScopeKey(workspaceRoot);
  const previous = mutationChains.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => gate);
  mutationChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    await ensureRelayGoalStorage(workspaceRoot);
    return await operation();
  } finally {
    release();
    if (mutationChains.get(key) === chain) mutationChains.delete(key);
  }
}

async function mutateRegistry(
  workspaceRoot: string,
  mutation: (current: WorkerRegistryState) => WorkerRegistryState,
  expectedRevision?: number
): Promise<WorkerRegistryState> {
  return withMutationLock(workspaceRoot, async () => {
    const currentFile = await readStateFile(workspaceRoot);
    const current = currentFile?.state ?? initialState(requireRelayGoal(workspaceRoot));
    if (expectedRevision !== undefined && current.revision !== expectedRevision) {
      throw new Error(`WORKER_REGISTRY_STALE_REVISION: expected ${expectedRevision}, current ${current.revision}`);
    }
    const next = mutation(current);
    if (next === current) return current;
    if (current.fenced_at) throw new Error("WORKER_GOAL_FENCED: superseded Goal cannot mutate its Worker registry");
    requireRelayGoal(workspaceRoot, next.goal_id);
    for (const worker of Object.values(next.workers)) {
      if (worker.goal_id !== next.goal_id && (worker.goal_id || !["RETIRED", "DEAD", "FAILED"].includes(worker.state))) {
        throw new Error("WORKER_GOAL_SCOPE_MISMATCH");
      }
    }
    const file = workerRegistryPath(workspaceRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeTextFileCas(
      file,
      `${JSON.stringify(next, null, 2)}\n`,
      currentFile ? { expectedSha256: currentFile.sha256 } : { createOnly: true }
    );
    const durableEvents = next.journal.filter((event) => event.registry_revision > current.revision);
    if (durableEvents.length) {
      const journalFile = workerTransitionJournalPath(workspaceRoot);
      await fs.mkdir(path.dirname(journalFile), { recursive: true });
      await fs.appendFile(journalFile, `${durableEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    }
    return next;
  });
}

export async function readWorkerRegistry(workspaceRoot: string, goalId?: string): Promise<WorkerRegistryState> {
  return withResolvedRelayGoal(workspaceRoot, goalId, async () => (await readStateFile(workspaceRoot))?.state ?? initialState(requireRelayGoal(workspaceRoot)));
}

/** Explicit Goal lifecycle fence. It preserves history and revokes future claims. */
export async function fenceWorkerRegistryForGoal(workspaceRoot: string, goalId: string): Promise<void> {
  await withResolvedRelayGoal(workspaceRoot, goalId, () => mutateRegistry(workspaceRoot, (current) => {
    if (current.fenced_at) return current;
    const now = new Date().toISOString();
    const revision = current.revision + 1;
    let journal = current.journal;
    const entries = Object.fromEntries(Object.entries(current.workers).map(([id, worker]) => {
      if (terminal(worker.state)) return [id, worker];
      const retired: WorkerRecord = Object.freeze({ ...worker, state: "RETIRED", record_revision: worker.record_revision + 1,
        retired_at: now, updated_at: now, death_reason: "goal_superseded", claim_nonce: null,
        claim_token_hash: null, claim_expires_at: null });
      journal = appendEvent({ ...current, journal }, retired, "GOAL_SUPERSEDED", worker.state, "goal_superseded", now, revision);
      return [id, retired];
    }));
    return Object.freeze({ ...current, revision, fenced_at: now, fence_reason: "goal_superseded", updated_at: now,
      workers: Object.freeze(entries), journal,
      lanes: Object.freeze({
        A: Object.freeze({ ...current.lanes.A, active_worker_id: null, standby_worker_id: null }),
        B: Object.freeze({ ...current.lanes.B, active_worker_id: null, standby_worker_id: null }),
      }) });
  }));
}

function appendEvent(
  current: WorkerRegistryState,
  worker: WorkerRecord,
  kind: string,
  fromState: WorkerState | null,
  detail: string | null,
  now: string,
  nextRevision: number
): readonly WorkerRegistryEvent[] {
  const event: WorkerRegistryEvent = Object.freeze({
    goal_id: current.goal_id,
    event_id: `we_${randomUUID()}`,
    registry_revision: nextRevision,
    worker_id: worker.worker_id,
    lane: worker.lane,
    kind,
    from_state: fromState,
    to_state: worker.state,
    detail: detail ? detail.slice(0, 1000) : null,
    at: now,
  });
  return Object.freeze([...current.journal, event].slice(-MAX_JOURNAL_EVENTS));
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 4096) : null;
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function isFormalChatConversationUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return false;
    return /^\/c\/[^/?#]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function workerHasFreshCapability(worker: WorkerRecord | null, nowMs = Date.now(), maxAgeMs = 60_000): boolean {
  // bound_session_id is only established through a verified one-time Worker
  // claim.  A later HANDOFF/RECOVERY ticket may legitimately replace the
  // current claim fields, so readiness must not depend on the *current*
  // claim_consumed_at slot after an earlier capability claim has proved the
  // session.
  if (!worker?.last_capability_at || !worker.bound_session_id) return false;
  const provedAt = Date.parse(worker.last_capability_at);
  return Number.isFinite(provedAt) && nowMs - provedAt <= Math.max(1_000, maxAgeMs);
}

/** Browser/bootstrap eligibility is deliberately weaker than authority READY. */
export function workerReadyForBootstrap(worker: WorkerRecord | null): boolean {
  return Boolean(
    worker &&
    ["READY_BLANK", "ACTIVATING", "READY"].includes(worker.state) &&
    worker.conversation_surface === "CHAT" && worker.tab_instance_id && worker.composer_ready &&
    !worker.generation_active && !worker.connection_interrupted
  );
}

/** Browser truth alone can never grant Driver authority. */
export function workerReadyForAuthority(worker: WorkerRecord | null, nowMs = Date.now(), capabilityFreshMs = 60_000): boolean {
  return Boolean(
    worker && worker.state === "READY" && worker.conversation_surface === "CHAT" && worker.tab_instance_id &&
    isFormalChatConversationUrl(worker.conversation_url) &&
    worker.bound_session_id &&
    workerHasFreshCapability(worker, nowMs, capabilityFreshMs)
  );
}

function activeLike(state: WorkerState): boolean {
  return ["ACTIVE", "DRAINING", "SUSPECT", "ORPHAN_CANDIDATE"].includes(state);
}

function provisionInFlight(state: WorkerState): boolean {
  return ["REQUESTED", "PROVISIONING", "TAB_CREATED", "READY_BLANK", "ACTIVATING", "READY", "PROVISION_AMBIGUOUS"].includes(state);
}

function terminal(state: WorkerState): boolean {
  return state === "RETIRED" || state === "DEAD" || state === "FAILED";
}

function sanitizeReason(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return (trimmed || fallback).slice(0, 300);
}

async function migrateLegacyLaneWorkersScoped(
  workspaceRoot: string,
  legacy: Readonly<Record<WorkerLaneId, LegacyWorkerObservation | null>>,
  activeLane: WorkerLaneId | null
): Promise<WorkerRegistryState> {
  return mutateRegistry(workspaceRoot, (current) => {
    const now = new Date().toISOString();
    let revision = current.revision;
    const workers: Record<string, WorkerRecord> = { ...current.workers };
    const lanes: Record<WorkerLaneId, WorkerLaneState> = {
      A: { ...current.lanes.A },
      B: { ...current.lanes.B },
    };
    let journal = [...current.journal];
    let changed = false;
    for (const lane of ["A", "B"] as const) {
      const observation = legacy[lane];
      if (!observation) continue;
      const existing = Object.values(workers).find((worker) => worker.lane === lane);
      if (existing) {
        // v1 compatibility: a migrated Worker remains management-plane only,
        // but its browser observation must keep following the current legacy
        // lane heartbeat. Never infer/overwrite bound_session_id or Driver
        // authority from URL/tab identity.
        if (existing.provision_id.startsWith("legacy_")) {
          const nextUrl = normalizeUrl(observation.conversation_url);
          const nextConfidence = observation.adapter_confidence ?? "unknown";
          const nextActivityRevision = Math.max(0, Math.trunc(observation.activity_revision ?? 0));
          const browserChanged =
            existing.tab_instance_id !== observation.tab_instance_id ||
            existing.conversation_url !== nextUrl ||
            existing.adapter_version !== (observation.adapter_version?.trim() || null) ||
            existing.adapter_confidence !== nextConfidence ||
            existing.composer_ready !== observation.composer_ready ||
            existing.generation_active !== observation.generation_active ||
            existing.connection_interrupted !== (observation.connection_interrupted ?? false) ||
            existing.activity_revision !== nextActivityRevision ||
            existing.turn_id !== (observation.turn_id ?? null) ||
            existing.stop_button_visible !== (observation.stop_button_visible ?? false) ||
            existing.retry_visible !== (observation.retry_visible ?? false) ||
            existing.tool_inflight_count !== Math.max(0, Math.trunc(observation.tool_inflight_count ?? 0)) ||
            existing.assistant_token_revision !== Math.max(0, Math.trunc(observation.assistant_token_revision ?? 0)) ||
            existing.stable_observation_windows !== Math.max(0, Math.trunc(observation.stable_observation_windows ?? 0)) ||
            existing.last_browser_seen_at !== observation.last_seen_at;
          if (browserChanged) {
            revision += 1;
            changed = true;
            workers[existing.worker_id] = Object.freeze({
              ...existing,
              record_revision: existing.record_revision + 1,
              tab_instance_id: observation.tab_instance_id,
              conversation_url: nextUrl,
              adapter_version: observation.adapter_version?.trim() || null,
              adapter_confidence: nextConfidence,
              conversation_surface: observation.conversation_surface ?? "UNKNOWN",
              composer_ready: observation.composer_ready,
              generation_active: observation.generation_active,
              connection_interrupted: observation.connection_interrupted ?? false,
              activity_revision: nextActivityRevision,
              turn_id: observation.turn_id ?? null,
              turn_started_at: observation.turn_started_at ?? null,
              stop_button_visible: observation.stop_button_visible ?? false,
              retry_visible: observation.retry_visible ?? false,
              tool_inflight_count: Math.max(0, Math.trunc(observation.tool_inflight_count ?? 0)),
              assistant_token_revision: Math.max(0, Math.trunc(observation.assistant_token_revision ?? 0)),
              last_dom_activity_at: observation.last_dom_activity_at ?? null,
              last_assistant_token_at: observation.last_assistant_token_at ?? null,
              stable_observation_windows: Math.max(0, Math.trunc(observation.stable_observation_windows ?? 0)),
              last_browser_seen_at: observation.last_seen_at || now,
              updated_at: now,
            });
          }
        }
        continue;
      }
      revision += 1;
      changed = true;
      const workerId = `${lane}:g1`;
      const chatSurface = observation.conversation_surface === "CHAT";
      const state: WorkerState = activeLane === lane && chatSurface
        ? "ACTIVE"
        : (chatSurface && observation.composer_ready && !observation.generation_active ? "READY" : "READY_BLANK");
      const worker: WorkerRecord = Object.freeze({
        worker_id: workerId,
        lane,
        generation: 1,
        state,
        record_revision: 1,
        goal_id: requireRelayGoal(workspaceRoot),
        bound_session_id: null,
        companion_instance_id: null,
        tab_instance_id: observation.tab_instance_id,
        conversation_url: normalizeUrl(observation.conversation_url),
        adapter_version: observation.adapter_version?.trim() || null,
        adapter_confidence: observation.adapter_confidence ?? "unknown",
        conversation_surface: observation.conversation_surface ?? "UNKNOWN",
        composer_ready: observation.composer_ready,
        generation_active: observation.generation_active,
        connection_interrupted: observation.connection_interrupted ?? false,
        activity_revision: Math.max(0, Math.trunc(observation.activity_revision ?? 0)),
        turn_id: observation.turn_id ?? null,
        turn_started_at: observation.turn_started_at ?? null,
        stop_button_visible: observation.stop_button_visible ?? false,
        retry_visible: observation.retry_visible ?? false,
        tool_inflight_count: Math.max(0, Math.trunc(observation.tool_inflight_count ?? 0)),
        assistant_token_revision: Math.max(0, Math.trunc(observation.assistant_token_revision ?? 0)),
        last_dom_activity_at: observation.last_dom_activity_at ?? null,
        last_assistant_token_at: observation.last_assistant_token_at ?? null,
        stable_observation_windows: Math.max(0, Math.trunc(observation.stable_observation_windows ?? 0)),
        provision_id: `legacy_${lane.toLowerCase()}_g1`,
        provision_attempt_id: `legacy_${lane.toLowerCase()}_g1`,
        provision_reason: "manager_v1_migration",
        claim_kind: null,
        claim_nonce: null,
        claim_token_hash: null,
        claim_handoff_id: null,
        claim_expires_at: null,
        claim_consumed_at: null,
        claim_session_id: null,
        created_at: observation.last_seen_at || now,
        updated_at: now,
        ready_at: observation.composer_ready ? now : null,
        activated_at: activeLane === lane && chatSurface ? now : null,
        last_browser_seen_at: observation.last_seen_at || now,
        last_mcp_seen_at: null,
        last_capability_probe_id: null,
        last_capability_at: null,
        successor_worker_id: null,
        retired_at: null,
        death_reason: null,
      });
      workers[workerId] = worker;
      lanes[lane] = Object.freeze({
        active_worker_id: activeLane === lane && chatSurface ? workerId : null,
        standby_worker_id: activeLane === lane && chatSurface ? null : workerId,
        next_generation: 2,
      });
      const evt: WorkerRegistryEvent = Object.freeze({
        event_id: `we_${randomUUID()}`,
        registry_revision: revision,
        worker_id: workerId,
        lane,
        kind: "MIGRATE_V1",
        from_state: null,
        to_state: state,
        detail: "Imported browser identity only; bound_session_id intentionally remains unknown.",
        at: now,
      });
      journal = [...journal, evt].slice(-MAX_JOURNAL_EVENTS);
    }
    if (!changed) return current;
    return Object.freeze({
      schema_version: WORKER_REGISTRY_SCHEMA_VERSION,
      goal_id: requireRelayGoal(workspaceRoot),
      revision,
      lanes: Object.freeze({ A: Object.freeze(lanes.A), B: Object.freeze(lanes.B) }),
      workers: Object.freeze(workers),
      journal: Object.freeze(journal),
      updated_at: now,
    });
  });
}

async function requestWorkerProvisionScoped(
  workspaceRoot: string,
  input: { lane: WorkerLaneId; goalId?: string | null; reason?: string; forceNew?: boolean; expectedRevision?: number }
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord; created: boolean }> {
  let selectedId = "";
  let created = false;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const existing = input.forceNew ? undefined : Object.values(current.workers)
      .filter((worker) => worker.lane === input.lane && provisionInFlight(worker.state))
      .sort((a, b) => b.generation - a.generation)[0];
    if (existing) {
      selectedId = existing.worker_id;
      const lane = current.lanes[input.lane];
      if (lane.active_worker_id === existing.worker_id || lane.standby_worker_id === existing.worker_id) {
        return current;
      }
      // A previous active generation can leave an older, still-live
      // READY_BLANK/READY Worker detached from both lane slots. Reusing that
      // Worker without restoring the lane pointer makes every automation poll
      // believe the pool is empty and enqueue the same provision forever.
      const now = new Date().toISOString();
      const nextRevision = current.revision + 1;
      return Object.freeze({
        ...current,
        revision: nextRevision,
        lanes: Object.freeze({
          ...current.lanes,
          [input.lane]: Object.freeze({ ...lane, standby_worker_id: existing.worker_id }),
        }),
        journal: appendEvent(current, existing, "PROVISION_REATTACHED", existing.state, input.reason ?? null, now, nextRevision),
        updated_at: now,
      });
    }
    if (Object.keys(current.workers).length >= MAX_WORKERS) {
      throw new Error("WORKER_REGISTRY_CAPACITY: retire old workers before provisioning another generation");
    }
    const now = new Date().toISOString();
    const generation = current.lanes[input.lane].next_generation;
    const workerId = `${input.lane}:g${generation}`;
    if (current.workers[workerId]) throw new Error(`WORKER_GENERATION_CONFLICT: ${workerId} already exists`);
    const worker: WorkerRecord = Object.freeze({
      worker_id: workerId,
      lane: input.lane,
      generation,
      state: "REQUESTED",
      record_revision: 1,
      goal_id: requireRelayGoal(workspaceRoot, input.goalId ?? undefined),
      bound_session_id: null,
      companion_instance_id: null,
      tab_instance_id: null,
      conversation_url: null,
      adapter_version: null,
      adapter_confidence: "unknown",
      conversation_surface: "UNKNOWN",
      composer_ready: false,
      generation_active: false,
      connection_interrupted: false,
      activity_revision: 0,
      turn_id: null,
      turn_started_at: null,
      stop_button_visible: false,
      retry_visible: false,
      tool_inflight_count: 0,
      assistant_token_revision: 0,
      last_dom_activity_at: null,
      last_assistant_token_at: null,
      stable_observation_windows: 0,
      provision_id: `pv_${randomUUID()}`,
      provision_attempt_id: `pva_${randomUUID()}`,
      provision_reason: sanitizeReason(input.reason, "automatic_pool_repair"),
      claim_kind: null,
      claim_nonce: null,
      claim_token_hash: null,
      claim_handoff_id: null,
      claim_expires_at: null,
      claim_consumed_at: null,
      claim_session_id: null,
      created_at: now,
      updated_at: now,
      ready_at: null,
      activated_at: null,
      last_browser_seen_at: null,
      last_mcp_seen_at: null,
      last_capability_probe_id: null,
      last_capability_at: null,
      successor_worker_id: null,
      retired_at: null,
      death_reason: null,
    });
    const nextRevision = current.revision + 1;
    const lane = Object.freeze({
      ...current.lanes[input.lane],
      standby_worker_id: workerId,
      next_generation: generation + 1,
    });
    selectedId = workerId;
    created = true;
    return Object.freeze({
      ...current,
      revision: nextRevision,
      lanes: Object.freeze({ ...current.lanes, [input.lane]: lane }),
      workers: Object.freeze({ ...current.workers, [workerId]: worker }),
      journal: appendEvent(current, worker, "PROVISION_REQUESTED", null, worker.provision_reason, now, nextRevision),
      updated_at: now,
    });
  }, input.expectedRevision);
  const worker = registry.workers[selectedId];
  if (!worker) throw new Error("WORKER_REGISTRY_INTERNAL: provisioned worker disappeared");
  return { registry, worker, created };
}

const ALLOWED_TRANSITIONS: Readonly<Record<WorkerState, readonly WorkerState[]>> = Object.freeze({
  REQUESTED: ["PROVISIONING", "FAILED"],
  PROVISIONING: ["TAB_CREATED", "PROVISION_AMBIGUOUS", "FAILED"],
  TAB_CREATED: ["READY_BLANK", "PROVISION_AMBIGUOUS", "FAILED"],
  READY_BLANK: ["ACTIVATING", "READY", "FAILED", "DEAD"],
  ACTIVATING: ["READY", "PROVISION_AMBIGUOUS", "FAILED", "DEAD"],
  READY: ["ACTIVE", "ACTIVATING", "RETIRED", "DEAD", "FAILED"],
  ACTIVE: ["DRAINING", "SUSPECT", "RETIRED", "DEAD"],
  DRAINING: ["RETIRED", "ACTIVE", "SUSPECT", "DEAD"],
  RETIRED: [],
  PROVISION_AMBIGUOUS: ["TAB_CREATED", "READY_BLANK", "FAILED", "DEAD"],
  SUSPECT: ["ACTIVE", "ORPHAN_CANDIDATE", "DEAD"],
  ORPHAN_CANDIDATE: ["ACTIVE", "DEAD"],
  DEAD: [],
  FAILED: [],
});

async function transitionWorkerScoped(
  workspaceRoot: string,
  workerId: string,
  toState: WorkerState,
  input: {
    expectedRegistryRevision?: number;
    expectedRecordRevision?: number;
    detail?: string;
    patch?: Partial<Pick<WorkerRecord,
      "goal_id" | "bound_session_id" | "companion_instance_id" | "tab_instance_id" | "conversation_url" |
      "last_browser_seen_at" | "last_mcp_seen_at" | "successor_worker_id" | "death_reason">>;
  } = {}
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord }> {
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = current.workers[workerId];
    if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
    if (input.expectedRecordRevision !== undefined && worker.record_revision !== input.expectedRecordRevision) {
      throw new Error(`WORKER_STALE_REVISION: expected ${input.expectedRecordRevision}, current ${worker.record_revision}`);
    }
    if (worker.state === toState) return current;
    if (!ALLOWED_TRANSITIONS[worker.state].includes(toState)) {
      throw new Error(`WORKER_TRANSITION_INVALID: ${worker.state} -> ${toState}`);
    }
    const now = new Date().toISOString();
    const patch = input.patch ?? {};
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      ...patch,
      conversation_url: patch.conversation_url !== undefined ? normalizeUrl(patch.conversation_url) : worker.conversation_url,
      state: toState,
      record_revision: worker.record_revision + 1,
      updated_at: now,
      ready_at: ["READY_BLANK", "READY"].includes(toState) ? (worker.ready_at ?? now) : worker.ready_at,
      activated_at: toState === "ACTIVE" ? (worker.activated_at ?? now) : worker.activated_at,
      retired_at: toState === "RETIRED" ? now : worker.retired_at,
      death_reason: ["DEAD", "FAILED"].includes(toState)
        ? sanitizeReason(patch.death_reason ?? input.detail, "worker_failed")
        : (patch.death_reason ?? worker.death_reason),
    });
    const nextRevision = current.revision + 1;
    let lane = current.lanes[worker.lane];
    if (toState === "ACTIVE") {
      lane = Object.freeze({ ...lane, active_worker_id: workerId, standby_worker_id: lane.standby_worker_id === workerId ? null : lane.standby_worker_id });
    } else if (terminal(toState) || toState === "RETIRED") {
      lane = Object.freeze({
        ...lane,
        active_worker_id: lane.active_worker_id === workerId ? null : lane.active_worker_id,
        standby_worker_id: lane.standby_worker_id === workerId ? null : lane.standby_worker_id,
      });
    }
    return Object.freeze({
      ...current,
      revision: nextRevision,
      lanes: Object.freeze({ ...current.lanes, [worker.lane]: lane }),
      workers: Object.freeze({ ...current.workers, [workerId]: nextWorker }),
      journal: appendEvent(current, nextWorker, `STATE_${toState}`, worker.state, input.detail ?? null, now, nextRevision),
      updated_at: now,
    });
  }, input.expectedRegistryRevision);
  const worker = registry.workers[workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
  return { registry, worker };
}

async function recordWorkerBrowserHeartbeatScoped(
  workspaceRoot: string,
  input: {
    workerId: string;
    lane: WorkerLaneId;
    generation: number;
    provisionId: string;
    companionInstanceId?: string | null;
    tabInstanceId: string;
    conversationUrl?: string | null;
    adapterVersion?: string | null;
    adapterConfidence?: "high" | "medium" | "low" | "unknown";
    conversationSurface?: WorkerConversationSurface;
    composerReady: boolean;
    generationActive: boolean;
    connectionInterrupted?: boolean;
    activityRevision?: number;
    turnId?: string | null;
    turnStartedAt?: string | null;
    stopButtonVisible?: boolean;
    retryVisible?: boolean;
    toolInflightCount?: number;
    assistantTokenRevision?: number;
    feedbackLedger?: unknown;
  }
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord }> {
  let resultId = input.workerId;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = current.workers[input.workerId];
    if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
    if (worker.lane !== input.lane || worker.generation !== input.generation || worker.provision_id !== input.provisionId) {
      throw new Error("WORKER_IDENTITY_MISMATCH: heartbeat does not match durable Worker identity");
    }
    if (terminal(worker.state)) throw new Error(`WORKER_TERMINAL: ${worker.worker_id} is ${worker.state}`);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    let nextState = worker.state;
    // Reconcile every browser-observable provisioning milestone carried by a
    // single heartbeat. After a MV3 service-worker wake, the first heartbeat
    // can already prove that tabs.create() completed and the composer is ready;
    // requiring separate heartbeats would leave that valid Worker stuck in an
    // artificial intermediate state until another timer tick happens.
    if (nextState === "REQUESTED") nextState = "PROVISIONING";
    if (nextState === "PROVISIONING" && input.tabInstanceId) nextState = "TAB_CREATED";
    const conversationSurface = input.conversationSurface ?? "UNKNOWN";
    if (
      ["TAB_CREATED", "PROVISION_AMBIGUOUS"].includes(nextState) && conversationSurface === "CHAT" &&
      input.composerReady && !input.generationActive
    ) nextState = "READY_BLANK";
    const normalizedConversationUrl = normalizeUrl(input.conversationUrl) ?? worker.conversation_url;
    if (
      nextState === "ACTIVATING" && conversationSurface === "CHAT" && input.composerReady && !input.generationActive &&
      isFormalChatConversationUrl(normalizedConversationUrl) && worker.bound_session_id && worker.last_capability_at
    ) nextState = "READY";
    const nextTurnId = input.turnId?.trim().slice(0, 256) || null;
    const turnChanged = nextTurnId !== (worker.turn_id ?? null);
    const previousFeedbackLedger = !turnChanged ? worker.feedback_ledger ?? null : null;
    const feedbackResult = input.feedbackLedger === undefined
      ? null
      : normalizeVisibleFeedbackLedger(input.feedbackLedger, nowMs, previousFeedbackLedger, nextTurnId);
    if (feedbackResult && !feedbackResult.ok && feedbackResult.reason === "invalid") {
      throw new Error(`VISIBLE_FEEDBACK_LEDGER_INVALID: ${feedbackResult.detail}`);
    }
    const nextFeedbackLedger = feedbackResult?.ok ? feedbackResult.value : turnChanged ? undefined : worker.feedback_ledger;
    const reportedActivityRevision = Math.max(0, Math.trunc(input.activityRevision ?? 0));
    const nextActivityRevision = turnChanged ? reportedActivityRevision : Math.max(worker.activity_revision, reportedActivityRevision);
    const nextAssistantTokenRevision = Math.max(0, Math.trunc(input.assistantTokenRevision ?? 0));
    const nextToolInflightCount = Math.max(0, Math.trunc(input.toolInflightCount ?? 0));
    const stableSignals = Boolean(
      nextTurnId && !turnChanged &&
      nextActivityRevision === worker.activity_revision &&
      nextAssistantTokenRevision === (worker.assistant_token_revision ?? 0) &&
      Boolean(input.generationActive) === worker.generation_active &&
      Boolean(input.stopButtonVisible) === (worker.stop_button_visible ?? false) &&
      Boolean(input.connectionInterrupted) === worker.connection_interrupted &&
      Boolean(input.retryVisible) === (worker.retry_visible ?? false) &&
      nextToolInflightCount === (worker.tool_inflight_count ?? 0)
    );
    const priorTurnStartedAt = !turnChanged ? worker.turn_started_at ?? null : null;
    const turnStartedAt = nextTurnId
      ? normalizeTimestamp(input.turnStartedAt) || priorTurnStartedAt || now
      : null;
    const lastDomActivityAt = nextTurnId
      ? (turnChanged || nextActivityRevision > worker.activity_revision ? now : worker.last_dom_activity_at ?? now)
      : null;
    const lastAssistantTokenAt = nextTurnId
      ? (turnChanged || nextAssistantTokenRevision > (worker.assistant_token_revision ?? 0) ? now : worker.last_assistant_token_at ?? null)
      : null;
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      state: nextState,
      record_revision: worker.record_revision + 1,
      companion_instance_id: input.companionInstanceId?.trim() || worker.companion_instance_id,
      tab_instance_id: input.tabInstanceId.trim(),
      conversation_url: normalizedConversationUrl,
      adapter_version: input.adapterVersion?.trim() || worker.adapter_version,
      adapter_confidence: input.adapterConfidence ?? worker.adapter_confidence,
      conversation_surface: conversationSurface,
      composer_ready: input.composerReady,
      generation_active: input.generationActive,
      connection_interrupted: input.connectionInterrupted ?? false,
      activity_revision: nextActivityRevision,
      turn_id: nextTurnId,
      turn_started_at: turnStartedAt,
      stop_button_visible: input.stopButtonVisible ?? false,
      retry_visible: input.retryVisible ?? false,
      tool_inflight_count: nextToolInflightCount,
      assistant_token_revision: nextAssistantTokenRevision,
      ...(nextFeedbackLedger ? { feedback_ledger: nextFeedbackLedger } : turnChanged ? { feedback_ledger: undefined } : {}),
      last_dom_activity_at: lastDomActivityAt,
      last_assistant_token_at: lastAssistantTokenAt,
      stable_observation_windows: stableSignals ? (worker.stable_observation_windows ?? 0) + 1 : 0,
      last_browser_seen_at: now,
      ready_at: ["READY_BLANK", "READY"].includes(nextState) ? (worker.ready_at ?? now) : worker.ready_at,
      updated_at: now,
    });
    const nextRevision = current.revision + 1;
    resultId = nextWorker.worker_id;
    return Object.freeze({
      ...current,
      revision: nextRevision,
      workers: Object.freeze({ ...current.workers, [nextWorker.worker_id]: nextWorker }),
      journal: nextState !== worker.state
        ? appendEvent(current, nextWorker, `BROWSER_${nextState}`, worker.state, null, now, nextRevision)
        : current.journal,
      updated_at: now,
    });
  });
  const worker = registry.workers[resultId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${resultId}`);
  return { registry, worker };
}

function claimTtlMs(): number {
  const raw = Number.parseInt(process.env.HARNESS_WORKER_CLAIM_TTL_MS || String(DEFAULT_CLAIM_TTL_MS), 10);
  return Number.isFinite(raw) && raw >= 30_000 && raw <= 60 * 60_000 ? raw : DEFAULT_CLAIM_TTL_MS;
}

function claimSecret(): string {
  const companionToken = process.env.HARNESS_COMPANION_TOKEN?.trim();
  if (!companionToken) throw new Error("WORKER_CLAIM_SECRET_REQUIRED: HARNESS_COMPANION_TOKEN is required to mint worker claim tickets");
  return createHmac("sha256", companionToken).update("web-harness-worker-claim-v1").digest("hex");
}

function ticketPayload(worker: WorkerRecord, kind: WorkerClaimKind, handoffId: string, nonce: string, expiresAt: string): string {
  return ["goal-scoped-v2", worker.goal_id, worker.worker_id, worker.lane, worker.generation, worker.provision_id, kind, handoffId, nonce, expiresAt].join("\n");
}

function materializeToken(worker: WorkerRecord, kind: WorkerClaimKind, handoffId: string, nonce: string, expiresAt: string): string {
  const sig = createHmac("sha256", claimSecret()).update(ticketPayload(worker, kind, handoffId, nonce, expiresAt)).digest("base64url");
  return `${nonce}.${sig}`;
}

/** Remove expired claim material without changing capability proof or Driver ownership. */
async function clearExpiredWorkerClaimsScoped(
  workspaceRoot: string,
  nowMs = Date.now()
): Promise<{ registry: WorkerRegistryState; cleared: number }> {
  let cleared = 0;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const now = new Date(nowMs).toISOString();
    const workers = { ...current.workers };
    let journal = current.journal;
    for (const worker of Object.values(current.workers)) {
      if (!worker.claim_expires_at || Date.parse(worker.claim_expires_at) > nowMs) continue;
      const nextState: WorkerState = worker.state === "ACTIVATING"
        ? (worker.last_capability_at && worker.bound_session_id ? "READY" : "READY_BLANK")
        : worker.state;
      const nextWorker: WorkerRecord = Object.freeze({
        ...worker,
        state: nextState,
        record_revision: worker.record_revision + 1,
        claim_kind: null,
        claim_nonce: null,
        claim_token_hash: null,
        claim_handoff_id: null,
        claim_expires_at: null,
        claim_consumed_at: null,
        claim_session_id: null,
        updated_at: now,
      });
      workers[worker.worker_id] = nextWorker;
      const eventBase = Object.freeze({ ...current, journal });
      journal = appendEvent(eventBase, nextWorker, "CLAIM_TICKET_EXPIRED", worker.state, null, now, current.revision + 1);
      cleared++;
    }
    if (!cleared) return current;
    return Object.freeze({
      ...current,
      revision: current.revision + 1,
      workers: Object.freeze(workers),
      journal,
      updated_at: now,
    });
  });
  return { registry, cleared };
}

async function mintWorkerClaimTicketScoped(
  workspaceRoot: string,
  input: { workerId: string; handoffId: string; kind: WorkerClaimKind; expectedRegistryRevision?: number }
): Promise<WorkerClaimTicket> {
  await clearExpiredWorkerClaims(workspaceRoot);
  let ticket: WorkerClaimTicket | null = null;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = current.workers[input.workerId];
    if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
    if (!["READY_BLANK", "READY", "ACTIVATING", "PROVISION_AMBIGUOUS"].includes(worker.state)) {
      throw new Error(`WORKER_CLAIM_NOT_READY: ${worker.worker_id} is ${worker.state}`);
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const existingLive = worker.claim_nonce && worker.claim_handoff_id === input.handoffId && worker.claim_kind === input.kind &&
      worker.claim_expires_at && Date.parse(worker.claim_expires_at) > nowMs && !worker.claim_consumed_at;
    const nonce = existingLive ? worker.claim_nonce! : randomUUID();
    const expiresAt = existingLive ? worker.claim_expires_at! : new Date(nowMs + claimTtlMs()).toISOString();
    const token = materializeToken(worker, input.kind, input.handoffId, nonce, expiresAt);
    if (existingLive) {
      if (worker.claim_token_hash !== sha256(token)) {
        throw new Error("WORKER_LEGACY_CLAIM_UNCERTAIN: existing ticket needs explicit reconciliation before reissue");
      }
      ticket = {
        goal_id: current.goal_id,
        worker_id: worker.worker_id, lane: worker.lane, generation: worker.generation, kind: input.kind,
        handoff_id: input.handoffId, token, expires_at: expiresAt, registry_revision: current.revision,
      };
      return current;
    }
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      // Only the pre-authority PROBE moves a blank Worker into ACTIVATING.
      // HANDOFF/RECOVERY tickets are minted *after* capability readiness has
      // been proved and must not downgrade READY before the Driver CAS.
      state: input.kind === "PROBE" && (worker.state === "READY_BLANK" || worker.state === "READY") ? "ACTIVATING" : worker.state,
      record_revision: worker.record_revision + 1,
      claim_kind: input.kind,
      claim_nonce: nonce,
      claim_token_hash: sha256(token),
      claim_handoff_id: input.handoffId,
      claim_expires_at: expiresAt,
      claim_consumed_at: null,
      claim_session_id: null,
      updated_at: now,
    });
    const nextRevision = current.revision + 1;
    ticket = {
      goal_id: current.goal_id,
      worker_id: worker.worker_id, lane: worker.lane, generation: worker.generation, kind: input.kind,
      handoff_id: input.handoffId, token, expires_at: expiresAt, registry_revision: nextRevision,
    };
    return Object.freeze({
      ...current,
      revision: nextRevision,
      workers: Object.freeze({ ...current.workers, [worker.worker_id]: nextWorker }),
      journal: appendEvent(current, nextWorker, "CLAIM_TICKET_MINTED", worker.state, `${input.kind}:${input.handoffId}`, now, nextRevision),
      updated_at: now,
    });
  }, input.expectedRegistryRevision);
  if (!ticket) {
    const worker = registry.workers[input.workerId];
    if (!worker?.claim_nonce || !worker.claim_expires_at) throw new Error("WORKER_CLAIM_INTERNAL: ticket not materialized");
    ticket = {
      goal_id: registry.goal_id,
      worker_id: worker.worker_id, lane: worker.lane, generation: worker.generation, kind: input.kind,
      handoff_id: input.handoffId,
      token: materializeToken(worker, input.kind, input.handoffId, worker.claim_nonce, worker.claim_expires_at),
      expires_at: worker.claim_expires_at,
      registry_revision: registry.revision,
    };
  }
  return ticket;
}

async function consumeWorkerClaimTicketScoped(
  workspaceRoot: string,
  input: { workerId: string; handoffId: string; token: string; targetSessionId: string; kind?: WorkerClaimKind }
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord; already_consumed: boolean }> {
  let alreadyConsumed = false;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = current.workers[input.workerId];
    if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
    if (!worker.claim_token_hash || !worker.claim_nonce || !worker.claim_expires_at || !worker.claim_handoff_id || !worker.claim_kind) {
      throw new Error("WORKER_CLAIM_MISSING: Worker has no live claim ticket");
    }
    if (worker.claim_handoff_id !== input.handoffId || (input.kind && worker.claim_kind !== input.kind)) {
      throw new Error("WORKER_CLAIM_HANDOFF_MISMATCH: claim ticket belongs to another transition");
    }
    if (Date.parse(worker.claim_expires_at) <= Date.now()) throw new Error("WORKER_CLAIM_EXPIRED: claim ticket expired");
    const expected = materializeToken(worker, worker.claim_kind, worker.claim_handoff_id, worker.claim_nonce, worker.claim_expires_at);
    if (sha256(input.token) !== worker.claim_token_hash || input.token !== expected) {
      throw new Error("WORKER_CLAIM_TOKEN_MISMATCH: invalid worker claim token");
    }
    if (worker.claim_consumed_at) {
      if (worker.claim_session_id === input.targetSessionId) {
        alreadyConsumed = true;
        return current;
      }
      throw new Error("WORKER_CLAIM_REPLAY: claim ticket was already consumed by another session");
    }
    const now = new Date().toISOString();
    const capabilityProbeId = `claim:${input.kind ?? worker.claim_kind}:${input.handoffId}`.slice(0, 256);
    const nextState: WorkerState = worker.state === "ACTIVATING" && isFormalChatConversationUrl(worker.conversation_url)
      ? "READY"
      : worker.state;
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      state: nextState,
      record_revision: worker.record_revision + 1,
      bound_session_id: input.targetSessionId,
      last_mcp_seen_at: now,
      last_capability_probe_id: capabilityProbeId,
      last_capability_at: now,
      claim_consumed_at: now,
      claim_session_id: input.targetSessionId,
      ready_at: nextState === "READY" ? (worker.ready_at ?? now) : worker.ready_at,
      updated_at: now,
    });
    const nextRevision = current.revision + 1;
    return Object.freeze({
      ...current,
      revision: nextRevision,
      workers: Object.freeze({ ...current.workers, [worker.worker_id]: nextWorker }),
      journal: appendEvent(current, nextWorker, "CLAIM_TICKET_CONSUMED", worker.state, `${worker.claim_kind}:${input.handoffId}`, now, nextRevision),
      updated_at: now,
    });
  });
  const worker = registry.workers[input.workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
  return { registry, worker, already_consumed: alreadyConsumed };
}

/**
 * Consume a claim whose delivery was already authenticated by Browser
 * Companion.  ChatGPT may block prompts that ask the model to echo a bearer
 * token, so the server can instead bind the arriving MCP session to the one
 * fresh browser turn that received this exact one-time command.
 *
 * This path is intentionally stricter than the token path: the Worker must be
 * in a formal conversation, actively generating the delivered turn, fresh,
 * on the exact claimed tab, and still hold the unexpired server-minted claim.
 */
async function consumeWorkerBrowserDeliveredClaimScoped(
  workspaceRoot: string,
  input: {
    workerId: string;
    handoffId: string;
    targetSessionId: string;
    kind: WorkerClaimKind;
    expectedTabInstanceId: string;
    notBefore: string;
    maxBrowserAgeMs?: number;
  }
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord; already_consumed: boolean; internal_claim_token: string }> {
  let alreadyConsumed = false;
  let internalClaimToken = "";
  const maxBrowserAgeMs = Math.max(1_000, Math.min(60_000, Math.trunc(input.maxBrowserAgeMs ?? 15_000)));
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = current.workers[input.workerId];
    if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
    if (!worker.claim_token_hash || !worker.claim_nonce || !worker.claim_expires_at || !worker.claim_handoff_id || !worker.claim_kind) {
      throw new Error("WORKER_CLAIM_MISSING: Worker has no live claim ticket");
    }
    if (worker.claim_handoff_id !== input.handoffId || worker.claim_kind !== input.kind) {
      throw new Error("WORKER_CLAIM_HANDOFF_MISMATCH: browser receipt belongs to another transition");
    }
    const nowMs = Date.now();
    if (Date.parse(worker.claim_expires_at) <= nowMs) throw new Error("WORKER_CLAIM_EXPIRED: claim ticket expired");
    internalClaimToken = materializeToken(worker, worker.claim_kind, worker.claim_handoff_id, worker.claim_nonce, worker.claim_expires_at);
    if (sha256(internalClaimToken) !== worker.claim_token_hash) {
      throw new Error("WORKER_CLAIM_TOKEN_MISMATCH: durable browser-delivered claim material is invalid");
    }
    if (worker.claim_consumed_at) {
      if (worker.claim_session_id === input.targetSessionId) {
        alreadyConsumed = true;
        return current;
      }
      throw new Error("WORKER_CLAIM_REPLAY: browser-delivered claim was already consumed by another session");
    }
    if (worker.bound_session_id && worker.bound_session_id !== input.targetSessionId) {
      throw new Error("WORKER_SESSION_MISMATCH: Worker is already bound to another MCP session");
    }
    if (
      worker.tab_instance_id !== input.expectedTabInstanceId ||
      worker.conversation_surface !== "CHAT" ||
      !isFormalChatConversationUrl(worker.conversation_url) ||
      !worker.generation_active ||
      worker.connection_interrupted ||
      !worker.turn_id ||
      !worker.turn_started_at ||
      !worker.last_browser_seen_at
    ) {
      throw new Error("WORKER_BROWSER_RECEIPT_INVALID: exact fresh generating browser turn is required");
    }
    const lastSeenMs = Date.parse(worker.last_browser_seen_at);
    const turnStartedMs = Date.parse(worker.turn_started_at);
    const notBeforeMs = Date.parse(input.notBefore);
    if (
      !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > maxBrowserAgeMs ||
      !Number.isFinite(turnStartedMs) || !Number.isFinite(notBeforeMs) ||
      lastSeenMs < notBeforeMs || turnStartedMs < notBeforeMs - 5_000
    ) {
      throw new Error("WORKER_BROWSER_RECEIPT_STALE: browser turn does not match the delivered command window");
    }
    const now = new Date(nowMs).toISOString();
    const capabilityProbeId = `browser-receipt:${input.kind}:${input.handoffId}`.slice(0, 256);
    const nextState: WorkerState = worker.state === "ACTIVATING" ? "READY" : worker.state;
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      state: nextState,
      record_revision: worker.record_revision + 1,
      bound_session_id: input.targetSessionId,
      last_mcp_seen_at: now,
      last_capability_probe_id: capabilityProbeId,
      last_capability_at: now,
      claim_consumed_at: now,
      claim_session_id: input.targetSessionId,
      ready_at: nextState === "READY" ? (worker.ready_at ?? now) : worker.ready_at,
      updated_at: now,
    });
    const nextRevision = current.revision + 1;
    return Object.freeze({
      ...current,
      revision: nextRevision,
      workers: Object.freeze({ ...current.workers, [worker.worker_id]: nextWorker }),
      journal: appendEvent(current, nextWorker, "CLAIM_BROWSER_RECEIPT_CONSUMED", worker.state, `${input.kind}:${input.handoffId}`, now, nextRevision),
      updated_at: now,
    });
  });
  const worker = registry.workers[input.workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
  if (!internalClaimToken) throw new Error("WORKER_CLAIM_INTERNAL: browser-delivered claim token was not materialized");
  return { registry, worker, already_consumed: alreadyConsumed, internal_claim_token: internalClaimToken };
}

/** Validate a one-time claim without mutating it. Commit paths re-check by
 * consuming the same ticket only after the Driver authority transition wins. */
async function verifyWorkerClaimTicketScoped(
  workspaceRoot: string,
  input: { workerId: string; handoffId: string; token: string; targetSessionId: string; kind?: WorkerClaimKind }
): Promise<{ worker: WorkerRecord; already_consumed: boolean }> {
  const registry = await readWorkerRegistry(workspaceRoot);
  const worker = registry.workers[input.workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${input.workerId}`);
  if (!worker.claim_token_hash || !worker.claim_nonce || !worker.claim_expires_at || !worker.claim_handoff_id || !worker.claim_kind) {
    throw new Error("WORKER_CLAIM_MISSING: Worker has no live claim ticket");
  }
  if (worker.claim_handoff_id !== input.handoffId || (input.kind && worker.claim_kind !== input.kind)) {
    throw new Error("WORKER_CLAIM_HANDOFF_MISMATCH: claim ticket belongs to another transition");
  }
  if (Date.parse(worker.claim_expires_at) <= Date.now()) throw new Error("WORKER_CLAIM_EXPIRED: claim ticket expired");
  const expected = materializeToken(worker, worker.claim_kind, worker.claim_handoff_id, worker.claim_nonce, worker.claim_expires_at);
  if (sha256(input.token) !== worker.claim_token_hash || input.token !== expected) {
    throw new Error("WORKER_CLAIM_TOKEN_MISMATCH: invalid worker claim token");
  }
  if (worker.claim_consumed_at && worker.claim_session_id !== input.targetSessionId) {
    throw new Error("WORKER_CLAIM_REPLAY: claim ticket was already consumed by another session");
  }
  if (worker.bound_session_id && worker.bound_session_id !== input.targetSessionId) {
    throw new Error("WORKER_SESSION_MISMATCH: Worker is already bound to another MCP session");
  }
  return { worker, already_consumed: Boolean(worker.claim_consumed_at) };
}

async function markWorkerActiveForSessionScoped(
  workspaceRoot: string,
  workerId: string,
  sessionId: string,
  detail = "driver_authority_committed"
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord }> {
  const current = await readWorkerRegistry(workspaceRoot);
  const worker = current.workers[workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
  if (worker.bound_session_id && worker.bound_session_id !== sessionId) {
    throw new Error("WORKER_SESSION_MISMATCH: Worker is bound to a different MCP session");
  }
  if (worker.state === "ACTIVE" && worker.bound_session_id === sessionId) return { registry: current, worker };
  if (!workerReadyForAuthority(worker)) {
    throw new Error("WORKER_AUTHORITY_NOT_READY: formal conversation + consumed claim + fresh MCP capability proof are required before Driver authority");
  }
  return transitionWorker(workspaceRoot, workerId, "ACTIVE", { detail, patch: { bound_session_id: sessionId, last_mcp_seen_at: new Date().toISOString() } });
}

async function recordWorkerCapabilityProofBySessionScoped(
  workspaceRoot: string,
  sessionId: string,
  probeId: string
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord } | null> {
  const normalizedSession = sessionId.trim();
  const normalizedProbe = probeId.trim();
  if (!normalizedSession || !normalizedProbe) return null;
  let matchedWorkerId: string | null = null;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = Object.values(current.workers).find((candidate) => candidate.bound_session_id === normalizedSession && !terminal(candidate.state));
    if (!worker) return current;
    matchedWorkerId = worker.worker_id;
    if (worker.last_capability_probe_id === normalizedProbe) return current;
    const now = new Date().toISOString();
    const nextState: WorkerState = worker.state === "ACTIVATING" && worker.bound_session_id && isFormalChatConversationUrl(worker.conversation_url)
      ? "READY"
      : worker.state;
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      state: nextState,
      record_revision: worker.record_revision + 1,
      last_mcp_seen_at: now,
      last_capability_probe_id: normalizedProbe.slice(0, 256),
      last_capability_at: now,
      ready_at: nextState === "READY" ? (worker.ready_at ?? now) : worker.ready_at,
      updated_at: now,
    });
    const nextRevision = current.revision + 1;
    return Object.freeze({
      ...current,
      revision: nextRevision,
      workers: Object.freeze({ ...current.workers, [worker.worker_id]: nextWorker }),
      journal: appendEvent(current, nextWorker, "CAPABILITY_PROOF", worker.state, normalizedProbe, now, nextRevision),
      updated_at: now,
    });
  });
  if (!matchedWorkerId) return null;
  const worker = registry.workers[matchedWorkerId];
  return worker ? { registry, worker } : null;
}

/** Record authoritative MCP activity without refreshing capability proof. */
async function recordWorkerMcpActivityBySessionScoped(
  workspaceRoot: string,
  sessionId: string,
  observedAt = new Date().toISOString()
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord } | null> {
  const normalizedSession = sessionId.trim();
  const normalizedAt = normalizeTimestamp(observedAt);
  if (!normalizedSession || !normalizedAt) return null;
  let matchedWorkerId: string | null = null;
  const registry = await mutateRegistry(workspaceRoot, (current) => {
    const worker = Object.values(current.workers).find((candidate) =>
      candidate.bound_session_id === normalizedSession && !terminal(candidate.state)
    );
    if (!worker) return current;
    matchedWorkerId = worker.worker_id;
    const previousMs = worker.last_mcp_seen_at ? Date.parse(worker.last_mcp_seen_at) : Number.NaN;
    const observedMs = Date.parse(normalizedAt);
    if (Number.isFinite(previousMs) && observedMs <= previousMs) return current;
    const nextWorker: WorkerRecord = Object.freeze({
      ...worker,
      record_revision: worker.record_revision + 1,
      last_mcp_seen_at: normalizedAt,
      updated_at: normalizedAt,
    });
    return Object.freeze({
      ...current,
      revision: current.revision + 1,
      workers: Object.freeze({ ...current.workers, [worker.worker_id]: nextWorker }),
      updated_at: normalizedAt,
    });
  });
  if (!matchedWorkerId) return null;
  const worker = registry.workers[matchedWorkerId];
  return worker ? { registry, worker } : null;
}

async function retireWorkerScoped(
  workspaceRoot: string,
  workerId: string,
  reason = "successor_committed"
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord }> {
  const current = await readWorkerRegistry(workspaceRoot);
  const worker = current.workers[workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
  if (worker.state === "RETIRED") return { registry: current, worker };
  if (worker.state === "ACTIVE") await transitionWorker(workspaceRoot, workerId, "DRAINING", { detail: reason });
  return transitionWorker(workspaceRoot, workerId, "RETIRED", { detail: reason });
}

async function markProvisionAmbiguousScoped(
  workspaceRoot: string,
  workerId: string,
  detail: string
): Promise<{ registry: WorkerRegistryState; worker: WorkerRecord }> {
  const current = await readWorkerRegistry(workspaceRoot);
  const worker = current.workers[workerId];
  if (!worker) throw new Error(`WORKER_NOT_FOUND: ${workerId}`);
  if (worker.state === "PROVISION_AMBIGUOUS") return { registry: current, worker };
  return transitionWorker(workspaceRoot, workerId, "PROVISION_AMBIGUOUS", { detail });
}

export function workerForLane(registry: WorkerRegistryState, lane: WorkerLaneId): WorkerRecord | null {
  const laneState = registry.lanes[lane];
  const workerId = laneState.active_worker_id ?? laneState.standby_worker_id;
  return workerId ? registry.workers[workerId] ?? null : null;
}

export function workerReadyForActivation(worker: WorkerRecord | null): boolean {
  return workerReadyForBootstrap(worker);
}

export function migrateLegacyLaneWorkers(...args: Parameters<typeof migrateLegacyLaneWorkersScoped>): ReturnType<typeof migrateLegacyLaneWorkersScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => migrateLegacyLaneWorkersScoped(...args));
}

export function requestWorkerProvision(...args: Parameters<typeof requestWorkerProvisionScoped>): ReturnType<typeof requestWorkerProvisionScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId ?? undefined, () => requestWorkerProvisionScoped(...args));
}

export function transitionWorker(...args: Parameters<typeof transitionWorkerScoped>): ReturnType<typeof transitionWorkerScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => transitionWorkerScoped(...args));
}

export function recordWorkerBrowserHeartbeat(...args: Parameters<typeof recordWorkerBrowserHeartbeatScoped>): ReturnType<typeof recordWorkerBrowserHeartbeatScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => recordWorkerBrowserHeartbeatScoped(...args));
}

export function clearExpiredWorkerClaims(...args: Parameters<typeof clearExpiredWorkerClaimsScoped>): ReturnType<typeof clearExpiredWorkerClaimsScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => clearExpiredWorkerClaimsScoped(...args));
}

export function mintWorkerClaimTicket(...args: Parameters<typeof mintWorkerClaimTicketScoped>): ReturnType<typeof mintWorkerClaimTicketScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => mintWorkerClaimTicketScoped(...args));
}

export function consumeWorkerClaimTicket(...args: Parameters<typeof consumeWorkerClaimTicketScoped>): ReturnType<typeof consumeWorkerClaimTicketScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => consumeWorkerClaimTicketScoped(...args));
}

export function consumeWorkerBrowserDeliveredClaim(...args: Parameters<typeof consumeWorkerBrowserDeliveredClaimScoped>): ReturnType<typeof consumeWorkerBrowserDeliveredClaimScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => consumeWorkerBrowserDeliveredClaimScoped(...args));
}

export function verifyWorkerClaimTicket(...args: Parameters<typeof verifyWorkerClaimTicketScoped>): ReturnType<typeof verifyWorkerClaimTicketScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => verifyWorkerClaimTicketScoped(...args));
}

export function markWorkerActiveForSession(...args: Parameters<typeof markWorkerActiveForSessionScoped>): ReturnType<typeof markWorkerActiveForSessionScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => markWorkerActiveForSessionScoped(...args));
}

export function recordWorkerCapabilityProofBySession(...args: Parameters<typeof recordWorkerCapabilityProofBySessionScoped>): ReturnType<typeof recordWorkerCapabilityProofBySessionScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => recordWorkerCapabilityProofBySessionScoped(...args));
}

export function recordWorkerMcpActivityBySession(...args: Parameters<typeof recordWorkerMcpActivityBySessionScoped>): ReturnType<typeof recordWorkerMcpActivityBySessionScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => recordWorkerMcpActivityBySessionScoped(...args));
}

export function retireWorker(...args: Parameters<typeof retireWorkerScoped>): ReturnType<typeof retireWorkerScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => retireWorkerScoped(...args));
}

export function markProvisionAmbiguous(...args: Parameters<typeof markProvisionAmbiguousScoped>): ReturnType<typeof markProvisionAmbiguousScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => markProvisionAmbiguousScoped(...args));
}
