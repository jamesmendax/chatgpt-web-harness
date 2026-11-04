import { currentRelayGoal, requireRelayGoal, withRelayGoal, withResolvedRelayGoal, relayGoalPath, relayScopeKey, readRelayStateText, ensureRelayGoalStorage, resolveRelayGoalForTransition, resolveRelayGoalForSession, listRelayGoalIds } from "./relay-scope.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeTextFileCas } from "./safe-text-write.js";
import type { HandoffSnapshot } from "./handoff-store.js";

const RESUME_BUNDLE_SCHEMA_VERSION = 1 as const;
export type ResumeBundleState = "PREPARED" | "COMMITTED" | "ABORTED";

export interface ResumeBundle {
  readonly schema_version: typeof RESUME_BUNDLE_SCHEMA_VERSION;
  readonly bundle_id: string;
  readonly handoff_id: string;
  readonly state: ResumeBundleState;
  readonly goal_id: string;
  readonly goal_run_id: string;
  readonly goal_revision: number;
  readonly goal_run_revision: number;
  readonly execution_contract_hash: string;
  readonly source_worker_id: string | null;
  readonly target_worker_id: string | null;
  readonly source_generation: number | null;
  readonly target_generation: number | null;
  readonly target_session_id: string | null;
  readonly current_phase: string;
  readonly resume_cursor: string | null;
  readonly next_action: string | null;
  readonly confirmed_criteria: readonly string[];
  readonly outstanding_criteria: readonly string[];
  readonly operation_receipt_refs: readonly string[];
  readonly verified_evidence_refs: readonly string[];
  readonly do_not_repeat: readonly string[];
  readonly snapshot_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly bundle_hash: string;
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

export function resumeBundlePath(workspaceRoot: string, handoffId: string, goalId?: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(handoffId)) throw new Error("HANDOFF_ID_INVALID");
  return relayGoalPath(workspaceRoot, path.join("resume-bundles", `${handoffId}.json`), goalId);
}

function hashable(bundle: Omit<ResumeBundle, "bundle_hash">): string {
  return JSON.stringify(bundle);
}

function verify(raw: string, file: string): ResumeBundle {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`RESUME_BUNDLE_UNREADABLE: invalid JSON at ${file}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`RESUME_BUNDLE_UNREADABLE: invalid bundle at ${file}`);
  }
  const bundle = parsed as ResumeBundle;
  if (bundle.schema_version !== RESUME_BUNDLE_SCHEMA_VERSION || !bundle.handoff_id || !bundle.goal_id || !bundle.goal_run_id || !bundle.bundle_hash) {
    throw new Error(`RESUME_BUNDLE_UNREADABLE: malformed bundle at ${file}`);
  }
  const { bundle_hash: stored, ...rest } = bundle;
  if (stored !== sha256(hashable(rest))) throw new Error(`RESUME_BUNDLE_CORRUPT: hash mismatch at ${file}`);
  return Object.freeze(bundle);
}

async function createResumeBundleScoped(
  workspaceRoot: string,
  handoff: HandoffSnapshot,
  run: {
    readonly runId: string;
    readonly revision: number;
    readonly criteria: readonly { readonly id: string; readonly confirmed: boolean }[];
  }
): Promise<ResumeBundle> {
  await ensureRelayGoalStorage(workspaceRoot);
  if (handoff.goal_id !== requireRelayGoal(workspaceRoot) || run.runId !== handoff.goal_id) throw new Error("RESUME_GOAL_SCOPE_MISMATCH");
  const now = new Date().toISOString();
  const base: Omit<ResumeBundle, "bundle_hash"> = {
    schema_version: RESUME_BUNDLE_SCHEMA_VERSION,
    bundle_id: `rb_${handoff.handoff_id}`,
    handoff_id: handoff.handoff_id,
    state: handoff.state,
    goal_id: handoff.goal_id,
    goal_run_id: run.runId,
    goal_revision: handoff.goal_revision,
    goal_run_revision: run.revision,
    execution_contract_hash: handoff.execution_contract_hash,
    source_worker_id: handoff.source_worker_id ?? null,
    target_worker_id: handoff.target_worker_id ?? null,
    source_generation: handoff.source_generation ?? null,
    target_generation: handoff.target_generation ?? null,
    target_session_id: handoff.target_session_id,
    current_phase: handoff.current_phase,
    resume_cursor: handoff.resume_cursor,
    next_action: handoff.next_action,
    confirmed_criteria: run.criteria.filter((item) => item.confirmed).map((item) => item.id),
    outstanding_criteria: run.criteria.filter((item) => !item.confirmed).map((item) => item.id),
    operation_receipt_refs: [...handoff.operation_receipt_refs],
    verified_evidence_refs: [...handoff.verified_evidence_refs],
    do_not_repeat: [...handoff.do_not_repeat],
    snapshot_hash: handoff.snapshot_hash,
    created_at: now,
    updated_at: now,
  };
  const bundle: ResumeBundle = Object.freeze({ ...base, bundle_hash: sha256(hashable(base)) });
  const file = resumeBundlePath(workspaceRoot, handoff.handoff_id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await writeTextFileCas(file, `${JSON.stringify(bundle, null, 2)}\n`, { createOnly: true });
    return bundle;
  } catch (error) {
    if ((error as Error).message.includes("exists") || (error as Error).message.includes("CAS")) {
      const existing = await readResumeBundle(workspaceRoot, handoff.handoff_id);
      if (existing?.snapshot_hash === handoff.snapshot_hash && existing.goal_run_id === run.runId) return existing;
    }
    throw error;
  }
}

async function readResumeBundleScoped(workspaceRoot: string, handoffId: string): Promise<ResumeBundle | null> {
  const file = resumeBundlePath(workspaceRoot, handoffId);
  try {
    const raw = await readRelayStateText(workspaceRoot, path.join("resume-bundles", `${handoffId}.json`));
    if (raw === null) return null;
    const bundle = verify(raw, file);
    if (bundle.goal_id !== requireRelayGoal(workspaceRoot)) throw new Error("RESUME_GOAL_SCOPE_MISMATCH");
    return bundle;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function transitionResumeBundleScoped(
  workspaceRoot: string,
  handoffId: string,
  state: Extract<ResumeBundleState, "COMMITTED" | "ABORTED">,
  targetSessionId?: string
): Promise<ResumeBundle> {
  await ensureRelayGoalStorage(workspaceRoot);
  const file = resumeBundlePath(workspaceRoot, handoffId);
  const raw = await fs.readFile(file, "utf8");
  const current = verify(raw, file);
  requireRelayGoal(workspaceRoot, current.goal_id);
  if (current.state === state) {
    if (state === "COMMITTED" && targetSessionId && current.target_session_id !== targetSessionId) {
      throw new Error("RESUME_BUNDLE_TARGET_CONFLICT: bundle already committed to another session");
    }
    return current;
  }
  if (current.state !== "PREPARED") throw new Error(`RESUME_BUNDLE_STATE_CONFLICT: bundle is ${current.state}`);
  const { bundle_hash: _old, ...rest } = current;
  const base: Omit<ResumeBundle, "bundle_hash"> = {
    ...rest,
    state,
    target_session_id: state === "COMMITTED" && targetSessionId ? targetSessionId : rest.target_session_id,
    updated_at: new Date().toISOString(),
  };
  const next: ResumeBundle = Object.freeze({ ...base, bundle_hash: sha256(hashable(base)) });
  await writeTextFileCas(file, `${JSON.stringify(next, null, 2)}\n`, { expectedSha256: sha256(raw) });
  return next;
}

export function createResumeBundle(...args: Parameters<typeof createResumeBundleScoped>): ReturnType<typeof createResumeBundleScoped> {
  return withResolvedRelayGoal(args[0], args[1].goal_id, () => createResumeBundleScoped(...args));
}

export function readResumeBundle(...args: Parameters<typeof readResumeBundleScoped>): ReturnType<typeof readResumeBundleScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => readResumeBundleScoped(...args));
}

export function transitionResumeBundle(...args: Parameters<typeof transitionResumeBundleScoped>): ReturnType<typeof transitionResumeBundleScoped> {
  return withResolvedRelayGoal(args[0], undefined, () => transitionResumeBundleScoped(...args));
}
