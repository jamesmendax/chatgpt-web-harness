import path from "node:path";
import { getActiveTaskId, getDurableTask, taskHandoff, type TaskHandoff } from "./durable-tasks.js";
import { GOAL_CONTINUATION_SNAPSHOT, getGoal, goalSummary, goalVisibleToSession, type DurableGoal, type GoalSummary } from "./goal-state-store.js";
import { readHarnessEventTail, harnessRepairCount, type HarnessEvidenceKind } from "./harness-events.js";
import { inferProjectScope, isPathWithinRoot } from "./project-scope.js";
import { onStateInvalidated } from "./state-invalidate.js";
import { createRuntimeScope, getRuntimeScope, runWithRuntimeScope } from "./runtime-scope.js";
import { readGoalRun, type GoalRunEnvelope, type GoalRunProjectionParity } from "./goal-run-store.js";
import { renderGoalRunPolicyText } from "./goal-run-policy.js";
import { advanceGoalWorkHistory, goalWorkHistoryIsStalled, goalWorkObservation, type GoalWorkHistory, type GoalWorkObservation } from "./goal-work-progress.js";
import { getMcpRequestIdentity } from "./mcp-request-identity.js";
import { BoundedContextCache, boundedCacheEnv } from "./bounded-context-cache.js";


export interface BrokerEvidenceSummary {
  seq: number;
  time: string;
  kind: HarnessEvidenceKind;
  source_tool?: string;
  summary: string;
}

export interface HarnessRuntimeContext {
  conversation?: {
    identity_version: 2;
    continuity: "trusted" | "unknown" | "conflict";
    source: "openai/session" | "none" | "conflict";
    id?: string;
  };
  project_root?: string;
  goal?: GoalSummary;
  goal_run?: {
    run_id: string;
    revision: number;
    state: GoalRunEnvelope["run"]["state"];
    criteria_confirmed: number;
    criteria_total: number;
    remaining_criteria: string[];
    evidence_count: number;
    next_action: string | null;
    wait: {
      id: string;
      kind: "TOOL" | "EXTERNAL_PROCESS" | "USER";
      description: string;
      deadline_at: string;
      process_ref?: string;
      poll_interval_ms?: number;
    } | null;
    policy: string;
  };
  goal_run_issue?: {
    code:
      | "GOAL_RUN_AUTHORITY_MISSING"
      | "GOAL_RUN_AUTHORITY_PENDING"
      | "GOAL_RUN_STATE_UNREADABLE"
      | "GOAL_RUN_PROJECTION_REPAIR_PENDING";
    message: string;
    recovery: "status_once" | "stop";
  };
  task?: Pick<
    TaskHandoff,
    | "task_id"
    | "goal_id"
    | "status"
    | "current_step"
    | "blockers"
    | "next_actions"
    | "changed_files"
    | "blocking_remaining"
    | "advisory_remaining"
    | "project_roots"
    | "project_scope_locked"
    | "blocked"
  >;
  recent_evidence: BrokerEvidenceSummary[];
}

/**
 * Context Broker V2 (ported from DeepSeek Harness RuntimeContextProjection):
 * dynamic context is delivered as a superseding snapshot and only when the
 * snapshot actually changes (whole-text equality) or after a refresh interval.
 * Unchanged state costs zero tokens per tool call; a periodic refresh keeps
 * long conversations and new ChatGPT conversations informed.
 */

const SUPERSEDE_HEADER = "This harness context supersedes earlier harness context snapshots.";
const CLEARED_TEXT = `${SUPERSEDE_HEADER}\nHARNESS CONTEXT\nNo active goal or task.`;
const CONTEXT_BUDGET_CHARS = 1800;
const EVIDENCE_WINDOW = 24;

// Tools whose own results already carry state: no text snapshot, structured as before.
const SKIP_TEXT_FOR: ReadonlySet<string> = new Set([
  "goal",
  "task_state",
  "project_context",
  "agent_status",
  "list_skills",
  "load_skill",
  "remember",
]);

interface ContinuationTailOptions {
  toolName?: string;
  toolAction?: string;
  resultFailed?: boolean;
  repeatedResults?: number;
  repeatedForMs?: number;
  repeatedWorkStalled?: boolean;
}

/** A progress record, never an instruction to authorize actions or prolong a turn. */
function continuationTail(
  context: HarnessRuntimeContext,
  _streak: number,
  options: ContinuationTailOptions = {}
): string {
  const goal = context.goal!;
  const run = context.goal_run;
  const issue = context.goal_run_issue;
  const verified = run?.criteria_confirmed ?? goal.criteria_passed;
  const total = run?.criteria_total ?? goal.criteria_total;
  const status = run?.state ?? goal.status;
  const remaining = run?.remaining_criteria ?? goal.remaining_criteria;
  const parts = [`GOAL RECORD ${verified}/${total} verified; status=${status}.`];
  if (remaining?.length) parts.push(`Unmet checks: ${remaining.slice(0, 3).map(item => truncateForSnapshot(item, 110)).join("; ")}.`);
  if (issue) parts.push(`Record issue [${issue.code}]: ${truncateForSnapshot(issue.message, 220)}.`);
  if (context.task) parts.push(`Task record: ${context.task.status}.`);
  if ((options.repeatedResults ?? 0) > 0) {
    parts.push(`Matching work fingerprint: repeats=${options.repeatedResults}, observation_window_ms=${options.repeatedForMs ?? 0}; this observation does not prove a stall.`);
  }
  parts.push("Completion declarations do not verify unmet checks. These records do not block tool use or delivery.");
  return parts.join(" ");
}

interface CoreState {
  goal: DurableGoal | null;
  goalRun: GoalRunEnvelope | null;
  goalRunError: string | null;
  task: Awaited<ReturnType<typeof getDurableTask>> | null;
  activeTaskId: string | null;
}

function isProjectionParity(value: GoalRunEnvelope["parity"]): value is GoalRunProjectionParity {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "projection"
  );
}

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

export interface HarnessContextNamespace {
  principalId?: string;
  tunnelProfile?: string;
}

function scopeCacheKey(workspaceRoot: string, sessionId?: string, namespace?: HarnessContextNamespace): string {
  const scope = getRuntimeScope();
  const owner = namespace ?? scope;
  return `${workspaceKey(workspaceRoot)}::${JSON.stringify([owner?.principalId ?? "local", owner?.tunnelProfile ?? "default", sessionId ?? "legacy"])}`;
}

const contextCacheCapacity = () => boundedCacheEnv("HARNESS_CONTEXT_CACHE_MAX_ENTRIES", 256, 1, 4096);
const contextCacheIdleMs = () => boundedCacheEnv("HARNESS_CONTEXT_CACHE_IDLE_MS", 30 * 60_000, 1, 7 * 24 * 60 * 60_000);

function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((a) => right.some((b) => isPathWithinRoot(a, b) || isPathWithinRoot(b, a)));
}

function cleanSummary(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 500) : fallback;
}

function stateCacheTtlMs(): number {
  const parsed = Number.parseInt(process.env.HARNESS_STATE_CACHE_TTL_MS || "2000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;
}

function snapshotRefreshMs(): number {
  const parsed = Number.parseInt(process.env.HARNESS_CONTEXT_REFRESH_MS || "300000", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300000;
}

async function getTaskForSession(workspaceRoot: string, taskId: string, sessionId?: string): Promise<Awaited<ReturnType<typeof getDurableTask>>> {
  const current = getRuntimeScope();
  if (current?.mcpSessionId === sessionId) return getDurableTask(workspaceRoot, taskId);

  // buildHarnessRuntimeContext is also a direct projection API used by
  // diagnostics/tests with an explicit session id and no active invocation
  // scope. Re-enter only that requested identity so getDurableTask's normal
  // current-session authorization remains the single access check.
  if (!sessionId && !current?.mcpSessionId) return getDurableTask(workspaceRoot, taskId);
  const projectedScope = createRuntimeScope(
    {
      tunnelProfile: current?.tunnelProfile,
      principalId: current?.principalId,
      workspaceRoot: current?.workspaceRoot ?? workspaceRoot,
      projectRoots: current?.projectRoots ?? [workspaceRoot],
      deadlineAt: current?.deadlineAt,
    },
    {
      sessionId,
      signal: current?.signal,
      requestId: current?.requestId,
    }
  );
  return runWithRuntimeScope(projectedScope, () => getDurableTask(workspaceRoot, taskId));
}

async function loadCoreState(workspaceRoot: string, sessionId?: string): Promise<CoreState> {
  const [goal, goalRunRead, activeTaskId] = await Promise.all([
    getGoal(workspaceRoot),
    readGoalRun(workspaceRoot).then(
      (goalRun) => ({ goalRun, error: null as string | null }),
      (error: unknown) => ({
        goalRun: null,
        error: cleanSummary(error instanceof Error ? error.message : String(error), "GoalRun state is unreadable"),
      })
    ),
    getActiveTaskId(workspaceRoot, sessionId),
  ]);
  let task: CoreState["task"] = null;
  if (activeTaskId) {
    try {
      task = await getTaskForSession(workspaceRoot, activeTaskId, sessionId);
    } catch {}
  }
  return { goal, goalRun: goalRunRead.goalRun, goalRunError: goalRunRead.error, task, activeTaskId };
}

const coreStateCache = new BoundedContextCache<{ expires: number; promise: Promise<CoreState> }>(contextCacheCapacity, contextCacheIdleMs);

// Goal/task mutations drop the cache for their workspace immediately; the TTL
// only bounds staleness from external file edits.
onStateInvalidated((workspaceRoot) => {
  const prefix = `${workspaceKey(workspaceRoot)}::`;
  for (const key of [...coreStateCache.keys()]) {
    if (key.startsWith(prefix)) coreStateCache.delete(key);
  }
});

function getCachedCoreState(workspaceRoot: string, sessionId?: string): Promise<CoreState> {
  const key = scopeCacheKey(workspaceRoot, sessionId);
  const now = Date.now();
  const cached = coreStateCache.get(key);
  if (cached && cached.expires > now) return cached.promise;
  const promise = loadCoreState(workspaceRoot, sessionId);
  const entry = { expires: now + stateCacheTtlMs(), promise };
  coreStateCache.set(key, entry);
  void promise.catch(() => {
    if (coreStateCache.peek(key) === entry) coreStateCache.delete(key);
  });
  return promise;
}

interface EvidenceWindowItem extends BrokerEvidenceSummary {
  task_id?: string;
  project_roots?: string[];
}

interface EvidenceWindow {
  items: EvidenceWindowItem[];
  offset: number;
  repairs: number;
  fileIdentity?: string;
}

interface EvidenceWindowEntry { window: EvidenceWindow; pending?: Promise<EvidenceWindowItem[]> }
const evidenceWindows = new BoundedContextCache<EvidenceWindowEntry>(contextCacheCapacity, contextCacheIdleMs);

async function refreshEvidenceWindow(workspaceRoot: string, sessionId?: string): Promise<EvidenceWindowItem[]> {
  const key = scopeCacheKey(workspaceRoot, sessionId);
  let entry = evidenceWindows.get(key);
  if (entry?.pending) return entry.pending;
  const generation = harnessRepairCount(workspaceRoot);
  if (!entry) {
    entry = { window: { items: [], offset: 0, repairs: generation } };
    evidenceWindows.set(key, entry);
  }
  const currentEntry = entry;
  const win = { ...entry.window, items: [...entry.window.items] };
  if (win.repairs !== generation) {
    // The log was rewritten (migration/repair/quarantine): byte offsets no
    // longer mean anything — rescan from the start.
    win.items = [];
    win.offset = 0;
    win.repairs = generation;
  }
  const pending = (async () => { try {
    const tail = await readHarnessEventTail(workspaceRoot, win.offset, {
      limit: EVIDENCE_WINDOW, type: "evidence/recorded", require_evidence_kind: true, file_identity: win.fileIdentity,
    });
    if (tail.reset) win.items = [];
    for (const event of tail.events) {
      if (event.type !== "evidence/recorded" || !event.evidence_kind) continue;
      win.items.push({
        seq: event.seq,
        time: event.time,
        kind: event.evidence_kind,
        ...(typeof event.data.source_tool === "string" ? { source_tool: event.data.source_tool } : {}),
        summary: cleanSummary(event.data.summary, event.type),
        ...(event.task_id ? { task_id: event.task_id } : {}),
        ...(event.project_roots?.length ? { project_roots: event.project_roots } : {}),
      });
    }
    win.offset = tail.next_offset;
    win.fileIdentity = tail.file_identity;
    if (win.items.length > EVIDENCE_WINDOW) win.items = win.items.slice(-EVIDENCE_WINDOW);
    if (evidenceWindows.peek(key) === currentEntry) currentEntry.window = win;
  } catch {
    // Evidence is advisory; a failed incremental read keeps the last window.
  }
  return win.items;
  })();
  currentEntry.pending = pending;
  try { return await pending; }
  finally { if (currentEntry.pending === pending) currentEntry.pending = undefined; }
}

export async function buildHarnessRuntimeContext(
  workspaceRoot: string,
  projectRoot?: string,
  sessionId?: string
): Promise<HarnessRuntimeContext> {
  const currentScope = getRuntimeScope();
  const effectiveSessionId = sessionId ?? currentScope?.mcpSessionId;
  const resolvedProject = projectRoot ? path.resolve(projectRoot) : undefined;
  const core = await getCachedCoreState(workspaceRoot, effectiveSessionId);

  let taskContext: HarnessRuntimeContext["task"];
  let taskId: string | undefined;
  let taskRoots: string[] = [];
  if (core.task) {
    // Session scoping: another ChatGPT window's task is invisible here.
    const taskVisible = !core.task.owner_session || core.task.owner_session === effectiveSessionId;
    if (taskVisible && (!resolvedProject || scopesOverlap(core.task.project_roots, [resolvedProject]))) {
      const handoff = taskHandoff(core.task);
      taskId = core.task.id;
      taskRoots = core.task.project_roots;
      taskContext = {
        task_id: handoff.task_id,
        ...(handoff.goal_id ? { goal_id: handoff.goal_id } : {}),
        status: handoff.status,
        current_step: handoff.current_step,
        blockers: handoff.blockers,
        next_actions: handoff.next_actions,
        changed_files: handoff.changed_files,
        blocking_remaining: handoff.blocking_remaining,
        advisory_remaining: handoff.advisory_remaining,
        project_roots: handoff.project_roots,
        project_scope_locked: handoff.project_scope_locked,
        ...(handoff.blocked ? { blocked: handoff.blocked } : {}),
      };
    }
  }

  let goalContext: GoalSummary | undefined;
  let goalRunContext: HarnessRuntimeContext["goal_run"];
  let goalRunIssue: HarnessRuntimeContext["goal_run_issue"];
  if (core.goal) {
    const scope = await inferProjectScope(workspaceRoot, [core.goal.objective, core.goal.current_phase, ...core.goal.constraints]);
    if ((!resolvedProject || scopesOverlap(scope.roots, [resolvedProject])) && goalVisibleToSession(core.goal, effectiveSessionId)) {
      goalContext = goalSummary(core.goal);
      if (core.goalRunError) {
        goalRunIssue = {
          code: "GOAL_RUN_STATE_UNREADABLE",
          message: core.goalRunError,
          recovery: "stop",
        };
      } else if (core.goalRun?.shadow === false && core.goalRun.run.runId === core.goal.id) {
        const run = core.goalRun.run;
        const parity = core.goalRun.parity;
        const projectionNeedsRepair =
          isProjectionParity(parity) &&
          (parity.repairPending || parity.mismatch !== null);
        const terminalProjectionMismatch = run.state === "COMPLETED" && core.goal.status !== "completed";
        if (projectionNeedsRepair || terminalProjectionMismatch) {
          goalRunIssue = {
            code: "GOAL_RUN_PROJECTION_REPAIR_PENDING",
            message: "The authoritative GoalRun and legacy compatibility projection are not yet reconciled.",
            recovery: "status_once",
          };
        } else {
          const remaining = run.criteria.filter((criterion) => !criterion.confirmed);
          const wait = run.waitCondition;
          goalRunContext = {
            run_id: run.runId,
            revision: run.revision,
            state: run.state,
            criteria_confirmed: run.criteria.length - remaining.length,
            criteria_total: run.criteria.length,
            remaining_criteria: remaining.map((criterion) => criterion.description),
            evidence_count: run.typedEvidence.length,
            next_action: run.nextAction,
            wait: wait
              ? {
                  id: wait.id,
                  kind: wait.kind,
                  description: wait.description,
                  deadline_at: wait.deadlineAt,
                  ...(wait.kind === "EXTERNAL_PROCESS"
                    ? { process_ref: wait.processRef, poll_interval_ms: wait.pollIntervalMs }
                    : {}),
                }
              : null,
            policy: renderGoalRunPolicyText(run, { maxBytes: 1100, maxPolicyBytes: 360 }),
          };
        }
      } else {
        goalRunIssue = core.goalRun
          ? {
              code: "GOAL_RUN_AUTHORITY_PENDING",
              message: "The stored GoalRun is still a shadow or belongs to a different run; inspect status and explicitly reconcile owned state before production work.",
              recovery: "status_once",
            }
          : {
              code: "GOAL_RUN_AUTHORITY_MISSING",
              message: "No authoritative GoalRun envelope exists for this active legacy Goal.",
              recovery: "status_once",
            };
      }
    }
  }

  const projectForEvidence = resolvedProject ?? taskRoots[0];
  // Evidence is task-scoped. A context without a visible task cannot safely
  // distinguish another session's task events, so it receives no evidence.
  const recentEvidence = taskId
    ? (await refreshEvidenceWindow(workspaceRoot, effectiveSessionId))
        .filter((item) => item.task_id === taskId)
        .filter((item) => !projectForEvidence || scopesOverlap(item.project_roots ?? [], [projectForEvidence]))
        .slice(-5)
        .map(({ task_id: _taskId, project_roots: _roots, ...summary }) => summary)
    : [];

  return {
    ...(currentScope ? { conversation: {
      identity_version: 2 as const,
      continuity: currentScope.conversationContinuity ?? "unknown",
      source: currentScope.conversationContinuity === "trusted" ? "openai/session" as const
        : currentScope.conversationContinuity === "conflict" ? "conflict" as const : "none" as const,
      ...(currentScope.conversationSessionId ? { id: currentScope.conversationSessionId } : {}),
    } } : {}),
    ...(resolvedProject ? { project_root: resolvedProject } : {}),
    ...(goalContext ? { goal: goalContext } : {}),
    ...(goalRunContext ? { goal_run: goalRunContext } : {}),
    ...(goalRunIssue ? { goal_run_issue: goalRunIssue } : {}),
    ...(taskContext ? { task: taskContext } : {}),
    recent_evidence: recentEvidence,
  };
}

interface RenderLimits {
  evidence: number;
  nextActions: number;
  remaining: number;
}

const RENDER_LADDER: RenderLimits[] = [
  { evidence: 3, nextActions: 3, remaining: 5 },
  { evidence: 2, nextActions: 2, remaining: 3 },
  { evidence: 1, nextActions: 1, remaining: 2 },
  { evidence: 0, nextActions: 1, remaining: 0 },
];

function renderSnapshot(context: HarnessRuntimeContext, limits: RenderLimits): string {
  const lines: string[] = [];
  // Goal block renders BEFORE the task block: head-preserving truncation must
  // never be able to cut the continuation contract or the goal state away.
  if (context.goal) {
    if (context.goal.status === "active") {
      lines.push("GOAL WORK RECORD: optional progress/evidence; unmet criteria remain recorded and do not block tools.");
    }
    lines.push(`ACTIVE GOAL: ${truncateForSnapshot(context.goal.objective, 300)}`);
    lines.push(`Phase: ${truncateForSnapshot(context.goal.current_phase, 200)} | status: ${context.goal.status}`);
    lines.push(
      `Success criteria: ${context.goal_run
        ? `${context.goal_run.criteria_confirmed}/${context.goal_run.criteria_total} confirmed by typed evidence`
        : `${context.goal.criteria_passed}/${context.goal.criteria_total} passed`}`
    );
    if (context.goal_run_issue) {
      lines.push(
        `GoalRun issue: [${context.goal_run_issue.code}] ${truncateForSnapshot(context.goal_run_issue.message, 240)}`
      );
    } else if (context.goal_run) {
      lines.push(`GoalRun state: ${context.goal_run.state}`);
      if (context.goal_run.wait) {
        lines.push(
          `Wait: ${context.goal_run.wait.kind}/${truncateForSnapshot(context.goal_run.wait.id, 100)} until ${context.goal_run.wait.deadline_at}`
        );
      }
    }
    // Never render an empty remaining list as "none": with unmet criteria that
    // would read as a false all-clear and invite premature completion claims.
    const remaining = (context.goal_run?.remaining_criteria ?? context.goal.remaining_criteria).slice(0, limits.remaining);
    if (remaining.length) lines.push(`Remaining: ${remaining.map((name) => truncateForSnapshot(name, 160)).join("; ")}`);
  }
  if (context.task) {
    lines.push(`Task: ${context.task.task_id} (${context.task.status})`);
    lines.push(`Step: ${truncateForSnapshot(context.task.current_step, 200)}`);
    lines.push(`Blocking checks remaining: ${context.task.blocking_remaining}`);
    if (context.task.blockers.length) {
      lines.push(`Blockers: ${context.task.blockers.slice(-3).map((blocker) => truncateForSnapshot(blocker, 160)).join("; ")}`);
    }
    if (context.task.blocked) lines.push(`Blocked: [${context.task.blocked.code}] ${truncateForSnapshot(context.task.blocked.message, 200)}`);
    if (context.task.next_actions.length) {
      lines.push(`Next: ${context.task.next_actions.slice(0, limits.nextActions).map((action) => truncateForSnapshot(action, 160)).join("; ")}`);
    }
  }
  if (limits.evidence > 0 && context.recent_evidence.length) {
    lines.push("Recent evidence:");
    for (const item of context.recent_evidence.slice(-limits.evidence)) {
      lines.push(`- [${item.kind}]${item.source_tool ? ` ${item.source_tool}:` : ""} ${item.summary}`);
    }
  }
  return lines.join("\n");
}

// The compact continuation snapshot intentionally stays small enough that a
// long objective/step cannot push the status lines past hardTruncate.
function truncateForSnapshot(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function hardTruncate(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const omitted = text.length - budget;
  return `${text.slice(0, budget)}…(+${omitted} chars omitted)`;
}

export function formatHarnessRuntimeContext(context: HarnessRuntimeContext): string {
  // Only actual work records contribute a retained runtime snapshot.
  const hasState = Boolean(
    context.goal || context.task || context.recent_evidence.length
  );
  if (!hasState) return CLEARED_TEXT;
  const body = ["HARNESS CONTEXT"];
  for (const limits of RENDER_LADDER) {
    const candidate = `${body.join("\n")}\n${renderSnapshot(context, limits)}`;
    const full = `${SUPERSEDE_HEADER}\n${candidate}`;
    if (full.length <= CONTEXT_BUDGET_CHARS) return full;
  }
  return hardTruncate(`${SUPERSEDE_HEADER}\n${body.join("\n")}\n${renderSnapshot(context, RENDER_LADDER[RENDER_LADDER.length - 1])}`, CONTEXT_BUDGET_CHARS);
}

interface RetainedSnapshot {
  text: string;
  at: number;
  tailStreak: number;
  progressKey: string;
  workHistory?: GoalWorkHistory;
}

interface RetentionSlot { snapshot?: RetainedSnapshot }
const retainedByWorkspace = new BoundedContextCache<RetentionSlot>(contextCacheCapacity, contextCacheIdleMs);
const pendingRetentionResets = new BoundedContextCache<true>(contextCacheCapacity, contextCacheIdleMs);

/**
 * Typed evidence and snapshot revisions can change on every tool result even
 * when the agent has not advanced its Goal/Task plan. Keep the loop breaker on
 * a semantic progress key so low-value evidence churn cannot reset the bound.
 */
function continuationProgressKey(context: HarnessRuntimeContext): string {
  return JSON.stringify({
    goal: context.goal
      ? {
          id: context.goal.goal_id,
          status: context.goal.status,
          phase: context.goal.current_phase,
        }
      : null,
    run: context.goal_run
      ? {
          state: context.goal_run.state,
          confirmed: context.goal_run.criteria_confirmed,
          total: context.goal_run.criteria_total,
          remaining: context.goal_run.remaining_criteria,
          next: context.goal_run.next_action,
          wait: context.goal_run.wait,
        }
      : null,
    issue: context.goal_run_issue ?? null,
    task: context.task
      ? {
          id: context.task.task_id,
          goalId: context.task.goal_id ?? null,
          status: context.task.status,
          step: context.task.current_step,
          blockers: context.task.blockers,
          blocked: context.task.blocked ?? null,
          next: context.task.next_actions,
          changed: context.task.changed_files,
          blockingRemaining: context.task.blocking_remaining,
          advisoryRemaining: context.task.advisory_remaining,
        }
      : null,
  });
}

function nextContinuationStreak(
  context: HarnessRuntimeContext,
  retained?: RetainedSnapshot,
  observation?: GoalWorkObservation
): { progressKey: string; streak: number; workHistory?: GoalWorkHistory } {
  const progressKey = continuationProgressKey(context);
  const sameProgress = retained?.progressKey === progressKey;
  // Waiting states keep their existing matching-result/deadline rules. Work
  // on another tool must not silently release a persisted wait.
  const workHistory = context.goal_run?.state === "RUNNING"
    ? advanceGoalWorkHistory(sameProgress ? retained?.workHistory : undefined, observation)
    : undefined;
  return {
    progressKey,
    streak: sameProgress && !workHistory?.advanced ? retained.tailStreak + 1 : 1,
    workHistory,
  };
}

/**
 * New MCP sessions (new/evicted/recovered ChatGPT conversations) rebuild their
 * instructions from boot-time state, so the first tool result of a fresh
 * conversation must re-deliver the snapshot even when the process-level
 * retained text is unchanged — otherwise a new chat could stay blind to the
 * goal for up to the refresh interval.
 */
export function resetHarnessSnapshotRetention(
  workspaceRoot: string, sessionId?: string, namespace?: HarnessContextNamespace
): void {
  retainedByWorkspace.delete(scopeCacheKey(workspaceRoot, sessionId, namespace));
}

/** A recovered transport has no trusted conversation identity until its first tool request. */
export function requestHarnessSnapshotRetentionReset(
  workspaceRoot: string, transportSessionId: string, namespace: HarnessContextNamespace
): void {
  pendingRetentionResets.set(scopeCacheKey(workspaceRoot, transportSessionId, namespace), true);
}

function consumeSnapshotRetentionReset(workspaceRoot: string, effectiveSessionId?: string): void {
  const transport = getMcpRequestIdentity()?.transportSessionId;
  if (!transport) return;
  const pendingKey = scopeCacheKey(workspaceRoot, transport);
  if (pendingRetentionResets.get(pendingKey) && pendingRetentionResets.delete(pendingKey)) {
    resetHarnessSnapshotRetention(workspaceRoot, effectiveSessionId);
  }
}

function withStructuredHarnessContext(result: unknown, context: HarnessRuntimeContext): unknown {
  const candidate = result as { structuredContent?: Record<string, unknown> };
  const structured = candidate.structuredContent;
  const data = structured?.data;
  if (!structured || !data || typeof data !== "object" || Array.isArray(data)) return result;
  // project_context already embeds a project-scoped harness_context of its own;
  // never overwrite a scope-specific view with the workspace-wide one.
  if ("harness_context" in (data as Record<string, unknown>)) return result;
  return {
    ...(result as Record<string, unknown>),
    structuredContent: {
      ...structured,
      data: {
        ...(data as Record<string, unknown>),
        harness_context: context,
      },
    },
  };
}

function withTextEntry(result: unknown, text: string): unknown {
  const candidate = result as { content?: unknown[] };
  if (!Array.isArray(candidate.content)) return result;
  return { ...(result as Record<string, unknown>), content: [...candidate.content, { type: "text", text }] };
}

export async function appendHarnessRuntimeContextToResult(
  workspaceRoot: string,
  result: unknown,
  options: { toolName?: string; toolAction?: string; rawArgs?: unknown } = {}
): Promise<unknown> {
  if (!result || typeof result !== "object") return result;
  const candidate = result as { content?: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean };
  const structuredData = candidate.structuredContent?.data;
  const hasStructuredData = Boolean(structuredData && typeof structuredData === "object" && !Array.isArray(structuredData));
  const toolName = options.toolName ?? "";
  const observation = goalWorkObservation(toolName, options.rawArgs, result);
  const tailOptions: ContinuationTailOptions = {
    toolName,
    toolAction: options.toolAction,
    resultFailed: candidate.isError === true || candidate.structuredContent?.ok === false,
  };
  const skipSnapshot = SKIP_TEXT_FOR.has(toolName);
  const canCarryText = Array.isArray(candidate.content);
  if (!skipSnapshot && !hasStructuredData && !canCarryText) return result;

  // Session scoping: the goal snapshot/tail only reaches the ChatGPT window
  // that owns (or is bound to) the active goal. Other windows are unaffected.
  const sessionId = getRuntimeScope()?.mcpSessionId;
  consumeSnapshotRetentionReset(workspaceRoot, sessionId);
  const key = scopeCacheKey(workspaceRoot, sessionId);
  let slot = retainedByWorkspace.get(key);
  if (!slot) {
    slot = {};
    retainedByWorkspace.set(key, slot);
  }
  const ownSlot = slot;
  // Invalidation/eviction while the state read is in flight must not resurrect
  // stale retention. This call can still deliver its own conservative snapshot.
  const retain = (snapshot: RetainedSnapshot): void => {
    if (retainedByWorkspace.peek(key) === ownSlot) ownSlot.snapshot = snapshot;
  };

  let context: HarnessRuntimeContext;
  try {
    context = await buildHarnessRuntimeContext(workspaceRoot, undefined, sessionId);
  } catch (error) {
    console.warn(`[harness-context] snapshot unavailable: ${(error as Error).message}`);
    return result;
  }

  // Keep visible active records concise; completed Goals do not make Task
  // completion or any additional tool call a delivery prerequisite.
  const activeNeedsWork = Boolean(
    context.goal?.status === "active" ||
    context.goal_run_issue?.code === "GOAL_RUN_PROJECTION_REPAIR_PENDING"
  );

  if (skipSnapshot) {
    const withStructured = hasStructuredData ? withStructuredHarnessContext(result, context) : result;
    // State tools already carry their details; add only the short work record.
    // It describes verification facts without requiring another tool call.
    if (!activeNeedsWork || !canCarryText) {
      if (!activeNeedsWork) {
        const retained = ownSlot.snapshot;
        retain({
          text: retained?.text ?? "",
          at: retained?.at ?? 0,
          tailStreak: 0,
          progressKey: continuationProgressKey(context),
        });
      }
      return withStructured;
    }
    const retained = ownSlot.snapshot ?? { text: "", at: 0, tailStreak: 0, progressKey: "" };
    const next = nextContinuationStreak(context, retained, observation);
    retained.tailStreak = next.streak;
    retained.progressKey = next.progressKey;
    retained.workHistory = next.workHistory;
    retain(retained);
    return withTextEntry(withStructured, continuationTail(context, retained.tailStreak, {
      ...tailOptions,
      repeatedResults: next.workHistory?.repeated,
      repeatedForMs: next.workHistory?.repeatedForMs,
      repeatedWorkStalled: goalWorkHistoryIsStalled(next.workHistory),
    }));
  }

  const text = formatHarnessRuntimeContext(context);
  const retained = ownSlot.snapshot;
  const cleared = text === CLEARED_TEXT;
  let inject: boolean;
  if (cleared) {
    inject = Boolean(retained && retained.text !== CLEARED_TEXT);
  } else if (!retained || retained.text !== text) {
    inject = true;
  } else {
    inject = Date.now() - retained.at > snapshotRefreshMs();
  }

  if (!inject) {
    // The full snapshot is deduped, but an active goal with unmet criteria must
    // keep a continuation signal in EVERY result: the model's stop decision
    // happens per tool call, and a gap without the signal is exactly how
    // "report progress and wait" relapses.
    if (activeNeedsWork && canCarryText) {
      const next = nextContinuationStreak(context, retained, observation);
      if (retained) {
        retained.tailStreak = next.streak;
        retained.progressKey = next.progressKey;
        retained.workHistory = next.workHistory;
      }
      retain(
        retained ?? { text, at: Date.now(), tailStreak: next.streak, progressKey: next.progressKey, workHistory: next.workHistory }
      );
      return withTextEntry(result, continuationTail(context, next.streak, {
        ...tailOptions,
        repeatedResults: next.workHistory?.repeated,
        repeatedForMs: next.workHistory?.repeatedForMs,
        repeatedWorkStalled: goalWorkHistoryIsStalled(next.workHistory),
      }));
    }
    return result;
  }

  const next = nextContinuationStreak(context, retained, observation);
  const tailStreak = activeNeedsWork && canCarryText ? next.streak : 0;
  retain({
    text,
    at: Date.now(),
    tailStreak,
    progressKey: next.progressKey,
    workHistory: next.workHistory,
  });
  const withStructured = hasStructuredData ? withStructuredHarnessContext(result, context) : result;
  const withSnapshot = withTextEntry(withStructured, text);
  // A changed/full snapshot is informational context, not a continuation
  // command. Keep the imperative tail as the LAST model-visible text entry on
  // every ordinary tool result while a Goal is active, including reinjection
  // calls triggered by changed task/goal state. Otherwise the exact calls that
  // make progress can become silent stop points.
  return activeNeedsWork && canCarryText
    ? withTextEntry(withSnapshot, continuationTail(context, tailStreak, {
        ...tailOptions,
        repeatedResults: next.workHistory?.repeated,
        repeatedForMs: next.workHistory?.repeatedForMs,
        repeatedWorkStalled: goalWorkHistoryIsStalled(next.workHistory),
      }))
    : withSnapshot;
}
