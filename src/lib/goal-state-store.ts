/**
 * Durable Goal state and session authority.
 *
 * This layer owns the single Goal lock and creation context together with JSON
 * state, compatibility projections and validation. It must not import the
 * GoalRun store, Task/Relay orchestration, or the public goals.ts facade.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { appendHarnessEventSafe } from "./harness-events.js";
import { appendAutoMemory } from "./auto-memory.js";
import { inferProjectScope } from "./project-scope.js";
import { notifyStateInvalidated } from "./state-invalidate.js";
import { getRuntimeScope } from "./runtime-scope.js";
import { accountProjectDir } from "./account-project-scope.js";
import { requireVerifiedHostUserConfirmation } from "./host-user-confirmation.js";
import { normalizeGoalVerification, type GoalVerification } from "./goal-verification.js";
import { withCanonicalFileLock } from "./safe-text-write.js";
export type GoalStatus = "active" | "paused" | "completed" | "cancelled";

/** A1.1 additive intent provenance. This is not the same as Goal ownership. */
export type GoalIntentOrigin = "user" | "assistant_proposed" | "system_maintained" | "unknown";
export interface GoalIntentProvenance {
  origin: GoalIntentOrigin;
  source_turn_ref: string | null;
  verification: "unverified" | "host_verified";
}

/**
 * The present MCP transport does not expose an authenticated Host user-turn
 * receipt. A legacy goal file, tool arguments and summary text are NOT an
 * authority for "user"/"host_verified", even when those strings are stored.
 * Future Host integration must validate its receipt OUTSIDE this JSON store
 * before replacing this conservative read normalization.
 */
export function unknownGoalIntentProvenance(_claim?: unknown): GoalIntentProvenance {
  return { origin: "unknown", source_turn_ref: null, verification: "unverified" };
}

export interface GoalCriterion {
  name: string;
  passed: boolean;
  detail?: string;
  requires_confirmation?: boolean;
  verification?: GoalVerification;
}

export interface DurableGoal {
  version: 1;
  id: string;
  revision: number;
  objective: string;
  success_criteria: GoalCriterion[];
  constraints: string[];
  status: GoalStatus;
  current_phase: string;
  owner_session?: string;
  /** Additive V1 field; old files remain valid and read as origin=unknown. */
  intent_provenance?: GoalIntentProvenance;
  previous_owner_session?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

/**
 * Material Goal definition fingerprint for a Task's acceptance scope.
 * Deliberately excludes phase, revision, passed flags, verification and
 * criterion.detail: GoalRun may project an evidence summary into detail when
 * it was previously absent (goal-run-store.ts). Those are progress, not
 * necessarily a new user requirement. A changed objective, named criterion,
 * confirmation requirement or constraint is substantive.
 */
export function goalDefinitionFingerprint(
  goal: Pick<DurableGoal, "objective" | "success_criteria" | "constraints">
): string {
  return createHash("sha256").update(JSON.stringify({
    objective: goal.objective,
    success_criteria: goal.success_criteria.map((criterion) => ({
      name: criterion.name,
      requires_confirmation: criterion.requires_confirmation === true,
    })),
    constraints: goal.constraints,
  })).digest("hex");
}

/**
 * Coordinate a material Goal edit and Task completion across Node processes.
 * Both sides acquire this durable per-Goal-owner lock before their in-process
 * store locks, then re-read persisted state while holding it. The key follows
 * the current session's Goal shard; legacy session-less callers use the
 * workspace-global shard. This is coordination, NOT user authorization.
 * All cooperating writers must use this gate; older installed runtimes do not.
 */
export function withGoalTaskDefinitionFence<T>(workspaceRoot: string, action: () => Promise<T>): Promise<T> {
  return withGoalTaskDefinitionFences(workspaceRoot, [currentSessionId()], action);
}

/**
 * A cross-session Goal bind moves ownership between *two* Goal shards.
 * Take both exact single-session fence keys in stable lexical order before
 * entering any Task workspace or Goal process-local locks. A reverse bind
 * takes the same order, preventing AB/BA deadlocks across Node processes.
 * The optional undefined entry represents the old session-less Goal shard.
 */
export function withGoalTaskDefinitionFences<T>(
  workspaceRoot: string,
  sessions: ReadonlyArray<string | undefined>,
  action: () => Promise<T>
): Promise<T> {
  const lockTargets = Array.from(new Set(sessions.map((session) =>
    path.join(goalShardDir(workspaceRoot, sessionSegment(session)), "goal-task-definition-v1")
  ))).sort();
  const lockNext = (index: number): Promise<T> => index >= lockTargets.length
    ? action()
    : withCanonicalFileLock(lockTargets[index]!, () => lockNext(index + 1));
  return lockNext(0);
}

export const GOAL_GROUNDING_NOTE =
  "Grounding: report only what tool results and verified evidence actually establish; mark anything unverified as unverified.";

export const GOAL_WATCHDOG_POLICY =
  "The Goal watchdog provides goal-scoped fallback alerts and does not auto-resume ChatGPT Web.";

export const GOAL_VISIBLE_PROGRESS_HEARTBEAT =
  "Visible progress messages record updates for the user.";

export const GOAL_CONTINUATION_CONTRACT =
  "Goal and Task status are work records. Report the completion basis and distinguish model declarations from checks supported by evidence. An unverified criterion remains unverified; a launch acknowledgment does not establish completion.";

export const GOAL_CONTINUATION_SNAPSHOT =
  "Goal and Task status record progress and model declarations. Preserve unverified criteria and report the evidence actually available.";

export type GoalMutationOptions = { expectedRevision?: number; expectedGoalId?: string; sourceSessionId?: string };

function assertExpectedRevision(goal: DurableGoal, opts?: GoalMutationOptions): void {
  if (opts?.expectedRevision === undefined) return;
  if (opts.expectedRevision !== goal.revision) {
    throw new Error(
      `GOAL_STALE_REVISION: goal revision is ${goal.revision}, but ${opts.expectedRevision} was supplied. Re-read the goal (action=status) and retry with the current revision.`
    );
  }
}

// Goal mutations are read-modify-write on a single file; serialize them per
// workspace so concurrent MCP calls cannot lose updates. No nesting: public
// wrappers take the lock, setGoalStatus (private) assumes it is held.
const goalChains = new Map<string, Promise<void>>();

function goalWorkspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

async function withGoalLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = goalWorkspaceKey(workspaceRoot);
  const previous = goalChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => gate);
  goalChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (goalChains.get(key) === chain) goalChains.delete(key);
  }
}

export interface GoalSummary {
  goal_id: string;
  objective: string;
  status: GoalStatus;
  current_phase: string;
  criteria_passed: number;
  criteria_total: number;
  remaining_criteria: string[];
  constraints: string[];
  owner_session?: string;
  intent_provenance: GoalIntentProvenance;
  continuation_contract: string;
  watchdog_policy: {
    mode: "goal_scoped";
    lifecycle: "managed_by_goal";
    role: "fallback_alert_only";
    manual_control: "operator_only";
    auto_resume_web: false;
  };
  updated_at: string;
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

// Session isolation: when a session id is present, the goal lives in a
// per-session shard so concurrent ChatGPT windows never supersede each other.
// The workspace-global goal.json remains the compatibility/discovery
// projection for session-less clients and cross-turn continuation.
function goalShardDir(workspaceRoot: string, sessionId?: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const projectDir = accountProjectDir(path.join(base, "projects", projectSlug(workspaceRoot)));
  return sessionId ? path.join(projectDir, "sessions", sessionId) : projectDir;
}

function goalPath(workspaceRoot: string, sessionId?: string): string {
  return path.join(goalShardDir(workspaceRoot, sessionId), "goal.json");
}

// Sanitize a session id for safe use as a single path segment.
function sessionSegment(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || undefined;

}

/**
 * Persist a goal to its authoritative location plus the global projection.
 * A goal owned by a session lives in that session's shard; the workspace-global
 * goal.json is also refreshed so session-less clients and cross-turn
 * continuation keep working. Unbound (legacy) goals only write the global path.
 */
async function writeGoalState(workspaceRoot: string, goal: DurableGoal): Promise<void> {
  const shard = sessionSegment(goal.owner_session);
  if (shard) {
    await atomicWriteJson(goalPath(workspaceRoot, shard), goal);
  }
  await atomicWriteJson(goalPath(workspaceRoot), goal);
}

function cleanString(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, max);
}

// Punctuation/case-insensitive criterion identity: prevents variant names
// ("User sign-off.") from being minted as fresh criteria to bypass the
// requires_confirmation gate.
function criterionKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function normalizeCriteria(input: unknown, existing: GoalCriterion[] = []): GoalCriterion[] {
  if (!Array.isArray(input)) return existing;
  const next = [...existing];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const name = cleanString(item.name, 300);
    if (!name) continue;
    const previous = next.find((criterion) => criterionKey(criterion.name) === criterionKey(name));
    const criterion: GoalCriterion = {
      name,
      passed: typeof item.passed === "boolean" ? item.passed : previous?.passed ?? false,
      ...(item.verification !== undefined || previous?.verification
        ? { verification: normalizeGoalVerification(item.verification ?? previous?.verification) } : {}),
      ...(item.requires_confirmation === true || previous?.requires_confirmation
        ? { requires_confirmation: true }
        : {}),
      ...(cleanString(item.detail, 2000)
        ? { detail: cleanString(item.detail, 2000)! }
        : previous?.detail
          ? { detail: previous.detail }
          : {}),
    };
    const index = next.findIndex((candidate) => criterionKey(candidate.name) === criterionKey(name));
    if (index >= 0) next[index] = criterion;
    else next.push(criterion);
  }
  return next.slice(0, 40);
}

function normalizeConstraints(input: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(input)) return fallback;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const value = cleanString(raw, 1000);
    if (!value || seen.has(value.toLowerCase())) continue;
    values.push(value);
    seen.add(value.toLowerCase());
  }
  return values.slice(0, 24);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(temp, filePath);
}

async function recordGoalChange(workspaceRoot: string, operation: string, goal: DurableGoal): Promise<void> {
  const scope = await inferProjectScope(workspaceRoot, [goal.objective, goal.current_phase, ...goal.constraints]);
  await appendHarnessEventSafe(workspaceRoot, {
    type: "goal/change",
    project_roots: scope.roots,
    goal_id: goal.id,
    data: { operation, goal },
  });
}

function normalizeGoal(raw: DurableGoal): DurableGoal {
  return {
    version: 1,
    id: raw.id,
    revision: Number.isInteger(raw.revision) && raw.revision > 0 ? raw.revision : 1,
    objective: cleanString(raw.objective, 4000) || raw.objective,
    success_criteria: normalizeCriteria(raw.success_criteria),
    constraints: normalizeConstraints(raw.constraints),
    status: raw.status,
    current_phase: cleanString(raw.current_phase, 2000) || "Work toward the goal",
    ...(raw.owner_session ? { owner_session: raw.owner_session } : {}),
    // Never promote a JSON-claimed Host/user source without trusted evidence.
    intent_provenance: unknownGoalIntentProvenance(raw.intent_provenance),
    ...(raw.previous_owner_session ? { previous_owner_session: raw.previous_owner_session } : {}),
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    ...(raw.completed_at ? { completed_at: raw.completed_at } : {}),
  };
}

/**
 * Session scoping: a goal created inside one ChatGPT conversation belongs to
 * that conversation's MCP session. Signals and gates only apply to the owning
 * session; other windows sharing this workspace are completely unaffected.
 * A goal without owner_session (legacy/unbound, e.g. created outside a
 * transport session) keeps the historical workspace-wide behavior.
 */
export function goalVisibleToSession(goal: DurableGoal, sessionId?: string): boolean {
  return !goal.owner_session || goal.owner_session === sessionId;
}

function currentSessionId(): string | undefined {
  return getRuntimeScope()?.mcpSessionId;
}

export function assertGoalAccessibleBySession(goal: DurableGoal, sessionId?: string): void {
  if (goal.owner_session && goal.owner_session !== sessionId) {
    throw new Error(
      `This goal belongs to a different ChatGPT window (session ${goal.owner_session.slice(0, 8)}…). ` +
      `Manage it from that window, or call goal(action=bind) in this window to adopt it.`
    );
  }
}

export interface GoalTakeoverCandidate {
  goal_id: string;
  status: GoalStatus;
  revision: number;
  owner_session_hint: string | null;
}

export async function getGoalTakeoverCandidate(
  workspaceRoot: string,
  targetSession?: string
): Promise<GoalTakeoverCandidate | null> {
  const global = await getGoalBindSource(workspaceRoot);
  if (
    !global ||
    !global.owner_session ||
    global.owner_session === targetSession ||
    (global.status !== "active" && global.status !== "paused")
  ) {
    return null;
  }
  return {
    goal_id: global.id,
    status: global.status,
    revision: global.revision,
    owner_session_hint: `${global.owner_session.slice(0, 8)}…`,
  };
}

export function goalTakeoverToken(
  workspaceRoot: string,
  candidate: GoalTakeoverCandidate,
  targetSession: string
): string {
  return createHash("sha256")
    .update(
      [
        path.resolve(workspaceRoot),
        candidate.goal_id,
        String(candidate.revision),
        candidate.owner_session_hint ?? "",
        targetSession,
        "goal-takeover-v1",
      ].join("\0")
    )
    .digest("hex")
    .slice(0, 32);
}

export async function getGoalOwnerSession(workspaceRoot: string): Promise<string | undefined> {
  const global = await getGoalBindSource(workspaceRoot);
  return global?.owner_session;
}

/** Global state discovers a source; its owning session shard supplies truth. */
export async function getGoalBindSource(workspaceRoot: string): Promise<DurableGoal | null> {
  const projected = await readGoalFile(goalPath(workspaceRoot));
  if (!projected?.owner_session) return projected;
  const authoritative = await getGoal(workspaceRoot, projected.owner_session);
  if (!authoritative || authoritative.id !== projected.id) {
    throw new Error("GOAL_DISCOVERY_STALE: workspace projection no longer identifies its owner's Goal; refresh discovery.");
  }
  return authoritative;
}

export function resolveGoalForSession(workspaceRoot: string, sessionId?: string): Promise<DurableGoal | null> {
  return getGoal(workspaceRoot, sessionId).then((goal) => (goal && goalVisibleToSession(goal, sessionId) ? goal : null));
}

async function readGoalFile(filePath: string): Promise<DurableGoal | null> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`GOAL_STATE_UNREADABLE: cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const raw = JSON.parse(rawText) as DurableGoal;
    return normalizeGoal(raw);
  } catch (error) {
    throw new Error(`GOAL_STATE_UNREADABLE: invalid goal state in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Resolve the active goal for the current runtime session.
 * Reads the per-session shard first (session isolation); falls back to the
 * workspace-global compatibility projection for session-less clients and
 * cross-turn continuation. Pass an explicit sessionId to read a specific
 * shard; omit to use the current runtime scope.
 */
export async function getGoal(workspaceRoot: string, sessionId?: string): Promise<DurableGoal | null> {
  const ownerSession = sessionId ?? currentSessionId();
  await assertGoalCreationIdle(workspaceRoot, ownerSession);
  const effective = sessionSegment(ownerSession);
  if (effective) {
    // Session shard is authoritative for this window.
    const sharded = await readGoalFile(goalPath(workspaceRoot, effective));
    if (sharded) {
      if (sharded.owner_session && sharded.owner_session !== ownerSession) {
        // A completed bind may leave a fenced source tombstone when removal
        // fails. It must never restore authority to the previous owner.
        return null;
      }
      return sharded;
    }
    // Fall back to the global projection ONLY when it is visible to this
    // session (unbound legacy goal, or one this window owns). A global goal
    // owned by a different window must never leak into this window's context.
    const global = await readGoalFile(goalPath(workspaceRoot));
    if (global && goalVisibleToSession(global, ownerSession)) return global;
    return null;
  }
  return readGoalFile(goalPath(workspaceRoot));
}

/**
 * Read the workspace-global compatibility projection without applying the
 * current session visibility filter. This is discovery/compatibility state;
 * mutation authority must come from the explicitly identified session shard.
 * Model-facing reads should continue to use getGoal()/goal(status).
 */
export async function getWorkspaceGoalProjection(workspaceRoot: string): Promise<DurableGoal | null> {
  return readGoalFile(goalPath(workspaceRoot));
}

/**
 * Compatibility projection writer used only after GoalRun has committed an
 * authoritative transition. It never invents a new revision itself.
 */
export async function writeGoalRunProjection(
  workspaceRoot: string,
  projection: DurableGoal,
  options: { expectedCurrentRevision: number; operation?: string }
): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const current = await getGoal(workspaceRoot);
    if (!current) throw new Error("No legacy goal projection exists for this workspace.");
    assertGoalAccessibleBySession(current, currentSessionId());
    if (current.id !== projection.id) {
      throw new Error(
        `GOAL_RUN_PROJECTION_MISMATCH: current goal is ${current.id}, projection is ${projection.id}.`
      );
    }
    if (current.revision !== options.expectedCurrentRevision) {
      throw new Error(
        `GOAL_STALE_REVISION: goal revision is ${current.revision}, but ${options.expectedCurrentRevision} was expected. Re-read the goal and retry.`
      );
    }
    if (!Number.isInteger(projection.revision) || projection.revision <= current.revision) {
      throw new Error(
        `GOAL_RUN_PROJECTION_REVISION: projection revision ${projection.revision} must be newer than ${current.revision}.`
      );
    }
    // Keep unknown top-level compatibility fields. Older/newer readers may
    // attach metadata that this version does not understand; projection
    // normalization must not erase it during an authoritative GoalRun commit.
    const next = {
      ...(projection as unknown as Record<string, unknown>),
      ...normalizeGoal(projection),
    } as DurableGoal;
    await writeGoalState(workspaceRoot, next);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, options.operation ?? "goal-run-projection", next);
    if (next.status === "completed" && current.status !== "completed") {
      try {
        const summary = goalSummary(next);
        await appendAutoMemory(
          workspaceRoot,
          `Goal completed (${summary.criteria_passed}/${summary.criteria_total} criteria): ${summary.objective.slice(0, 200)}`
        );
      } catch {}
    }
    return next;
  });
}

export type GoalCreationPhase = "prepared" | "archived" | "relay_fenced" | "task_cancelled" | "goal_published" | "run_published" | "committed";
export interface GoalCreationJournal {
  version: 1;
  transaction_id: string;
  owner_session?: string;
  input_fingerprint: string;
  phase: GoalCreationPhase;
  previous_goal: DurableGoal | null;
  previous_run: { runId: string; runRevision: number; envelopeRevision: number } | null;
  previous_task_id: string | null;
  new_goal: DurableGoal;
}
const goalCreationContext = new AsyncLocalStorage<string>();

function creationKey(workspaceRoot: string, sessionId?: string): string {
  return goalWorkspaceKey(workspaceRoot) + "::" + (sessionId ?? "legacy");
}

export function goalCreationJournalPath(workspaceRoot: string, sessionId = currentSessionId()): string {
  return path.join(goalShardDir(workspaceRoot, sessionSegment(sessionId)), "goal-create-transaction.json");
}

async function readCreationJournal(workspaceRoot: string, sessionId = currentSessionId()): Promise<GoalCreationJournal | null> {
  let text: string;
  try { text = await fs.readFile(goalCreationJournalPath(workspaceRoot, sessionId), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const journal = JSON.parse(text) as GoalCreationJournal;
  if (journal.version !== 1 || journal.owner_session !== sessionId || !journal.new_goal?.id ||
      !["prepared", "archived", "relay_fenced", "task_cancelled", "goal_published", "run_published", "committed"].includes(journal.phase)) {
    throw new Error("GOAL_CREATION_JOURNAL_INVALID: refusing to overwrite an invalid or foreign creation transaction.");
  }
  return journal;
}

/** Inspection is intentionally read-only. Only create/reconcile may recover. */
export async function getGoalCreationStatus(workspaceRoot: string, sessionId = currentSessionId()) {
  const journal = await readCreationJournal(workspaceRoot, sessionId);
  return journal ? {
    pending: journal.phase !== "committed", transaction_id: journal.transaction_id, phase: journal.phase,
    new_goal_id: journal.new_goal.id, new_goal_revision: journal.new_goal.revision, previous_goal_id: journal.previous_goal?.id ?? null,
    previous_task_id: journal.previous_task_id,
    stale_task_cancelled: ["task_cancelled", "goal_published", "run_published", "committed"].includes(journal.phase),
  } : { pending: false, transaction_id: null, phase: null, new_goal_id: null, new_goal_revision: null, previous_goal_id: null, previous_task_id: null, stale_task_cancelled: false };
}

export async function assertGoalCreationIdle(workspaceRoot: string, sessionId = currentSessionId()): Promise<void> {
  if (goalCreationContext.getStore() === creationKey(workspaceRoot, sessionId)) return;
  const journal = await readCreationJournal(workspaceRoot, sessionId);
  if (journal && journal.phase !== "committed") {
    throw new Error("GOAL_CREATION_PENDING: transaction " + journal.transaction_id + " is at " + journal.phase +
      "; inspect goal(status), then explicitly use goal(reconcile) or retry the same create to recover.");
  }
}

export async function updateGoal(
  workspaceRoot: string,
  patch: {
    objective?: string;
    success_criteria?: GoalCriterion[];
    constraints?: string[];
    current_phase?: string;
  },
  opts?: GoalMutationOptions
): Promise<DurableGoal> {
  return withGoalTaskDefinitionFence(workspaceRoot, () => withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal) throw new Error("No goal exists for this workspace. Create one with goal action=create.");
    if (goal.status === "completed" || goal.status === "cancelled") {
      throw new Error(`Cannot update a ${goal.status} goal. Create a new goal instead.`);
    }
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    const next: DurableGoal = {
      ...goal,
      objective: cleanString(patch.objective, 4000) || goal.objective,
      success_criteria: patch.success_criteria ? normalizeCriteria(patch.success_criteria, goal.success_criteria) : goal.success_criteria,
      constraints: patch.constraints ? normalizeConstraints(patch.constraints) : goal.constraints,
      current_phase: cleanString(patch.current_phase, 2000) || goal.current_phase,
      revision: goal.revision + 1,
      updated_at: new Date().toISOString(),
    };
    await writeGoalState(workspaceRoot, next);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, "update", next);
    return next;
  }));
}

// Private: caller must hold the goal lock.
async function setGoalStatus(workspaceRoot: string, status: GoalStatus, phase?: string): Promise<DurableGoal> {
  const goal = await getGoal(workspaceRoot);
  if (!goal) throw new Error("No goal exists for this workspace.");
  const now = new Date().toISOString();
  const next: DurableGoal = {
    ...goal,
    status,
    current_phase: cleanString(phase, 2000) || goal.current_phase,
    revision: goal.revision + 1,
    updated_at: now,
    ...(status === "completed" ? { completed_at: now } : {}),
  };
  if (status !== "completed") delete next.completed_at;
  await writeGoalState(workspaceRoot, next);
  notifyStateInvalidated(workspaceRoot);
  await recordGoalChange(workspaceRoot, `status:${status}`, next);
  return next;
}

export async function pauseGoal(workspaceRoot: string, phase?: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "active") throw new Error("Only an active goal can be paused.");
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    return setGoalStatus(workspaceRoot, "paused", phase);
  });
}

export async function resumeGoal(workspaceRoot: string, phase?: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "paused") throw new Error("Only a paused goal can be resumed.");
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    return setGoalStatus(workspaceRoot, "active", phase);
  });
}

export async function cancelGoal(workspaceRoot: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
      throw new Error("Only an active or paused goal can be cancelled.");
    }
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    return setGoalStatus(workspaceRoot, "cancelled", "Cancelled");
  });
}

export async function completeGoal(workspaceRoot: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const goal = await getGoal(workspaceRoot);
    if (!goal) throw new Error("No goal exists for this workspace.");
    if (goal.status !== "active") throw new Error(`Cannot complete a ${goal.status} goal.`);
    assertGoalAccessibleBySession(goal, currentSessionId());
    assertExpectedRevision(goal, opts);
    const remaining = goal.success_criteria.filter((criterion) => !criterion.passed);
    if (remaining.length) {
      throw new Error(
        `Cannot complete goal: ${remaining.length} success criterion/criteria remain: ${remaining.map((criterion) => criterion.name).join(", ")}. ` +
        `Keep executing toward the remaining criteria — a progress update is not a stop condition.`
      );
    }
    const completed = await setGoalStatus(workspaceRoot, "completed", "Goal complete");
    // Crystallize the outcome into cross-session memory: a fresh conversation
    // inherits what was achieved without re-reading the whole event log.
    try {
      const summary = goalSummary(completed);
      await appendAutoMemory(
        workspaceRoot,
        `Goal completed (${summary.criteria_passed}/${summary.criteria_total} criteria): ${summary.objective.slice(0, 200)}`
      );
    } catch {}
    return completed;
  });
}

export function goalSummary(goal: DurableGoal): GoalSummary {
  const remaining = goal.success_criteria.filter((criterion) => !criterion.passed);
  return {
    goal_id: goal.id,
    objective: goal.objective,
    status: goal.status,
    current_phase: goal.current_phase,
    criteria_passed: goal.success_criteria.length - remaining.length,
    criteria_total: goal.success_criteria.length,
    remaining_criteria: remaining.map((criterion) => criterion.name),
    constraints: goal.constraints,
    owner_session: goal.owner_session,
    intent_provenance: unknownGoalIntentProvenance(goal.intent_provenance),
    watchdog_policy: {
      mode: "goal_scoped",
      lifecycle: "managed_by_goal",
      role: "fallback_alert_only",
      manual_control: "operator_only",
      auto_resume_web: false,
    },
    continuation_contract: GOAL_CONTINUATION_CONTRACT,
    updated_at: goal.updated_at,
  };
}

export async function formatActiveGoalForInstructions(workspaceRoot: string): Promise<string> {
  const goal = await getGoal(workspaceRoot);
  if (!goal || goal.status !== "active") return "";
  const criteria = goal.success_criteria
    .map((criterion) => `- [${criterion.passed ? "x" : " "}] ${criterion.name}${criterion.detail ? ` — ${criterion.detail}` : ""}`)
    .join("\n");
  const constraints = goal.constraints.length
    ? `\nConstraints:\n${goal.constraints.map((constraint) => `- ${constraint}`).join("\n")}`
    : "";
  return [
    "## ACTIVE GOAL",
    `Execution contract: ${GOAL_CONTINUATION_CONTRACT}`,
    `Watchdog policy: ${GOAL_WATCHDOG_POLICY}`,
    `Objective: ${goal.objective}`,
    `Current phase: ${goal.current_phase}`,
    "Success criteria:",
    criteria,
    constraints,
    GOAL_GROUNDING_NOTE,
  ].filter(Boolean).join("\n");
}

/**
 * A Task is independently deliverable after its OWN checks pass. That must
 * neither complete its containing Goal nor allow an old/foreign Goal's Task
 * to be acknowledged under a newer Goal. Goal completion remains governed
 * by completeGoal and GoalRun's typed evidence criteria, not by this helper.
 */
export async function assertGoalAllowsTaskCompletion(
  workspaceRoot: string,
  taskGoalId?: string,
  taskGoalDefinitionSha256?: string
): Promise<void> {
  const sessionId = getRuntimeScope()?.mcpSessionId;
  const goal = await getGoal(workspaceRoot);
  if (!goal) {
    if (taskGoalId) throw new Error("TASK_GOAL_STALE: Task is bound to a Goal that is not available in the current session.");
    return;
  }
  if (!goalVisibleToSession(goal, sessionId)) {
    throw new Error("TASK_GOAL_OWNER_MISMATCH: current Goal is not owned by this session.");
  }
  if (taskGoalId !== goal.id) {
    throw new Error("TASK_GOAL_MISMATCH: Task is not bound to this Goal; reconcile or cancel the stale Task.");
  }
  if (goal.status === "cancelled") {
    throw new Error("TASK_GOAL_CANCELLED: cannot deliver a Task for a cancelled Goal.");
  }
  // New Tasks pin their concrete acceptance scope. Do not let a Task
  // validated for the old user objective silently succeed after a revision.
  // Historical Tasks remain readable, but their previous passed checks cannot
  // establish the current Goal requirements. An explicit revision-pinned
  // revalidation resets those checks before a new completion is permitted.
  if (taskGoalId && !taskGoalDefinitionSha256) {
    throw new Error("TASK_GOAL_REVALIDATION_REQUIRED: historic Task has no material Goal definition fingerprint. Run task_state action=revalidate with expected_goal_revision, then rerun blocking checks.");
  }
  if (taskGoalDefinitionSha256 &&
      taskGoalDefinitionSha256 !== goalDefinitionFingerprint(goal)) {
    throw new Error("TASK_GOAL_DEFINITION_CHANGED: this Task was validated for an earlier Goal objective, named criterion, confirmation requirement or constraint. Reconcile the Task against the current user intent before completing.");
  }
}

/** Lifecycle-only boundary: keep the pending-journal bypass in this singleton. */
function withGoalCreationContext<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  return goalCreationContext.run(creationKey(workspaceRoot, currentSessionId()), operation);
}

/** Internal primitives for goals.ts; not re-exported by the public facade. */
export const goalStateStore = Object.freeze({
  assertExpectedRevision,
  atomicWriteJson,
  cleanString,
  currentSessionId,
  goalPath,
  goalShardDir,
  normalizeConstraints,
  normalizeCriteria,
  readCreationJournal,
  readGoalFile,
  recordGoalChange,
  sessionSegment,
  withGoalCreationContext,
  withGoalLock,
  writeGoalState,
});
