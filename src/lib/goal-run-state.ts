export const GOAL_RUN_STATES = [
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_EXTERNAL_PROCESS",
  "WAITING_USER",
  "READY_TO_FINALIZE",
  "COMPLETED",
  "WAITING_CONTROL_PLANE",
  "NO_PROGRESS_PAUSED",
  "INTERRUPTED",
] as const;

export type GoalRunState = (typeof GOAL_RUN_STATES)[number];

export const GOAL_RUN_EVIDENCE_KINDS = [
  "launch_ack",
  "deterministic",
  "runtime",
  "model_assessed",
  "user_confirmed",
] as const;

export type GoalRunEvidenceKind = (typeof GOAL_RUN_EVIDENCE_KINDS)[number];
export type GoalRunVerifiedEvidenceKind = Exclude<GoalRunEvidenceKind, "launch_ack">;
export type GoalRunMetadataValue = string | number | boolean | null;

export interface GoalRunEvidence {
  readonly id: string;
  readonly kind: GoalRunEvidenceKind;
  readonly summary: string;
  readonly source: string | null;
  readonly metadata: Readonly<Record<string, GoalRunMetadataValue>>;
  readonly recordedAt: string;
}

export interface GoalRunCriterion {
  readonly id: string;
  readonly description: string;
  readonly confirmed: boolean;
  readonly evidenceIds: readonly string[];
  readonly confirmedAt: string | null;
}

export interface GoalRunWaitRecovery {
  readonly attempt: number;
  readonly previousWaitId: string | null;
  readonly strategy: string | null;
  readonly timedOutAt: string | null;
}

interface GoalRunWaitBase {
  readonly id: string;
  readonly description: string;
  readonly status: "ACTIVE" | "INTERRUPTED" | "TIMED_OUT";
  readonly timeoutMs: number;
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly recovery: GoalRunWaitRecovery;
}

export interface GoalRunToolWait extends GoalRunWaitBase {
  readonly kind: "TOOL";
  readonly toolName: string;
}

export interface GoalRunExternalWait extends GoalRunWaitBase {
  readonly kind: "EXTERNAL_PROCESS";
  readonly processRef: string;
  readonly pollIntervalMs: number;
}

export interface GoalRunUserWait extends GoalRunWaitBase {
  readonly kind: "USER";
  readonly requestKey: string;
}

export type GoalRunWaitCondition = GoalRunToolWait | GoalRunExternalWait | GoalRunUserWait;

export interface GoalRunLease {
  readonly leaseId: string;
  readonly holder: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export type GoalRunStopKind = "INTERRUPTION" | "PAUSE" | "CANCEL" | "WAIT_TIMEOUT";

export interface GoalRunStopReason {
  readonly kind: GoalRunStopKind;
  readonly code: string;
  readonly message: string;
  readonly terminal: boolean;
  readonly at: string;
  readonly previousState: Exclude<GoalRunState, "COMPLETED">;
}

export interface GoalRunTimestamps {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stateChangedAt: string;
  readonly completedAt: string | null;
}

export interface GoalRun {
  readonly runId: string;
  readonly revision: number;
  readonly state: GoalRunState;
  readonly objective: string;
  readonly criteria: readonly GoalRunCriterion[];
  readonly typedEvidence: readonly GoalRunEvidence[];
  readonly currentPhase: string;
  readonly nextAction: string | null;
  readonly resumeCursor: string | null;
  readonly waitCondition: GoalRunWaitCondition | null;
  readonly lease: GoalRunLease | null;
  readonly stopReason: GoalRunStopReason | null;
  readonly timestamps: GoalRunTimestamps;
}

export interface CreateGoalRunInput {
  readonly runId: string;
  readonly objective: string;
  readonly criteria: readonly {
    readonly id: string;
    readonly description: string;
  }[];
  readonly currentPhase?: string;
  readonly nextAction?: string | null;
  readonly resumeCursor?: string | null;
  readonly lease?: GoalRunLease | null;
  /** Defaults to the Unix epoch, keeping creation deterministic without a clock. */
  readonly now?: string;
}

export interface GoalRunRecoveryInput {
  readonly attempt?: number;
  readonly previousWaitId?: string | null;
  readonly strategy?: string | null;
}

export type GoalRunEvent =
  | {
      readonly type: "definition_update";
      readonly objective?: string;
      readonly criteria?: readonly {
        readonly id: string;
        readonly description: string;
      }[];
      readonly currentPhase?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "phase_update";
      readonly currentPhase: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "wait_tool";
      readonly waitId: string;
      readonly toolName: string;
      readonly description: string;
      readonly timeoutMs: number;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
      readonly recovery?: GoalRunRecoveryInput;
    }
  | {
      readonly type: "tool_result";
      readonly waitId: string;
      readonly outcome: "succeeded" | "failed";
      readonly summary?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "wait_external";
      readonly waitId: string;
      readonly processRef: string;
      readonly description: string;
      readonly timeoutMs: number;
      readonly pollIntervalMs: number;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
      readonly recovery?: GoalRunRecoveryInput;
    }
  | {
      readonly type: "external_satisfied";
      readonly waitId: string;
      readonly summary?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "wait_user";
      readonly waitId: string;
      readonly requestKey: string;
      readonly description: string;
      readonly timeoutMs: number;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
      readonly recovery?: GoalRunRecoveryInput;
    }
  | {
      readonly type: "user_response";
      readonly waitId: string;
      readonly summary?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "wait_timeout";
      readonly waitId: string;
      readonly message?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "interrupt";
      readonly code: string;
      readonly message: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "control_plane_wait";
      readonly message: string;
      readonly currentPhase?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "control_plane_ready";
      readonly currentPhase?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "resume";
      readonly currentPhase?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
      readonly lease?: GoalRunLease | null;
    }
  | {
      readonly type: "record_evidence";
      readonly evidence: {
        readonly id: string;
        readonly kind: GoalRunEvidenceKind;
        readonly summary: string;
        readonly source?: string | null;
        readonly metadata?: Readonly<Record<string, GoalRunMetadataValue>>;
      };
    }
  | {
      readonly type: "confirm_criterion" | "reconfirm_criterion";
      readonly criterionId: string;
      readonly evidenceIds: readonly string[];
    }
  | { readonly type: "request_finalize" }
  | { readonly type: "complete" }
  | {
      readonly type: "pause";
      readonly pauseKind?: "manual" | "no_progress";
      readonly code: string;
      readonly message: string;
      readonly currentPhase?: string;
      readonly nextAction?: string | null;
      readonly resumeCursor?: string | null;
    }
  | {
      readonly type: "cancel";
      readonly code: string;
      readonly message: string;
    };

export type GoalRunEffect =
  | { readonly type: "WAIT_REGISTERED"; readonly condition: GoalRunWaitCondition }
  | {
      readonly type: "WAIT_CLEARED";
      readonly waitId: string;
      readonly outcome: "tool_result" | "external_satisfied" | "user_response" | "resume";
    }
  | { readonly type: "WAIT_TIMED_OUT"; readonly waitId: string; readonly recoveryAttempt: number }
  | { readonly type: "EVIDENCE_RECORDED"; readonly evidenceId: string; readonly kind: GoalRunEvidenceKind }
  | { readonly type: "CRITERION_CONFIRMED"; readonly criterionId: string; readonly evidenceIds: readonly string[] }
  | { readonly type: "FINALIZATION_READY" }
  | { readonly type: "RUN_COMPLETED"; readonly runId: string }
  | { readonly type: "RUN_STOPPED"; readonly reason: GoalRunStopReason }
  | { readonly type: "LEASE_RELEASED"; readonly leaseId: string }
  | { readonly type: "NOOP"; readonly reason: string };

export interface GoalRunTransitionSummary {
  readonly eventType: GoalRunEvent["type"];
  readonly fromState: GoalRunState;
  readonly toState: GoalRunState;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly changed: boolean;
  readonly summary: string;
}

export interface GoalRunAdvanceResult {
  readonly run: GoalRun;
  readonly transition: GoalRunTransitionSummary;
  readonly effects: readonly GoalRunEffect[];
}

export interface AdvanceGoalRunOptions {
  readonly expectedRevision?: number;
  /** Defaults to run.timestamps.updatedAt, keeping advancement deterministic without a clock. */
  readonly now?: string;
}

export type GoalRunErrorCode =
  | "INVALID_INPUT"
  | "CAS_CONFLICT"
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_RUN"
  | "WAIT_MISMATCH"
  | "WAIT_NOT_EXPIRED"
  | "EVIDENCE_ID_CONFLICT"
  | "UNVERIFIED_EVIDENCE"
  | "CRITERIA_UNMET";

export class GoalRunStateError extends Error {
  readonly code: GoalRunErrorCode;

  constructor(code: GoalRunErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "GoalRunStateError";
    this.code = code;
  }
}

export const GOAL_RUN_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const GOAL_RUN_MAX_POLL_INTERVAL_MS = 60_000;
const GOAL_RUN_MAX_LEASE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIME = "1970-01-01T00:00:00.000Z";
const MAX_CRITERIA = 128;
const MAX_EVIDENCE = 4096;

const STATE_SET = new Set<string>(GOAL_RUN_STATES);
const EVIDENCE_KIND_SET = new Set<string>(GOAL_RUN_EVIDENCE_KINDS);

function fail(code: GoalRunErrorCode, message: string): never {
  throw new GoalRunStateError(code, message);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") fail("INVALID_INPUT", `${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) fail("INVALID_INPUT", `${field} must not be empty`);
  if (normalized.length > max) fail("INVALID_INPUT", `${field} exceeds ${max} characters`);
  return normalized;
}

function nullableText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  return text(value, field, max);
}

function canonicalTime(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_INPUT", `${field} must be an ISO timestamp`);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) fail("INVALID_INPUT", `${field} must be an ISO timestamp`);
  return new Date(millis).toISOString();
}

function timeMillis(value: string): number {
  return Date.parse(value);
}

function assertMonotonic(now: string, prior: string): void {
  if (timeMillis(now) < timeMillis(prior)) {
    fail("INVALID_INPUT", `now ${now} is earlier than run.updatedAt ${prior}`);
  }
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail("INVALID_INPUT", `${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function normalizeMetadata(
  metadata: Readonly<Record<string, GoalRunMetadataValue>> | undefined
): Readonly<Record<string, GoalRunMetadataValue>> {
  if (metadata === undefined) return {};
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("INVALID_INPUT", "evidence.metadata must be a plain object");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 64) fail("INVALID_INPUT", "evidence.metadata exceeds 64 entries");
  const normalized: Record<string, GoalRunMetadataValue> = {};
  for (const [rawKey, value] of entries) {
    const key = text(rawKey, "evidence.metadata key", 128);
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
      fail("INVALID_INPUT", `evidence.metadata.${key} must be a string, number, boolean, or null`);
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail("INVALID_INPUT", `evidence.metadata.${key} must be finite`);
    }
    if (typeof value === "string" && value.length > 4000) {
      fail("INVALID_INPUT", `evidence.metadata.${key} exceeds 4000 characters`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeLease(lease: GoalRunLease | null | undefined): GoalRunLease | null {
  if (lease === undefined || lease === null) return null;
  const acquiredAt = canonicalTime(lease.acquiredAt, "lease.acquiredAt");
  const expiresAt = canonicalTime(lease.expiresAt, "lease.expiresAt");
  const duration = timeMillis(expiresAt) - timeMillis(acquiredAt);
  if (duration <= 0 || duration > GOAL_RUN_MAX_LEASE_MS) {
    fail("INVALID_INPUT", `lease duration must be greater than zero and at most ${GOAL_RUN_MAX_LEASE_MS}ms`);
  }
  return {
    leaseId: text(lease.leaseId, "lease.leaseId", 128),
    holder: text(lease.holder, "lease.holder", 256),
    acquiredAt,
    expiresAt,
  };
}

function normalizeRecovery(recovery: GoalRunRecoveryInput | undefined): GoalRunWaitRecovery {
  const attempt = integer(recovery?.attempt ?? 0, "wait.recovery.attempt", 0, 100);
  const previousWaitId = nullableText(recovery?.previousWaitId, "wait.recovery.previousWaitId", 128);
  const strategy = nullableText(recovery?.strategy, "wait.recovery.strategy", 1000);
  if (attempt > 0 && (!previousWaitId || !strategy)) {
    fail("INVALID_INPUT", "a recovery attempt requires previousWaitId and strategy");
  }
  if (attempt === 0 && (previousWaitId || strategy)) {
    fail("INVALID_INPUT", "recovery metadata requires attempt greater than zero");
  }
  return { attempt, previousWaitId, strategy, timedOutAt: null };
}

function waitBase(
  waitId: string,
  description: string,
  timeoutMs: number,
  now: string,
  recovery: GoalRunRecoveryInput | undefined
): GoalRunWaitBase {
  const boundedTimeout = integer(timeoutMs, "wait.timeoutMs", 1, GOAL_RUN_MAX_WAIT_MS);
  return {
    id: text(waitId, "wait.waitId", 128),
    description: text(description, "wait.description", 2000),
    status: "ACTIVE",
    timeoutMs: boundedTimeout,
    startedAt: now,
    deadlineAt: new Date(timeMillis(now) + boundedTimeout).toISOString(),
    recovery: normalizeRecovery(recovery),
  };
}

function cloneCriterion(criterion: GoalRunCriterion): GoalRunCriterion {
  return { ...criterion, evidenceIds: [...criterion.evidenceIds] };
}

function cloneEvidence(evidence: GoalRunEvidence): GoalRunEvidence {
  return { ...evidence, metadata: { ...evidence.metadata } };
}

function cloneWait(wait: GoalRunWaitCondition | null): GoalRunWaitCondition | null {
  if (!wait) return null;
  return { ...wait, recovery: { ...wait.recovery } };
}

function cloneRun(run: GoalRun): GoalRun {
  return {
    ...run,
    criteria: run.criteria.map(cloneCriterion),
    typedEvidence: run.typedEvidence.map(cloneEvidence),
    waitCondition: cloneWait(run.waitCondition),
    lease: run.lease ? { ...run.lease } : null,
    stopReason: run.stopReason ? { ...run.stopReason } : null,
    timestamps: { ...run.timestamps },
  };
}

function freezeWait(wait: GoalRunWaitCondition | null): GoalRunWaitCondition | null {
  if (!wait) return null;
  Object.freeze(wait.recovery);
  return Object.freeze(wait);
}

function freezeRun(run: GoalRun): GoalRun {
  for (const criterion of run.criteria) {
    Object.freeze(criterion.evidenceIds);
    Object.freeze(criterion);
  }
  for (const evidence of run.typedEvidence) {
    Object.freeze(evidence.metadata);
    Object.freeze(evidence);
  }
  Object.freeze(run.criteria);
  Object.freeze(run.typedEvidence);
  freezeWait(run.waitCondition);
  if (run.lease) Object.freeze(run.lease);
  if (run.stopReason) Object.freeze(run.stopReason);
  Object.freeze(run.timestamps);
  return Object.freeze(run);
}

function freezeEffect(effect: GoalRunEffect): GoalRunEffect {
  if (effect.type === "WAIT_REGISTERED") freezeWait(effect.condition);
  if (effect.type === "CRITERION_CONFIRMED") Object.freeze(effect.evidenceIds);
  if (effect.type === "RUN_STOPPED") Object.freeze(effect.reason);
  return Object.freeze(effect);
}

function freezeResult(
  run: GoalRun,
  transition: GoalRunTransitionSummary,
  effects: GoalRunEffect[]
): GoalRunAdvanceResult {
  const frozenRun = freezeRun(run);
  effects.forEach(freezeEffect);
  return Object.freeze({
    run: frozenRun,
    transition: Object.freeze(transition),
    effects: Object.freeze(effects),
  });
}

function isVerifiedKind(kind: GoalRunEvidenceKind): kind is GoalRunVerifiedEvidenceKind {
  return kind !== "launch_ack";
}

function verifiesCriterion(evidence: GoalRunEvidence): boolean {
  return isVerifiedKind(evidence.kind) && evidence.metadata.verifiesCriterion !== false;
}

function allCriteriaConfirmed(run: GoalRun): boolean {
  return run.criteria.length > 0 && run.criteria.every((criterion) => criterion.confirmed);
}

function expectedWaitKind(state: GoalRunState): GoalRunWaitCondition["kind"] | null {
  if (state === "WAITING_TOOL") return "TOOL";
  if (state === "WAITING_EXTERNAL_PROCESS") return "EXTERNAL_PROCESS";
  if (state === "WAITING_USER") return "USER";
  return null;
}

function validateWaitCondition(wait: GoalRunWaitCondition): void {
  text(wait.id, "waitCondition.id", 128);
  text(wait.description, "waitCondition.description", 2000);
  if (!(["ACTIVE", "INTERRUPTED", "TIMED_OUT"] as const).includes(wait.status)) {
    fail("INVALID_INPUT", `unknown waitCondition status ${String(wait.status)}`);
  }
  const timeoutMs = integer(wait.timeoutMs, "waitCondition.timeoutMs", 1, GOAL_RUN_MAX_WAIT_MS);
  const startedAt = canonicalTime(wait.startedAt, "waitCondition.startedAt");
  const deadlineAt = canonicalTime(wait.deadlineAt, "waitCondition.deadlineAt");
  if (timeMillis(deadlineAt) - timeMillis(startedAt) !== timeoutMs) {
    fail("INVALID_INPUT", "waitCondition deadline must equal startedAt plus timeoutMs");
  }
  const attempt = integer(wait.recovery.attempt, "waitCondition.recovery.attempt", 0, 100);
  const previousWaitId = nullableText(wait.recovery.previousWaitId, "waitCondition.recovery.previousWaitId", 128);
  const strategy = nullableText(wait.recovery.strategy, "waitCondition.recovery.strategy", 1000);
  if (attempt > 0 && (!previousWaitId || !strategy)) {
    fail("INVALID_INPUT", "a persisted recovery attempt requires previousWaitId and strategy");
  }
  if (attempt === 0 && (previousWaitId || strategy)) {
    fail("INVALID_INPUT", "persisted recovery metadata requires attempt greater than zero");
  }
  const timedOutAt = wait.recovery.timedOutAt === null
    ? null
    : canonicalTime(wait.recovery.timedOutAt, "waitCondition.recovery.timedOutAt");
  if (wait.status === "TIMED_OUT") {
    if (!timedOutAt || timeMillis(timedOutAt) < timeMillis(deadlineAt)) {
      fail("INVALID_INPUT", "timed-out waitCondition requires timedOutAt at or after its deadline");
    }
  } else if (timedOutAt) {
    fail("INVALID_INPUT", `${wait.status} waitCondition must not carry timedOutAt`);
  }

  if (wait.kind === "TOOL") {
    text(wait.toolName, "waitCondition.toolName", 256);
  } else if (wait.kind === "EXTERNAL_PROCESS") {
    text(wait.processRef, "waitCondition.processRef", 512);
    const pollIntervalMs = integer(
      wait.pollIntervalMs,
      "waitCondition.pollIntervalMs",
      100,
      GOAL_RUN_MAX_POLL_INTERVAL_MS
    );
    if (pollIntervalMs > timeoutMs) fail("INVALID_INPUT", "waitCondition.pollIntervalMs must not exceed timeoutMs");
  } else if (wait.kind === "USER") {
    text(wait.requestKey, "waitCondition.requestKey", 256);
  } else {
    fail("INVALID_INPUT", `unknown waitCondition kind ${String((wait as { kind?: unknown }).kind)}`);
  }
}

function validateStopReason(reason: GoalRunStopReason): void {
  if (!(["INTERRUPTION", "PAUSE", "CANCEL", "WAIT_TIMEOUT"] as const).includes(reason.kind)) {
    fail("INVALID_INPUT", `unknown stopReason kind ${String(reason.kind)}`);
  }
  text(reason.code, "stopReason.code", 128);
  text(reason.message, "stopReason.message", 2000);
  canonicalTime(reason.at, "stopReason.at");
  if (!STATE_SET.has(reason.previousState)) {
    fail("INVALID_INPUT", `invalid stopReason previousState ${String(reason.previousState)}`);
  }
  if (reason.terminal !== (reason.kind === "CANCEL")) {
    fail("INVALID_INPUT", "only CANCEL is a terminal stopReason");
  }
}

function validateRun(run: GoalRun): void {
  text(run.runId, "run.runId", 128);
  integer(run.revision, "run.revision", 1, Number.MAX_SAFE_INTEGER);
  if (!STATE_SET.has(run.state)) fail("INVALID_INPUT", `unknown run state ${String(run.state)}`);
  text(run.objective, "run.objective", 8000);
  text(run.currentPhase, "run.currentPhase", 2000);
  nullableText(run.nextAction, "run.nextAction", 4000);
  nullableText(run.resumeCursor, "run.resumeCursor", 4000);
  if (!Array.isArray(run.criteria) || run.criteria.length < 1 || run.criteria.length > MAX_CRITERIA) {
    fail("INVALID_INPUT", `run.criteria must contain 1 to ${MAX_CRITERIA} entries`);
  }
  if (!Array.isArray(run.typedEvidence) || run.typedEvidence.length > MAX_EVIDENCE) {
    fail("INVALID_INPUT", `run.typedEvidence must contain at most ${MAX_EVIDENCE} entries`);
  }

  const evidenceById = new Map<string, GoalRunEvidence>();
  for (const evidence of run.typedEvidence) {
    const id = text(evidence.id, "evidence.id", 128);
    if (evidenceById.has(id)) fail("INVALID_INPUT", `duplicate evidence id ${id}`);
    if (!EVIDENCE_KIND_SET.has(evidence.kind)) fail("INVALID_INPUT", `unknown evidence kind ${String(evidence.kind)}`);
    text(evidence.summary, "evidence.summary", 4000);
    nullableText(evidence.source, "evidence.source", 512);
    normalizeMetadata(evidence.metadata);
    canonicalTime(evidence.recordedAt, "evidence.recordedAt");
    evidenceById.set(id, evidence);
  }

  const criterionIds = new Set<string>();
  for (const criterion of run.criteria) {
    const id = text(criterion.id, "criterion.id", 128);
    if (criterionIds.has(id)) fail("INVALID_INPUT", `duplicate criterion id ${id}`);
    criterionIds.add(id);
    text(criterion.description, "criterion.description", 2000);
    if (typeof criterion.confirmed !== "boolean") fail("INVALID_INPUT", `criterion ${id} confirmed must be boolean`);
    if (!Array.isArray(criterion.evidenceIds)) fail("INVALID_INPUT", `criterion ${id} evidenceIds must be an array`);
    const unique = new Set(criterion.evidenceIds);
    if (unique.size !== criterion.evidenceIds.length) fail("INVALID_INPUT", `criterion ${id} repeats evidence ids`);
    const referenced: GoalRunEvidence[] = criterion.evidenceIds.map((evidenceId: string) => {
      const normalized = text(evidenceId, `criterion ${id} evidence id`, 128);
      const evidence = evidenceById.get(normalized);
      if (!evidence) fail("INVALID_INPUT", `criterion ${id} references unknown evidence ${normalized}`);
      return evidence;
    });
    if (criterion.confirmed && !referenced.some(verifiesCriterion)) {
      fail("UNVERIFIED_EVIDENCE", `criterion ${id} lacks verified evidence`);
    }
    if (criterion.confirmed !== Boolean(criterion.confirmedAt)) {
      fail("INVALID_INPUT", `criterion ${id} confirmedAt does not match confirmed status`);
    }
    if (criterion.confirmedAt) canonicalTime(criterion.confirmedAt, `criterion ${id} confirmedAt`);
  }

  const createdAt = canonicalTime(run.timestamps.createdAt, "timestamps.createdAt");
  const updatedAt = canonicalTime(run.timestamps.updatedAt, "timestamps.updatedAt");
  const stateChangedAt = canonicalTime(run.timestamps.stateChangedAt, "timestamps.stateChangedAt");
  if (timeMillis(updatedAt) < timeMillis(createdAt) || timeMillis(stateChangedAt) < timeMillis(createdAt)) {
    fail("INVALID_INPUT", "run timestamps must not precede creation");
  }
  if (run.timestamps.completedAt) canonicalTime(run.timestamps.completedAt, "timestamps.completedAt");
  if ((run.state === "COMPLETED") !== Boolean(run.timestamps.completedAt)) {
    fail("INVALID_INPUT", "completedAt must be present only for COMPLETED runs");
  }

  const expectedKind = expectedWaitKind(run.state);
  if (run.waitCondition) validateWaitCondition(run.waitCondition);
  if (expectedKind) {
    if (!run.waitCondition || run.waitCondition.kind !== expectedKind || run.waitCondition.status !== "ACTIVE") {
      fail("INVALID_INPUT", `${run.state} requires a matching active waitCondition`);
    }
  } else if (run.state !== "INTERRUPTED" && run.state !== "NO_PROGRESS_PAUSED" && run.waitCondition) {
    fail("INVALID_INPUT", `${run.state} must not carry a waitCondition`);
  }
  if (run.state === "INTERRUPTED" || run.state === "NO_PROGRESS_PAUSED") {
    if (!run.stopReason) fail("INVALID_INPUT", `${run.state} requires stopReason`);
    validateStopReason(run.stopReason);
    if (run.waitCondition && run.waitCondition.status === "ACTIVE") {
      fail("INVALID_INPUT", `${run.state} waitCondition must be interrupted or timed out`);
    }
  } else if (run.stopReason) {
    fail("INVALID_INPUT", `${run.state} must not carry stopReason`);
  }
  if ((run.state === "READY_TO_FINALIZE" || run.state === "COMPLETED") && !allCriteriaConfirmed(run)) {
    fail("CRITERIA_UNMET", `${run.state} requires every criterion to be confirmed`);
  }
  normalizeLease(run.lease);
}

/**
 * Validate a persisted or externally supplied GoalRun without advancing it.
 * The store uses this public boundary after its JSON-shape checks so a
 * structurally valid but semantically impossible state cannot be loaded.
 */
export function validateGoalRun(run: GoalRun): void {
  validateRun(run);
}

function assertState(run: GoalRun, eventType: GoalRunEvent["type"], allowed: readonly GoalRunState[]): void {
  if (!allowed.includes(run.state)) {
    fail("ILLEGAL_TRANSITION", `${eventType} is not legal from ${run.state}; expected ${allowed.join(" or ")}`);
  }
}

function activeWait(run: GoalRun, waitId: string): GoalRunWaitCondition {
  const requested = text(waitId, "event.waitId", 128);
  if (!run.waitCondition || run.waitCondition.status !== "ACTIVE" || run.waitCondition.id !== requested) {
    fail("WAIT_MISMATCH", `active wait does not match ${requested}`);
  }
  return run.waitCondition;
}

function eventText(value: string | null | undefined, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  return nullableText(value, field, max);
}

function releaseLeaseEffect(run: GoalRun, effects: GoalRunEffect[]): void {
  if (run.lease) effects.push({ type: "LEASE_RELEASED", leaseId: run.lease.leaseId });
}

function stoppedWait(wait: GoalRunWaitCondition | null, status: "INTERRUPTED" | "TIMED_OUT", at?: string): GoalRunWaitCondition | null {
  if (!wait) return null;
  return {
    ...wait,
    status,
    recovery: {
      ...wait.recovery,
      timedOutAt: status === "TIMED_OUT" ? at ?? wait.recovery.timedOutAt : wait.recovery.timedOutAt,
    },
  };
}

function stopReason(
  kind: GoalRunStopKind,
  code: string,
  message: string,
  terminal: boolean,
  at: string,
  previousState: Exclude<GoalRunState, "COMPLETED">
): GoalRunStopReason {
  return {
    kind,
    code: text(code, "stop.code", 128),
    message: text(message, "stop.message", 2000),
    terminal,
    at,
    previousState,
  };
}

function evidencePayloadEqual(left: GoalRunEvidence, right: GoalRunEvidence): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.summary !== right.summary || left.source !== right.source) return false;
  const lexical = ([leftKey]: [string, GoalRunMetadataValue], [rightKey]: [string, GoalRunMetadataValue]): number =>
    leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  const leftEntries = Object.entries(left.metadata).sort(lexical);
  const rightEntries = Object.entries(right.metadata).sort(lexical);
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function transitionResult(
  base: GoalRun,
  candidate: GoalRun,
  event: GoalRunEvent,
  now: string,
  summary: string,
  effects: GoalRunEffect[]
): GoalRunAdvanceResult {
  const stateChanged = candidate.state !== base.state;
  const next: GoalRun = {
    ...candidate,
    revision: base.revision + 1,
    timestamps: {
      ...candidate.timestamps,
      updatedAt: now,
      stateChangedAt: stateChanged ? now : base.timestamps.stateChangedAt,
    },
  };
  validateRun(next);
  return freezeResult(
    cloneRun(next),
    {
      eventType: event.type,
      fromState: base.state,
      toState: next.state,
      fromRevision: base.revision,
      toRevision: next.revision,
      changed: true,
      summary,
    },
    effects
  );
}

function noopResult(base: GoalRun, event: GoalRunEvent, summary: string): GoalRunAdvanceResult {
  return freezeResult(
    cloneRun(base),
    {
      eventType: event.type,
      fromState: base.state,
      toState: base.state,
      fromRevision: base.revision,
      toRevision: base.revision,
      changed: false,
      summary,
    },
    [{ type: "NOOP", reason: summary }]
  );
}

export function createGoalRun(input: CreateGoalRunInput): GoalRun {
  const now = canonicalTime(input.now ?? DEFAULT_TIME, "input.now");
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > MAX_CRITERIA) {
    fail("INVALID_INPUT", `criteria must contain 1 to ${MAX_CRITERIA} entries`);
  }
  const seen = new Set<string>();
  const criteria = input.criteria.map((criterion, index): GoalRunCriterion => {
    const id = text(criterion.id, `criteria[${index}].id`, 128);
    if (seen.has(id)) fail("INVALID_INPUT", `duplicate criterion id ${id}`);
    seen.add(id);
    return {
      id,
      description: text(criterion.description, `criteria[${index}].description`, 2000),
      confirmed: false,
      evidenceIds: [],
      confirmedAt: null,
    };
  });
  const run: GoalRun = {
    runId: text(input.runId, "input.runId", 128),
    revision: 1,
    state: "RUNNING",
    objective: text(input.objective, "input.objective", 8000),
    criteria,
    typedEvidence: [],
    currentPhase: text(input.currentPhase ?? "Execute the goal", "input.currentPhase", 2000),
    nextAction: input.nextAction === undefined
      ? "Advance the current phase"
      : nullableText(input.nextAction, "input.nextAction", 4000),
    resumeCursor: nullableText(input.resumeCursor, "input.resumeCursor", 4000),
    waitCondition: null,
    lease: normalizeLease(input.lease),
    stopReason: null,
    timestamps: {
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
      completedAt: null,
    },
  };
  validateRun(run);
  return freezeRun(cloneRun(run));
}

export function advanceGoalRun(
  current: GoalRun,
  event: GoalRunEvent,
  options: AdvanceGoalRunOptions = {}
): GoalRunAdvanceResult {
  const base = cloneRun(current);
  validateRun(base);
  if (options.expectedRevision !== undefined) {
    integer(options.expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER);
    if (options.expectedRevision !== base.revision) {
      fail("CAS_CONFLICT", `expected revision ${options.expectedRevision}, current revision is ${base.revision}`);
    }
  }
  const now = canonicalTime(options.now ?? base.timestamps.updatedAt, "options.now");
  assertMonotonic(now, base.timestamps.updatedAt);
  if (base.state === "COMPLETED") fail("TERMINAL_RUN", "completed runs cannot transition");
  if (base.stopReason?.kind === "CANCEL" && base.stopReason.terminal) {
    fail("TERMINAL_RUN", "cancelled runs cannot transition");
  }

  let next = cloneRun(base);
  const effects: GoalRunEffect[] = [];
  let summary = "";

  switch (event.type) {
    case "definition_update": {
      assertState(base, event.type, ["RUNNING", "READY_TO_FINALIZE", "WAITING_CONTROL_PLANE", "NO_PROGRESS_PAUSED", "INTERRUPTED"]);
      let criteria = next.criteria;
      if (event.criteria !== undefined) {
        if (!Array.isArray(event.criteria) || event.criteria.length < 1) {
          fail("INVALID_INPUT", "event.criteria requires at least one criterion");
        }
        const seen = new Set<string>();
        criteria = event.criteria.map((candidate, index) => {
          const id = text(candidate.id, `event.criteria[${index}].id`, 128);
          if (seen.has(id)) fail("INVALID_INPUT", `event.criteria repeats id ${id}`);
          seen.add(id);
          const existing = base.criteria.find((criterion) => criterion.id === id);
          return existing
            ? { ...existing, description: text(candidate.description, `event.criteria[${index}].description`, 2000) }
            : {
                id,
                description: text(candidate.description, `event.criteria[${index}].description`, 2000),
                confirmed: false,
                evidenceIds: [],
                confirmedAt: null,
              };
        });
      }
      next = {
        ...next,
        objective: event.objective === undefined
          ? next.objective
          : text(event.objective, "event.objective", 8000),
        criteria,
        currentPhase: event.currentPhase === undefined
          ? next.currentPhase
          : text(event.currentPhase, "event.currentPhase", 2000),
        nextAction: event.nextAction === undefined
          ? next.nextAction
          : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined
          ? next.resumeCursor
          : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
        ...(base.state === "READY_TO_FINALIZE" && criteria.some((criterion) => !criterion.confirmed)
          ? { state: "RUNNING" as const }
          : {}),
      };
      summary = `Updated goal definition for ${base.runId}`;
      break;
    }

    case "phase_update": {
      assertState(base, event.type, ["RUNNING"]);
      next = {
        ...next,
        currentPhase: text(event.currentPhase, "event.currentPhase", 2000),
        nextAction: event.nextAction === undefined ? next.nextAction : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      summary = `Updated phase to ${next.currentPhase}`;
      break;
    }

    case "wait_tool": {
      assertState(base, event.type, ["RUNNING"]);
      const condition: GoalRunToolWait = {
        ...waitBase(event.waitId, event.description, event.timeoutMs, now, event.recovery),
        kind: "TOOL",
        toolName: text(event.toolName, "event.toolName", 256),
      };
      next = {
        ...next,
        state: "WAITING_TOOL",
        waitCondition: condition,
        nextAction: event.nextAction === undefined ? `Await tool ${condition.toolName}` : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_REGISTERED", condition });
      summary = `Waiting for tool ${condition.toolName}`;
      break;
    }

    case "tool_result": {
      assertState(base, event.type, ["WAITING_TOOL"]);
      const wait = activeWait(base, event.waitId);
      if (wait.kind !== "TOOL") fail("WAIT_MISMATCH", `${event.waitId} is not a tool wait`);
      if (event.summary !== undefined) text(event.summary, "event.summary", 2000);
      next = {
        ...next,
        state: "RUNNING",
        waitCondition: null,
        nextAction: event.nextAction === undefined ? "Continue after tool result" : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_CLEARED", waitId: wait.id, outcome: "tool_result" });
      summary = `Tool wait ${wait.id} ${event.outcome}`;
      break;
    }

    case "wait_external": {
      assertState(base, event.type, ["RUNNING"]);
      const baseCondition = waitBase(event.waitId, event.description, event.timeoutMs, now, event.recovery);
      const pollIntervalMs = integer(event.pollIntervalMs, "wait.pollIntervalMs", 100, GOAL_RUN_MAX_POLL_INTERVAL_MS);
      if (pollIntervalMs > baseCondition.timeoutMs) {
        fail("INVALID_INPUT", "wait.pollIntervalMs must not exceed timeoutMs");
      }
      const condition: GoalRunExternalWait = {
        ...baseCondition,
        kind: "EXTERNAL_PROCESS",
        processRef: text(event.processRef, "event.processRef", 512),
        pollIntervalMs,
      };
      next = {
        ...next,
        state: "WAITING_EXTERNAL_PROCESS",
        waitCondition: condition,
        nextAction: event.nextAction === undefined ? `Await external process ${condition.processRef}` : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_REGISTERED", condition });
      summary = `Waiting for external process ${condition.processRef}`;
      break;
    }

    case "external_satisfied": {
      assertState(base, event.type, ["WAITING_EXTERNAL_PROCESS"]);
      const wait = activeWait(base, event.waitId);
      if (wait.kind !== "EXTERNAL_PROCESS") fail("WAIT_MISMATCH", `${event.waitId} is not an external-process wait`);
      if (event.summary !== undefined) text(event.summary, "event.summary", 2000);
      next = {
        ...next,
        state: "RUNNING",
        waitCondition: null,
        nextAction: event.nextAction === undefined ? "Continue after external process" : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_CLEARED", waitId: wait.id, outcome: "external_satisfied" });
      summary = `External wait ${wait.id} satisfied`;
      break;
    }

    case "wait_user": {
      assertState(base, event.type, ["RUNNING"]);
      const condition: GoalRunUserWait = {
        ...waitBase(event.waitId, event.description, event.timeoutMs, now, event.recovery),
        kind: "USER",
        requestKey: text(event.requestKey, "event.requestKey", 256),
      };
      next = {
        ...next,
        state: "WAITING_USER",
        waitCondition: condition,
        nextAction: event.nextAction === undefined ? `Await user input ${condition.requestKey}` : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_REGISTERED", condition });
      summary = `Waiting for user input ${condition.requestKey}`;
      break;
    }

    case "user_response": {
      assertState(base, event.type, ["WAITING_USER"]);
      const wait = activeWait(base, event.waitId);
      if (wait.kind !== "USER") fail("WAIT_MISMATCH", `${event.waitId} is not a user wait`);
      if (event.summary !== undefined) text(event.summary, "event.summary", 2000);
      next = {
        ...next,
        state: "RUNNING",
        waitCondition: null,
        nextAction: event.nextAction === undefined ? "Continue with user input" : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_CLEARED", waitId: wait.id, outcome: "user_response" });
      summary = `User wait ${wait.id} satisfied`;
      break;
    }

    case "wait_timeout": {
      assertState(base, event.type, ["WAITING_TOOL", "WAITING_EXTERNAL_PROCESS", "WAITING_USER"]);
      const wait = activeWait(base, event.waitId);
      if (timeMillis(now) < timeMillis(wait.deadlineAt)) {
        fail("WAIT_NOT_EXPIRED", `wait ${wait.id} does not expire until ${wait.deadlineAt}`);
      }
      const reason = stopReason(
        "WAIT_TIMEOUT",
        "wait_timeout",
        event.message ?? `Wait ${wait.id} timed out`,
        false,
        now,
        base.state
      );
      releaseLeaseEffect(base, effects);
      next = {
        ...next,
        state: "INTERRUPTED",
        waitCondition: stoppedWait(wait, "TIMED_OUT", now),
        lease: null,
        stopReason: reason,
        nextAction: event.nextAction === undefined ? "Recover from timed-out wait" : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "WAIT_TIMED_OUT", waitId: wait.id, recoveryAttempt: wait.recovery.attempt });
      effects.push({ type: "RUN_STOPPED", reason });
      summary = `Wait ${wait.id} timed out`;
      break;
    }

    case "control_plane_wait": {
      assertState(base, event.type, ["RUNNING"]);
      const message = text(event.message, "event.message", 2000);
      next = {
        ...next,
        state: "WAITING_CONTROL_PLANE",
        waitCondition: null,
        stopReason: null,
        currentPhase: event.currentPhase === undefined
          ? `Waiting for control plane: ${message}`
          : text(event.currentPhase, "event.currentPhase", 2000),
        nextAction: event.nextAction === undefined
          ? "Resume automatically when a browser/MCP lane is capability-ready"
          : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined
          ? next.resumeCursor
          : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      summary = `Waiting for control plane: ${message}`;
      break;
    }

    case "control_plane_ready": {
      assertState(base, event.type, ["WAITING_CONTROL_PLANE"]);
      next = {
        ...next,
        state: "RUNNING",
        waitCondition: null,
        stopReason: null,
        currentPhase: event.currentPhase === undefined
          ? "Browser/MCP control plane restored"
          : text(event.currentPhase, "event.currentPhase", 2000),
        nextAction: event.nextAction === undefined
          ? next.nextAction ?? "Continue goal execution"
          : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined
          ? next.resumeCursor
          : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      summary = `Control plane restored for ${base.runId}`;
      break;
    }

    case "interrupt":
    case "pause": {
      assertState(base, event.type, ["RUNNING", "WAITING_TOOL", "WAITING_EXTERNAL_PROCESS", "WAITING_USER", "READY_TO_FINALIZE", "WAITING_CONTROL_PLANE"]);
      const kind: GoalRunStopKind = event.type === "pause" ? "PAUSE" : "INTERRUPTION";
      const noProgressPause = event.type === "pause" && event.pauseKind === "no_progress";
      const reason = stopReason(kind, event.code, event.message, false, now, base.state);
      releaseLeaseEffect(base, effects);
      next = {
        ...next,
        state: noProgressPause ? "NO_PROGRESS_PAUSED" : "INTERRUPTED",
        waitCondition: stoppedWait(base.waitCondition, "INTERRUPTED"),
        lease: null,
        stopReason: reason,
        currentPhase: event.type === "pause" && event.currentPhase !== undefined
          ? text(event.currentPhase, "event.currentPhase", 2000)
          : next.currentPhase,
        nextAction: event.nextAction === undefined ? next.nextAction : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      effects.push({ type: "RUN_STOPPED", reason });
      summary = noProgressPause
        ? `No-progress paused: ${reason.message}`
        : event.type === "pause" ? `Paused: ${reason.message}` : `Interrupted: ${reason.message}`;
      break;
    }

    case "resume": {
      assertState(base, event.type, ["WAITING_CONTROL_PLANE", "NO_PROGRESS_PAUSED", "INTERRUPTED"]);
      if (base.state !== "WAITING_CONTROL_PLANE" && (!base.stopReason || base.stopReason.terminal)) {
        fail("TERMINAL_RUN", "terminal stop reasons cannot resume");
      }
      const returnToReady = base.stopReason?.previousState === "READY_TO_FINALIZE" && allCriteriaConfirmed(base);
      const clearedWait = base.waitCondition;
      next = {
        ...next,
        state: returnToReady ? "READY_TO_FINALIZE" : "RUNNING",
        waitCondition: null,
        lease: normalizeLease(event.lease),
        stopReason: null,
        currentPhase: event.currentPhase === undefined
          ? next.currentPhase
          : text(event.currentPhase, "event.currentPhase", 2000),
        nextAction: event.nextAction === undefined ? next.nextAction ?? "Continue goal execution" : eventText(event.nextAction, "event.nextAction", 4000) ?? null,
        resumeCursor: event.resumeCursor === undefined ? next.resumeCursor : eventText(event.resumeCursor, "event.resumeCursor", 4000) ?? null,
      };
      if (clearedWait) effects.push({ type: "WAIT_CLEARED", waitId: clearedWait.id, outcome: "resume" });
      summary = `Resumed run ${base.runId}`;
      break;
    }

    case "record_evidence": {
      assertState(base, event.type, ["RUNNING", "READY_TO_FINALIZE"]);
      const kind = event.evidence.kind;
      if (!EVIDENCE_KIND_SET.has(kind)) fail("INVALID_INPUT", `unknown evidence kind ${String(kind)}`);
      const evidence: GoalRunEvidence = {
        id: text(event.evidence.id, "event.evidence.id", 128),
        kind,
        summary: text(event.evidence.summary, "event.evidence.summary", 4000),
        source: nullableText(event.evidence.source, "event.evidence.source", 512),
        metadata: normalizeMetadata(event.evidence.metadata),
        recordedAt: now,
      };
      const existing = base.typedEvidence.find((candidate) => candidate.id === evidence.id);
      if (existing) {
        if (!evidencePayloadEqual(existing, evidence)) {
          fail("EVIDENCE_ID_CONFLICT", `evidence id ${evidence.id} already has a different payload`);
        }
        return noopResult(base, event, `Evidence ${evidence.id} already recorded`);
      }
      if (base.typedEvidence.length >= MAX_EVIDENCE) fail("INVALID_INPUT", `typedEvidence exceeds ${MAX_EVIDENCE} entries`);
      next = { ...next, typedEvidence: [...next.typedEvidence, evidence] };
      effects.push({ type: "EVIDENCE_RECORDED", evidenceId: evidence.id, kind: evidence.kind });
      summary = `Recorded ${evidence.kind} evidence ${evidence.id}`;
      break;
    }

    case "confirm_criterion":
    case "reconfirm_criterion": {
      assertState(base, event.type, event.type === "reconfirm_criterion" ? ["RUNNING", "READY_TO_FINALIZE"] : ["RUNNING"]);
      const criterionId = text(event.criterionId, "event.criterionId", 128);
      const index = base.criteria.findIndex((criterion) => criterion.id === criterionId);
      if (index < 0) fail("INVALID_INPUT", `unknown criterion ${criterionId}`);
      if (!Array.isArray(event.evidenceIds) || event.evidenceIds.length < 1) {
        fail("UNVERIFIED_EVIDENCE", `criterion ${criterionId} requires evidence ids`);
      }
      const evidenceIds = [...new Set(event.evidenceIds.map((id) => text(id, "event.evidenceId", 128)))];
      const evidence = evidenceIds.map((id) => {
        const found = base.typedEvidence.find((candidate) => candidate.id === id);
        if (!found) fail("INVALID_INPUT", `unknown evidence id ${id}`);
        return found;
      });
      if (!evidence.some(verifiesCriterion)) {
        fail(
          "UNVERIFIED_EVIDENCE",
          `criterion ${criterionId} requires at least one successful non-launch evidence item`
        );
      }
      const currentCriterion = base.criteria[index];
      if (currentCriterion.confirmed) {
        const currentIds = [...currentCriterion.evidenceIds].sort();
        const requestedIds = [...evidenceIds].sort();
        if (JSON.stringify(currentIds) === JSON.stringify(requestedIds)) {
          return noopResult(base, event, `Criterion ${criterionId} already confirmed with the same evidence`);
        }
        if (event.type !== "reconfirm_criterion") fail("ILLEGAL_TRANSITION", `criterion ${criterionId} is already confirmed`);
      }
      const criteria = next.criteria.map((criterion, criterionIndex) =>
        criterionIndex === index
          ? { ...criterion, confirmed: true, evidenceIds, confirmedAt: now }
          : criterion
      );
      next = { ...next, criteria };
      effects.push({ type: "CRITERION_CONFIRMED", criterionId, evidenceIds });
      summary = `Confirmed criterion ${criterionId}`;
      break;
    }

    case "request_finalize": {
      assertState(base, event.type, ["RUNNING"]);
      if (!allCriteriaConfirmed(base)) {
        const missing = base.criteria.filter((criterion) => !criterion.confirmed).map((criterion) => criterion.id);
        fail("CRITERIA_UNMET", `cannot finalize; unmet criteria: ${missing.join(", ")}`);
      }
      next = {
        ...next,
        state: "READY_TO_FINALIZE",
        waitCondition: null,
        stopReason: null,
        nextAction: "Complete the goal run",
      };
      effects.push({ type: "FINALIZATION_READY" });
      summary = "All criteria confirmed; ready to finalize";
      break;
    }

    case "complete": {
      assertState(base, event.type, ["READY_TO_FINALIZE"]);
      if (!allCriteriaConfirmed(base)) fail("CRITERIA_UNMET", "cannot complete until every criterion is confirmed");
      releaseLeaseEffect(base, effects);
      next = {
        ...next,
        state: "COMPLETED",
        waitCondition: null,
        lease: null,
        stopReason: null,
        nextAction: null,
        timestamps: { ...next.timestamps, completedAt: now },
      };
      effects.push({ type: "RUN_COMPLETED", runId: base.runId });
      summary = `Completed run ${base.runId}`;
      break;
    }

    case "cancel": {
      assertState(base, event.type, ["RUNNING", "WAITING_TOOL", "WAITING_EXTERNAL_PROCESS", "WAITING_USER", "READY_TO_FINALIZE", "WAITING_CONTROL_PLANE", "NO_PROGRESS_PAUSED", "INTERRUPTED"]);
      const reason = stopReason("CANCEL", event.code, event.message, true, now, base.state);
      releaseLeaseEffect(base, effects);
      next = {
        ...next,
        state: "INTERRUPTED",
        waitCondition: null,
        lease: null,
        stopReason: reason,
        nextAction: null,
      };
      effects.push({ type: "RUN_STOPPED", reason });
      summary = `Cancelled run ${base.runId}: ${reason.message}`;
      break;
    }

    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }

  return transitionResult(base, next, event, now, summary, effects);
}
