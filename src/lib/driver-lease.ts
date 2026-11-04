import { currentRelayGoal, requireRelayGoal, withRelayGoal, withResolvedRelayGoal, relayGoalPath, relayScopeKey, readRelayStateText, ensureRelayGoalStorage, resolveRelayGoalForTransition, resolveRelayGoalForSession, listRelayGoalIds } from "./relay-scope.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTextFileCas } from "./safe-text-write.js";
import {
  createHandoffSnapshot,
  readHandoffSnapshot,
  transitionHandoffSnapshot,
  type HandoffSnapshot,
  type HandoffSnapshotInput,
} from "./handoff-store.js";

const DRIVER_LEASE_SCHEMA_VERSION = 1 as const;
const DEFAULT_DRIVER_LEASE_TTL_MS = 10 * 60 * 1_000;
const DEFAULT_DRIVER_ORPHAN_GRACE_MS = 2 * 60 * 1_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;

export type DriverLeaseState = "ACTIVE" | "HANDOFF_PREPARED" | "DRAINING" | "ORPHANED" | "RELEASED";

export interface DriverLease {
  readonly schema_version: typeof DRIVER_LEASE_SCHEMA_VERSION;
  readonly goal_id: string;
  readonly epoch: number;
  readonly lease_id: string;
  readonly owner_session_id: string;
  readonly state: DriverLeaseState;
  readonly execution_contract_hash: string;
  readonly intent_revision: number;
  readonly acquired_at: string;
  readonly renewed_at: string;
  /** Advisory liveness deadline only. Expiry never transfers authority by itself. */
  readonly expires_at: string;
  readonly prepared_handoff_id: string | null;
  /** Exact predecessor receipt: retries cannot impersonate another transition. */
  readonly authority_transition?: Readonly<{
    kind: "HANDOFF" | "ORPHAN_RECOVERY";
    transition_id: string | null;
    source_epoch: number;
    source_lease_id: string;
    source_session_id: string;
    target_session_id: string;
  }>;
}

export interface DriverMutationAdmission {
  readonly enforced: boolean;
  readonly lease: DriverLease | null;
}

export interface DriverOrphanObservation {
  /** True only when Relay Manager has a concrete Browser Companion lane record. */
  readonly lane_observed: boolean;
  /** Freshness is diagnostic only; a fresh page does not prove the App/tool binding is alive. */
  readonly lane_fresh: boolean;
  readonly generation_active: boolean;
  readonly tool_inflight_count: number;
}

export interface DriverOrphanAssessment {
  readonly eligible: boolean;
  readonly grace_ms: number;
  readonly expired_by_ms: number | null;
  readonly reasons: readonly string[];
}

export type RecoveryAuthorization =
  | Readonly<{ kind: "USER_TAKEOVER"; request_id: string }>
  | Readonly<{ kind: "RELAY_POLICY"; policy_revision: number; goal_id: string; enabled_at: string }>;

export interface PreparedDriverOrphanRecovery {
  readonly lease: DriverLease;
  readonly source_epoch: number;
  readonly source_lease_id: string;
}

interface ReadLease {
  readonly lease: DriverLease;
  readonly sha256: string;
}

const leaseChains = new Map<string, Promise<void>>();
const activeMutationCounts = new Map<string, number>();

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

export function driverLeasePath(workspaceRoot: string, goalId?: string): string {
  return relayGoalPath(workspaceRoot, "driver-lease.json", goalId);
}

export function relayEnabled(): boolean {
  // Retired in 3.0.4. Legacy account config and external environment flags
  // must never reactivate automatic cross-Chat authority transfer.
  return false;
}

function driverLeaseTtlMs(): number {
  const parsed = Number.parseInt(
    process.env.HARNESS_DRIVER_LEASE_TTL_MS || String(DEFAULT_DRIVER_LEASE_TTL_MS),
    10
  );
  return Number.isFinite(parsed) && parsed >= 30_000 ? parsed : DEFAULT_DRIVER_LEASE_TTL_MS;
}

function driverOrphanGraceMs(): number {
  const parsed = Number.parseInt(
    process.env.HARNESS_DRIVER_ORPHAN_GRACE_MS || String(DEFAULT_DRIVER_ORPHAN_GRACE_MS),
    10
  );
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, 30 * 60 * 1_000)
    : DEFAULT_DRIVER_ORPHAN_GRACE_MS;
}

function recoveryAuthorized(
  lease: DriverLease,
  explicitTakeoverAuthorized: boolean,
  authorization?: RecoveryAuthorization
): boolean {
  if (explicitTakeoverAuthorized) return true;
  if (!authorization) return false;
  if (authorization.kind === "USER_TAKEOVER") return Boolean(authorization.request_id.trim());
  return authorization.goal_id === lease.goal_id &&
    Number.isSafeInteger(authorization.policy_revision) && authorization.policy_revision > 0 &&
    Number.isFinite(Date.parse(authorization.enabled_at));
}

function leaseTimes(nowMs = Date.now()): { renewed_at: string; expires_at: string } {
  return {
    renewed_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + driverLeaseTtlMs()).toISOString(),
  };
}

function activeMutationKey(workspaceRoot: string, leaseId: string): string {
  return `${relayScopeKey(workspaceRoot)}::${leaseId}`;
}

async function withLeaseLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = relayScopeKey(workspaceRoot);
  const previous = leaseChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => gate);
  leaseChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    await ensureRelayGoalStorage(workspaceRoot);
    return await operation();
  } finally {
    release();
    if (leaseChains.get(key) === chain) leaseChains.delete(key);
  }
}

function parseLease(raw: string, file: string): DriverLease {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`DRIVER_LEASE_UNREADABLE: invalid JSON at ${file}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`DRIVER_LEASE_UNREADABLE: invalid state at ${file}`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.schema_version !== DRIVER_LEASE_SCHEMA_VERSION ||
    typeof record.goal_id !== "string" ||
    !Number.isInteger(record.epoch) ||
    Number(record.epoch) < 1 ||
    typeof record.lease_id !== "string" ||
    typeof record.owner_session_id !== "string" ||
    !["ACTIVE", "HANDOFF_PREPARED", "DRAINING", "ORPHANED", "RELEASED"].includes(String(record.state)) ||
    typeof record.execution_contract_hash !== "string" ||
    !Number.isInteger(record.intent_revision) ||
    typeof record.acquired_at !== "string" ||
    typeof record.renewed_at !== "string" ||
    typeof record.expires_at !== "string"
  ) {
    throw new Error(`DRIVER_LEASE_UNREADABLE: unsupported or malformed state at ${file}`);
  }
  return record as unknown as DriverLease;
}

async function readLeaseWithHash(workspaceRoot: string): Promise<ReadLease | null> {
  const file = driverLeasePath(workspaceRoot);
  try {
    const raw = await readRelayStateText(workspaceRoot, "driver-lease.json");
    if (raw === null) return null;
    const lease = parseLease(raw, file);
    if (lease.goal_id !== requireRelayGoal(workspaceRoot)) throw new Error("DRIVER_GOAL_SCOPE_MISMATCH");
    return { lease, sha256: sha256(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function persistLease(workspaceRoot: string, lease: DriverLease, current?: ReadLease | null): Promise<void> {
  requireRelayGoal(workspaceRoot, lease.goal_id);
  const file = driverLeasePath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextFileCas(
    file,
    `${JSON.stringify(lease, null, 2)}\n`,
    current ? { expectedSha256: current.sha256 } : { createOnly: true }
  );
}

export async function readDriverLease(workspaceRoot: string, goalId?: string): Promise<DriverLease | null> {
  return withResolvedRelayGoal(workspaceRoot, goalId, async () => (await readLeaseWithHash(workspaceRoot))?.lease ?? null);
}

/**
 * A trusted MCP arrival from the exact active owner is positive liveness
 * evidence. Renew the advisory deadline without changing epoch/lease fencing.
 * Calls from stale sessions and non-ACTIVE states are observational no-ops.
 * Writes are rate-limited until half the TTL remains.
 */
async function renewDriverLeaseForOwnerActivityScoped(
  workspaceRoot: string,
  ownerSessionId: string
): Promise<DriverLease | null> {
  if (!relayEnabled() || !ownerSessionId.trim()) return null;
  return withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    if (!current || current.lease.state !== "ACTIVE" || current.lease.owner_session_id !== ownerSessionId) return null;
    const nowMs = Date.now();
    const expiresMs = Date.parse(current.lease.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs - nowMs > driverLeaseTtlMs() / 2) return current.lease;
    const next: DriverLease = Object.freeze({ ...current.lease, ...leaseTimes(nowMs) });
    await persistLease(workspaceRoot, next, current);
    return next;
  });
}

/**
 * Pure policy check for explicit dead/stale Driver recovery. Lease expiry is
 * intentionally insufficient by itself: the caller must also present explicit
 * takeover authorization, an observed Companion lane, and evidence that no
 * browser generation/tool execution is still in flight.
 *
 * A fresh idle ChatGPT page is allowed. Browser Companion can keep observing a
 * conversation after ChatGPT has disabled that conversation's App/tool binding,
 * so page freshness is not proof that the MCP Worker can still act.
 */
export function assessDriverOrphanRecovery(
  lease: DriverLease,
  input: {
    sourceSessionId: string;
    targetSessionId: string;
    explicitTakeoverAuthorized: boolean;
    authorization?: RecoveryAuthorization;
    observation: DriverOrphanObservation;
    nowMs?: number;
    activeMutationCount?: number;
  }
): DriverOrphanAssessment {
  const reasons: string[] = [];
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = driverOrphanGraceMs();
  const expiresMs = Date.parse(lease.expires_at);
  const expiredByMs = Number.isFinite(expiresMs) ? nowMs - expiresMs : null;

  if (!recoveryAuthorized(lease, input.explicitTakeoverAuthorized, input.authorization)) reasons.push("explicit_takeover_required");
  if (!input.sourceSessionId || lease.owner_session_id !== input.sourceSessionId) reasons.push("source_owner_mismatch");
  if (!input.targetSessionId || input.targetSessionId === input.sourceSessionId) reasons.push("target_session_invalid");
  if (lease.state !== "ACTIVE" && lease.state !== "ORPHANED") reasons.push(`driver_state_${lease.state.toLowerCase()}`);
  if (lease.prepared_handoff_id) reasons.push("prepared_handoff_exists");
  if (expiredByMs === null) reasons.push("lease_expiry_invalid");
  else if (expiredByMs < graceMs) reasons.push("lease_expiry_grace_not_elapsed");
  if (!input.observation.lane_observed) reasons.push("companion_lane_observation_required");
  if (input.observation.generation_active) reasons.push("browser_generation_active");
  if (input.observation.tool_inflight_count > 0) reasons.push("browser_tool_inflight");
  if ((input.activeMutationCount ?? 0) > 0) reasons.push("driver_mutation_inflight");

  return Object.freeze({
    eligible: reasons.length === 0,
    grace_ms: graceMs,
    expired_by_ms: expiredByMs,
    reasons: Object.freeze(reasons),
  });
}

async function prepareDriverOrphanRecoveryScoped(
  workspaceRoot: string,
  input: {
    goalId: string;
    sourceSessionId: string;
    targetSessionId: string;
    explicitTakeoverAuthorized: boolean;
    authorization?: RecoveryAuthorization;
    observation: DriverOrphanObservation;
  }
): Promise<PreparedDriverOrphanRecovery> {
  return withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    if (!current || current.lease.goal_id !== input.goalId) {
      throw new Error("DRIVER_ORPHAN_RECOVERY_MISSING: no matching Driver lease exists for the Goal");
    }
    const lease = current.lease;
    if (lease.owner_session_id !== input.sourceSessionId) {
      throw new Error("DRIVER_ORPHAN_SOURCE_MISMATCH: stale Driver owner changed before recovery");
    }
    if (lease.state === "ORPHANED") {
      if (!recoveryAuthorized(lease, input.explicitTakeoverAuthorized, input.authorization)) {
        throw new Error("DRIVER_ORPHAN_RECOVERY_UNAUTHORIZED: explicit Goal takeover authorization is required");
      }
      return { lease, source_epoch: lease.epoch, source_lease_id: lease.lease_id };
    }

    const assessment = assessDriverOrphanRecovery(lease, {
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      explicitTakeoverAuthorized: input.explicitTakeoverAuthorized,
      authorization: input.authorization,
      observation: input.observation,
      activeMutationCount: activeDriverMutationCount(workspaceRoot, lease.lease_id),
    });
    if (!assessment.eligible) {
      throw new Error(`DRIVER_ORPHAN_RECOVERY_NOT_READY: ${assessment.reasons.join(",")}`);
    }

    const next: DriverLease = Object.freeze({
      ...lease,
      state: "ORPHANED",
      // Preserve renewed_at/expires_at. Refreshing liveness while declaring the
      // old Worker orphaned would make a retry falsely look live again.
      prepared_handoff_id: null,
    });
    await persistLease(workspaceRoot, next, current);
    return { lease: next, source_epoch: next.epoch, source_lease_id: next.lease_id };
  });
}

async function commitDriverOrphanRecoveryScoped(
  workspaceRoot: string,
  input: {
    goalId: string;
    sourceSessionId: string;
    targetSessionId: string;
    sourceEpoch: number;
    sourceLeaseId: string;
    executionContractHash: string;
    intentRevision: number;
  }
): Promise<DriverLease> {
  return withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    if (!current) throw new Error("DRIVER_ORPHAN_RECOVERY_MISSING: Driver lease disappeared before recovery commit");

    if (
      current.lease.goal_id === input.goalId &&
      current.lease.owner_session_id === input.targetSessionId &&
      current.lease.epoch === input.sourceEpoch + 1 &&
      current.lease.state === "ACTIVE"
    ) {
      if (
        current.lease.execution_contract_hash !== input.executionContractHash ||
        current.lease.intent_revision !== input.intentRevision
      ) {
        throw new Error("DRIVER_CONTRACT_MISMATCH: idempotent orphan recovery retry has a different Execution Contract");
      }
      const receipt = current.lease.authority_transition;
      if (!receipt || receipt.kind !== "ORPHAN_RECOVERY" || receipt.source_epoch !== input.sourceEpoch ||
          receipt.source_lease_id !== input.sourceLeaseId || receipt.source_session_id !== input.sourceSessionId ||
          receipt.target_session_id !== input.targetSessionId) {
        throw new Error("DRIVER_ORPHAN_RECOVERY_CONFLICT: exact predecessor receipt is required for a retry");
      }
      return current.lease;
    }

    if (
      current.lease.goal_id !== input.goalId ||
      current.lease.owner_session_id !== input.sourceSessionId ||
      current.lease.epoch !== input.sourceEpoch ||
      current.lease.lease_id !== input.sourceLeaseId ||
      current.lease.state !== "ORPHANED"
    ) {
      throw new Error("DRIVER_ORPHAN_RECOVERY_CONFLICT: Driver fencing token changed before recovery commit");
    }
    if (activeDriverMutationCount(workspaceRoot, current.lease.lease_id) > 0) {
      throw new Error("DRIVER_ORPHAN_RECOVERY_BUSY: stale Driver still has an in-flight mutation");
    }
    if (
      current.lease.execution_contract_hash !== input.executionContractHash ||
      current.lease.intent_revision !== input.intentRevision
    ) {
      throw new Error("DRIVER_CONTRACT_MISMATCH: orphan recovery must preserve the stale Driver Execution Contract");
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const next: DriverLease = Object.freeze({
      ...current.lease,
      epoch: current.lease.epoch + 1,
      lease_id: randomUUID(),
      owner_session_id: input.targetSessionId,
      authority_transition: Object.freeze({ kind: "ORPHAN_RECOVERY", transition_id: null,
        source_epoch: input.sourceEpoch, source_lease_id: input.sourceLeaseId,
        source_session_id: input.sourceSessionId, target_session_id: input.targetSessionId }),
      state: "ACTIVE",
      acquired_at: now,
      ...leaseTimes(nowMs),
      prepared_handoff_id: null,
    });
    await persistLease(workspaceRoot, next, current);
    return next;
  });
}

async function ensureDriverLeaseScoped(
  workspaceRoot: string,
  input: {
    goalId: string;
    ownerSessionId: string;
    executionContractHash: string;
    intentRevision: number;
  }
): Promise<DriverLease> {
  return withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    if (current?.lease.goal_id === input.goalId) {
      if (current.lease.owner_session_id !== input.ownerSessionId) {
        throw new Error(
          `DRIVER_LEASE_LOST: current owner is ${current.lease.owner_session_id.slice(0, 8)}…, caller is ${input.ownerSessionId.slice(0, 8)}…`
        );
      }
      if (current.lease.state === "RELEASED") {
        throw new Error("DRIVER_LEASE_RELEASED: the current Goal driver lease has been released");
      }
      if (current.lease.state === "ORPHANED") {
        throw new Error("DRIVER_NOT_ACTIVE: current driver state is ORPHANED and must finish explicit recovery");
      }
      if (input.intentRevision < current.lease.intent_revision) {
        throw new Error(
          `DRIVER_CONTRACT_STALE: incoming intent revision ${input.intentRevision}, current ${current.lease.intent_revision}`
        );
      }
      const contractChanged = current.lease.execution_contract_hash !== input.executionContractHash;
      const mayAdvanceContract =
        current.lease.execution_contract_hash === "pending" || input.intentRevision > current.lease.intent_revision;
      if (contractChanged && !mayAdvanceContract) {
        throw new Error("DRIVER_CONTRACT_MISMATCH: current Driver is fenced to a different Execution Contract hash");
      }
      const next: DriverLease = Object.freeze({
        ...current.lease,
        execution_contract_hash: input.executionContractHash,
        intent_revision: input.intentRevision,
        ...leaseTimes(),
      });
      await persistLease(workspaceRoot, next, current);
      return next;
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const next: DriverLease = Object.freeze({
      schema_version: DRIVER_LEASE_SCHEMA_VERSION,
      goal_id: input.goalId,
      epoch: 1,
      lease_id: randomUUID(),
      owner_session_id: input.ownerSessionId,
      state: "ACTIVE",
      execution_contract_hash: input.executionContractHash,
      intent_revision: input.intentRevision,
      acquired_at: now,
      ...leaseTimes(nowMs),
      prepared_handoff_id: null,
    });
    await persistLease(workspaceRoot, next, current);
    return next;
  });
}

async function assertDriverMutationAdmissionScoped(
  workspaceRoot: string,
  input: {
    goalId: string;
    goalOwnerSessionId: string;
    callerSessionId?: string;
    executionContractHash: string;
    intentRevision: number;
  }
): Promise<DriverMutationAdmission> {
  if (!relayEnabled()) return { enforced: false, lease: null };
  if (!input.callerSessionId) {
    throw new Error("DRIVER_SESSION_REQUIRED: relay-controlled mutations require a ChatGPT session identity");
  }
  if (input.callerSessionId !== input.goalOwnerSessionId) {
    throw new Error("DRIVER_LEASE_LOST: this ChatGPT session no longer owns the active Goal");
  }
  const lease = await ensureDriverLease(workspaceRoot, {
    goalId: input.goalId,
    ownerSessionId: input.goalOwnerSessionId,
    executionContractHash: input.executionContractHash,
    intentRevision: input.intentRevision,
  });
  if (lease.state !== "ACTIVE") {
    throw new Error(`DRIVER_NOT_ACTIVE: current driver state is ${lease.state}`);
  }
  if (lease.execution_contract_hash !== input.executionContractHash || lease.intent_revision !== input.intentRevision) {
    throw new Error("DRIVER_CONTRACT_MISMATCH: the driver lease belongs to a different Execution Contract revision");
  }
  return { enforced: true, lease };
}

/**
 * Re-check the persisted fencing token at the exact point where a handler is
 * about to enter side-effecting execution. This closes the race where a Turn
 * passed admission immediately before the Relay moved the Driver to DRAINING.
 * The counter is process-local by design; crash uncertainty remains governed
 * by the durable Operation Journal rather than being guessed from this count.
 */
async function enterDriverMutationExecutionScoped(
  workspaceRoot: string,
  expected: DriverLease | null
): Promise<() => void> {
  if (!relayEnabled() || !expected) return () => {};
  return withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    if (
      !current ||
      current.lease.goal_id !== expected.goal_id ||
      current.lease.epoch !== expected.epoch ||
      current.lease.lease_id !== expected.lease_id ||
      current.lease.owner_session_id !== expected.owner_session_id
    ) {
      throw new Error("DRIVER_LEASE_LOST: Driver fencing token changed before mutation execution");
    }
    if (current.lease.state !== "ACTIVE") {
      throw new Error(`DRIVER_NOT_ACTIVE: current driver state is ${current.lease.state}`);
    }
    const key = activeMutationKey(workspaceRoot, current.lease.lease_id);
    activeMutationCounts.set(key, (activeMutationCounts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = Math.max(0, (activeMutationCounts.get(key) ?? 1) - 1);
      if (remaining === 0) activeMutationCounts.delete(key);
      else activeMutationCounts.set(key, remaining);
    };
  });
}

export function activeDriverMutationCount(workspaceRoot: string, leaseId: string): number {
  return activeMutationCounts.get(activeMutationKey(workspaceRoot, leaseId)) ?? 0;
}

async function waitForDriverDrain(workspaceRoot: string, leaseId: string): Promise<void> {
  const parsed = Number.parseInt(
    process.env.HARNESS_DRIVER_DRAIN_TIMEOUT_MS || String(DEFAULT_DRAIN_TIMEOUT_MS),
    10
  );
  const timeoutMs = Number.isFinite(parsed) && parsed >= 250 ? parsed : DEFAULT_DRAIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (activeDriverMutationCount(workspaceRoot, leaseId) > 0) {
    if (Date.now() >= deadline) {
      throw new Error(
        `DRIVER_DRAIN_TIMEOUT: ${activeDriverMutationCount(workspaceRoot, leaseId)} mutation(s) still in flight`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function prepareDriverHandoffScoped(
  workspaceRoot: string,
  input: {
    goalId: string;
    sourceSessionId: string;
    targetSessionId?: string | null;
    executionContractHash: string;
    intentRevision: number;
    snapshot: Omit<HandoffSnapshotInput, "goal_id" | "source_session_id" | "source_driver_epoch" | "target_session_id" | "execution_contract_hash">;
  }
): Promise<{ lease: DriverLease; snapshot: HandoffSnapshot }> {
  const draining = await withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    let lease = current?.lease;
    if (!lease || lease.goal_id !== input.goalId) {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      lease = {
        schema_version: DRIVER_LEASE_SCHEMA_VERSION,
        goal_id: input.goalId,
        epoch: 1,
        lease_id: randomUUID(),
        owner_session_id: input.sourceSessionId,
        state: "ACTIVE",
        execution_contract_hash: input.executionContractHash,
        intent_revision: input.intentRevision,
        acquired_at: now,
        ...leaseTimes(nowMs),
        prepared_handoff_id: null,
      };
      await persistLease(workspaceRoot, lease, current);
      const created = await readLeaseWithHash(workspaceRoot);
      if (!created) throw new Error("DRIVER_LEASE_MISSING: newly created Driver lease was not readable");
      lease = created.lease;
    }
    if (lease.owner_session_id !== input.sourceSessionId) {
      throw new Error("DRIVER_LEASE_LOST: handoff source is not the current driver");
    }
    if (lease.state !== "ACTIVE") {
      throw new Error(`DRIVER_HANDOFF_CONFLICT: cannot prepare from state ${lease.state}`);
    }
    if (
      lease.execution_contract_hash !== input.executionContractHash ||
      lease.intent_revision !== input.intentRevision
    ) {
      throw new Error("DRIVER_CONTRACT_MISMATCH: handoff must use the current Driver Execution Contract");
    }
    const latest = await readLeaseWithHash(workspaceRoot);
    if (!latest) throw new Error("DRIVER_LEASE_MISSING: cannot enter draining state");
    const next: DriverLease = Object.freeze({
      ...latest.lease,
      state: "DRAINING",
      ...leaseTimes(),
    });
    await persistLease(workspaceRoot, next, latest);
    return next;
  });

  let snapshot: HandoffSnapshot | null = null;
  try {
    await waitForDriverDrain(workspaceRoot, draining.lease_id);
    snapshot = await createHandoffSnapshot(workspaceRoot, {
      ...input.snapshot,
      goal_id: input.goalId,
      source_session_id: input.sourceSessionId,
      source_driver_epoch: draining.epoch,
      target_session_id: input.targetSessionId ?? null,
      execution_contract_hash: input.executionContractHash,
    });
    const prepared = await withLeaseLock(workspaceRoot, async () => {
      const reread = await readLeaseWithHash(workspaceRoot);
      if (
        !reread ||
        reread.lease.goal_id !== input.goalId ||
        reread.lease.epoch !== draining.epoch ||
        reread.lease.lease_id !== draining.lease_id ||
        reread.lease.state !== "DRAINING"
      ) {
        throw new Error("DRIVER_HANDOFF_CONFLICT: Driver changed while handoff snapshot was being prepared");
      }
      const next: DriverLease = Object.freeze({
        ...reread.lease,
        state: "HANDOFF_PREPARED",
        ...leaseTimes(),
        prepared_handoff_id: snapshot!.handoff_id,
      });
      await persistLease(workspaceRoot, next, reread);
      return next;
    });
    return { lease: prepared, snapshot };
  } catch (error) {
    if (snapshot) {
      await transitionHandoffSnapshot(workspaceRoot, snapshot.handoff_id, "ABORTED").catch(() => {});
    }
    await withLeaseLock(workspaceRoot, async () => {
      const current = await readLeaseWithHash(workspaceRoot);
      if (
        current &&
        current.lease.goal_id === draining.goal_id &&
        current.lease.epoch === draining.epoch &&
        current.lease.lease_id === draining.lease_id &&
        current.lease.state === "DRAINING"
      ) {
        const restored: DriverLease = Object.freeze({
          ...current.lease,
          state: "ACTIVE",
          ...leaseTimes(),
          prepared_handoff_id: null,
        });
        await persistLease(workspaceRoot, restored, current);
      }
    }).catch(() => {});
    throw error;
  }
}

async function commitDriverHandoffScoped(
  workspaceRoot: string,
  handoffId: string,
  targetSessionId: string
): Promise<DriverLease> {
  return withLeaseLock(workspaceRoot, async () => {
    const snapshot = await readHandoffSnapshot(workspaceRoot, handoffId);
    if (!snapshot) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
    if (snapshot.source_session_id === targetSessionId) {
      throw new Error("DRIVER_HANDOFF_SOURCE_RECLAIM: source Driver cannot claim its own prepared handoff");
    }
    if (snapshot.target_session_id && snapshot.target_session_id !== targetSessionId) {
      throw new Error("DRIVER_HANDOFF_TARGET_MISMATCH: handoff belongs to a different target session");
    }
    const current = await readLeaseWithHash(workspaceRoot);
    if (!current) throw new Error("DRIVER_LEASE_MISSING: cannot commit handoff without a lease");
    if (
      current.lease.goal_id === snapshot.goal_id &&
      current.lease.owner_session_id === targetSessionId &&
      current.lease.epoch === snapshot.source_driver_epoch + 1 &&
      current.lease.state === "ACTIVE"
    ) {
      const receipt = current.lease.authority_transition;
      if (current.lease.execution_contract_hash !== snapshot.execution_contract_hash ||
          (receipt ? receipt.kind !== "HANDOFF" || receipt.transition_id !== handoffId ||
            receipt.source_epoch !== snapshot.source_driver_epoch || receipt.source_session_id !== snapshot.source_session_id ||
            receipt.target_session_id !== targetSessionId : snapshot.state !== "COMMITTED")) {
        throw new Error("DRIVER_HANDOFF_CONFLICT: exact committed transition receipt is required for a retry");
      }
      if (snapshot.state === "PREPARED") {
        await transitionHandoffSnapshot(workspaceRoot, handoffId, "COMMITTED", { targetSessionId });
      } else if (snapshot.state !== "COMMITTED") {
        throw new Error(`DRIVER_HANDOFF_CONFLICT: snapshot is ${snapshot.state}`);
      }
      return current.lease;
    }
    if (snapshot.state !== "PREPARED") {
      throw new Error(`DRIVER_HANDOFF_CONFLICT: snapshot is already ${snapshot.state}`);
    }
    if (current.lease.prepared_handoff_id !== handoffId || current.lease.state !== "HANDOFF_PREPARED") {
      throw new Error("DRIVER_HANDOFF_CONFLICT: prepared handoff no longer matches current lease");
    }
    if (
      current.lease.goal_id !== snapshot.goal_id ||
      current.lease.owner_session_id !== snapshot.source_session_id ||
      current.lease.epoch !== snapshot.source_driver_epoch ||
      current.lease.execution_contract_hash !== snapshot.execution_contract_hash
    ) {
      throw new Error("DRIVER_HANDOFF_CONFLICT: snapshot identity does not match current Driver lease");
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const next: DriverLease = Object.freeze({
      ...current.lease,
      epoch: current.lease.epoch + 1,
      lease_id: randomUUID(),
      owner_session_id: targetSessionId,
      authority_transition: Object.freeze({ kind: "HANDOFF", transition_id: handoffId,
        source_epoch: current.lease.epoch, source_lease_id: current.lease.lease_id,
        source_session_id: snapshot.source_session_id, target_session_id: targetSessionId }),
      state: "ACTIVE",
      acquired_at: now,
      ...leaseTimes(nowMs),
      prepared_handoff_id: null,
    });
    await persistLease(workspaceRoot, next, current);
    await transitionHandoffSnapshot(workspaceRoot, handoffId, "COMMITTED", { targetSessionId });
    return next;
  });
}

async function abortDriverHandoffScoped(workspaceRoot: string, handoffId: string): Promise<DriverLease> {
  return withLeaseLock(workspaceRoot, async () => {
    const snapshot = await readHandoffSnapshot(workspaceRoot, handoffId);
    if (!snapshot) throw new Error(`HANDOFF_NOT_FOUND: ${handoffId}`);
    const current = await readLeaseWithHash(workspaceRoot);
    if (!current) throw new Error("DRIVER_LEASE_MISSING: cannot abort handoff without a lease");
    if (
      snapshot.state === "ABORTED" &&
      current.lease.goal_id === snapshot.goal_id &&
      current.lease.owner_session_id === snapshot.source_session_id &&
      current.lease.epoch === snapshot.source_driver_epoch &&
      current.lease.state === "ACTIVE"
    ) {
      return current.lease;
    }
    if (snapshot.state !== "PREPARED") {
      throw new Error(`DRIVER_HANDOFF_CONFLICT: snapshot is already ${snapshot.state}`);
    }
    if (current.lease.prepared_handoff_id !== handoffId || current.lease.state !== "HANDOFF_PREPARED") {
      throw new Error("DRIVER_HANDOFF_CONFLICT: prepared handoff no longer matches current lease");
    }
    const next: DriverLease = Object.freeze({
      ...current.lease,
      state: "ACTIVE",
      ...leaseTimes(),
      prepared_handoff_id: null,
    });
    await persistLease(workspaceRoot, next, current);
    await transitionHandoffSnapshot(workspaceRoot, handoffId, "ABORTED");
    return next;
  });
}

async function releaseDriverLeaseScoped(workspaceRoot: string, goalId: string): Promise<DriverLease | null> {
  if (!relayEnabled()) return null;
  return withLeaseLock(workspaceRoot, async () => {
    const current = await readLeaseWithHash(workspaceRoot);
    if (!current || current.lease.goal_id !== goalId) return current?.lease ?? null;
    if (current.lease.state === "RELEASED") return current.lease;
    const next: DriverLease = Object.freeze({
      ...current.lease,
      state: "RELEASED",
      ...leaseTimes(),
      prepared_handoff_id: null,
    });
    await persistLease(workspaceRoot, next, current);
    return next;
  });
}

export function prepareDriverOrphanRecovery(...args: Parameters<typeof prepareDriverOrphanRecoveryScoped>): ReturnType<typeof prepareDriverOrphanRecoveryScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => prepareDriverOrphanRecoveryScoped(...args));
}

export function commitDriverOrphanRecovery(...args: Parameters<typeof commitDriverOrphanRecoveryScoped>): ReturnType<typeof commitDriverOrphanRecoveryScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => commitDriverOrphanRecoveryScoped(...args));
}

export function ensureDriverLease(...args: Parameters<typeof ensureDriverLeaseScoped>): ReturnType<typeof ensureDriverLeaseScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => ensureDriverLeaseScoped(...args));
}

export function assertDriverMutationAdmission(...args: Parameters<typeof assertDriverMutationAdmissionScoped>): ReturnType<typeof assertDriverMutationAdmissionScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => assertDriverMutationAdmissionScoped(...args));
}

export function enterDriverMutationExecution(...args: Parameters<typeof enterDriverMutationExecutionScoped>): ReturnType<typeof enterDriverMutationExecutionScoped> {
  if (!relayEnabled() || !args[1]) return Promise.resolve(() => {});
  return withResolvedRelayGoal(args[0], args[1]?.goal_id, () => enterDriverMutationExecutionScoped(...args));
}

export function prepareDriverHandoff(...args: Parameters<typeof prepareDriverHandoffScoped>): ReturnType<typeof prepareDriverHandoffScoped> {
  return withResolvedRelayGoal(args[0], args[1].goalId, () => prepareDriverHandoffScoped(...args));
}

export function commitDriverHandoff(...args: Parameters<typeof commitDriverHandoffScoped>): ReturnType<typeof commitDriverHandoffScoped> {
  return (async () => { const goalId = currentRelayGoal(args[0]) ?? await resolveRelayGoalForTransition(args[0], args[1]); if (!goalId) throw new Error("HANDOFF_NOT_FOUND: " + args[1]); return withResolvedRelayGoal(args[0], goalId, () => commitDriverHandoffScoped(...args)); })();
}

export function abortDriverHandoff(...args: Parameters<typeof abortDriverHandoffScoped>): ReturnType<typeof abortDriverHandoffScoped> {
  return (async () => { const goalId = currentRelayGoal(args[0]) ?? await resolveRelayGoalForTransition(args[0], args[1]); if (!goalId) throw new Error("HANDOFF_NOT_FOUND: " + args[1]); return withResolvedRelayGoal(args[0], goalId, () => abortDriverHandoffScoped(...args)); })();
}

export function releaseDriverLease(...args: Parameters<typeof releaseDriverLeaseScoped>): ReturnType<typeof releaseDriverLeaseScoped> {
  return withResolvedRelayGoal(args[0], args[1], () => releaseDriverLeaseScoped(...args));
}

export async function renewDriverLeaseForOwnerActivity(workspaceRoot: string, ownerSessionId: string, goalId?: string): Promise<DriverLease | null> {
  if (!relayEnabled() || !ownerSessionId.trim()) return null;
  const selected = goalId ?? currentRelayGoal(workspaceRoot) ?? await resolveRelayGoalForSession(workspaceRoot, ownerSessionId);
  return selected ? withRelayGoal(workspaceRoot, selected, () => renewDriverLeaseForOwnerActivityScoped(workspaceRoot, ownerSessionId)) : null;
}
