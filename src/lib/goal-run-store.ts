import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  GOAL_RUN_EVIDENCE_KINDS,
  GOAL_RUN_STATES,
  createGoalRun as createStateGoalRun,
  validateGoalRun,
  type CreateGoalRunInput,
  type GoalRun,
  type GoalRunEvidence,
  type GoalRunWaitCondition,
} from "./goal-run-state.js";
import { getRuntimeScope } from "./runtime-scope.js";
import { accountProjectDir } from "./account-project-scope.js";
import { assertGoalCreationIdle, type DurableGoal, type GoalStatus } from "./goal-state-store.js";
import { notifyStateInvalidated } from "./state-invalidate.js";
import { withCanonicalFileLock } from "./safe-text-write.js";

export const GOAL_RUN_STORE_SCHEMA_VERSION = 1 as const;
export const GOAL_RUN_STORE_AUTHORITY = "goal-run" as const;
export const GOAL_RUN_STORE_FILE_NAME = "goal-run.json" as const;
export const GOAL_RUN_REQUIRED_PARITY_MATCHES = 1 as const;
export const GOAL_RUN_LEGACY_COMPAT_MAX_BYTES = 256 * 1024;
export const GOAL_RUN_LEGACY_COMPAT_MAX_DEPTH = 32 as const;
export const GOAL_RUN_LEGACY_COMPAT_MAX_NODES = 8192 as const;

export type GoalRunStoreParity =
  | string
  | number
  | boolean
  | null
  | Readonly<Record<string, unknown>>
  | readonly unknown[]
  | GoalRunProjectionParity;

export interface GoalRunProjectionMismatch {
  readonly path: string;
  readonly projectedValue: GoalRunStoreParity | null;
  readonly legacyValue: GoalRunStoreParity | null;
  readonly projectedPresent: boolean;
  readonly legacyPresent: boolean;
  readonly projectedFingerprint: string;
  readonly legacyFingerprint: string;
}

export interface GoalRunProjectionParity {
  readonly kind: "projection";
  readonly matchedChecks: number;
  readonly requiredMatches: number;
  readonly mismatch: GoalRunProjectionMismatch | null;
  readonly repairPending: boolean;
  readonly repairReason: string | null;
  readonly lastCheckedRunRevision: number | null;
}

export type LegacyGoalInput = DurableGoal | Readonly<Record<string, unknown>>;

export interface GoalRunEnvelope {
  readonly schemaVersion: typeof GOAL_RUN_STORE_SCHEMA_VERSION;
  readonly authority: string;
  readonly run: GoalRun;
  readonly legacyProjectionRevision: number | null;
  readonly legacyProjectionFingerprint: string | null;
  readonly parity: GoalRunStoreParity;
  /** Bounded copy of the legacy goal used for shadow projection and promotion. */
  readonly legacy?: Readonly<Record<string, unknown>>;
  /** True while the run is still a compatibility shadow; false after promotion. */
  readonly shadow?: boolean;
  /** CAS revision for pure envelope metadata changes. */
  readonly envelopeRevision?: number;
}

export type GoalRunStoreRecord = GoalRunEnvelope;
export type GoalRunStoreInput = GoalRun | GoalRunEnvelope;

export interface GoalRunStoreMetadata {
  readonly authority?: string;
  readonly legacyProjectionRevision?: number | null;
  readonly legacyProjectionFingerprint?: string | null;
  readonly parity?: GoalRunStoreParity;
  readonly legacy?: Readonly<Record<string, unknown>>;
  readonly shadow?: boolean;
  readonly envelopeRevision?: number;
}

export interface GoalRunStoreCreateOptions extends GoalRunStoreMetadata {}

export interface GoalRunStoreReplaceOptions extends GoalRunStoreMetadata {
  readonly expectedRevision?: number;
  readonly expectedRunRevision?: number;
  readonly expected_revision?: number;
  /** Runs inside the store lock against the exact envelope to be replaced. */
  readonly beforeCommit?: (current: GoalRunEnvelope) => void | Promise<void>;
}

export interface GoalRunEnvelopeMetadataReplaceOptions {
  readonly expectedEnvelopeRevision: number;
  readonly expectedRunRevision: number;
}

export interface GoalRunNewIdentityReplaceOptions {
  readonly expectedRunId: string;
  readonly expectedRunRevision: number;
  readonly expectedEnvelopeRevision: number;
  readonly allowActiveSupersede?: boolean;
}

export type GoalRunStoreErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "CAS_CONFLICT"
  | "FUTURE_VERSION"
  | "UNSUPPORTED_VERSION"
  | "CORRUPT"
  | "IO_ERROR"
  | "PROMOTION_BLOCKED";

export class GoalRunStoreError extends Error {
  readonly code: GoalRunStoreErrorCode;
  readonly filePath?: string;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;

  constructor(
    code: GoalRunStoreErrorCode,
    message: string,
    details: {
      filePath?: string;
      expectedRevision?: number;
      actualRevision?: number;
    } = {}
  ) {
    super(`${code}: ${message}`);
    this.name = "GoalRunStoreError";
    this.code = code;
    this.filePath = details.filePath;
    this.expectedRevision = details.expectedRevision;
    this.actualRevision = details.actualRevision;
  }
}

const REQUIRED_ENVELOPE_KEYS = [
  "schemaVersion",
  "authority",
  "run",
  "legacyProjectionRevision",
  "legacyProjectionFingerprint",
  "parity",
] as const;
const OPTIONAL_ENVELOPE_KEYS = ["legacy", "shadow", "envelopeRevision"] as const;
const ENVELOPE_KEYS = [...REQUIRED_ENVELOPE_KEYS, ...OPTIONAL_ENVELOPE_KEYS] as const;

const RUN_STATES = new Set<string>(GOAL_RUN_STATES);
const EVIDENCE_KINDS = new Set<string>(GOAL_RUN_EVIDENCE_KINDS);
const workspaceChains = new Map<string, Promise<void>>();

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string, filePath?: string): never {
  throw new GoalRunStoreError("INVALID_INPUT", message, { filePath });
}

function requireRecord(value: unknown, field: string, filePath?: string): RecordValue {
  if (!isRecord(value)) invalid(`${field} must be an object`, filePath);
  return value;
}

function requireNonEmptyString(value: unknown, field: string, filePath?: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string`, filePath);
  }
  return value;
}

function requireNullableString(value: unknown, field: string, filePath?: string): void {
  if (value !== null && typeof value !== "string") invalid(`${field} must be a string or null`, filePath);
}

function requirePositiveRevision(value: unknown, field: string, filePath?: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    invalid(`${field} must be a positive safe integer`, filePath);
  }
  return value as number;
}

function requireNonNegativeRevision(value: unknown, field: string, filePath?: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${field} must be a non-negative safe integer or null`, filePath);
  }
}

function requireBoolean(value: unknown, field: string, filePath?: string): void {
  if (typeof value !== "boolean") invalid(`${field} must be a boolean`, filePath);
}

function requireArray(value: unknown, field: string, filePath?: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${field} must be an array`, filePath);
  return value;
}

function assertJsonValue(value: unknown, field: string, filePath?: string, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${field} must contain only finite numbers`, filePath);
    return;
  }
  if (typeof value !== "object") invalid(`${field} must be JSON-serializable`, filePath);
  if (seen.has(value as object)) invalid(`${field} must not contain a cycle`, filePath);
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`, filePath, seen));
  } else {
    for (const [key, item] of Object.entries(value as RecordValue)) {
      assertJsonValue(item, `${field}.${key}`, filePath, seen);
    }
  }
  seen.delete(value as object);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) invalid("value must be JSON-serializable");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  invalid("value must be JSON-serializable");
}

function cloneBoundedJson(
  value: unknown,
  field: string,
  depth: number,
  seen: Set<object>,
  nodeCount: { value: number }
): GoalRunStoreParity {
  nodeCount.value += 1;
  if (nodeCount.value > GOAL_RUN_LEGACY_COMPAT_MAX_NODES) {
    invalid(`${field} exceeds ${GOAL_RUN_LEGACY_COMPAT_MAX_NODES} JSON nodes`);
  }
  if (depth > GOAL_RUN_LEGACY_COMPAT_MAX_DEPTH) {
    invalid(`${field} exceeds JSON depth ${GOAL_RUN_LEGACY_COMPAT_MAX_DEPTH}`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${field} must contain only finite numbers`);
    return value;
  }
  if (typeof value !== "object") invalid(`${field} must be JSON-serializable`);
  if (seen.has(value as object)) invalid(`${field} must not contain a cycle`);
  seen.add(value as object);
  let cloned: GoalRunStoreParity;
  if (Array.isArray(value)) {
    cloned = value.map((item, index) => cloneBoundedJson(item, `${field}[${index}]`, depth + 1, seen, nodeCount));
  } else if (isRecord(value)) {
    const record: RecordValue = {};
    for (const [key, item] of Object.entries(value)) {
      record[key] = cloneBoundedJson(item, `${field}.${key}`, depth + 1, seen, nodeCount);
    }
    cloned = record;
  } else {
    invalid(`${field} must contain only plain JSON objects and arrays`);
  }
  seen.delete(value as object);
  return cloned;
}

function cloneLegacyPayload(value: unknown, field = "legacy"): RecordValue {
  if (!isRecord(value)) invalid(`${field} must be a plain object`);
  const cloned = cloneBoundedJson(value, field, 0, new Set<object>(), { value: 0 });
  const bytes = Buffer.byteLength(stableSerialize(cloned), "utf-8");
  if (bytes > GOAL_RUN_LEGACY_COMPAT_MAX_BYTES) {
    invalid(`${field} exceeds ${GOAL_RUN_LEGACY_COMPAT_MAX_BYTES} UTF-8 bytes`);
  }
  return cloned as RecordValue;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function assertMetadataValue(value: unknown, field: string, filePath?: string): void {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
    invalid(`${field} must be a string, number, boolean, or null`, filePath);
  }
  if (typeof value === "number" && !Number.isFinite(value)) invalid(`${field} must be finite`, filePath);
}

function assertRunEvidence(value: unknown, index: number, filePath?: string): asserts value is GoalRunEvidence {
  const evidence = requireRecord(value, `run.typedEvidence[${index}]`, filePath);
  requireNonEmptyString(evidence.id, `run.typedEvidence[${index}].id`, filePath);
  if (typeof evidence.kind !== "string" || !EVIDENCE_KINDS.has(evidence.kind)) {
    invalid(`run.typedEvidence[${index}].kind is not a known evidence kind`, filePath);
  }
  requireNonEmptyString(evidence.summary, `run.typedEvidence[${index}].summary`, filePath);
  requireNullableString(evidence.source, `run.typedEvidence[${index}].source`, filePath);
  const metadata = requireRecord(evidence.metadata, `run.typedEvidence[${index}].metadata`, filePath);
  for (const [key, metadataValue] of Object.entries(metadata)) {
    assertMetadataValue(metadataValue, `run.typedEvidence[${index}].metadata.${key}`, filePath);
  }
  requireNonEmptyString(evidence.recordedAt, `run.typedEvidence[${index}].recordedAt`, filePath);
}

function assertRunWait(value: unknown, filePath?: string): asserts value is GoalRunWaitCondition {
  const wait = requireRecord(value, "run.waitCondition", filePath);
  requireNonEmptyString(wait.id, "run.waitCondition.id", filePath);
  requireNonEmptyString(wait.description, "run.waitCondition.description", filePath);
  if (!["ACTIVE", "INTERRUPTED", "TIMED_OUT"].includes(String(wait.status))) {
    invalid("run.waitCondition.status is invalid", filePath);
  }
  if (!Number.isSafeInteger(wait.timeoutMs) || (wait.timeoutMs as number) < 1) {
    invalid("run.waitCondition.timeoutMs must be a positive safe integer", filePath);
  }
  requireNonEmptyString(wait.startedAt, "run.waitCondition.startedAt", filePath);
  requireNonEmptyString(wait.deadlineAt, "run.waitCondition.deadlineAt", filePath);
  const recovery = requireRecord(wait.recovery, "run.waitCondition.recovery", filePath);
  if (!Number.isSafeInteger(recovery.attempt) || (recovery.attempt as number) < 0) {
    invalid("run.waitCondition.recovery.attempt must be a non-negative safe integer", filePath);
  }
  requireNullableString(recovery.previousWaitId, "run.waitCondition.recovery.previousWaitId", filePath);
  requireNullableString(recovery.strategy, "run.waitCondition.recovery.strategy", filePath);
  requireNullableString(recovery.timedOutAt, "run.waitCondition.recovery.timedOutAt", filePath);
  if (wait.kind === "TOOL") {
    requireNonEmptyString(wait.toolName, "run.waitCondition.toolName", filePath);
  } else if (wait.kind === "EXTERNAL_PROCESS") {
    requireNonEmptyString(wait.processRef, "run.waitCondition.processRef", filePath);
    if (!Number.isSafeInteger(wait.pollIntervalMs) || (wait.pollIntervalMs as number) < 1) {
      invalid("run.waitCondition.pollIntervalMs must be a positive safe integer", filePath);
    }
  } else if (wait.kind === "USER") {
    requireNonEmptyString(wait.requestKey, "run.waitCondition.requestKey", filePath);
  } else {
    invalid("run.waitCondition.kind is invalid", filePath);
  }
}

function assertRun(value: unknown, filePath?: string): asserts value is GoalRun {
  const run = requireRecord(value, "run", filePath);
  requireNonEmptyString(run.runId, "run.runId", filePath);
  requirePositiveRevision(run.revision, "run.revision", filePath);
  if (typeof run.state !== "string" || !RUN_STATES.has(run.state)) invalid("run.state is invalid", filePath);
  requireNonEmptyString(run.objective, "run.objective", filePath);
  requireNonEmptyString(run.currentPhase, "run.currentPhase", filePath);
  requireNullableString(run.nextAction, "run.nextAction", filePath);
  requireNullableString(run.resumeCursor, "run.resumeCursor", filePath);

  const criteria = requireArray(run.criteria, "run.criteria", filePath);
  if (criteria.length < 1) invalid("run.criteria must not be empty", filePath);
  for (const [index, rawCriterion] of criteria.entries()) {
    const criterion = requireRecord(rawCriterion, `run.criteria[${index}]`, filePath);
    requireNonEmptyString(criterion.id, `run.criteria[${index}].id`, filePath);
    requireNonEmptyString(criterion.description, `run.criteria[${index}].description`, filePath);
    requireBoolean(criterion.confirmed, `run.criteria[${index}].confirmed`, filePath);
    const evidenceIds = requireArray(criterion.evidenceIds, `run.criteria[${index}].evidenceIds`, filePath);
    evidenceIds.forEach((id, evidenceIndex) =>
      requireNonEmptyString(id, `run.criteria[${index}].evidenceIds[${evidenceIndex}]`, filePath)
    );
    requireNullableString(criterion.confirmedAt, `run.criteria[${index}].confirmedAt`, filePath);
  }

  const evidence = requireArray(run.typedEvidence, "run.typedEvidence", filePath);
  evidence.forEach((item, index) => assertRunEvidence(item, index, filePath));
  if (run.waitCondition !== null) assertRunWait(run.waitCondition, filePath);
  if (run.lease !== null) {
    const lease = requireRecord(run.lease, "run.lease", filePath);
    requireNonEmptyString(lease.leaseId, "run.lease.leaseId", filePath);
    requireNonEmptyString(lease.holder, "run.lease.holder", filePath);
    requireNonEmptyString(lease.acquiredAt, "run.lease.acquiredAt", filePath);
    requireNonEmptyString(lease.expiresAt, "run.lease.expiresAt", filePath);
  }
  if (run.stopReason !== null) {
    const stopReason = requireRecord(run.stopReason, "run.stopReason", filePath);
    requireNonEmptyString(stopReason.kind, "run.stopReason.kind", filePath);
    requireNonEmptyString(stopReason.code, "run.stopReason.code", filePath);
    requireNonEmptyString(stopReason.message, "run.stopReason.message", filePath);
    requireBoolean(stopReason.terminal, "run.stopReason.terminal", filePath);
    requireNonEmptyString(stopReason.at, "run.stopReason.at", filePath);
    requireNonEmptyString(stopReason.previousState, "run.stopReason.previousState", filePath);
  }
  const timestamps = requireRecord(run.timestamps, "run.timestamps", filePath);
  requireNonEmptyString(timestamps.createdAt, "run.timestamps.createdAt", filePath);
  requireNonEmptyString(timestamps.updatedAt, "run.timestamps.updatedAt", filePath);
  requireNonEmptyString(timestamps.stateChangedAt, "run.timestamps.stateChangedAt", filePath);
  requireNullableString(timestamps.completedAt, "run.timestamps.completedAt", filePath);
  assertJsonValue(run, "run", filePath);
  try {
    validateGoalRun(run as unknown as GoalRun);
  } catch (error) {
    invalid(
      `run semantic validation failed: ${error instanceof Error ? error.message : String(error)}`,
      filePath
    );
  }
}

function assertEnvelopeKeys(value: RecordValue, filePath?: string): void {
  const actual = Object.keys(value).sort();
  const required = [...REQUIRED_ENVELOPE_KEYS].sort();
  const allowed = new Set<string>(ENVELOPE_KEYS);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    actual.some((key) => !allowed.has(key))
  ) {
    invalid(`envelope must contain required keys ${REQUIRED_ENVELOPE_KEYS.join(", ")}`, filePath);
  }
}

function assertSupportedVersion(value: RecordValue, filePath?: string): void {
  const schemaVersion = value.schemaVersion;
  if (typeof schemaVersion === "number" && Number.isInteger(schemaVersion) && schemaVersion > GOAL_RUN_STORE_SCHEMA_VERSION) {
    throw new GoalRunStoreError(
      "FUTURE_VERSION",
      `schemaVersion ${schemaVersion} is newer than supported version ${GOAL_RUN_STORE_SCHEMA_VERSION}`,
      { filePath }
    );
  }
  if (schemaVersion !== GOAL_RUN_STORE_SCHEMA_VERSION) {
    throw new GoalRunStoreError(
      "UNSUPPORTED_VERSION",
      `schemaVersion ${String(schemaVersion)} is not supported`,
      { filePath }
    );
  }
}

function assertEnvelope(value: unknown, filePath?: string): asserts value is GoalRunEnvelope {
  const envelope = requireRecord(value, "envelope", filePath);
  assertSupportedVersion(envelope, filePath);
  assertEnvelopeKeys(envelope, filePath);
  requireNonEmptyString(envelope.authority, "envelope.authority", filePath);
  assertRun(envelope.run, filePath);
  if (envelope.legacyProjectionRevision !== null) {
    requireNonNegativeRevision(envelope.legacyProjectionRevision, "envelope.legacyProjectionRevision", filePath);
  }
  if (
    envelope.legacyProjectionFingerprint !== null &&
    typeof envelope.legacyProjectionFingerprint !== "string"
  ) {
    invalid("envelope.legacyProjectionFingerprint must be a string or null", filePath);
  }
  assertJsonValue(envelope.parity, "envelope.parity", filePath);
  if (envelope.legacy !== undefined) cloneLegacyPayload(envelope.legacy, "envelope.legacy");
  if (envelope.shadow !== undefined && typeof envelope.shadow !== "boolean") {
    invalid("envelope.shadow must be a boolean", filePath);
  }
  if (envelope.envelopeRevision !== undefined) {
    requirePositiveRevision(envelope.envelopeRevision, "envelope.envelopeRevision", filePath);
  }
  if (envelope.shadow === true && envelope.legacy === undefined) {
    invalid("a shadow envelope must carry its legacy compatibility payload", filePath);
  }
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    invalid("workspaceRoot must be a non-empty string");
  }
  return path.resolve(workspaceRoot);
}

function workspaceKey(workspaceRoot: string): string {
  return path.normalize(workspaceRoot).toLowerCase();
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

// Session sharding (Plan A): each ChatGPT window owns an independent GoalRun
// store under sessions/<session>/, so concurrent windows never contend on a
// single goal-run.json. Session-less callers keep the workspace-global path.
function goalRunSessionSegment(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const clean = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
  return clean || undefined;
}

export function goalRunPath(workspaceRoot: string, sessionId?: string): string {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const projectDir = accountProjectDir(path.join(base, "projects", projectSlug(normalizedRoot)));
  const seg = goalRunSessionSegment(sessionId ?? getRuntimeScope()?.mcpSessionId);
  return seg
    ? path.join(projectDir, "sessions", seg, GOAL_RUN_STORE_FILE_NAME)
    : path.join(projectDir, GOAL_RUN_STORE_FILE_NAME);
}

export function goalRunProjectionFingerprint(value: LegacyGoalInput): string {
  return fingerprint(cloneLegacyPayload(value, "legacy fingerprint"));
}

export const goalRunStorePath = goalRunPath;
export const goalRunFilePath = goalRunPath;

async function withWorkspaceLock<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = workspaceKey(workspaceRoot);
  const previous = workspaceChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  workspaceChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const target = path.join(accountProjectDir(path.join(base, "projects", projectSlug(workspaceRoot))), ".goal-run-workspace");
    return await withCanonicalFileLock(target, operation);
  } finally {
    release();
    if (workspaceChains.get(key) === chain) workspaceChains.delete(key);
  }
}

async function readEnvelopeUnlocked(filePath: string): Promise<GoalRunEnvelope | null> {
  let rawText: string;
  try {
    rawText = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GoalRunStoreError(
      "IO_ERROR",
      `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { filePath }
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch (error) {
    throw new GoalRunStoreError(
      "CORRUPT",
      `invalid JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { filePath }
    );
  }
  assertEnvelope(raw, filePath);
  return raw;
}

async function atomicWriteEnvelope(filePath: string, envelope: GoalRunEnvelope): Promise<void> {
  const serialized = JSON.stringify(envelope, null, 2) + "\n";
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    handle = await fs.open(temporaryPath, "wx");
    await handle.writeFile(serialized, "utf-8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    throw new GoalRunStoreError(
      "IO_ERROR",
      `cannot atomically write ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { filePath }
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function cloneEnvelope(envelope: GoalRunEnvelope): GoalRunEnvelope {
  return JSON.parse(JSON.stringify(envelope)) as GoalRunEnvelope;
}

interface SourceParts {
  readonly run: GoalRun;
  readonly metadata: GoalRunStoreMetadata;
}

function sourceParts(source: unknown, filePath?: string): SourceParts {
  if (!isRecord(source)) invalid("goal run source must be an object", filePath);
  if (Object.prototype.hasOwnProperty.call(source, "run")) {
    if (source.schemaVersion !== undefined) assertSupportedVersion(source, filePath);
    const metadata: GoalRunStoreMetadata = {
      ...(source.authority === undefined ? {} : { authority: source.authority as string }),
      ...(source.legacyProjectionRevision === undefined
        ? {}
        : { legacyProjectionRevision: source.legacyProjectionRevision as number | null }),
      ...(source.legacyProjectionFingerprint === undefined
        ? {}
        : { legacyProjectionFingerprint: source.legacyProjectionFingerprint as string | null }),
      ...(Object.prototype.hasOwnProperty.call(source, "parity") ? { parity: source.parity as GoalRunStoreParity } : {}),
      ...(source.legacy === undefined ? {} : { legacy: cloneLegacyPayload(source.legacy, "source.legacy") }),
      ...(source.shadow === undefined ? {} : { shadow: source.shadow as boolean }),
      ...(source.envelopeRevision === undefined ? {} : { envelopeRevision: source.envelopeRevision as number }),
    };
    assertRun(source.run, filePath);
    return { run: source.run, metadata };
  }
  assertRun(source, filePath);
  return { run: source, metadata: {} };
}

function maybeCreateStateRun(source: unknown, filePath?: string): GoalRunStoreInput {
  if (
    isRecord(source) &&
    Object.prototype.hasOwnProperty.call(source, "runId") &&
    !Object.prototype.hasOwnProperty.call(source, "revision")
  ) {
    return createStateGoalRun(source as unknown as CreateGoalRunInput);
  }
  return source as GoalRunStoreInput;
}

function buildEnvelope(
  source: unknown,
  options: GoalRunStoreMetadata = {},
  fallback: GoalRunStoreMetadata = {},
  filePath?: string
): GoalRunEnvelope {
  const parts = sourceParts(maybeCreateStateRun(source, filePath), filePath);
  const authority = options.authority ?? parts.metadata.authority ?? fallback.authority;
  const legacyProjectionRevision =
    options.legacyProjectionRevision !== undefined
      ? options.legacyProjectionRevision
      : parts.metadata.legacyProjectionRevision !== undefined
        ? parts.metadata.legacyProjectionRevision
        : fallback.legacyProjectionRevision;
  const legacyProjectionFingerprint =
    options.legacyProjectionFingerprint !== undefined
      ? options.legacyProjectionFingerprint
      : parts.metadata.legacyProjectionFingerprint !== undefined
        ? parts.metadata.legacyProjectionFingerprint
        : fallback.legacyProjectionFingerprint;
  const parity =
    options.parity !== undefined
      ? options.parity
      : parts.metadata.parity !== undefined
        ? parts.metadata.parity
        : fallback.parity;
  const legacy =
    options.legacy !== undefined
      ? options.legacy
      : parts.metadata.legacy !== undefined
        ? parts.metadata.legacy
        : fallback.legacy;
  const shadow =
    options.shadow !== undefined
      ? options.shadow
      : parts.metadata.shadow !== undefined
        ? parts.metadata.shadow
        : fallback.shadow;
  const envelopeRevision =
    options.envelopeRevision !== undefined
      ? options.envelopeRevision
      : parts.metadata.envelopeRevision !== undefined
        ? parts.metadata.envelopeRevision
        : fallback.envelopeRevision;
  const envelope: GoalRunEnvelope = {
    schemaVersion: GOAL_RUN_STORE_SCHEMA_VERSION,
    authority: authority ?? GOAL_RUN_STORE_AUTHORITY,
    run: parts.run,
    legacyProjectionRevision: legacyProjectionRevision === undefined ? null : legacyProjectionRevision,
    legacyProjectionFingerprint: legacyProjectionFingerprint === undefined ? null : legacyProjectionFingerprint,
    parity: parity === undefined ? "unverified" : parity,
    ...(legacy === undefined ? {} : { legacy: cloneLegacyPayload(legacy, "envelope.legacy") }),
    ...(shadow === undefined ? {} : { shadow }),
    ...(envelopeRevision === undefined ? {} : { envelopeRevision }),
  };
  assertEnvelope(envelope, filePath);
  return cloneEnvelope(envelope);
}

function explicitExpectedRevision(options: GoalRunStoreReplaceOptions): number | undefined {
  return options.expectedRevision ?? options.expectedRunRevision ?? options.expected_revision;
}

function assertExpectedRevision(value: unknown, field: string, filePath?: string): number {
  return requirePositiveRevision(value, field, filePath);
}

function parseReplaceArguments(
  sourceOrExpected: GoalRunStoreInput | number,
  optionsOrSource: GoalRunStoreReplaceOptions | GoalRunStoreInput | number | undefined
): {
  readonly source: GoalRunStoreInput;
  readonly options: GoalRunStoreReplaceOptions;
} {
  if (typeof sourceOrExpected === "number") {
    if (optionsOrSource === undefined || typeof optionsOrSource === "number") {
      invalid("replace requires a goal run after expectedRevision");
    }
    return {
      source: optionsOrSource as GoalRunStoreInput,
      options: { expectedRevision: sourceOrExpected },
    };
  }
  if (typeof optionsOrSource === "number") {
    return { source: sourceOrExpected, options: { expectedRevision: optionsOrSource } };
  }
  if (optionsOrSource === undefined) return { source: sourceOrExpected, options: {} };
  if (isRecord(optionsOrSource) && Object.prototype.hasOwnProperty.call(optionsOrSource, "run")) {
    return { source: sourceOrExpected, options: optionsOrSource as GoalRunStoreReplaceOptions };
  }
  return { source: sourceOrExpected, options: optionsOrSource as GoalRunStoreReplaceOptions };
}

export async function readGoalRun(workspaceRoot: string, sessionId?: string): Promise<GoalRunEnvelope | null> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(normalizedRoot, sessionId);
  return withWorkspaceLock(normalizedRoot, async () => {
    const envelope = await readEnvelopeUnlocked(filePath);
    return envelope ? cloneEnvelope(envelope) : null;
  });
}

/** Journal publication holds the same lock as evidence commits. */
export async function withGoalRunCreationSnapshot<T>(
  workspaceRoot: string,
  operation: (current: GoalRunEnvelope | null) => Promise<T>,
  sessionId?: string
): Promise<T> {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(root, sessionId);
  return withWorkspaceLock(root, async () => {
    const current = await readEnvelopeUnlocked(filePath);
    return operation(current ? cloneEnvelope(current) : null);
  });
}

export function goalRunIsTerminal(envelope: GoalRunEnvelope): boolean {
  return envelope.run.state === "COMPLETED" ||
    (envelope.run.state === "INTERRUPTED" && envelope.run.stopReason?.terminal === true);
}

function archivedRunDirectory(filePath: string, runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(runId)) {
    throw new GoalRunStoreError("INVALID_INPUT", "Invalid archived GoalRun identity");
  }
  return path.join(path.dirname(filePath), "goal-run-history", runId);
}

async function archiveRunUnlocked(filePath: string, envelope: GoalRunEnvelope): Promise<string> {
  const directory = archivedRunDirectory(filePath, envelope.run.runId);
  const revisionPath = path.join(directory, `revision-${envelope.run.revision}-envelope-${currentEnvelopeRevision(envelope)}.json`);
  const existing = await readEnvelopeUnlocked(revisionPath);
  if (existing && stableSerialize(existing) !== stableSerialize(envelope)) {
    throw new GoalRunStoreError("CAS_CONFLICT", "GoalRun archive revision already contains different evidence", { filePath: revisionPath });
  }
  if (!existing) await atomicWriteEnvelope(revisionPath, envelope);
  const latestPath = path.join(directory, "latest.json");
  const latest = await readEnvelopeUnlocked(latestPath);
  if (!latest || latest.run.revision < envelope.run.revision ||
      (latest.run.revision === envelope.run.revision && currentEnvelopeRevision(latest) <= currentEnvelopeRevision(envelope))) {
    await atomicWriteEnvelope(latestPath, envelope);
  }
  return revisionPath;
}

/** Archive exact evidence before a new identity replaces the session slot. */
export async function archiveGoalRun(
  workspaceRoot: string,
  expected: { runId: string; runRevision: number; envelopeRevision: number },
  sessionId?: string
): Promise<string> {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(root, sessionId);
  return withWorkspaceLock(root, async () => {
    const current = await readEnvelopeUnlocked(filePath);
    if (!current || current.run.runId !== expected.runId || current.run.revision !== expected.runRevision ||
        currentEnvelopeRevision(current) !== expected.envelopeRevision) {
      throw new GoalRunStoreError("CAS_CONFLICT", "GoalRun changed before replacement archive", { filePath });
    }
    return archiveRunUnlocked(filePath, current);
  });
}

export async function readArchivedGoalRun(workspaceRoot: string, runId: string, sessionId?: string): Promise<GoalRunEnvelope | null> {
  const filePath = path.join(archivedRunDirectory(goalRunPath(workspaceRoot, sessionId), runId), "latest.json");
  const archived = await readEnvelopeUnlocked(filePath);
  return archived ? cloneEnvelope(archived) : null;
}

/**
 * Copy the authoritative GoalRun owned by the current Driver into the standby
 * session before a Goal bind.  Session shards are deliberately retained after
 * handoff so an old Chat can be fenced without destroying audit history; when
 * that Chat later becomes the standby lane again its shard is therefore stale.
 * Relay must refresh that shard from the *current* Driver rather than trying to
 * reconstruct GoalRun truth from goal.json (which would lose typed evidence).
 *
 * This is a transfer of existing truth, not a GoalRun transition: run revision,
 * evidence and parity metadata are preserved byte-for-byte (modulo JSON pretty
 * printing). A target that is inexplicably ahead of the active Driver fails
 * closed instead of overwriting potentially newer truth.
 */
export async function rebindGoalRunSession(
  workspaceRoot: string,
  sourceSessionId: string,
  targetSessionId: string
): Promise<GoalRunEnvelope> {
  const sourceSession = sourceSessionId.trim();
  const targetSession = targetSessionId.trim();
  if (!sourceSession || !targetSession) {
    throw new GoalRunStoreError("INVALID_INPUT", "GoalRun session rebind requires source and target session ids");
  }
  if (sourceSession === targetSession) {
    throw new GoalRunStoreError("INVALID_INPUT", "GoalRun session rebind target must differ from source");
  }
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const sourcePath = goalRunPath(normalizedRoot, sourceSession);
  const targetPath = goalRunPath(normalizedRoot, targetSession);
  return withWorkspaceLock(normalizedRoot, async () => {
    const source = await readEnvelopeUnlocked(sourcePath);
    if (!source) {
      throw new GoalRunStoreError("NOT_FOUND", `source GoalRun is missing at ${sourcePath}`, { filePath: sourcePath });
    }
    const target = await readEnvelopeUnlocked(targetPath);
    if (target) {
      if (target.run.runId !== source.run.runId && !goalRunIsTerminal(target)) {
        throw new GoalRunStoreError(
          "CAS_CONFLICT",
          `target session contains another GoalRun (${target.run.runId}); refusing relay overwrite`,
          { filePath: targetPath }
        );
      }
      if (target.run.runId === source.run.runId && target.run.revision > source.run.revision) {
        throw new GoalRunStoreError(
          "CAS_CONFLICT",
          `target GoalRun revision ${target.run.revision} is ahead of active Driver revision ${source.run.revision}`,
          { filePath: targetPath, expectedRevision: source.run.revision, actualRevision: target.run.revision }
        );
      }
      if (target.run.runId === source.run.runId && target.run.revision === source.run.revision && stableSerialize(target.run) !== stableSerialize(source.run)) {
        throw new GoalRunStoreError(
          "CAS_CONFLICT",
          `target GoalRun revision ${target.run.revision} diverges from the active Driver at the same revision`,
          { filePath: targetPath, expectedRevision: source.run.revision, actualRevision: target.run.revision }
        );
      }
    }
    if (target && target.run.runId !== source.run.runId) await archiveRunUnlocked(targetPath, target);
    await atomicWriteEnvelope(targetPath, source);
    notifyStateInvalidated(normalizedRoot);
    return cloneEnvelope(source);
  });
}

export async function openGoalRun(workspaceRoot: string): Promise<GoalRunEnvelope | null> {
  return readGoalRun(workspaceRoot);
}

export async function createGoalRun(
  workspaceRoot: string,
  source: GoalRunStoreInput | CreateGoalRunInput,
  options: GoalRunStoreCreateOptions = {},
  sessionId?: string
): Promise<GoalRunEnvelope> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(normalizedRoot, sessionId);
  return withWorkspaceLock(normalizedRoot, async () => {
    await assertGoalCreationIdle(normalizedRoot, sessionId ?? getRuntimeScope()?.mcpSessionId);
    const existing = await readEnvelopeUnlocked(filePath);
    if (existing) {
      throw new GoalRunStoreError("ALREADY_EXISTS", `a goal run already exists at ${filePath}`, { filePath });
    }
    const envelope = buildEnvelope(source, options, {}, filePath);
    const importedShadowRevision =
      envelope.shadow === true &&
      envelope.legacy !== undefined &&
      envelope.legacyProjectionRevision === envelope.run.revision;
    if (envelope.run.revision !== 1 && !importedShadowRevision) {
      invalid("a newly created goal run must have revision 1 unless it imports a revision-matched legacy shadow", filePath);
    }
    await atomicWriteEnvelope(filePath, envelope);
    notifyStateInvalidated(normalizedRoot);
    return cloneEnvelope(envelope);
  });
}

export async function replaceGoalRun(
  workspaceRoot: string,
  sourceOrExpected: GoalRunStoreInput | number,
  optionsOrSource?: GoalRunStoreReplaceOptions | GoalRunStoreInput | number,
  sessionId?: string
): Promise<GoalRunEnvelope> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(normalizedRoot, sessionId);
  const parsed = parseReplaceArguments(sourceOrExpected, optionsOrSource);
  return withWorkspaceLock(normalizedRoot, async () => {
    await assertGoalCreationIdle(normalizedRoot, sessionId ?? getRuntimeScope()?.mcpSessionId);
    const current = await readEnvelopeUnlocked(filePath);
    if (!current) {
      throw new GoalRunStoreError("NOT_FOUND", `no goal run exists at ${filePath}`, { filePath });
    }
    await parsed.options.beforeCommit?.(cloneEnvelope(current));
    const envelope = buildEnvelope(parsed.source, parsed.options, current, filePath);
    if (envelope.run.runId !== current.run.runId) {
      throw new GoalRunStoreError("CAS_CONFLICT", "GoalRun identity changed; use the explicit identity replacement transaction", { filePath });
    }
    const expected = explicitExpectedRevision(parsed.options) ?? envelope.run.revision - 1;
    assertExpectedRevision(expected, "expectedRevision", filePath);
    if (current.run.revision !== expected) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `goal run revision is ${current.run.revision}, but ${expected} was expected`,
        { filePath, expectedRevision: expected, actualRevision: current.run.revision }
      );
    }
    if (envelope.run.revision !== expected + 1) {
      invalid(
        `replacement run revision must be exactly ${expected + 1}, received ${envelope.run.revision}`,
        filePath
      );
    }
    await atomicWriteEnvelope(filePath, envelope);
    notifyStateInvalidated(normalizedRoot);
    return cloneEnvelope(envelope);
  });
}

/**
 * Persist parity/projection/promotion metadata without pretending that the
 * GoalRun state itself advanced. Both envelope and run revisions are guarded.
 */
export async function replaceGoalRunEnvelopeMetadata(
  workspaceRoot: string,
  source: GoalRunEnvelope,
  options: GoalRunEnvelopeMetadataReplaceOptions
): Promise<GoalRunEnvelope> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(normalizedRoot);
  return withWorkspaceLock(normalizedRoot, async () => {
    await assertGoalCreationIdle(normalizedRoot, getRuntimeScope()?.mcpSessionId);
    const current = await readEnvelopeUnlocked(filePath);
    if (!current) {
      throw new GoalRunStoreError("NOT_FOUND", `no goal run exists at ${filePath}`, { filePath });
    }
    const expectedEnvelopeRevision = assertExpectedRevision(
      options.expectedEnvelopeRevision,
      "expectedEnvelopeRevision",
      filePath
    );
    const expectedRunRevision = assertExpectedRevision(
      options.expectedRunRevision,
      "expectedRunRevision",
      filePath
    );
    const actualEnvelopeRevision = currentEnvelopeRevision(current);
    if (actualEnvelopeRevision !== expectedEnvelopeRevision) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `goal run envelope revision is ${actualEnvelopeRevision}, but ${expectedEnvelopeRevision} was expected`,
        { filePath, expectedRevision: expectedEnvelopeRevision, actualRevision: actualEnvelopeRevision }
      );
    }
    if (current.run.revision !== expectedRunRevision) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `goal run revision is ${current.run.revision}, but ${expectedRunRevision} was expected`,
        { filePath, expectedRevision: expectedRunRevision, actualRevision: current.run.revision }
      );
    }
    const envelope = buildEnvelope(source, {}, current, filePath);
    if (stableSerialize(envelope.run) !== stableSerialize(current.run)) {
      invalid("metadata replacement cannot mutate the GoalRun state", filePath);
    }
    if (currentEnvelopeRevision(envelope) !== expectedEnvelopeRevision + 1) {
      invalid(
        `metadata replacement envelope revision must be exactly ${expectedEnvelopeRevision + 1}`,
        filePath
      );
    }
    await atomicWriteEnvelope(filePath, envelope);
    notifyStateInvalidated(normalizedRoot);
    return cloneEnvelope(envelope);
  });
}

/** Start a different run in the single-slot store under explicit CAS. */
export async function replaceGoalRunIdentity(
  workspaceRoot: string,
  source: GoalRunEnvelope,
  options: GoalRunNewIdentityReplaceOptions
): Promise<GoalRunEnvelope> {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  const filePath = goalRunPath(normalizedRoot);
  return withWorkspaceLock(normalizedRoot, async () => {
    const current = await readEnvelopeUnlocked(filePath);
    if (!current) {
      throw new GoalRunStoreError("NOT_FOUND", `no goal run exists at ${filePath}`, { filePath });
    }
    const expectedRunRevision = assertExpectedRevision(
      options.expectedRunRevision,
      "expectedRunRevision",
      filePath
    );
    const expectedEnvelopeRevision = assertExpectedRevision(
      options.expectedEnvelopeRevision,
      "expectedEnvelopeRevision",
      filePath
    );
    if (current.run.runId !== options.expectedRunId) {
      throw new GoalRunStoreError("CAS_CONFLICT", `current run id is ${current.run.runId}, not ${options.expectedRunId}`, {
        filePath,
      });
    }
    if (current.run.revision !== expectedRunRevision) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `goal run revision is ${current.run.revision}, but ${expectedRunRevision} was expected`,
        { filePath, expectedRevision: expectedRunRevision, actualRevision: current.run.revision }
      );
    }
    const actualEnvelopeRevision = currentEnvelopeRevision(current);
    if (actualEnvelopeRevision !== expectedEnvelopeRevision) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `goal run envelope revision is ${actualEnvelopeRevision}, but ${expectedEnvelopeRevision} was expected`,
        { filePath, expectedRevision: expectedEnvelopeRevision, actualRevision: actualEnvelopeRevision }
      );
    }
    const terminal =
      current.run.state === "COMPLETED" ||
      (current.run.state === "INTERRUPTED" && current.run.stopReason?.terminal === true);
    if (!terminal && options.allowActiveSupersede !== true) {
      throw new GoalRunStoreError(
        "INVALID_INPUT",
        `cannot replace active run ${current.run.runId} with ${source.run.runId} without an explicit supersede`,
        { filePath }
      );
    }
    if (source.run.runId === current.run.runId) {
      invalid("new identity replacement requires a different run id", filePath);
    }
    const envelope = buildEnvelope(
      source,
      { envelopeRevision: expectedEnvelopeRevision + 1 },
      current,
      filePath
    );
    await archiveRunUnlocked(filePath, current);
    await atomicWriteEnvelope(filePath, envelope);
    notifyStateInvalidated(normalizedRoot);
    return cloneEnvelope(envelope);
  });
}

export async function createGoalRunEnvelope(
  workspaceRoot: string,
  source: GoalRunStoreInput | CreateGoalRunInput,
  options: GoalRunStoreCreateOptions = {}
): Promise<GoalRunEnvelope> {
  return createGoalRun(workspaceRoot, source, options);
}

export async function replaceGoalRunEnvelope(
  workspaceRoot: string,
  sourceOrExpected: GoalRunStoreInput | number,
  optionsOrSource?: GoalRunStoreReplaceOptions | GoalRunStoreInput | number
): Promise<GoalRunEnvelope> {
  return replaceGoalRun(workspaceRoot, sourceOrExpected, optionsOrSource);
}

export interface GoalRunPromotionExpectation {
  readonly envelopeRevision?: number;
  readonly expectedEnvelopeRevision?: number;
  readonly envelope?: number;
  readonly runRevision?: number;
  readonly expectedRunRevision?: number;
  readonly run?: number;
  readonly expectedRevision?: number;
  readonly expected_revision?: number;
}

type ProjectionDifference = {
  readonly path: string;
  readonly projectedPresent: boolean;
  readonly legacyPresent: boolean;
  readonly projectedValue: unknown;
  readonly legacyValue: unknown;
};

const DEFAULT_LEGACY_TIME = "1970-01-01T00:00:00.000Z";

function legacyStatus(value: unknown): GoalStatus {
  if (value === "active" || value === "paused" || value === "completed" || value === "cancelled") {
    return value;
  }
  invalid("legacy.status must be active, paused, completed, or cancelled");
}

function legacyText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) return fallback.slice(0, max);
  return value.trim().slice(0, max);
}

function legacyNullableText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, max);
}

function legacyTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

function legacyRevision(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : 1;
}

function legacyCriterionName(value: unknown, index: number): string {
  if (isRecord(value)) return legacyText(value.name, `Criterion ${index + 1}`, 300);
  return `Criterion ${index + 1}`;
}

function legacyCriterionPassed(value: unknown): boolean {
  return isRecord(value) && value.passed === true;
}

function legacyCriterionDetail(value: unknown): string | null {
  return isRecord(value) ? legacyNullableText(value.detail, 4000) : null;
}

export function goalRunCriterionId(name: string, index: number): string {
  return `legacy-criterion-${fingerprint({ index, name: name.toLowerCase().replace(/\s+/g, " ").trim() }).slice(0, 24)}`;
}

function legacyRunId(payload: RecordValue): string {
  if (typeof payload.id === "string" && payload.id.trim() && payload.id.trim().length <= 128) {
    return payload.id.trim();
  }
  return `legacy-${fingerprint(payload).slice(0, 24)}`;
}

function legacyStatusForRun(run: GoalRun): GoalStatus {
  if (run.state === "COMPLETED") return "completed";
  if (run.state === "INTERRUPTED" && run.stopReason?.kind === "CANCEL") return "cancelled";
  if (run.state === "INTERRUPTED" || run.state === "NO_PROGRESS_PAUSED") return "paused";
  return "active";
}

function priorLegacyCriteria(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => cloneLegacyPayload(item, "legacy.success_criteria"));
}

function criterionMatch(prior: readonly RecordValue[], index: number, description: string): RecordValue | null {
  const sameName = prior.find(
    (candidate) => typeof candidate.name === "string" && candidate.name.trim().toLowerCase() === description.toLowerCase()
  );
  return sameName ?? prior[index] ?? null;
}

function evidenceSummaryForCriterion(run: GoalRun, criterion: GoalRunCriterionLike): string | null {
  for (const evidenceId of criterion.evidenceIds) {
    const evidence = run.typedEvidence.find((candidate) => candidate.id === evidenceId);
    if (evidence) return evidence.summary;
  }
  return null;
}

type GoalRunCriterionLike = GoalRun["criteria"][number];

function newProjectionParity(): GoalRunProjectionParity {
  return {
    kind: "projection",
    matchedChecks: 0,
    requiredMatches: GOAL_RUN_REQUIRED_PARITY_MATCHES,
    mismatch: null,
    repairPending: false,
    repairReason: null,
    lastCheckedRunRevision: null,
  };
}

function normalizedMismatch(value: unknown): GoalRunProjectionMismatch | null {
  if (!isRecord(value)) return null;
  const path = typeof value.path === "string" && value.path ? value.path : "$";
  const projectedPresent = value.projectedPresent === true;
  const legacyPresent = value.legacyPresent === true;
  return {
    path,
    projectedValue: projectedPresent && value.projectedValue !== undefined ? value.projectedValue as GoalRunStoreParity : null,
    legacyValue: legacyPresent && value.legacyValue !== undefined ? value.legacyValue as GoalRunStoreParity : null,
    projectedPresent,
    legacyPresent,
    projectedFingerprint: typeof value.projectedFingerprint === "string" ? value.projectedFingerprint : "",
    legacyFingerprint: typeof value.legacyFingerprint === "string" ? value.legacyFingerprint : "",
  };
}

function normalizedParity(value: GoalRunStoreParity): GoalRunProjectionParity {
  if (!isRecord(value) || value.kind !== "projection") return newProjectionParity();
  const matchedChecks = Number.isSafeInteger(value.matchedChecks) && (value.matchedChecks as number) >= 0
    ? value.matchedChecks as number
    : 0;
  const requiredMatches = Number.isSafeInteger(value.requiredMatches) && (value.requiredMatches as number) >= 1
    ? value.requiredMatches as number
    : GOAL_RUN_REQUIRED_PARITY_MATCHES;
  const lastCheckedRunRevision = Number.isSafeInteger(value.lastCheckedRunRevision) && (value.lastCheckedRunRevision as number) >= 1
    ? value.lastCheckedRunRevision as number
    : null;
  return {
    kind: "projection",
    matchedChecks,
    requiredMatches,
    mismatch: value.mismatch === null || value.mismatch === undefined ? null : normalizedMismatch(value.mismatch),
    repairPending: value.repairPending === true,
    repairReason: value.repairReason === null || value.repairReason === undefined
      ? null
      : legacyNullableText(value.repairReason, 1000),
    lastCheckedRunRevision,
  };
}

function currentEnvelopeRevision(envelope: GoalRunEnvelope): number {
  return envelope.envelopeRevision === undefined ? 1 : requirePositiveRevision(envelope.envelopeRevision, "envelope.envelopeRevision");
}

function updateProjectionMetadata(
  envelope: GoalRunEnvelope,
  parity: GoalRunProjectionParity
): GoalRunEnvelope {
  const next: GoalRunEnvelope = {
    ...cloneEnvelope(envelope),
    parity,
    envelopeRevision: currentEnvelopeRevision(envelope) + 1,
  };
  assertEnvelope(next);
  return cloneEnvelope(next);
}

function firstProjectionDifference(
  projected: unknown,
  legacy: unknown,
  path = "$"
): ProjectionDifference | null {
  if (stableSerialize(projected) === stableSerialize(legacy)) return null;
  const projectedObject = isRecord(projected);
  const legacyObject = isRecord(legacy);
  if (projectedObject && legacyObject) {
    const keys = [...new Set([...Object.keys(projected), ...Object.keys(legacy)])].sort();
    for (const key of keys) {
      const projectedPresent = Object.prototype.hasOwnProperty.call(projected, key);
      const legacyPresent = Object.prototype.hasOwnProperty.call(legacy, key);
      if (!projectedPresent || !legacyPresent) {
        return {
          path: `${path}.${key}`,
          projectedPresent,
          legacyPresent,
          projectedValue: projected[key],
          legacyValue: legacy[key],
        };
      }
      const difference = firstProjectionDifference(projected[key], legacy[key], `${path}.${key}`);
      if (difference) return difference;
    }
  } else if (Array.isArray(projected) && Array.isArray(legacy)) {
    const length = Math.max(projected.length, legacy.length);
    for (let index = 0; index < length; index += 1) {
      const projectedPresent = index < projected.length;
      const legacyPresent = index < legacy.length;
      if (!projectedPresent || !legacyPresent) {
        return {
          path: `${path}[${index}]`,
          projectedPresent,
          legacyPresent,
          projectedValue: projected[index],
          legacyValue: legacy[index],
        };
      }
      const difference = firstProjectionDifference(projected[index], legacy[index], `${path}[${index}]`);
      if (difference) return difference;
    }
  }
  return {
    path,
    projectedPresent: projected !== undefined,
    legacyPresent: legacy !== undefined,
    projectedValue: projected,
    legacyValue: legacy,
  };
}

function mismatchFor(projected: RecordValue, legacy: RecordValue): GoalRunProjectionMismatch {
  const difference = firstProjectionDifference(projected, legacy) ?? {
    path: "$",
    projectedPresent: true,
    legacyPresent: true,
    projectedValue: projected,
    legacyValue: legacy,
  };
  return {
    path: difference.path,
    projectedValue: difference.projectedPresent ? difference.projectedValue as GoalRunStoreParity : null,
    legacyValue: difference.legacyPresent ? difference.legacyValue as GoalRunStoreParity : null,
    projectedPresent: difference.projectedPresent,
    legacyPresent: difference.legacyPresent,
    projectedFingerprint: fingerprint(projected),
    legacyFingerprint: fingerprint(legacy),
  };
}

export function importLegacyGoal(legacy: LegacyGoalInput): GoalRunEnvelope {
  const payload = cloneLegacyPayload(legacy, "legacy");
  const status = legacyStatus(payload.status);
  const sourceRevision = legacyRevision(payload.revision);
  const createdAt = legacyTimestamp(payload.created_at, DEFAULT_LEGACY_TIME);
  const updatedCandidate = legacyTimestamp(payload.updated_at, createdAt);
  const updatedAt = Date.parse(updatedCandidate) < Date.parse(createdAt) ? createdAt : updatedCandidate;
  const completedAt = status === "completed" ? legacyTimestamp(payload.completed_at, updatedAt) : null;
  const runId = legacyRunId(payload);
  const objective = legacyText(payload.objective, `Imported legacy goal ${runId}`, 8000);
  const currentPhase = legacyText(payload.current_phase, "Imported legacy goal", 2000);
  const rawCriteria = Array.isArray(payload.success_criteria) ? payload.success_criteria : [];
  if (rawCriteria.length > 128) invalid("legacy.success_criteria exceeds 128 entries");
  const rows = rawCriteria.length
    ? rawCriteria.map((raw, index) => {
        const name = legacyCriterionName(raw, index);
        return {
          index,
          name,
          description: isRecord(raw) ? legacyText(raw.description ?? raw.name, name, 2000) : name,
          passed: legacyCriterionPassed(raw),
          detail: legacyCriterionDetail(raw),
        };
      })
    : [{ index: 0, name: "Imported goal", description: objective.slice(0, 2000), passed: false, detail: null }];
  const base = createStateGoalRun({
    runId,
    objective,
    criteria: rows.map((row) => ({ id: goalRunCriterionId(row.name, row.index), description: row.description })),
    currentPhase,
    nextAction: status === "completed" || status === "cancelled"
      ? null
      : legacyNullableText(payload.next_action ?? payload.nextAction, 4000),
    resumeCursor: legacyNullableText(payload.resume_cursor ?? payload.resumeCursor, 4000),
    now: createdAt,
  });

  const typedEvidence: GoalRunEvidence[] = [];
  const criteria = rows.map((row) => {
    const confirmed = row.passed;
    if (!confirmed) {
      return {
        id: goalRunCriterionId(row.name, row.index),
        description: row.description,
        confirmed: false,
        evidenceIds: [],
        confirmedAt: null,
      };
    }
    const id = goalRunCriterionId(row.name, row.index);
    const evidenceId = `legacy-evidence-${fingerprint({ id, detail: row.detail, passed: row.passed }).slice(0, 24)}`;
    typedEvidence.push({
      id: evidenceId,
      kind: "model_assessed",
      summary: row.detail ?? `Legacy criterion ${row.name} was marked passed`,
      source: "legacy-import",
      metadata: {
        legacyCriterionIndex: row.index,
        legacyCriterionName: row.name,
        legacyPassed: row.passed,
      },
      recordedAt: updatedAt,
    });
    return {
      id,
      description: row.description,
      confirmed: true,
      evidenceIds: [evidenceId],
      confirmedAt: status === "completed" ? completedAt : updatedAt,
    };
  });

  const run: GoalRun = {
    ...base,
    revision: sourceRevision,
    state: status === "completed" ? "COMPLETED" : status === "active" ? "RUNNING" : "INTERRUPTED",
    criteria,
    typedEvidence,
    ...(status === "completed" && criteria.some(criterion => !criterion.confirmed) ? {
      completionBasis: {
        verification: "legacy_record" as const,
        declaration: "Imported completed legacy Goal; unchecked criteria remain unverified",
        declaredAt: completedAt!,
        unverifiedCriterionIds: criteria.filter(criterion => !criterion.confirmed).map(criterion => criterion.id),
      },
    } : {}),
    nextAction: status === "completed" || status === "cancelled" ? null : base.nextAction,
    stopReason: status === "paused" || status === "cancelled"
      ? {
          kind: status === "cancelled" ? "CANCEL" : "PAUSE",
          code: status === "cancelled" ? "legacy_cancelled" : "legacy_paused",
          message: status === "cancelled" ? "Imported cancelled legacy goal" : "Imported paused legacy goal",
          terminal: status === "cancelled",
          at: updatedAt,
          previousState: "RUNNING",
        }
      : null,
    timestamps: {
      createdAt,
      updatedAt,
      stateChangedAt: updatedAt,
      completedAt,
    },
  };
  const envelope: GoalRunEnvelope = {
    schemaVersion: GOAL_RUN_STORE_SCHEMA_VERSION,
    authority: GOAL_RUN_STORE_AUTHORITY,
    run,
    legacyProjectionRevision: sourceRevision,
    legacyProjectionFingerprint: fingerprint(payload),
    parity: newProjectionParity(),
    legacy: payload,
    shadow: true,
    envelopeRevision: 1,
  };
  assertEnvelope(envelope);
  return cloneEnvelope(envelope);
}

export function projectGoalRunToLegacy(
  envelope: GoalRunEnvelope,
  priorLegacy?: LegacyGoalInput
): DurableGoal & RecordValue {
  assertEnvelope(envelope);
  const base = priorLegacy === undefined
    ? envelope.legacy === undefined ? {} : cloneLegacyPayload(envelope.legacy, "envelope.legacy")
    : cloneLegacyPayload(priorLegacy, "priorLegacy");
  const priorCriteria = priorLegacyCriteria(base.success_criteria);
  const criteria = envelope.run.criteria.map((criterion) => {
    const prior = criterionMatch(priorCriteria, envelope.run.criteria.indexOf(criterion), criterion.description);
    const projected: RecordValue = prior ? { ...prior } : {};
    projected.name = criterion.description;
    projected.passed = criterion.confirmed;
    if (!Object.prototype.hasOwnProperty.call(projected, "detail")) {
      const detail = evidenceSummaryForCriterion(envelope.run, criterion);
      if (detail) projected.detail = detail;
    }
    return projected;
  });
  const projected: RecordValue = {
    ...base,
    version: Number.isSafeInteger(base.version) && (base.version as number) > 0 ? base.version : 1,
    id: typeof base.id === "string" && base.id.trim() ? base.id : envelope.run.runId,
    revision: envelope.run.revision,
    objective: envelope.run.objective,
    success_criteria: criteria,
    constraints: Array.isArray(base.constraints) ? base.constraints : [],
    status: legacyStatusForRun(envelope.run),
    current_phase: envelope.run.currentPhase,
    created_at: envelope.run.timestamps.createdAt,
    updated_at: envelope.run.timestamps.updatedAt,
  };
  if (legacyStatusForRun(envelope.run) === "completed") {
    projected.completed_at = envelope.run.timestamps.completedAt ?? envelope.run.timestamps.updatedAt;
  } else {
    delete projected.completed_at;
  }
  return cloneLegacyPayload(projected, "projected legacy") as DurableGoal & RecordValue;
}

export function checkProjectionParity(
  envelope: GoalRunEnvelope,
  legacy: LegacyGoalInput
): GoalRunEnvelope {
  assertEnvelope(envelope);
  const legacyPayload = cloneLegacyPayload(legacy, "legacy");
  const projected = projectGoalRunToLegacy(envelope, legacyPayload) as RecordValue;
  const current = normalizedParity(envelope.parity);
  const matches = stableSerialize(projected) === stableSerialize(legacyPayload);
  const parity: GoalRunProjectionParity = {
    ...current,
    matchedChecks: matches ? current.matchedChecks + 1 : current.matchedChecks,
    mismatch: matches ? null : mismatchFor(projected, legacyPayload),
    lastCheckedRunRevision: envelope.run.revision,
  };
  return updateProjectionMetadata(envelope, parity);
}

/** Record the exact legacy compatibility projection and verify its parity. */
export function recordGoalRunProjection(
  envelope: GoalRunEnvelope,
  legacy: LegacyGoalInput
): GoalRunEnvelope {
  assertEnvelope(envelope);
  const payload = cloneLegacyPayload(legacy, "legacy projection");
  return checkProjectionParity(
    {
      ...cloneEnvelope(envelope),
      legacy: payload,
      legacyProjectionRevision: envelope.run.revision,
      legacyProjectionFingerprint: fingerprint(payload),
    },
    payload
  );
}

function promotionRevisions(
  expected: GoalRunPromotionExpectation | number | undefined,
  expectedRunRevision?: number
): { readonly envelopeRevision?: number; readonly runRevision?: number } {
  if (typeof expected === "number") {
    return expectedRunRevision === undefined
      ? { runRevision: expected }
      : { envelopeRevision: expected, runRevision: expectedRunRevision };
  }
  if (!expected) return {};
  return {
    envelopeRevision: expected.expectedEnvelopeRevision ?? expected.envelopeRevision ?? expected.envelope,
    runRevision: expected.expectedRunRevision ?? expected.runRevision ?? expected.run ?? expected.expectedRevision ?? expected.expected_revision,
  };
}

function assertPromotionRevisions(
  envelope: GoalRunEnvelope,
  expected: GoalRunPromotionExpectation | number | undefined,
  expectedRunRevision?: number
): void {
  const revisions = promotionRevisions(expected, expectedRunRevision);
  if (revisions.envelopeRevision !== undefined) {
    assertExpectedRevision(revisions.envelopeRevision, "expectedEnvelopeRevision");
    const actual = currentEnvelopeRevision(envelope);
    if (actual !== revisions.envelopeRevision) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `envelope revision is ${actual}, but ${revisions.envelopeRevision} was expected`,
        { expectedRevision: revisions.envelopeRevision, actualRevision: actual }
      );
    }
  }
  if (revisions.runRevision !== undefined) {
    assertExpectedRevision(revisions.runRevision, "expectedRunRevision");
    if (envelope.run.revision !== revisions.runRevision) {
      throw new GoalRunStoreError(
        "CAS_CONFLICT",
        `run revision is ${envelope.run.revision}, but ${revisions.runRevision} was expected`,
        { expectedRevision: revisions.runRevision, actualRevision: envelope.run.revision }
      );
    }
  }
}

export function promoteShadow(
  envelope: GoalRunEnvelope,
  expected?: GoalRunPromotionExpectation | number,
  expectedRunRevision?: number
): GoalRunEnvelope {
  assertEnvelope(envelope);
  assertPromotionRevisions(envelope, expected, expectedRunRevision);
  const isShadow = envelope.shadow === true || (envelope.shadow === undefined && envelope.legacy !== undefined);
  if (!isShadow) return cloneEnvelope(envelope);
  const parity = normalizedParity(envelope.parity);
  if (parity.mismatch || parity.repairPending || parity.matchedChecks < parity.requiredMatches) {
    throw new GoalRunStoreError(
      "PROMOTION_BLOCKED",
      `shadow promotion requires ${parity.requiredMatches} matching parity check(s), no mismatch, and no pending repair`
    );
  }
  const promoted: GoalRunEnvelope = {
    ...cloneEnvelope(envelope),
    authority: GOAL_RUN_STORE_AUTHORITY,
    shadow: false,
    legacyProjectionRevision: envelope.run.revision,
    legacyProjectionFingerprint: envelope.legacy === undefined
      ? envelope.legacyProjectionFingerprint
      : fingerprint(envelope.legacy),
    parity: { ...parity, mismatch: null, repairPending: false, repairReason: null },
    envelopeRevision: currentEnvelopeRevision(envelope) + 1,
  };
  assertEnvelope(promoted);
  return cloneEnvelope(promoted);
}

export function markProjectionRepairPending(
  envelope: GoalRunEnvelope,
  reason = "Legacy projection repair pending"
): GoalRunEnvelope {
  assertEnvelope(envelope);
  const parity = normalizedParity(envelope.parity);
  return updateProjectionMetadata(envelope, {
    ...parity,
    repairPending: true,
    repairReason: legacyText(reason, "Legacy projection repair pending", 1000),
  });
}

export function clearProjectionRepairPending(
  envelope: GoalRunEnvelope,
  verifiedLegacy?: LegacyGoalInput
): GoalRunEnvelope {
  const checked = verifiedLegacy === undefined ? envelope : checkProjectionParity(envelope, verifiedLegacy);
  assertEnvelope(checked);
  const parity = normalizedParity(checked.parity);
  if (parity.mismatch || parity.matchedChecks < parity.requiredMatches) {
    throw new GoalRunStoreError(
      "PROMOTION_BLOCKED",
      "projection repair can clear only after a verified parity match"
    );
  }
  if (!parity.repairPending && parity.repairReason === null) return cloneEnvelope(checked);
  return updateProjectionMetadata(checked, { ...parity, repairPending: false, repairReason: null });
}

export const clearProjectionRepair = clearProjectionRepairPending;
export const markProjectionRepair = markProjectionRepairPending;

export interface GoalRunStore {
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly open: () => Promise<GoalRunEnvelope | null>;
  readonly read: () => Promise<GoalRunEnvelope | null>;
  readonly create: (
    source: GoalRunStoreInput | CreateGoalRunInput,
    options?: GoalRunStoreCreateOptions
  ) => Promise<GoalRunEnvelope>;
  readonly replace: (
    sourceOrExpected: GoalRunStoreInput | number,
    optionsOrSource?: GoalRunStoreReplaceOptions | GoalRunStoreInput | number
  ) => Promise<GoalRunEnvelope>;
}

export function openGoalRunStore(workspaceRoot: string): GoalRunStore {
  const normalizedRoot = normalizeWorkspaceRoot(workspaceRoot);
  return {
    workspaceRoot: normalizedRoot,
    filePath: goalRunPath(normalizedRoot),
    open: () => readGoalRun(normalizedRoot),
    read: () => readGoalRun(normalizedRoot),
    create: (source, options) => createGoalRun(normalizedRoot, source, options),
    replace: (sourceOrExpected, optionsOrSource) => replaceGoalRun(normalizedRoot, sourceOrExpected, optionsOrSource),
  };
}
