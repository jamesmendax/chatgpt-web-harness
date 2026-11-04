import { GOAL_RUN_EVIDENCE_KINDS } from "./goal-run-state.js";
import type {
  GoalRun,
  GoalRunEvidenceKind,
} from "./goal-run-state.js";

export const GOAL_RUN_POLICY_MAX_BYTES = 1_800;
export const GOAL_RUN_POLICY_DEFAULT_MAX_BYTES = GOAL_RUN_POLICY_MAX_BYTES;
export const GOAL_RUN_POLICY_MAX_TASK_POLICY_BYTES = 640;

const MAX_OBJECTIVE_BYTES = 240;
const MAX_PHASE_BYTES = 80;
const MAX_ACTION_BYTES = 180;
const MAX_IDENTIFIER_BYTES = 96;
const MAX_CURSOR_BYTES = 120;
const MAX_CRITERION_ID_BYTES = 64;
const MAX_POLICY_NAME_BYTES = 72;
const MAX_POLICY_NOTES_BYTES = 220;

export interface GoalRunTaskPolicy {
  readonly name: string;
  readonly requiredEvidenceKinds: readonly GoalRunEvidenceKind[];
  readonly notes?: string | null;
}

export type GoalRunPolicy = GoalRunTaskPolicy;

export interface GoalRunPolicyRenderOptions {
  readonly maxBytes?: number;
  readonly policies?: readonly GoalRunTaskPolicy[];
  readonly taskPolicies?: readonly GoalRunTaskPolicy[];
  readonly maxPolicyBytes?: number;
  readonly policyBudgetBytes?: number;
}

export interface GoalRunPolicyByteBudget {
  readonly used: number;
  readonly max: number;
  readonly remaining: number;
  readonly truncated: boolean;
}

export interface GoalRunPolicyRenderResult {
  readonly text: string;
  readonly bytes: number;
  readonly byteLength: number;
  readonly maxBytes: number;
  readonly truncated: boolean;
  readonly byteBudget: GoalRunPolicyByteBudget;
  readonly policyCount: number;
  readonly renderedPolicyCount: number;
  readonly omittedPolicyCount: number;
  readonly dedupedPolicyCount: number;
  readonly policyBytes: number;
  readonly maxPolicyBytes: number;
}

interface BoundedText {
  readonly text: string;
  readonly truncated: boolean;
}

interface NormalizedTaskPolicy extends GoalRunTaskPolicy {
  readonly key: string;
}

interface NormalizedPolicies {
  readonly policies: readonly NormalizedTaskPolicy[];
  readonly sourceCount: number;
  readonly dedupedCount: number;
  readonly truncated: boolean;
}

interface TruncationTracker {
  truncated: boolean;
}

type RenderOptionsOrPolicies =
  | GoalRunPolicyRenderOptions
  | readonly GoalRunTaskPolicy[];

const EVIDENCE_KIND_SET = new Set<string>(GOAL_RUN_EVIDENCE_KINDS);

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let result = "";
  for (const character of value) {
    const size = utf8Bytes(character);
    if (used + size > maxBytes) break;
    result += character;
    used += size;
  }
  return result;
}

function truncateUtf8(value: string, maxBytes: number, suffix = "…"): BoundedText {
  const normalizedLimit = Math.max(0, Math.floor(maxBytes));
  if (utf8Bytes(value) <= normalizedLimit) {
    return { text: value, truncated: false };
  }
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes > normalizedLimit) {
    return { text: utf8Prefix(value, normalizedLimit), truncated: true };
  }
  return {
    text: utf8Prefix(value, normalizedLimit - suffixBytes) + suffix,
    truncated: true,
  };
}

function compactText(value: unknown, maxBytes: number): BoundedText {
  const source = value === null || value === undefined ? "" : String(value);
  const normalized = source.replace(/\s+/gu, " ").trim();
  return truncateUtf8(normalized, maxBytes);
}

function display(
  value: unknown,
  maxBytes: number,
  tracker: TruncationTracker,
  fallback: string
): string {
  const bounded = compactText(value, maxBytes);
  tracker.truncated ||= bounded.truncated;
  return bounded.text || fallback;
}

function resolveMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return GOAL_RUN_POLICY_DEFAULT_MAX_BYTES;
  }
  return Math.min(GOAL_RUN_POLICY_MAX_BYTES, Math.floor(value));
}

function resolvePolicyBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return GOAL_RUN_POLICY_MAX_TASK_POLICY_BYTES;
  }
  return Math.min(GOAL_RUN_POLICY_MAX_TASK_POLICY_BYTES, Math.floor(value));
}

function normalizeOptions(
  input: RenderOptionsOrPolicies | undefined
): GoalRunPolicyRenderOptions {
  if (input === undefined) return {};
  if (Array.isArray(input)) {
    return { policies: input as readonly GoalRunTaskPolicy[] };
  }
  return input as GoalRunPolicyRenderOptions;
}

function normalizedEvidenceKinds(
  value: unknown
): readonly GoalRunEvidenceKind[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set<GoalRunEvidenceKind>();
  for (const rawKind of value) {
    if (typeof rawKind === "string" && EVIDENCE_KIND_SET.has(rawKind)) {
      selected.add(rawKind as GoalRunEvidenceKind);
    }
  }
  return GOAL_RUN_EVIDENCE_KINDS.filter((kind) => selected.has(kind));
}

function normalizePolicies(
  options: GoalRunPolicyRenderOptions,
  tracker: TruncationTracker
): NormalizedPolicies {
  const sources: readonly GoalRunTaskPolicy[] = ([] as GoalRunTaskPolicy[]).concat(
    Array.isArray(options.policies) ? options.policies : [],
    Array.isArray(options.taskPolicies) ? options.taskPolicies : []
  );
  const seen = new Set<string>();
  const normalized: NormalizedTaskPolicy[] = [];

  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const name = compactText(source.name, MAX_POLICY_NAME_BYTES);
    tracker.truncated ||= name.truncated;
    if (!name.text) continue;
    const key = name.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const notes = compactText(source.notes, MAX_POLICY_NOTES_BYTES);
    tracker.truncated ||= notes.truncated;
    normalized.push({
      name: name.text,
      requiredEvidenceKinds: normalizedEvidenceKinds(source.requiredEvidenceKinds),
      notes: notes.text || null,
      key,
    });
  }

  normalized.sort((left, right) => {
    if (left.key < right.key) return -1;
    if (left.key > right.key) return 1;
    return 0;
  });
  return {
    policies: normalized,
    sourceCount: sources.length,
    dedupedCount: Math.max(0, sources.length - normalized.length),
    truncated: tracker.truncated,
  };
}

function stateDirective(run: GoalRun, tracker: TruncationTracker): string {
  const wait = run.waitCondition;
  const waitId = display(wait?.id, MAX_IDENTIFIER_BYTES, tracker, "matching-wait");

  switch (run.state) {
    case "RUNNING":
      return "RUNNING: continue with tools while RUNNING; record verified evidence before confirming criteria.";
    case "WAITING_TOOL": {
      const toolName = wait?.kind === "TOOL" ? wait.toolName : "matching tool";
      return `WAITING_TOOL: resume only when tool ${display(toolName, MAX_IDENTIFIER_BYTES, tracker, "matching-tool")} returns for wait ${waitId}; then continue with tools.`;
    }
    case "WAITING_EXTERNAL_PROCESS": {
      const processRef = wait?.kind === "EXTERNAL_PROCESS" ? wait.processRef : "matching process";
      const deadline = display(wait?.deadlineAt, MAX_IDENTIFIER_BYTES, tracker, "the persisted deadline");
      const poll = wait?.kind === "EXTERNAL_PROCESS" ? String(wait.pollIntervalMs) : "the persisted interval";
      return `WAITING_EXTERNAL_PROCESS: resume only when external process ${display(processRef, MAX_IDENTIFIER_BYTES, tracker, "matching-process")} is satisfied for wait ${waitId}; poll every ${poll}ms until ${deadline}, then recover on timeout.`;
    }
    case "WAITING_USER": {
      const requestKey = wait?.kind === "USER" ? wait.requestKey : "matching request";
      return `WAITING_USER: resume only after a user response for request ${display(requestKey, MAX_IDENTIFIER_BYTES, tracker, "matching-request")} for wait ${waitId}.`;
    }
    case "WAITING_CONTROL_PLANE": {
      const cursor = display(run.resumeCursor, MAX_CURSOR_BYTES, tracker, "none");
      return `WAITING_CONTROL_PLANE: preserve Goal state, receipts, and cursor ${cursor}; do not treat control-plane downtime as no progress. Resume automatically after a capability-proved browser/MCP lane returns.`;
    }
    case "READY_TO_FINALIZE":
      return "READY_TO_FINALIZE: requires verified criteria; every criterion must be confirmed with non-launch evidence before completion.";
    case "COMPLETED":
      return "COMPLETED: no continuation; do not use more tools for this run.";
    case "NO_PROGRESS_PAUSED": {
      const cursor = display(run.resumeCursor, MAX_CURSOR_BYTES, tracker, "none");
      return `NO_PROGRESS_PAUSED: exact consecutive results persisted for the configured window. Preserve cursor ${cursor}; resume only after user direction or a changed recovery condition.`;
    }
    case "INTERRUPTED": {
      const cursor = display(run.resumeCursor, MAX_CURSOR_BYTES, tracker, "none");
      if (run.stopReason?.terminal) {
        return `INTERRUPTED: resume from cursor ${cursor} is unavailable after terminal cancellation; no continuation.`;
      }
      return `INTERRUPTED: resume from cursor ${cursor} only after an explicit resume; preserve the cursor.`;
    }
  }
}

function visibleHeartbeatDirective(run: GoalRun): string {
  if (
    run.state !== "RUNNING" &&
    run.state !== "WAITING_TOOL" &&
    run.state !== "WAITING_EXTERNAL_PROCESS"
  ) {
    return "";
  }
  return "heartbeat: after about 270s without user-visible assistant text, emit brief truthful progress before 300s and immediately continue; tool cards, MCP health, Goal revisions, and background stdout do not reset this timer.";
}

function criteriaLine(run: GoalRun, tracker: TruncationTracker): string {
  const confirmed = run.criteria.filter((criterion) => criterion.confirmed).length;
  const pending = run.criteria
    .filter((criterion) => !criterion.confirmed)
    .slice(0, 3)
    .map((criterion) => display(criterion.id, MAX_CRITERION_ID_BYTES, tracker, "unnamed"));
  const suffix = pending.length > 0 ? `; pending=${pending.join(",")}` : "";
  return `criteria: ${confirmed}/${run.criteria.length} confirmed${suffix}`;
}

function evidenceLine(run: GoalRun): string {
  const counts = new Map<GoalRunEvidenceKind, number>();
  for (const kind of GOAL_RUN_EVIDENCE_KINDS) counts.set(kind, 0);
  let verified = 0;
  for (const evidence of run.typedEvidence) {
    if (!counts.has(evidence.kind)) continue;
    counts.set(evidence.kind, (counts.get(evidence.kind) || 0) + 1);
    if (evidence.kind !== "launch_ack" && evidence.metadata.verifiesCriterion !== false) verified += 1;
  }
  const kinds = GOAL_RUN_EVIDENCE_KINDS
    .filter((kind) => (counts.get(kind) || 0) > 0)
    .map((kind) => `${kind}=${counts.get(kind)}`)
    .join(",");
  return `evidence: verified=${verified}; ${kinds || "none"}`;
}

function policyLine(
  policy: NormalizedTaskPolicy,
  run: GoalRun,
  tracker: TruncationTracker
): string {
  const available = new Set<GoalRunEvidenceKind>();
  for (const evidence of run.typedEvidence) {
    if (evidence.kind !== "launch_ack") available.add(evidence.kind);
  }
  const required = policy.requiredEvidenceKinds.map((kind) =>
    kind === "launch_ack" ? "launch_ack(trace-only)" : kind
  );
  const missing = policy.requiredEvidenceKinds
    .filter((kind) => kind === "launch_ack" || !available.has(kind))
    .map((kind) => (kind === "launch_ack" ? "launch_ack(trace-only)" : kind));
  const requirement = required.length > 0 ? required.join(",") : "none";
  const status = missing.length > 0 ? `; missing=${missing.join(",")}` : "; evidence=present";
  const notes = policy.notes
    ? `; notes=${display(policy.notes, MAX_POLICY_NOTES_BYTES, tracker, "")}`
    : "";
  return `policy ${display(policy.name, MAX_POLICY_NAME_BYTES, tracker, "unnamed")}: requires=${requirement}${status}${notes}`;
}

function appendLine(
  lines: string[],
  line: string,
  maxBytes: number,
  tracker: TruncationTracker,
  required: boolean
): boolean {
  if (!line) return true;
  const separator = lines.length > 0 ? "\n" : "";
  const candidate = separator + line;
  if (utf8Bytes(candidate) <= maxBytes - utf8Bytes(lines.join("\n"))) {
    lines.push(line);
    return true;
  }
  tracker.truncated = true;
  if (!required) return false;
  const used = utf8Bytes(lines.join("\n"));
  const remaining = maxBytes - used - utf8Bytes(separator);
  if (remaining <= 0) return false;
  const partial = utf8Prefix(line, remaining);
  if (!partial) return false;
  lines.push(partial);
  return false;
}

function policySources(options: GoalRunPolicyRenderOptions): readonly GoalRunTaskPolicy[] {
  return ([] as GoalRunTaskPolicy[]).concat(
    Array.isArray(options.policies) ? options.policies : [],
    Array.isArray(options.taskPolicies) ? options.taskPolicies : []
  );
}

export function renderGoalRunPolicy(
  run: GoalRun,
  options?: GoalRunPolicyRenderOptions
): GoalRunPolicyRenderResult;
export function renderGoalRunPolicy(
  run: GoalRun,
  policies?: readonly GoalRunTaskPolicy[]
): GoalRunPolicyRenderResult;
export function renderGoalRunPolicy(
  run: GoalRun,
  input?: RenderOptionsOrPolicies
): GoalRunPolicyRenderResult {
  const options = normalizeOptions(input);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const maxPolicyBytes = resolvePolicyBudget(
    options.maxPolicyBytes ?? options.policyBudgetBytes
  );
  const tracker: TruncationTracker = { truncated: false };
  const normalized = normalizePolicies(options, tracker);
  const lines: string[] = [];

  appendLine(lines, "GOAL RUN POLICY", maxBytes, tracker, true);
  appendLine(lines, `state: ${run.state}`, maxBytes, tracker, true);
  appendLine(lines, stateDirective(run, tracker), maxBytes, tracker, true);
  appendLine(
    lines,
    "safety: launch_ack never verifies a criterion; no automatic host wakeup is claimed.",
    maxBytes,
    tracker,
    true
  );
  appendLine(lines, visibleHeartbeatDirective(run), maxBytes, tracker, true);

  appendLine(
    lines,
    `run: ${display(run.runId, MAX_IDENTIFIER_BYTES, tracker, "unknown")} revision=${run.revision}`,
    maxBytes,
    tracker,
    false
  );
  appendLine(
    lines,
    `objective: ${display(run.objective, MAX_OBJECTIVE_BYTES, tracker, "unspecified")}`,
    maxBytes,
    tracker,
    false
  );
  appendLine(
    lines,
    `phase: ${display(run.currentPhase, MAX_PHASE_BYTES, tracker, "unspecified")}`,
    maxBytes,
    tracker,
    false
  );
  appendLine(lines, criteriaLine(run, tracker), maxBytes, tracker, false);
  appendLine(lines, evidenceLine(run), maxBytes, tracker, false);

  if (run.nextAction) {
    appendLine(
      lines,
      `next: ${display(run.nextAction, MAX_ACTION_BYTES, tracker, "unspecified")}`,
      maxBytes,
      tracker,
      false
    );
  }
  if (run.resumeCursor && run.state !== "INTERRUPTED" && run.state !== "NO_PROGRESS_PAUSED") {
    appendLine(
      lines,
      `cursor: ${display(run.resumeCursor, MAX_CURSOR_BYTES, tracker, "none")}`,
      maxBytes,
      tracker,
      false
    );
  }
  if (run.waitCondition) {
    appendLine(
      lines,
      `wait: ${display(run.waitCondition.description, MAX_ACTION_BYTES, tracker, "unspecified")} deadline=${display(run.waitCondition.deadlineAt, MAX_IDENTIFIER_BYTES, tracker, "unspecified")}`,
      maxBytes,
      tracker,
      false
    );
  }
  if (run.stopReason) {
    appendLine(
      lines,
      `stop: ${run.stopReason.kind}/${display(run.stopReason.code, MAX_IDENTIFIER_BYTES, tracker, "unspecified")}`,
      maxBytes,
      tracker,
      false
    );
  }

  let renderedPolicyCount = 0;
  let policyBytes = 0;
  if (normalized.policies.length > 0) {
    const header = `task policies: ${normalized.policies.length} accepted; duplicate names removed`;
    appendLine(lines, header, maxBytes, tracker, false);
    for (const policy of normalized.policies) {
      const line = policyLine(policy, run, tracker);
      const lineBytes = utf8Bytes(line) + (renderedPolicyCount > 0 ? 1 : 0);
      if (policyBytes + lineBytes > maxPolicyBytes) {
        tracker.truncated = true;
        continue;
      }
      if (!appendLine(lines, line, maxBytes, tracker, false)) continue;
      policyBytes += lineBytes;
      renderedPolicyCount += 1;
    }
  }

  const text = lines.join("\n");
  const bytes = utf8Bytes(text);
  const truncated = tracker.truncated || bytes > maxBytes;
  const safeText = bytes <= maxBytes ? text : utf8Prefix(text, maxBytes);
  const safeBytes = utf8Bytes(safeText);
  const sourcePolicyCount = policySources(options).length;
  const result: GoalRunPolicyRenderResult = {
    text: safeText,
    bytes: safeBytes,
    byteLength: safeBytes,
    maxBytes,
    truncated,
    byteBudget: {
      used: safeBytes,
      max: maxBytes,
      remaining: maxBytes - safeBytes,
      truncated,
    },
    policyCount: normalized.policies.length,
    renderedPolicyCount,
    omittedPolicyCount: Math.max(0, normalized.policies.length - renderedPolicyCount),
    dedupedPolicyCount: Math.max(0, sourcePolicyCount - normalized.policies.length),
    policyBytes,
    maxPolicyBytes,
  };
  return Object.freeze({
    ...result,
    byteBudget: Object.freeze(result.byteBudget),
  });
}

export function renderGoalRunPolicyText(
  run: GoalRun,
  input?: RenderOptionsOrPolicies
): string {
  return renderGoalRunPolicy(run, normalizeOptions(input)).text;
}

export const formatGoalRunPolicy = renderGoalRunPolicy;
