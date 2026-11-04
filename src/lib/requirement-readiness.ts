import { z } from "zod";

export const INTENT_ASSURANCE_FIELD = "_intent" as const;
export const REQUIREMENT_READY_SCORE = 95;
export const MAX_CLARIFICATION_ROUNDS = 2;
export const MAX_QUESTIONS_PER_ROUND = 5;
export const MAX_INTENT_JSON_CHARS = 12_000;

export type RequirementMateriality = "low" | "medium" | "high" | "critical";
export type RequirementClosureStatus = "closed" | "open" | "na";
export type RequirementResolutionMode =
  | "none"
  | "assume_and_proceed"
  | "delegated_decision"
  | "forced_choice"
  | "safe_prefix"
  | "hard_blocker";

export interface RequirementClosureItem {
  readonly id: string;
  readonly label?: string;
  readonly status: RequirementClosureStatus;
  readonly materiality: RequirementMateriality;
  readonly basis?: string;
}

export interface RequirementAmbiguity {
  readonly id: string;
  readonly question: string;
  readonly materiality: RequirementMateriality;
  readonly reversible: boolean;
  readonly blocking?: boolean;
  readonly delegated?: boolean;
}

export interface RequirementModel {
  readonly intent_revision: number;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly out_of_scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly success_criteria: readonly string[];
  readonly constraints: readonly string[];
  readonly protected_resources: readonly string[];
  readonly known_facts: readonly string[];
  readonly assumptions: readonly string[];
  readonly delegated_decisions: readonly string[];
  readonly remaining_nonblocking_uncertainties: readonly string[];
  readonly closure_items: readonly RequirementClosureItem[];
  readonly ambiguities: readonly RequirementAmbiguity[];
  readonly clarification_round: number;
  readonly questions_in_round: number;
  readonly resolution_mode: RequirementResolutionMode;
}

export interface RequirementReadinessAssessment {
  readonly score: number;
  readonly ready: boolean;
  readonly blocking_ambiguities: readonly RequirementAmbiguity[];
  readonly open_items: readonly RequirementClosureItem[];
  readonly resolution_stage_required: boolean;
  readonly normal_clarification_allowed: boolean;
  readonly reasons: readonly string[];
}

const materialitySchema = z.enum(["low", "medium", "high", "critical"]);
const closureStatusSchema = z.enum(["closed", "open", "na"]);
const resolutionModeSchema = z.enum([
  "none",
  "assume_and_proceed",
  "delegated_decision",
  "forced_choice",
  "safe_prefix",
  "hard_blocker",
]);
const boundedText = z.string().trim().min(1).max(2_000);
const boundedTextArray = z.array(boundedText).max(40).default([]);

const closureItemSchema = z.object({
  id: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(300).optional(),
  status: closureStatusSchema,
  materiality: materialitySchema,
  basis: z.string().trim().min(1).max(1_000).optional(),
}).strict();

const ambiguitySchema = z.object({
  id: z.string().trim().min(1).max(128),
  question: z.string().trim().min(1).max(1_000),
  materiality: materialitySchema,
  reversible: z.boolean(),
  blocking: z.boolean().optional(),
  delegated: z.boolean().optional(),
}).strict();

export const requirementModelSchema = z.object({
  intent_revision: z.number().int().min(1).max(1_000_000),
  objective: z.string().trim().min(1).max(4_000),
  scope: z.array(boundedText).min(1).max(40),
  out_of_scope: boundedTextArray,
  deliverables: boundedTextArray,
  success_criteria: z.array(boundedText).min(1).max(40),
  constraints: boundedTextArray,
  protected_resources: boundedTextArray,
  known_facts: boundedTextArray,
  assumptions: boundedTextArray,
  delegated_decisions: boundedTextArray,
  remaining_nonblocking_uncertainties: boundedTextArray,
  closure_items: z.array(closureItemSchema).max(40).default([]),
  ambiguities: z.array(ambiguitySchema).max(40).default([]),
  clarification_round: z.number().int().min(0).max(MAX_CLARIFICATION_ROUNDS).default(0),
  questions_in_round: z.number().int().min(0).max(MAX_QUESTIONS_PER_ROUND).default(0),
  resolution_mode: resolutionModeSchema.default("none"),
}).strict();

/**
 * Kept intentionally compact because this field is repeated in every
 * side-effecting tool's input schema. The detailed contract is described in
 * server instructions, not duplicated across tools/list.
 */
// Keep the repeated tools/list schema intentionally tiny. Runtime parsing below
// still enforces MAX_INTENT_JSON_CHARS, so omitting maxLength here does not
// weaken admission; it only avoids duplicating catalog metadata on every
// side-effecting tool.
export const intentAssuranceInputSchema = z.string().optional().describe("Required for side effects. JSON with intent_revision (positive integer), objective (string), scope and success_criteria (nonempty string arrays), plus actual constraints/uncertainties. Or use the exact accepted reference. A confidence percentage is not a requirement model; see server instructions.");

/** Explain the schema without supplying facts, granting authority or altering admission. */
export function requirementInputGuidance(): Record<string, unknown> {
  return {
    required_intent_fields: ["intent_revision", "objective", "scope", "success_criteria"],
    intent_field_types: { intent_revision: "integer >= 1", objective: "nonempty string", scope: "nonempty string[]", success_criteria: "nonempty string[]" },
    optional_intent_fields: ["out_of_scope", "deliverables", "constraints", "protected_resources", "known_facts", "assumptions", "delegated_decisions", "remaining_nonblocking_uncertainties", "closure_items", "ambiguities", "clarification_round", "questions_in_round", "resolution_mode"],
    guidance: "Use the actual user request and discovered constraints. Record material unknowns in ambiguities; do not fabricate readiness or omit a real blocker. JSON is strict: do not add confidence or readiness-score fields. After full admission reuse only the exact scoped reference returned by the server.",
  };
}

const MATERIALITY_WEIGHT: Record<RequirementMateriality, number> = {
  low: 1,
  medium: 2,
  high: 4,
  critical: 8,
};

export function parseRequirementModel(value: unknown): RequirementModel {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("REQUIREMENT_CONTRACT_REQUIRED: side-effecting tools require _intent JSON");
  }
  if (value.length > MAX_INTENT_JSON_CHARS) {
    throw new Error(`REQUIREMENT_CONTRACT_TOO_LARGE: _intent exceeds ${MAX_INTENT_JSON_CHARS} characters`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error("REQUIREMENT_CONTRACT_INVALID: _intent must be valid JSON");
  }
  const parsed = requirementModelSchema.safeParse(decoded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.length ? issue.path.join(".") : "_intent";
    throw new Error(`REQUIREMENT_CONTRACT_INVALID: ${field}: ${issue?.message ?? "invalid requirement model"}`);
  }
  return parsed.data;
}

function ambiguityIsBlocking(ambiguity: RequirementAmbiguity): boolean {
  // Critical uncertainty is never delegatable. A high-impact irreversible
  // uncertainty is equally unsafe even if the caller tries to mark it delegated.
  if (ambiguity.materiality === "critical") return true;
  if (ambiguity.materiality === "high" && !ambiguity.reversible) return true;
  if (ambiguity.delegated) return false;
  return ambiguity.blocking === true;
}

export function assessRequirementReadiness(model: RequirementModel): RequirementReadinessAssessment {
  const implicitClosedWeight =
    MATERIALITY_WEIGHT.critical + // objective
    MATERIALITY_WEIGHT.critical + // scope
    MATERIALITY_WEIGHT.critical; // success criteria

  let closedWeight = implicitClosedWeight;
  let openWeight = 0;
  const openItems: RequirementClosureItem[] = [];
  for (const item of model.closure_items) {
    if (item.status === "na") continue;
    const weight = MATERIALITY_WEIGHT[item.materiality];
    if (item.status === "closed") closedWeight += weight;
    else {
      openWeight += weight;
      openItems.push(item);
    }
  }

  // Ambiguities are semantic uncertainty, not content-quality points. Delegated
  // non-critical choices are closed by explicit user authorization and therefore
  // do not reduce readiness. Every other ambiguity contributes open weight.
  for (const ambiguity of model.ambiguities) {
    if (ambiguity.delegated && ambiguity.materiality !== "critical" && !(ambiguity.materiality === "high" && !ambiguity.reversible)) {
      closedWeight += MATERIALITY_WEIGHT[ambiguity.materiality];
    } else {
      openWeight += MATERIALITY_WEIGHT[ambiguity.materiality];
    }
  }

  const denominator = closedWeight + openWeight;
  const score = denominator > 0 ? Math.round((closedWeight / denominator) * 100) : 0;
  const blocking = model.ambiguities.filter(ambiguityIsBlocking);
  const resolutionStageRequired = model.clarification_round >= MAX_CLARIFICATION_ROUNDS && (score < REQUIREMENT_READY_SCORE || blocking.length > 0);
  const ready = score >= REQUIREMENT_READY_SCORE && blocking.length === 0;
  const reasons: string[] = [];
  if (score < REQUIREMENT_READY_SCORE) reasons.push(`RRS ${score} is below ${REQUIREMENT_READY_SCORE}`);
  if (blocking.length) reasons.push(`${blocking.length} blocking ambiguity/ambiguities remain`);
  if (resolutionStageRequired) reasons.push("normal clarification budget is exhausted; enter Resolution Stage instead of asking another normal round");
  if (model.questions_in_round > MAX_QUESTIONS_PER_ROUND) reasons.push("question budget exceeded");

  return Object.freeze({
    score,
    ready,
    blocking_ambiguities: Object.freeze([...blocking]),
    open_items: Object.freeze([...openItems]),
    resolution_stage_required: resolutionStageRequired,
    normal_clarification_allowed: !ready && model.clarification_round < MAX_CLARIFICATION_ROUNDS,
    reasons: Object.freeze(reasons),
  });
}

export type IntentToolEffect = "read_only" | "control_state" | "side_effect";

const CONTROL_STATE_TOOLS = new Set([
  "goal",
  "task_state",
  "task_status",
  "task_list",
]);

export function classifyIntentToolEffect(
  toolName: string,
  annotations?: { readonly readOnlyHint?: boolean }
): IntentToolEffect {
  if (annotations?.readOnlyHint === true) return "read_only";
  if (CONTROL_STATE_TOOLS.has(toolName)) return "control_state";
  return "side_effect";
}

export function toolRequiresExecutionContract(
  toolName: string,
  annotations?: { readonly readOnlyHint?: boolean }
): boolean {
  return classifyIntentToolEffect(toolName, annotations) === "side_effect";
}

function actionFromArgs(rawArgs: unknown): string | undefined {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) return undefined;
  const action = (rawArgs as Record<string, unknown>).action;
  return typeof action === "string" ? action : undefined;
}

/**
 * Some MCP tools intentionally combine observation and mutation actions under
 * one schema. Their catalog annotation must remain conservative, while runtime
 * admission may still allow an explicitly read-only action during discovery.
 */
export function invocationRequiresExecutionContract(
  toolName: string,
  annotations: { readonly readOnlyHint?: boolean } | undefined,
  rawArgs: unknown
): boolean {
  if (!toolRequiresExecutionContract(toolName, annotations)) return false;
  const action = actionFromArgs(rawArgs);
  if (!action) return true;

  switch (toolName) {
    case "visual_review":
      return action !== "status";
    case "code_intelligence":
      return action === "rename_apply";
    case "git_branch":
      return action !== "list";
    case "git_stash":
      return action !== "list";
    case "node_repl":
      return action !== "status";
    case "browser_action":
      return action !== "turn_observe" && action !== "wait";
    default:
      return true;
  }
}

export function extractIntentArgument(rawArgs: unknown): {
  intent: unknown;
  sanitizedArgs: unknown;
} {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return { intent: undefined, sanitizedArgs: rawArgs };
  }
  const record = rawArgs as Record<string, unknown>;
  if (!(INTENT_ASSURANCE_FIELD in record)) return { intent: undefined, sanitizedArgs: rawArgs };
  const { [INTENT_ASSURANCE_FIELD]: intent, ...rest } = record;
  return { intent, sanitizedArgs: rest };
}
