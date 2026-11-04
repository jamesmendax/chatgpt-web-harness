import { currentRelayGoal, requireRelayGoal, withRelayGoal, withResolvedRelayGoal, relayGoalPath, relayScopeKey, readRelayStateText, ensureRelayGoalStorage, resolveRelayGoalForTransition, resolveRelayGoalForSession, listRelayGoalIds } from "./relay-scope.js";
import { createHash, randomUUID } from "node:crypto";
import { assertRecoveryBackgroundIngress } from "./recovery-non-mcp-fence.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activeDriverMutationCount,
  assessDriverOrphanRecovery,
  readDriverLease,
  releaseDriverLease,
  relayEnabled,
  type DriverLease,
  type RecoveryAuthorization,
} from "./driver-lease.js";
import { readHandoffSnapshot } from "./handoff-store.js";
import { transitionGoalRunLifecycle } from "./goal-run-web.js";
import { readGoalRun } from "./goal-run-store.js";
import { listAuthorityBlockingOperationInspections } from "./operation-journal.js";
import { abortRelayHandoff, prepareRelayHandoff } from "./relay-control.js";
import { createRuntimeScope, runWithRuntimeScope } from "./runtime-scope.js";
import { writeTextFileCas } from "./safe-text-write.js";
import { normalizeVisibleFeedbackLedger, type VisibleFeedbackLedger } from "./visible-feedback-ledger.js";
import {
  isFormalChatConversationUrl,
  markProvisionAmbiguous,
  markWorkerActiveForSession,
  migrateLegacyLaneWorkers,
  mintWorkerClaimTicket,
  consumeWorkerClaimTicket,
  consumeWorkerBrowserDeliveredClaim,
  readWorkerRegistry,
  fenceWorkerRegistryForGoal,
  recordWorkerBrowserHeartbeat,
  requestWorkerProvision,
  retireWorker,
  transitionWorker,
  verifyWorkerClaimTicket,
  workerForLane,
  workerReadyForAuthority,
  workerReadyForBootstrap,
  type WorkerConversationSurface,
  type WorkerLaneId,
  type WorkerRecord,
  type WorkerRegistryState,
} from "./worker-registry.js";

const RELAY_MANAGER_SCHEMA_VERSION = 2 as const;
const LEGACY_RELAY_MANAGER_SCHEMA_VERSION = 1 as const;
const DEFAULT_LANE_FRESH_MS = 15_000;
const DEFAULT_COMMAND_TTL_MS = 5 * 60_000;
const DEFAULT_RISK_THRESHOLD = 75;
const DEFAULT_AUTOMATION_POLL_MS = 2_000;
const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_DELIVERY_RETRY_MS = 30_000;
const DEFAULT_CAPABILITY_FRESH_MS = 60_000;
const DEFAULT_REPLACEMENT_PROGRESS_TIMEOUT_MS = 90_000;
const MAX_COMMAND_HISTORY = 192;
const AUTOMATIC_PROVISION_REASONS = new Set([
  "companion_identity_storage_recovery",
  "automatic_pool_repair",
  "automatic_orphan_recovery",
  "risk_handoff_standby_unavailable",
]);
const RELAY_POLICY_PROCESS_ENABLED_AT = new Date().toISOString();

export type RelayLaneId = WorkerLaneId;
export type RelayCommandState = "PENDING" | "CLAIMED" | "SENT" | "ACKED" | "FAILED" | "EXPIRED" | "AMBIGUOUS";
export type RelayAdapterConfidence = "high" | "medium" | "low" | "unknown";
export type RelayCommandKind =
  | "resume_goal"
  | "provision_worker"
  | "bootstrap_worker"
  | "activate_worker"
  | "retire_worker"
  | "close_retired_worker"
  | "health_probe"
  | "recover_worker";

export interface RelayLaneHeartbeatInput {
  readonly lane: RelayLaneId;
  readonly tab_instance_id: string;
  readonly conversation_url: string;
  readonly adapter_version: string;
  readonly adapter_confidence?: RelayAdapterConfidence;
  readonly conversation_surface?: WorkerConversationSurface;
  readonly composer_ready: boolean;
  readonly generation_active: boolean;
  readonly connection_interrupted: boolean;
  /** Browser values are retained only for v1 compatibility/diagnostics. They are not authority telemetry. */
  readonly tool_inflight_count?: number;
  readonly tool_activity_count?: number;
  readonly activity_revision?: number;
  readonly turn_id?: string | null;
  readonly turn_started_at?: string | null;
  readonly stop_button_visible?: boolean;
  readonly retry_visible?: boolean;
  readonly assistant_token_revision?: number;
  readonly feedback_ledger?: unknown;
  readonly worker_id?: string;
  readonly generation?: number;
  readonly provision_id?: string;
  readonly companion_instance_id?: string;
}

export interface RelayLaneObservation {
  readonly lane: RelayLaneId;
  readonly tab_instance_id: string;
  readonly conversation_url: string;
  readonly adapter_version: string;
  readonly adapter_confidence: RelayAdapterConfidence;
  readonly conversation_surface: WorkerConversationSurface;
  readonly composer_ready: boolean;
  readonly generation_active: boolean;
  readonly connection_interrupted: boolean;
  readonly tool_inflight_count: number;
  readonly tool_activity_count: number;
  readonly activity_revision: number;
  readonly turn_id: string | null;
  readonly turn_started_at: string | null;
  readonly stop_button_visible: boolean;
  readonly retry_visible: boolean;
  readonly assistant_token_revision: number;
  readonly feedback_ledger?: VisibleFeedbackLedger;
  readonly last_dom_activity_at: string | null;
  readonly last_assistant_token_at: string | null;
  readonly last_mcp_activity_at: string | null;
  readonly stable_observation_windows: number;
  readonly last_seen_at: string;
  readonly bound_at: string;
}

export interface RelayLaneState {
  readonly lane: RelayLaneId;
  readonly active_worker_id: string | null;
  readonly standby_worker_id: string | null;
  readonly replacement_worker_id: string | null;
  readonly replacement_source_worker_id: string | null;
  readonly next_generation: number;
  readonly observation: RelayLaneObservation | null;
}

export interface RelayCommand {
  readonly command_id: string;
  readonly kind: RelayCommandKind;
  readonly lane: RelayLaneId;
  readonly worker_id: string | null;
  readonly generation: number | null;
  readonly registry_revision: number | null;
  readonly provision_id: string | null;
  readonly provision_attempt_id: string | null;
  readonly source_worker_id: string | null;
  readonly probe_id: string | null;
  readonly expected_source_driver_epoch: number | null;
  readonly expected_source_lease_id: string | null;
  readonly recovery_policy_revision: number | null;
  readonly recovery_policy_enabled_at: string | null;
  readonly handoff_id: string | null;
  readonly goal_id: string | null;
  readonly goal_revision: number | null;
  /** Persisted only for legacy resume_goal. Worker claim tokens are never persisted here. */
  readonly marker: string | null;
  readonly message: string | null;
  readonly state: RelayCommandState;
  readonly claimed_by_instance_id: string | null;
  readonly claimed_by_tab_instance_id: string | null;
  readonly claim_count: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string;
  readonly failure_detail: string | null;
}

export interface RelayCommandDelivery extends RelayCommand {
  readonly marker: string | null;
  readonly message: string | null;
}

export type RelayResumeCommand = RelayCommand;

export interface RelayManagerState {
  readonly goal_id: string;
  readonly fenced_at?: string;
  readonly fence_reason?: string;
  readonly schema_version: typeof RELAY_MANAGER_SCHEMA_VERSION;
  readonly revision: number;
  readonly active_lane: RelayLaneId | null;
  readonly lanes: Readonly<Record<RelayLaneId, RelayLaneState>>;
  readonly commands: readonly RelayCommand[];
  readonly updated_at: string;
  readonly migrated_from_v1: boolean;
}

export interface TurnRiskAssessment {
  readonly score: number;
  readonly threshold: number;
  readonly should_handoff: boolean;
  readonly reasons: readonly string[];
  readonly driver_age_ms: number;
  readonly lane_age_ms: number | null;
  readonly web_turn?: WebTurnStallAssessment;
}

export interface WebTurnStallAssessment {
  readonly turn_id: string | null;
  readonly structured: boolean;
  readonly explicit_failure: boolean;
  readonly inactivity_budget_ms: number | null;
  readonly inactivity_ms: number | null;
  readonly inactivity_exceeded: boolean;
  readonly stable_observation_windows: number;
  readonly stable_across_two_windows: boolean;
  readonly tool_inflight_count: number;
  readonly candidate: boolean;
  readonly should_recover: boolean;
  readonly reasons: readonly string[];
}

export interface RelayAutomationResult {
  readonly enabled: boolean;
  readonly action: "disabled" | "idle" | "prepared" | "reconciled" | "blocked" | "provisioned";
  readonly detail: string;
  readonly risk?: TurnRiskAssessment;
  readonly handoff_id?: string;
  readonly command_id?: string;
  readonly target_lane?: RelayLaneId;
  readonly target_worker_id?: string;
}

export type RelayControlPlaneState =
  | "IDLE"
  | "ACTIVE"
  | "RECOVERING"
  | "DEGRADED_REDUNDANCY"
  | "WAITING_CONTROL_PLANE";

export type RelayStandbyState = "READY_STANDBY" | "PREWARMING" | "ABSENT";

/**
 * Read-only projection of the browser/MCP control plane. This is deliberately
 * separate from the Driver lease: a lease proves authority, while this
 * projection describes whether that authority currently has a usable browser
 * lane and a capability-proved successor.
 */
export interface RelayControlPlaneProjection {
  readonly state: RelayControlPlaneState;
  readonly goal_id: string | null;
  readonly driver_epoch: number | null;
  readonly active_lane: RelayLaneId | null;
  readonly active_worker_id: string | null;
  readonly active_ready: boolean;
  readonly standby_lane: RelayLaneId | null;
  readonly standby_worker_id: string | null;
  readonly standby_state: RelayStandbyState;
  readonly detail: string;
}

interface StateFile {
  readonly state: RelayManagerState;
  readonly sha256: string;
  readonly source_schema_version: 1 | 2;
}

const stateMutationChains = new Map<string, Promise<void>>();
const automationBusyWorkspaces = new Set<string>();

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

export function relayManagerPath(workspaceRoot: string, goalId?: string): string {
  return relayGoalPath(workspaceRoot, "manager.json", goalId);
}

function emptyLane(lane: RelayLaneId): RelayLaneState {
  return Object.freeze({
    lane,
    active_worker_id: null,
    standby_worker_id: null,
    replacement_worker_id: null,
    replacement_source_worker_id: null,
    next_generation: 1,
    observation: null,
  });
}

function initialState(goalId: string, now = new Date().toISOString()): RelayManagerState {
  return Object.freeze({
    schema_version: RELAY_MANAGER_SCHEMA_VERSION,
    goal_id: goalId,
    revision: 0,
    active_lane: null,
    lanes: Object.freeze({ A: emptyLane("A"), B: emptyLane("B") }),
    commands: Object.freeze([]),
    updated_at: now,
    migrated_from_v1: false,
  });
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function relayAutomationEnabled(): boolean {
  return relayEnabled() && process.env.HARNESS_RELAY_AUTOMATION_ENABLED === "true";
}

export function relayAutoRecoveryEnabled(): boolean {
  return relayAutomationEnabled() && process.env.HARNESS_RELAY_AUTO_RECOVERY_ENABLED === "true";
}

export function relayCompanionEnabled(): boolean {
  return relayEnabled() && process.env.HARNESS_COMPANION_ENABLED === "true";
}

export interface RelayGateStatus {
  readonly ready: boolean;
  readonly reason_code: "READY" | "RELAY_DISABLED" | "RELAY_AUTOMATION_DISABLED" | "RELAY_COMPANION_DISABLED" | "RELAY_AUTO_RECOVERY_DISABLED";
  readonly checked_at: string;
}

/** Safe user-facing gate summary; deliberately contains no Goal, Worker or capability identity. */
export function getRelayGateStatus(now = new Date()): RelayGateStatus {
  const reason_code: RelayGateStatus["reason_code"] = !relayEnabled()
    ? "RELAY_DISABLED"
    : !relayAutomationEnabled()
      ? "RELAY_AUTOMATION_DISABLED"
      : !relayCompanionEnabled()
        ? "RELAY_COMPANION_DISABLED"
        : !relayAutoRecoveryEnabled()
          ? "RELAY_AUTO_RECOVERY_DISABLED"
          : "READY";
  return Object.freeze({ ready: reason_code === "READY", reason_code, checked_at: now.toISOString() });
}

function laneFreshMs(): number {
  return envInt("HARNESS_RELAY_LANE_FRESH_MS", DEFAULT_LANE_FRESH_MS, 2_000, 120_000);
}

function commandTtlMs(): number {
  return envInt("HARNESS_RELAY_COMMAND_TTL_MS", DEFAULT_COMMAND_TTL_MS, 30_000, 30 * 60_000);
}

function capabilityProbeTimeoutMs(): number {
  return envInt("HARNESS_RELAY_CAPABILITY_PROBE_TIMEOUT_MS", DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS, 100, 120_000);
}

function browserDeliveryRetryMs(): number {
  return envInt("HARNESS_RELAY_BROWSER_DELIVERY_RETRY_MS", DEFAULT_BROWSER_DELIVERY_RETRY_MS, 1_000, 10 * 60_000);
}

function capabilityFreshMs(): number {
  return envInt("HARNESS_RELAY_CAPABILITY_FRESH_MS", DEFAULT_CAPABILITY_FRESH_MS, 1_000, 30 * 60_000);
}

function replacementProgressTimeoutMs(): number {
  return envInt(
    "HARNESS_RELAY_REPLACEMENT_PROGRESS_TIMEOUT_MS",
    DEFAULT_REPLACEMENT_PROGRESS_TIMEOUT_MS,
    100,
    15 * 60_000
  );
}

function relayRecoveryPolicy(lease: DriverLease): Extract<RecoveryAuthorization, { kind: "RELAY_POLICY" }> {
  const policyRevision = envInt("HARNESS_RELAY_RECOVERY_POLICY_REVISION", 1, 1, 1_000_000);
  const configuredAt = process.env.HARNESS_RELAY_RECOVERY_POLICY_ENABLED_AT?.trim();
  const enabledAt = configuredAt && Number.isFinite(Date.parse(configuredAt)) ? configuredAt : RELAY_POLICY_PROCESS_ENABLED_AT;
  return Object.freeze({ kind: "RELAY_POLICY", policy_revision: policyRevision, goal_id: lease.goal_id, enabled_at: enabledAt });
}

function riskThreshold(): number {
  return envInt("HARNESS_RELAY_RISK_THRESHOLD", DEFAULT_RISK_THRESHOLD, 1, 100);
}

function configuredWebTurnBudgetMs(): number | null {
  const raw = process.env.HARNESS_WEB_TURN_BUDGET_MS?.trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 30_000), 60 * 60_000) : null;
}

function normalizeNonNegativeInt(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value!));
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseLegacyObservation(value: unknown, lane: RelayLaneId): RelayLaneObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.lane !== lane || typeof record.tab_instance_id !== "string" || typeof record.conversation_url !== "string" ||
    typeof record.adapter_version !== "string" || typeof record.composer_ready !== "boolean" ||
    typeof record.generation_active !== "boolean" || typeof record.connection_interrupted !== "boolean" ||
    typeof record.last_seen_at !== "string" || typeof record.bound_at !== "string"
  ) return null;
  return Object.freeze({
    lane,
    tab_instance_id: record.tab_instance_id,
    conversation_url: record.conversation_url,
    adapter_version: record.adapter_version,
    adapter_confidence: ["high", "medium", "low", "unknown"].includes(String(record.adapter_confidence))
      ? record.adapter_confidence as RelayAdapterConfidence : "unknown",
    conversation_surface: ["CHAT", "WORK", "UNKNOWN"].includes(String(record.conversation_surface))
      ? record.conversation_surface as WorkerConversationSurface : "UNKNOWN",
    composer_ready: record.composer_ready,
    generation_active: record.generation_active,
    connection_interrupted: record.connection_interrupted,
    tool_inflight_count: normalizeNonNegativeInt(Number(record.tool_inflight_count)),
    tool_activity_count: normalizeNonNegativeInt(Number(record.tool_activity_count)),
    activity_revision: normalizeNonNegativeInt(Number(record.activity_revision)),
    turn_id: typeof record.turn_id === "string" && record.turn_id.trim() ? record.turn_id.slice(0, 256) : null,
    turn_started_at: normalizeTimestamp(record.turn_started_at),
    stop_button_visible: record.stop_button_visible === true,
    retry_visible: record.retry_visible === true,
    assistant_token_revision: normalizeNonNegativeInt(Number(record.assistant_token_revision)),
    last_dom_activity_at: normalizeTimestamp(record.last_dom_activity_at),
    last_assistant_token_at: normalizeTimestamp(record.last_assistant_token_at),
    last_mcp_activity_at: normalizeTimestamp(record.last_mcp_activity_at),
    stable_observation_windows: normalizeNonNegativeInt(Number(record.stable_observation_windows)),
    last_seen_at: record.last_seen_at,
    bound_at: record.bound_at,
  });
}

function migrateV1(record: Record<string, unknown>, file: string): RelayManagerState {
  if (!(record.active_lane === null || record.active_lane === "A" || record.active_lane === "B")) {
    throw new Error(`RELAY_MANAGER_UNREADABLE: malformed v1 active_lane at ${file}`);
  }
  const legacyLanes = record.lanes as Record<string, unknown> | undefined;
  if (!legacyLanes || typeof legacyLanes !== "object" || !Array.isArray(record.commands)) {
    throw new Error(`RELAY_MANAGER_UNREADABLE: malformed v1 state at ${file}`);
  }
  const commands = (record.commands as unknown[]).map((raw) => migrateV1Command(raw, file));
  const now = typeof record.updated_at === "string" ? record.updated_at : new Date().toISOString();
  return Object.freeze({
    schema_version: RELAY_MANAGER_SCHEMA_VERSION,
    goal_id: String(record.goal_id || ""),
    revision: 0,
    active_lane: record.active_lane as RelayLaneId | null,
    lanes: Object.freeze({
      A: Object.freeze({ ...emptyLane("A"), observation: parseLegacyObservation(legacyLanes.A, "A") }),
      B: Object.freeze({ ...emptyLane("B"), observation: parseLegacyObservation(legacyLanes.B, "B") }),
    }),
    commands: Object.freeze(commands),
    updated_at: now,
    migrated_from_v1: true,
  });
}

function migrateV1Command(value: unknown, file: string): RelayCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`RELAY_MANAGER_UNREADABLE: malformed v1 command at ${file}`);
  }
  const command = value as Record<string, unknown>;
  if (
    typeof command.command_id !== "string" || command.kind !== "resume_goal" ||
    !(command.lane === "A" || command.lane === "B") || typeof command.handoff_id !== "string" ||
    typeof command.goal_id !== "string" || !Number.isSafeInteger(command.goal_revision) ||
    typeof command.created_at !== "string" || typeof command.updated_at !== "string" || typeof command.expires_at !== "string"
  ) throw new Error(`RELAY_MANAGER_UNREADABLE: malformed v1 command at ${file}`);
  return Object.freeze({
    command_id: command.command_id,
    kind: "resume_goal",
    lane: command.lane,
    worker_id: null,
    generation: null,
    registry_revision: null,
    provision_id: null,
    provision_attempt_id: null,
    source_worker_id: null,
    probe_id: null,
    expected_source_driver_epoch: null,
    expected_source_lease_id: null,
    recovery_policy_revision: null,
    recovery_policy_enabled_at: null,
    handoff_id: command.handoff_id,
    goal_id: command.goal_id,
    goal_revision: Number(command.goal_revision),
    marker: typeof command.marker === "string" ? command.marker : null,
    message: typeof command.message === "string" ? command.message : null,
    state: String(command.state) as RelayCommandState,
    claimed_by_instance_id: typeof command.claimed_by_tab_instance_id === "string" ? command.claimed_by_tab_instance_id : null,
    claimed_by_tab_instance_id: typeof command.claimed_by_tab_instance_id === "string" ? command.claimed_by_tab_instance_id : null,
    claim_count: normalizeNonNegativeInt(Number(command.claim_count)),
    created_at: command.created_at,
    updated_at: command.updated_at,
    expires_at: command.expires_at,
    failure_detail: typeof command.failure_detail === "string" ? command.failure_detail : null,
  });
}

function parseState(raw: string, file: string): { state: RelayManagerState; source_schema_version: 1 | 2 } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(`RELAY_MANAGER_UNREADABLE: invalid JSON at ${file}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`RELAY_MANAGER_UNREADABLE: invalid state at ${file}`);
  const record = value as Record<string, unknown>;
  if (record.schema_version === LEGACY_RELAY_MANAGER_SCHEMA_VERSION) {
    return { state: migrateV1(record, file), source_schema_version: 1 };
  }
  if (
    record.schema_version !== RELAY_MANAGER_SCHEMA_VERSION || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 ||
    !(record.active_lane === null || record.active_lane === "A" || record.active_lane === "B") ||
    !record.lanes || typeof record.lanes !== "object" || Array.isArray(record.lanes) ||
    !Array.isArray(record.commands) || typeof record.updated_at !== "string"
  ) throw new Error(`RELAY_MANAGER_UNREADABLE: unsupported or malformed state at ${file}`);
  const lanes = record.lanes as Record<string, unknown>;
  for (const lane of ["A", "B"] as const) {
    const rawLane = lanes[lane];
    if (!rawLane || typeof rawLane !== "object" || Array.isArray(rawLane)) throw new Error(`RELAY_MANAGER_UNREADABLE: missing lane ${lane} at ${file}`);
  }
  return { state: record as unknown as RelayManagerState, source_schema_version: 2 };
}

async function readStateFile(workspaceRoot: string): Promise<StateFile | null> {
  const file = relayManagerPath(workspaceRoot);
  try {
    const raw = await readRelayStateText(workspaceRoot, "manager.json");
    if (raw === null) return null;
    const parsed = parseState(raw, file);
    if (parsed.state.goal_id !== requireRelayGoal(workspaceRoot)) throw new Error("RELAY_MANAGER_GOAL_SCOPE_MISMATCH");
    for (const command of parsed.state.commands) {
      if (command.goal_id !== parsed.state.goal_id &&
          (command.goal_id || !["ACKED", "FAILED", "EXPIRED"].includes(command.state))) {
        throw new Error("RELAY_COMMAND_GOAL_SCOPE_MISMATCH");
      }
    }
    return { state: parsed.state, sha256: sha256(raw), source_schema_version: parsed.source_schema_version };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function withStateMutationLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = relayScopeKey(workspaceRoot);
  const previous = stateMutationChains.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => gate);
  stateMutationChains.set(key, chain);
  await previous.catch(() => undefined);
  try { await ensureRelayGoalStorage(workspaceRoot); return await operation(); } finally {
    release();
    if (stateMutationChains.get(key) === chain) stateMutationChains.delete(key);
  }
}

async function mutateState(
  workspaceRoot: string,
  mutation: (current: RelayManagerState) => RelayManagerState
): Promise<RelayManagerState> {
  return withStateMutationLock(workspaceRoot, async () => {
    const currentFile = await readStateFile(workspaceRoot);
    const before = currentFile?.state ?? initialState(requireRelayGoal(workspaceRoot));
    const mutated = mutation(before);
    if (mutated === before && currentFile?.source_schema_version !== 1) return before;
    if (before.fenced_at) throw new Error("RELAY_GOAL_FENCED: superseded Goal cannot mutate its manager");
    const next = mutated === before
      ? Object.freeze({ ...before, schema_version: RELAY_MANAGER_SCHEMA_VERSION, revision: before.revision + 1, migrated_from_v1: true, updated_at: new Date().toISOString() })
      : Object.freeze({ ...mutated, revision: Math.max(mutated.revision, before.revision + 1) });
    const file = relayManagerPath(workspaceRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeTextFileCas(file, `${JSON.stringify(next, null, 2)}\n`, currentFile ? { expectedSha256: currentFile.sha256 } : { createOnly: true });
    return next;
  });
}

function projectRegistry(state: RelayManagerState, registry: WorkerRegistryState): RelayManagerState {
  if (registry.revision === 0 && Object.keys(registry.workers).length === 0) return state;
  const lanes = Object.freeze({
    A: Object.freeze({ ...state.lanes.A, active_worker_id: registry.lanes.A.active_worker_id, standby_worker_id: registry.lanes.A.standby_worker_id, next_generation: registry.lanes.A.next_generation }),
    B: Object.freeze({ ...state.lanes.B, active_worker_id: registry.lanes.B.active_worker_id, standby_worker_id: registry.lanes.B.standby_worker_id, next_generation: registry.lanes.B.next_generation }),
  });
  return Object.freeze({ ...state, lanes });
}

export async function readRelayManagerState(workspaceRoot: string, goalId?: string): Promise<RelayManagerState> {
  return withResolvedRelayGoal(workspaceRoot, goalId, async () => {
  const state = (await readStateFile(workspaceRoot))?.state ?? initialState(requireRelayGoal(workspaceRoot));
  return projectRegistry(state, await readWorkerRegistry(workspaceRoot));
  });
}

export function relayLaneObservation(lane: RelayLaneState | RelayLaneObservation | null): RelayLaneObservation | null {
  if (!lane) return null;
  return "observation" in lane ? lane.observation : lane;
}

export function relayLaneIsFresh(lane: RelayLaneState | RelayLaneObservation | null, nowMs = Date.now()): boolean {
  const observation = relayLaneObservation(lane);
  if (!observation) return false;
  const seen = Date.parse(observation.last_seen_at);
  return Number.isFinite(seen) && nowMs - seen <= laneFreshMs();
}

export function relayLaneCanReceive(lane: RelayLaneState | RelayLaneObservation | null, nowMs = Date.now()): boolean {
  const observation = relayLaneObservation(lane);
  return Boolean(
    observation && observation.conversation_surface === "CHAT" && relayLaneIsFresh(observation, nowMs) &&
    observation.composer_ready && !observation.generation_active &&
    !observation.connection_interrupted && observation.adapter_confidence !== "low"
  );
}

function workerIsFresh(worker: WorkerRecord, nowMs = Date.now()): boolean {
  if (!worker.last_browser_seen_at) return false;
  const seen = Date.parse(worker.last_browser_seen_at);
  return Number.isFinite(seen) && nowMs - seen <= laneFreshMs();
}

function workerCanReceive(worker: WorkerRecord | null, nowMs = Date.now()): boolean {
  // Migrated v1 Workers intentionally do not pretend to know the MCP-session
  // authority mapping. Their legacy receive eligibility is therefore still
  // derived from fresh browser/composer telemetry until a real provisioned
  // generation replaces them. Provisioned generations are not eligible for
  // authority until a real MCP capability claim has bound a formal Chat.
  const lifecycleReady = Boolean(worker && (
    worker.provision_id.startsWith("legacy_") || workerReadyForAuthority(worker, nowMs, capabilityFreshMs())
  ));
  return Boolean(worker && worker.conversation_surface === "CHAT" && lifecycleReady && workerIsFresh(worker, nowMs) &&
    worker.composer_ready && !worker.generation_active &&
    !worker.connection_interrupted && worker.adapter_confidence !== "low");
}

/**
 * A standby only needs one durable browser/MCP binding while it is idle.
 * Fresh capability is still required at the instant authority moves, and the
 * handoff/recovery paths already enqueue a new bootstrap when that proof is
 * stale. Treating a one-minute-old proof as "not prewarmed" here caused the
 * background poller to send another ChatGPT turn every capability window.
 */
function workerHasEstablishedStandby(worker: WorkerRecord | null, nowMs = Date.now()): boolean {
  return Boolean(
    worker && worker.state === "READY" && worker.conversation_surface === "CHAT" && worker.bound_session_id &&
    worker.claim_consumed_at && worker.last_capability_at &&
    isFormalChatConversationUrl(worker.conversation_url) &&
    workerIsFresh(worker, nowMs) && worker.composer_ready && !worker.generation_active &&
    !worker.connection_interrupted && worker.adapter_confidence !== "low"
  );
}

function workerCanBootstrap(worker: WorkerRecord | null, nowMs = Date.now()): boolean {
  return Boolean(
    worker && worker.conversation_surface === "CHAT" && !worker.provision_id.startsWith("legacy_") && workerReadyForBootstrap(worker) &&
    workerIsFresh(worker, nowMs) && worker.adapter_confidence !== "low"
  );
}

const REPLACEMENT_PROGRESS_STATES = new Set<WorkerRecord["state"]>([
  "REQUESTED",
  "PROVISIONING",
  "TAB_CREATED",
  "READY_BLANK",
  "ACTIVATING",
  "READY",
  "PROVISION_AMBIGUOUS",
]);

export function replacementProgressTimedOut(worker: WorkerRecord | null, nowMs = Date.now()): boolean {
  if (!worker || !REPLACEMENT_PROGRESS_STATES.has(worker.state)) return false;
  const progressAt = worker.last_browser_seen_at ?? worker.updated_at ?? worker.created_at;
  const progressMs = Date.parse(progressAt);
  return !Number.isFinite(progressMs) || nowMs - progressMs >= replacementProgressTimeoutMs();
}

async function terminalizeTimedOutReplacement(workspaceRoot: string, worker: WorkerRecord): Promise<void> {
  if (!REPLACEMENT_PROGRESS_STATES.has(worker.state)) return;
  const failedBeforeBrowserReady = ["REQUESTED", "PROVISIONING", "TAB_CREATED"].includes(worker.state);
  await transitionWorker(workspaceRoot, worker.worker_id, failedBeforeBrowserReady ? "FAILED" : "DEAD", {
    expectedRecordRevision: worker.record_revision,
    detail: "replacement_progress_timeout",
    patch: { death_reason: "replacement_progress_timeout" },
  });
}

async function clearReplacementReference(workspaceRoot: string, lane: RelayLaneId, workerId: string): Promise<void> {
  await mutateState(workspaceRoot, (current) => {
    const currentLane = current.lanes[lane];
    if (currentLane.replacement_worker_id !== workerId) return current;
    return Object.freeze({
      ...current,
      lanes: Object.freeze({
        ...current.lanes,
        [lane]: Object.freeze({
          ...currentLane,
          replacement_worker_id: null,
          replacement_source_worker_id: null,
        }),
      }),
      updated_at: new Date().toISOString(),
    });
  });
}

function workerObservation(worker: WorkerRecord | null): RelayLaneObservation | null {
  if (!worker?.tab_instance_id || !worker.conversation_url || !worker.last_browser_seen_at) return null;
  return Object.freeze({
    lane: worker.lane,
    tab_instance_id: worker.tab_instance_id,
    conversation_url: worker.conversation_url,
    adapter_version: worker.adapter_version ?? "worker-registry",
    adapter_confidence: worker.adapter_confidence,
    conversation_surface: worker.conversation_surface ?? "UNKNOWN",
    composer_ready: worker.composer_ready,
    generation_active: worker.generation_active,
    connection_interrupted: worker.connection_interrupted,
    tool_inflight_count: 0,
    tool_activity_count: 0,
    activity_revision: worker.activity_revision,
    turn_id: worker.turn_id ?? null,
    turn_started_at: worker.turn_started_at ?? null,
    stop_button_visible: worker.stop_button_visible ?? false,
    retry_visible: worker.retry_visible ?? false,
    assistant_token_revision: worker.assistant_token_revision ?? 0,
    ...(worker.feedback_ledger ? { feedback_ledger: worker.feedback_ledger } : {}),
    last_dom_activity_at: worker.last_dom_activity_at ?? null,
    last_assistant_token_at: worker.last_assistant_token_at ?? null,
    last_mcp_activity_at: worker.last_mcp_seen_at,
    stable_observation_windows: worker.stable_observation_windows ?? 0,
    last_seen_at: worker.last_browser_seen_at,
    bound_at: worker.created_at,
  });
}

async function migrateLegacyWorkersFromManager(workspaceRoot: string, state?: RelayManagerState): Promise<WorkerRegistryState> {
  const manager = state ?? await readRelayManagerState(workspaceRoot);
  return migrateLegacyLaneWorkers(workspaceRoot, {
    A: manager.lanes.A.observation ? { ...manager.lanes.A.observation } : null,
    B: manager.lanes.B.observation ? { ...manager.lanes.B.observation } : null,
  }, manager.active_lane);
}

async function recordRelayLaneHeartbeatScoped(workspaceRoot: string, input: RelayLaneHeartbeatInput): Promise<RelayManagerState> {
  if (!relayCompanionEnabled()) throw new Error("COMPANION_DISABLED: Browser Companion is not enabled");
  const tabInstanceId = input.tab_instance_id.trim();
  const conversationUrl = input.conversation_url.trim();
  const adapterVersion = input.adapter_version.trim();
  const conversationSurface = input.conversation_surface ?? "UNKNOWN";
  if (!tabInstanceId || !conversationUrl || !adapterVersion) {
    throw new Error("COMPANION_HEARTBEAT_INVALID: tab_instance_id, conversation_url and adapter_version are required");
  }
  if (!["CHAT", "WORK", "UNKNOWN"].includes(conversationSurface)) {
    throw new Error("COMPANION_HEARTBEAT_INVALID: conversation_surface must be CHAT, WORK or UNKNOWN");
  }
  const workerFields = [input.worker_id, input.generation, input.provision_id];
  if (workerFields.some((value) => value !== undefined) && workerFields.some((value) => value === undefined)) {
    throw new Error("WORKER_HEARTBEAT_IDENTITY_REQUIRED: worker_id, generation and provision_id must be supplied together");
  }
  let registry: WorkerRegistryState | null = null;
  if (input.worker_id && input.generation !== undefined && input.provision_id) {
    const result = await recordWorkerBrowserHeartbeat(workspaceRoot, {
      workerId: input.worker_id,
      lane: input.lane,
      generation: input.generation,
      provisionId: input.provision_id,
      companionInstanceId: input.companion_instance_id,
      tabInstanceId,
      conversationUrl,
      adapterVersion,
      adapterConfidence: input.adapter_confidence ?? "unknown",
      conversationSurface,
      composerReady: input.composer_ready,
      generationActive: input.generation_active,
      connectionInterrupted: input.connection_interrupted,
      activityRevision: input.activity_revision,
      turnId: input.turn_id,
      turnStartedAt: input.turn_started_at,
      stopButtonVisible: input.stop_button_visible,
      retryVisible: input.retry_visible,
      toolInflightCount: input.tool_inflight_count,
      assistantTokenRevision: input.assistant_token_revision,
      feedbackLedger: input.feedback_ledger,
    });
    registry = result.registry;
  }
  const now = new Date().toISOString();
  const state = await mutateState(workspaceRoot, (current) => {
    const previous = current.lanes[input.lane].observation;
    const currentRegistryWorker = registry && input.worker_id ? registry.workers[input.worker_id] : null;
    const registryActiveId = registry?.lanes[input.lane].active_worker_id ?? null;
    const mayProject = !input.worker_id || !registryActiveId || registryActiveId === input.worker_id || previous?.tab_instance_id === tabInstanceId;
    if (!input.worker_id && previous && previous.tab_instance_id !== tabInstanceId && relayLaneIsFresh(previous)) {
      throw new Error(`RELAY_LANE_CONFLICT: legacy lane ${input.lane} is still owned by another live tab`);
    }
    const nextTurnId = input.turn_id?.trim().slice(0, 256) || null;
    const turnChanged = nextTurnId !== previous?.turn_id;
    const legacyFeedbackResult = !input.worker_id && input.feedback_ledger !== undefined
      ? normalizeVisibleFeedbackLedger(input.feedback_ledger, Date.now(), turnChanged ? null : previous?.feedback_ledger ?? null, nextTurnId)
      : null;
    if (legacyFeedbackResult && !legacyFeedbackResult.ok && legacyFeedbackResult.reason === "invalid") {
      throw new Error(`VISIBLE_FEEDBACK_LEDGER_INVALID: ${legacyFeedbackResult.detail}`);
    }
    const projectedFeedbackLedger = currentRegistryWorker
      ? currentRegistryWorker.feedback_ledger
      : legacyFeedbackResult?.ok ? legacyFeedbackResult.value : turnChanged ? undefined : previous?.feedback_ledger;
    const nextActivityRevision = turnChanged
      ? normalizeNonNegativeInt(input.activity_revision)
      : Math.max(previous?.activity_revision ?? 0, normalizeNonNegativeInt(input.activity_revision));
    const nextAssistantTokenRevision = normalizeNonNegativeInt(input.assistant_token_revision);
    const nextToolInflightCount = normalizeNonNegativeInt(input.tool_inflight_count);
    const stableSignals = Boolean(
      nextTurnId && !turnChanged && previous &&
      nextActivityRevision === previous.activity_revision &&
      nextAssistantTokenRevision === previous.assistant_token_revision &&
      input.generation_active === previous.generation_active &&
      Boolean(input.stop_button_visible) === previous.stop_button_visible &&
      input.connection_interrupted === previous.connection_interrupted &&
      Boolean(input.retry_visible) === previous.retry_visible &&
      nextToolInflightCount === previous.tool_inflight_count
    );
    const priorTurnStartedAt = !turnChanged ? previous?.turn_started_at ?? null : null;
    const turnStartedAt = nextTurnId
      ? normalizeTimestamp(input.turn_started_at) || priorTurnStartedAt || now
      : null;
    const observation: RelayLaneObservation = Object.freeze({
      lane: input.lane,
      tab_instance_id: tabInstanceId,
      conversation_url: conversationUrl,
      adapter_version: adapterVersion,
      adapter_confidence: input.adapter_confidence ?? "unknown",
      conversation_surface: currentRegistryWorker?.conversation_surface ?? conversationSurface,
      composer_ready: input.composer_ready,
      generation_active: input.generation_active,
      connection_interrupted: input.connection_interrupted,
      tool_inflight_count: nextToolInflightCount,
      tool_activity_count: normalizeNonNegativeInt(input.tool_activity_count),
      activity_revision: nextActivityRevision,
      turn_id: currentRegistryWorker?.turn_id ?? nextTurnId,
      turn_started_at: currentRegistryWorker?.turn_started_at ?? turnStartedAt,
      stop_button_visible: currentRegistryWorker?.stop_button_visible ?? input.stop_button_visible ?? false,
      retry_visible: currentRegistryWorker?.retry_visible ?? input.retry_visible ?? false,
      assistant_token_revision: currentRegistryWorker?.assistant_token_revision ?? nextAssistantTokenRevision,
      ...(projectedFeedbackLedger ? { feedback_ledger: projectedFeedbackLedger } : {}),
      last_dom_activity_at: currentRegistryWorker?.last_dom_activity_at ?? (nextTurnId
        ? (turnChanged || nextActivityRevision > (previous?.activity_revision ?? 0) ? now : previous?.last_dom_activity_at ?? now)
        : null),
      last_assistant_token_at: currentRegistryWorker?.last_assistant_token_at ?? (nextTurnId
        ? (turnChanged || nextAssistantTokenRevision > (previous?.assistant_token_revision ?? 0) ? now : previous?.last_assistant_token_at ?? null)
        : null),
      last_mcp_activity_at: currentRegistryWorker?.last_mcp_seen_at ?? previous?.last_mcp_activity_at ?? null,
      stable_observation_windows: currentRegistryWorker?.stable_observation_windows ?? (stableSignals
        ? (previous?.stable_observation_windows ?? 0) + 1
        : 0),
      last_seen_at: now,
      bound_at: previous?.tab_instance_id === tabInstanceId ? previous.bound_at : (currentRegistryWorker?.created_at ?? now),
    });
    const lane = Object.freeze({ ...current.lanes[input.lane], observation: mayProject ? observation : previous });
    const activeLane = current.active_lane ?? (
      conversationSurface === "CHAT" && input.generation_active && (!input.worker_id || currentRegistryWorker?.state === "ACTIVE")
        ? input.lane
        : null
    );
    return Object.freeze({ ...current, active_lane: activeLane, lanes: Object.freeze({ ...current.lanes, [input.lane]: lane }), updated_at: now });
  });
  if (!input.worker_id) {
    registry = await migrateLegacyWorkersFromManager(workspaceRoot, state);
  }
  if (input.worker_id && conversationSurface === "CHAT" && input.composer_ready && !input.generation_active) {
    await markWorkerProvisionCommandReady(workspaceRoot, input.worker_id);
  }
  return projectRegistry(await readRelayManagerState(workspaceRoot), registry ?? await readWorkerRegistry(workspaceRoot));
}

function pruneCommands(commands: readonly RelayCommand[]): RelayCommand[] {
  if (commands.length <= MAX_COMMAND_HISTORY) return [...commands];
  const terminalStates: RelayCommandState[] = ["ACKED", "FAILED", "EXPIRED", "AMBIGUOUS"];
  const active = commands.filter((command) => !terminalStates.includes(command.state));
  const terminal = commands.filter((command) => terminalStates.includes(command.state));
  return [...terminal.slice(-Math.max(0, MAX_COMMAND_HISTORY - active.length)), ...active].slice(-MAX_COMMAND_HISTORY);
}

function newCommandBase(kind: RelayCommandKind, lane: RelayLaneId, input: Partial<RelayCommand>): RelayCommand {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  return Object.freeze({
    command_id: input.command_id ?? `${kind}_${randomUUID()}`,
    kind,
    lane,
    worker_id: input.worker_id ?? null,
    generation: input.generation ?? null,
    registry_revision: input.registry_revision ?? null,
    provision_id: input.provision_id ?? null,
    provision_attempt_id: input.provision_attempt_id ?? null,
    source_worker_id: input.source_worker_id ?? null,
    probe_id: input.probe_id ?? null,
    expected_source_driver_epoch: input.expected_source_driver_epoch ?? null,
    expected_source_lease_id: input.expected_source_lease_id ?? null,
    recovery_policy_revision: input.recovery_policy_revision ?? null,
    recovery_policy_enabled_at: input.recovery_policy_enabled_at ?? null,
    handoff_id: input.handoff_id ?? null,
    goal_id: input.goal_id ?? null,
    goal_revision: input.goal_revision ?? null,
    marker: input.marker ?? null,
    message: input.message ?? null,
    state: "PENDING",
    claimed_by_instance_id: null,
    claimed_by_tab_instance_id: null,
    claim_count: 0,
    created_at: now,
    updated_at: now,
    expires_at: new Date(nowMs + commandTtlMs()).toISOString(),
    failure_detail: null,
  });
}

async function enqueueCommand(workspaceRoot: string, command: RelayCommand, duplicate: (item: RelayCommand) => boolean): Promise<RelayCommand> {
  command = Object.freeze({ ...command, goal_id: requireRelayGoal(workspaceRoot, command.goal_id ?? undefined) });
  await mutateState(workspaceRoot, (current) => {
    if (current.commands.some(duplicate)) return current;
    return Object.freeze({ ...current, commands: Object.freeze(pruneCommands([...current.commands, command])), updated_at: new Date().toISOString() });
  });
  return (await readRelayManagerState(workspaceRoot)).commands.find(duplicate) ?? command;
}

function automaticDeliveryAttemptStillBlocksRetry(command: RelayCommand, nowMs = Date.now()): boolean {
  if (["PENDING", "CLAIMED", "SENT"].includes(command.state)) return true;
  // An ambiguous browser effect must never be activated again automatically.
  if (command.state === "AMBIGUOUS") return Date.parse(command.expires_at) > nowMs;
  if (command.state !== "FAILED") return false;
  const failedAt = Date.parse(command.updated_at);
  return Number.isFinite(failedAt) && nowMs - failedAt < browserDeliveryRetryMs();
}

async function enqueueRelayResumeCommandScoped(
  workspaceRoot: string,
  input: { lane: RelayLaneId; handoff_id: string; goal_id: string; goal_revision: number }
): Promise<RelayResumeCommand> {
  const commandId = `relay_${randomUUID()}`;
  const marker = `[WH-RELAY:${commandId}]`;
  const command = newCommandBase("resume_goal", input.lane, {
    command_id: commandId,
    handoff_id: input.handoff_id,
    goal_id: input.goal_id,
    goal_revision: input.goal_revision,
    marker,
    message: `${marker} Resume Goal ${input.goal_id} from relay handoff ${input.handoff_id}. First call goal(action=bind, handoff_id=${input.handoff_id}). On a relay takeover, use relay_intent_json exactly as _intent. Use durable handoff/Process/Operation/Evidence truth and do not repeat completed side effects. Continue autonomously until completion or a verified user-only blocker.`,
  });
  return enqueueCommand(workspaceRoot, command, (item) => item.handoff_id === input.handoff_id && !["FAILED", "EXPIRED", "AMBIGUOUS"].includes(item.state));
}

/**
 * Wake the newly authoritative Worker after an automatic recovery commit.
 * Binding and continuing are deliberately separate browser turns: a bind can
 * consume most of one model turn, and relying on that same response to also
 * reconstruct and execute the Goal caused successful takeovers to stop after
 * goal(status). The recovery command is the durable authorization anchor;
 * this follow-up carries task context only and cannot move Driver authority.
 */
async function enqueueRelayRecoveryContinuationScoped(
  workspaceRoot: string,
  input: { recoveryId: string; workerId: string; goalRevision: number; instruction: string }
): Promise<RelayCommand> {
  const recoveryId = input.recoveryId.trim();
  const workerId = input.workerId.trim();
  const instruction = input.instruction.trim();
  if (!recoveryId || !workerId || !instruction || instruction.length > 12_000 || !Number.isSafeInteger(input.goalRevision)) {
    throw new Error("RELAY_CONTINUATION_INVALID: committed recovery, Worker, Goal revision and bounded instruction are required");
  }
  const manager = await readRelayManagerState(workspaceRoot);
  const recovery = manager.commands.find((item) => item.kind === "recover_worker" && item.command_id === recoveryId);
  const registry = await readWorkerRegistry(workspaceRoot);
  const worker = registry.workers[workerId];
  const lease = await readDriverLease(workspaceRoot);
  if (!recovery || recovery.state !== "ACKED" || recovery.worker_id !== workerId || !recovery.goal_id) {
    throw new Error("RELAY_CONTINUATION_RECOVERY_NOT_COMMITTED: recovery command is not committed to this Worker");
  }
  if (!worker || worker.state !== "ACTIVE" || worker.bound_session_id !== lease?.owner_session_id ||
      lease.state !== "ACTIVE" || lease.goal_id !== recovery.goal_id || lease.epoch !== (recovery.expected_source_driver_epoch ?? -1) + 1) {
    throw new Error("RELAY_CONTINUATION_DRIVER_MISMATCH: Worker is not the current post-recovery Driver");
  }
  const continuationId = `continuation_${recoveryId}`;
  // The handoff id is the stable logical continuation identity used for
  // de-duplication while a delivery is live.  The transcript marker must have
  // a different lifetime: once a failed/expired delivery is retried, an old
  // user turn is still present in ChatGPT's transcript.  Reusing a marker lets
  // that old turn falsely prove the retry was sent, so the replacement command
  // never reaches the model.  Bind proof to the physical command attempt.
  const commandId = `resume_goal_${randomUUID()}`;
  const marker = `[WH-CONTINUE:${commandId}]`;
  const command = newCommandBase("resume_goal", worker.lane, {
    command_id: commandId,
    worker_id: worker.worker_id,
    generation: worker.generation,
    registry_revision: registry.revision,
    provision_id: worker.provision_id,
    source_worker_id: recovery.source_worker_id,
    handoff_id: continuationId,
    goal_id: recovery.goal_id,
    goal_revision: input.goalRevision,
    marker,
    message: `${marker} Driver recovery is committed: you are the authoritative Worker for Goal ${recovery.goal_id}. Do not bind again. Continue the same Goal now. For this post-recovery continuation, omit _intent from side-effecting tool calls: Harness will reuse the valid execution contract inherited during bind only for the exact current Driver/Goal/epoch and will fail closed otherwise. Re-read goal(action=status) only if needed, then execute and verify the remaining work. Durable continuation instruction: ${instruction}`,
  });
  return enqueueCommand(
    workspaceRoot,
    command,
    (item) => item.kind === "resume_goal" && item.handoff_id === continuationId && item.worker_id === workerId &&
      !["FAILED", "EXPIRED", "AMBIGUOUS"].includes(item.state) && Date.parse(item.expires_at) > Date.now()
  );
}

async function enqueueWorkerProvisionCommandScoped(workspaceRoot: string, worker: WorkerRecord, registryRevision: number): Promise<RelayCommand> {
  const command = newCommandBase("provision_worker", worker.lane, {
    worker_id: worker.worker_id,
    generation: worker.generation,
    registry_revision: registryRevision,
    provision_id: worker.provision_id,
    provision_attempt_id: worker.provision_attempt_id,
  });
  // ACK means the Companion accepted this exact provision attempt. It is a
  // terminal success for command delivery, not permission to send a fresh
  // command every automation poll while browser lifecycle telemetry catches
  // up. A failed/expired/ambiguous attempt may be retried explicitly.
  return enqueueCommand(workspaceRoot, command, (item) => item.kind === "provision_worker" &&
    item.worker_id === worker.worker_id && item.provision_attempt_id === worker.provision_attempt_id &&
    !["FAILED", "EXPIRED", "AMBIGUOUS"].includes(item.state));
}

async function enqueueWorkerBootstrapCommandScoped(
  workspaceRoot: string,
  input: { worker: WorkerRecord; registryRevision: number; goalId: string }
): Promise<RelayCommand> {
  const command = newCommandBase("bootstrap_worker", input.worker.lane, {
    worker_id: input.worker.worker_id,
    generation: input.worker.generation,
    registry_revision: input.registryRevision,
    provision_id: input.worker.provision_id,
    provision_attempt_id: input.worker.provision_attempt_id,
    goal_id: input.goalId,
    probe_id: `bootstrap_${randomUUID()}`,
  });
  return enqueueCommand(
    workspaceRoot,
    command,
    (item) => item.kind === "bootstrap_worker" && item.worker_id === input.worker.worker_id &&
      automaticDeliveryAttemptStillBlocksRetry(item)
  );
}

async function enqueueWorkerActivationCommandScoped(
  workspaceRoot: string,
  input: { lane: RelayLaneId; worker: WorkerRecord; registryRevision: number; sourceWorkerId: string | null; handoffId: string; goalId: string; goalRevision: number }
): Promise<RelayCommand> {
  const command = newCommandBase("activate_worker", input.lane, {
    worker_id: input.worker.worker_id,
    generation: input.worker.generation,
    registry_revision: input.registryRevision,
    provision_id: input.worker.provision_id,
    source_worker_id: input.sourceWorkerId,
    handoff_id: input.handoffId,
    goal_id: input.goalId,
    goal_revision: input.goalRevision,
  });
  return enqueueCommand(workspaceRoot, command, (item) => item.kind === "activate_worker" && item.handoff_id === input.handoffId && item.worker_id === input.worker.worker_id && !["FAILED", "EXPIRED", "AMBIGUOUS"].includes(item.state));
}

async function enqueueHealthProbeCommandScoped(
  workspaceRoot: string,
  input: { worker: WorkerRecord; lease: DriverLease }
): Promise<RelayCommand> {
  const probeId = `probe_${randomUUID()}`;
  const command = newCommandBase("health_probe", input.worker.lane, {
    worker_id: input.worker.worker_id,
    generation: input.worker.generation,
    provision_id: input.worker.provision_id,
    source_worker_id: input.worker.worker_id,
    goal_id: input.lease.goal_id,
    probe_id: probeId,
    expected_source_driver_epoch: input.lease.epoch,
    expected_source_lease_id: input.lease.lease_id,
  });
  return enqueueCommand(
    workspaceRoot,
    command,
    (item) => item.kind === "health_probe" && item.worker_id === input.worker.worker_id &&
      item.expected_source_driver_epoch === input.lease.epoch && item.expected_source_lease_id === input.lease.lease_id &&
      !["ACKED", "FAILED", "EXPIRED", "AMBIGUOUS"].includes(item.state)
  );
}

async function enqueueWorkerRecoveryCommandScoped(
  workspaceRoot: string,
  input: { sourceWorker: WorkerRecord; targetWorker: WorkerRecord; lease: DriverLease; policy: Extract<RecoveryAuthorization, { kind: "RELAY_POLICY" }>; registryRevision: number }
): Promise<RelayCommand> {
  if (input.lease.goal_id !== requireRelayGoal(workspaceRoot) || input.policy.goal_id !== input.lease.goal_id || input.sourceWorker.goal_id !== input.lease.goal_id || input.targetWorker.goal_id !== input.lease.goal_id) throw new Error("RELAY_RECOVERY_GOAL_MISMATCH");
  const command = newCommandBase("recover_worker", input.targetWorker.lane, {
    worker_id: input.targetWorker.worker_id,
    generation: input.targetWorker.generation,
    registry_revision: input.registryRevision,
    provision_id: input.targetWorker.provision_id,
    source_worker_id: input.sourceWorker.worker_id,
    goal_id: input.lease.goal_id,
    expected_source_driver_epoch: input.lease.epoch,
    expected_source_lease_id: input.lease.lease_id,
    recovery_policy_revision: input.policy.policy_revision,
    recovery_policy_enabled_at: input.policy.enabled_at,
  });
  return enqueueCommand(
    workspaceRoot,
    command,
    (item) => item.kind === "recover_worker" && item.worker_id === input.targetWorker.worker_id &&
      item.source_worker_id === input.sourceWorker.worker_id && item.expected_source_driver_epoch === input.lease.epoch &&
      item.expected_source_lease_id === input.lease.lease_id && automaticDeliveryAttemptStillBlocksRetry(item)
  );
}

async function claimCommandBy(workspaceRoot: string, predicate: (command: RelayCommand) => boolean, claimant: string, tabInstanceId: string | null): Promise<RelayCommand | null> {
  let claimed: RelayCommand | null = null;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  await mutateState(workspaceRoot, (current) => {
    let changed = false;
    const commands = current.commands.map((command) => {
      if (!predicate(command)) return command;
      if (command.state === "CLAIMED" && command.claimed_by_instance_id === claimant) {
        if (Date.parse(command.expires_at) <= nowMs) {
          changed = true;
          return Object.freeze({ ...command, state: "EXPIRED" as const, updated_at: now });
        }
        claimed = command;
        return command;
      }
      if (claimed || command.state !== "PENDING") return command;
      if (Date.parse(command.expires_at) <= nowMs) {
        changed = true;
        return Object.freeze({ ...command, state: "EXPIRED" as const, updated_at: now });
      }
      const next: RelayCommand = Object.freeze({
        ...command,
        state: "CLAIMED",
        claimed_by_instance_id: claimant,
        claimed_by_tab_instance_id: tabInstanceId,
        claim_count: command.claim_count + 1,
        updated_at: now,
      });
      claimed = next;
      changed = true;
      return next;
    });
    return changed ? Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now }) : current;
  });
  return claimed;
}

async function activationDelivery(workspaceRoot: string, command: RelayCommand): Promise<RelayCommandDelivery> {
  if (command.kind === "bootstrap_worker" && command.worker_id && command.goal_id) {
    await mintWorkerClaimTicket(workspaceRoot, {
      workerId: command.worker_id,
      handoffId: command.command_id,
      kind: "PROBE",
    });
    const marker = `[WH-BOOTSTRAP:${command.command_id}:${command.worker_id}]`;
    const message = `${marker} You are prewarmed Worker ${command.worker_id} (${command.lane}:g${command.generation}) for durable Goal ${command.goal_id}. This is a capability bootstrap only: do not continue the task and do not perform side effects. Call goal(action=status, handoff_id=${command.command_id}) exactly once, then stop. Do not send or request any token: authenticated Browser Companion delivery plus this single fresh MCP arrival forms the one-time capability proof. Successful MCP arrival proves this conversation can host Web Harness; Driver authority remains with the current Worker.`;
    return Object.freeze({ ...command, marker, message });
  }
  if (command.kind === "health_probe" && command.worker_id && command.probe_id) {
    const marker = `[WH-PROBE:${command.probe_id}:${command.worker_id}]`;
    const message = `${marker} Web Harness read-only capability probe. Do not continue the task and do not perform side effects. Call goal(action=status, handoff_id=${command.probe_id}) exactly once, then stop.`;
    return Object.freeze({ ...command, marker, message });
  }
  if (command.kind === "recover_worker" && command.worker_id && command.goal_id) {
    await mintWorkerClaimTicket(workspaceRoot, { workerId: command.worker_id, handoffId: command.command_id, kind: "RECOVERY" });
    const marker = `[WH-RECOVERY:${command.command_id}:${command.worker_id}]`;
    const message = `${marker} You are recovery Worker ${command.worker_id} (${command.lane}:g${command.generation}) for Goal ${command.goal_id}. First call goal(action=bind, handoff_id=${command.command_id}). Do not send or request any token: authenticated Browser Companion delivery plus this fresh MCP arrival forms the one-time recovery claim. This is automatic ORPHAN recovery, not a normal handoff. Use relay_intent_json exactly as _intent after bind, reconstruct only from durable truth, and never repeat completed side effects.`;
    return Object.freeze({ ...command, marker, message });
  }
  if (command.kind !== "activate_worker" || !command.worker_id || !command.handoff_id || !command.goal_id) return command;
  await mintWorkerClaimTicket(workspaceRoot, { workerId: command.worker_id, handoffId: command.handoff_id, kind: "HANDOFF" });
  const marker = `[WH-RELAY:${command.command_id}:${command.worker_id}]`;
  const message = `${marker} You are Worker ${command.worker_id} (${command.lane}:g${command.generation}). Resume Goal ${command.goal_id} from handoff ${command.handoff_id}. First call goal(action=bind, handoff_id=${command.handoff_id}). Do not send or request any token: authenticated Browser Companion delivery plus this fresh MCP arrival forms the one-time handoff claim. Use the returned relay_intent_json exactly as _intent on side-effecting calls. Reconstruct from durable handoff/Process/Operation/Evidence truth; obey do_not_repeat and never infer completed effects from chat history. Continue until Goal completion or a verified user-only blocker.`;
  return Object.freeze({ ...command, marker, message });
}

async function claimRelayCommandScoped(workspaceRoot: string, laneId: RelayLaneId, tabInstanceId: string, workerId?: string): Promise<RelayCommandDelivery | null> {
  if ((await readRelayManagerState(workspaceRoot)).fenced_at) return null;
  const command = await claimCommandBy(
    workspaceRoot,
    (item) => item.goal_id === requireRelayGoal(workspaceRoot) && item.lane === laneId &&
      ["resume_goal", "bootstrap_worker", "activate_worker", "health_probe", "recover_worker"].includes(item.kind) &&
      (!item.worker_id || item.worker_id === workerId),
    `tab:${tabInstanceId}`,
    tabInstanceId
  );
  return command ? activationDelivery(workspaceRoot, command) : null;
}

async function claimRelayBootstrapCapabilityScoped(
  workspaceRoot: string,
  commandId: string,
  token: string,
  targetSessionId: string
): Promise<{ command: RelayCommand; worker: WorkerRecord; driver_adopted: boolean }> {
  const id = commandId.trim();
  const sessionId = targetSessionId.trim();
  if (!id || !token.trim() || !sessionId) throw new Error("RELAY_BOOTSTRAP_CLAIM_INVALID: command, token and target session are required");
  const state = await readRelayManagerState(workspaceRoot);
  const command = state.commands.find((item) => item.command_id === id && item.kind === "bootstrap_worker");
  if (!command?.worker_id || !command.goal_id) throw new Error(`RELAY_BOOTSTRAP_NOT_FOUND: ${id}`);
  if (["FAILED", "EXPIRED", "AMBIGUOUS"].includes(command.state)) {
    throw new Error(`RELAY_BOOTSTRAP_NOT_ACTIVE: bootstrap command is ${command.state}`);
  }
  const verified = await verifyWorkerClaimTicket(workspaceRoot, {
    workerId: command.worker_id,
    handoffId: command.command_id,
    token: token.trim(),
    targetSessionId: sessionId,
    kind: "PROBE",
  });
  if (verified.worker.conversation_surface !== "CHAT") {
    throw new Error(`RELAY_BOOTSTRAP_CHAT_SURFACE_REQUIRED: ${verified.worker.worker_id} is ${verified.worker.conversation_surface}`);
  }
  if (verified.worker.goal_id && verified.worker.goal_id !== command.goal_id) {
    throw new Error("RELAY_BOOTSTRAP_GOAL_MISMATCH: Worker bootstrap belongs to another Goal");
  }
  const consumed = await consumeWorkerClaimTicket(workspaceRoot, {
    workerId: command.worker_id,
    handoffId: command.command_id,
    token: token.trim(),
    targetSessionId: sessionId,
    kind: "PROBE",
  });
  const worker = consumed.worker;
  const now = new Date().toISOString();
  let acknowledged: RelayCommand | null = null;
  await mutateState(workspaceRoot, (current) => {
    const commands = current.commands.map((item) => {
      if (item.command_id !== command.command_id) return item;
      const next = item.state === "ACKED" ? item : Object.freeze({ ...item, state: "ACKED" as const, updated_at: now, failure_detail: null });
      acknowledged = next;
      return next;
    });
    if (!acknowledged) throw new Error(`RELAY_BOOTSTRAP_NOT_FOUND: ${id}`);
    return Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now });
  });
  // Capability bootstrap is deliberately non-authoritative. Only an explicit
  // HANDOFF/RECOVERY bind may move Driver authority or retire an ACTIVE Worker.
  return { command: acknowledged!, worker, driver_adopted: false };
}

async function claimRelayBootstrapCapabilityFromBrowserReceiptScoped(
  workspaceRoot: string,
  targetSessionId: string,
  commandId?: string
): Promise<{ command: RelayCommand; worker: WorkerRecord; driver_adopted: boolean } | null> {
  const sessionId = targetSessionId.trim();
  const requestedId = commandId?.trim() || null;
  if (!sessionId) throw new Error("RELAY_BOOTSTRAP_SESSION_REQUIRED: browser receipt requires an MCP session");
  const state = await readRelayManagerState(workspaceRoot);
  const registry = await readWorkerRegistry(workspaceRoot);
  const driver = await readDriverLease(workspaceRoot);
  const nowMs = Date.now();
  if (!driver || driver.state !== "ACTIVE") {
    if (requestedId) throw new Error(`RELAY_BOOTSTRAP_BROWSER_RECEIPT_NOT_READY: ${requestedId}`);
    return null;
  }
  const candidates = state.commands.filter((command) => {
    if (command.kind !== "bootstrap_worker" || command.state !== "SENT" || !command.worker_id || !command.goal_id) return false;
    if (requestedId && command.command_id !== requestedId) return false;
    if (Date.parse(command.expires_at) <= nowMs || driver.goal_id !== command.goal_id) return false;
    const worker = registry.workers[command.worker_id];
    if (
      !worker || worker.provision_id.startsWith("legacy_") || worker.state !== "ACTIVATING" ||
      (worker.bound_session_id && worker.bound_session_id !== sessionId)
    ) return false;
    const lastSeenMs = worker.last_browser_seen_at ? Date.parse(worker.last_browser_seen_at) : Number.NaN;
    const turnStartedMs = worker.turn_started_at ? Date.parse(worker.turn_started_at) : Number.NaN;
    const sentAtMs = Date.parse(command.updated_at);
    return Boolean(
      command.claimed_by_tab_instance_id &&
      command.claimed_by_tab_instance_id === worker.tab_instance_id &&
      worker.claim_kind === "PROBE" &&
      worker.claim_handoff_id === command.command_id &&
      worker.conversation_surface === "CHAT" &&
      isFormalChatConversationUrl(worker.conversation_url) &&
      worker.generation_active &&
      !worker.connection_interrupted &&
      worker.turn_id &&
      Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= DEFAULT_LANE_FRESH_MS &&
      Number.isFinite(turnStartedMs) && Number.isFinite(sentAtMs) &&
      lastSeenMs >= sentAtMs && turnStartedMs >= sentAtMs - 5_000
    );
  });
  if (candidates.length === 0) {
    if (requestedId) throw new Error(`RELAY_BOOTSTRAP_BROWSER_RECEIPT_NOT_READY: ${requestedId}`);
    return null;
  }
  if (candidates.length !== 1) {
    throw new Error(`RELAY_BOOTSTRAP_BROWSER_RECEIPT_AMBIGUOUS: ${candidates.length} live bootstrap turns match`);
  }
  const command = candidates[0]!;
  const consumed = await consumeWorkerBrowserDeliveredClaim(workspaceRoot, {
    workerId: command.worker_id!,
    handoffId: command.command_id,
    targetSessionId: sessionId,
    kind: "PROBE",
    expectedTabInstanceId: command.claimed_by_tab_instance_id!,
    notBefore: command.updated_at,
    maxBrowserAgeMs: DEFAULT_LANE_FRESH_MS,
  });
  if (consumed.worker.goal_id && consumed.worker.goal_id !== command.goal_id) {
    throw new Error("RELAY_BOOTSTRAP_GOAL_MISMATCH: Worker bootstrap belongs to another Goal");
  }
  const worker = consumed.worker;
  const now = new Date().toISOString();
  let acknowledged: RelayCommand | null = null;
  await mutateState(workspaceRoot, (current) => {
    const commands = current.commands.map((item) => {
      if (item.command_id !== command.command_id) return item;
      if (!["SENT", "ACKED"].includes(item.state)) {
        throw new Error(`RELAY_BOOTSTRAP_BROWSER_RECEIPT_RACE: command became ${item.state}`);
      }
      const next = item.state === "ACKED" ? item : Object.freeze({ ...item, state: "ACKED" as const, updated_at: now, failure_detail: null });
      acknowledged = next;
      return next;
    });
    if (!acknowledged) throw new Error(`RELAY_BOOTSTRAP_NOT_FOUND: ${command.command_id}`);
    return Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now });
  });
  // A browser delivery receipt proves reachability only. It cannot infer
  // authority from MCP session reuse and therefore never changes Driver.
  return { command: acknowledged!, worker, driver_adopted: false };
}

async function claimRelayAuthorityFromBrowserReceiptScoped(
  workspaceRoot: string,
  targetSessionId: string,
  transitionId: string,
  kind: "HANDOFF" | "RECOVERY"
): Promise<{ command: RelayCommand; worker: WorkerRecord; internal_claim_token: string }> {
  const sessionId = targetSessionId.trim();
  const requestedId = transitionId.trim();
  if (!sessionId || !requestedId) {
    throw new Error("RELAY_AUTHORITY_BROWSER_RECEIPT_INVALID: target session and transition id are required");
  }
  const state = await readRelayManagerState(workspaceRoot);
  const registry = await readWorkerRegistry(workspaceRoot);
  const driver = await readDriverLease(workspaceRoot);
  const nowMs = Date.now();
  if (!driver) throw new Error(`RELAY_${kind}_BROWSER_RECEIPT_NOT_READY: ${requestedId}`);

  const candidates = state.commands.filter((command) => {
    const commandMatches = kind === "HANDOFF"
      ? command.kind === "activate_worker" && command.handoff_id === requestedId
      : command.kind === "recover_worker" && command.command_id === requestedId;
    if (!commandMatches || !command.worker_id || !command.goal_id || !["SENT", "ACKED"].includes(command.state)) return false;
    const claimHandoffId = kind === "HANDOFF" ? command.handoff_id : command.command_id;
    if (!claimHandoffId) return false;
    const worker = registry.workers[command.worker_id];
    if (!worker || worker.provision_id.startsWith("legacy_") || worker.bound_session_id !== sessionId) return false;
    if (
      worker.lane !== command.lane ||
      worker.generation !== command.generation ||
      worker.provision_id !== command.provision_id ||
      worker.claim_kind !== kind ||
      worker.claim_handoff_id !== claimHandoffId
    ) return false;

    const alreadyConsumed = Boolean(worker.claim_consumed_at && worker.claim_session_id === sessionId);
    if (alreadyConsumed) {
      return command.state === "ACKED" && driver.goal_id === command.goal_id &&
        driver.state === "ACTIVE" && driver.owner_session_id === sessionId && worker.state === "ACTIVE";
    }
    if (command.state !== "SENT" || Date.parse(command.expires_at) <= nowMs) return false;
    const driverMatches = kind === "HANDOFF"
      ? driver.goal_id === command.goal_id && driver.state === "HANDOFF_PREPARED" &&
        driver.prepared_handoff_id === requestedId && driver.owner_session_id !== sessionId
      : driver.goal_id === command.goal_id && driver.state === "ACTIVE" &&
        driver.epoch === command.expected_source_driver_epoch &&
        driver.lease_id === command.expected_source_lease_id && driver.owner_session_id !== sessionId;
    if (!driverMatches || !workerReadyForAuthority(worker, nowMs, capabilityFreshMs())) return false;
    const lastSeenMs = worker.last_browser_seen_at ? Date.parse(worker.last_browser_seen_at) : Number.NaN;
    const turnStartedMs = worker.turn_started_at ? Date.parse(worker.turn_started_at) : Number.NaN;
    const sentAtMs = Date.parse(command.updated_at);
    return Boolean(
      command.claimed_by_tab_instance_id &&
      command.claimed_by_tab_instance_id === worker.tab_instance_id &&
      isFormalChatConversationUrl(worker.conversation_url) &&
      worker.generation_active &&
      !worker.connection_interrupted &&
      worker.turn_id &&
      Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= DEFAULT_LANE_FRESH_MS &&
      Number.isFinite(turnStartedMs) && Number.isFinite(sentAtMs) &&
      lastSeenMs >= sentAtMs && turnStartedMs >= sentAtMs - 5_000
    );
  });
  if (candidates.length !== 1) {
    const suffix = candidates.length > 1 ? `AMBIGUOUS:${candidates.length}` : `NOT_READY:${requestedId}`;
    throw new Error(`RELAY_${kind}_BROWSER_RECEIPT_${suffix}`);
  }
  const command = candidates[0]!;
  const claimHandoffId = kind === "HANDOFF" ? command.handoff_id! : command.command_id;
  const consumed = await consumeWorkerBrowserDeliveredClaim(workspaceRoot, {
    workerId: command.worker_id!,
    handoffId: claimHandoffId,
    targetSessionId: sessionId,
    kind,
    expectedTabInstanceId: command.claimed_by_tab_instance_id!,
    notBefore: command.updated_at,
    maxBrowserAgeMs: DEFAULT_LANE_FRESH_MS,
  });
  return { command, worker: consumed.worker, internal_claim_token: consumed.internal_claim_token };
}

async function claimCompanionCommandScoped(workspaceRoot: string, companionInstanceId: string): Promise<RelayCommand | null> {
  if ((await readRelayManagerState(workspaceRoot)).fenced_at) return null;
  const id = companionInstanceId.trim();
  if (!id) throw new Error("COMPANION_INSTANCE_REQUIRED: global sync requires companion_instance_id");
  // Stopping the scheduler does not remove commands queued before the pause.
  // Check durable origin for both PENDING claims and same-claimant CLAIMED replays.
  const pausedRegistry = relayAutomationEnabled() ? null : await readWorkerRegistry(workspaceRoot);
  return claimCommandBy(
    workspaceRoot,
    (item) => {
      if (!["provision_worker", "retire_worker", "close_retired_worker"].includes(item.kind)) return false;
      if (item.kind !== "provision_worker" || !pausedRegistry) return true;
      const worker = item.worker_id ? pausedRegistry.workers[item.worker_id] : undefined;
      // An unknown origin cannot prove an explicit operator request while paused.
      return Boolean(worker?.provision_reason && !AUTOMATIC_PROVISION_REASONS.has(worker.provision_reason));
    },
    `companion:${id}`,
    null
  );
}

async function acknowledgeRelayCommandScoped(
  workspaceRoot: string,
  commandId: string,
  claimant: string,
  status: "sent" | "failed" | "ambiguous",
  detail?: string
): Promise<RelayCommand> {
  let updated: RelayCommand | null = null;
  const now = new Date().toISOString();
  await mutateState(workspaceRoot, (current) => {
    const commands = current.commands.map((command) => {
      if (command.command_id !== commandId) return command;
      if (command.state === "ACKED") { updated = command; return command; }
      const allowed = new Set([claimant, `tab:${claimant}`, `companion:${claimant}`]);
      if (command.claimed_by_instance_id && !allowed.has(command.claimed_by_instance_id)) {
        throw new Error("RELAY_COMMAND_OWNER_MISMATCH: command is claimed by another instance");
      }
      const state: RelayCommandState = status === "sent" ? "SENT" : status === "ambiguous" ? "AMBIGUOUS" : "FAILED";
      const next: RelayCommand = Object.freeze({
        ...command,
        state,
        updated_at: now,
        failure_detail: status === "sent" ? null : (detail?.slice(0, 1000) || (status === "ambiguous" ? "Browser effect outcome is ambiguous" : "Browser Companion reported failure")),
      });
      updated = next;
      return next;
    });
    if (!updated) throw new Error(`RELAY_COMMAND_NOT_FOUND: ${commandId}`);
    return Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now });
  });
  if (updated!.kind === "provision_worker" && updated!.worker_id && status === "ambiguous") {
    await markProvisionAmbiguous(workspaceRoot, updated!.worker_id, detail || "tabs.create outcome ambiguous");
  }
  return updated!;
}

async function recordRelayCapabilityProofScoped(
  workspaceRoot: string,
  probeId: string,
  sourceSessionId: string
): Promise<RelayCommand> {
  const normalizedProbe = probeId.trim();
  const normalizedSession = sourceSessionId.trim();
  if (!normalizedProbe || !normalizedSession) throw new Error("RELAY_CAPABILITY_PROOF_INVALID: probe_id and source session are required");
  const registry = await readWorkerRegistry(workspaceRoot);
  let proven: RelayCommand | null = null;
  const now = new Date().toISOString();
  await mutateState(workspaceRoot, (current) => {
    const commands = current.commands.map((command) => {
      if (command.kind !== "health_probe" || command.probe_id !== normalizedProbe) return command;
      if (!command.worker_id) throw new Error("RELAY_CAPABILITY_PROBE_INVALID: probe command is missing worker identity");
      const worker = registry.workers[command.worker_id];
      if (!worker || worker.bound_session_id !== normalizedSession) {
        throw new Error("RELAY_CAPABILITY_PROOF_SESSION_MISMATCH: probe came from a session that does not own the source Worker");
      }
      if (["FAILED", "EXPIRED", "AMBIGUOUS"].includes(command.state)) {
        throw new Error(`RELAY_CAPABILITY_PROBE_TERMINAL: probe command is ${command.state}`);
      }
      const next = command.state === "ACKED"
        ? command
        : Object.freeze({ ...command, state: "ACKED" as const, updated_at: now, failure_detail: null });
      proven = next;
      return next;
    });
    if (!proven) throw new Error(`RELAY_CAPABILITY_PROBE_NOT_FOUND: ${normalizedProbe}`);
    return Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now });
  });
  return proven!;
}

async function getRelayRecoveryCommandScoped(
  workspaceRoot: string,
  recoveryId: string,
  workerId?: string
): Promise<RelayCommand> {
  const state = await readRelayManagerState(workspaceRoot);
  const command = state.commands.find((item) => item.command_id === recoveryId && item.kind === "recover_worker");
  if (!command) throw new Error(`RELAY_RECOVERY_NOT_FOUND: ${recoveryId}`);
  if (workerId && command.worker_id !== workerId) throw new Error("RELAY_RECOVERY_WORKER_MISMATCH: recovery command targets another Worker");
  if (["FAILED", "EXPIRED", "AMBIGUOUS"].includes(command.state)) {
    throw new Error(`RELAY_RECOVERY_NOT_ACTIVE: recovery command is ${command.state}`);
  }
  if (!command.source_worker_id || command.expected_source_driver_epoch === null || !command.expected_source_lease_id ||
      command.recovery_policy_revision === null || !command.recovery_policy_enabled_at || !command.goal_id) {
    throw new Error("RELAY_RECOVERY_INVALID: recovery command is missing fenced source/policy identity");
  }
  return command;
}

export function recoveryAuthorizationForCommand(command: RelayCommand): Extract<RecoveryAuthorization, { kind: "RELAY_POLICY" }> {
  if (command.kind !== "recover_worker" || !command.goal_id || command.recovery_policy_revision === null || !command.recovery_policy_enabled_at) {
    throw new Error("RELAY_RECOVERY_POLICY_INVALID: recovery command has no policy provenance");
  }
  return Object.freeze({
    kind: "RELAY_POLICY",
    policy_revision: command.recovery_policy_revision,
    goal_id: command.goal_id,
    enabled_at: command.recovery_policy_enabled_at,
  });
}

async function markRelayRecoveryCommittedScoped(
  workspaceRoot: string,
  recoveryId: string,
  targetSessionId: string
): Promise<RelayCommand> {
  const state = await readRelayManagerState(workspaceRoot);
  const command = state.commands.find((item) => item.command_id === recoveryId && item.kind === "recover_worker");
  if (!command || !command.worker_id) throw new Error(`RELAY_RECOVERY_NOT_FOUND: ${recoveryId}`);
  const registry = await readWorkerRegistry(workspaceRoot);
  const target = registry.workers[command.worker_id];
  if (!target || target.bound_session_id !== targetSessionId || target.state !== "ACTIVE") {
    throw new Error("RELAY_RECOVERY_TARGET_NOT_ACTIVE: target Worker/session was not committed before Manager reconciliation");
  }
  if (command.source_worker_id) {
    const source = registry.workers[command.source_worker_id];
    if (source && source.state === "SUSPECT") {
      await transitionWorker(workspaceRoot, source.worker_id, "ORPHAN_CANDIDATE", { detail: `recovery_committed:${recoveryId}` });
    }
    const latest = (await readWorkerRegistry(workspaceRoot)).workers[command.source_worker_id];
    if (latest?.state === "ORPHAN_CANDIDATE") {
      await transitionWorker(workspaceRoot, latest.worker_id, "DEAD", { detail: `recovered_by:${command.worker_id}`, patch: { death_reason: "app_tool_capability_lost" } });
    }
  }
  const now = new Date().toISOString();
  let committed: RelayCommand | null = null;
  await mutateState(workspaceRoot, (current) => {
    const commands = current.commands.map((item) => {
      if (item.command_id !== recoveryId) return item;
      committed = item.state === "ACKED" ? item : Object.freeze({ ...item, state: "ACKED" as const, updated_at: now, failure_detail: null });
      return committed!;
    });
    if (!committed) throw new Error(`RELAY_RECOVERY_NOT_FOUND: ${recoveryId}`);
    return Object.freeze({ ...current, active_lane: command.lane, commands: Object.freeze(commands), updated_at: now });
  });
  return committed!;
}

async function markWorkerProvisionCommandReady(workspaceRoot: string, workerId: string): Promise<void> {
  const now = new Date().toISOString();
  await mutateState(workspaceRoot, (current) => {
    let changed = false;
    const commands = current.commands.map((command) => {
      if (command.kind === "provision_worker" && command.worker_id === workerId && ["PENDING", "CLAIMED", "SENT"].includes(command.state)) {
        changed = true;
        return Object.freeze({ ...command, state: "ACKED" as const, updated_at: now, failure_detail: null });
      }
      return command;
    });
    return changed ? Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now }) : current;
  });
}

async function markCommandCommitted(workspaceRoot: string, command: RelayCommand, targetSessionId: string | null): Promise<void> {
  const now = new Date().toISOString();
  if (command.worker_id && targetSessionId) {
    await markWorkerActiveForSession(workspaceRoot, command.worker_id, targetSessionId);
  }
  if (command.source_worker_id && command.source_worker_id !== command.worker_id) {
    await retireWorker(workspaceRoot, command.source_worker_id, `handoff_committed:${command.handoff_id}`).catch(() => undefined);
  }
  await mutateState(workspaceRoot, (current) => {
    const lane = current.lanes[command.lane];
    const clearReplacement = lane.replacement_worker_id === command.worker_id;
    return Object.freeze({
      ...current,
      active_lane: command.lane,
      lanes: Object.freeze({
        ...current.lanes,
        [command.lane]: clearReplacement ? Object.freeze({ ...lane, replacement_worker_id: null, replacement_source_worker_id: null }) : lane,
      }),
      commands: Object.freeze(current.commands.map((item) => item.command_id === command.command_id
        ? Object.freeze({ ...item, state: "ACKED" as const, updated_at: now, failure_detail: null }) : item)),
      updated_at: now,
    });
  });
}

export function assessWebTurnStall(
  lane: RelayLaneState | RelayLaneObservation | null,
  nowMs = Date.now(),
  turnBudgetMs: number | null = configuredWebTurnBudgetMs()
): WebTurnStallAssessment {
  const observation = relayLaneObservation(lane);
  if (!observation) {
    return Object.freeze({
      turn_id: null,
      structured: false,
      explicit_failure: false,
      inactivity_budget_ms: turnBudgetMs,
      inactivity_ms: null,
      inactivity_exceeded: false,
      stable_observation_windows: 0,
      stable_across_two_windows: false,
      tool_inflight_count: 0,
      candidate: false,
      should_recover: false,
      reasons: Object.freeze(["turn_unobserved"]),
    });
  }
  const structured = Boolean(observation.turn_id && observation.turn_started_at);
  const explicitFailure = observation.connection_interrupted || observation.retry_visible;
  const activityTimes = [
    observation.last_dom_activity_at,
    observation.last_assistant_token_at,
    observation.last_mcp_activity_at,
    observation.turn_started_at,
  ].map((value) => value ? Date.parse(value) : Number.NaN).filter(Number.isFinite);
  const lastActivityMs = activityTimes.length ? Math.max(...activityTimes) : Number.NaN;
  const inactivityMs = Number.isFinite(lastActivityMs) ? Math.max(0, nowMs - lastActivityMs) : null;
  const inactivityExceeded = Boolean(
    structured && turnBudgetMs !== null && inactivityMs !== null && inactivityMs >= turnBudgetMs
  );
  const stableWindows = Math.max(0, observation.stable_observation_windows ?? 0);
  const stableAcrossTwoWindows = structured && stableWindows >= 2;
  const candidate = explicitFailure || inactivityExceeded;
  const reasons: string[] = [];
  if (observation.connection_interrupted) reasons.push("explicit_delivery_error");
  if (observation.retry_visible) reasons.push("retry_control_visible");
  if (inactivityExceeded) reasons.push("turn_inactivity_budget_exceeded");
  if (candidate && structured && !stableAcrossTwoWindows) reasons.push("awaiting_second_stable_window");
  if (candidate && observation.tool_inflight_count > 0) reasons.push("browser_tool_inflight");
  if (candidate && !structured) reasons.push("legacy_telemetry_no_turn_identity");
  return Object.freeze({
    turn_id: observation.turn_id,
    structured,
    explicit_failure: explicitFailure,
    inactivity_budget_ms: turnBudgetMs,
    inactivity_ms: inactivityMs,
    inactivity_exceeded: inactivityExceeded,
    stable_observation_windows: stableWindows,
    stable_across_two_windows: stableAcrossTwoWindows,
    tool_inflight_count: observation.tool_inflight_count,
    candidate,
    // Rolling-upgrade compatibility retains the old explicit-error path when
    // an older Companion cannot provide a turn id. New telemetry must satisfy
    // two independent stable observations and show no browser tool in flight.
    should_recover: candidate && (
      !structured || (stableAcrossTwoWindows && observation.tool_inflight_count === 0)
    ),
    reasons: Object.freeze(reasons),
  });
}

export function assessRelayTurnRisk(
  lease: DriverLease,
  lane: RelayLaneState | RelayLaneObservation | null,
  nowMs = Date.now()
): TurnRiskAssessment {
  const observation = relayLaneObservation(lane);
  const reasons: string[] = [];
  let score = 0;
  const acquired = Date.parse(lease.acquired_at);
  const driverAgeMs = Number.isFinite(acquired) ? Math.max(0, nowMs - acquired) : 0;
  const minute = 60_000;
  if (driverAgeMs >= 10 * minute) { score += 10; reasons.push("driver_age>=10m"); }
  if (driverAgeMs >= 18 * minute) { score += 20; reasons.push("driver_age>=18m"); }
  if (driverAgeMs >= 25 * minute) { score += 20; reasons.push("driver_age>=25m"); }
  if (driverAgeMs >= 35 * minute) { score += 15; reasons.push("driver_age>=35m"); }
  let laneAgeMs: number | null = null;
  const webTurn = assessWebTurnStall(observation, nowMs);
  if (observation) {
    const seen = Date.parse(observation.last_seen_at);
    laneAgeMs = Number.isFinite(seen) ? Math.max(0, nowMs - seen) : null;
    if (webTurn.should_recover) {
      score = 100;
      reasons.push("web_turn_composite_stall");
    } else if (webTurn.candidate) {
      score += 60;
      reasons.push("web_turn_stall_pending_confirmation");
    }
    // Browser-reported tool counters are deliberately not used for authority/risk;
    // authoritative MCP counters belong to the runtime telemetry plane.
    if (laneAgeMs !== null && laneAgeMs > laneFreshMs()) {
      score += observation.generation_active ? 10 : 30;
      reasons.push(observation.generation_active ? "lane_heartbeat_stale_while_generating" : "lane_heartbeat_stale");
    }
  } else {
    score += 25;
    reasons.push("active_lane_unobserved");
  }
  score = Math.min(100, score);
  const threshold = riskThreshold();
  const structuredStallAwaitingConfirmation = webTurn.structured && webTurn.candidate && !webTurn.should_recover;
  return Object.freeze({
    score,
    threshold,
    should_handoff: score >= threshold && !structuredStallAwaitingConfirmation,
    reasons: Object.freeze(reasons),
    driver_age_ms: driverAgeMs,
    lane_age_ms: laneAgeMs,
    web_turn: webTurn,
  });
}

function otherLane(lane: RelayLaneId): RelayLaneId {
  return lane === "A" ? "B" : "A";
}

function projectionActiveLane(
  manager: RelayManagerState,
  registry: WorkerRegistryState,
  lease: DriverLease
): RelayLaneId | null {
  if (manager.active_lane) return manager.active_lane;
  const matching = (["A", "B"] as const).filter((lane) => {
    const workerId = registry.lanes[lane].active_worker_id;
    const worker = workerId ? registry.workers[workerId] : null;
    return worker?.state === "ACTIVE" && worker.bound_session_id === lease.owner_session_id;
  });
  return matching.length === 1 ? matching[0] : null;
}

function activeWorkerReady(
  worker: WorkerRecord | null,
  lease: DriverLease,
  nowMs: number
): boolean {
  return Boolean(
    worker &&
    worker.state === "ACTIVE" &&
    worker.conversation_surface === "CHAT" &&
    worker.bound_session_id === lease.owner_session_id &&
    isFormalChatConversationUrl(worker.conversation_url) &&
    workerIsFresh(worker, nowMs) &&
    !worker.connection_interrupted &&
    worker.adapter_confidence !== "low"
  );
}

function recoveryCommandPending(manager: RelayManagerState, goalId: string): boolean {
  return manager.commands.some((command) =>
    command.goal_id === goalId &&
    ["health_probe", "recover_worker", "activate_worker"].includes(command.kind) &&
    ["PENDING", "CLAIMED", "SENT"].includes(command.state)
  );
}

/**
 * Compute control-plane health without mutating the Driver, Goal, Worker
 * registry, or command journal. A READY_BLANK browser tab is intentionally
 * reported as PREWARMING and can never satisfy READY_STANDBY.
 */
export function assessRelayControlPlane(
  manager: RelayManagerState,
  registry: WorkerRegistryState,
  lease: DriverLease | null,
  nowMs = Date.now()
): RelayControlPlaneProjection {
  if (!lease || lease.state === "RELEASED") {
    return Object.freeze({
      state: "IDLE",
      goal_id: lease?.goal_id ?? null,
      driver_epoch: lease?.epoch ?? null,
      active_lane: null,
      active_worker_id: null,
      active_ready: false,
      standby_lane: null,
      standby_worker_id: null,
      standby_state: "ABSENT",
      detail: "No active Driver lease exists.",
    });
  }

  const activeLane = projectionActiveLane(manager, registry, lease);
  const activeWorkerId = activeLane ? registry.lanes[activeLane].active_worker_id : null;
  const activeWorker = activeWorkerId ? registry.workers[activeWorkerId] ?? null : null;
  const legacyActiveReady = Boolean(
    activeLane && !activeWorker && relayLaneIsFresh(manager.lanes[activeLane], nowMs) &&
    manager.lanes[activeLane].observation?.conversation_surface === "CHAT" &&
    !manager.lanes[activeLane].observation?.connection_interrupted
  );
  const activeReady = activeWorkerReady(activeWorker, lease, nowMs) || legacyActiveReady;
  const standbyLane = activeLane ? otherLane(activeLane) : null;
  const standbyWorkerId = standbyLane
    ? registry.lanes[standbyLane].standby_worker_id ?? registry.lanes[standbyLane].active_worker_id
    : null;
  const standbyWorker = standbyWorkerId ? registry.workers[standbyWorkerId] ?? null : null;
  const standbyReady = workerCanReceive(standbyWorker, nowMs);
  const standbyState: RelayStandbyState = standbyReady
    ? "READY_STANDBY"
    : standbyWorker ? "PREWARMING" : "ABSENT";
  let state: RelayControlPlaneState;
  let detail: string;
  if (lease.state !== "ACTIVE" || recoveryCommandPending(manager, lease.goal_id)) {
    state = "RECOVERING";
    detail = `Driver epoch ${lease.epoch} is reconciling ${lease.state.toLowerCase()} authority.`;
  } else if (!activeReady && standbyReady) {
    state = "RECOVERING";
    detail = `Driver lane is unavailable or expired; capability-proved standby ${standbyWorkerId} is ready for fenced recovery.`;
  } else if (!activeReady) {
    state = "WAITING_CONTROL_PLANE";
    detail = "No usable Driver lane or capability-proved standby is available; durable Goal and receipts must wait for control-plane recovery.";
  } else if (!standbyReady) {
    state = "DEGRADED_REDUNDANCY";
    detail = "Driver remains usable, but no capability-proved standby is currently available.";
  } else {
    state = "ACTIVE";
    detail = `Driver lane ${activeLane} and capability-proved standby ${standbyWorkerId} are ready.`;
  }

  return Object.freeze({
    state,
    goal_id: lease.goal_id,
    driver_epoch: lease.epoch,
    active_lane: activeLane,
    active_worker_id: activeWorkerId,
    active_ready: activeReady,
    standby_lane: standbyLane,
    standby_worker_id: standbyWorkerId,
    standby_state: standbyState,
    detail,
  });
}

async function readRelayControlPlaneProjectionScoped(
  workspaceRoot: string,
  nowMs = Date.now()
): Promise<RelayControlPlaneProjection> {
  const [manager, registry, lease] = await Promise.all([
    readRelayManagerState(workspaceRoot),
    readWorkerRegistry(workspaceRoot),
    readDriverLease(workspaceRoot),
  ]);
  return assessRelayControlPlane(manager, registry, lease, nowMs);
}

async function transitionControlPlaneGoal(
  workspaceRoot: string,
  lease: DriverLease,
  action: "wait_control_plane" | "control_plane_ready",
  detail: string
): Promise<void> {
  const scope = createRuntimeScope(
    { workspaceRoot, projectRoots: [workspaceRoot] },
    { sessionId: lease.owner_session_id }
  );
  await runWithRuntimeScope(scope, () => transitionGoalRunLifecycle(workspaceRoot, action, {
    currentPhase: action === "wait_control_plane"
      ? `Waiting for browser/MCP control plane: ${detail}`
      : "Browser/MCP control plane restored; continuing Goal",
  }));
}

async function expireCommands(workspaceRoot: string): Promise<RelayManagerState> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  return mutateState(workspaceRoot, (current) => {
    let changed = false;
    const commands = current.commands.map((command) => {
      if (["PENDING", "CLAIMED", "SENT"].includes(command.state) && Date.parse(command.expires_at) <= nowMs) {
        changed = true;
        return Object.freeze({ ...command, state: "EXPIRED" as const, updated_at: now });
      }
      return command;
    });
    return changed ? Object.freeze({ ...current, commands: Object.freeze(commands), updated_at: now }) : current;
  });
}

async function ensureWorkerPool(workspaceRoot: string): Promise<{ registry: WorkerRegistryState; provisioned: { worker: WorkerRecord; command: RelayCommand }[] }> {
  const manager = await readRelayManagerState(workspaceRoot);
  let registry = await migrateLegacyWorkersFromManager(workspaceRoot, manager);
  const provisioned: { worker: WorkerRecord; command: RelayCommand }[] = [];
  const authoritative = Object.values(registry.workers).filter((worker) =>
    worker.conversation_surface === "CHAT" && ["ACTIVE", "DRAINING", "SUSPECT", "ORPHAN_CANDIDATE"].includes(worker.state)
  );
  // Automatic repair is allowed only around one already-authoritative Driver.
  // With zero or multiple candidates, opening tabs cannot resolve identity and
  // merely amplifies a control-plane bug. Explicit HANDOFF/RECOVERY must first
  // establish the single Driver.
  if (authoritative.length !== 1) return { registry, provisioned };
  const standbyLane: RelayLaneId = authoritative[0]!.lane === "A" ? "B" : "A";
  const current = workerForLane(registry, standbyLane);
  if (current && !["RETIRED", "DEAD", "FAILED"].includes(current.state)) return { registry, provisioned };
  const requested = await requestWorkerProvision(workspaceRoot, { lane: standbyLane, reason: "automatic_pool_repair" });
  registry = requested.registry;
  // requestWorkerProvision may recover a detached but live Worker. Once its
  // lane slot is restored, normal prewarm logic performs the next step.
  if (!requested.created) return { registry, provisioned };
  const command = await enqueueWorkerProvisionCommand(workspaceRoot, requested.worker, registry.revision);
  provisioned.push({ worker: requested.worker, command });
  return { registry, provisioned };
}

async function requestRelayLaneReplacementScoped(workspaceRoot: string, lane: RelayLaneId, reason = "operator_replace"): Promise<{ worker: WorkerRecord; command: RelayCommand; manager: RelayManagerState }> {
  if (!relayCompanionEnabled()) throw new Error("COMPANION_DISABLED: Browser Companion is not enabled");
  // An old Companion can still ask for identity recovery after the server is paused.
  // Refuse before migration/provision/queue writes; explicit operator replacement remains valid.
  if (AUTOMATIC_PROVISION_REASONS.has(reason) && !relayAutomationEnabled()) {
    throw new Error("RELAY_AUTOMATION_PAUSED: Automatic Worker provisioning is paused");
  }
  const beforeRegistry = await migrateLegacyWorkersFromManager(workspaceRoot);
  const source = workerForLane(beforeRegistry, lane);
  const requested = await requestWorkerProvision(workspaceRoot, { lane, reason, forceNew: true });
  const command = await enqueueWorkerProvisionCommand(workspaceRoot, requested.worker, requested.registry.revision);
  await mutateState(workspaceRoot, (current) => {
    const currentLane = current.lanes[lane];
    return Object.freeze({
      ...current,
      lanes: Object.freeze({ ...current.lanes, [lane]: Object.freeze({ ...currentLane, replacement_worker_id: requested.worker.worker_id, replacement_source_worker_id: source?.worker_id ?? null }) }),
      updated_at: new Date().toISOString(),
    });
  });
  return { worker: requested.worker, command, manager: await readRelayManagerState(workspaceRoot) };
}

async function prepareWorkerHandoff(
  workspaceRoot: string,
  lease: DriverLease,
  targetLane: RelayLaneId,
  targetWorker: WorkerRecord,
  sourceWorker: WorkerRecord | null,
  risk?: TurnRiskAssessment
): Promise<RelayAutomationResult> {
  const unresolvedOperations = await listAuthorityBlockingOperationInspections(workspaceRoot, lease.acquired_at, requireRelayGoal(workspaceRoot));
  if (unresolvedOperations.length > 0) {
    return {
      enabled: true,
      action: "blocked",
      detail: `Handoff checkpoint is fenced by ${unresolvedOperations.length} unresolved operation receipt(s); observe or reconcile effects before authority can move.`,
      risk,
      target_lane: targetLane,
      target_worker_id: targetWorker.worker_id,
    };
  }
  let prepared: Awaited<ReturnType<typeof prepareRelayHandoff>> | null = null;
  try {
    // A v1 Lane migrated from the fixed-conversation model deliberately keeps
    // the legacy authority path until a real provision transaction establishes
    // Worker identity. Migration may observe a URL/tab, but must never invent a
    // Worker->MCP session binding or require a claim token that never existed.
    const legacyTarget = targetWorker.provision_id.startsWith("legacy_");
    prepared = await prepareRelayHandoff(
      workspaceRoot,
      lease.owner_session_id,
      undefined,
      legacyTarget ? {} : {
        source_worker_id: sourceWorker?.worker_id ?? null,
        source_generation: sourceWorker?.generation ?? null,
        target_worker_id: targetWorker.worker_id,
        target_generation: targetWorker.generation,
      }
    );
    const registry = await readWorkerRegistry(workspaceRoot);
    const command = legacyTarget
      ? await enqueueRelayResumeCommand(workspaceRoot, {
          lane: targetLane,
          handoff_id: prepared.handoff.handoff_id,
          goal_id: prepared.goal.id,
          goal_revision: prepared.handoff.goal_revision,
        })
      : await enqueueWorkerActivationCommand(workspaceRoot, {
          lane: targetLane,
          worker: targetWorker,
          registryRevision: registry.revision,
          sourceWorkerId: sourceWorker?.worker_id ?? null,
          handoffId: prepared.handoff.handoff_id,
          goalId: prepared.goal.id,
          goalRevision: prepared.handoff.goal_revision,
        });
    return {
      enabled: true,
      action: "prepared",
      detail: `Prepared ${prepared.handoff.handoff_id}; Worker ${targetWorker.worker_id} may claim one idempotent activation command.`,
      risk,
      handoff_id: prepared.handoff.handoff_id,
      command_id: command.command_id,
      target_lane: targetLane,
      target_worker_id: targetWorker.worker_id,
    };
  } catch (error) {
    if (prepared) await abortRelayHandoff(workspaceRoot, prepared.handoff.handoff_id, lease.owner_session_id).catch(() => undefined);
    throw error;
  }
}

async function evaluateRequestedReplacement(workspaceRoot: string, manager: RelayManagerState, lease: DriverLease): Promise<RelayAutomationResult | null> {
  const registry = await readWorkerRegistry(workspaceRoot);
  for (const lane of ["A", "B"] as const) {
    const requestId = manager.lanes[lane].replacement_worker_id;
    if (!requestId) continue;
    const replacement = registry.workers[requestId];
    if (!replacement || ["RETIRED", "DEAD", "FAILED"].includes(replacement.state)) {
      await clearReplacementReference(workspaceRoot, lane, requestId);
      const requested = await requestRelayLaneReplacement(workspaceRoot, lane, "missing_or_terminal_replacement_recovery");
      return {
        enabled: true,
        action: "provisioned",
        detail: `Replacement ${requestId} is missing or terminal; cleared the stale slot and provisioned ${requested.worker.worker_id}. Driver authority remains unchanged.`,
        command_id: requested.command.command_id,
        target_lane: lane,
        target_worker_id: requested.worker.worker_id,
      };
    }
    if (!workerCanReceive(replacement)) {
      if (replacementProgressTimedOut(replacement)) {
        await terminalizeTimedOutReplacement(workspaceRoot, replacement);
        await clearReplacementReference(workspaceRoot, lane, replacement.worker_id);
        const requested = await requestRelayLaneReplacement(workspaceRoot, lane, "stale_replacement_recovery");
        return {
          enabled: true,
          action: "provisioned",
          detail: `Replacement ${replacement.worker_id} made no browser/provision progress before timeout; marked it terminal, cleared the stale slot, and provisioned ${requested.worker.worker_id}. Driver authority remains unchanged.`,
          command_id: requested.command.command_id,
          target_lane: lane,
          target_worker_id: requested.worker.worker_id,
        };
      }
      if (workerCanBootstrap(replacement)) {
        const bootstrap = await enqueueWorkerBootstrapCommand(workspaceRoot, {
          worker: replacement,
          registryRevision: registry.revision,
          goalId: lease.goal_id,
        });
        return {
          enabled: true,
          action: "blocked",
          detail: `Replacement ${replacement.worker_id} has browser proof but not MCP capability proof; bootstrap ${bootstrap.command_id} is queued/awaiting formal conversation establishment. Driver authority remains unchanged.`,
          command_id: bootstrap.command_id,
          target_lane: lane,
          target_worker_id: replacement.worker_id,
        };
      }
      return { enabled: true, action: "provisioned", detail: `Replacement ${replacement.worker_id} is provisioning; authority remains unchanged.`, target_lane: lane, target_worker_id: replacement.worker_id };
    }
    const sourceId = manager.lanes[lane].replacement_source_worker_id;
    const source = sourceId ? registry.workers[sourceId] ?? null : null;
    if (manager.active_lane !== lane) {
      if (source && source.worker_id !== replacement.worker_id && !["RETIRED", "DEAD", "FAILED"].includes(source.state)) {
        await retireWorker(workspaceRoot, source.worker_id, `standby_replaced_by:${replacement.worker_id}`);
      }
      await mutateState(workspaceRoot, (current) => {
        const currentLane = current.lanes[lane];
        return Object.freeze({ ...current, lanes: Object.freeze({ ...current.lanes, [lane]: Object.freeze({ ...currentLane, replacement_worker_id: null, replacement_source_worker_id: null }) }), updated_at: new Date().toISOString() });
      });
      return { enabled: true, action: "reconciled", detail: `Standby lane ${lane} replacement ${replacement.worker_id} is ready; prior standby retired without moving Driver authority.`, target_lane: lane, target_worker_id: replacement.worker_id };
    }
    if (lease.state !== "ACTIVE") return { enabled: true, action: "blocked", detail: `Driver state ${lease.state}; active-lane replacement waits without stealing authority.`, target_lane: lane, target_worker_id: replacement.worker_id };
    return prepareWorkerHandoff(workspaceRoot, lease, lane, replacement, source);
  }
  return null;
}

async function evaluateStandbyPrewarm(
  workspaceRoot: string,
  manager: RelayManagerState,
  lease: DriverLease
): Promise<RelayAutomationResult | null> {
  if (!manager.active_lane) return null;
  const standbyLane = otherLane(manager.active_lane);
  const registry = await readWorkerRegistry(workspaceRoot);
  const worker = workerForLane(registry, standbyLane);
  if (!worker) {
    const requested = await requestRelayLaneReplacement(workspaceRoot, standbyLane, "proactive_standby_prewarm");
    return {
      enabled: true,
      action: "provisioned",
      detail: `Active lane ${manager.active_lane} has no provisioned standby; provisioned ${requested.worker.worker_id} before a failure occurs. Driver authority remains unchanged.`,
      command_id: requested.command.command_id,
      target_lane: standbyLane,
      target_worker_id: requested.worker.worker_id,
    };
  }
  if (worker.provision_id.startsWith("legacy_")) return null;
  // Do not keep talking to an already-bound standby merely to refresh a
  // short-lived proof. A transfer path will request exactly one fresh proof
  // immediately before it attempts to move Driver authority.
  if (workerCanReceive(worker) || workerHasEstablishedStandby(worker)) return null;
  if (replacementProgressTimedOut(worker)) {
    await terminalizeTimedOutReplacement(workspaceRoot, worker);
    const requested = await requestRelayLaneReplacement(workspaceRoot, standbyLane, "stale_standby_recovery");
    return {
      enabled: true,
      action: "provisioned",
      detail: `Standby ${worker.worker_id} stopped making browser/provision progress; marked it terminal and provisioned ${requested.worker.worker_id}. Driver authority remains unchanged.`,
      command_id: requested.command.command_id,
      target_lane: standbyLane,
      target_worker_id: requested.worker.worker_id,
    };
  }
  if (!workerCanBootstrap(worker)) return null;
  const bootstrap = await enqueueWorkerBootstrapCommand(workspaceRoot, {
    worker,
    registryRevision: registry.revision,
    goalId: lease.goal_id,
  });
  return {
    enabled: true,
    action: "blocked",
    detail: `Standby ${worker.worker_id} is browser-ready but not capability-ready; prewarming a formal Chat/MCP session before any rotation is needed. Driver remains ${lease.owner_session_id}.`,
    command_id: bootstrap.command_id,
    target_lane: standbyLane,
    target_worker_id: worker.worker_id,
  };
}

async function evaluateAutomaticRecovery(
  workspaceRoot: string,
  manager: RelayManagerState,
  lease: DriverLease
): Promise<RelayAutomationResult | null> {
  if (!relayAutoRecoveryEnabled() || lease.state !== "ACTIVE" || !manager.active_lane) return null;
  const registry = await readWorkerRegistry(workspaceRoot);
  const sourceId = registry.lanes[manager.active_lane].active_worker_id;
  const source = sourceId ? registry.workers[sourceId] ?? null : null;
  // v1 migration intentionally never guesses Worker->session authority. Full
  // automatic recovery starts only after a provisioned generation has a real
  // MCP session relation established by claim/bind.
  if (!source || source.provision_id.startsWith("legacy_") || source.bound_session_id !== lease.owner_session_id) return null;

  const runEnvelope = await readGoalRun(workspaceRoot, lease.owner_session_id);
  if (!runEnvelope || runEnvelope.run.runId !== lease.goal_id || !["RUNNING", "WAITING_CONTROL_PLANE"].includes(runEnvelope.run.state)) {
    return { enabled: true, action: "idle", detail: "GoalRun is neither RUNNING nor waiting for control-plane recovery; automatic recovery will not create or activate another Worker." };
  }

  const nowMs = Date.now();
  const leaseExpired = Number.isFinite(Date.parse(lease.expires_at)) && Date.parse(lease.expires_at) <= nowMs;
  const sourceMcpTimes = [source.last_capability_at, source.last_mcp_seen_at]
    .map((value) => value ? Date.parse(value) : Number.NaN)
    .filter(Number.isFinite);
  const capabilityAt = sourceMcpTimes.length > 0 ? Math.max(...sourceMcpTimes) : Number.NaN;
  const capabilityFresh = Number.isFinite(capabilityAt) && nowMs - capabilityAt <= capabilityFreshMs();
  const sourceBrowserHealthy = source.conversation_surface === "CHAT" && workerIsFresh(source, nowMs) && !source.connection_interrupted;

  if (capabilityFresh && source.state === "SUSPECT") {
    await transitionWorker(workspaceRoot, source.worker_id, "ACTIVE", { detail: "owner_mcp_activity_restored" });
    return {
      enabled: true,
      action: "reconciled",
      detail: `Fresh MCP activity proved ${source.worker_id} is still the Driver; restored ACTIVE without moving authority.`,
      target_lane: source.lane,
      target_worker_id: source.worker_id,
    };
  }

  // A stale browser or expired Driver without recent MCP capability proof is a
  // recovery condition, never a normal handoff shortcut. Before lease expiry
  // we deliberately wait; authority cannot move merely because browser health
  // looks bad.
  if (!leaseExpired && (!sourceBrowserHealthy || !capabilityFresh)) {
    if (!sourceBrowserHealthy) {
      return { enabled: true, action: "blocked", detail: `Worker ${source.worker_id} is browser-suspect but Driver lease has not expired; waiting without transferring authority.`, target_lane: source.lane, target_worker_id: source.worker_id };
    }
    return null;
  }
  if (!leaseExpired || capabilityFresh) return null;

  const policy = relayRecoveryPolicy(lease);
  const unresolvedOperations = await listAuthorityBlockingOperationInspections(workspaceRoot, lease.acquired_at, requireRelayGoal(workspaceRoot));
  if (unresolvedOperations.length > 0) {
    return {
      enabled: true,
      action: "blocked",
      detail: `Automatic recovery is fenced by ${unresolvedOperations.length} unresolved operation receipt(s); no Driver authority changed.`,
      target_lane: source.lane,
      target_worker_id: source.worker_id,
    };
  }
  const assessment = assessDriverOrphanRecovery(lease, {
    sourceSessionId: lease.owner_session_id,
    targetSessionId: `pending-recovery:${source.worker_id}`,
    explicitTakeoverAuthorized: false,
    authorization: policy,
    observation: {
      lane_observed: Boolean(source.last_browser_seen_at),
      lane_fresh: workerIsFresh(source, nowMs),
      generation_active: source.generation_active,
      // Browser DOM is not authoritative for tool activity. Side-effect safety
      // is fenced by process-local mutation count and re-checked in goal(bind).
      tool_inflight_count: 0,
    },
    activeMutationCount: activeDriverMutationCount(workspaceRoot, lease.lease_id),
  });
  if (!assessment.eligible) {
    return {
      enabled: true,
      action: "blocked",
      detail: `Automatic recovery safety gate is not satisfied (${assessment.reasons.join(", ") || "unknown"}); no Driver authority changed.`,
      target_lane: source.lane,
      target_worker_id: source.worker_id,
    };
  }

  const probe = manager.commands
    .filter((command) => command.kind === "health_probe" && command.worker_id === source.worker_id &&
      command.expected_source_driver_epoch === lease.epoch && command.expected_source_lease_id === lease.lease_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  if (!probe) {
    if (source.state === "ACTIVE") await transitionWorker(workspaceRoot, source.worker_id, "SUSPECT", { detail: "driver_expired_capability_probe" });
    const command = await enqueueHealthProbeCommand(workspaceRoot, { worker: source, lease });
    return {
      enabled: true,
      action: "blocked",
      detail: `Driver expiry+grace passed for ${source.worker_id}; issued read-only MCP capability probe ${command.probe_id}. No authority changed.`,
      command_id: command.command_id,
      target_lane: source.lane,
      target_worker_id: source.worker_id,
    };
  }
  if (probe.state === "ACKED") {
    const latestSource = (await readWorkerRegistry(workspaceRoot)).workers[source.worker_id];
    if (latestSource?.state === "SUSPECT") await transitionWorker(workspaceRoot, source.worker_id, "ACTIVE", { detail: `capability_probe_ok:${probe.probe_id}` });
    return { enabled: true, action: "blocked", detail: `Capability probe ${probe.probe_id} proved ${source.worker_id} can still call MCP; automatic ORPHAN recovery cancelled.`, command_id: probe.command_id, target_lane: source.lane, target_worker_id: source.worker_id };
  }
  const probeAgeMs = nowMs - Date.parse(probe.created_at);
  if (!Number.isFinite(probeAgeMs) || probeAgeMs < capabilityProbeTimeoutMs()) {
    return { enabled: true, action: "blocked", detail: `Waiting for read-only capability proof from ${source.worker_id}; no authority changed.`, command_id: probe.command_id, target_lane: source.lane, target_worker_id: source.worker_id };
  }

  const targetLane = otherLane(source.lane);
  let latestRegistry = await readWorkerRegistry(workspaceRoot);
  let target = workerForLane(latestRegistry, targetLane);
  if (target && !target.provision_id.startsWith("legacy_") && !workerCanReceive(target, nowMs)) {
    if (workerCanBootstrap(target, nowMs)) {
      const bootstrap = await enqueueWorkerBootstrapCommand(workspaceRoot, {
        worker: target,
        registryRevision: latestRegistry.revision,
        goalId: lease.goal_id,
      });
      return {
        enabled: true,
        action: "blocked",
        detail: `Source ${source.worker_id} failed capability proof, but recovery successor ${target.worker_id} is only browser-ready. Capability bootstrap ${bootstrap.command_id} must prove a formal Chat/MCP session before recovery can move epoch.`,
        command_id: bootstrap.command_id,
        target_lane: targetLane,
        target_worker_id: target.worker_id,
      };
    }
    return { enabled: true, action: "blocked", detail: `Recovery successor ${target.worker_id} is not yet safe to bootstrap or receive authority; no Driver authority changed.`, target_lane: targetLane, target_worker_id: target.worker_id };
  }
  if (!target || target.provision_id.startsWith("legacy_")) {
    const requested = await requestWorkerProvision(workspaceRoot, { lane: targetLane, goalId: lease.goal_id, reason: "automatic_orphan_recovery", forceNew: Boolean(target?.provision_id.startsWith("legacy_")) });
    const provision = await enqueueWorkerProvisionCommand(workspaceRoot, requested.worker, requested.registry.revision);
    return { enabled: true, action: "provisioned", detail: `Source ${source.worker_id} failed capability proof; provisioning recovery successor ${requested.worker.worker_id}. Driver authority remains unchanged.`, command_id: provision.command_id, target_lane: targetLane, target_worker_id: requested.worker.worker_id };
  }
  if (source.state === "SUSPECT") {
    await transitionWorker(workspaceRoot, source.worker_id, "ORPHAN_CANDIDATE", { detail: `capability_probe_timeout:${probe.probe_id}` });
  }
  latestRegistry = await readWorkerRegistry(workspaceRoot);
  target = latestRegistry.workers[target.worker_id] ?? target;
  const recovery = await enqueueWorkerRecoveryCommand(workspaceRoot, {
    sourceWorker: latestRegistry.workers[source.worker_id] ?? source,
    targetWorker: target,
    lease,
    policy,
    registryRevision: latestRegistry.revision,
  });
  return {
    enabled: true,
    action: "prepared",
    detail: `Recovery successor ${target.worker_id} is READY after failed capability proof. Recovery command is fenced to source epoch ${lease.epoch}/lease ${lease.lease_id}; Driver authority has not moved yet.`,
    command_id: recovery.command_id,
    target_lane: targetLane,
    target_worker_id: target.worker_id,
  };
}

async function evaluateRelayAutomationScoped(workspaceRoot: string): Promise<RelayAutomationResult> {
  if (!relayAutomationEnabled()) return { enabled: false, action: "disabled", detail: "Relay automation feature flag is off." };
  if ((await readRelayManagerState(workspaceRoot)).fenced_at) return { enabled: true, action: "idle", detail: "Goal was superseded; its Relay authority is fenced." };
  const busyKey = relayScopeKey(workspaceRoot);
  if (automationBusyWorkspaces.has(busyKey)) return { enabled: true, action: "idle", detail: "Previous relay automation evaluation is still running." };
  automationBusyWorkspaces.add(busyKey);
  try {
    let state = await expireCommands(workspaceRoot);
    const lease = await readDriverLease(workspaceRoot);
    if (!lease) return { enabled: true, action: "idle", detail: "No Driver lease exists; automatic Worker provisioning waits for an active Goal/Driver." };
    let sourceRun = await readGoalRun(workspaceRoot, lease.owner_session_id);
    if (sourceRun?.run.runId === lease.goal_id && sourceRun.run.state === "COMPLETED" && lease.state !== "RELEASED") {
      await releaseDriverLease(workspaceRoot, lease.goal_id);
      return { enabled: true, action: "reconciled", detail: `Released stale Driver lease for completed Goal ${lease.goal_id}.` };
    }
    if (!sourceRun || sourceRun.run.runId !== lease.goal_id || !["RUNNING", "WAITING_CONTROL_PLANE"].includes(sourceRun.run.state)) {
      return { enabled: true, action: "idle", detail: "GoalRun is not executable or waiting for control-plane recovery; no new Worker will be provisioned." };
    }
    const pool = await ensureWorkerPool(workspaceRoot);
    if (pool.provisioned.length) {
      const first = pool.provisioned[0];
      return { enabled: true, action: "provisioned", detail: `Worker pool repair queued ${pool.provisioned.map((item) => item.worker.worker_id).join(", ")}; no Driver authority changed.`, command_id: first.command.command_id, target_lane: first.worker.lane, target_worker_id: first.worker.worker_id };
    }
    state = await readRelayManagerState(workspaceRoot);
    const controlRegistry = await readWorkerRegistry(workspaceRoot);
    const controlPlane = assessRelayControlPlane(state, controlRegistry, lease);
    const establishedControlPlane = Object.values(controlRegistry.workers).some((worker) =>
      (worker.goal_id === lease.goal_id || worker.bound_session_id === lease.owner_session_id) &&
      ["ACTIVE", "DRAINING", "RETIRED", "SUSPECT", "ORPHAN_CANDIDATE", "DEAD"].includes(worker.state)
    );
    if (
      controlPlane.state === "WAITING_CONTROL_PLANE" &&
      sourceRun.run.state === "RUNNING" &&
      establishedControlPlane
    ) {
      await transitionControlPlaneGoal(workspaceRoot, lease, "wait_control_plane", controlPlane.detail);
      sourceRun = await readGoalRun(workspaceRoot, lease.owner_session_id);
    } else if (
      controlPlane.state !== "WAITING_CONTROL_PLANE" &&
      sourceRun.run.state === "WAITING_CONTROL_PLANE"
    ) {
      await transitionControlPlaneGoal(workspaceRoot, lease, "control_plane_ready", controlPlane.detail);
      sourceRun = await readGoalRun(workspaceRoot, lease.owner_session_id);
    }
    if (!sourceRun || !["RUNNING", "WAITING_CONTROL_PLANE"].includes(sourceRun.run.state)) {
      return { enabled: true, action: "idle", detail: "GoalRun control-plane reconciliation produced a non-executable state." };
    }
    for (const command of state.commands) {
      if (command.state === "ACKED" || !command.handoff_id) continue;
      const snapshot = await readHandoffSnapshot(workspaceRoot, command.handoff_id);
      if (snapshot?.state === "COMMITTED") {
        await markCommandCommitted(workspaceRoot, command, snapshot.target_session_id ?? null);
        return { enabled: true, action: "reconciled", detail: "Committed handoff reconciled to its target Worker/Lane.", handoff_id: command.handoff_id, command_id: command.command_id, target_lane: command.lane, target_worker_id: command.worker_id ?? undefined };
      }
      if (snapshot?.state === "ABORTED") continue;
      if (["EXPIRED", "FAILED"].includes(command.state) && lease.prepared_handoff_id === command.handoff_id && lease.state === "HANDOFF_PREPARED") {
        await abortRelayHandoff(workspaceRoot, command.handoff_id, lease.owner_session_id);
        return { enabled: true, action: "reconciled", detail: "Expired/failed Worker activation was aborted; source Driver restored.", handoff_id: command.handoff_id, command_id: command.command_id };
      }
      if (command.state === "AMBIGUOUS") {
        return { enabled: true, action: "blocked", detail: `Command ${command.command_id} has an ambiguous browser effect; reconcile proof before any retry.`, handoff_id: command.handoff_id, command_id: command.command_id, target_worker_id: command.worker_id ?? undefined };
      }
    }

    state = await readRelayManagerState(workspaceRoot);
    const replacement = await evaluateRequestedReplacement(workspaceRoot, state, lease);
    if (replacement) return replacement;
    // An expired Driver whose source has stopped proving MCP capability is an
    // active recovery incident. Give that path first refusal: it owns its own
    // target bootstrap step, whereas generic standby prewarm can otherwise
    // enqueue a fresh bootstrap every capability-freshness window and starve
    // the source probe/recovery state machine forever.
    const recovery = await evaluateAutomaticRecovery(workspaceRoot, state, lease);
    if (recovery) return recovery;
    const prewarm = await evaluateStandbyPrewarm(workspaceRoot, state, lease);
    if (prewarm) return prewarm;
    if (lease.state !== "ACTIVE") return { enabled: true, action: "blocked", detail: `Driver state ${lease.state} is awaiting reconciliation; no new handoff will be prepared.` };

    const registry = await readWorkerRegistry(workspaceRoot);
    let activeLane = state.active_lane;
    if (!activeLane) {
      const activeWorkers = (["A", "B"] as const).filter((lane) => {
        const id = registry.lanes[lane].active_worker_id;
        return Boolean(id && registry.workers[id]?.state === "ACTIVE");
      });
      if (activeWorkers.length === 1) activeLane = activeWorkers[0];
    }
    if (!activeLane) {
      const generating = (["A", "B"] as const).filter((lane) => {
        const observation = relayLaneObservation(state.lanes[lane]);
        return observation?.conversation_surface === "CHAT" && observation.generation_active;
      });
      if (generating.length === 1) activeLane = generating[0];
    }
    if (!activeLane) return { enabled: true, action: "blocked", detail: "No active Worker/Lane is known yet; provisioned blank Workers remain non-authoritative." };

    const activeWorkerId = registry.lanes[activeLane].active_worker_id;
    const activeWorker = activeWorkerId ? registry.workers[activeWorkerId] ?? null : null;
    const activeObservation = workerObservation(activeWorker) ?? relayLaneObservation(state.lanes[activeLane]);
    const risk = assessRelayTurnRisk(lease, activeObservation);
    if (risk.web_turn?.candidate && risk.web_turn.structured && !risk.web_turn.should_recover) {
      return {
        enabled: true,
        action: "blocked",
        detail: `Web turn ${risk.web_turn.turn_id} has a failure signal but has not satisfied two stable observation windows with no browser tool in flight; no authority changed.`,
        risk,
        target_lane: activeLane,
        target_worker_id: activeWorker?.worker_id,
      };
    }
    if (!risk.should_handoff) return { enabled: true, action: "idle", detail: `Turn risk ${risk.score}/${risk.threshold}; current Driver remains active.`, risk };

    const standbyLane = otherLane(activeLane);
    const standbyId = registry.lanes[standbyLane].standby_worker_id ?? registry.lanes[standbyLane].active_worker_id;
    const standby = standbyId ? registry.workers[standbyId] ?? null : null;
    if (!workerCanReceive(standby)) {
      if (standby && workerCanBootstrap(standby)) {
        const bootstrap = await enqueueWorkerBootstrapCommand(workspaceRoot, {
          worker: standby,
          registryRevision: registry.revision,
          goalId: lease.goal_id,
        });
        return { enabled: true, action: "blocked", detail: `Turn risk ${risk.score}/${risk.threshold}; standby ${standby.worker_id} has browser proof but not MCP capability proof. Bootstrap ${bootstrap.command_id} is queued; authority remains with the current Driver.`, risk, target_lane: standbyLane, target_worker_id: standby.worker_id, command_id: bootstrap.command_id };
      }
      const requested = await requestWorkerProvision(workspaceRoot, { lane: standbyLane, goalId: lease.goal_id, reason: "risk_handoff_standby_unavailable" });
      const command = await enqueueWorkerProvisionCommand(workspaceRoot, requested.worker, requested.registry.revision);
      return { enabled: true, action: "provisioned", detail: `Turn risk ${risk.score}/${risk.threshold}; standby ${standbyLane} was not safely ready, so ${requested.worker.worker_id} was provisioned without moving Driver authority.`, risk, target_lane: standbyLane, target_worker_id: requested.worker.worker_id, command_id: command.command_id };
    }
    return prepareWorkerHandoff(workspaceRoot, lease, standbyLane, standby!, activeWorker, risk);
  } finally {
    automationBusyWorkspaces.delete(busyKey);
  }
}

export function startRelayAutomation(workspaceRoot: string): () => void {
  assertRecoveryBackgroundIngress("relay_automation.start");
  if (!relayAutomationEnabled()) return () => {};
  const intervalMs = envInt("HARNESS_RELAY_AUTOMATION_POLL_MS", DEFAULT_AUTOMATION_POLL_MS, 500, 30_000);
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void listRelayGoalIds(workspaceRoot).then((ids) => Promise.all(ids.map((goalId) => withRelayGoal(workspaceRoot, goalId, () => evaluateRelayAutomation(workspaceRoot))))).catch((error) => console.warn(`[relay] automation tick failed: ${error instanceof Error ? error.message : String(error)}`));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return () => { stopped = true; clearInterval(timer); };
}

/** Idempotent lifecycle cleanup; no browser command or service action is created. */
export async function fenceSupersededRelayGoal(workspaceRoot: string, oldGoalId: string): Promise<void> {
  await withResolvedRelayGoal(workspaceRoot, oldGoalId, async () => {
    await releaseDriverLease(workspaceRoot, oldGoalId);
    await mutateState(workspaceRoot, (current) => {
      if (current.fenced_at) return current;
      const now = new Date().toISOString();
      const commands = current.commands.map((command): RelayCommand => {
        if (command.state === "PENDING") return Object.freeze({ ...command, state: "FAILED", updated_at: now, failure_detail: "goal_superseded_before_delivery" });
        if (command.state === "CLAIMED" || command.state === "SENT") return Object.freeze({ ...command, state: "AMBIGUOUS", updated_at: now, failure_detail: "goal_superseded_delivery_requires_reconciliation" });
        return command;
      });
      const lanes = Object.fromEntries((["A", "B"] as const).map((lane) => [lane, Object.freeze({ ...current.lanes[lane],
        active_worker_id: null, standby_worker_id: null, replacement_worker_id: null })])) as unknown as RelayManagerState["lanes"];
      return Object.freeze({ ...current, fenced_at: now, fence_reason: "goal_superseded", active_lane: null,
        commands: Object.freeze(commands), lanes: Object.freeze(lanes), updated_at: now });
    });
    await fenceWorkerRegistryForGoal(workspaceRoot, oldGoalId);
  });
}

export function recordRelayLaneHeartbeat(...args: Parameters<typeof recordRelayLaneHeartbeatScoped>): ReturnType<typeof recordRelayLaneHeartbeatScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => recordRelayLaneHeartbeatScoped(...args));
}

export function enqueueRelayResumeCommand(...args: Parameters<typeof enqueueRelayResumeCommandScoped>): ReturnType<typeof enqueueRelayResumeCommandScoped> {
  return withResolvedRelayGoal(args[0], args[1].goal_id, () => enqueueRelayResumeCommandScoped(...args));
}

export function enqueueRelayRecoveryContinuation(...args: Parameters<typeof enqueueRelayRecoveryContinuationScoped>): ReturnType<typeof enqueueRelayRecoveryContinuationScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => enqueueRelayRecoveryContinuationScoped(...args));
}

export function enqueueWorkerProvisionCommand(...args: Parameters<typeof enqueueWorkerProvisionCommandScoped>): ReturnType<typeof enqueueWorkerProvisionCommandScoped> {
  return withResolvedRelayGoal(args[0], args[1].goal_id ?? undefined, () => enqueueWorkerProvisionCommandScoped(...args));
}

export function enqueueWorkerBootstrapCommand(...args: Parameters<typeof enqueueWorkerBootstrapCommandScoped>): ReturnType<typeof enqueueWorkerBootstrapCommandScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => enqueueWorkerBootstrapCommandScoped(...args));
}

export function enqueueWorkerActivationCommand(...args: Parameters<typeof enqueueWorkerActivationCommandScoped>): ReturnType<typeof enqueueWorkerActivationCommandScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => enqueueWorkerActivationCommandScoped(...args));
}

export function enqueueHealthProbeCommand(...args: Parameters<typeof enqueueHealthProbeCommandScoped>): ReturnType<typeof enqueueHealthProbeCommandScoped> {
  return withResolvedRelayGoal(args[0], args[1].lease.goal_id, () => enqueueHealthProbeCommandScoped(...args));
}

export function enqueueWorkerRecoveryCommand(...args: Parameters<typeof enqueueWorkerRecoveryCommandScoped>): ReturnType<typeof enqueueWorkerRecoveryCommandScoped> {
  return withResolvedRelayGoal(args[0], args[1].lease.goal_id, () => enqueueWorkerRecoveryCommandScoped(...args));
}

export function claimRelayCommand(...args: Parameters<typeof claimRelayCommandScoped>): ReturnType<typeof claimRelayCommandScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => claimRelayCommandScoped(...args));
}

export function claimRelayBootstrapCapability(...args: Parameters<typeof claimRelayBootstrapCapabilityScoped>): ReturnType<typeof claimRelayBootstrapCapabilityScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => claimRelayBootstrapCapabilityScoped(...args));
}

export function claimRelayBootstrapCapabilityFromBrowserReceipt(...args: Parameters<typeof claimRelayBootstrapCapabilityFromBrowserReceiptScoped>): ReturnType<typeof claimRelayBootstrapCapabilityFromBrowserReceiptScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => claimRelayBootstrapCapabilityFromBrowserReceiptScoped(...args));
}

export function claimRelayAuthorityFromBrowserReceipt(...args: Parameters<typeof claimRelayAuthorityFromBrowserReceiptScoped>): ReturnType<typeof claimRelayAuthorityFromBrowserReceiptScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => claimRelayAuthorityFromBrowserReceiptScoped(...args));
}

export function claimCompanionCommand(...args: Parameters<typeof claimCompanionCommandScoped>): ReturnType<typeof claimCompanionCommandScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => claimCompanionCommandScoped(...args));
}

export function acknowledgeRelayCommand(...args: Parameters<typeof acknowledgeRelayCommandScoped>): ReturnType<typeof acknowledgeRelayCommandScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => acknowledgeRelayCommandScoped(...args));
}

export function recordRelayCapabilityProof(...args: Parameters<typeof recordRelayCapabilityProofScoped>): ReturnType<typeof recordRelayCapabilityProofScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => recordRelayCapabilityProofScoped(...args));
}

export function getRelayRecoveryCommand(...args: Parameters<typeof getRelayRecoveryCommandScoped>): ReturnType<typeof getRelayRecoveryCommandScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => getRelayRecoveryCommandScoped(...args));
}

export function markRelayRecoveryCommitted(...args: Parameters<typeof markRelayRecoveryCommittedScoped>): ReturnType<typeof markRelayRecoveryCommittedScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => markRelayRecoveryCommittedScoped(...args));
}

export function readRelayControlPlaneProjection(...args: Parameters<typeof readRelayControlPlaneProjectionScoped>): ReturnType<typeof readRelayControlPlaneProjectionScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => readRelayControlPlaneProjectionScoped(...args));
}

export function requestRelayLaneReplacement(...args: Parameters<typeof requestRelayLaneReplacementScoped>): ReturnType<typeof requestRelayLaneReplacementScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => requestRelayLaneReplacementScoped(...args));
}

export function evaluateRelayAutomation(...args: Parameters<typeof evaluateRelayAutomationScoped>): ReturnType<typeof evaluateRelayAutomationScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => evaluateRelayAutomationScoped(...args));
}
