import { createHash } from "node:crypto";
import path from "node:path";

/**
 * Advisory loop-breaker ported from DeepSeek Harness repeat-tool-reminder.
 * Counts consecutive identical tool calls per workspace and appends a reminder
 * to the result at escalating thresholds. Denied and failed calls count too —
 * a model hammering a failing call is exactly the loop worth breaking. State
 * tools are excluded: their arguments repeat legitimately between checkpoints.
 * User interjection cannot be observed over MCP, so the only reset is a
 * different call (different tool or arguments), which matches the "consecutive
 * identical calls" semantics.
 */

const GUARD_THRESHOLDS = [3, 5, 8];
const ARGS_PREVIEW_CHARS = 500;
const CANONICAL_KEY_CHARS = 4096;

const GUARD_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "goal",
  "task_state",
  "task_create",
  "task_status",
  "task_update",
  "task_complete",
  "task_list",
  "agent_status",
  "visual_review",
  "rewind",
  "remember",
]);

const GENTLE_REMINDER =
  "GUARD: You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again — change the arguments, fix the underlying issue, or choose a different approach.";

function detailedReminder(toolName: string, count: number, argsPreview: string): string {
  return `GUARD: tool "${toolName}" has now been called ${count} consecutive times with identical arguments. Arguments: ${argsPreview}. Do not call this tool with these exact arguments again — change the inputs, fix the underlying failure, or take a different approach.`;
}

function canonicalJson(value: unknown, depth: number): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 8) return "\"…\"";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`);
    return `{${entries.join(",")}}`;
  }
  return "null";
}

function argsKey(toolName: string, args: unknown): string {
  const canonical = canonicalJson(args, 0);
  const identity = canonical.length <= CANONICAL_KEY_CHARS
    ? canonical
    : `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  return `${toolName}:${identity}`;
}

function argsPreview(args: unknown): string {
  const canonical = canonicalJson(args, 0);
  if (canonical.length <= ARGS_PREVIEW_CHARS) return canonical;
  return `${canonical.slice(0, ARGS_PREVIEW_CHARS)}… (+${canonical.length - ARGS_PREVIEW_CHARS} more chars)`;
}

interface GuardChain {
  key: string;
  count: number;
}

const chains = new Map<string, GuardChain>();

function workspaceKey(workspaceRoot: string): string {
  return path.resolve(workspaceRoot).toLowerCase();
}

/**
 * Records one call and returns a reminder when the consecutive-identical count
 * exactly reaches a configured threshold. `null` when the tool is excluded or
 * the chain is not at a threshold.
 */
export function repeatGuardReminder(
  workspaceRoot: string,
  toolName: string,
  args: unknown
): string | null {
  if (GUARD_EXCLUDED_TOOLS.has(toolName)) return null;
  const wsKey = workspaceKey(workspaceRoot);
  const key = argsKey(toolName, args);
  const chain = chains.get(wsKey);
  if (!chain || chain.key !== key) {
    chains.set(wsKey, { key, count: 1 });
    return null;
  }
  chain.count += 1;
  const thresholdIndex = GUARD_THRESHOLDS.indexOf(chain.count);
  if (thresholdIndex === -1) return null;
  return thresholdIndex === 0
    ? GENTLE_REMINDER
    : detailedReminder(toolName, chain.count, argsPreview(args));
}

/** Failure path: count the call (escalation continues across failed calls) without a reminder surface. */
export function recordRepeatGuardFailure(workspaceRoot: string, toolName: string, args: unknown): void {
  try {
    repeatGuardReminder(workspaceRoot, toolName, args);
  } catch {}
}

/** Attaches the reminder text to a resolved tool result, when one is due. */
export function appendRepeatGuardReminderToResult(
  workspaceRoot: string,
  toolName: string,
  args: unknown,
  result: unknown
): unknown {
  const reminder = repeatGuardReminder(workspaceRoot, toolName, args);
  if (!reminder || !result || typeof result !== "object") return result;
  const candidate = result as { content?: unknown[] };
  if (!Array.isArray(candidate.content)) return result;
  return { ...(candidate as Record<string, unknown>), content: [...candidate.content, { type: "text", text: reminder }] };
}

/** Test/diagnostic seam: inspect the current chain without recording a call. */
export function repeatGuardState(workspaceRoot: string): { count: number; tool: string } | null {
  const chain = chains.get(workspaceKey(workspaceRoot));
  if (!chain) return null;
  return { count: chain.count, tool: chain.key.split(":")[0] ?? "" };
}
