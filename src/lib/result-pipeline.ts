import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getSkillDiscoveryAppender } from "./skill-discovery.js";
import { currentProviderScope } from "./provider-scope.js";

import { appendHarnessRuntimeContextToResult } from "./context-broker.js";
import { recordGoalStallTelemetry, recordToolObservation } from "./durable-tasks.js";
import type { InvocationContext } from "./invocation-gateway.js";
import { appendGoalRunEvidenceToResult, recordGoalRunToolFailure } from "./goal-run-web.js";
import { getGoal } from "./goal-state-store.js";
import {
  appendRepeatGuardReminderToResult,
  recordRepeatGuardFailure,
} from "./repeat-guard.js";

type MaybePromise<T> = T | Promise<T>;

/** Injectable seam for deterministic result-pipeline tests. */
export interface WebHarnessResultPipelineOperations {
  /** A late result may be returned, but cannot mutate another Goal or task. */
  mayRecordForScope?(context: InvocationContext): MaybePromise<boolean>;
  recordToolObservation(
    context: InvocationContext,
    result: CallToolResult | undefined,
    error?: unknown
  ): MaybePromise<void>;
  recordGoalStallTelemetry(): MaybePromise<void>;
  appendGoalRunEvidenceToResult(
    context: InvocationContext,
    result: CallToolResult
  ): MaybePromise<CallToolResult>;
  appendHarnessRuntimeContextToResult(
    context: InvocationContext,
    result: CallToolResult
  ): MaybePromise<CallToolResult>;
  appendRepeatGuardReminderToResult(
    context: InvocationContext,
    result: CallToolResult
  ): MaybePromise<CallToolResult>;
  recordRepeatGuardFailure(context: InvocationContext): MaybePromise<void>;
  recordGoalRunToolFailure(context: InvocationContext, error: unknown): MaybePromise<void>;
}

/** Owns the ordered post-handler pipeline for ChatGPT Web harness results. */
export class WebHarnessResultPipeline {
  constructor(private readonly operations: WebHarnessResultPipelineOperations) {}

  async processSuccess(
    context: InvocationContext,
    result: CallToolResult
  ): Promise<CallToolResult> {
    if (this.operations.mayRecordForScope && !await this.operations.mayRecordForScope(context)) {
      return optionalAppend("runtime_context", result, value => this.operations.appendHarnessRuntimeContextToResult(context, value));
    }
    await suppressErrors(() => this.operations.recordToolObservation(context, result));
    await suppressErrors(() => this.operations.recordGoalStallTelemetry());
    const withGoalRunEvidence = await optionalAppend("goal_evidence", result,
      value => this.operations.appendGoalRunEvidenceToResult(context, value));
    const withHarnessContext = await optionalAppend("runtime_context", withGoalRunEvidence,
      value => this.operations.appendHarnessRuntimeContextToResult(context, value));
    return optionalAppend("repeat_reminder", withHarnessContext,
      value => this.operations.appendRepeatGuardReminderToResult(context, value));
  }

  async processFailure(context: InvocationContext, error: unknown): Promise<void> {
    if (this.operations.mayRecordForScope && !await this.operations.mayRecordForScope(context)) return;
    await suppressErrors(() =>
      this.operations.recordToolObservation(context, undefined, error)
    );
    await suppressErrors(() => this.operations.recordGoalRunToolFailure(context, error));
    await this.operations.recordRepeatGuardFailure(context);
  }
}

/** Work-record failures cannot turn a completed operation into an apparent failure. */
async function optionalAppend(stage: string, result: CallToolResult,
  append: (value: CallToolResult) => MaybePromise<CallToolResult>): Promise<CallToolResult> {
  try { return await append(result); }
  catch {
    const previous = result._meta?.["harness/postprocessing_warnings"];
    return { ...result, _meta: { ...result._meta,
      "harness/postprocessing_warnings": [...(Array.isArray(previous) ? previous : []),
        { stage, status: "unavailable", handler_result_preserved: true, grants_verification: false }] } };
  }
}

/** Production adapter matching the current server-factory operation mapping. */
export function createWebHarnessResultPipeline(
  workspaceRoot: string
): WebHarnessResultPipeline {
  return new WebHarnessResultPipeline({
    mayRecordForScope: async (context) => {
      if (!Object.prototype.hasOwnProperty.call(context.scope, "goalId")) return true;
      try {
        const current = context.scope.mcpSessionId
          ? await getGoal(workspaceRoot, context.scope.mcpSessionId) : null;
        return current?.id === context.scope.goalId;
      } catch { return false; }
    },
    recordToolObservation: (context, result, error) =>
      recordToolObservation(
        workspaceRoot,
        context.definition.name,
        context.rawArgs,
        result,
        error
      ),
    recordGoalStallTelemetry: () => recordGoalStallTelemetry(workspaceRoot),
    appendGoalRunEvidenceToResult: (context, result) =>
      appendGoalRunEvidenceToResult(workspaceRoot, context, result),
    appendHarnessRuntimeContextToResult: async (context, result) => {
      const withDiscovery = context.definition.source === "native" ? await getSkillDiscoveryAppender(workspaceRoot).append(
        result,
        currentProviderScope().key,
        context.definition.name,
        context.rawArgs
      ) : result;
      return await appendHarnessRuntimeContextToResult(workspaceRoot, withDiscovery, {
        toolName: context.definition.name,
        rawArgs: context.rawArgs,
        toolAction:
          context.rawArgs && typeof context.rawArgs === "object" && !Array.isArray(context.rawArgs) &&
          typeof (context.rawArgs as Record<string, unknown>).action === "string"
            ? (context.rawArgs as Record<string, unknown>).action as string
            : undefined,
      }) as CallToolResult;
    },
    appendRepeatGuardReminderToResult: (context, result) =>
      appendRepeatGuardReminderToResult(
        workspaceRoot,
        context.definition.name,
        context.rawArgs,
        result
      ) as CallToolResult,
    recordRepeatGuardFailure: (context) =>
      recordRepeatGuardFailure(
        workspaceRoot,
        context.definition.name,
        context.rawArgs
      ),
    recordGoalRunToolFailure: (context, error) =>
      recordGoalRunToolFailure(workspaceRoot, context, error),
  });
}

async function suppressErrors(operation: () => MaybePromise<void>): Promise<void> {
  try {
    await operation();
  } catch {}
}
