import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { captureDurableRecoveryScope, readDurableRecoverySubmission, submitDurableRecoveryPlan } from "../lib/service-recovery-plan.js";
import { readRecoveryTask } from "../lib/recovery-engine.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

const stepSchema = z.object({
  id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  name: z.string().min(1).max(300).optional(),
  operation_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  replay_policy: z.enum(["safe", "never"]),
  command: z.string().min(1).max(100000),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(100).max(300000).optional(),
  side_effect: z.enum(["none", "unknown"]),
  retry_on_nonzero: z.boolean().optional(),
});

export function registerRecoveryTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool(
    "recovery_submit",
    {
      title: "Submit Durable Recovery Plan",
      description: "Submit an already-authorized command plan to the detached recovery runner before useful work begins. The plan captures the current trusted Goal, survives the current Web/MCP session, and uses Goal-scoped stable operation IDs. Safe replay is allowed only for commands explicitly declared side_effect=none.",
      inputSchema: {
        task_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        steps: z.array(stepSchema).min(1).max(64),
        lease_ms: z.number().int().min(250).max(60000).optional(),
        max_automatic_recoveries: z.number().int().min(0).max(64).optional(),
      },
      annotations: toolAnnotations("command"),
    },
    async (input) => {
      try {
        const receipt = await submitDurableRecoveryPlan(workspaceRoot, input);
        return toolResult("recovery_submit", receipt, {
          summary: `durable recovery plan submitted: ${receipt.task_id}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult("recovery_submit", { error: message }, { ok: false, summary: message });
      }
    }
  );

  server.registerTool(
    "recovery_status",
    {
      title: "Read Durable Recovery Submission",
      description: "Read the immutable receipt and execution state for a durable recovery plan in the current trusted Goal. Unscoped legacy plans are never adopted.",
      inputSchema: {
        task_id: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ task_id }) => {
      try {
        const scope = captureDurableRecoveryScope(workspaceRoot);
        const receipt = await readDurableRecoverySubmission(workspaceRoot, task_id);
        const execution = receipt ? await readRecoveryTask(receipt.artifact_root, task_id) : null;
        if (execution && (execution.goal_id !== scope.goal_id || execution.task_id !== task_id ||
            execution.steps?.some((step: { receipt?: { goal_id?: string } }) => step.receipt && step.receipt.goal_id !== scope.goal_id) ||
            (execution.final_receipt && execution.final_receipt.goal_id !== scope.goal_id))) {
          throw new Error("RECOVERY_EXECUTION_GOAL_SCOPE_MISMATCH");
        }
        return toolResult("recovery_status", { goal_id: scope.goal_id, task_id, receipt, execution }, {
          summary: receipt ? `durable recovery submission found: ${task_id}` : `no durable recovery submission: ${task_id}`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return toolResult("recovery_status", { error: message }, { ok: false, summary: message });
      }
    }
  );
}