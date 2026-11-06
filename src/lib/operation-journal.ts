import fs from "node:fs/promises";
import fsSync from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveText } from "./activity-log.js";
import { resilienceDirectory } from "./transport-resilience.js";

/**
 * A durable receipt deliberately keeps the operation identity opaque.  The
 * caller supplies the scope identity, while this module stores only its
 * digest and the argument digest.  This prevents a retry-safe receipt from
 * becoming an arguments, headers, or credentials log.
 */
export type OperationJournalState =
  | "received"
  | "executing"
  | "completed"
  | "failed";

export interface ExecuteOperationOptions {
  readonly workspaceRoot: string;
  /** Trusted session/Driver authority, captured before handler execution. */
  readonly goalId?: string;
  readonly ownerSessionId?: string;
  /** Previous conversation-scoped key, used only to detect unmigrated receipts. */
  readonly legacyIdentity?: string;
  readonly identity: string;
  readonly tool: string;
  readonly args: unknown;
  readonly signal?: AbortSignal;
  /** Resolve a prior receipt without ever claiming or executing the call. */
  readonly observe?: boolean;
}

export interface OperationInspection {
  readonly goal_id?: string;
  readonly owner_session_id?: string;
  readonly workspace_sha256?: string;
  readonly operation_id: string;
  readonly identity_sha256: string;
  readonly tool: string;
  readonly tool_sha256: string;
  readonly args_sha256: string;
  readonly state: OperationJournalState;
  readonly created_at: string;
  readonly accepted_at?: string;
  readonly started_at?: string;
  readonly finished_at?: string;
  readonly result_sha256?: string;
  readonly result_redacted: boolean;
  readonly result_available: boolean;
  readonly result_bytes?: number;
  readonly failure_code?: string;
}

interface OperationReceipt extends OperationInspection {
  readonly version: 1;
  readonly owner_pid?: number;
  readonly result?: CallToolResult;
}

interface ValidatedOperation {
  readonly workspaceRoot: string;
  readonly goalId?: string;
  readonly ownerSessionId?: string;
  readonly legacyIdentitySha256?: string;
  readonly journalDirectory: string;
  readonly operationFile: string;
  readonly operationLockFile: string;
  readonly identity: string;
  readonly identitySha256: string;
  readonly operationId: string;
  readonly tool: string;
  readonly toolLabel: string;
  readonly toolSha256: string;
  readonly args: unknown;
  readonly argsSha256: string;
  readonly signal?: AbortSignal;
  readonly observe: boolean;
}

interface HeldLock {
  readonly file: FileHandle;
  readonly path: string;
  readonly token: string;
}

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

interface JournalLimits {
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxReceiptBytes: number;
  readonly maxResultBytes: number;
  readonly observeWaitMs: number;
}

interface PersistableResult {
  readonly serialized: string;
  readonly value: CallToolResult;
  readonly sha256: string;
  readonly redacted: boolean;
  readonly available: boolean;
  readonly bytes: number;
}

interface UnresolvedOperationIndex {
  readonly version: 1;
  readonly operation_ids: string[];
  readonly updated_at: string;
}

interface UnresolvedOperationTransition {
  readonly version: 1;
  readonly operation_id: string;
  readonly target_state: OperationJournalState;
  readonly created_at: string;
}

class JournalFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "JournalFailure";
    this.code = code;
  }
}

const RECEIPT_VERSION = 1 as const;
const UNRESOLVED_INDEX_VERSION = 1 as const;
const UNRESOLVED_INDEX_FILE = ".unresolved-index.json";
const UNRESOLVED_TRANSITION_FILE = ".unresolved-transition.json";
const DEFAULT_MAX_ENTRIES = 16_384;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_RECEIPT_BYTES = 512 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_OBSERVE_WAIT_MS = 5_000;
const MAX_IDENTITY_CHARS = 4_096;
const MAX_TOOL_CHARS = 256;
const MAX_ARGS_CANONICAL_CHARS = 1 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 32;
const MAX_RESULT_DEPTH = 32;
const MAX_RESULT_NODES = 100_000;
const POLL_INTERVAL_MS = 25;
const HASH_RE = /^[0-9a-f]{64}$/;
const OPERATION_KEY_RE = /^[0-9a-f]{64}$/;

const activeOperations = new Map<
  string,
  { toolSha256: string; argsSha256: string; promise: Promise<CallToolResult> }
>();
const executingOperation = new AsyncLocalStorage<{
  readonly workspaceRoot: string;
  readonly goalId?: string;
  readonly operationId: string;
}>();

/**
 * Execute an operation once per opaque identity.  A durable claim is written
 * before `execute` is entered.  A receipt in `executing` is never reclaimed:
 * after a crash there is no proof that the external side effect did not run.
 */
export function executeOperation(
  options: ExecuteOperationOptions,
  execute: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const validated = validateOperation(options);
  if (validated instanceof JournalFailure) {
    return Promise.resolve(journalError(options?.tool, validated.code, "journal validation failed"));
  }
  if (validated.signal?.aborted) {
    return Promise.resolve(abortedBeforeAcceptance(validated.tool, validated.operationId));
  }

  const activeDirectory = process.platform === "win32"
    ? validated.journalDirectory.toLowerCase()
    : path.normalize(validated.journalDirectory);
  const key = `${activeDirectory}:${validated.operationId}`;
  const active = activeOperations.get(key);
  if (active) {
    if (active.toolSha256 !== validated.toolSha256 || active.argsSha256 !== validated.argsSha256) {
      return Promise.resolve(identityMismatch(validated.tool, validated.operationId));
    }
    if (validated.observe) return observeActiveOperation(validated, active.promise);
    return active.promise;
  }

  const promise = performOperation(validated, execute).catch((error: unknown) => {
    // Admission failures are structured tool failures. Original handler errors
    // retain their first-call exception semantics after a failure receipt.
    if (error instanceof JournalFailure) return journalError(validated.tool, error.code, "journal is unavailable or corrupt");
    throw error;
  });
  activeOperations.set(key, {
    toolSha256: validated.toolSha256,
    argsSha256: validated.argsSha256,
    promise,
  });
  void promise.finally(() => {
    if (activeOperations.get(key)?.promise === promise) activeOperations.delete(key);
  }).catch(() => {
    // The operation promise carries the original handler failure.  This
    // observer only releases the in-process single-flight entry.
  });
  return promise;
}

/**
 * Read a receipt without exposing identity or arguments.  Corruption is
 * intentionally surfaced as an error so recovery callers cannot mistake a
 * damaged journal for `never_seen`.
 */
export async function inspectOperation(
  workspaceRoot: string,
  identity: string,
  goalId?: string
): Promise<OperationInspection | null> {
  const root = validateWorkspaceRoot(workspaceRoot);
  const goal = validateScopeId(goalId, "OPERATION_GOAL_INVALID");
  const identitySha256 = hashIdentity(identity);
  const receipt = await readReceipt(operationFilePath(root, identitySha256, goal));
  if (goal && !receipt) {
    const legacy = await readReceipt(operationFilePath(root, identitySha256));
    if (legacy && (!legacy.goal_id || legacy.goal_id === goal)) {
      throw new JournalFailure("OPERATION_LEGACY_SCOPE_UNRESOLVED");
    }
  }
  return receipt ? publicInspection(receipt) : null;
}

/** Bounded discovery. An explicit Goal includes only itself and unassigned legacy receipts. */
export async function listOperationInspections(
  workspaceRoot: string,
  limit = 256,
  goalId?: string
): Promise<OperationInspection[]> {
  const root = validateWorkspaceRoot(workspaceRoot);
  const goal = validateScopeId(goalId, "OPERATION_GOAL_INVALID");
  const inspections: OperationInspection[] = [];
  for (const directory of await operationDirectories(root, goal)) {
    inspections.push(...(await scanOperationInspections(directory))
      .filter((receipt) => belongsToGoalQuery(receipt, goal)));
  }
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1024);
  return sortOperationInspections(inspections).slice(0, boundedLimit);
}

/**
 * Safety barrier: audit every non-terminal receipt without a display limit.
 * Unknown legacy ownership remains relevant to every Goal until reconciled.
 */
export async function listUnresolvedOperationInspections(
  workspaceRoot: string,
  goalId?: string
): Promise<OperationInspection[]> {
  const root = validateWorkspaceRoot(workspaceRoot);
  const goal = validateScopeId(goalId, "OPERATION_GOAL_INVALID");
  const unresolved = await collectUnresolvedReceipts(root, goal);
  return sortOperationInspections(unresolved.map(publicInspection));
}

/**
 * Other Goals cannot fence this Driver. Its own indeterminate operations still
 * fence replay; unknown legacy ownership cannot be cleared by a dead PID alone.
 */
export async function listAuthorityBlockingOperationInspections(
  workspaceRoot: string,
  authorityAcquiredAt: string,
  goalId?: string
): Promise<OperationInspection[]> {
  const root = validateWorkspaceRoot(workspaceRoot);
  const goal = validateScopeId(goalId, "OPERATION_GOAL_INVALID");
  const authorityAcquiredMs = Date.parse(authorityAcquiredAt);
  const current = executingOperation.getStore();
  const currentWorkspace = current
    ? (process.platform === "win32" ? current.workspaceRoot.toLowerCase() : current.workspaceRoot)
    : null;
  const inspectedWorkspace = process.platform === "win32" ? root.toLowerCase() : root;
  const currentOperationId = currentWorkspace === inspectedWorkspace ? current?.operationId : undefined;
  const unresolved = await collectUnresolvedReceipts(root, goal);
  const blockers = unresolved.filter((receipt) => {
    // Exclude only the exact transfer invocation, including its captured scope.
    if (currentOperationId && receipt.operation_id === currentOperationId &&
        receipt.goal_id === current?.goalId) return false;
    if (goal && !receipt.goal_id) return true;
    if (!Number.isFinite(authorityAcquiredMs)) return true;
    const acceptedAt = receipt.started_at ?? receipt.accepted_at ?? receipt.created_at;
    const acceptedMs = Date.parse(acceptedAt);
    if (!Number.isFinite(acceptedMs) || acceptedMs >= authorityAcquiredMs) return true;
    if (receipt.owner_pid === undefined || isProcessAlive(receipt.owner_pid)) return true;
    return false;
  });
  return sortOperationInspections(blockers.map(publicInspection));
}

async function collectUnresolvedReceipts(root: string, goalId?: string): Promise<OperationReceipt[]> {
  const receipts: OperationReceipt[] = [];
  for (const directory of await operationDirectories(root, goalId)) {
    const current = await withCapacityLock(directory, () => verifiedUnresolvedReceipts(directory));
    receipts.push(...current.filter((receipt) => belongsToGoalQuery(receipt, goalId)));
  }
  return receipts;
}

function belongsToGoalQuery(receipt: OperationInspection, goalId?: string): boolean {
  return goalId === undefined || receipt.goal_id === undefined || receipt.goal_id === goalId;
}

function validateOperation(options: ExecuteOperationOptions): ValidatedOperation | JournalFailure {
  if (!options || typeof options !== "object") return new JournalFailure("OPERATION_OPTIONS_INVALID");
  let workspaceRoot: string;
  try {
    workspaceRoot = validateWorkspaceRoot(options.workspaceRoot);
  } catch {
    return new JournalFailure("WORKSPACE_ROOT_INVALID");
  }

  if (typeof options.identity !== "string" || options.identity.length === 0 || options.identity.length > MAX_IDENTITY_CHARS) {
    return new JournalFailure("OPERATION_IDENTITY_INVALID");
  }
  if (options.identity.includes("\0")) return new JournalFailure("OPERATION_IDENTITY_INVALID");
  if (typeof options.tool !== "string" || options.tool.length === 0 || options.tool.length > MAX_TOOL_CHARS || options.tool.includes("\0")) {
    return new JournalFailure("OPERATION_TOOL_INVALID");
  }

  let goalId: string | undefined;
  let ownerSessionId: string | undefined;
  try {
    goalId = validateScopeId(options.goalId, "OPERATION_GOAL_INVALID");
    ownerSessionId = validateScopeId(options.ownerSessionId, "OPERATION_OWNER_INVALID");
    if (options.legacyIdentity !== undefined &&
        (typeof options.legacyIdentity !== "string" || options.legacyIdentity.length === 0 ||
         options.legacyIdentity.length > MAX_IDENTITY_CHARS || options.legacyIdentity.includes("\0"))) {
      throw new JournalFailure("OPERATION_IDENTITY_INVALID");
    }
  } catch (error) {
    return error instanceof JournalFailure ? error : new JournalFailure("OPERATION_GOAL_INVALID");
  }

  let argsSha256: string;
  try {
    argsSha256 = digestCanonical(options.args);
  } catch (error) {
    return new JournalFailure(error instanceof JournalFailure ? error.code : "OPERATION_ARGUMENTS_INVALID");
  }

  const identitySha256 = hashIdentity(options.identity);
  const journalDirectory = operationDirectory(workspaceRoot, goalId);
  return {
    workspaceRoot,
    goalId,
    ownerSessionId,
    legacyIdentitySha256: options.legacyIdentity === undefined ? undefined : hashIdentity(options.legacyIdentity),
    journalDirectory,
    operationFile: operationFilePath(workspaceRoot, identitySha256, goalId),
    operationLockFile: operationLockPath(workspaceRoot, identitySha256, goalId),
    identity: options.identity,
    identitySha256,
    operationId: identitySha256,
    tool: options.tool,
    toolLabel: safeLabel(options.tool, MAX_TOOL_CHARS),
    toolSha256: hashText(options.tool),
    args: options.args,
    argsSha256,
    signal: options.signal,
    observe: options.observe === true,
  };
}

function validateWorkspaceRoot(workspaceRoot: string): string {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0 || workspaceRoot.includes("\0")) {
    throw new JournalFailure("WORKSPACE_ROOT_INVALID");
  }
  const absolute = path.resolve(workspaceRoot);
  try {
    // Workspace identity must follow the real directory. Otherwise a junction
    // or symlink alias gets a separate resilience directory and can execute the
    // same operation twice under two lexical roots.
    const realRoot = fsSync.realpathSync.native(absolute);
    if (!fsSync.statSync(realRoot).isDirectory()) throw new JournalFailure("WORKSPACE_ROOT_INVALID");
    return path.normalize(realRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof JournalFailure || code !== "ENOENT") throw new JournalFailure("WORKSPACE_ROOT_INVALID");

    // Preserve support for a workspace root that will be created later: resolve
    // the deepest existing parent and append only the missing suffix. Any
    // permission or other filesystem error fails closed instead of silently
    // falling back to a lexical alias.
    const suffix = [path.basename(absolute)];
    let current = path.dirname(absolute);
    while (true) {
      try {
        const existingParent = fsSync.realpathSync.native(current);
        if (!fsSync.statSync(existingParent).isDirectory()) throw new JournalFailure("WORKSPACE_ROOT_INVALID");
        return path.normalize(path.join(existingParent, ...suffix));
      } catch (parentError) {
        const parentCode = (parentError as NodeJS.ErrnoException).code;
        if (parentError instanceof JournalFailure || parentCode !== "ENOENT") throw new JournalFailure("WORKSPACE_ROOT_INVALID");
        const parent = path.dirname(current);
        if (parent === current) throw new JournalFailure("WORKSPACE_ROOT_INVALID");
        suffix.unshift(path.basename(current));
        current = parent;
      }
    }
  }
}

function validateScopeId(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 512 ||
      /[\u0000-\u001f\u007f\u2028\u2029]/.test(value)) throw new JournalFailure(code);
  return value;
}

function operationDirectory(workspaceRoot: string, goalId?: string): string {
  const root = path.join(resilienceDirectory(workspaceRoot), "operations");
  return goalId === undefined ? root : path.join(root, "goals", hashText(goalId));
}

function operationFilePath(workspaceRoot: string, identitySha256: string, goalId?: string): string {
  return path.join(operationDirectory(workspaceRoot, goalId), `operation-${identitySha256}.json`);
}

function operationLockPath(workspaceRoot: string, identitySha256: string, goalId?: string): string {
  return path.join(operationDirectory(workspaceRoot, goalId), `operation-${identitySha256}.lock`);
}

async function operationDirectories(workspaceRoot: string, goalId?: string): Promise<string[]> {
  const legacy = operationDirectory(workspaceRoot);
  const candidates = [legacy];
  if (goalId !== undefined) {
    candidates.push(operationDirectory(workspaceRoot, goalId));
  } else {
    try {
      const entries = await fs.readdir(path.join(legacy, "goals"), { withFileTypes: true });
      for (const entry of entries) {
        if (!HASH_RE.test(entry.name)) continue;
        if (!entry.isDirectory()) throw new JournalFailure("OPERATION_GOAL_SCOPE_MISMATCH");
        candidates.push(path.join(legacy, "goals", entry.name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const directories: string[] = [];
  for (const directory of candidates) {
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new JournalFailure("OPERATION_GOAL_SCOPE_MISMATCH");
      directories.push(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return directories;
}

async function assertNoLegacyScopeConflict(operation: ValidatedOperation): Promise<void> {
  if (!operation.goalId) return;
  const legacyIds = new Set([operation.identitySha256, operation.legacyIdentitySha256].filter(
    (identity): identity is string => identity !== undefined
  ));
  for (const identity of legacyIds) {
    const receipt = await readReceipt(operationFilePath(operation.workspaceRoot, identity));
    if (receipt && (!receipt.goal_id || receipt.goal_id === operation.goalId)) {
      // A fresh directory is not proof that a previously accepted effect never ran.
      throw new JournalFailure("OPERATION_LEGACY_SCOPE_UNRESOLVED");
    }
    if (!receipt && await lockExists(operationLockPath(operation.workspaceRoot, identity))) {
      throw new JournalFailure("OPERATION_LEGACY_SCOPE_UNRESOLVED");
    }
  }
}

function unresolvedIndexPath(directory: string): string {
  return path.join(directory, UNRESOLVED_INDEX_FILE);
}

function unresolvedTransitionPath(directory: string): string {
  return path.join(directory, UNRESOLVED_TRANSITION_FILE);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashIdentity(value: string): string {
  return createHash("sha256").update("operation-identity-v1\0", "utf8").update(value, "utf8").digest("hex");
}

function digestCanonical(value: unknown): string {
  const canonical = canonicalJson(value, 0, new Set<object>(), { chars: 0 });
  return hashText(canonical);
}

interface CanonicalBudget {
  chars: number;
}

function canonicalJson(value: unknown, depth: number, seen: Set<object>, budget: CanonicalBudget): string {
  if (budget.chars > MAX_ARGS_CANONICAL_CHARS) throw new JournalFailure("OPERATION_ARGUMENTS_TOO_LARGE");
  if (value === null) return countCanonical("null", budget);
  if (value === undefined) return countCanonical("undefined", budget);
  if (typeof value === "string") return countCanonical(JSON.stringify(value), budget);
  if (typeof value === "boolean") return countCanonical(value ? "true" : "false", budget);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new JournalFailure("OPERATION_ARGUMENTS_INVALID");
    return countCanonical(Object.is(value, -0) ? "-0" : String(value), budget);
  }
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    throw new JournalFailure("OPERATION_ARGUMENTS_INVALID");
  }
  if (depth >= MAX_CANONICAL_DEPTH) throw new JournalFailure("OPERATION_ARGUMENTS_TOO_DEEP");
  if (seen.has(value as object)) throw new JournalFailure("OPERATION_ARGUMENTS_CYCLIC");
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => canonicalJson(item, depth + 1, seen, budget));
      return countCanonical(`[${items.join(",")}]`, budget);
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1, seen, budget)}`);
    return countCanonical(`{${entries.join(",")}}`, budget);
  } finally {
    seen.delete(value as object);
  }
}

function countCanonical(value: string, budget: CanonicalBudget): string {
  budget.chars += value.length;
  if (budget.chars > MAX_ARGS_CANONICAL_CHARS) throw new JournalFailure("OPERATION_ARGUMENTS_TOO_LARGE");
  return value;
}

function safeLabel(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").slice(0, max);
}

function parseLimit(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function journalLimits(): JournalLimits {
  return {
    maxEntries: parseLimit("MCP_OPERATION_JOURNAL_MAX_ENTRIES", DEFAULT_MAX_ENTRIES, 0, 100_000),
    maxBytes: parseLimit("MCP_OPERATION_JOURNAL_MAX_BYTES", DEFAULT_MAX_BYTES, 0, 256 * 1024 * 1024),
    maxReceiptBytes: parseLimit("MCP_OPERATION_JOURNAL_MAX_RECEIPT_BYTES", DEFAULT_MAX_RECEIPT_BYTES, 512, 16 * 1024 * 1024),
    maxResultBytes: parseLimit("MCP_OPERATION_JOURNAL_MAX_RESULT_BYTES", DEFAULT_MAX_RESULT_BYTES, 256, 8 * 1024 * 1024),
    observeWaitMs: parseLimit("MCP_OPERATION_JOURNAL_OBSERVE_WAIT_MS", DEFAULT_OBSERVE_WAIT_MS, 0, 60_000),
  };
}

async function performOperation(
  operation: ValidatedOperation,
  execute: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    await assertNoLegacyScopeConflict(operation);
    await ensureJournalDirectory(operation.journalDirectory);
    const existing = await readReceipt(operation.operationFile);
    if (existing) {
      assertMatches(existing, operation);
      if (isTerminal(existing.state)) return replayReceipt(existing, operation);
      if (operation.observe) return observeReceipt(operation, existing);
      if (existing.state === "executing") return observeReceipt(operation, existing);
      return resumeReceived(operation, existing, execute);
    }
    if (operation.observe) return neverSeen(operation.tool, operation.operationId);
    return claimNew(operation, execute);
  } catch (error) {
    if (error instanceof JournalFailure) return journalError(operation.tool, error.code, "journal is unavailable or corrupt");
    return journalError(operation.tool, "OPERATION_JOURNAL_UNAVAILABLE", "journal is unavailable or corrupt");
  }
}

async function claimNew(
  operation: ValidatedOperation,
  execute: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (operation.signal?.aborted) return abortedBeforeAcceptance(operation.tool, operation.operationId);
    let lock = await tryOpenLock(operation.operationLockFile, true);
    if (!lock) {
      const current = await readReceipt(operation.operationFile);
      if (current) {
        assertMatches(current, operation);
        if (isTerminal(current.state)) return replayReceipt(current, operation);
        if (current.state === "executing" || operation.observe) return observeReceipt(operation, current);
        return waitForReceipt(operation, current, execute);
      }
      const owner = await readLockOwner(operation.operationLockFile);
      if (!owner && await lockExists(operation.operationLockFile)) {
        return journalError(operation.tool, "OPERATION_JOURNAL_CORRUPT", "operation lock is unreadable; recovery is fail closed");
      }
      if (owner && !isProcessAlive(owner.pid)) {
        if (await reclaimDeadLock(operation.operationLockFile)) continue;
        return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "a stale-lock reaper is active; recovery is fail closed until it completes");
      }
      return waitForMissingReceipt(operation, execute);
    }
    try {
      const current = await readReceipt(operation.operationFile);
      if (current) {
        assertMatches(current, operation);
        if (isTerminal(current.state)) return replayReceipt(current, operation);
        if (current.state === "executing" || operation.observe) return observeReceipt(operation, current);
        return await executeClaimed(operation, current, lock, execute);
      }
      const received = makeReceived(operation);
      await withCapacityLock(operation.journalDirectory, async () => {
        await recoverUnresolvedTransition(operation.journalDirectory);
        await assertCapacity(operation.journalDirectory, operation.operationFile, received);
        await persistIndexedTransition(operation.journalDirectory, received.operation_id, received.state, async () => {
          await createReceipt(operation.operationFile, received);
        });
      });
      return await executeClaimed(operation, received, lock, execute);
    } finally {
      await releaseLock(lock);
    }
  }
  return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "journal admission is busy; retry after inspecting operation state");
}

async function resumeReceived(
  operation: ValidatedOperation,
  received: OperationReceipt,
  execute: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (operation.signal?.aborted) return abortedBeforeAcceptance(operation.tool, operation.operationId);
    const lock = await tryOpenLock(operation.operationLockFile, true);
    if (!lock) {
      const current = await readReceipt(operation.operationFile);
      if (!current) return waitForMissingReceipt(operation, execute);
      assertMatches(current, operation);
      if (isTerminal(current.state)) return replayReceipt(current, operation);
      if (current.state === "executing") return observeReceipt(operation, current);
      const owner = await readLockOwner(operation.operationLockFile);
      if (!owner && await lockExists(operation.operationLockFile)) {
        return journalError(operation.tool, "OPERATION_JOURNAL_CORRUPT", "operation lock is unreadable; recovery is fail closed");
      }
      if (owner && !isProcessAlive(owner.pid)) {
        if (await reclaimDeadLock(operation.operationLockFile)) continue;
        return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "a stale-lock reaper is active; recovery is fail closed until it completes");
      }
      return waitForReceipt(operation, current, execute);
    }
    try {
      const current = await readReceipt(operation.operationFile);
      if (!current) return journalError(operation.tool, "OPERATION_JOURNAL_CORRUPT", "operation claim disappeared");
      assertMatches(current, operation);
      if (isTerminal(current.state)) return replayReceipt(current, operation);
      if (current.state === "executing") return observeReceipt(operation, current);
      return await executeClaimed(operation, current, lock, execute);
    } finally {
      await releaseLock(lock);
    }
  }
  return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "journal admission is busy; retry after inspecting operation state");
}

async function executeClaimed(
  operation: ValidatedOperation,
  received: OperationReceipt,
  _lock: HeldLock,
  execute: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  if (operation.signal?.aborted) return abortedBeforeAcceptance(operation.tool, operation.operationId);

  const executing: OperationReceipt = {
    ...received,
    state: "executing",
    accepted_at: received.accepted_at ?? new Date().toISOString(),
    started_at: new Date().toISOString(),
    owner_pid: process.pid,
    result_available: false,
    result_redacted: false,
  };
  try {
    await persistReceipt(operation, received, executing);
  } catch (error) {
    return journalError(operation.tool, errorCode(error, "OPERATION_JOURNAL_UNAVAILABLE"), "operation was not started because its claim could not be made durable");
  }

  // Once `executing` is durable, an abort is no longer a safe cancellation
  // before acceptance. We know this process has not entered the callback, so
  // record a terminal failure when possible; if that write fails, preserve the
  // executing receipt and report outcome unknown.
  if (operation.signal?.aborted) {
    const aborted = makeFailureResult(operation.tool, "OPERATION_ABORTED_AFTER_ACCEPTANCE");
    try {
      await persistTerminal(operation, executing, "failed", aborted, "OPERATION_ABORTED_AFTER_ACCEPTANCE");
      return aborted;
    } catch {
      return outcomeUnknown(operation.tool, operation.operationId, "accepted operation could not record its aborted outcome");
    }
  }

  let rawResult: CallToolResult;
  let thrown = false;
  let thrownError: unknown;
  try {
    rawResult = await executingOperation.run({
      workspaceRoot: operation.workspaceRoot,
      goalId: operation.goalId,
      operationId: operation.operationId,
    }, execute);
    if (!isCallToolResult(rawResult)) {
      throw new JournalFailure("OPERATION_RESULT_INVALID");
    }
  } catch (error) {
    thrown = true;
    thrownError = error;
    rawResult = makeFailureResult(operation.tool, "OPERATION_EXECUTION_FAILED");
  }

  const terminalState: OperationJournalState = resultIsFailure(rawResult) || thrown ? "failed" : "completed";
  const failureCode = terminalState === "failed"
    ? (thrown ? "OPERATION_EXECUTION_FAILED" : "TOOL_ERROR_RESULT")
    : undefined;
  try {
    await persistTerminal(operation, executing, terminalState, rawResult, failureCode);
  } catch {
    // The effect may already have happened. Returning a normal success here
    // would invite a blind retry, so keep the durable executing truth and make
    // the caller reconcile the external state.
    return outcomeUnknown(operation.tool, operation.operationId, "operation ran but its final receipt could not be persisted");
  }

  if (thrown) throw thrownError;
  return rawResult;
}

async function persistTerminal(
  operation: ValidatedOperation,
  expected: OperationReceipt,
  state: "completed" | "failed",
  rawResult: CallToolResult,
  failureCode?: string
): Promise<void> {
  const prepared = prepareResult(rawResult, operation.tool, operation.operationId);
  const next: OperationReceipt = {
    ...expected,
    state,
    finished_at: new Date().toISOString(),
    result_sha256: prepared.sha256,
    result_redacted: prepared.redacted,
    result_available: prepared.available,
    result_bytes: prepared.bytes,
    ...(prepared.available ? { result: prepared.value } : {}),
    ...(failureCode ? { failure_code: failureCode } : {}),
  };
  await persistReceipt(operation, expected, next);
}

async function persistReceipt(
  operation: ValidatedOperation,
  expected: OperationReceipt,
  next: OperationReceipt
): Promise<void> {
  await withCapacityLock(operation.journalDirectory, async () => {
    await recoverUnresolvedTransition(operation.journalDirectory);
    const current = await readReceipt(operation.operationFile);
    if (!current || !sameReceiptIdentity(current, expected) || current.state !== expected.state) {
      throw new JournalFailure("OPERATION_JOURNAL_CONFLICT");
    }
    await assertCapacity(operation.journalDirectory, operation.operationFile, next);
    await persistIndexedTransition(operation.journalDirectory, next.operation_id, next.state, async () => {
      await atomicReplaceReceipt(operation.operationFile, next);
    });
  });
}

function makeReceived(operation: ValidatedOperation): OperationReceipt {
  const now = new Date().toISOString();
  return {
    version: RECEIPT_VERSION,
    ...(operation.goalId ? { goal_id: operation.goalId } : {}),
    ...(operation.ownerSessionId ? { owner_session_id: operation.ownerSessionId } : {}),
    workspace_sha256: hashText(operation.workspaceRoot.toLowerCase()),
    operation_id: operation.operationId,
    identity_sha256: operation.identitySha256,
    tool: operation.toolLabel,
    tool_sha256: operation.toolSha256,
    args_sha256: operation.argsSha256,
    state: "received",
    created_at: now,
    accepted_at: now,
    result_redacted: false,
    result_available: false,
    owner_pid: process.pid,
  };
}

function sameReceiptIdentity(a: OperationReceipt, b: OperationReceipt): boolean {
  return a.version === b.version &&
    a.goal_id === b.goal_id &&
    a.workspace_sha256 === b.workspace_sha256 &&
    a.operation_id === b.operation_id &&
    a.identity_sha256 === b.identity_sha256 &&
    a.tool_sha256 === b.tool_sha256 &&
    a.args_sha256 === b.args_sha256;
}

function assertMatches(receipt: OperationReceipt, operation: ValidatedOperation): void {
  if (receipt.goal_id !== operation.goalId ||
      (receipt.workspace_sha256 !== undefined && receipt.workspace_sha256 !== hashText(operation.workspaceRoot.toLowerCase())) ||
      receipt.identity_sha256 !== operation.identitySha256 ||
      receipt.tool_sha256 !== operation.toolSha256 ||
      receipt.args_sha256 !== operation.argsSha256) {
    throw new JournalFailure("OPERATION_IDENTITY_MISMATCH");
  }
}

function isTerminal(state: OperationJournalState): state is "completed" | "failed" {
  return state === "completed" || state === "failed";
}

function resultIsFailure(result: CallToolResult): boolean {
  if (result.isError === true) return true;
  const structured = result.structuredContent;
  return Boolean(structured && typeof structured === "object" && structured.ok === false);
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return Boolean(value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content));
}

function prepareResult(result: CallToolResult, tool: string, operationId: string): PersistableResult {
  const originalIsError = result.isError === true;
  const originalFailed = resultIsFailure(result);
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
    if (typeof serialized !== "string") throw new JournalFailure("OPERATION_RESULT_SERIALIZATION_FAILED");
  } catch {
    const fallback = resultUnavailable(tool, operationId, "OPERATION_RESULT_SERIALIZATION_FAILED", undefined, originalIsError, originalFailed);
    const fallbackSerialized = JSON.stringify(fallback);
    return {
      serialized: fallbackSerialized,
      value: fallback,
      sha256: hashText(fallbackSerialized),
      redacted: false,
      available: true,
      bytes: Buffer.byteLength(fallbackSerialized, "utf8"),
    };
  }

  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes > journalLimits().maxResultBytes) {
    const fallback = resultUnavailable(tool, operationId, "RESULT_NOT_RETAINED", hashText(serialized), originalIsError, originalFailed);
    const fallbackSerialized = JSON.stringify(fallback);
    return {
      serialized: fallbackSerialized,
      value: fallback,
      sha256: hashText(fallbackSerialized),
      redacted: false,
      available: true,
      bytes: Buffer.byteLength(fallbackSerialized, "utf8"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    const fallback = resultUnavailable(tool, operationId, "OPERATION_RESULT_SERIALIZATION_FAILED", undefined, originalIsError, originalFailed);
    const fallbackSerialized = JSON.stringify(fallback);
    return {
      serialized: fallbackSerialized,
      value: fallback,
      sha256: hashText(fallbackSerialized),
      redacted: false,
      available: true,
      bytes: Buffer.byteLength(fallbackSerialized, "utf8"),
    };
  }

  const redacted = redactJson(parsed);
  if (!redacted.changed) {
    return {
      serialized,
      value: result,
      sha256: hashText(serialized),
      redacted: false,
      available: true,
      bytes: originalBytes,
    };
  }
  const redactedSerialized = JSON.stringify(redacted.value);
  const redactedBytes = Buffer.byteLength(redactedSerialized, "utf8");
  if (redactedBytes > journalLimits().maxResultBytes) {
    const fallback = resultUnavailable(tool, operationId, "RESULT_NOT_RETAINED", hashText(redactedSerialized), originalIsError, originalFailed);
    const fallbackSerialized = JSON.stringify(fallback);
    return {
      serialized: fallbackSerialized,
      value: fallback,
      sha256: hashText(fallbackSerialized),
      redacted: true,
      available: true,
      bytes: Buffer.byteLength(fallbackSerialized, "utf8"),
    };
  }
  return {
    serialized: redactedSerialized,
    value: redacted.value as CallToolResult,
    sha256: hashText(redactedSerialized),
    redacted: true,
    available: true,
    bytes: redactedBytes,
  };
}

const SENSITIVE_KEY_RE = /(?:authorization|cookie|set-cookie|headers?|raw[_-]?args?|arguments?|credentials?|private[_-]?key|access[_-]?key|refresh[_-]?token|api[_-]?key|token|secret|password)/i;

interface RedactedJson {
  readonly value: unknown;
  readonly changed: boolean;
}

function redactJson(value: unknown): RedactedJson {
  const seen = new Set<object>();
  const result = redactJsonValue(value, "", 0, seen, { count: 0 });
  return result;
}

interface ResultBudget {
  count: number;
}

function redactJsonValue(value: unknown, key: string, depth: number, seen: Set<object>, budget: ResultBudget): RedactedJson {
  budget.count++;
  if (budget.count > MAX_RESULT_NODES || depth > MAX_RESULT_DEPTH) {
    return { value: "[REDACTED]", changed: true };
  }
  if (SENSITIVE_KEY_RE.test(key)) return { value: "[REDACTED]", changed: true };
  if (typeof value === "string") {
    if (key === "text") {
      const parsedText = parseJsonText(value);
      if (parsedText !== undefined) {
        const nested = redactJson(parsedText);
        if (nested.changed) {
          return { value: JSON.stringify(nested.value), changed: true };
        }
      }
    }
    const redacted = redactSensitiveString(value);
    return { value: redacted, changed: redacted !== value };
  }
  if (value === null || typeof value !== "object") return { value, changed: false };
  if (seen.has(value as object)) return { value: "[REDACTED]", changed: true };
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      let changed = false;
      const output = value.map((item) => {
        const next = redactJsonValue(item, "", depth + 1, seen, budget);
        changed ||= next.changed;
        return next.value;
      });
      return { value: output, changed };
    }
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      const next = redactJsonValue(child, childKey, depth + 1, seen, budget);
      changed ||= next.changed;
      output[childKey] = next.value;
    }
    return { value: output, changed };
  } finally {
    seen.delete(value as object);
  }
}

function redactSensitiveString(value: string): string {
  let output = redactSensitiveText(value);
  output = output
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, "$1-[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(["']?\b(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[REDACTED]");
  return output;
}

function parseJsonText(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed.length > 128 * 1024) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function resultUnavailable(
  tool: string,
  operationId: string,
  code: string,
  originalSha256: string | undefined,
  originalIsError: boolean,
  originalFailed = originalIsError,
): CallToolResult {
  const payload = {
    ok: false,
    tool: safeLabel(tool, MAX_TOOL_CHARS),
    summary: "The operation result was not retained. Inspect task state and artifacts before retrying any side effect.",
    data: {
      error: code,
      outcome: originalFailed ? "failed" : "completed",
      operation_id: operationId,
      original_is_error: originalIsError,
      ...(originalSha256 ? { original_result_sha256: originalSha256 } : {}),
      next_action: "Inspect task state and artifacts; do not blindly rerun this operation.",
    },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function makeFailureResult(tool: string, code: string): CallToolResult {
  const payload = {
    ok: false,
    tool: safeLabel(tool, MAX_TOOL_CHARS),
    summary: "The operation failed. Its failure receipt is retained and must be reconciled before retrying.",
    data: {
      error: code,
      outcome: "failed",
      next_action: "Inspect task state and artifacts before retrying this operation.",
    },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function journalError(tool: string | undefined, code: string, summary: string): CallToolResult {
  const safeTool = typeof tool === "string" ? safeLabel(tool, MAX_TOOL_CHARS) : "operation";
  const payload = {
    ok: false,
    tool: safeTool,
    summary,
    data: {
      error: code,
      outcome: "journal_unavailable",
      next_action: "Inspect the journal and operation state; do not retry a possible side effect blindly.",
    },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function identityMismatch(tool: string, operationId: string): CallToolResult {
  return journalErrorWithData(tool, "OPERATION_IDENTITY_MISMATCH", "operation identity conflicts with an existing receipt", {
    outcome: "identity_mismatch",
    operation_id: operationId,
    next_action: "Use the original tool and canonical arguments for this operation identity, or choose a new identity.",
  });
}

function neverSeen(tool: string, operationId: string): CallToolResult {
  return journalErrorWithData(tool, "OPERATION_NEVER_SEEN", "no durable receipt exists for this operation", {
    outcome: "never_seen",
    operation_id: operationId,
    next_action: "The observe-only lookup did not execute or claim the operation.",
  });
}

function abortedBeforeAcceptance(tool: string, operationId: string): CallToolResult {
  return journalErrorWithData(tool, "OPERATION_ABORTED_BEFORE_ACCEPTANCE", "operation was cancelled before durable acceptance", {
    outcome: "not_accepted",
    operation_id: operationId,
    next_action: "No tool callback was entered. Retry with a live request if the operation is still required.",
  });
}

function outcomeUnknown(tool: string, operationId: string, reason: string): CallToolResult {
  return journalErrorWithData(tool, "OPERATION_OUTCOME_UNKNOWN", "operation outcome is unknown; reconcile before retrying", {
    outcome: "unknown",
    operation_id: operationId,
    reason,
    next_action: "Inspect task state and external artifacts. Do not blindly rerun this mutation.",
  });
}

function journalErrorWithData(tool: string, code: string, summary: string, data: Record<string, unknown>): CallToolResult {
  const payload = { ok: false, tool: safeLabel(tool, MAX_TOOL_CHARS), summary, data: { error: code, ...data } };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

function replayReceipt(receipt: OperationReceipt, operation: ValidatedOperation): CallToolResult {
  if (!receipt.result_available || !receipt.result) {
    return resultUnavailable(
      operation.tool,
      operation.operationId,
      receipt.state === "failed" ? "FAILURE_RESULT_NOT_RETAINED" : "RESULT_NOT_RETAINED",
      receipt.result_sha256,
      receipt.state === "failed"
    );
  }
  const result = receipt.result;
  return receipt.result_redacted ? markRedactedReplay(result) : result;
}

function markRedactedReplay(result: CallToolResult): CallToolResult {
  const currentMeta = result._meta && typeof result._meta === "object" ? result._meta : {};
  return {
    ...result,
    _meta: {
      ...currentMeta,
      "operation-journal": {
        redacted: true,
        note: "Receipt replay is redacted; inspect original task artifacts before relying on omitted values.",
      },
    },
  };
}

function observeReceipt(operation: ValidatedOperation, receipt: OperationReceipt): Promise<CallToolResult> {
  return waitForReceipt(operation, receipt);
}

async function observeActiveOperation(
  operation: ValidatedOperation,
  promise: Promise<CallToolResult>
): Promise<CallToolResult> {
  const waitMs = journalLimits().observeWaitMs;
  if (waitMs <= 0) return outcomeUnknown(operation.tool, operation.operationId, "operation is active in this process");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = promise.then(
    (result) => ({ kind: "result" as const, result }),
    () => ({ kind: "failure" as const })
  );
  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), waitMs);
  });
  const observed = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);
  if (observed.kind === "result") return observed.result;
  if (observed.kind === "failure") return makeFailureResult(operation.tool, "OPERATION_EXECUTION_FAILED");
  return outcomeUnknown(operation.tool, operation.operationId, "operation remains active after the bounded observation window");
}

async function waitForReceipt(
  operation: ValidatedOperation,
  initial: OperationReceipt,
  execute?: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  let current = initial;
  const waitMs = journalLimits().observeWaitMs;
  const deadline = Date.now() + waitMs;
  while (true) {
    if (isTerminal(current.state)) return replayReceipt(current, operation);
    if (operation.signal?.aborted) return outcomeUnknown(operation.tool, operation.operationId, "observation request was cancelled");
    const owner = await readLockOwner(operation.operationLockFile);
    if (!owner && await lockExists(operation.operationLockFile)) {
      return journalError(operation.tool, "OPERATION_JOURNAL_CORRUPT", "operation lock is unreadable; recovery is fail closed");
    }
    if (!owner || !isProcessAlive(owner.pid)) {
      if (current.state === "executing") return outcomeUnknown(operation.tool, operation.operationId, "executing receipt has no live owner");
      if (operation.observe || !execute) {
        return journalErrorWithData(operation.tool, "OPERATION_RECEIVED", "operation is durably received but not executing", {
          outcome: "received",
          operation_id: operation.operationId,
          next_action: "Retry with execution enabled to resume this pre-execution claim.",
        });
      }
      if (owner && await reclaimDeadLock(operation.operationLockFile)) {
        return resumeReceived(operation, current, execute);
      }
      if (owner) return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "a stale-lock reaper is active; recovery is fail closed until it completes");
      return resumeReceived(operation, current, execute);
    }
    if (waitMs === 0 || Date.now() >= deadline) {
      if (current.state === "executing") return outcomeUnknown(operation.tool, operation.operationId, "operation is still executing");
      return journalErrorWithData(operation.tool, "OPERATION_RECEIVED", "operation is durably received but not executing", {
        outcome: "received",
        operation_id: operation.operationId,
        next_action: "Retry after the owner releases its claim; do not create a second mutation.",
      });
    }
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    const next = await readReceipt(operation.operationFile);
    if (!next) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    assertMatches(next, operation);
    current = next;
  }
}

async function waitForMissingReceipt(
  operation: ValidatedOperation,
  execute: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  const waitMs = journalLimits().observeWaitMs;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (operation.signal?.aborted) return abortedBeforeAcceptance(operation.tool, operation.operationId);
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    const receipt = await readReceipt(operation.operationFile);
    if (receipt) {
      assertMatches(receipt, operation);
      if (isTerminal(receipt.state)) return replayReceipt(receipt, operation);
      if (receipt.state === "executing") return observeReceipt(operation, receipt);
      return resumeReceived(operation, receipt, execute);
    }
    const owner = await readLockOwner(operation.operationLockFile);
    if (!owner && await lockExists(operation.operationLockFile)) {
      return journalError(operation.tool, "OPERATION_JOURNAL_CORRUPT", "operation lock is unreadable; recovery is fail closed");
    }
    if (!owner) break;
    if (!isProcessAlive(owner.pid)) {
      if (await reclaimDeadLock(operation.operationLockFile)) return claimNew(operation, execute);
      return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "a stale-lock reaper is active; recovery is fail closed until it completes");
    }
  }
  return journalError(operation.tool, "OPERATION_JOURNAL_BUSY", "another process is admitting this operation; retry after inspecting its receipt");
}

async function ensureJournalDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => undefined);
}

async function readReceipt(file: string): Promise<OperationReceipt | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  const receipt = validateReceipt(parsed);
  const directory = path.dirname(file);
  if (path.basename(path.dirname(directory)) === "goals") {
    if (!receipt.goal_id || path.basename(directory) !== hashText(receipt.goal_id)) {
      throw new JournalFailure("OPERATION_GOAL_SCOPE_MISMATCH");
    }
    const workspaceSlug = path.basename(path.dirname(path.dirname(path.dirname(directory))));
    if (!receipt.workspace_sha256 || workspaceSlug !== receipt.workspace_sha256.slice(0, 16)) {
      throw new JournalFailure("OPERATION_WORKSPACE_SCOPE_MISMATCH");
    }
  }
  return receipt;
}

function validateReceipt(value: unknown): OperationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  const record = value as Record<string, unknown>;
  if (record.version !== RECEIPT_VERSION ||
      typeof record.operation_id !== "string" || !OPERATION_KEY_RE.test(record.operation_id) ||
      record.identity_sha256 !== record.operation_id ||
      typeof record.tool !== "string" || record.tool.length === 0 || record.tool.length > MAX_TOOL_CHARS ||
      typeof record.tool_sha256 !== "string" || !HASH_RE.test(record.tool_sha256) ||
      typeof record.args_sha256 !== "string" || !HASH_RE.test(record.args_sha256) ||
      !isReceiptState(record.state) ||
      typeof record.created_at !== "string" ||
      typeof record.result_redacted !== "boolean" ||
      typeof record.result_available !== "boolean") {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  try {
    validateScopeId(record.goal_id, "OPERATION_JOURNAL_CORRUPT");
    validateScopeId(record.owner_session_id, "OPERATION_JOURNAL_CORRUPT");
  } catch { throw new JournalFailure("OPERATION_JOURNAL_CORRUPT"); }
  if (record.workspace_sha256 !== undefined &&
      (typeof record.workspace_sha256 !== "string" || !HASH_RE.test(record.workspace_sha256))) {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  if (record.owner_pid !== undefined && (!Number.isInteger(record.owner_pid) || Number(record.owner_pid) <= 0)) {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  if (record.result_sha256 !== undefined && (typeof record.result_sha256 !== "string" || !HASH_RE.test(record.result_sha256))) {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  if (record.result_bytes !== undefined && (!Number.isInteger(record.result_bytes) || Number(record.result_bytes) < 0)) {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  if (record.failure_code !== undefined && (typeof record.failure_code !== "string" || !/^[A-Z0-9_]{1,80}$/.test(record.failure_code))) {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  if (record.result_available) {
    if (!record.result || typeof record.result !== "object" || Array.isArray(record.result) || !Array.isArray((record.result as Record<string, unknown>).content)) {
      throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    }
    if (!record.result_sha256) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    let serialized: string;
    try {
      serialized = JSON.stringify(record.result);
    } catch {
      throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    }
    if (hashText(serialized) !== record.result_sha256) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  } else if (record.result !== undefined) {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  return record as unknown as OperationReceipt;
}

function isReceiptState(value: unknown): value is OperationJournalState {
  return value === "received" || value === "executing" || value === "completed" || value === "failed";
}

function publicInspection(receipt: OperationReceipt): OperationInspection {
  const {
    version: _version,
    owner_pid: _ownerPid,
    result: _result,
    ...inspection
  } = receipt;
  return inspection;
}

async function scanOperationInspections(directory: string, knownNames?: string[]): Promise<OperationInspection[]> {
  return (await scanOperationReceipts(directory, knownNames)).map(publicInspection);
}

async function scanOperationReceipts(directory: string, knownNames?: string[]): Promise<OperationReceipt[]> {
  const names = knownNames ?? await fs.readdir(directory);
  const receipts: OperationReceipt[] = [];
  for (const name of names) {
    if (!/^operation-[a-f0-9]{64}\.json$/i.test(name)) continue;
    const receipt = await readReceipt(path.join(directory, name));
    if (!receipt) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    receipts.push(receipt);
  }
  return receipts;
}

async function verifiedUnresolvedReceipts(directory: string): Promise<OperationReceipt[]> {
  await recoverUnresolvedTransition(directory);
  const index = await ensureUnresolvedIndex(directory);
  const receipts = await scanOperationReceipts(directory);
  const unresolved = receipts.filter((receipt) => !isTerminal(receipt.state));
  const actualIds = unresolved.map((receipt) => receipt.operation_id).sort();
  if (!sameStringArray(index.operation_ids, actualIds)) {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_MISMATCH");
  }
  return unresolved;
}

function sortOperationInspections(inspections: OperationInspection[]): OperationInspection[] {
  return inspections.sort((a, b) => {
    const at = a.finished_at ?? a.started_at ?? a.accepted_at ?? a.created_at;
    const bt = b.finished_at ?? b.started_at ?? b.accepted_at ?? b.created_at;
    return bt.localeCompare(at);
  });
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function ensureUnresolvedIndex(directory: string): Promise<UnresolvedOperationIndex> {
  const current = await readUnresolvedIndex(directory);
  if (current) return current;
  const inspections = await scanOperationInspections(directory);
  const migrated = makeUnresolvedIndex(inspections
    .filter((inspection) => !isTerminal(inspection.state))
    .map((inspection) => inspection.operation_id));
  await writeUnresolvedIndex(directory, migrated);
  return migrated;
}

function makeUnresolvedIndex(operationIds: readonly string[]): UnresolvedOperationIndex {
  return {
    version: UNRESOLVED_INDEX_VERSION,
    operation_ids: [...new Set(operationIds)].sort(),
    updated_at: new Date().toISOString(),
  };
}

async function readUnresolvedIndex(directory: string): Promise<UnresolvedOperationIndex | null> {
  const raw = await readOptionalText(unresolvedIndexPath(directory));
  if (raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > journalLimits().maxEntries * 72 + 4096) {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== UNRESOLVED_INDEX_VERSION ||
      !Array.isArray(record.operation_ids) ||
      record.operation_ids.length > journalLimits().maxEntries ||
      typeof record.updated_at !== "string") {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  const ids = record.operation_ids;
  if (ids.some((value) => typeof value !== "string" || !OPERATION_KEY_RE.test(value)) ||
      !sameStringArray(ids as string[], [...ids as string[]].sort()) ||
      new Set(ids).size !== ids.length) {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  return record as unknown as UnresolvedOperationIndex;
}

async function setUnresolvedMembership(directory: string, operationId: string, unresolved: boolean): Promise<void> {
  const current = await ensureUnresolvedIndex(directory);
  const ids = new Set(current.operation_ids);
  if (unresolved) ids.add(operationId);
  else ids.delete(operationId);
  const next = makeUnresolvedIndex([...ids]);
  if (!sameStringArray(current.operation_ids, next.operation_ids)) await writeUnresolvedIndex(directory, next);
}

async function writeUnresolvedIndex(directory: string, index: UnresolvedOperationIndex): Promise<void> {
  await atomicReplaceText(unresolvedIndexPath(directory), `${JSON.stringify(index)}\n`);
}

async function readUnresolvedTransition(directory: string): Promise<UnresolvedOperationTransition | null> {
  const raw = await readOptionalText(unresolvedTransitionPath(directory));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== UNRESOLVED_INDEX_VERSION ||
      typeof record.operation_id !== "string" || !OPERATION_KEY_RE.test(record.operation_id) ||
      !isReceiptState(record.target_state) || typeof record.created_at !== "string") {
    throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
  }
  return record as unknown as UnresolvedOperationTransition;
}

async function recoverUnresolvedTransition(directory: string): Promise<void> {
  const transition = await readUnresolvedTransition(directory);
  if (!transition) return;
  const receipt = await readReceipt(path.join(directory, `operation-${transition.operation_id}.json`));
  if (!receipt) {
    if (transition.target_state === "completed" || transition.target_state === "failed") {
      throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_CORRUPT");
    }
    // A crash may occur after the add intent/index write but before the first
    // RECEIVED receipt is created. No callback could have run, so roll back the
    // provisional membership while retaining fail-closed behavior elsewhere.
    await setUnresolvedMembership(directory, transition.operation_id, false);
  } else {
    await setUnresolvedMembership(directory, transition.operation_id, !isTerminal(receipt.state));
  }
  await removeUnresolvedTransition(directory);
}

async function persistIndexedTransition(
  directory: string,
  operationId: string,
  targetState: OperationJournalState,
  writeReceipt: () => Promise<void>
): Promise<void> {
  const transition: UnresolvedOperationTransition = {
    version: UNRESOLVED_INDEX_VERSION,
    operation_id: operationId,
    target_state: targetState,
    created_at: new Date().toISOString(),
  };
  await createDurableText(unresolvedTransitionPath(directory), `${JSON.stringify(transition)}\n`);
  try {
    // Add before a non-terminal receipt can become durable; remove only after
    // a terminal receipt is durable. A crash can therefore create a harmless
    // false-positive barrier, never a missing unresolved effect.
    if (!isTerminal(targetState)) await setUnresolvedMembership(directory, operationId, true);
    await writeReceipt();
    if (isTerminal(targetState)) await setUnresolvedMembership(directory, operationId, false);
    await removeUnresolvedTransition(directory);
  } catch (error) {
    await recoverUnresolvedTransition(directory).catch(() => undefined);
    throw error;
  }
}

async function readOptionalText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  }
}

async function createDurableText(file: string, text: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new JournalFailure("OPERATION_UNRESOLVED_INDEX_BUSY");
    }
    throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  }
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function atomicReplaceText(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function removeUnresolvedTransition(directory: string): Promise<void> {
  await fs.rm(unresolvedTransitionPath(directory), { force: true });
  await syncDirectory(directory);
}

// A terminal receipt protects against a retried request re-running its side
// effect. ChatGPT retries arrive within minutes, and Goal-less identities embed
// the per-call transport session, so receipts finished more than a week ago
// (or more than an hour ago once a directory is large) protect nothing. Keeping
// them forever filled the journal: after 16,384 calls every mutating tool was
// refused with OPERATION_JOURNAL_CAPACITY_EXHAUSTED, and each admission
// stat()ed every receipt. Unresolved receipts are never pruned.
const RECEIPT_NAME_RE = /^operation-[a-f0-9]{64}\.json$/i;
const PRUNE_TRIGGER_ENTRIES = 1_024;
const PRUNE_TARGET_ENTRIES = 512;
const PRUNE_COOLDOWN_MS = 60_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_MIN_RETENTION_MS = 60 * 60 * 1000;
const lastPruneAt = new Map<string, number>();

async function receiptUsage(directory: string, names: readonly string[]): Promise<{ entries: number; totalBytes: number }> {
  let entries = 0;
  let totalBytes = 0;
  for (const name of names) {
    if (!RECEIPT_NAME_RE.test(name)) continue;
    const file = path.join(directory, name);
    const stat = await fs.stat(file).catch(() => {
      throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
    });
    if (!stat.isFile()) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    // The target receipt was parsed and identity-checked by the caller.  For
    // unrelated receipts use stat-only accounting so admission remains O(n)
    // filesystem metadata work rather than reparsing every receipt on every
    // mutation.  A corrupt target is still fail-closed through readReceipt;
    // receipts become unreachable only under their own opaque identity hash.
    entries++;
    totalBytes += stat.size;
  }
  return { entries, totalBytes };
}

/** Delete expired terminal receipts, then the oldest ones over an hour old while above the target size. */
async function pruneTerminalReceipts(directory: string, names: readonly string[], keepName: string, limits: JournalLimits): Promise<number> {
  const now = Date.now();
  const candidates: { file: string; finished: number }[] = [];
  let receipts = 0;
  for (const name of names) {
    if (!RECEIPT_NAME_RE.test(name)) continue;
    receipts++;
    if (name === keepName) continue;
    const file = path.join(directory, name);
    // Unreadable receipts stay (fail closed); so does any identity being worked on.
    const receipt = await readReceipt(file).catch(() => null);
    if (!receipt || !isTerminal(receipt.state)) continue;
    const finished = Date.parse(receipt.finished_at ?? receipt.started_at ?? receipt.accepted_at ?? receipt.created_at);
    if (!Number.isFinite(finished) || now - finished < TERMINAL_MIN_RETENTION_MS) continue;
    if (fsSync.existsSync(file.replace(/\.json$/i, ".lock"))) continue;
    candidates.push({ file, finished });
  }
  candidates.sort((a, b) => a.finished - b.finished);
  let excess = receipts - Math.max(1, Math.min(PRUNE_TARGET_ENTRIES, Math.floor(limits.maxEntries / 2)));
  let removed = 0;
  for (const candidate of candidates) {
    if (now - candidate.finished < TERMINAL_RETENTION_MS && excess <= 0) break;
    try { await fs.rm(candidate.file, { force: true }); } catch { continue; }
    removed++;
    excess--;
  }
  return removed;
}

async function assertCapacity(directory: string, target: string, next: OperationReceipt): Promise<void> {
  const limits = journalLimits();
  let names = await fs.readdir(directory);
  let { entries, totalBytes } = await receiptUsage(directory, names);
  const nearLimit = entries >= limits.maxEntries * 0.9 || totalBytes >= limits.maxBytes * 0.9;
  const large = entries >= Math.min(PRUNE_TRIGGER_ENTRIES, limits.maxEntries) || totalBytes >= limits.maxBytes / 2;
  if (large && (nearLimit || Date.now() - (lastPruneAt.get(directory) ?? 0) >= PRUNE_COOLDOWN_MS)) {
    lastPruneAt.set(directory, Date.now());
    if (await pruneTerminalReceipts(directory, names, path.basename(target), limits) > 0) {
      names = await fs.readdir(directory);
      ({ entries, totalBytes } = await receiptUsage(directory, names));
    }
  }
  const serialized = serializeReceipt(next);
  const nextBytes = Buffer.byteLength(serialized, "utf8");
  if (nextBytes > limits.maxReceiptBytes) throw new JournalFailure("OPERATION_JOURNAL_CAPACITY_EXHAUSTED");
  const targetExists = names.includes(path.basename(target));
  if (!targetExists && entries >= limits.maxEntries) throw new JournalFailure("OPERATION_JOURNAL_CAPACITY_EXHAUSTED");
  const targetStat = targetExists ? await fs.stat(target).catch(() => null) : null;
  const projected = totalBytes - (targetStat?.size ?? 0) + nextBytes;
  if (projected > limits.maxBytes) throw new JournalFailure("OPERATION_JOURNAL_CAPACITY_EXHAUSTED");
}

function serializeReceipt(receipt: OperationReceipt): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  }
  if (typeof serialized !== "string") throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
  return `${serialized}\n`;
}

async function createReceipt(file: string, receipt: OperationReceipt): Promise<void> {
  const serialized = serializeReceipt(receipt);
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}

async function atomicReplaceReceipt(file: string, receipt: OperationReceipt): Promise<void> {
  const serialized = serializeReceipt(receipt);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // fs.rename is the atomic replacement primitive on both supported
    // platforms.  In particular, do not move the old receipt to a backup on
    // Windows: a crash during a backup dance could make an executing receipt
    // disappear and permit an unsafe re-execution after restart.  If the
    // platform rejects replacement, leave the old receipt in place and fail
    // closed.
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Windows does not support opening a directory as a syncable file. The
    // receipt file itself was fsynced before rename, which is the strongest
    // portable guarantee available there.
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || !["EISDIR", "EINVAL", "ENOTSUP", "EPERM", "EACCES"].includes(code || "")) {
      throw new JournalFailure("OPERATION_JOURNAL_FSYNC_FAILED");
    }
  }
}

async function withCapacityLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const lockPath = path.join(directory, ".capacity.lock");
  const lock = await openLockWaiting(lockPath, true, journalLimits().observeWaitMs);
  if (!lock) throw new JournalFailure("OPERATION_JOURNAL_BUSY");
  try {
    return await action();
  } finally {
    await releaseLock(lock);
  }
}

async function tryOpenLock(file: string, reclaimDeadOwner: boolean): Promise<HeldLock | null> {
  const token = randomUUID();
  let handle: FileHandle;
  try {
    handle = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (reclaimDeadOwner) {
        if (!await reclaimDeadLock(file)) return null;
        try {
          handle = await fs.open(file, "wx", 0o600);
        } catch (retryError) {
          if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return null;
          throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
        }
      } else {
        return null;
      }
    } else {
      throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }) + "\n", "utf8");
    await handle.sync();
  } catch {
    await handle.close().catch(() => undefined);
    throw new JournalFailure("OPERATION_JOURNAL_FSYNC_FAILED");
  }
  return { file: handle, path: file, token };
}

async function openLockWaiting(file: string, reclaimDeadOwner: boolean, waitMs: number): Promise<HeldLock | null> {
  const deadline = Date.now() + waitMs;
  while (true) {
    const lock = await tryOpenLock(file, reclaimDeadOwner);
    if (lock) return lock;
    if (waitMs <= 0 || Date.now() >= deadline) return null;
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
}

async function readLockOwner(file: string): Promise<LockOwner | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!Number.isInteger(parsed.pid) || Number(parsed.pid) <= 0 || typeof parsed.token !== "string" || parsed.token.length < 8) return null;
    return { pid: Number(parsed.pid), token: parsed.token };
  } catch {
    return null;
  }
}

async function removeLock(file: string): Promise<void> {
  await fs.rm(file, { force: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  });
}

/**
 * Serialize stale-lock recovery with a marker that is itself exclusive. The
 * marker is removed only after a successful, completed reaper. If a reaper
 * process crashes, its marker remains and future callers fail closed instead
 * of racing to unlink a lock that may have already been replaced.
 */
async function reclaimDeadLock(file: string): Promise<boolean> {
  const markerPath = `${file}.reaper`;
  const token = randomUUID();
  let marker: FileHandle;
  try {
    marker = await fs.open(markerPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  }

  let finished = false;
  try {
    try {
      await marker.writeFile(JSON.stringify({ pid: process.pid, token }) + "\n", "utf8");
      await marker.sync();
    } catch {
      throw new JournalFailure("OPERATION_JOURNAL_FSYNC_FAILED");
    }

    // Read after acquiring the exclusive marker, then read again to ensure
    // that the owner did not change while liveness was being checked.
    const first = await readLockOwner(file);
    if (!first || isProcessAlive(first.pid)) {
      finished = true;
      return false;
    }
    const second = await readLockOwner(file);
    if (!second || second.pid !== first.pid || second.token !== first.token || isProcessAlive(second.pid)) {
      finished = true;
      return false;
    }
    await removeLock(file);
    finished = true;
    return true;
  } finally {
    await marker.close().catch(() => undefined);
    if (finished) await fs.rm(markerPath, { force: true }).catch(() => undefined);
  }
}

async function lockExists(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new JournalFailure("OPERATION_JOURNAL_CORRUPT");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof JournalFailure) throw error;
    throw new JournalFailure("OPERATION_JOURNAL_UNAVAILABLE");
  }
}

async function releaseLock(lock: HeldLock): Promise<void> {
  await lock.file.close().catch(() => undefined);
  const owner = await readLockOwner(lock.path).catch(() => null);
  if (owner?.token === lock.token) await removeLock(lock.path).catch(() => undefined);
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return true;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof JournalFailure ? error.code : fallback;
}
