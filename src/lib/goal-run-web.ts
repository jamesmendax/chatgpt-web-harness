import { createHash } from "node:crypto";
import { assertGoalCriterionVerified, normalizeGoalVerification, verificationDigest } from "./goal-verification.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import {
  advanceGoalRun,
  type GoalRun,
  type GoalRunEvent,
  type GoalRunEvidenceKind,
  type GoalRunMetadataValue,
} from "./goal-run-state.js";
import {
  GoalRunStoreError,
  checkProjectionParity,
  clearProjectionRepairPending,
  createGoalRun as createStoredGoalRun,
  goalRunCriterionId,
  goalRunProjectionFingerprint,
  importLegacyGoal,
  markProjectionRepairPending,
  projectGoalRunToLegacy,
  promoteShadow,
  readGoalRun,
  recordGoalRunProjection,
  replaceGoalRun,
  replaceGoalRunEnvelopeMetadata,
  replaceGoalRunIdentity,
  type GoalRunEnvelope,
} from "./goal-run-store.js";
import {
  assertGoalAccessibleBySession,
  getGoal,
  goalVisibleToSession,
  withGoalTaskDefinitionFence,
  writeGoalRunProjection,
  type DurableGoal,
  type GoalCriterion,
} from "./goal-state-store.js";
import type { InvocationContext } from "./invocation-gateway.js";
import { getRuntimeScope, runWithRuntimeScope } from "./runtime-scope.js";
import { requireVerifiedHostUserConfirmation } from "./host-user-confirmation.js";

const SUMMARY_MAX = 500;
const STATE_TOOLS = new Set(["goal", "task_state"]);
const RUNTIME_TOOLS = new Set([
  "run_command",
  "start_process",
  "process_status",
  "process_output",
  "process_input",
  "stop_process",
  "render_svg",
  "capture_webpage",
  "visual_review",
]);

type JsonRecord = Record<string, unknown>;

export interface GoalRunWebEvidenceClassification {
  readonly id: string;
  readonly kind: GoalRunEvidenceKind;
  readonly summary: string;
  readonly source: string;
  readonly verifiesCriterion: boolean;
  readonly metadata: Readonly<Record<string, GoalRunMetadataValue>>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(value: unknown, fallback: string, max = SUMMARY_MAX): string {
  if (typeof value !== "string") return fallback;
  const compact = value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, "[redacted-key]")
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
  return (compact || fallback).slice(0, max);
}

function parseTextPayload(result: CallToolResult): JsonRecord | null {
  for (const item of result.content ?? []) {
    if (item.type !== "text" || typeof item.text !== "string") continue;
    const text = item.text.trim();
    if (text.length > 64_000) continue;
    if (!text.startsWith("{") || !text.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(text);
      if (isRecord(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function resultPayload(result: CallToolResult | undefined): JsonRecord {
  if (!result) return {};
  if (isRecord(result.structuredContent)) return result.structuredContent;
  return parseTextPayload(result) ?? {};
}

function payloadData(payload: JsonRecord): JsonRecord {
  return isRecord(payload.data) ? payload.data : {};
}

function numericField(data: JsonRecord, ...keys: string[]): number | null | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "number" || value === null) return value;
  }
  return undefined;
}

function booleanField(data: JsonRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof data[key] === "boolean") return data[key] as boolean;
  }
  return undefined;
}

function stringField(data: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof data[key] === "string") return data[key] as string;
  }
  return undefined;
}

function processRows(data: JsonRecord): JsonRecord[] {
  return Array.isArray(data.processes) ? data.processes.filter(isRecord) : [];
}

function observedProcessRef(context: InvocationContext, data: JsonRecord): string | undefined {
  const args = isRecord(context.rawArgs) ? context.rawArgs : {};
  const explicit = stringField(args, "id") ?? stringField(data, "id");
  if (explicit) return explicit;
  const rows = processRows(data);
  return rows.length === 1 ? stringField(rows[0], "id") : undefined;
}

function observedRunning(data: JsonRecord): boolean | undefined {
  const direct = booleanField(data, "running");
  if (direct !== undefined) return direct;
  const rows = processRows(data);
  if (!rows.length) return undefined;
  const values = rows
    .map((row) => booleanField(row, "running"))
    .filter((value): value is boolean => value !== undefined);
  if (!values.length) return undefined;
  if (values.some((value) => value)) return true;
  if (values.length === rows.length) return false;
  return undefined;
}

function observedExitCode(data: JsonRecord): number | null | undefined {
  const direct = numericField(data, "exit_code", "exitCode");
  if (direct !== undefined) return direct;
  const rows = processRows(data);
  if (!rows.length) return undefined;
  const values = rows
    .map((row) => numericField(row, "exit_code", "exitCode"))
    .filter((value): value is number | null => value !== undefined);
  if (!values.length) return undefined;
  if (values.some((value) => value === null)) return null;
  const first = values[0];
  return values.every((value) => value === first) ? first : null;
}

function visualVerdict(data: JsonRecord): string | undefined {
  const direct = stringField(data, "verdict", "visual_status");
  if (direct) return direct.toLowerCase();
  const assessment = isRecord(data.model_visual_assessment) ? data.model_visual_assessment : null;
  return assessment ? stringField(assessment, "verdict")?.toLowerCase() : undefined;
}

function isLaunchAcknowledgement(tool: string, data: JsonRecord): boolean {
  const running = observedRunning(data);
  const exitCode = observedExitCode(data);
  const status = stringField(data, "status", "state")?.toLowerCase();
  if (tool === "start_process") return running !== false || exitCode === undefined || exitCode === null;
  if (tool === "process_status" || tool === "process_output") {
    return running === true || ["starting", "started", "running", "pending", "queued"].includes(status ?? "");
  }
  return false;
}

function evidenceKind(tool: string, data: JsonRecord, launch: boolean): GoalRunEvidenceKind {
  if (launch) return "launch_ack";
  if (tool === "visual_review" && (data.action === "assess" || isRecord(data.model_visual_assessment))) {
    return "model_assessed";
  }
  return RUNTIME_TOOLS.has(tool) ? "runtime" : "deterministic";
}

function evidenceVerifies(
  tool: string,
  kind: GoalRunEvidenceKind,
  ok: boolean,
  data: JsonRecord
): boolean {
  // Stopping a process is an action acknowledgement, never proof that the
  // goal's requested work succeeded.
  if (tool === "stop_process" || tool === "process_input" || kind === "launch_ack" || !ok) return false;
  // A model-assessed result must carry an explicit passing verdict; a generic
  // successful visual tool response is not enough.
  if (kind === "model_assessed") {
    const verdict = visualVerdict(data);
    const passLike = Boolean(verdict && ["pass", "passed", "ready", "approved", "ok"].includes(verdict));
    if (tool === "visual_review") {
      const coverage = isRecord(data.model_visual_coverage) ? data.model_visual_coverage : null;
      return passLike && booleanField(data, "model_visual_ready") === true &&
        booleanField(data, "fresh") === true && Boolean(coverage && booleanField(coverage, "complete") === true);
    }
    return passLike;
  }
  // Do not turn a result containing only a generic success/summary into proof.
  if (Object.keys(data).length === 0) return false;
  const running = observedRunning(data);
  if (running === true) return false;
  const exitCode = observedExitCode(data);
  if (exitCode !== undefined) return exitCode === 0;
  const verdict = visualVerdict(data);
  if (verdict) return ["pass", "passed", "ready", "approved", "ok"].includes(verdict);
  return true;
}

/** Pure, bounded classification of one MCP tool outcome for GoalRun. */
export function classifyGoalRunToolEvidence(
  context: InvocationContext,
  result?: CallToolResult,
  thrownError?: unknown
): GoalRunWebEvidenceClassification | null {
  const tool = context.definition.name;
  if (STATE_TOOLS.has(tool)) return null;
  const payload = resultPayload(result);
  const data = payloadData(payload);
  const ok = thrownError === undefined && payload.ok !== false && result?.isError !== true;
  const launch = isLaunchAcknowledgement(tool, data);
  const kind = evidenceKind(tool, data, launch);
  const verifiesCriterion = evidenceVerifies(tool, kind, ok, data);
  const fallback = `${tool}: ${ok ? "completed" : "failed"}`;
  const summary = compactText(
    thrownError instanceof Error ? thrownError.message : thrownError ?? payload.summary,
    fallback
  );
  const exitCode = observedExitCode(data);
  const running = observedRunning(data);
  const status = stringField(data, "status", "state");
  const processRef = tool === "process_status" || tool === "process_output"
    ? observedProcessRef(context, data)
    : undefined;
  const metadata: Record<string, GoalRunMetadataValue> = {
    tool,
    ok,
    verifiesCriterion,
    invocationId: context.scope.invocationId,
  };
  if (exitCode !== undefined) metadata.exitCode = exitCode;
  if (running !== undefined) metadata.running = running;
  if (status) metadata.status = compactText(status, "unknown", 80);
  if (processRef) metadata.processRef = compactText(processRef, "unknown", 512);
  const observed = Array.isArray(data.processes) && data.processes.length === 1 && isRecord(data.processes[0]) ? data.processes[0] : data;
  const command = stringField(observed, "command");
  const cwd = stringField(observed, "cwd");
  const target = stringField(data, "path", "target");
  const reviewId = stringField(data, "review_id");
  const sha256 = stringField(data, "sha256");
  const verificationSourceStable = booleanField(observed, "verification_source_stable");
  if (command) metadata.commandHash = verificationDigest(command.trim());
  if (cwd) metadata.cwd = cwd;
  if (target) metadata.target = target;
  if (reviewId) metadata.reviewId = reviewId;
  if (sha256) metadata.sha256 = sha256;
  if (verificationSourceStable !== undefined) metadata.verificationSourceStable = verificationSourceStable;
  for (const source of [data, observed]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith("verification_") && typeof value === "string") metadata[key] = value;
    }
  }
  return Object.freeze({
    id: `tool-${context.scope.invocationId}`.slice(0, 128),
    kind,
    summary,
    source: `${context.definition.source}:${tool}`.slice(0, 512),
    verifiesCriterion,
    metadata: Object.freeze(metadata),
  });
}

function transitionTime(run: GoalRun): string {
  const prior = Date.parse(run.timestamps.updatedAt);
  return new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior : 0)).toISOString();
}

function envelopeRevision(envelope: GoalRunEnvelope): number {
  return envelope.envelopeRevision ?? 1;
}

function criterionKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cleanString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, max) : undefined;
}

function normalizeConstraints(input: readonly string[] | undefined, fallback: string[]): string[] {
  if (!input) return fallback;
  const seen = new Set<string>();
  const values: string[] = [];
  for (const raw of input) {
    const value = cleanString(raw, 1000);
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    values.push(value);
  }
  return values.slice(0, 24);
}

function mergeLegacyCriteria(
  current: readonly GoalCriterion[],
  patch: readonly (GoalCriterion & { id?: string })[] | undefined,
  envelope: GoalRunEnvelope
): GoalCriterion[] {
  const merged = current.map((criterion) => ({ ...criterion }));
  if (!patch) return merged;
  for (const raw of patch) {
    const name = cleanString(raw.name, 300);
    if (!name) continue;
    if (raw.passed === true) {
      throw new Error(
        `UNVERIFIED_CRITERION_UPDATE: criterion "${name}" cannot be marked passed via goal(action=update); record a successful tool result and use goal(action=confirm, evidence_ids=[...]).`
      );
    }
    const bound = raw.id ? envelope.run.criteria.find(candidate => candidate.id === raw.id) : undefined;
    if (raw.id && !bound) throw new Error(`Unknown criterion ID "${raw.id}".`);
    const index = merged.findIndex((criterion) => criterionKey(criterion.name) === criterionKey(bound?.description ?? name));
    if (raw.id && index < 0) throw new Error(`Criterion ID "${raw.id}" does not match the current Goal.`);
    if (index >= 0 && criterionKey(merged[index].name) !== criterionKey(name)) {
      if (merged[index].passed) throw new Error("Cannot rename a confirmed criterion; add a new criterion for the changed requirement.");
      if (merged.some((candidate, i) => i !== index && criterionKey(candidate.name) === criterionKey(name))) {
        throw new Error(`A criterion named "${name}" already exists.`);
      }
    }
    const previous = index >= 0 ? merged[index] : undefined;
    const detail = cleanString(raw.detail, 2000);
    const next: GoalCriterion = {
      name,
      passed: previous?.passed ?? false,
      ...(raw.verification !== undefined || previous?.verification
        ? { verification: normalizeGoalVerification(raw.verification ?? previous?.verification) } : {}),
      ...(raw.requires_confirmation === true || previous?.requires_confirmation
        ? { requires_confirmation: true }
        : {}),
      ...(detail ? { detail } : previous?.detail ? { detail: previous.detail } : {}),
    };
    if (index >= 0) merged[index] = next;
    else merged.push(next);
  }
  return merged.slice(0, 40);
}

function runCriteriaFor(
  envelope: GoalRunEnvelope,
  criteria: readonly GoalCriterion[],
  previousCriteria?: readonly GoalCriterion[]
): { readonly id: string; readonly description: string }[] {
  return criteria.map((criterion, index) => {
    const existing = envelope.run.criteria.find(
      (candidate) => criterionKey(candidate.description) === criterionKey(previousCriteria?.[index]?.name ?? criterion.name)
    );
    return {
      id: existing?.id ?? goalRunCriterionId(criterion.name, index),
      description: criterion.name,
    };
  });
}

async function persistEnvelopeMetadata(
  workspaceRoot: string,
  previous: GoalRunEnvelope,
  next: GoalRunEnvelope
): Promise<GoalRunEnvelope> {
  return replaceGoalRunEnvelopeMetadata(workspaceRoot, next, {
    expectedEnvelopeRevision: envelopeRevision(previous),
    expectedRunRevision: previous.run.revision,
  });
}

function projectionMismatch(envelope: GoalRunEnvelope): boolean {
  const parity = envelope.parity;
  return isRecord(parity) && parity.kind === "projection" && parity.mismatch !== null;
}

function projectionRepairPending(envelope: GoalRunEnvelope): boolean {
  const parity = envelope.parity;
  return isRecord(parity) && parity.kind === "projection" && parity.repairPending === true;
}

function recordVerifiedProjection(envelope: GoalRunEnvelope, goal: DurableGoal): GoalRunEnvelope {
  const recorded = recordGoalRunProjection(envelope, goal);
  const verified = projectionRepairPending(recorded)
    ? clearProjectionRepairPending(recorded, goal)
    : recorded;
  return { ...verified, envelopeRevision: envelopeRevision(envelope) + 1 };
}

function projectionSemanticKey(goal: DurableGoal): string {
  return JSON.stringify({
    id: goal.id,
    objective: goal.objective,
    success_criteria: goal.success_criteria.map((criterion) => ({
      name: criterion.name,
      passed: criterion.passed,
      ...(criterion.detail ? { detail: criterion.detail } : {}),
      ...(criterion.requires_confirmation ? { requires_confirmation: true } : {}),
      ...(criterion.verification ? { verification: criterion.verification } : {}),
    })),
    constraints: goal.constraints,
    status: goal.status,
    current_phase: goal.current_phase,
    ...(goal.owner_session ? { owner_session: goal.owner_session } : {}),
    ...(goal.completed_at ? { completed_at: goal.completed_at } : {}),
  });
}

async function promoteVerifiedShadow(
  workspaceRoot: string,
  shadow: GoalRunEnvelope,
  legacy: DurableGoal
): Promise<GoalRunEnvelope> {
  if (shadow.shadow === false) return shadow;
  const checked = checkProjectionParity(shadow, legacy);
  const persistedCheck = await persistEnvelopeMetadata(workspaceRoot, shadow, checked);
  if (projectionMismatch(persistedCheck)) {
    throw new Error(
      `GOAL_RUN_SHADOW_DIVERGED: GoalRun ${shadow.run.runId} does not match the legacy goal projection.`
    );
  }
  const promoted = promoteShadow(persistedCheck, {
    expectedEnvelopeRevision: envelopeRevision(persistedCheck),
    expectedRunRevision: persistedCheck.run.revision,
  });
  return persistEnvelopeMetadata(workspaceRoot, persistedCheck, promoted);
}

export async function ensureGoalRunAuthority(
  workspaceRoot: string,
  goal: DurableGoal,
  options: { allowActiveSupersede?: boolean; allowIdentityReplacement?: boolean } = {}
): Promise<GoalRunEnvelope> {
  assertGoalAccessibleBySession(goal, getRuntimeScope()?.mcpSessionId);
  let envelope = await readGoalRun(workspaceRoot);
  if (!envelope || envelope.run.runId !== goal.id) {
    if (envelope && options.allowIdentityReplacement === false) {
      throw new Error("GOAL_SCOPE_CHANGED: evidence observation cannot replace a different GoalRun identity.");
    }
    const imported = importLegacyGoal(goal);
    if (!envelope) {
      envelope = await createStoredGoalRun(workspaceRoot, imported);
    } else {
      envelope = await replaceGoalRunIdentity(workspaceRoot, imported, {
        expectedRunId: envelope.run.runId,
        expectedRunRevision: envelope.run.revision,
        expectedEnvelopeRevision: envelopeRevision(envelope),
        allowActiveSupersede: options.allowActiveSupersede,
      });
    }
  }
  if (envelope.shadow !== false) {
    return promoteVerifiedShadow(workspaceRoot, envelope, goal);
  }
  // Evidence-only transitions intentionally advance GoalRun without rewriting
  // goal.json. The legacy projection revision, not the live run revision, is
  // therefore the compatibility cursor.
  const projected = projectGoalRunToLegacy(envelope, goal) as DurableGoal;
  if (projectionSemanticKey(projected) === projectionSemanticKey(goal)) {
    if (!projectionRepairPending(envelope) && !projectionMismatch(envelope)) return envelope;
    const cleared = clearProjectionRepairPending(envelope, goal);
    return persistEnvelopeMetadata(workspaceRoot, envelope, {
      ...cleared,
      envelopeRevision: envelopeRevision(envelope) + 1,
    });
  }
  // If goal.json still equals the last committed projection, a crash between
  // GoalRun commit and legacy projection is safely repairable. If its
  // fingerprint changed, treat it as an external writer and fail closed.
  if (envelope.legacyProjectionFingerprint === goalRunProjectionFingerprint(goal)) {
    const repairedGoal = await writeGoalRunProjection(workspaceRoot, projected, {
      expectedCurrentRevision: goal.revision,
      operation: "goal-run:repair-projection",
    });
    const recorded = recordVerifiedProjection(envelope, repairedGoal);
    return persistEnvelopeMetadata(workspaceRoot, envelope, recorded);
  }
  const checked = checkProjectionParity(envelope, goal);
  const persisted = await persistEnvelopeMetadata(workspaceRoot, envelope, checked);
  throw new Error(
    `GOAL_RUN_PROJECTION_DIVERGED: authoritative run ${persisted.run.runId} revision ${persisted.run.revision} does not match goal.json revision ${goal.revision}.`
  );
}

async function persistRunOnly(
  workspaceRoot: string,
  envelope: GoalRunEnvelope,
  event: GoalRunEvent,
  now?: string
): Promise<GoalRunEnvelope> {
  const advanced = advanceGoalRun(envelope.run, event, {
    expectedRevision: envelope.run.revision,
    now: now ?? transitionTime(envelope.run),
  });
  if (!advanced.transition.changed) return envelope;
  return replaceGoalRun(
    workspaceRoot,
    { ...envelope, run: advanced.run },
    { expectedRevision: envelope.run.revision }
  );
}

async function markProjectionFailure(
  workspaceRoot: string,
  envelope: GoalRunEnvelope,
  error: unknown
): Promise<void> {
  try {
    const pending = markProjectionRepairPending(
      envelope,
      `goal.json projection failed: ${error instanceof Error ? error.message : String(error)}`
    );
    await persistEnvelopeMetadata(workspaceRoot, envelope, pending);
  } catch {}
}

async function commitRunProjection(
  workspaceRoot: string,
  envelope: GoalRunEnvelope,
  legacyBase: DurableGoal,
  event: GoalRunEvent,
  operation: string
): Promise<{ readonly envelope: GoalRunEnvelope; readonly goal: DurableGoal }> {
  const stored = await persistRunOnly(workspaceRoot, envelope, event);
  if (stored === envelope) return { envelope, goal: legacyBase };
  const projection = projectGoalRunToLegacy(stored, legacyBase);
  let goal: DurableGoal;
  try {
    goal = await writeGoalRunProjection(workspaceRoot, projection, {
      expectedCurrentRevision: legacyBase.revision,
      operation,
    });
  } catch (error) {
    await markProjectionFailure(workspaceRoot, stored, error);
    throw error;
  }
  const recorded = recordVerifiedProjection(stored, goal);
  const reconciled = await persistEnvelopeMetadata(workspaceRoot, stored, recorded);
  return { envelope: reconciled, goal };
}

export interface GoalRunDefinitionPatch {
  readonly objective?: string;
  readonly success_criteria?: readonly (GoalCriterion & { id?: string })[];
  readonly constraints?: readonly string[];
  readonly current_phase?: string;
}

export async function updateGoalRunDefinition(
  workspaceRoot: string,
  patch: GoalRunDefinitionPatch,
  expectedRevision?: number
): Promise<{ readonly envelope: GoalRunEnvelope; readonly goal: DurableGoal }> {
  return withGoalTaskDefinitionFence(workspaceRoot, async () => {
  const current = await getGoal(workspaceRoot);
  if (!current) throw new Error("No goal exists for this workspace. Create one with goal action=create.");
  if (current.status === "completed" || current.status === "cancelled") {
    throw new Error(`Cannot update a ${current.status} goal. Create a new goal instead.`);
  }
  if (expectedRevision !== undefined && current.revision !== expectedRevision) {
    throw new Error(`GOAL_STALE_REVISION: goal revision is ${current.revision}, but ${expectedRevision} was supplied.`);
  }
  const envelope = await ensureGoalRunAuthority(workspaceRoot, current);
  const criteria = mergeLegacyCriteria(current.success_criteria, patch.success_criteria, envelope);
  const legacyBase: DurableGoal = {
    ...current,
    objective: cleanString(patch.objective, 4000) ?? current.objective,
    success_criteria: criteria,
    constraints: normalizeConstraints(patch.constraints, current.constraints),
    current_phase: cleanString(patch.current_phase, 2000) ?? current.current_phase,
  };
  return commitRunProjection(
    workspaceRoot,
    envelope,
    legacyBase,
    {
      type: "definition_update",
      objective: legacyBase.objective,
      criteria: runCriteriaFor(envelope, criteria, current.success_criteria),
      currentPhase: legacyBase.current_phase,
    },
    "goal-run:update"
  );
  });
}

function confirmationEvidenceId(
  run: GoalRun,
  criterionId: string,
  detail: string | undefined,
  receiptSha256: string
): string {
  const digest = createHash("sha256")
    .update(`${run.runId}\0${run.revision}\0${criterionId}\0${detail ?? ""}\0${receiptSha256}`)
    .digest("hex")
    .slice(0, 24);
  return `user-confirmed-${digest}`;
}

export async function confirmGoalRunCriterion(
  workspaceRoot: string,
  input: {
    readonly criterion: string;
    readonly evidenceIds?: readonly string[];
    readonly detail?: string;
    readonly expectedRevision?: number;
  }
): Promise<{ readonly envelope: GoalRunEnvelope; readonly goal: DurableGoal }> {
  const current = await getGoal(workspaceRoot);
  if (!current) throw new Error("No goal exists for this workspace.");
  if (current.status !== "active") throw new Error(`Cannot confirm criteria on a ${current.status} goal.`);
  if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
    throw new Error(`GOAL_STALE_REVISION: goal revision is ${current.revision}, but ${input.expectedRevision} was supplied.`);
  }
  let envelope = await ensureGoalRunAuthority(workspaceRoot, current);
  // Status exposes GoalRun IDs; map those IDs, legacy generated IDs and names
  // through the same current projection, preserving stable IDs on edits.
  const requested = input.criterion.trim();
  const byRunId = envelope.run.criteria.find(candidate => candidate.id === requested);
  const index = current.success_criteria.findIndex((candidate, index) =>
    criterionKey(candidate.name) === criterionKey(byRunId?.description ?? requested) ||
    goalRunCriterionId(candidate.name, index) === requested);
  const legacyCriterion = current.success_criteria[index];
  if (!legacyCriterion) throw new Error(`Unknown criterion "${input.criterion}".`);
  const runCriterion = byRunId ?? envelope.run.criteria.find(candidate =>
    criterionKey(candidate.description) === criterionKey(legacyCriterion.name));
  if (!runCriterion) throw new Error(`GoalRun criterion mapping is missing for "${legacyCriterion.name}".`);
  const evidenceIds = [...new Set(input.evidenceIds ?? [])];
  if (!evidenceIds.length) throw new Error(`criterion "${legacyCriterion.name}" requires evidence_ids from successful tool results`);
  await assertGoalCriterionVerified(workspaceRoot, legacyCriterion, envelope.run.typedEvidence.filter((item) => evidenceIds.includes(item.id)));
  return commitRunProjection(
    workspaceRoot,
    envelope,
    current,
    { type: runCriterion.confirmed ? "reconfirm_criterion" : "confirm_criterion", criterionId: runCriterion.id, evidenceIds },
    "goal-run:confirm"
  );
}

export async function transitionGoalRunLifecycle(
  workspaceRoot: string,
  action: "pause" | "resume" | "complete" | "cancel" | "wait_control_plane" | "control_plane_ready",
  options: { readonly currentPhase?: string; readonly expectedRevision?: number; readonly pauseKind?: "manual" | "no_progress"; readonly declaration?: string } = {}
): Promise<{ readonly envelope: GoalRunEnvelope; readonly goal: DurableGoal }> {
  return withGoalTaskDefinitionFence(workspaceRoot, async () => {
  const current = await getGoal(workspaceRoot);
  if (!current) throw new Error("No goal exists for this workspace.");
  if (options.expectedRevision !== undefined && current.revision !== options.expectedRevision) {
    throw new Error(`GOAL_STALE_REVISION: goal revision is ${current.revision}, but ${options.expectedRevision} was supplied.`);
  }
  let envelope = await ensureGoalRunAuthority(workspaceRoot, current);
  if (action === "complete") {
    if (current.status === "cancelled" || current.status === "completed") throw new Error(`Cannot complete a ${current.status} goal.`);
    const unverified: string[] = [];
    for (const criterion of current.success_criteria) {
      const bound = envelope.run.criteria.find((candidate) => criterionKey(candidate.description) === criterionKey(criterion.name));
      if (!bound) throw new Error(`GoalRun criterion mapping is missing for "${criterion.name}".`);
      if (!bound.confirmed) { unverified.push(bound.id); continue; }
      try { await assertGoalCriterionVerified(workspaceRoot, criterion, envelope.run.typedEvidence.filter((item) => bound.evidenceIds.includes(item.id))); }
      catch { unverified.push(bound.id); }
    }
    return commitRunProjection(workspaceRoot, envelope, current, {
      type: "declare_complete", declaration: options.declaration?.trim() || "Model declared goal complete",
      unverifiedCriterionIds: unverified,
    }, "goal-run:complete");
  }
  const event: GoalRunEvent = action === "pause"
    ? {
        type: "pause",
        pauseKind: options.pauseKind,
        code: options.pauseKind === "no_progress" ? "goal_no_progress" : "goal_pause",
        message: options.currentPhase ?? (options.pauseKind === "no_progress" ? "No semantic progress for the configured repeat window" : "Paused"),
        currentPhase: options.currentPhase,
      }
    : action === "resume"
      ? { type: "resume", currentPhase: options.currentPhase }
      : action === "wait_control_plane"
        ? {
            type: "control_plane_wait",
            message: options.currentPhase ?? "Browser/MCP control plane is unavailable",
            currentPhase: options.currentPhase,
          }
        : action === "control_plane_ready"
          ? { type: "control_plane_ready", currentPhase: options.currentPhase }
      : { type: "cancel", code: "goal_cancel", message: "Cancelled" };
  return commitRunProjection(workspaceRoot, envelope, current, event, `goal-run:${action}`);
  });
}

/**
 * Reconcile the one legacy-first mutation that remains for session ownership
 * (`goal(action=bind)`). No criterion or lifecycle truth is imported from it.
 */
export async function synchronizeCommittedLegacyGoal(
  workspaceRoot: string,
  goal: DurableGoal
): Promise<GoalRunEnvelope> {
  const existing = await readGoalRun(workspaceRoot);
  if (!existing || existing.run.runId !== goal.id) {
    return ensureGoalRunAuthority(workspaceRoot, goal);
  }
  const stored = await persistRunOnly(workspaceRoot, existing, {
    type: "definition_update",
    objective: goal.objective,
    criteria: runCriteriaFor(existing, goal.success_criteria),
    currentPhase: goal.current_phase,
  }, goal.updated_at);
  // GoalRun revisions may be far ahead of goal.json because evidence-only
  // transitions intentionally advance the authoritative run without rewriting
  // the legacy compatibility projection. A session bind mutates goal.json
  // first, so reconcile by projecting the authoritative run back onto that
  // bound legacy base (which preserves owner_session and unknown fields).
  // Comparing the low post-bind legacy revision directly against the advanced
  // GoalRun revision would otherwise report a false projection divergence.
  const projection = projectGoalRunToLegacy(stored, goal) as DurableGoal;
  let synchronizedGoal = goal;
  if (projection.revision > goal.revision) {
    synchronizedGoal = await writeGoalRunProjection(workspaceRoot, projection, {
      expectedCurrentRevision: goal.revision,
      operation: "goal-run:bind-projection",
    });
  }
  const recorded = recordVerifiedProjection(stored, synchronizedGoal);
  if (projectionMismatch(recorded)) {
    throw new Error(`GOAL_RUN_PROJECTION_DIVERGED: bound goal ${goal.id} does not match its GoalRun projection.`);
  }
  const synchronized = await persistEnvelopeMetadata(workspaceRoot, stored, recorded);
  // Creation now persists its shadow before the first public observation. An
  // explicit bind must also finish promotion after verifying the bound parity.
  return promoteVerifiedShadow(workspaceRoot, synchronized, synchronizedGoal);
}

async function ensureShadowEnvelope(
  workspaceRoot: string,
  context: InvocationContext
): Promise<GoalRunEnvelope | null> {
  const goal = await getGoal(workspaceRoot, context.scope.mcpSessionId);
  if (Object.prototype.hasOwnProperty.call(context.scope, "goalId") &&
      (goal?.id !== context.scope.goalId || goal?.owner_session !== context.scope.goalOwnerSessionId)) return null;
  if (!goal || goal.status !== "active" || !goalVisibleToSession(goal, context.scope.mcpSessionId)) return null;
  try {
    return await ensureGoalRunAuthority(workspaceRoot, goal, { allowIdentityReplacement: false });
  } catch (error) {
    if (!(error instanceof GoalRunStoreError) || error.code !== "ALREADY_EXISTS") throw error;
    const raced = await readGoalRun(workspaceRoot, context.scope.mcpSessionId);
    return raced?.run.runId === goal.id ? raced : null;
  }
}

async function assertEvidenceScope(workspaceRoot: string, context: InvocationContext, current: GoalRunEnvelope): Promise<void> {
  // This executes inside replaceGoalRun's store lock. Creation publishes its
  // pending journal under the same lock, so a late result cannot cross it.
  const goal = await getGoal(workspaceRoot, context.scope.mcpSessionId);
  if (!goal || goal.id !== current.run.runId || !goalVisibleToSession(goal, context.scope.mcpSessionId) ||
      (Object.prototype.hasOwnProperty.call(context.scope, "goalId") &&
        (current.run.runId !== context.scope.goalId || goal.owner_session !== context.scope.goalOwnerSessionId))) {
    throw new Error("GOAL_SCOPE_CHANGED: the result no longer belongs to this session's authoritative GoalRun.");
  }
}

async function persistEvidenceOnce(
  workspaceRoot: string,
  envelope: GoalRunEnvelope,
  classification: GoalRunWebEvidenceClassification,
  context: InvocationContext
): Promise<GoalRunEnvelope> {
  let current = envelope;
  if (
    current.run.state === "WAITING_EXTERNAL_PROCESS" &&
    current.run.waitCondition?.kind === "EXTERNAL_PROCESS"
  ) {
    const wait = current.run.waitCondition;
    const now = transitionTime(current.run);
    let event: GoalRunEvent | null = null;
    if (Date.parse(now) >= Date.parse(wait.deadlineAt)) {
      event = {
        type: "wait_timeout",
        waitId: wait.id,
        message: `External process ${wait.processRef} did not complete before ${wait.deadlineAt}`,
        nextAction: `Inspect and recover external process ${wait.processRef} once`,
      };
    } else if (
      (classification.metadata.tool === "process_status" || classification.metadata.tool === "process_output") &&
      classification.metadata.processRef === wait.processRef
    ) {
      const ok = classification.metadata.ok === true;
      const running = classification.metadata.running;
      const exitCode = classification.metadata.exitCode;
      if (!ok || (running === false && exitCode !== 0)) {
        event = {
          type: "interrupt",
          code: "external_process_failed",
          message: `External process ${wait.processRef} failed: ${classification.summary}`,
          nextAction: `Inspect and recover external process ${wait.processRef} once`,
        };
      } else if (running === false && exitCode === 0) {
        event = {
          type: "external_satisfied",
          waitId: wait.id,
          summary: classification.summary,
        };
      }
    }
    if (event) {
      const advanced = advanceGoalRun(current.run, event, {
        expectedRevision: current.run.revision,
        now,
      });
      current = await replaceGoalRun(
        workspaceRoot,
        { ...current, run: advanced.run },
        { expectedRevision: current.run.revision, beforeCommit: (stored) => assertEvidenceScope(workspaceRoot, context, stored) },
        context.scope.mcpSessionId
      );
    }
  }
  if (
    current.run.state === "WAITING_TOOL" &&
    current.run.waitCondition?.kind === "TOOL" &&
    current.run.waitCondition.toolName === classification.metadata.tool
  ) {
    const cleared = advanceGoalRun(current.run, {
      type: "tool_result",
      waitId: current.run.waitCondition.id,
      outcome: classification.metadata.ok === true ? "succeeded" : "failed",
      summary: classification.summary,
    }, {
      expectedRevision: current.run.revision,
      now: transitionTime(current.run),
    });
    current = await replaceGoalRun(
      workspaceRoot,
      { ...current, run: cleared.run },
      { expectedRevision: current.run.revision, beforeCommit: (stored) => assertEvidenceScope(workspaceRoot, context, stored) },
      context.scope.mcpSessionId
    );
  }
  if (current.run.state !== "RUNNING" && current.run.state !== "READY_TO_FINALIZE") return current;
  const recorded = advanceGoalRun(current.run, {
    type: "record_evidence",
    evidence: {
      id: classification.id,
      kind: classification.kind,
      summary: classification.summary,
      source: classification.source,
      metadata: classification.metadata,
    },
  }, {
    expectedRevision: current.run.revision,
    now: transitionTime(current.run),
  });
  if (!recorded.transition.changed) return current;
  return replaceGoalRun(
    workspaceRoot,
    { ...current, run: recorded.run },
    { expectedRevision: current.run.revision, beforeCommit: (stored) => assertEvidenceScope(workspaceRoot, context, stored) },
    context.scope.mcpSessionId
  );
}

async function persistEvidence(
  workspaceRoot: string,
  envelope: GoalRunEnvelope,
  classification: GoalRunWebEvidenceClassification,
  context: InvocationContext
): Promise<GoalRunEnvelope> {
  let current = envelope;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await persistEvidenceOnce(workspaceRoot, current, classification, context);
    } catch (error) {
      if (!(error instanceof GoalRunStoreError) || error.code !== "CAS_CONFLICT" || attempt >= 2) {
        throw error;
      }
      const fresh = await readGoalRun(workspaceRoot, context.scope.mcpSessionId);
      if (!fresh || fresh.run.runId !== current.run.runId) throw error;
      current = fresh;
    }
  }
  return current;
}

function appendEvidenceProjection(
  result: CallToolResult,
  classification: GoalRunWebEvidenceClassification
): CallToolResult {
  const projection = {
    id: classification.id,
    kind: classification.kind,
    verifies_criterion: classification.verifiesCriterion,
    criterion_confirmed: false,
    requires_verification_contract: true,
    summary: classification.summary,
  };
  const structured = isRecord(result.structuredContent) ? result.structuredContent : null;
  const data = structured && isRecord(structured.data) ? structured.data : null;
  const withStructured = data
    ? { ...result, structuredContent: { ...structured, data: { ...data, goal_run_evidence: projection } } }
    : result;
  const reminder = classification.kind === "launch_ack"
    ? `GOAL EVIDENCE ${classification.id}: launch_ack only; this proves a process was started, not that it completed or passed.`
    : `GOAL EVIDENCE ${classification.id}: ${classification.kind}; verification_candidate=${classification.verifiesCriterion}. Not a confirmed criterion: goal(confirm) must match its declared check and current sources. ${classification.summary}`;
  return {
    ...withStructured,
    content: [...withStructured.content, { type: "text", text: reminder.slice(0, 800) }],
  };
}

/** Fail-soft production hook: shadow-write evidence before context rendering. */
export async function appendGoalRunEvidenceToResult(
  workspaceRoot: string,
  context: InvocationContext,
  result: CallToolResult
): Promise<CallToolResult> {
  return runWithRuntimeScope(context.scope, async () => {
  try {
    const classification = classifyGoalRunToolEvidence(context, result);
    if (!classification) return result;
    const envelope = await ensureShadowEnvelope(workspaceRoot, context);
    if (!envelope) return result;
    const persisted = await persistEvidence(workspaceRoot, envelope, classification, context);
    // Never advertise an evidence id that was not actually committed. This
    // can happen when a concurrent lifecycle transition has already moved the
    // run into a non-recording state.
    if (!persisted.run.typedEvidence.some((item) => item.id === classification.id)) return result;
    return appendEvidenceProjection(result, classification);
  } catch (error) {
    if (error instanceof Error && /^GOAL_(CREATION_PENDING|SCOPE_CHANGED):/.test(error.message)) return result;
    console.warn(`[goal-run] evidence mirror failed: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  });
}

/** Fail-soft thrown-handler observation; no user-visible result exists to annotate. */
export async function recordGoalRunToolFailure(
  workspaceRoot: string,
  context: InvocationContext,
  error: unknown
): Promise<void> {
  return runWithRuntimeScope(context.scope, async () => {
  try {
    const classification = classifyGoalRunToolEvidence(context, undefined, error);
    if (!classification) return;
    const envelope = await ensureShadowEnvelope(workspaceRoot, context);
    if (!envelope) return;
    await persistEvidence(workspaceRoot, envelope, classification, context);
  } catch (mirrorError) {
    if (mirrorError instanceof Error && /^GOAL_(CREATION_PENDING|SCOPE_CHANGED):/.test(mirrorError.message)) return;
    console.warn(`[goal-run] failure evidence mirror failed: ${mirrorError instanceof Error ? mirrorError.message : String(mirrorError)}`);
  }
  });
}
