import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readAcceptedExecutionContractState } from "./execution-contract.js";
import { getRuntimeScope, type RuntimeScope } from "./runtime-scope.js";
import { validatePath } from "./path-security.js";
import { inspectOperation, listUnresolvedOperationInspections } from "./operation-journal.js";
import type { ToolSource } from "./effective-tool-registry.js";

/**
 * RI v1 is deliberately NOT a general authorization framework. It is an
 * opt-in, isolated MCP write slice. Do not enable in a shared runtime until
 * Admin, Companion, internal effects and dynamic providers are closed.
 */
const STRICT_MODE = "scoped_write_v1";
const MAX_GRANT_LIFETIME_MS = 5 * 60_000;
const READ_ONLY_NATIVE = new Set([
  "read_text_file", "read_file_base64", "file_info", "list_directory",
  "glob", "grep", "search_files", "project_context", "load_path_rules",
]);
const SHA256 = /^[0-9a-f]{64}$/;
/** Per-invocation floor: disabling the process mode cannot downgrade an admitted call. */
const strictAdmittedScopes = new WeakSet<RuntimeScope>();
const scopedPermits = new WeakMap<RuntimeScope, RecoveryWritePermit>();
const KEYS = [
  "version", "operation_id", "operator_ref", "workspace_root", "session_id",
  "head_sha256", "snapshot_revision", "intent_revision", "contract_hash",
  "target_path", "content_sha256", "expected_sha256", "create_only",
  "issued_at", "expires_at",
] as const;

export interface RecoveryWriteInput {
  readonly path: string;
  readonly content: string;
  readonly expected_sha256?: string;
  readonly create_only?: boolean;
}

export interface RecoveryWriteGrant {
  readonly version: 1;
  readonly operation_id: string;
  /** Operator-side decision locator. The signature does not prove a Host ID. */
  readonly operator_ref: string;
  readonly workspace_root: string;
  readonly session_id: string;
  readonly head_sha256: string;
  readonly snapshot_revision: number;
  readonly intent_revision: number;
  readonly contract_hash: string;
  readonly target_path: string;
  readonly content_sha256: string;
  readonly expected_sha256: string | null;
  readonly create_only: boolean;
  readonly issued_at: string;
  readonly expires_at: string;
}

interface SignedRecoveryWriteGrant {
  readonly grant: RecoveryWriteGrant;
  readonly hmac_sha256: string;
}

/** Operator-signed authorization evidence, NOT a verified Host user-message ID. */
export interface RecoveryOperatorAttestation {
  readonly version: 1;
  readonly source_kind: "operator_attested";
  readonly evidence_ref: string;
  readonly operator_ref: string;
  readonly grant_sha256: string;
  readonly decision: "approved";
  readonly approved_at: string;
}
interface SignedRecoveryOperatorAttestation {
  readonly attestation: RecoveryOperatorAttestation;
  readonly hmac_sha256: string;
}
export interface RecoveryWritePermit {
  readonly operationId: string;
  readonly identity: string;
  readonly grantHash: string;
}

const digest = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
function denied(reason: string): never {
  throw new Error(`RI_BLOCKED: ${reason}`);
}
function samePath(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function inside(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Resolve symlinks and Windows junctions even when the final file is absent. */
async function canonicalPhysicalPath(file: string): Promise<string> {
  let current = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") denied("canonical path cannot be verified");
      const parent = path.dirname(current);
      if (parent === current) denied("canonical path has no existing ancestor");
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
function validateConfiguredMode(): boolean {
  const mode = process.env.HARNESS_RECOVERY_SCOPE_MODE;
  if (!mode || mode === "off") return false;
  if (mode !== STRICT_MODE || process.env.HARNESS_RECOVERY_ISOLATED !== "1") {
    denied("strict-mode configuration invalid or isolation flag missing");
  }
  return true;
}
// Legacy RI configuration is historical metadata, not an execution gate.
export function recoveryStrictEnabled(): boolean { return false; }
export function recoveryToolMayRegister(_name: string, _source: ToolSource): boolean { return true; }
function signingKey(): Buffer {
  const encoded = process.env.HARNESS_RECOVERY_HMAC_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) denied("operator key is missing");
  const key = Buffer.from(encoded, "base64url");
  if (key.length < 32 || key.toString("base64url") !== encoded) denied("operator key is invalid");
  return key;
}

/** Only for trusted operator-side provisioning and isolated test fixtures. */
export function signRecoveryWriteGrant(grant: RecoveryWriteGrant, key: Buffer): SignedRecoveryWriteGrant {
  if (key.length < 32) throw new Error("RI_INVALID_SIGNING_KEY");
  return { grant, hmac_sha256: createHmac("sha256", key).update(JSON.stringify(grant)).digest("hex") };
}
/** Operator-side issuance only; an attestation does not assert Host identity. */
export function signRecoveryOperatorAttestation(
  attestation: RecoveryOperatorAttestation, key: Buffer
): SignedRecoveryOperatorAttestation {
  if (key.length < 32) throw new Error("RI_INVALID_SIGNING_KEY");
  return {
    attestation,
    hmac_sha256: createHmac("sha256", key).update(JSON.stringify(attestation)).digest("hex"),
  };
}

function exactlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const entries = Object.keys(value);
  return entries.length === keys.length && entries.every((entry) => keys.includes(entry));
}
function grantShape(value: unknown): value is RecoveryWriteGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  return exactlyKeys(g, KEYS) &&
    g.version === 1 &&
    typeof g.operation_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(g.operation_id) &&
    typeof g.operator_ref === "string" && g.operator_ref.length >= 6 && g.operator_ref.length <= 256 &&
    typeof g.workspace_root === "string" && path.isAbsolute(g.workspace_root) &&
    typeof g.session_id === "string" && g.session_id.length > 0 &&
    typeof g.head_sha256 === "string" && SHA256.test(g.head_sha256) &&
    Number.isSafeInteger(g.snapshot_revision) && Number(g.snapshot_revision) >= 1 &&
    Number.isSafeInteger(g.intent_revision) && Number(g.intent_revision) >= 1 &&
    typeof g.contract_hash === "string" && SHA256.test(g.contract_hash) &&
    typeof g.target_path === "string" && path.isAbsolute(g.target_path) &&
    typeof g.content_sha256 === "string" && SHA256.test(g.content_sha256) &&
    (g.expected_sha256 === null || (typeof g.expected_sha256 === "string" && SHA256.test(g.expected_sha256))) &&
    typeof g.create_only === "boolean" &&
    typeof g.issued_at === "string" && typeof g.expires_at === "string";
}

async function loadSignedGrant(workspaceRoot: string): Promise<RecoveryWriteGrant> {
  const policyPath = process.env.HARNESS_RECOVERY_GRANT_FILE;
  const headPath = process.env.HARNESS_RECOVERY_HEAD_PATH;
  if (!policyPath || !headPath || !path.isAbsolute(policyPath) || !path.isAbsolute(headPath)) {
    denied("operator-controlled grant or current-head path is missing");
  }
  // Neither the signed grant nor the authoritative head may be changed by
  // the only write capability exposed in the strict profile.
  const [physicalRoot, physicalPolicy, physicalHead] = await Promise.all([
    canonicalPhysicalPath(workspaceRoot),
    canonicalPhysicalPath(policyPath),
    canonicalPhysicalPath(headPath),
  ]);
  if (inside(physicalRoot, physicalPolicy) || inside(physicalRoot, physicalHead) ||
      samePath(physicalRoot, physicalPolicy) || samePath(physicalRoot, physicalHead) ||
      samePath(physicalPolicy, physicalHead)) {
    denied("control files must be outside the permitted workspace");
  }
  let raw: Buffer;
  try {
    const info = await fs.lstat(policyPath);
    if (!info.isFile() || info.size > 16 * 1024) denied("grant is not a bounded regular file");
    raw = await fs.readFile(policyPath);
  } catch { denied("operator grant unavailable"); }
  let signed: unknown;
  try { signed = JSON.parse(raw.toString("utf8")); } catch { denied("invalid operator grant JSON"); }
  if (!signed || typeof signed !== "object" || Array.isArray(signed) ||
      !exactlyKeys(signed as Record<string, unknown>, ["grant", "hmac_sha256"])) {
    denied("invalid grant envelope");
  }
  const value = signed as SignedRecoveryWriteGrant;
  if (!grantShape(value.grant) || !SHA256.test(value.hmac_sha256)) denied("invalid signed grant shape");
  const expected = createHmac("sha256", signingKey()).update(JSON.stringify(value.grant)).digest();
  const provided = Buffer.from(value.hmac_sha256, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) denied("grant signature mismatch");
  return value.grant;
}

async function assertOperatorAttestation(workspaceRoot: string, grant: RecoveryWriteGrant): Promise<void> {
  const receiptPath = process.env.HARNESS_RECOVERY_ATTESTATION_FILE;
  if (!receiptPath || !path.isAbsolute(receiptPath)) denied("trusted operator attestation path missing");
  const [physicalRoot, physicalReceipt] = await Promise.all([
    canonicalPhysicalPath(workspaceRoot), canonicalPhysicalPath(receiptPath),
  ]);
  if (samePath(physicalRoot, physicalReceipt) || inside(physicalRoot, physicalReceipt)) {
    denied("operator evidence must be outside the writable workspace");
  }
  let raw: string;
  try {
    const stat = await fs.lstat(receiptPath);
    if (!stat.isFile() || stat.size > 16 * 1024) denied("operator evidence is not a bounded file");
    raw = await fs.readFile(receiptPath, "utf8");
  } catch { denied("trusted operator evidence is unavailable"); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { denied("invalid operator evidence JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !exactlyKeys(parsed as Record<string, unknown>, ["attestation", "hmac_sha256"])) {
    denied("invalid operator evidence envelope");
  }
  const signed = parsed as SignedRecoveryOperatorAttestation;
  const a = signed.attestation as unknown as Record<string, unknown>;
  if (!a || typeof a !== "object" || Array.isArray(a) ||
      !exactlyKeys(a, ["version", "source_kind", "evidence_ref", "operator_ref", "grant_sha256", "decision", "approved_at"]) ||
      a.version !== 1 || a.source_kind !== "operator_attested" || a.decision !== "approved" ||
      typeof a.evidence_ref !== "string" || !/^[^\x00-\x1f\x7f]{6,512}$/.test(a.evidence_ref) ||
      typeof a.operator_ref !== "string" || a.operator_ref !== grant.operator_ref ||
      a.grant_sha256 !== digest(JSON.stringify(grant)) ||
      typeof a.approved_at !== "string" || !Number.isFinite(Date.parse(a.approved_at)) ||
      Date.parse(a.approved_at) > Date.now() + 30_000 ||
      typeof signed.hmac_sha256 !== "string" || !SHA256.test(signed.hmac_sha256)) {
    denied("operator attestation does not bind this signed action");
  }
  const expected = createHmac("sha256", signingKey()).update(JSON.stringify(signed.attestation)).digest();
  const provided = Buffer.from(signed.hmac_sha256, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    denied("operator attestation signature mismatch");
  }
}

function recoveryIdentity(scope: RuntimeScope, grant: RecoveryWriteGrant): string {
  const workspace = path.resolve(scope.workspaceRoot);
  return digest(JSON.stringify([
    "recovery-scoped-write-v2",
    process.platform === "win32" ? workspace.toLowerCase() : workspace,
    scope.mcpSessionId, grant.operation_id,
  ]));
}

async function assertHeadFresh(grant: RecoveryWriteGrant): Promise<void> {
  const headPath = process.env.HARNESS_RECOVERY_HEAD_PATH!;
  let raw: Buffer;
  try {
    const info = await fs.lstat(headPath);
    if (!info.isFile() || info.size > 1024 * 1024) denied("current head is not a bounded regular file");
    raw = await fs.readFile(headPath);
  } catch { denied("current head unavailable"); }
  if (digest(raw) !== grant.head_sha256) denied("stale snapshot head");
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch { denied("current head is not valid JSON"); }
  if (!parsed || typeof parsed !== "object" || (parsed as Record<string, unknown>).schema_version !== 2 ||
      (parsed as Record<string, unknown>).snapshot_revision !== grant.snapshot_revision) {
    denied("snapshot version mismatch");
  }
}
async function assertScopedWrite(scope: RuntimeScope | undefined, input: RecoveryWriteInput): Promise<RecoveryWriteGrant> {
  if (!scope?.mcpSessionId) denied("trusted session identity unavailable");
  if (!input || typeof input.path !== "string" || typeof input.content !== "string") denied("write arguments invalid");
  const createOnly = input.create_only === true;
  const expectedSha = input.expected_sha256?.toLowerCase() ?? null;
  if ((createOnly && expectedSha !== null) || (!createOnly && !expectedSha) ||
      (expectedSha !== null && !SHA256.test(expectedSha))) {
    denied("single-target write requires exactly one CAS precondition");
  }
  const target = await validatePath(input.path);
  if (!inside(scope.workspaceRoot, target)) denied("target outside the bound workspace");
  const [physicalRoot, physicalTarget] = await Promise.all([
    canonicalPhysicalPath(scope.workspaceRoot),
    canonicalPhysicalPath(target),
  ]);
  if (!inside(physicalRoot, physicalTarget)) denied("resolved target outside the bound workspace");
  const grant = await loadSignedGrant(scope.workspaceRoot);
  const issuedAt = Date.parse(grant.issued_at), expiresAt = Date.parse(grant.expires_at);
  const now = Date.now();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt || expiresAt - issuedAt > MAX_GRANT_LIFETIME_MS ||
      now < issuedAt - 30_000 || now >= expiresAt) denied("expired or not-yet-valid grant");
  if (!samePath(grant.workspace_root, scope.workspaceRoot) ||
      grant.session_id !== scope.mcpSessionId ||
      !samePath(grant.target_path, target) ||
      grant.expected_sha256 !== expectedSha || grant.create_only !== createOnly ||
      grant.content_sha256 !== digest(input.content) ||
      (expectedSha !== null && expectedSha === grant.content_sha256)) {
    denied("grant does not match the exact write");
  }
  await assertHeadFresh(grant);
  const contract = await readAcceptedExecutionContractState(scope.workspaceRoot, scope.mcpSessionId, scope.goalId);
  if (!contract || contract.intent_revision !== grant.intent_revision ||
      contract.requirement_hash !== grant.contract_hash) {
    denied("accepted execution contract changed or unavailable");
  }
  await assertOperatorAttestation(scope.workspaceRoot, grant);
  return grant;
}

/** Invocation prefilter. Tool names and readOnly annotations alone are not effect proof. */
export async function assertRecoveryIngress(
  _name: string, _source: ToolSource, _rawArgs: unknown, _scope: RuntimeScope, _observe = false
): Promise<RecoveryWritePermit | null> { return null; }

export async function assertRecoveryWriteCommit(_input: RecoveryWriteInput): Promise<void> {}
