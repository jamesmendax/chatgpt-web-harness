import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolOutcomeKind = "needs_input" | "review_rejected" | "blocked" | "execution_error" | "unknown" | "running";
export type ToolFailurePhase = "admission" | "validation" | "execution" | "postprocessing";

/** Bounded diagnostic fields only: never retain arguments, stdout or the result body. */
export interface ToolFailureDiagnostic {
  readonly outcome_kind: ToolOutcomeKind;
  readonly error_code: string;
  readonly failure_phase: ToolFailurePhase;
  readonly error_summary: string;
  readonly retry_policy: string;
  readonly operation_started?: boolean;
  readonly exit_code?: number | null;
  readonly timed_out?: boolean;
  readonly may_have_partially_completed?: boolean;
  readonly failure_step?: string;
  readonly original_error_code?: string;
  readonly result_path?: string;
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(\b[A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;,&}]+)/gi, "$1[REDACTED]");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function boundedText(value: unknown, fallback: string): string {
  return redactSensitiveText(typeof value === "string" ? value : fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 360);
}

export function toolFailureDiagnostic(result: CallToolResult): ToolFailureDiagnostic | undefined {
  const envelope = record(result.structuredContent);
  const data = record(envelope?.data) ?? {};
  if (result.isError !== true && envelope?.ok !== false && !["unknown", "running"].includes(String(data.outcome_kind))) return undefined;
  const message = typeof data.detail === "string" ? data.detail
    : typeof data.error === "string" ? data.error : envelope?.summary;
  const codeCandidate = typeof data.error_code === "string" ? data.error_code
    : typeof data.error === "string" ? /^[A-Z][A-Z0-9_]{1,79}(?=:|$)/.exec(data.error)?.[0] : undefined;
  const code = codeCandidate && /^[A-Z][A-Z0-9_]{1,79}$/.test(codeCandidate)
    ? codeCandidate : "TOOL_EXECUTION_FAILED";
  const kinds = ["needs_input", "review_rejected", "blocked", "execution_error", "unknown", "running"];
  const kind = kinds.includes(String(data.outcome_kind)) ? data.outcome_kind as ToolOutcomeKind
    : data.failure_class === "validation" ? "needs_input"
    : data.failure_class === "conflict" || /^(?:DRIVER_|RI_|PERMISSION_)/.test(code) ? "blocked"
    : "execution_error";
  const phases = ["admission", "validation", "execution", "postprocessing"];
  const phase = phases.includes(String(data.failure_phase)) ? data.failure_phase as ToolFailurePhase
    : "execution";
  const policies = ["retry_with_changed_args", "refresh_state", "inspect_original_result", "repair_then_review", "none"];
  return {
    outcome_kind: kind,
    error_code: code,
    failure_phase: phase,
    error_summary: boundedText(message, code),
    retry_policy: policies.includes(String(data.retry_policy)) ? String(data.retry_policy) : "inspect_original_result",
    ...(typeof data.operation_started === "boolean" ? { operation_started: data.operation_started } : {}),
    ...(typeof data.exit_code === "number" || data.exit_code === null ? { exit_code: data.exit_code as number | null } : {}),
    ...(typeof data.timed_out === "boolean" ? { timed_out: data.timed_out } : {}),
    ...(typeof data.may_have_partially_completed === "boolean" ? { may_have_partially_completed: data.may_have_partially_completed } : {}),
    ...(typeof data.failure_step === "string" || typeof data.stage === "string" ? { failure_step: boundedText(data.failure_step ?? data.stage, "execution") } : {}),
    ...(typeof data.original_error_code === "string" ? { original_error_code: boundedText(data.original_error_code, code) } : {}),
    ...(typeof data.output_file === "string" || typeof data.result_path === "string" || typeof data.log_path === "string" || typeof data.full_output_path === "string"
      ? { result_path: boundedText(data.result_path ?? data.full_output_path ?? data.output_file ?? data.log_path, "") } : {}),
  };
}

/** Whitelisted tokens survive both console and Admin-feed transport. */
export function toolDiagnosticTokens(details?: Record<string, unknown>): string {
  if (!details || !["needs_input", "review_rejected", "blocked", "execution_error", "unknown", "running"].includes(String(details.outcome_kind))) return "";
  const parts = ["outcome=" + String(details.outcome_kind)];
  if (typeof details.error_code === "string" && /^[A-Z][A-Z0-9_]{1,79}$/.test(details.error_code)) parts.push("code=" + details.error_code);
  if (["admission", "validation", "execution", "postprocessing"].includes(String(details.failure_phase))) parts.push("phase=" + String(details.failure_phase));
  if (typeof details.operation_started === "boolean") parts.push("started=" + String(details.operation_started));
  if (typeof details.exit_code === "number" && Number.isInteger(details.exit_code)) parts.push("exit=" + details.exit_code);
  if (typeof details.timed_out === "boolean") parts.push("timeout=" + details.timed_out);
  if (typeof details.may_have_partially_completed === "boolean") parts.push("partial=" + details.may_have_partially_completed);
  if (["retry_with_changed_args", "refresh_state", "inspect_original_result", "repair_then_review", "none"].includes(String(details.retry_policy))) parts.push("retry=" + String(details.retry_policy));
  return " " + parts.join(" ");
}
