import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolError, toolResult } from "../lib/tool-result.js";
import {
  completeDurableTask,
  checkpointDurableTask,
  createDurableTask,
  getDurableTask,
  listDurableTasks,
  resolveDurableTask,
  revalidateDurableTaskGoalDefinition,
  taskHandoff,
  updateDurableTask,
  type DurableTaskStatus,
  type TaskBlockedReason,
} from "../lib/durable-tasks.js";
import { GOAL_GROUNDING_NOTE, getGoal, type GoalCriterion } from "../lib/goals.js";

/**
 * Continuation-signal fields for task_state results. A just-recorded blocker
 * takes precedence: the contract's sanctioned yield path must not be
 * countermanded by a "keep executing" hint at the same moment.
 */
function continuationFields(
  goal: Awaited<ReturnType<typeof getGoal>>,
  blocked?: TaskBlockedReason
): Record<string, unknown> {
  if (blocked) {
    return {
      blocked_yield: true,
      execution_hint:
        "Blocked state recorded — you may yield to the user for this blocker; continue execution once it is resolved.",
    };
  }
  const remaining = goal?.success_criteria.filter((criterion: GoalCriterion) => !criterion.passed).length ?? 0;
  // An active Goal still needs explicit finalization even after its last
  // criterion passes; finishing a subtask must never signal a Goal stop.
  return goal?.status === "active"
    ? {
        continue_execution: true,
        execution_hint:
          remaining > 0
            ? "The subtask may be complete but its Goal is still active: continue using tools toward the remaining Goal criteria. Task completion is not Goal completion."
            : "All Goal criteria may be passed, but Goal completion requires the separate verified goal action=complete. Task completion does not finalize the Goal.",
      }
    : {};
}

const checkSchema = z.object({
  name: z.string().min(1).max(300),
  passed: z.boolean().default(false),
  detail: z.string().max(2000).optional(),
});

const statusSchema = z.enum(["active", "blocked", "completed", "cancelled"]);
const shortStringArray = z.array(z.string().min(1).max(4000)).max(100);
const compactStringArray = z.array(z.string().min(1).max(1000)).max(24);

const taskStateActionSchema = z.enum(["create", "resume", "checkpoint", "revalidate", "complete", "list", "cancel"]);

export function registerTaskTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "task_state",
    {
      title: "Compact Task State",
      description:
        "Maintain one compact long-task checkpoint across chats. Create once, then checkpoint progress; tool calls automatically record failures, checks, and changed files.",
      inputSchema: {
        action: taskStateActionSchema,
        task_id: z.string().uuid().optional(),
        expected_goal_revision: z.number().int().positive().optional()
          .describe("Required for revalidate; read the current Goal revision before rechecking a legacy/stale Task."),
        goal: z.string().min(1).max(4000).optional(),
        current_step: z.string().max(2000).optional(),
        done: compactStringArray.optional(),
        decisions: compactStringArray.optional(),
        blockers: compactStringArray.optional(),
        resolved_blockers: compactStringArray.optional(),
        next_actions: compactStringArray.optional(),
        artifacts: compactStringArray.optional(),
        notes: compactStringArray.optional(),
        blocking_checks: z.array(checkSchema).max(30).optional(),
        advisory_checks: z.array(checkSchema).max(30).optional(),
        visual_required: z.boolean().optional(),
        blocked_reason: z.object({
          code: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, "lower-kebab-case"),
          message: z.string().min(1).max(1000),
        }).optional().describe("Structured blocker; cleared by resolved_blockers"),
        note: z.string().max(2000).optional(),
        limit: z.number().int().min(1).max(30).optional().default(10),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, task_id, expected_goal_revision, goal, current_step, done, decisions, blockers, resolved_blockers, next_actions, artifacts, notes, blocking_checks, advisory_checks, visual_required, blocked_reason, note, limit }) => {
      try {
        if (action === "create") {
          if (!goal?.trim()) throw new Error("task_state action=create requires goal");
          const task = await createDurableTask(workspaceRoot, {
            goal,
            current_step,
            blocking_checks,
            advisory_checks,
            artifacts,
            notes,
            visual_required,
          });
          const checkpointed = done?.length || decisions?.length || blockers?.length || next_actions?.length
            ? await checkpointDurableTask(workspaceRoot, task.id, {
                current_step,
                done,
                decisions,
                blockers,
                next_actions,
                artifacts,
                notes,
                blocking_checks,
                advisory_checks,
                visual_required,
              })
            : task;
          const activeGoal = await getGoal(workspaceRoot);
          return toolResult(
            "task_state",
            { action, handoff: taskHandoff(checkpointed), ...continuationFields(activeGoal) },
            { summary: `task active: ${task.id} — continue execution` }
          );
        }

        if (action === "resume") {
          const task = await resolveDurableTask(workspaceRoot, task_id);
          const handoff = taskHandoff(task);
          const activeGoal = await getGoal(workspaceRoot);
          return toolResult(
            "task_state",
            { action, handoff, ...continuationFields(activeGoal, handoff.blocked) },
            { summary: `resume ${task.id}` }
          );
        }

        if (action === "revalidate") {
          if (expected_goal_revision === undefined) {
            throw new Error("task_state action=revalidate requires expected_goal_revision from the current Goal.");
          }
          const current = await resolveDurableTask(workspaceRoot, task_id);
          const rebound = await revalidateDurableTaskGoalDefinition(workspaceRoot, current.id, expected_goal_revision);
          const parent = await getGoal(workspaceRoot);
          return toolResult("task_state", {
            action,
            handoff: taskHandoff(rebound),
            revalidation_required: true,
            previous_passed_checks_invalidated: true,
            current_goal_revision: parent?.revision ?? null,
            ...continuationFields(parent),
          }, { summary: `task revalidated against Goal definition; rerun blocking checks before completion: ${rebound.id}` });
        }
        if (action === "checkpoint") {
          const task = await checkpointDurableTask(workspaceRoot, task_id, {
            current_step,
            done,
            decisions,
            blockers,
            resolved_blockers,
            next_actions,
            artifacts,
            notes,
            blocking_checks,
            advisory_checks,
            visual_required,
            blocked_reason,
          });
          // A progress checkpoint is the single most likely moment for the model
          // to end its turn and "report progress" — re-assert the continuation
          // contract right here, not just on the next broker snapshot. A
          // just-recorded blocker switches the signal to the sanctioned yield.
          const handoff = taskHandoff(task);
          const activeGoal = await getGoal(workspaceRoot);
          const fields = continuationFields(activeGoal, handoff.blocked);
          const suffix = handoff.blocked ? " — blocked" : fields.continue_execution ? " — continue execution" : "";
          return toolResult(
            "task_state",
            {
              action,
              handoff,
              ...fields,
            },
            { summary: `checkpoint ${task.id} #${task.checkpoint_no}${suffix}` }
          );
        }

        if (action === "complete") {
          const task = await resolveDurableTask(workspaceRoot, task_id);
          const completed = await completeDurableTask(workspaceRoot, task.id, note);
          const parent = await getGoal(workspaceRoot);
          const goalStillActive = parent?.status === "active";
          return toolResult("task_state", {
            action, deliverable_ready: true, deliverable_scope: "task",
            goal_still_active: goalStillActive, goal_id: parent?.id ?? null,
            grounding: GOAL_GROUNDING_NOTE, handoff: taskHandoff(completed),
            ...continuationFields(parent),
          }, { summary: goalStillActive
            ? `TASK_COMPLETED_GOAL_CONTINUES ${task.id}`
            : `DELIVERABLE_READY ${task.id}` });
        }

        if (action === "cancel") {
          const task = await resolveDurableTask(workspaceRoot, task_id);
          const cancelled = await updateDurableTask(workspaceRoot, task.id, {
            status: "cancelled",
            current_step: "Cancelled",
            notes: note?.trim() ? [...task.notes, note.trim()] : task.notes,
          });
          return toolResult("task_state", { action, handoff: taskHandoff(cancelled) }, { summary: `cancelled ${task.id}` });
        }

        const tasks = await listDurableTasks(workspaceRoot, { limit });
        return toolResult("task_state", {
          action,
          tasks: tasks.map(taskHandoff),
          count: tasks.length,
        }, { summary: `${tasks.length} task(s)` });
      } catch (error) {
        return toolError("task_state", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "task_create",
    {
      title: "Create Durable Task",
      description:
        "Create a persistent task handle for long work. Store goal, current step, blocking checks, advisory checks, artifacts, and notes so work can resume across chats or MCP restarts.",
      inputSchema: {
        goal: z.string().min(1).max(8000),
        current_step: z.string().max(4000).optional(),
        blocking_checks: z.array(checkSchema).max(50).optional(),
        advisory_checks: z.array(checkSchema).max(50).optional(),
        visual_required: z.boolean().optional(),
        artifacts: shortStringArray.optional(),
        notes: shortStringArray.optional(),
      },
      annotations: toolAnnotations("edit"),
    },
    async (args) => {
      try {
        const task = await createDurableTask(workspaceRoot, args);
        return toolResult("task_create", { task_id: task.id, task }, { summary: `task_create: ${task.id}` });
      } catch (error) {
        return toolError("task_create", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "task_status",
    {
      title: "Task Status",
      description: "Read one persistent task by task_id. Use this to resume a long task after a new chat or MCP restart.",
      inputSchema: { task_id: z.string().uuid() },
      annotations: toolAnnotations("read"),
    },
    async ({ task_id }) => {
      try {
        const task = await getDurableTask(workspaceRoot, task_id);
        const blockingRemaining = task.blocking_checks.filter((check) => !check.passed).length;
        const advisoryRemaining = task.advisory_checks.filter((check) => !check.passed).length;
        return toolResult("task_status", { task, blocking_remaining: blockingRemaining, advisory_remaining: advisoryRemaining });
      } catch (error) {
        return toolError("task_status", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "task_update",
    {
      title: "Update Durable Task",
      description:
        "Checkpoint a persistent task after meaningful progress. Replace only fields supplied; keep blocking/advisory checks explicit and record produced artifacts.",
      inputSchema: {
        task_id: z.string().uuid(),
        goal: z.string().min(1).max(8000).optional(),
        status: statusSchema.optional(),
        current_step: z.string().max(4000).optional(),
        blocking_checks: z.array(checkSchema).max(50).optional(),
        advisory_checks: z.array(checkSchema).max(50).optional(),
        visual_required: z.boolean().optional(),
        artifacts: shortStringArray.optional(),
        notes: shortStringArray.optional(),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ task_id, ...patch }) => {
      try {
        if (patch.status === "completed") {
          throw new Error("Use task_complete to enter completed state; it enforces blocking checks.");
        }
        const task = await updateDurableTask(workspaceRoot, task_id, patch);
        return toolResult("task_update", { task_id, task }, { summary: `task_update: ${task_id}` });
      } catch (error) {
        return toolError("task_update", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "task_complete",
    {
      title: "Complete Durable Task",
      description:
        "Mark a task DELIVERABLE_READY only when every blocking check passes. Advisory checks may remain incomplete and do not block delivery.",
      inputSchema: {
        task_id: z.string().uuid(),
        note: z.string().max(4000).optional(),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ task_id, note }) => {
      try {
        const task = await completeDurableTask(workspaceRoot, task_id, note);
        const parent = await getGoal(workspaceRoot);
        const goalStillActive = parent?.status === "active";
        return toolResult(
          "task_complete",
          {
            task_id,
            task,
            deliverable_ready: true,
            deliverable_scope: "task",
            goal_still_active: goalStillActive,
            goal_id: parent?.id ?? null,
            grounding: GOAL_GROUNDING_NOTE,
            advisory_remaining: task.advisory_checks.filter((check) => !check.passed).length,
            ...continuationFields(parent),
          },
          { summary: goalStillActive
            ? `task_complete: ${task_id} TASK_COMPLETED_GOAL_CONTINUES`
            : `task_complete: ${task_id} DELIVERABLE_READY` }
        );
      } catch (error) {
        return toolError("task_complete", error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    "task_list",
    {
      title: "List Durable Tasks",
      description: "List recent persistent tasks for the current workspace, optionally filtered by status.",
      inputSchema: {
        status: statusSchema.optional(),
        limit: z.number().int().min(1).max(100).optional().default(20),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ status, limit }) => {
      try {
        const tasks = await listDurableTasks(workspaceRoot, { status: status as DurableTaskStatus | undefined, limit });
        return toolResult("task_list", { tasks, count: tasks.length });
      } catch (error) {
        return toolError("task_list", error instanceof Error ? error.message : String(error));
      }
    }
  );
}
