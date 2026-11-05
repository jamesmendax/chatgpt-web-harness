import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { getVisualReviewFreshness } from "./visual-review-state.js";
import { assertGoalAllowsTaskCompletion, assertGoalCreationIdle, getGoal, goalDefinitionFingerprint, goalVisibleToSession, withGoalTaskDefinitionFence, withGoalTaskDefinitionFences } from "./goal-state-store.js";
import { appendHarnessEventSafe, type HarnessEvidenceKind } from "./harness-events.js";
import { getRuntimeScope } from "./runtime-scope.js";
import { accountProjectDir } from "./account-project-scope.js";
import { inferProjectRootsFromPaths, inferProjectScope, isPathWithinRoots } from "./project-scope.js";
import { notifyStateInvalidated } from "./state-invalidate.js";

export type DurableTaskStatus = "active" | "blocked" | "completed" | "cancelled";

export interface TaskCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface TaskEvent {
  time: string;
  kind: "tool" | "progress" | "decision" | "failure" | "check";
  summary: string;
  tool?: string;
  ok?: boolean;
  exit_code?: number | null;
  paths?: string[];
}

export interface TaskFailure {
  time: string;
  tool: string;
  summary: string;
  command?: string;
  exit_code?: number | null;
}

export interface TaskVisualReview {
  review_id: string;
  target: string;
  kind: string;
  reviewed_at: string;
  visual_status: string;
  machine_ready: boolean;
  blocking_issues: string[];
  source_path?: string;
  source_signature?: string;
}

export interface TaskBlockedReason {
  code: string;
  message: string;
  since: string;
}

export interface DurableTask {
  version: 2;
  id: string;
  goal: string;
  goal_id?: string;
  /** New tasks pin material Goal acceptance scope; old V2 records omit it. */
  goal_definition_sha256?: string;
  status: DurableTaskStatus;
  current_step: string;
  blocking_checks: TaskCheck[];
  advisory_checks: TaskCheck[];
  artifacts: string[];
  notes: string[];
  done: string[];
  decisions: string[];
  blockers: string[];
  next_actions: string[];
  changed_files: string[];
  observed_checks: TaskCheck[];
  recent_events: TaskEvent[];
  project_roots: string[];
  project_scope_locked: boolean;
  owner_session?: string;
  checkpoint_no: number;
  visual_required: boolean;
  blocked?: TaskBlockedReason;
  last_mutation_at?: string;
  visual_review?: TaskVisualReview;
  last_failure?: TaskFailure;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  completion_basis?: { declaration: string; declared_at: string; verification: "model_declared"; unmet_checks: TaskCheck[] };
}

export interface TaskHandoff {
  task_id: string;
  goal: string;
  goal_id?: string;
  goal_definition_sha256?: string;
  goal_definition_revalidation_required?: boolean;
  status: DurableTaskStatus;
  current_step: string;
  done: string[];
  decisions: string[];
  blockers: string[];
  next_actions: string[];
  changed_files: string[];
  artifacts: string[];
  completion_basis?: DurableTask["completion_basis"];
  blocking_remaining: number;
  advisory_remaining: number;
  observed_checks: TaskCheck[];
  owner_session?: string;
  blocked?: TaskBlockedReason;
  last_failure?: TaskFailure;
  recent_events: TaskEvent[];
  project_roots: string[];
  project_scope_locked: boolean;
  checkpoint_no: number;
  visual_required: boolean;
  last_mutation_at?: string;
  visual_review?: TaskVisualReview;
  updated_at: string;
}

interface ActiveTaskPointer {
  taskId: string | null;
  updatedAt: number;
}

export interface DurableTaskSessionRebindPlan {
  task_id: string;
  goal_id?: string;
  from_session?: string;
  to_session: string;
}

interface GoalTaskBindJournal extends DurableTaskSessionRebindPlan {
  version: 1;
  goal_id: string;
  phase: "prepared" | "committed";
}

export interface DurableTaskSessionRebindResult {
  migrated: boolean;
  task_id?: string;
  from_session?: string;
  to_session?: string;
  reason?: string;
}

const ACTIVE_TASK_TTL_MS = Math.min(
  30 * 24 * 60 * 60 * 1000,
  Math.max(60 * 60 * 1000, Number.parseInt(process.env.ACTIVE_TASK_TTL_MS || "86400000", 10) || 86_400_000)
);
const activeTaskCache = new Map<string, ActiveTaskPointer>();
const workspaceChains = new Map<string, Promise<void>>();
const taskLockContext = new AsyncLocalStorage<ReadonlySet<string>>();
const MAX_LIST_ITEMS = 24;
const MAX_EVENTS = 24;
const MAX_CHANGED_FILES = 40;

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

function currentSessionId(): string | undefined {
  return getRuntimeScope()?.mcpSessionId;
}

class DurableTaskAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableTaskAccessError";
  }
}

function taskVisibleToSession(task: DurableTask, sessionId = currentSessionId()): boolean {
  // Tasks written before session ownership was introduced remain workspace
  // scoped. Once an owner exists, an absent session is just as foreign as a
  // different session and must fail closed.
  return !task.owner_session || task.owner_session === sessionId;
}

function assertDurableTaskAccessible(task: DurableTask, sessionId = currentSessionId()): void {
  if (taskVisibleToSession(task, sessionId)) return;
  if (!sessionId) {
    throw new DurableTaskAccessError(
      "This task belongs to a ChatGPT window, but no current MCP session is available; access is denied."
    );
  }
  throw new DurableTaskAccessError(
    "This task belongs to a different ChatGPT window; access is denied. Use goal(action=bind) for the explicit Goal/task migration contract."
  );
}

async function withWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = workspaceKey(workspaceRoot);
  const previous = workspaceChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  workspaceChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await taskLockContext.run(new Set([...(taskLockContext.getStore() ?? []), key]), operation);
  } finally {
    release();
    if (workspaceChains.get(key) === chain) workspaceChains.delete(key);
  }
}

function cleanString(value: unknown, max = 1000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, max);
}

function assertBlockerCode(code: string): string {
  const cleaned = code.trim();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(cleaned)) {
    throw new Error(`blocker code must be lower-kebab-case, got "${code}"`);
  }
  return cleaned;
}

function stallGapMs(): number {
  const parsed = Number.parseInt(process.env.GOAL_STALL_GAP_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
}

const lastStallNotified = new Map<string, number>();

function pruneStallThrottle(): void {
  if (lastStallNotified.size <= 512) return;
  const cutoff = Date.now() - 2 * stallGapMs();
  for (const [key, at] of lastStallNotified) {
    if (at < cutoff) lastStallNotified.delete(key);
  }
}

/**
 * Stall telemetry, covering BOTH task-backed and goal-only workflows (an
 * earlier inline version in recordToolObservation only saw task-backed ones).
 * A stall = goal active + unmet criteria + no high-value activity for longer
 * than the gap threshold. A recorded blocker is a sanctioned yield, not a
 * stall. Throttled to one event per gap per workspace.
 */
export async function recordGoalStallTelemetry(workspaceRoot: string): Promise<void> {
  try {
    const gap = stallGapMs();
    if (gap <= 0) return;
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "active") return;
    // Session scoping: another ChatGPT window's activity must not consume this
    // goal's stall signal (and vice versa).
    if (!goalVisibleToSession(goal, currentSessionId())) return;

    const activeTaskId = await getActiveTaskId(workspaceRoot, currentSessionId());
    let lastActivity = Date.parse(goal.updated_at);
    let taskId: string | undefined;
    let blocked = false;
    if (activeTaskId) {
      try {
        const task = await getDurableTask(workspaceRoot, activeTaskId);
        taskId = task.id;
        blocked = Boolean(task.blocked);
        const taskActivity = Date.parse(task.updated_at);
        if (Number.isFinite(taskActivity) && taskActivity > lastActivity) lastActivity = taskActivity;
      } catch {}
    }
    if (blocked || !Number.isFinite(lastActivity)) return;

    const gapMs = Date.now() - lastActivity;
    if (gapMs <= gap) return;

    const throttleKey = workspaceKey(workspaceRoot);
    const lastNotified = lastStallNotified.get(throttleKey) ?? 0;
    if (Date.now() - lastNotified <= gap) return;

    await appendHarnessEventSafe(workspaceRoot, {
      type: "goal/stall",
      ...(taskId ? { task_id: taskId } : {}),
      project_roots: [path.resolve(workspaceRoot)],
      data: {
        gap_ms: gapMs,
        criteria_passed: goal.success_criteria.filter((criterion) => criterion.passed).length,
        criteria_total: goal.success_criteria.length,
        scope: taskId ? "task" : "goal_only",
      },
    });
    // Stamp the throttle only after the event is durably handed off, so a
    // failed write retries on the next call instead of suppressing a stall.
    lastStallNotified.set(throttleKey, Date.now());
    pruneStallThrottle();
  } catch {}
}

function appendUnique(existing: string[], incoming: unknown, maxItems = MAX_LIST_ITEMS): string[] {
  const values = Array.isArray(incoming) ? incoming : incoming == null ? [] : [incoming];
  const next = [...existing];
  const seen = new Set(next.map((item) => item.toLowerCase()));
  for (const value of values) {
    const cleaned = cleanString(value);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    next.push(cleaned);
    seen.add(cleaned.toLowerCase());
  }
  return next.slice(-maxItems);
}

function removeStrings(existing: string[], values: unknown): string[] {
  if (!Array.isArray(values)) return existing;
  const removals = new Set(values.map((value) => cleanString(value)?.toLowerCase()).filter(Boolean));
  return existing.filter((item) => !removals.has(item.toLowerCase()));
}

function mergeChecks(existing: TaskCheck[], incoming?: TaskCheck[]): TaskCheck[] {
  if (!incoming?.length) return existing;
  const next = [...existing];
  for (const check of incoming) {
    const name = cleanString(check.name, 300);
    if (!name) continue;
    const normalized: TaskCheck = {
      name,
      passed: Boolean(check.passed),
      ...(cleanString(check.detail, 2000) ? { detail: cleanString(check.detail, 2000)! } : {}),
    };
    const index = next.findIndex((item) => item.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) next[index] = normalized;
    else next.push(normalized);
  }
  return next.slice(-50);
}

function normalizeTask(
  raw: Partial<DurableTask> & Pick<DurableTask, "id" | "goal" | "status" | "current_step" | "created_at" | "updated_at">,
  workspaceRoot?: string
): DurableTask {
  return {
    version: 2,
    id: raw.id,
    goal: raw.goal,
    status: raw.status,
    current_step: raw.current_step,
    blocking_checks: raw.blocking_checks ?? [],
    advisory_checks: raw.advisory_checks ?? [],
    artifacts: raw.artifacts ?? [],
    notes: raw.notes ?? [],
    done: raw.done ?? [],
    decisions: raw.decisions ?? [],
    blockers: raw.blockers ?? [],
    next_actions: raw.next_actions ?? [],
    changed_files: raw.changed_files ?? [],
    observed_checks: raw.observed_checks ?? [],
    recent_events: raw.recent_events ?? [],
    project_roots: raw.project_roots?.length
      ? raw.project_roots.map((root) => path.resolve(root))
      : workspaceRoot
        ? [path.resolve(workspaceRoot)]
        : [],
    project_scope_locked: raw.project_scope_locked ?? false,
    ...(raw.owner_session ? { owner_session: raw.owner_session } : {}),
    ...(raw.goal_id ? { goal_id: raw.goal_id } : {}),
    ...(typeof raw.goal_definition_sha256 === "string"
      ? { goal_definition_sha256: raw.goal_definition_sha256 }
      : {}),
    ...(raw.blocked && typeof raw.blocked === "object"
      ? { blocked: raw.blocked as TaskBlockedReason }
      : {}),
    checkpoint_no: raw.checkpoint_no ?? 0,
    visual_required: raw.visual_required ?? false,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    ...(raw.completed_at ? { completed_at: raw.completed_at } : {}),
    ...(raw.completion_basis ? { completion_basis: raw.completion_basis } : {}),
    ...(raw.last_failure ? { last_failure: raw.last_failure } : {}),
    ...(raw.last_mutation_at ? { last_mutation_at: raw.last_mutation_at } : {}),
    ...(raw.visual_review ? { visual_review: raw.visual_review } : {}),
  };
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function durableTaskDir(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(accountProjectDir(path.join(base, "projects", projectSlug(workspaceRoot))), "tasks");
}

function activeTaskPath(workspaceRoot: string): string {
  return path.join(durableTaskDir(workspaceRoot), "active-task.json");
}

function taskPath(workspaceRoot: string, taskId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error("Invalid task_id");
  return path.join(durableTaskDir(workspaceRoot), `${taskId}.json`);
}

async function readDurableTaskRecord(workspaceRoot: string, taskId: string): Promise<DurableTask> {
  const raw = await fs.readFile(taskPath(workspaceRoot, taskId), "utf-8");
  return normalizeTask(JSON.parse(raw) as DurableTask, workspaceRoot);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(temp, filePath);
}

async function recordTaskChange(workspaceRoot: string, operation: string, task: DurableTask): Promise<void> {
  let data: Record<string, unknown> = { operation, task };
  if (Buffer.byteLength(JSON.stringify(data), "utf-8") > 60_000) {
    // Whole-value snapshots stay under the event cap; pathological tasks fall
    // back to a summary event instead of silently dropping the change.
    data = {
      operation,
      task_summary: { id: task.id, status: task.status, checkpoint_no: task.checkpoint_no, updated_at: task.updated_at },
      snapshot_omitted: "task snapshot exceeds the 60KB event budget; read the task file for full state",
    };
  }
  await appendHarnessEventSafe(workspaceRoot, {
    type: "task/change",
    project_roots: task.project_roots,
    task_id: task.id,
    data,
  });
}

function activeTaskPathFor(workspaceRoot: string, sessionId?: string): string {
  const dir = durableTaskDir(workspaceRoot);
  return sessionId
    ? path.join(dir, `active-task.${sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}.json`)
    : path.join(dir, "active-task.json");
}

async function setActiveTaskId(workspaceRoot: string, sessionId: string | undefined, taskId: string | null): Promise<void> {
  const key = `${workspaceKey(workspaceRoot)}::${sessionId ?? "legacy"}`;
  const previous = activeTaskCache.get(key)?.taskId ?? null;
  const updatedAt = Date.now();
  const filePath = activeTaskPathFor(workspaceRoot, sessionId);
  if (!taskId) {
    await fs.rm(filePath, { force: true });
  } else {
    // Always rewrite: updated_at is the TTL heartbeat for the pointer expiry.
    await atomicWriteJson(filePath, { task_id: taskId, updated_at: new Date(updatedAt).toISOString() });
  }
  // Publish the cache only after the durable pointer succeeds. An I/O failure
  // must remain visible to a subsequent bind recovery in this process.
  activeTaskCache.set(key, { taskId, updatedAt });
  // Observations re-assert the same pointer on every tool call; only a real
  // pointer change may invalidate the broker cache, or the 2s state cache
  // would be defeated entirely.
  if (taskId !== previous) notifyStateInvalidated(workspaceRoot);
}

export async function getActiveTaskId(workspaceRoot: string, sessionId?: string): Promise<string | null> {
  const key = `${workspaceKey(workspaceRoot)}::${sessionId ?? "legacy"}`;
  const filePath = activeTaskPathFor(workspaceRoot, sessionId);
  // A Goal bind may move the authoritative active pointer in *another* Node
  // process. The in-memory pointer is only a write/notification hint; neither
  // a cached task ID nor a cached null may bypass a durable file read.
  // Keep the existing persisted TTL and expiry cleanup behavior unchanged.
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf-8")) as { task_id?: string; updated_at?: string };
    const taskId = typeof raw.task_id === "string" ? raw.task_id : null;
    const updatedAt = Date.parse(raw.updated_at || "");
    if (taskId && (!Number.isFinite(updatedAt) || Date.now() - updatedAt > ACTIVE_TASK_TTL_MS)) {
      activeTaskCache.set(key, { taskId: null, updatedAt: Date.now() });
      await fs.rm(filePath, { force: true });
      return null;
    }
    activeTaskCache.set(key, { taskId, updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now() });
    return taskId;
  } catch {
    activeTaskCache.set(key, { taskId: null, updatedAt: Date.now() });
    return null;
  }
}

/**
 * Preflight the durable-task half of an explicit Goal session bind.
 *
 * The Goal and task stores are separate, so the Goal tool uses this before it
 * mutates Goal ownership. A conflicting active task in the destination window
 * is rejected up front instead of silently replacing that window's work.
 */
export async function planActiveDurableTaskSessionRebind(
  workspaceRoot: string,
  fromSession: string | undefined,
  toSession: string,
  expectedGoalId?: string
): Promise<DurableTaskSessionRebindPlan | null> {
  if (!toSession || fromSession === toSession) return null;

  if (expectedGoalId) {
    const sourceGoal = await getGoal(workspaceRoot, fromSession);
    if (!sourceGoal || sourceGoal.id !== expectedGoalId || sourceGoal.owner_session !== fromSession) {
      throw new Error("GOAL_BIND_TASK_GOAL_CONFLICT: the authoritative source Goal changed before task preflight.");
    }
  }

  const sourceTaskId = await getActiveTaskId(workspaceRoot, fromSession);
  if (!sourceTaskId) return null;

  // This read is part of the explicit Goal bind migration contract. The
  // source session is intentionally inspected while the destination session
  // owns the bind invocation; ownership is checked below before migration.
  const sourceTask = await readDurableTaskRecord(workspaceRoot, sourceTaskId);
  if (sourceTask.status !== "active" && sourceTask.status !== "blocked") return null;
  if (expectedGoalId && sourceTask.goal_id && sourceTask.goal_id !== expectedGoalId) {
    throw new Error("GOAL_BIND_TASK_GOAL_CONFLICT: the source active task belongs to another Goal.");
  }

  if (sourceTask.owner_session && sourceTask.owner_session !== fromSession && sourceTask.owner_session !== toSession) {
    throw new Error(
      `GOAL_BIND_TASK_OWNER_CONFLICT: active task ${sourceTask.id} belongs to session ${sourceTask.owner_session.slice(0, 8)}…`
    );
  }

  const destinationTaskId = await getActiveTaskId(workspaceRoot, toSession);
  if (destinationTaskId && destinationTaskId !== sourceTaskId) {
    throw new Error(
      `GOAL_BIND_TASK_CONFLICT: destination ChatGPT window already has active task ${destinationTaskId}; ` +
      `complete/cancel it before binding this Goal.`
    );
  }

  return {
    task_id: sourceTaskId,
    ...(expectedGoalId ? { goal_id: expectedGoalId } : {}),
    ...(fromSession ? { from_session: fromSession } : {}),
    to_session: toSession,
  };
}

async function commitActiveDurableTaskSessionRebindUnlocked(
  workspaceRoot: string,
  plan: DurableTaskSessionRebindPlan | null,
  allowJournaledDetachedTask = false
): Promise<DurableTaskSessionRebindResult> {
  if (!plan) return { migrated: false, reason: "no-active-task-to-migrate" };
  if (plan.goal_id) await assertGoalTaskBindTarget(workspaceRoot, plan.goal_id, plan.to_session);

  const sourcePointer = await getActiveTaskId(workspaceRoot, plan.from_session);
  const destinationPointer = await getActiveTaskId(workspaceRoot, plan.to_session);
  if (destinationPointer && destinationPointer !== plan.task_id) {
    throw new Error(
      `GOAL_BIND_TASK_CONFLICT: destination ChatGPT window already has active task ${destinationPointer}.`
    );
  }
  if (!allowJournaledDetachedTask && sourcePointer !== plan.task_id && destinationPointer !== plan.task_id) {
    throw new Error(
      `GOAL_BIND_TASK_STALE_PLAN: active task pointer changed before migration of ${plan.task_id}; retry Goal bind status/recovery.`
    );
  }

  // See the preflight note above: migration is the one supported cross-session
  // read, and the owner/conflict checks below must run before the write.
  const task = await readDurableTaskRecord(workspaceRoot, plan.task_id);
  if (plan.goal_id && task.goal_id && task.goal_id !== plan.goal_id) {
    throw new Error("GOAL_BIND_TASK_GOAL_CONFLICT: the fixed task belongs to another Goal.");
  }
  if (task.status !== "active" && task.status !== "blocked") {
    return {
      migrated: false,
      task_id: task.id,
      ...(plan.from_session ? { from_session: plan.from_session } : {}),
      to_session: plan.to_session,
      reason: `task-is-${task.status}`,
    };
  }
  if (task.owner_session && task.owner_session !== plan.from_session && task.owner_session !== plan.to_session) {
    throw new Error(
      `GOAL_BIND_TASK_OWNER_CONFLICT: task ${task.id} changed owner before migration.`
    );
  }

  const next: DurableTask = {
    ...task,
    ...(plan.goal_id ? { goal_id: plan.goal_id } : {}),
    owner_session: plan.to_session,
    updated_at: new Date().toISOString(),
  };
  const taskChanged = task.owner_session !== plan.to_session || Boolean(plan.goal_id && task.goal_id !== plan.goal_id);
  if (taskChanged) await atomicWriteJson(taskPath(workspaceRoot, task.id), next);
  if (destinationPointer !== task.id) await setActiveTaskId(workspaceRoot, plan.to_session, task.id);
  if (plan.from_session !== plan.to_session && (await getActiveTaskId(workspaceRoot, plan.from_session)) === task.id) {
    await setActiveTaskId(workspaceRoot, plan.from_session, null);
  }
  notifyStateInvalidated(workspaceRoot);
  if (taskChanged) await recordTaskChange(workspaceRoot, "bind-session", next);

  return {
    migrated: true,
    task_id: task.id,
    ...(plan.from_session ? { from_session: plan.from_session } : {}),
    to_session: plan.to_session,
  };
}

/** Commit a preflighted task-session migration as a standalone task mutation. */
export async function commitActiveDurableTaskSessionRebind(
  workspaceRoot: string,
  plan: DurableTaskSessionRebindPlan | null
): Promise<DurableTaskSessionRebindResult> {
  return withGoalTaskDefinitionFences(
    workspaceRoot,
    plan ? [plan.from_session, plan.to_session] : [currentSessionId()],
    () => withWorkspaceLock(workspaceRoot, () => commitActiveDurableTaskSessionRebindUnlocked(workspaceRoot, plan))
  );
}

/**
 * Hold the durable-task workspace lock across preflight, Goal ownership change,
 * and task migration. This closes the race where the destination session could
 * create/activate another task after preflight but before migration commit.
 */
export async function runWithActiveDurableTaskSessionRebind<T>(
  workspaceRoot: string,
  fromSession: string | undefined,
  toSession: string,
  operation: () => Promise<T>,
  expectedGoalId?: string
): Promise<{ value: T; durable_task_rebind: DurableTaskSessionRebindResult }> {
  return withGoalTaskDefinitionFences(workspaceRoot, [fromSession, toSession], () => withWorkspaceLock(workspaceRoot, async () => {
    const prior = expectedGoalId ? await readGoalTaskBindJournal(workspaceRoot, expectedGoalId, toSession) : null;
    if (prior?.phase === "prepared" && prior.from_session !== fromSession) {
      throw new Error("GOAL_BIND_TASK_JOURNAL_CONFLICT: a different source has a pending task migration for this Goal.");
    }
    const plan = prior?.phase === "prepared" ? prior
      : await planActiveDurableTaskSessionRebind(workspaceRoot, fromSession, toSession, expectedGoalId);
    const journal: GoalTaskBindJournal | null = plan && expectedGoalId
      ? { ...plan, version: 1, goal_id: expectedGoalId, phase: "prepared" } : null;
    if (journal) await atomicWriteJson(goalTaskBindJournalPath(workspaceRoot, expectedGoalId!, toSession), journal);
    const value = await operation();
    const durable_task_rebind = await commitActiveDurableTaskSessionRebindUnlocked(workspaceRoot, plan, prior?.phase === "prepared");
    if (journal) await atomicWriteJson(goalTaskBindJournalPath(workspaceRoot, journal.goal_id, toSession), { ...journal, phase: "committed" });
    return { value, durable_task_rebind };
  }));
}

function goalTaskBindJournalPath(workspaceRoot: string, goalId: string, toSession: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(goalId) || !toSession) throw new Error("GOAL_BIND_TASK_JOURNAL_INVALID: invalid identity.");
  const targetKey = createHash("sha256").update(toSession).digest("hex");
  return path.join(durableTaskDir(workspaceRoot), "goal-bind-transactions", targetKey, `${goalId}.json`);
}

async function readGoalTaskBindJournal(workspaceRoot: string, goalId: string, toSession: string): Promise<GoalTaskBindJournal | null> {
  let raw: GoalTaskBindJournal;
  try { raw = JSON.parse(await fs.readFile(goalTaskBindJournalPath(workspaceRoot, goalId, toSession), "utf8")) as GoalTaskBindJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (raw.version !== 1 || raw.goal_id !== goalId || raw.to_session !== toSession ||
      !["prepared", "committed"].includes(raw.phase) || typeof raw.task_id !== "string" ||
      (raw.from_session !== undefined && typeof raw.from_session !== "string")) {
    throw new Error("GOAL_BIND_TASK_JOURNAL_INVALID: the stored migration does not match this Goal and destination.");
  }
  taskPath(workspaceRoot, raw.task_id);
  return raw;
}

async function assertGoalTaskBindTarget(workspaceRoot: string, goalId: string, toSession: string): Promise<void> {
  const goal = await getGoal(workspaceRoot, toSession);
  if (currentSessionId() !== toSession || goal?.id !== goalId || goal.owner_session !== toSession) {
    throw new Error("GOAL_BIND_TASK_GOAL_CONFLICT: task recovery requires the exact Goal owned by this destination session.");
  }
}

/** Finish only the task captured before this Goal's bind. Never select a new source pointer. */
export async function recoverGoalTaskSessionRebind(workspaceRoot: string, goalId: string, toSession: string): Promise<DurableTaskSessionRebindResult> {
  // Peek only to discover the source lock; validate the journal again *under*
  // both fences before any writes. A changed journal must not silently rebind
  // a different source Task or create an unprotected owner transition.
  const peek = await readGoalTaskBindJournal(workspaceRoot, goalId, toSession);
  return withGoalTaskDefinitionFences(workspaceRoot,
    peek ? [peek.from_session, toSession] : [toSession],
    () => withWorkspaceLock(workspaceRoot, async () => {
    await assertGoalTaskBindTarget(workspaceRoot, goalId, toSession);
    const journal = await readGoalTaskBindJournal(workspaceRoot, goalId, toSession);
    if (journal?.phase === "prepared" && journal.from_session !== peek?.from_session) {
      throw new Error("GOAL_BIND_TASK_JOURNAL_CONFLICT: source changed while acquiring the Goal owner fences.");
    }
    if (!journal || journal.phase === "committed") return { migrated: false, reason: "ALREADY_BOUND" };
    const result = await commitActiveDurableTaskSessionRebindUnlocked(workspaceRoot, journal, true);
    await atomicWriteJson(goalTaskBindJournalPath(workspaceRoot, goalId, toSession), { ...journal, phase: "committed" });
    return result;
  }));
}

/** Capture one exact task identity while creation publishes its journal. */
export function withDurableTaskGoalTransition<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  return withWorkspaceLock(workspaceRoot, operation);
}

// Only the coordinator's two internal helpers may reuse its lock. Ordinary
// mutations can fork from the same async context and must still queue.
function withGoalTransitionTaskLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  return taskLockContext.getStore()?.has(workspaceKey(workspaceRoot))
    ? operation()
    : withWorkspaceLock(workspaceRoot, operation);
}

export async function withActiveDurableTaskSnapshot<T>(
  workspaceRoot: string,
  operation: (taskId: string | null) => Promise<T>
): Promise<T> {
  return withGoalTransitionTaskLock(workspaceRoot, async () => {
    const session = currentSessionId();
    const taskId = await getActiveTaskId(workspaceRoot, session);
    if (!taskId) return operation(null);
    const task = await readDurableTaskRecord(workspaceRoot, taskId);
    assertDurableTaskAccessible(task, session);
    return operation(task.status === "active" || task.status === "blocked" ? taskId : null);
  });
}

/** Idempotent cancellation targets the journal's task, never a fresh pointer. */
export async function cancelDurableTaskForGoalReplacement(workspaceRoot: string, taskId: string, reason: string): Promise<void> {
  await withGoalTransitionTaskLock(workspaceRoot, async () => {
    const task = await readDurableTaskRecord(workspaceRoot, taskId);
    assertDurableTaskAccessible(task);
    if (task.status === "active" || task.status === "blocked") {
      const next: DurableTask = { ...task, status: "cancelled", current_step: reason, updated_at: new Date().toISOString() };
      delete next.blocked;
      await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
      await recordTaskChange(workspaceRoot, "goal-superseded", next);
    }
    if ((await getActiveTaskId(workspaceRoot, currentSessionId())) === taskId) {
      await setActiveTaskId(workspaceRoot, currentSessionId(), null);
    }
    notifyStateInvalidated(workspaceRoot);
  });
}

export async function createDurableTask(
  workspaceRoot: string,
  input: {
    goal: string;
    current_step?: string;
    blocking_checks?: TaskCheck[];
    advisory_checks?: TaskCheck[];
    artifacts?: string[];
    notes?: string[];
    visual_required?: boolean;
  }
): Promise<DurableTask> {
  const now = new Date().toISOString();
  const ownerSession = currentSessionId();
  const scope = await inferProjectScope(workspaceRoot, [input.goal, input.current_step, ...(input.notes ?? [])]);
  const task: DurableTask = {
    version: 2,
    id: randomUUID(),
    goal: input.goal.trim(),
    status: "active",
    current_step: input.current_step?.trim() || "Start work",
    blocking_checks: input.blocking_checks ?? [],
    advisory_checks: input.advisory_checks ?? [],
    artifacts: input.artifacts ?? [],
    notes: input.notes ?? [],
    done: [],
    decisions: [],
    blockers: [],
    next_actions: [],
    changed_files: [],
    observed_checks: [],
    recent_events: [],
    project_roots: scope.roots,
    project_scope_locked: scope.locked,
    ...(ownerSession ? { owner_session: ownerSession } : {}),
    checkpoint_no: 0,
    visual_required: Boolean(input.visual_required),
    created_at: now,
    updated_at: now,
  };
  await withGoalTaskDefinitionFence(workspaceRoot, () => withWorkspaceLock(workspaceRoot, async () => {
    const currentGoal = await getGoal(workspaceRoot).catch(() => null);
    if (currentGoal) {
      task.goal_id = currentGoal.id;
      task.goal_definition_sha256 = goalDefinitionFingerprint(currentGoal);
    }
    await atomicWriteJson(taskPath(workspaceRoot, task.id), task);
    await setActiveTaskId(workspaceRoot, currentSessionId(), task.id);
    notifyStateInvalidated(workspaceRoot);
  }));
  await recordTaskChange(workspaceRoot, "create", task);
  return task;
}

export async function getDurableTask(workspaceRoot: string, taskId: string): Promise<DurableTask> {
  const task = await readDurableTaskRecord(workspaceRoot, taskId);
  assertDurableTaskAccessible(task);
  return task;
}

export async function updateDurableTask(
  workspaceRoot: string,
  taskId: string,
  patch: Partial<Pick<DurableTask, "goal" | "status" | "current_step" | "blocking_checks" | "advisory_checks" | "artifacts" | "notes" | "visual_required">>
): Promise<DurableTask> {
  return withWorkspaceLock(workspaceRoot, async () => {
    if (patch.status === "completed") {
      throw new Error("TASK_COMPLETION_GATE_REQUIRED: use completeDurableTask to enforce current Goal definition and blocking checks.");
    }
    const task = await getDurableTask(workspaceRoot, taskId);
    const next: DurableTask = {
      ...task,
      ...patch,
      goal: patch.goal?.trim() || task.goal,
      current_step: patch.current_step?.trim() ?? task.current_step,
      updated_at: new Date().toISOString(),
    };
    if (next.status === "completed" && !next.completed_at) next.completed_at = next.updated_at;
    if (next.status !== "completed") delete next.completed_at;
    if (next.status === "completed" || next.status === "cancelled") delete next.blocked;
    await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
    notifyStateInvalidated(workspaceRoot);
    if (next.status === "active" || next.status === "blocked") await setActiveTaskId(workspaceRoot, currentSessionId(), taskId);
    else if ((await getActiveTaskId(workspaceRoot, currentSessionId())) === taskId) await setActiveTaskId(workspaceRoot, currentSessionId(), null);
    await recordTaskChange(workspaceRoot, "update", next);
    return next;
  });
}

/**
 * Explicitly adopt the current *material* Goal definition for a legacy or
 * stale Task. This is revalidation of work, NOT evidence of user approval:
 * earlier "passed" checks and visual-review freshness are invalidated. The
 * caller must perform fresh checks before task_complete can succeed.
 *
 * expectedGoalRevision pins the currently observed Goal, while the shared
 * cross-process fence prevents a concurrent cooperating Goal definition
 * update from interleaving the rebind.
 */
export async function revalidateDurableTaskGoalDefinition(
  workspaceRoot: string,
  taskId: string,
  expectedGoalRevision: number
): Promise<DurableTask> {
  if (!Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1) {
    throw new Error("GOAL_STALE_REVISION: revalidation requires a positive expected_goal_revision.");
  }
  return withGoalTaskDefinitionFence(workspaceRoot, () => withWorkspaceLock(workspaceRoot, async () => {
    const task = await getDurableTask(workspaceRoot, taskId);
    if (task.status !== "active" && task.status !== "blocked") {
      throw new Error("TASK_REVALIDATION_TERMINAL: a completed or cancelled Task cannot be rebound.");
    }
    const goal = await getGoal(workspaceRoot);
    if (!goal || goal.status !== "active" || !goalVisibleToSession(goal, currentSessionId())) {
      throw new Error("TASK_GOAL_REVALIDATION_UNAVAILABLE: no active owned Goal is available.");
    }
    if (!task.goal_id || task.goal_id !== goal.id) {
      throw new Error("TASK_GOAL_MISMATCH: a Task cannot be rebound to an unrelated Goal.");
    }
    if (goal.revision !== expectedGoalRevision) {
      throw new Error(`GOAL_STALE_REVISION: expected ${expectedGoalRevision}, current ${goal.revision}; read the Goal again before revalidation.`);
    }
    const fingerprint = goalDefinitionFingerprint(goal);
    if (task.goal_definition_sha256 === fingerprint) {
      throw new Error("TASK_REVALIDATION_NOT_REQUIRED: Task already binds the current material Goal definition.");
    }
    const now = new Date().toISOString();
    const checks = task.blocking_checks.length > 0
      ? task.blocking_checks.map((check) => ({ ...check, passed: false }))
      : [{ name: "Fresh Goal-definition acceptance check", passed: false,
           detail: "Verify this Task's result under the current Goal definition." }];
    const next: DurableTask = {
      ...task,
      goal_definition_sha256: fingerprint,
      blocking_checks: checks,
      advisory_checks: task.advisory_checks.map((check) => ({ ...check, passed: false })),
      observed_checks: [],
      current_step: "Revalidate Task against the current Goal definition; rerun all blocking checks.",
      notes: [...task.notes, `A1.1 Goal definition revalidation at Goal revision ${goal.revision}: previous passed checks are historical only.`].slice(-MAX_LIST_ITEMS),
      next_actions: [...task.next_actions, "Rerun all blocking checks and any required visual review against current user requirements."].slice(-MAX_LIST_ITEMS),
      checkpoint_no: task.checkpoint_no + 1,
      updated_at: now,
      last_mutation_at: now,
      recent_events: [...task.recent_events, {
        time: now, kind: "progress",
        summary: "Material Goal definition revalidation; previous acceptance checks invalidated.",
      } satisfies TaskEvent].slice(-MAX_EVENTS),
    };
    delete next.visual_review;
    await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
    notifyStateInvalidated(workspaceRoot);
    await setActiveTaskId(workspaceRoot, currentSessionId(), taskId);
    await recordTaskChange(workspaceRoot, "goal-definition-revalidated", next);
    return next;
  }));
}

export async function resolveDurableTask(
  workspaceRoot: string,
  taskId?: string,
  sessionId?: string
): Promise<DurableTask> {
  const session = sessionId ?? currentSessionId();
  if (taskId) {
    // Controlled resolution is allowed to supply an explicit session when no
    // RuntimeScope exists. Read raw state only here, then authorize against
    // that resolved session before returning anything.
    const task = await readDurableTaskRecord(workspaceRoot, taskId);
    assertDurableTaskAccessible(task, session);
    return task;
  }
  const activeId = await getActiveTaskId(workspaceRoot, session);
  const activeGoal = await getGoal(workspaceRoot, session);
  const matchesGoal = (task: DurableTask) => !activeGoal || !task.goal_id || task.goal_id === activeGoal.id;
  if (activeId) {
    try {
      const task = await readDurableTaskRecord(workspaceRoot, activeId);
      if (taskVisibleToSession(task, session) && matchesGoal(task) && (task.status === "active" || task.status === "blocked")) return task;
    } catch {}
  }
  const recent = await listDurableTasks(workspaceRoot, { limit: 20, sessionId: session });
  const resumable = recent.find(
    (task) =>
      (task.status === "active" || task.status === "blocked") &&
      taskVisibleToSession(task, session) && matchesGoal(task) &&
      (!activeGoal || Boolean(task.goal_id) || task.created_at >= activeGoal.created_at)
  );
  if (!resumable) throw new Error("No active task. Create one with task_state action=create.");
  await setActiveTaskId(workspaceRoot, session, resumable.id);
  return resumable;
}

export async function checkpointDurableTask(
  workspaceRoot: string,
  taskId: string | undefined,
  input: {
    current_step?: string;
    done?: string[];
    decisions?: string[];
    blockers?: string[];
    resolved_blockers?: string[];
    blocked_reason?: { code: string; message: string };
    next_actions?: string[];
    artifacts?: string[];
    notes?: string[];
    blocking_checks?: TaskCheck[];
    advisory_checks?: TaskCheck[];
    visual_required?: boolean;
  }
): Promise<DurableTask> {
  const task = await resolveDurableTask(workspaceRoot, taskId);
  return withWorkspaceLock(workspaceRoot, async () => {
    const current = await getDurableTask(workspaceRoot, task.id);
    if (current.status === "completed" || current.status === "cancelled") {
      throw new Error(`Cannot checkpoint task: task is already ${current.status}.`);
    }
    const now = new Date().toISOString();
    const next: DurableTask = {
      ...current,
      current_step: cleanString(input.current_step, 2000) ?? current.current_step,
      done: appendUnique(current.done, input.done),
      decisions: appendUnique(current.decisions, input.decisions),
      blockers: appendUnique(removeStrings(current.blockers, input.resolved_blockers), input.blockers),
      next_actions: appendUnique([], input.next_actions, 12),
      artifacts: appendUnique(current.artifacts, input.artifacts, 40),
      notes: appendUnique(current.notes, input.notes, 40),
      blocking_checks: mergeChecks(current.blocking_checks, input.blocking_checks),
      advisory_checks: mergeChecks(current.advisory_checks, input.advisory_checks),
      visual_required: input.visual_required ?? current.visual_required,
      ...(input.blocked_reason
        ? {
            blocked: {
              code: assertBlockerCode(input.blocked_reason.code),
              message: cleanString(input.blocked_reason.message, 1000) ?? "blocked",
              since: now,
            },
          }
        : input.resolved_blockers?.length
          ? { blocked: undefined }
          : {}),
      checkpoint_no: current.checkpoint_no + 1,
      updated_at: now,
      recent_events: [
        ...current.recent_events,
        {
          time: now,
          kind: "progress",
          summary: cleanString(input.current_step, 500) ?? `Checkpoint ${current.checkpoint_no + 1}`,
        } satisfies TaskEvent,
      ].slice(-MAX_EVENTS),
    };
    await atomicWriteJson(taskPath(workspaceRoot, next.id), next);
    await setActiveTaskId(workspaceRoot, currentSessionId(), next.id);
    notifyStateInvalidated(workspaceRoot);
    await recordTaskChange(workspaceRoot, "checkpoint", next);
    return next;
  });
}

export function taskHandoff(task: DurableTask): TaskHandoff {
  return {
    task_id: task.id,
    goal: task.goal,
    ...(task.goal_id ? { goal_id: task.goal_id } : {}),
    ...(task.goal_definition_sha256 ? { goal_definition_sha256: task.goal_definition_sha256 } : {}),
    ...(task.goal_id && !task.goal_definition_sha256 ? { goal_definition_revalidation_required: true } : {}),
    status: task.status,
    current_step: task.current_step,
    done: task.done.slice(-10),
    decisions: task.decisions.slice(-8),
    blockers: task.blockers.slice(-8),
    next_actions: task.next_actions.slice(0, 8),
    changed_files: task.changed_files.slice(-16),
    artifacts: task.artifacts.slice(-16),
    blocking_remaining: task.blocking_checks.filter((check) => !check.passed).length,
    ...(task.completion_basis ? { completion_basis: task.completion_basis } : {}),
    advisory_remaining: task.advisory_checks.filter((check) => !check.passed).length,
    ...(task.blocked ? { blocked: task.blocked } : {}),
    observed_checks: task.observed_checks.slice(-12),
    ...(task.last_failure ? { last_failure: task.last_failure } : {}),
    recent_events: task.recent_events.slice(-8),
    project_roots: task.project_roots,
    project_scope_locked: task.project_scope_locked,
    ...(task.owner_session ? { owner_session: task.owner_session } : {}),
    checkpoint_no: task.checkpoint_no,
    visual_required: task.visual_required,
    ...(task.last_mutation_at ? { last_mutation_at: task.last_mutation_at } : {}),
    ...(task.visual_review ? { visual_review: task.visual_review } : {}),
    updated_at: task.updated_at,
  };
}

function resultPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  return structured && typeof structured === "object" ? structured as Record<string, unknown> : null;
}

function objectValue(source: unknown, key: string): unknown {
  return source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;
}

function extractPaths(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractPaths(item, depth + 1));
  if (typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["path", "source", "destination", "output_path", "full_output_path", "saved_to", "staging_path"].includes(key) && typeof nested === "string") {
      out.push(nested);
    } else if (["files", "artifacts", "data", "output_paths", "page_paths", "focus_paths", "images_returned"].includes(key)) {
      out.push(...extractPaths(nested, depth + 1));
    }
  }
  return [...new Set(out)].slice(0, 20);
}

function extractScopePaths(value: unknown, depth = 0): string[] {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) return value.flatMap((item) => extractScopePaths(item, depth + 1));
  if (typeof value !== "object") return [];
  const out: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (["path", "source", "destination", "working_directory", "cwd", "target"].includes(key) && typeof nested === "string") {
      out.push(nested);
    } else if (["files", "data", "images_returned"].includes(key)) {
      out.push(...extractScopePaths(nested, depth + 1));
    }
  }
  return [...new Set(out)].slice(0, 20);
}

function observationEvidenceKind(tool: string, data: Record<string, unknown>): HarnessEvidenceKind {
  if (tool === "visual_review" && (data.action === "assess" || data.model_visual_assessment)) return "model_assessed";
  if (["run_command", "start_process", "process_output", "process_input", "stop_process", "render_svg", "capture_webpage", "visual_review"].includes(tool)) {
    return "runtime";
  }
  return "deterministic";
}

function observedCheck(command: string | undefined, passed: boolean, detail: string): TaskCheck | null {
  if (!command) return null;
  const normalized = command.toLowerCase();
  let name: string | null = null;
  if (/\b(test|pytest|vitest|jest|cargo test|go test|mvn test|gradle test)\b/.test(normalized)) name = "tests";
  else if (/\b(build|compile|tsc|cargo build|go build)\b/.test(normalized)) name = "build";
  else if (/\b(lint|eslint|ruff|clippy)\b/.test(normalized)) name = "lint";
  else if (/\b(format|prettier|gofmt|rustfmt)\b/.test(normalized)) name = "format";
  if (!name) return null;
  return { name, passed, detail: detail.slice(0, 1000) };
}

const MUTATING_TOOLS = new Set([
  "write_file",
  "write_file_base64",
  "save_chatgpt_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "delete_file",
  "copy_file",
  "move_file",
]);

const HIGH_VALUE_OBSERVATION_TOOLS = new Set([
  ...MUTATING_TOOLS,
  "run_command",
  "start_process",
  "process_output",
  "stop_process",
  "open_image",
  "render_svg",
  "capture_webpage",
  "visual_review",
]);

const ARTIFACT_TOOLS = new Set([
  "run_command",
  "start_process",
  "process_output",
  "open_image",
  "render_svg",
  "capture_webpage",
  "visual_review",
]);

const MAX_ARTIFACT_HASH_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_REFS = 4;

// Content-addressed artifact references for the event mirror: events carry
// {path, sha256, bytes} only, never file content. Best-effort — unhashable
// artifacts keep their plain path entry.
async function hashArtifactFiles(paths: string[]): Promise<Array<{ path: string; sha256: string; bytes: number }>> {
  const refs: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const candidate of paths.slice(0, MAX_ARTIFACT_REFS)) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_HASH_BYTES) continue;
      const digest = createHash("sha256").update(await fs.readFile(candidate)).digest("hex");
      refs.push({ path: candidate, sha256: digest, bytes: stat.size });
    } catch {}
  }
  return refs;
}

const VISUAL_EXTENSIONS = new Set([
  ".svg", ".html", ".htm", ".css", ".scss", ".sass", ".less",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".pdf", ".pptx", ".docx",
]);

function looksLikeVisualMutation(tool: string, paths: string[], command?: string): boolean {
  if (MUTATING_TOOLS.has(tool) && paths.some((candidate) => VISUAL_EXTENSIONS.has(path.extname(candidate).toLowerCase()))) {
    return true;
  }
  if (tool !== "run_command" && tool !== "start_process") return false;
  const normalized = (command || "").toLowerCase();
  return /\.(svg|html?|css|scss|sass|less|png|jpe?g|webp|gif|pdf|pptx|docx)\b/.test(normalized) ||
    /\b(vite|webpack|next\s+build|astro|storybook|playwright|puppeteer)\b/.test(normalized);
}

export async function recordToolObservation(
  workspaceRoot: string,
  tool: string,
  args: unknown,
  result?: unknown,
  thrownError?: unknown
): Promise<void> {
  if (tool === "task_state" || tool.startsWith("task_")) return;
  const session = currentSessionId();
  const taskId = await getActiveTaskId(workspaceRoot, session);
  if (!taskId) return;

  await withWorkspaceLock(workspaceRoot, async () => {
    let task: DurableTask;
    const invocationScope = getRuntimeScope();
    if (invocationScope && Object.prototype.hasOwnProperty.call(invocationScope, "goalId")) {
      try {
        const currentGoal = await getGoal(workspaceRoot, invocationScope.mcpSessionId);
        if (currentGoal?.id !== invocationScope.goalId ||
            currentGoal?.owner_session !== invocationScope.goalOwnerSessionId) return;
      } catch { return; }
    }
    try {
      task = await getDurableTask(workspaceRoot, taskId);
    } catch (error) {
      if (error instanceof DurableTaskAccessError) return;
      if ((await getActiveTaskId(workspaceRoot, session)) === taskId) await setActiveTaskId(workspaceRoot, session, null);
      return;
    }
    // Session scoping: never write observations into another window's task.
    if (!taskVisibleToSession(task, session)) return;
    if (task.status !== "active" && task.status !== "blocked") return;

    const payload = resultPayload(result);
    const data = payload?.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
    const ok = thrownError === undefined && objectValue(result, "isError") !== true && payload?.ok !== false;
    const content = objectValue(result, "content");
    const errorText = !ok && Array.isArray(content) ? content.find((item) => item?.type === "text")?.text : undefined;
    const summary = cleanString(
      thrownError instanceof Error ? thrownError.message : thrownError !== undefined ? String(thrownError) : payload?.summary ?? errorText,
      300
    ) ?? `${tool}: ${ok ? "done" : "failed"}`;
    const command = cleanString(objectValue(args, "command") ?? data.command, 200) ?? undefined;
    const exitCode = typeof data.exit_code === "number" || data.exit_code === null ? data.exit_code as number | null : undefined;
    const paths = [...new Set([...extractPaths(args), ...extractPaths(data)])];
    const scopePaths = [...new Set([...extractScopePaths(args), ...extractScopePaths(data)])];
    let projectRoots = task.project_roots.length ? task.project_roots : [path.resolve(workspaceRoot)];
    let projectScopeLocked = task.project_scope_locked;
    if (!projectScopeLocked && scopePaths.some((candidate) => path.isAbsolute(candidate))) {
      const inferred = await inferProjectRootsFromPaths(scopePaths, workspaceRoot);
      if (inferred.length) {
        projectRoots = inferred;
        projectScopeLocked = true;
      }
    }
    const absoluteScopePaths = scopePaths.filter((candidate) => path.isAbsolute(candidate));
    if (projectScopeLocked && absoluteScopePaths.length > 0 && !absoluteScopePaths.some((candidate) => isPathWithinRoots(candidate, projectRoots))) {
      return;
    }
    const scopedPaths = paths.filter((candidate) => !path.isAbsolute(candidate) || isPathWithinRoots(candidate, projectRoots));
    const keyLines = Array.isArray(data.key_lines)
      ? data.key_lines.map((line) => cleanString(line, 500)).filter((line): line is string => Boolean(line)).slice(0, 4)
      : [];
    const evidence = cleanString(keyLines.join(" | "), 1200) ?? summary;
    const running = typeof data.running === "boolean" ? data.running : undefined;
    const canObserveCheck = tool === "run_command" || (tool === "process_output" && running === false && exitCode !== undefined);
    const check = canObserveCheck
      ? observedCheck(command, ok && exitCode === 0, evidence)
      : null;
    if (ok && !HIGH_VALUE_OBSERVATION_TOOLS.has(tool) && !check) return;

    const artifactPaths = ARTIFACT_TOOLS.has(tool)
      ? paths.filter((candidate) =>
          candidate === data.full_output_path ||
          candidate === data.output_path ||
          tool === "open_image" ||
          tool === "render_svg" ||
          tool === "capture_webpage" ||
          tool === "visual_review"
        )
      : [];
    const artifactRefs = await hashArtifactFiles(artifactPaths);
    const now = new Date().toISOString();
    const visualMutation = ok && looksLikeVisualMutation(tool, scopedPaths, command);
    const reviewId = typeof data.review_id === "string" ? data.review_id : undefined;
    const target = cleanString(data.target, 2000);
    const visualReview = ok && tool === "visual_review" && reviewId && typeof data.visual_status === "string"
      ? {
          review_id: reviewId,
          target: target || "visual artifact",
          kind: cleanString(data.kind, 100) || "unknown",
          reviewed_at: now,
          visual_status: String(data.visual_status),
          machine_ready: !Array.isArray(data.machine_blocking_issues) || data.machine_blocking_issues.length === 0,
          blocking_issues: Array.isArray(data.machine_blocking_issues)
            ? data.machine_blocking_issues.map((item) => cleanString(item, 1000)).filter((item): item is string => Boolean(item)).slice(0, 20)
            : [],
          ...(target && !/^https?:\/\//i.test(target) ? { source_path: target } : {}),
          ...(typeof data.source_signature === "string" ? { source_signature: data.source_signature } : {}),
        } satisfies TaskVisualReview
      : undefined;
    const event: TaskEvent = {
      time: now,
      kind: ok ? "tool" : "failure",
      summary: ok ? summary : evidence === summary ? summary : `${summary}: ${evidence}`,
      tool,
      ok,
      ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
      ...(scopedPaths.length ? { paths: scopedPaths.slice(0, 8) } : {}),
    };
    const next: DurableTask = {
      ...task,
      changed_files: MUTATING_TOOLS.has(tool)
        ? appendUnique(task.changed_files, scopedPaths, MAX_CHANGED_FILES)
        : task.changed_files,
      artifacts: appendUnique(task.artifacts, artifactPaths, 40),
      observed_checks: check ? mergeChecks(task.observed_checks, [check]) : task.observed_checks,
      recent_events: [...task.recent_events, event].slice(-MAX_EVENTS),
      project_roots: projectRoots,
      project_scope_locked: projectScopeLocked,
      updated_at: now,
      visual_required: task.visual_required || visualMutation || Boolean(visualReview),
      ...(visualMutation ? { last_mutation_at: now } : {}),
      ...(visualReview ? { visual_review: visualReview } : {}),
      ...(ok
        ? {}
        : {
            last_failure: {
              time: now,
              tool,
              summary: evidence === summary ? summary : `${summary}: ${evidence}`,
              ...(command ? { command } : {}),
              ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
            } satisfies TaskFailure,
          }),
    };
    await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
    await setActiveTaskId(workspaceRoot, currentSessionId(), taskId);
    // Observation mutations (recent_events/observed_checks/changed_files) do
    // not alter any field the broker snapshot renders, so no invalidation here.
    const evidenceKind = observationEvidenceKind(tool, data);
    await appendHarnessEventSafe(workspaceRoot, {
      type: "tool/observation",
      project_roots: next.project_roots,
      task_id: taskId,
      evidence_kind: evidenceKind,
      data: {
        tool,
        ok,
        summary,
        ...(command ? { command } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(scopedPaths.length ? { paths: scopedPaths.slice(0, 8) } : {}),
        ...(artifactRefs.length ? { artifacts: artifactRefs } : {}),
      },
    });
    if (check || evidenceKind === "model_assessed") {
      await appendHarnessEventSafe(workspaceRoot, {
        type: "evidence/recorded",
        project_roots: next.project_roots,
        task_id: taskId,
        evidence_kind: evidenceKind,
        data: {
          source_tool: tool,
          ...(check ? { check } : {}),
          summary: evidence,
        },
      });
    }
    // Observation-driven task mutations are mirrored as slim tool/observation
    // events; whole-value task/change stays reserved for explicit state changes
    // (create/update/checkpoint/complete) so the log cannot grow 10KB per call.
  });
}

export async function completeDurableTask(workspaceRoot: string, taskId: string, note?: string): Promise<DurableTask> {
  return withGoalTaskDefinitionFence(workspaceRoot, () => withWorkspaceLock(workspaceRoot, async () => {
  const task = await getDurableTask(workspaceRoot, taskId);
  if (task.status === "completed" || task.status === "cancelled") throw new Error(`Cannot complete task: task is already ${task.status}.`);
  const unmetChecks = [...task.blocking_checks, ...task.advisory_checks].filter((check) => !check.passed);
  const now = new Date().toISOString();
  const next: DurableTask = {
    ...task,
    status: "completed",
    completion_basis: { declaration: note?.trim() || "Model declared task complete", declared_at: now, verification: "model_declared", unmet_checks: unmetChecks },
    current_step: "Model declared complete",
    notes: note?.trim() ? [...task.notes, note.trim()] : task.notes,
    updated_at: now,
    completed_at: now,
  };
  delete next.blocked;
  await atomicWriteJson(taskPath(workspaceRoot, taskId), next);
  notifyStateInvalidated(workspaceRoot);
  if ((await getActiveTaskId(workspaceRoot, currentSessionId())) === taskId) {
    await setActiveTaskId(workspaceRoot, currentSessionId(), null);
  }
  await recordTaskChange(workspaceRoot, "update", next);
  return next;
  }));
}

export async function listDurableTasks(
  workspaceRoot: string,
  options?: { status?: DurableTaskStatus; limit?: number; sessionId?: string }
): Promise<DurableTask[]> {
  // sessionId is an internal resolution selector; ordinary Task tools never
  // expose it and therefore retain ambient RuntimeScope authorization.
  const session = options?.sessionId ?? currentSessionId();
  const dir = durableTaskDir(workspaceRoot);
  let names: string[];
  try {
    names = (await fs.readdir(dir)).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name));
  } catch {
    return [];
  }

  const tasks: DurableTask[] = [];
  for (const name of names) {
    try {
      const task = normalizeTask(JSON.parse(await fs.readFile(path.join(dir, name), "utf-8")) as DurableTask, workspaceRoot);
      if (!taskVisibleToSession(task, session)) continue;
      if (!options?.status || task.status === options.status) tasks.push(task);
    } catch {}
  }
  tasks.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return tasks.slice(0, Math.max(1, Math.min(options?.limit ?? 20, 100)));
}
