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
import { readAcceptedExecutionContractState } from "./execution-contract.js";

export interface BrokerEvidenceSummary {
  seq: number;
  time: string;
  kind: HarnessEvidenceKind;
  source_tool?: string;
  summary: string;
}

export interface HarnessRuntimeContext {
  project_root?: string;
  intent_assurance?: {
    state: "UNDERSTANDING" | "READY";
    intent_revision?: number;
    readiness_score?: number;
    requirement_hash?: string;
    accepted_at?: string;
    issue?: string;
  };
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

const TAIL_ESCALATION_AFTER = 12;

interface ContinuationTailOptions {
  toolName?: string;
  toolAction?: string;
  resultFailed?: boolean;
  repeatedResults?: number;
  repeatedForMs?: number;
  repeatedWorkStalled?: boolean;
}

function taskNeedsCompletion(context: HarnessRuntimeContext): boolean {
  return Boolean(context.task?.goal_id && context.task.goal_id === context.goal?.goal_id &&
    context.task.goal_id === context.goal_run?.run_id &&
    (context.task.status === "active" || context.task.status === "blocked"));
}

function finishChain(context: HarnessRuntimeContext): string {
  return taskNeedsCompletion(context)
    ? "call goal(action=complete) now, then task_state(action=complete)."
    : "call goal(action=complete) now. No task_state completion call is required because no active durable task bound to this Goal is visible.";
}

function continuationTail(
  context: HarnessRuntimeContext,
  streak: number,
  options: ContinuationTailOptions = {}
): string {
  const goal = context.goal!;
  const issue = context.goal_run_issue;
  if (issue) {
    const failedPreflight =
      issue.recovery === "status_once" &&
      options.toolName === "goal" &&
      (options.toolAction === "status" || options.toolAction === "reconcile") &&
      options.resultFailed;
    if (issue.recovery === "stop" || failedPreflight) {
      return (
        `GOALRUN_BLOCKER [${issue.code}]: ${truncateForSnapshot(issue.message, 260)} ` +
        "STOP_AUTONOMOUS_TOOL_CALLS. Preserve the active Goal, send one concise blocker reply, and retry only after the runtime/schema issue is repaired."
      );
    }
    return (
      `GOALRUN_PREFLIGHT_REQUIRED [${issue.code}]: ${truncateForSnapshot(issue.message, 240)} ` +
      "Read goal(action=status) to inspect ownership and stored_goal_revision without side effects. If reconciliation_required is true, explicitly call goal(action=reconcile) with that stored revision before production work. If either call fails, preserve state and report the concrete blocker; do not loop or switch tools to bypass it."
    );
  }

  const run = context.goal_run;
  if (!run) {
    return (
      "GOALRUN_PREFLIGHT_REQUIRED [GOAL_RUN_AUTHORITY_MISSING]: authoritative GoalRun state is unavailable. " +
      "Read goal(action=status). Status is observational; if it reports reconciliation_required, use goal(action=reconcile, expected_revision=stored_goal_revision). If either call fails, preserve state and report the blocker; do not loop."
    );
  }

  const remaining = run.remaining_criteria;
  const counter = `GOAL ${run.criteria_confirmed}/${run.criteria_total} — ${remaining.length ? "NOT DONE." : "ALL CRITERIA CONFIRMED."}`;

  switch (run.state) {
    case "WAITING_USER":
      return `${counter} GOAL_WAITING_USER: stop tool calls and send the single concise user request described by the persisted GoalRun wait. YIELD_TO_USER until the matching response arrives; do not retry or call unrelated tools.`;
    case "WAITING_TOOL":
      if (streak >= TAIL_ESCALATION_AFTER) {
        return `${counter} GOAL_WAITING_TOOL_BLOCKER: ${streak} results arrived without the persisted matching tool result. STOP_AUTONOMOUS_TOOL_CALLS, preserve the wait, and report one concise recoverable blocker; do not poll or call unrelated tools.`;
      }
      return `${counter} GOAL_WAITING_TOOL: only the matching persisted tool result may resume this run. Do not call unrelated tools; if that result is still pending, yield instead of polling or narrating progress.`;
    case "WAITING_EXTERNAL_PROCESS":
      if (streak >= TAIL_ESCALATION_AFTER) {
        return `${counter} GOAL_EXTERNAL_WAIT_POLL_LIMIT: ${streak} results arrived without satisfying the bounded external wait. STOP_AUTONOMOUS_TOOL_CALLS, preserve the wait, and report one concise recoverable blocker; do not poll again until the process or recovery condition changes.`;
      }
      return `${counter} GOAL_WAITING_EXTERNAL_PROCESS: follow only wait ${run.wait?.id ?? "unknown"} for process ${run.wait?.process_ref ?? "unknown"}, poll no faster than ${run.wait?.poll_interval_ms ?? "the persisted interval"}ms, and stop at ${run.wait?.deadline_at ?? "the persisted deadline"}. Do not call unrelated tools; yield between due polls and recover once on timeout instead of looping.`;
    case "WAITING_CONTROL_PLANE":
      return `${counter} GOAL_WAITING_CONTROL_PLANE: preserve the Goal, receipts, and resume cursor while browser/MCP capability is unavailable. Do not count this state as semantic no-progress; resume automatically after a capability-proved lane returns.`;
    case "NO_PROGRESS_PAUSED":
      return `${counter} GOAL_NO_PROGRESS_PAUSED: exact consecutive results lasted at least 30 minutes. Preserve the Goal and resume cursor; continue only after user direction or a changed recovery condition.`;
    case "INTERRUPTED":
      return `${counter} GOAL_INTERRUPTED: STOP_AUTONOMOUS_TOOL_CALLS and preserve the resume cursor. Continue only after an explicit goal(action=resume); a terminal cancellation cannot resume.`;
    case "COMPLETED":
      if (taskNeedsCompletion(context)) {
        if (options.toolName === "task_state" && options.toolAction === "complete" && options.resultFailed) {
          return "GOAL_COMPLETED_TASK_BLOCKER: task_state(action=complete) failed once after Goal completion. STOP_AUTONOMOUS_TOOL_CALLS and report the task completion blocker; do not retry in a loop.";
        }
        return "GOAL_COMPLETED_TASK_PENDING: the GoalRun is complete but its visible durable task is still active/blocked. Call task_state(action=complete) once now; do not end the turn before that call succeeds or returns a verified blocker.";
      }
      return "GOAL_COMPLETED: no continuation and no further Goal tools are required for this run.";
    case "READY_TO_FINALIZE":
      return `${counter} DELIVERABLE_READY pending finish chain — ${finishChain(context)} Do not narrate before the applicable finish chain completes.`;
    case "RUNNING":
      break;
  }

  // All-confirmed limbo: evidence gates passed but explicit finalization has not.
  if (remaining.length === 0) {
    return `${counter} DELIVERABLE_READY pending finish chain — ${finishChain(context)} Do not end the turn before the applicable finish chain completes.`;
  }

  const next = truncateForSnapshot(remaining[0], 120);
  if (streak >= TAIL_ESCALATION_AFTER || options.repeatedWorkStalled) {
    if (options.toolName === "goal" && options.toolAction === "pause" && options.resultFailed) {
      return (
        `GOAL_NO_PROGRESS_PAUSE_FAILED: the single bounded pause attempt failed while "${next}" remains unmet. ` +
        "STOP_AUTONOMOUS_TOOL_CALLS and report one concise recoverable blocker; do not retry pause or the stalled tool loop."
      );
    }
    if (!options.repeatedWorkStalled) {
      return (
        `GOAL_CHECKPOINT_DUE: "${next}" is still unconfirmed. Record the useful findings and next step at a natural boundary, then continue the authorized work. ` +
        "An unchanged criterion count does not establish a blocker. Do not pause or confirm a criterion merely to reset this reminder; confirmation still requires matching evidence."
      );
    }
    return (
      `GOAL_NO_PROGRESS_BLOCKER: ${options.repeatedResults} exact consecutive repeats persisted for ${Math.floor((options.repeatedForMs ?? 0) / 60_000)} minutes without Goal/Task progress while "${next}" remains unmet. ` +
      "STOP_AUTONOMOUS_TOOL_CALLS. Call goal(action=pause, pause_kind=no_progress, current_phase=\"Blocked: no semantic progress\") once, then yield one concise blocker reply with the last useful evidence. Resume only after user direction or a changed recovery condition; do not retry the loop."
    );
  }
  return (
    `${counter} MUST_CONTINUE_TO_TOOL. Expect no user reply until DELIVERABLE_READY or a verified blocker; this goal supersedes any "report progress every N calls" rule (progress = checkpoints). ` +
    `Your next action must be a tool call advancing: ${next}. ` +
    `Progress updates, plans, and "shall I continue?" are forbidden turn endings. ` +
    `Confirm it only with goal(action=confirm, evidence_ids=[...]). ` +
    (context.task
      ? "Genuinely blocked? checkpoint task_state with blocked_reason, pause the Goal, then yield — otherwise continue."
      : "Genuinely blocked? pause the Goal with a concrete blocker, then yield — otherwise continue.")
  );
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

const coreStateCache = new Map<string, { expires: number; promise: Promise<CoreState> }>();

// Goal/task mutations drop the cache for their workspace immediately; the TTL
// only bounds staleness from external file edits.
onStateInvalidated((workspaceRoot) => {
  const prefix = `${workspaceKey(workspaceRoot)}::`;
  for (const key of [...coreStateCache.keys()]) {
    if (key.startsWith(prefix)) coreStateCache.delete(key);
  }
});

function getCachedCoreState(workspaceRoot: string, sessionId?: string): Promise<CoreState> {
  const key = `${workspaceKey(workspaceRoot)}::${sessionId ?? "legacy"}`;
  const now = Date.now();
  const cached = coreStateCache.get(key);
  if (cached && cached.expires > now) return cached.promise;
  const promise = loadCoreState(workspaceRoot, sessionId);
  coreStateCache.set(key, { expires: now + stateCacheTtlMs(), promise });
  void promise.catch(() => coreStateCache.delete(key));
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
}

const evidenceWindows = new Map<string, EvidenceWindow>();

async function refreshEvidenceWindow(workspaceRoot: string, sessionId?: string): Promise<EvidenceWindowItem[]> {
  const key = `${workspaceKey(workspaceRoot)}::${sessionId ?? "legacy"}`;
  const generation = harnessRepairCount(workspaceRoot);
  const win = evidenceWindows.get(key) ?? { items: [], offset: 0, repairs: generation };
  if (win.repairs !== generation) {
    // The log was rewritten (migration/repair/quarantine): byte offsets no
    // longer mean anything — rescan from the start.
    win.items = [];
    win.offset = 0;
    win.repairs = generation;
  }
  try {
    const tail = await readHarnessEventTail(workspaceRoot, win.offset);
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
    if (win.items.length > EVIDENCE_WINDOW) win.items = win.items.slice(-EVIDENCE_WINDOW);
    evidenceWindows.set(key, win);
  } catch {
    // Evidence is advisory; a failed incremental read keeps the last window.
  }
  return win.items;
}

export async function buildHarnessRuntimeContext(
  workspaceRoot: string,
  projectRoot?: string,
  sessionId?: string
): Promise<HarnessRuntimeContext> {
  const effectiveSessionId = sessionId ?? getRuntimeScope()?.mcpSessionId;
  const resolvedProject = projectRoot ? path.resolve(projectRoot) : undefined;
  const core = await getCachedCoreState(workspaceRoot, effectiveSessionId);

  let intentAssurance: HarnessRuntimeContext["intent_assurance"];
  try {
    const accepted = await readAcceptedExecutionContractState(workspaceRoot, effectiveSessionId,
      core.goal && goalVisibleToSession(core.goal, effectiveSessionId) ? core.goal.id : undefined);
    intentAssurance = accepted
      ? {
          state: "READY",
          intent_revision: accepted.intent_revision,
          readiness_score: accepted.readiness_score,
          requirement_hash: accepted.requirement_hash,
          accepted_at: accepted.accepted_at,
        }
      : { state: "UNDERSTANDING" };
  } catch (error) {
    intentAssurance = {
      state: "UNDERSTANDING",
      issue: truncateForSnapshot(error instanceof Error ? error.message : String(error), 240),
    };
  }

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
    ...(resolvedProject ? { project_root: resolvedProject } : {}),
    intent_assurance: intentAssurance,
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
  if (context.intent_assurance?.state === "READY") {
    lines.push(
      `Requirement gate: READY | intent_revision=${context.intent_assurance.intent_revision ?? "?"} | RRS=${context.intent_assurance.readiness_score ?? "?"} | contract=${(context.intent_assurance.requirement_hash ?? "unknown").slice(0, 12)}`
    );
  } else if (context.intent_assurance) {
    lines.push(
      context.intent_assurance.issue
        ? `Requirement gate: UNDERSTANDING | state issue: ${truncateForSnapshot(context.intent_assurance.issue, 220)}`
        : "Requirement gate: UNDERSTANDING | read-only discovery is allowed; side effects require _intent with RRS >= 95 and zero blocking ambiguities."
    );
  }
  // Goal block renders BEFORE the task block: head-preserving truncation must
  // never be able to cut the continuation contract or the goal state away.
  if (context.goal) {
    if (context.goal.status === "active") {
      lines.push(`GOAL CONTINUATION CONTRACT: ${context.goal_run?.policy ?? GOAL_CONTINUATION_SNAPSHOT}`);
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
  // UNDERSTANDING is the default pre-execution posture already present in the
  // server instructions; do not append a Harness context block to every
  // ordinary read result just to restate that default. READY is durable state
  // worth projecting because it carries an accepted contract revision/hash.
  const hasState = Boolean(
    context.intent_assurance?.state === "READY" || context.goal || context.task || context.recent_evidence.length
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

const retainedByWorkspace = new Map<string, RetainedSnapshot>();

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
export function resetHarnessSnapshotRetention(workspaceRoot: string, sessionId?: string): void {
  retainedByWorkspace.delete(`${workspaceKey(workspaceRoot)}::${sessionId ?? "legacy"}`);
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

  let context: HarnessRuntimeContext;
  try {
    context = await buildHarnessRuntimeContext(workspaceRoot, undefined, sessionId);
  } catch (error) {
    console.warn(`[harness-context] snapshot unavailable: ${(error as Error).message}`);
    return result;
  }

  const key = `${workspaceKey(workspaceRoot)}::${sessionId ?? "legacy"}`;
  // An active goal ALWAYS needs a signal: unmet criteria → "advance X" tail;
  // all-passed limbo → "run the finish chain" tail. Zero-signal gaps here are
  // how goals end up active forever.
  const activeNeedsWork = Boolean(
    context.goal?.status === "active" ||
    context.goal_run_issue?.code === "GOAL_RUN_PROJECTION_REPAIR_PENDING" ||
    (context.goal_run?.state === "COMPLETED" && taskNeedsCompletion(context))
  );

  if (skipSnapshot) {
    const withStructured = hasStructuredData ? withStructuredHarnessContext(result, context) : result;
    // Skip tools skip the SNAPSHOT, not the continuation signal: ChatGPT's
    // turn-start preflight calls (agent_status/remember/…) and any turn ENDING
    // on one of them previously had no signal at the stop-decision point.
    // Even goal/task_state get the tail. Their in-band continue_execution /
    // execution_hint fields are useful state, but a real Web reproduction
    // showed that the model can still stop immediately after goal(create).
    // The imperative tail must therefore remain the LAST model-visible text
    // entry on every active-Goal result, including the state tools themselves.
    if (!activeNeedsWork || !canCarryText) {
      if (!activeNeedsWork) {
        const retained = retainedByWorkspace.get(key);
        retainedByWorkspace.set(key, {
          text: retained?.text ?? "",
          at: retained?.at ?? 0,
          tailStreak: 0,
          progressKey: continuationProgressKey(context),
        });
      }
      return withStructured;
    }
    const retained = retainedByWorkspace.get(key) ?? { text: "", at: 0, tailStreak: 0, progressKey: "" };
    const next = nextContinuationStreak(context, retained, observation);
    retained.tailStreak = next.streak;
    retained.progressKey = next.progressKey;
      retained.workHistory = next.workHistory;
    retainedByWorkspace.set(key, retained);
    return withTextEntry(withStructured, continuationTail(context, retained.tailStreak, {
      ...tailOptions,
      repeatedResults: next.workHistory?.repeated,
      repeatedForMs: next.workHistory?.repeatedForMs,
      repeatedWorkStalled: goalWorkHistoryIsStalled(next.workHistory),
    }));
  }

  const text = formatHarnessRuntimeContext(context);
  const retained = retainedByWorkspace.get(key);
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
      retainedByWorkspace.set(
        key,
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
  retainedByWorkspace.set(key, {
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
