import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { writeTextFileCas } from "./safe-text-write.js";
import { getRuntimeScope } from "./runtime-scope.js";
import { currentRelayGoal } from "./relay-scope.js";
import {
  assessRequirementReadiness,
  MAX_INTENT_JSON_CHARS,
  type RequirementAmbiguity,
  type RequirementClosureItem,
  type RequirementModel,
  type RequirementResolutionMode,
} from "./requirement-readiness.js";

const CONTRACT_VERSION = 1 as const;
const STATE_VERSION = 1 as const;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface ExecutionContract {
  readonly contract_version: typeof CONTRACT_VERSION;
  readonly intent_revision: number;
  readonly objective: string;
  readonly scope: readonly string[];
  readonly out_of_scope: readonly string[];
  readonly deliverables: readonly string[];
  readonly success_criteria: readonly string[];
  readonly constraints: readonly string[];
  readonly protected_resources: readonly string[];
  readonly authorized_assumptions: readonly string[];
  readonly delegated_decisions: readonly string[];
  readonly remaining_nonblocking_uncertainties: readonly string[];
  readonly clarification_round: number;
  readonly resolution_mode: RequirementResolutionMode;
  readonly readiness_score: number;
  readonly requirement_hash: string;
}

export interface AcceptedExecutionContractState {
  readonly schema_version: typeof STATE_VERSION;
  /** Accepted for this Goal; an unassigned legacy contract cannot steer a new Goal. */
  readonly goal_id?: string;
  readonly scope_binding?: string;
  readonly intent_revision: number;
  readonly requirement_hash: string;
  readonly readiness_score: number;
  /** Canonical _intent payload used to reproduce the exact admitted contract across relay lanes. */
  readonly canonical_requirement_json?: string;
  readonly accepted_at: string;
  readonly expires_at: string;
}

export interface ExecutionContractAdmission {
  readonly contract: ExecutionContract;
  readonly state: AcceptedExecutionContractState;
  readonly reused: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scopeBinding(workspaceRoot: string, sessionId?: string, goalId?: string): string | undefined {
  const scope = getRuntimeScope();
  if (!scope || !sessionId || scope.mcpSessionId !== sessionId ||
      path.resolve(scope.workspaceRoot).toLowerCase() !== path.resolve(workspaceRoot).toLowerCase()) return undefined;
  const account = process.env.HARNESS_ACCOUNT_ID?.trim() || scope.principalId || scope.tunnelProfile;
  // No trusted account identity means no reusable reference. The full form still works.
  if (!account) return undefined;
  return sha256(JSON.stringify(["intent-scope-v1", account, scope.principalId ?? null,
    scope.tunnelProfile ?? null, path.resolve(workspaceRoot).toLowerCase(), sessionId, goalId ?? null]));
}

function normalizeStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeClosure(items: readonly RequirementClosureItem[]): RequirementClosureItem[] {
  return [...items]
    .map((item) => ({
      id: item.id.trim(),
      ...(item.label ? { label: item.label.trim() } : {}),
      status: item.status,
      materiality: item.materiality,
      ...(item.basis ? { basis: item.basis.trim() } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeAmbiguities(items: readonly RequirementAmbiguity[]): RequirementAmbiguity[] {
  return [...items]
    .map((item) => ({
      id: item.id.trim(),
      question: item.question.trim(),
      materiality: item.materiality,
      reversible: item.reversible,
      ...(item.blocking === undefined ? {} : { blocking: item.blocking }),
      ...(item.delegated === undefined ? {} : { delegated: item.delegated }),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries.map(([key, child]) => [key, canonicalize(child)]));
}

export function canonicalRequirementJson(model: RequirementModel): string {
  const projection = {
    intent_revision: model.intent_revision,
    objective: model.objective.trim(),
    scope: normalizeStrings(model.scope),
    out_of_scope: normalizeStrings(model.out_of_scope),
    deliverables: normalizeStrings(model.deliverables),
    success_criteria: normalizeStrings(model.success_criteria),
    constraints: normalizeStrings(model.constraints),
    protected_resources: normalizeStrings(model.protected_resources),
    known_facts: normalizeStrings(model.known_facts),
    assumptions: normalizeStrings(model.assumptions),
    delegated_decisions: normalizeStrings(model.delegated_decisions),
    remaining_nonblocking_uncertainties: normalizeStrings(model.remaining_nonblocking_uncertainties),
    closure_items: normalizeClosure(model.closure_items),
    ambiguities: normalizeAmbiguities(model.ambiguities),
    clarification_round: model.clarification_round,
    questions_in_round: model.questions_in_round,
    resolution_mode: model.resolution_mode,
  };
  return JSON.stringify(canonicalize(projection));
}

export function compileExecutionContract(model: RequirementModel): ExecutionContract {
  const assessment = assessRequirementReadiness(model);
  if (!assessment.ready) {
    const details = assessment.reasons.length ? assessment.reasons.join("; ") : "requirements are not ready";
    throw new Error(`REQUIREMENT_NOT_READY: ${details}`);
  }
  const requirementHash = sha256(canonicalRequirementJson(model));
  return Object.freeze({
    contract_version: CONTRACT_VERSION,
    intent_revision: model.intent_revision,
    objective: model.objective.trim(),
    scope: Object.freeze(normalizeStrings(model.scope)),
    out_of_scope: Object.freeze(normalizeStrings(model.out_of_scope)),
    deliverables: Object.freeze(normalizeStrings(model.deliverables)),
    success_criteria: Object.freeze(normalizeStrings(model.success_criteria)),
    constraints: Object.freeze(normalizeStrings(model.constraints)),
    protected_resources: Object.freeze(normalizeStrings(model.protected_resources)),
    authorized_assumptions: Object.freeze(normalizeStrings(model.assumptions)),
    delegated_decisions: Object.freeze(normalizeStrings(model.delegated_decisions)),
    remaining_nonblocking_uncertainties: Object.freeze(normalizeStrings(model.remaining_nonblocking_uncertainties)),
    clarification_round: model.clarification_round,
    resolution_mode: model.resolution_mode,
    readiness_score: assessment.score,
    requirement_hash: requirementHash,
  });
}

function projectSlug(workspaceRoot: string): string {
  return sha256(path.resolve(workspaceRoot).toLowerCase()).slice(0, 12);
}

function sessionSlug(sessionId?: string): string {
  return sha256(sessionId?.trim() || "legacy").slice(0, 24);
}

export function executionContractStatePath(workspaceRoot: string, sessionId?: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", projectSlug(workspaceRoot), "requirement-contracts", `${sessionSlug(sessionId)}.json`);
}

function ttlMs(): number {
  const parsed = Number.parseInt(process.env.HARNESS_REQUIREMENT_CONTRACT_TTL_MS || String(DEFAULT_TTL_MS), 10);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_TTL_MS;
}

function validateContractGoal(goalId: unknown): string | undefined {
  if (goalId === undefined) return undefined;
  if (typeof goalId !== "string" || !goalId || goalId.trim() !== goalId || goalId.length > 512 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(goalId)) throw new Error("REQUIREMENT_GOAL_INVALID");
  return goalId;
}

function admissionGoal(workspaceRoot: string, sessionId?: string, goalId?: string): string | undefined {
  const scope = getRuntimeScope();
  const scopedGoal = scope && scope.mcpSessionId === sessionId &&
    path.resolve(scope.workspaceRoot).toLowerCase() === path.resolve(workspaceRoot).toLowerCase()
    ? scope.goalId : undefined;
  return validateContractGoal(goalId ?? currentRelayGoal(workspaceRoot) ?? scopedGoal);
}

function parseState(raw: string, file: string): AcceptedExecutionContractState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`REQUIREMENT_STATE_UNREADABLE: invalid JSON at ${file}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`REQUIREMENT_STATE_UNREADABLE: invalid state at ${file}`);
  }
  const record = value as Record<string, unknown>;
  validateContractGoal(record.goal_id);
  if (
    record.schema_version !== STATE_VERSION ||
    !(record.scope_binding === undefined || (typeof record.scope_binding === "string" && /^[a-f0-9]{64}$/.test(record.scope_binding))) ||
    !Number.isInteger(record.intent_revision) ||
    typeof record.requirement_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.requirement_hash) ||
    !Number.isInteger(record.readiness_score) ||
    !(
      record.canonical_requirement_json === undefined ||
      (typeof record.canonical_requirement_json === "string" &&
        record.canonical_requirement_json.length <= MAX_INTENT_JSON_CHARS)
    ) ||
    typeof record.accepted_at !== "string" ||
    typeof record.expires_at !== "string"
  ) {
    throw new Error(`REQUIREMENT_STATE_UNREADABLE: unsupported or malformed state at ${file}`);
  }
  if (
    typeof record.canonical_requirement_json === "string" &&
    sha256(record.canonical_requirement_json) !== record.requirement_hash
  ) {
    throw new Error(`REQUIREMENT_STATE_UNREADABLE: canonical requirement hash mismatch at ${file}`);
  }
  return record as unknown as AcceptedExecutionContractState;
}

async function readStateWithHash(file: string): Promise<{ state: AcceptedExecutionContractState; sha256: string } | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { state: parseState(raw, file), sha256: sha256(raw) };
}

export async function readAcceptedExecutionContractState(
  workspaceRoot: string,
  sessionId?: string,
  goalId?: string
): Promise<AcceptedExecutionContractState | null> {
  const goal = validateContractGoal(goalId);
  const file = executionContractStatePath(workspaceRoot, sessionId);
  const current = await readStateWithHash(file);
  if (!current || (goal !== undefined && current.state.goal_id !== goal)) return null;
  const expires = Date.parse(current.state.expires_at);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  return current.state;
}

export async function admitExecutionContract(
  workspaceRoot: string,
  sessionId: string | undefined,
  model: RequirementModel,
  goalId?: string
): Promise<ExecutionContractAdmission> {
  const goal = admissionGoal(workspaceRoot, sessionId, goalId);
  const contract = compileExecutionContract(model);
  const file = executionContractStatePath(workspaceRoot, sessionId);
  const current = await readStateWithHash(file);
  const binding = scopeBinding(workspaceRoot, sessionId, goal);
  const currentValid = current && current.state.goal_id === goal &&
    Date.parse(current.state.expires_at) > Date.now() ? current : null;

  if (currentValid) {
    if (contract.intent_revision < currentValid.state.intent_revision) {
      throw new Error(
        `STALE_INTENT_REVISION: incoming ${contract.intent_revision}, current ${currentValid.state.intent_revision}`
      );
    }
    if (
      contract.intent_revision === currentValid.state.intent_revision &&
      contract.requirement_hash !== currentValid.state.requirement_hash
    ) {
      throw new Error(
        `INTENT_REVISION_CONFLICT: revision ${contract.intent_revision} already has a different requirement hash`
      );
    }
    if (
      contract.intent_revision === currentValid.state.intent_revision &&
      contract.requirement_hash === currentValid.state.requirement_hash
    ) {
      // Full payload can bind an older state to this trusted account without
      // renewing the original expiry. A different binding cannot be inherited.
      if (binding && currentValid.state.scope_binding !== binding) {
        const bound = Object.freeze({ ...currentValid.state, scope_binding: binding });
        await writeTextFileCas(file, `${JSON.stringify(bound, null, 2)}\n`, { expectedSha256: currentValid.sha256 });
        return { contract, state: bound, reused: true };
      }
      return { contract, state: currentValid.state, reused: true };
    }
  }

  const now = Date.now();
  const canonicalRequirement = canonicalRequirementJson(model);
  const state: AcceptedExecutionContractState = Object.freeze({
    schema_version: STATE_VERSION,
    ...(goal === undefined ? {} : { goal_id: goal }),
    ...(binding ? { scope_binding: binding } : {}),
    intent_revision: contract.intent_revision,
    requirement_hash: contract.requirement_hash,
    readiness_score: contract.readiness_score,
    canonical_requirement_json: canonicalRequirement,
    accepted_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs()).toISOString(),
  });
  const content = `${JSON.stringify(state, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    await writeTextFileCas(file, content, current ? { expectedSha256: current.sha256 } : { createOnly: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("WRITE_CONFLICT") || message.includes("WRITE_LOCK_BUSY")) {
      throw new Error(`INTENT_CONTRACT_STATE_CONFLICT: ${message}`);
    }
    throw error;
  }
  return { contract, state, reused: false };
}

/** Resolve a compact reference without writing or extending its expiry. */
export async function resolveExecutionContractReference(
  workspaceRoot: string, sessionId: string | undefined, goalId: string | undefined,
  revision: number, hash: string
): Promise<AcceptedExecutionContractState> {
  const binding = scopeBinding(workspaceRoot, sessionId, goalId);
  if (!binding) throw new Error("INTENT_REFERENCE_SCOPE_REQUIRED: trusted account and session are required");
  const state = await readAcceptedExecutionContractState(workspaceRoot, sessionId, goalId);
  if (!state || state.goal_id !== goalId || state.scope_binding !== binding ||
      state.intent_revision !== revision || state.requirement_hash !== hash ||
      state.readiness_score < 95 || !state.canonical_requirement_json) {
    throw new Error("INTENT_REFERENCE_INVALID: accepted contract is missing, expired or does not match this scope");
  }
  return state;
}

/**
 * Carry the current Driver's admitted Requirement Contract into the standby
 * Chat before ownership changes. Driver Lease still decides authority; this
 * only lets the new Driver reproduce the exact `_intent` hash instead of
 * guessing it from prose and tripping DRIVER_CONTRACT_MISMATCH.
 */
export async function inheritAcceptedExecutionContractState(
  workspaceRoot: string,
  sourceSessionId: string,
  targetSessionId: string,
  expectedRequirementHash: string,
  expectedIntentRevision: number,
  expectedGoalId?: string
): Promise<AcceptedExecutionContractState> {
  const goal = validateContractGoal(expectedGoalId);
  const sourceSession = sourceSessionId.trim();
  const targetSession = targetSessionId.trim();
  if (!sourceSession || !targetSession || sourceSession === targetSession) {
    throw new Error("RELAY_EXECUTION_CONTRACT_TRANSFER_INVALID: distinct source/target sessions are required");
  }
  const sourceFile = executionContractStatePath(workspaceRoot, sourceSession);
  const targetFile = executionContractStatePath(workspaceRoot, targetSession);
  const source = await readStateWithHash(sourceFile);
  if (!source || Date.parse(source.state.expires_at) <= Date.now()) {
    throw new Error("RELAY_EXECUTION_CONTRACT_REQUIRED: active Driver contract is missing or expired");
  }
  if (
    (goal !== undefined && source.state.goal_id !== goal) ||
    source.state.requirement_hash !== expectedRequirementHash ||
    source.state.intent_revision !== expectedIntentRevision
  ) {
    throw new Error("RELAY_EXECUTION_CONTRACT_MISMATCH: active Driver contract does not match the prepared handoff");
  }
  if (!source.state.canonical_requirement_json) {
    throw new Error(
      "RELAY_EXECUTION_CONTRACT_PAYLOAD_REQUIRED: active contract predates relay intent transfer; admit one READY side-effect with the current _intent before handoff"
    );
  }

  const target = await readStateWithHash(targetFile);
  if (target && target.state.goal_id === source.state.goal_id && Date.parse(target.state.expires_at) > Date.now()) {
    if (target.state.intent_revision > source.state.intent_revision) {
      throw new Error(
        `RELAY_EXECUTION_CONTRACT_TARGET_AHEAD: standby revision ${target.state.intent_revision} is ahead of Driver revision ${source.state.intent_revision}`
      );
    }
    if (
      target.state.intent_revision === source.state.intent_revision &&
      target.state.requirement_hash === source.state.requirement_hash &&
      target.state.canonical_requirement_json === source.state.canonical_requirement_json
    ) {
      return target.state;
    }
  }

  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  try {
    await writeTextFileCas(
      targetFile,
      `${JSON.stringify(source.state, null, 2)}\n`,
      target ? { expectedSha256: target.sha256 } : { createOnly: true }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`RELAY_EXECUTION_CONTRACT_TRANSFER_CONFLICT: ${message}`);
  }
  return source.state;
}
