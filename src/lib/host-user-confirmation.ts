import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { getRuntimeScope } from "./runtime-scope.js";
import {
  claimPasskeyApprovalOnce, verifyPasskeyApprovalAssertion,
  type PasskeyApprovalRequest, type PasskeyCredential, type PasskeyAssertion,
} from "./passkey-approval.js";

/**
 * A1.1 HOST CONFIRMATION BOUNDARY — source-only, NOT an integrated ChatGPT Host.
 *
 * ChatGPT tool arguments, _meta, MCP session IDs, JSON Goal files and a model's
 * paraphrase of the user are not a proof that the user approved an action.
 *
 * A future, independently trusted Host-side adapter may call
 * runWithVerifiedHostUserTurn(receipt, operation) AFTER receiving an authentic
 * user-turn receipt outside model-controlled tool arguments. The only trust
 * anchor is an operator-pinned Ed25519 public key; no signing key is supplied
 * to or generated in the running server. Without an actual issuer and adapter,
 * human confirmation is fail-closed by default.
 *
 * Tests use an EPHEMERAL key to prove cryptographic mechanics only. That is
 * not evidence of a real ChatGPT Host authorization flow.
 */

interface UserTurnClaim {
  readonly version: 1;
  readonly audience: "web-harness-goal-user-confirmation-v1";
  readonly issuer: "operator-trusted-host-v1";
  readonly goal_id: string;
  readonly goal_revision: number;
  readonly session_id: string;
  readonly criterion: string;
  readonly source_turn_ref: string;
  readonly nonce: string;
  readonly issued_at_ms: number;
  readonly expires_at_ms: number;
}

interface VerifiedTurnScope {
  readonly claim: Pick<UserTurnClaim, "session_id" | "goal_id" | "goal_revision" | "criterion" | "expires_at_ms">;
  readonly sourceTurnDigest: string;
  readonly receiptDigest: string;
  readonly sourceVerification: "operator_pinned_signature_v1" | "webauthn_uv_v1";
  consumed: boolean;
}

const scopeStorage = new AsyncLocalStorage<VerifiedTurnScope>();
const EXACT_CLAIM_KEYS = [
  "audience", "criterion", "expires_at_ms", "goal_id", "goal_revision",
  "issued_at_ms", "issuer", "nonce", "session_id", "source_turn_ref", "version",
];
const AUDIENCE = "web-harness-goal-user-confirmation-v1";
const MAX_LIFETIME_MS = 120_000;
const CLOCK_SKEW_MS = 15_000;
const KEY_ENV = "HARNESS_HOST_USER_TURN_PUBLIC_KEY_SPKI";

function reject(code: string): never {
  throw new Error(code);
}

function bytesBase64Url(raw: unknown, maxLength: number): Buffer {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > maxLength ||
      !/^[A-Za-z0-9_-]+$/.test(raw)) reject("HOST_USER_TURN_MALFORMED");
  const decoded = Buffer.from(raw, "base64url");
  if (!decoded.length || decoded.toString("base64url") !== raw) reject("HOST_USER_TURN_MALFORMED");
  return decoded;
}

function objectWithExactKeys(raw: unknown, keys: readonly string[]): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) &&
    JSON.stringify(Object.keys(raw).sort()) === JSON.stringify([...keys].sort());
}

function parseAndVerify(receipt: unknown): VerifiedTurnScope {
  if (!objectWithExactKeys(receipt, ["body_base64url", "signature_base64url"])) {
    reject("HOST_USER_TURN_MALFORMED");
  }
  const body = bytesBase64Url(receipt.body_base64url, 4096);
  const signature = bytesBase64Url(receipt.signature_base64url, 256);
  if (signature.length !== 64) reject("HOST_USER_TURN_MALFORMED");
  const pinned = process.env[KEY_ENV];
  if (!pinned) reject("HOST_USER_TURN_TRUST_ANCHOR_MISSING");
  const keyBytes = bytesBase64Url(pinned, 1024);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  } catch {
    reject("HOST_USER_TURN_TRUST_ANCHOR_INVALID");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") reject("HOST_USER_TURN_TRUST_ANCHOR_INVALID");
  if (!verifySignature(null, body, publicKey, signature)) reject("HOST_USER_TURN_BAD_SIGNATURE");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    reject("HOST_USER_TURN_MALFORMED");
  }
  if (!objectWithExactKeys(parsed, EXACT_CLAIM_KEYS)) reject("HOST_USER_TURN_MALFORMED");
  const claim = parsed as unknown as UserTurnClaim;
  if (claim.version !== 1 || claim.audience !== AUDIENCE ||
      claim.issuer !== "operator-trusted-host-v1" ||
      typeof claim.goal_id !== "string" || !/^[a-f0-9-]{36}$/i.test(claim.goal_id) ||
      !Number.isSafeInteger(claim.goal_revision) || claim.goal_revision < 1 ||
      typeof claim.session_id !== "string" || claim.session_id.length < 1 || claim.session_id.length > 512 ||
      typeof claim.criterion !== "string" || !claim.criterion.trim() || claim.criterion.length > 300 ||
      typeof claim.source_turn_ref !== "string" ||
      !/^[A-Za-z0-9._:/-]{12,256}$/.test(claim.source_turn_ref) ||
      typeof claim.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claim.nonce) ||
      !Number.isSafeInteger(claim.issued_at_ms) || !Number.isSafeInteger(claim.expires_at_ms)) {
    reject("HOST_USER_TURN_MALFORMED");
  }
  const now = Date.now();
  if (claim.expires_at_ms <= claim.issued_at_ms ||
      claim.expires_at_ms - claim.issued_at_ms > MAX_LIFETIME_MS ||
      claim.issued_at_ms > now + CLOCK_SKEW_MS ||
      claim.expires_at_ms <= now) {
    reject("HOST_USER_TURN_EXPIRED");
  }
  return {
    claim,
    sourceTurnDigest: createHash("sha256").update(claim.source_turn_ref).digest("hex"),
    receiptDigest: createHash("sha256").update(body).digest("hex"),
    sourceVerification: "operator_pinned_signature_v1",
    consumed: false,
  };
}

/**
 * Privileged native boundary. Do not call this with receipt fields copied from
 * a ChatGPT tool argument. Only trusted server-side Host message capture may
 * supply signed receipt bytes, and the process must pin the real issuer key.
 */
export function runWithVerifiedHostUserTurn<T>(receipt: unknown, operation: () => T): T {
  const scope = getRuntimeScope();
  if (!scope?.mcpSessionId) reject("HOST_USER_TURN_SESSION_REQUIRED");
  const verified = parseAndVerify(receipt);
  if (verified.claim.session_id !== scope.mcpSessionId) reject("HOST_USER_TURN_SCOPE_MISMATCH");
  return scopeStorage.run(verified, operation);
}

/**
 * Out-of-band human consent for products whose ChatGPT Host exposes no signed
 * user-turn ingress. An operator-pinned WebAuthn credential (not a tool input)
 * must sign the exact server-issued pending Goal action; the durable request
 * is claimed BEFORE the Goal mutation, blocking replay across processes.
 *
 * This proves passkey-controlled approval of this action, not that ChatGPT
 * itself authored or signed the original user message.
 */
export async function runWithVerifiedPasskeyUserApproval<T>(
  storeDir: string,
  pending: PasskeyApprovalRequest,
  pinned: PasskeyCredential,
  assertion: PasskeyAssertion,
  operation: () => T
): Promise<T> {
  const scope = getRuntimeScope();
  if (!scope?.mcpSessionId || scope.mcpSessionId !== pending.owner_session ||
      !scope.workspaceRoot) reject("PASSKEY_SCOPE_MISMATCH");
  const proof = verifyPasskeyApprovalAssertion(pending, pinned, assertion);
  await claimPasskeyApprovalOnce(storeDir, pending);
  return scopeStorage.run({
    claim: {
      session_id: pending.owner_session, goal_id: pending.goal_id,
      goal_revision: pending.goal_revision, criterion: pending.criterion,
      expires_at_ms: pending.expires_at_ms,
    },
    sourceTurnDigest: proof.source_turn_sha256,
    receiptDigest: proof.receipt_sha256,
    sourceVerification: "webauthn_uv_v1",
    consumed: false,
  }, operation);
}

export interface VerifiedUserConfirmation {
  readonly source_verification: "operator_pinned_signature_v1" | "webauthn_uv_v1";
  readonly source_turn_sha256: string;
  readonly receipt_sha256: string;
}

/** Check immediately before any user_confirmed write, not at tool ingress. */
export function requireVerifiedHostUserConfirmation(
  goal: { readonly id: string; readonly revision: number; readonly owner_session?: string },
  criterion: string
): VerifiedUserConfirmation {
  const verified = scopeStorage.getStore();
  if (!verified) reject("HOST_USER_TURN_REQUIRED");
  if (verified.consumed) reject("HOST_USER_TURN_ALREADY_USED");
  const currentSession = getRuntimeScope()?.mcpSessionId;
  const claim = verified.claim;
  if (!currentSession || claim.session_id !== currentSession ||
      (goal.owner_session && goal.owner_session !== currentSession) ||
      claim.goal_id !== goal.id || claim.goal_revision !== goal.revision ||
      claim.criterion !== criterion) {
    reject("HOST_USER_TURN_SCOPE_MISMATCH");
  }
  if (claim.expires_at_ms <= Date.now()) reject("HOST_USER_TURN_EXPIRED");
  verified.consumed = true;
  return {
    source_verification: verified.sourceVerification,
    source_turn_sha256: verified.sourceTurnDigest,
    receipt_sha256: verified.receiptDigest,
  };
}
