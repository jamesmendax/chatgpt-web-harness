import { currentRelayGoal, requireRelayGoal, withRelayGoal, withResolvedRelayGoal, relayGoalPath, relayScopeKey, readRelayStateText, ensureRelayGoalStorage, resolveRelayGoalForTransition, resolveRelayGoalForSession, listRelayGoalIds } from "./relay-scope.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTextFileCas } from "./safe-text-write.js";

const HANDOFF_SCHEMA_VERSION = 2 as const;
const LEGACY_HANDOFF_SCHEMA_VERSION = 1 as const;

export type HandoffState = "PREPARED" | "COMMITTED" | "ABORTED";

export interface HandoffSnapshotInput {
  readonly goal_id: string;
  readonly goal_revision: number;
  readonly source_session_id: string;
  readonly source_driver_epoch: number;
  readonly source_worker_id?: string | null;
  readonly source_generation?: number | null;
  readonly target_worker_id?: string | null;
  readonly target_generation?: number | null;
  readonly target_session_id?: string | null;
  readonly execution_contract_hash: string;
  readonly current_phase: string;
  readonly resume_cursor?: string | null;
  readonly next_action?: string | null;
  readonly completed?: readonly string[];
  readonly decisions?: readonly string[];
  readonly blockers?: readonly string[];
  readonly pending?: readonly string[];
  readonly changed_files?: readonly string[];
  readonly active_process_refs?: readonly string[];
  readonly completed_process_refs?: readonly string[];
  readonly operation_receipt_refs?: readonly string[];
  readonly pending_delivery_refs?: readonly string[];
  readonly verified_evidence_refs?: readonly string[];
  readonly do_not_repeat?: readonly string[];
}

export interface HandoffSnapshot {
  readonly schema_version: typeof LEGACY_HANDOFF_SCHEMA_VERSION | typeof HANDOFF_SCHEMA_VERSION;
  readonly handoff_id: string;
  readonly state: HandoffState;
  readonly goal_id: string;
  readonly goal_revision: number;
  readonly source_session_id: string;
  readonly source_driver_epoch: number;
  /** Present on v2 snapshots. Absent on legacy v1 files. */
  readonly source_worker_id?: string | null;
  readonly source_generation?: number | null;
  readonly target_worker_id?: string | null;
  readonly target_generation?: number | null;
  /** Null until the standby Chat claims an untargeted prepared handoff. */
  readonly target_session_id: string | null;
  readonly execution_contract_hash: string;
  readonly current_phase: string;
  readonly resume_cursor: string | null;
  readonly next_action: string | null;
  readonly completed: readonly string[];
  readonly decisions: readonly string[];
  readonly blockers: readonly string[];
  readonly pending: readonly string[];
  readonly changed_files: readonly string[];
  readonly active_process_refs: readonly string[];
  readonly completed_process_refs: readonly string[];
  readonly operation_receipt_refs: readonly string[];
  readonly pending_delivery_refs: readonly string[];
  readonly verified_evidence_refs: readonly string[];
  readonly do_not_repeat: readonly string[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly snapshot_hash: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function projectSlug(workspaceRoot: string): string {
  return sha256(path.resolve(workspaceRoot).toLowerCase()).slice(0, 12);
}

function relayRoot(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", projectSlug(workspaceRoot), "relay");
}

export function handoffSnapshotPath(workspaceRoot: string, handoffId: string, goalId?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(handoffId)) throw new Error("HANDOFF_ID_INVALID");
  return relayGoalPath(workspaceRoot, path.join("handoffs", `${handoffId}.json`), goalId);
}

function bounded(values: readonly string[] | undefined, max = 128): string[] {
  if (!values?.length) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, max);
}

function snapshotHashPayload(snapshot: Omit<HandoffSnapshot, "snapshot_hash">): string {
  return JSON.stringify(snapshot);
}

function parseSnapshot(raw: string, file: string): HandoffSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`HANDOFF_STATE_UNREADABLE: invalid JSON at ${file}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`HANDOFF_STATE_UNREADABLE: invalid state at ${file}`);
  }
  const record = value as Record<string, unknown>;
  if (
    ![LEGACY_HANDOFF_SCHEMA_VERSION, HANDOFF_SCHEMA_VERSION].includes(record.schema_version as 1 | 2) ||
    typeof record.handoff_id !== "string" ||
    !["PREPARED", "COMMITTED", "ABORTED"].includes(String(record.state)) ||
    typeof record.goal_id !== "string" ||
    !Number.isInteger(record.goal_revision) ||
    typeof record.source_session_id !== "string" ||
    !Number.isInteger(record.source_driver_epoch) ||
    !(typeof record.target_session_id === "string" || record.target_session_id === null) ||
    typeof record.execution_contract_hash !== "string" ||
    typeof record.snapshot_hash !== "string"
  ) {
    throw new Error(`HANDOFF_STATE_UNREADABLE: unsupported or malformed state at ${file}`);
  }
  if (record.schema_version === HANDOFF_SCHEMA_VERSION && (
    !(record.source_worker_id === null || typeof record.source_worker_id === "string") ||
    !(record.target_worker_id === null || typeof record.target_worker_id === "string") ||
    !(record.source_generation === null || (Number.isInteger(record.source_generation) && Number(record.source_generation) >= 1)) ||
    !(record.target_generation === null || (Number.isInteger(record.target_generation) && Number(record.target_generation) >= 1))
  )) {
    throw new Error(`HANDOFF_STATE_UNREADABLE: malformed worker identity at ${file}`);
  }
  const snapshot = record as unknown as HandoffSnapshot;
  const { snapshot_hash: storedHash, ...hashable } = snapshot;
  const actualHash = sha256(snapshotHashPayload(hashable));
  if (storedHash !== actualHash) {
    throw new Error(`HANDOFF_SNAPSHOT_CORRUPT: hash mismatch at ${file}`);
  }
  return snapshot;
}

async function createHandoffSnapshotScoped(
  workspaceRoot: string,
  input: HandoffSnapshotInput
): Promise<HandoffSnapshot> {
  await ensureRelayGoalStorage(workspaceRoot);
  const now = new Date().toISOString();
  const handoffId = `hf_${randomUUID()}`;
  const base: Omit<HandoffSnapshot, "snapshot_hash"> = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: handoffId,
    state: "PREPARED",
    goal_id: input.goal_id,
    goal_revision: input.goal_revision,
    source_session_id: input.source_session_id,
    source_driver_epoch: input.source_driver_epoch,
    source_worker_id: input.source_worker_id ?? null,
    source_generation: input.source_generation ?? null,
    target_worker_id: input.target_worker_id ?? null,
    target_generation: input.target_generation ?? null,
    target_session_id: input.target_session_id ?? null,
    execution_contract_hash: input.execution_contract_hash,
    current_phase: input.current_phase,
    resume_cursor: input.resume_cursor ?? null,
    next_action: input.next_action ?? null,
    completed: bounded(input.completed, 64),
    decisions: bounded(input.decisions, 64),
    blockers: bounded(input.blockers, 64),
    pending: bounded(input.pending, 64),
    changed_files: bounded(input.changed_files, 256),
    active_process_refs: bounded(input.active_process_refs, 128),
    completed_process_refs: bounded(input.completed_process_refs, 128),
    operation_receipt_refs: bounded(input.operation_receipt_refs, 256),
    pending_delivery_refs: bounded(input.pending_delivery_refs, 256),
    verified_evidence_refs: bounded(input.verified_evidence_refs, 256),
    do_not_repeat: bounded(input.do_not_repeat, 128),
    created_at: now,
    updated_at: now,
  };
  const snapshot: HandoffSnapshot = Object.freeze({
    ...base,
    snapshot_hash: sha256(snapshotHashPayload(base)),
  });
  const file = handoffSnapshotPath(workspaceRoot, handoffId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeTextFileCas(file, `${JSON.stringify(snapshot, null, 2)}\n`, { createOnly: true });
  return snapshot;
}

async function readHandoffSnapshotScoped(
  workspaceRoot: string,
  handoffId: string
): Promise<HandoffSnapshot | null> {
  const file = handoffSnapshotPath(workspaceRoot, handoffId);
  try {
    const raw = await readRelayStateText(workspaceRoot, path.join("handoffs", `${handoffId}.json`));
    if (raw === null) return null;
    const snapshot = parseSnapshot(raw, file);
    if (snapshot.goal_id !== requireRelayGoal(workspaceRoot)) throw new Error("HANDOFF_GOAL_SCOPE_MISMATCH");
    return snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function transitionHandoffSnapshotScoped(
  workspaceRoot: string,
  handoffId: string,
  state: Extract<HandoffState, "COMMITTED" | "ABORTED">,
  options: { targetSessionId?: string } = {}
): Promise<HandoffSnapshot> {
  await ensureRelayGoalStorage(workspaceRoot);
  const file = handoffSnapshotPath(workspaceRoot, handoffId);
  const raw = await fs.readFile(file, "utf8");
  const current = parseSnapshot(raw, file);
  requireRelayGoal(workspaceRoot, current.goal_id);
  if (current.state === state) {
    if (state === "COMMITTED" && options.targetSessionId && current.target_session_id !== options.targetSessionId) {
      throw new Error(`HANDOFF_STATE_CONFLICT: ${handoffId} was committed to another target session`);
    }
    return current;
  }
  if (current.state !== "PREPARED") {
    throw new Error(`HANDOFF_STATE_CONFLICT: ${handoffId} is already ${current.state}`);
  }
  const { snapshot_hash: _oldHash, ...rest } = current;
  const base: Omit<HandoffSnapshot, "snapshot_hash"> = {
    ...rest,
    state,
    target_session_id: state === "COMMITTED" && options.targetSessionId
      ? options.targetSessionId
      : rest.target_session_id,
    updated_at: new Date().toISOString(),
  };
  const next: HandoffSnapshot = Object.freeze({
    ...base,
    snapshot_hash: sha256(snapshotHashPayload(base)),
  });
  await writeTextFileCas(file, `${JSON.stringify(next, null, 2)}\n`, { expectedSha256: sha256(raw) });
  return next;
}
export function createHandoffSnapshot(...args: Parameters<typeof createHandoffSnapshotScoped>): ReturnType<typeof createHandoffSnapshotScoped> {
  return withResolvedRelayGoal(args[0], args[1].goal_id, () => createHandoffSnapshotScoped(...args));
}

export function readHandoffSnapshot(...args: Parameters<typeof readHandoffSnapshotScoped>): ReturnType<typeof readHandoffSnapshotScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => readHandoffSnapshotScoped(...args));
}

export function transitionHandoffSnapshot(...args: Parameters<typeof transitionHandoffSnapshotScoped>): ReturnType<typeof transitionHandoffSnapshotScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => transitionHandoffSnapshotScoped(...args));
}
