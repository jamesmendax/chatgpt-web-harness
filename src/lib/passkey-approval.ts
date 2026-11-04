import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";

/**
 * A1.1 alternate, out-of-band user consent. This is not a ChatGPT Host event.
 * A verified WebAuthn assertion binds a browser-origin user gesture to one
 * server-issued Goal/criterion/revision/session challenge.
 *
 * Trust prerequisites (never inferred from tool args):
 * - The operator has independently enrolled and pinned the user's credential.
 * - The pinned credential config cannot be replaced by a tool/model principal.
 * - The authenticator actually implements UP/UV (attestation policy is separate).
 */

export interface PasskeyCredential {
  schema_version: 1;
  credential_id: string;
  public_key_spki_base64url: string;
  rp_id: "localhost";
  origin: string;
}
export interface PasskeyApprovalRequest {
  schema_version: 1;
  request_id: string;
  challenge_base64url: string;
  goal_id: string;
  goal_revision: number;
  owner_session: string;
  criterion: string;
  goal_objective: string;
  credential_id: string;
  credential_spki_sha256: string;
  created_at_ms: number;
  expires_at_ms: number;
}
export interface PasskeyAssertion {
  id: string;
  type: "public-key";
  client_data_json_base64url: string;
  authenticator_data_base64url: string;
  signature_base64url: string;
}
export interface VerifiedPasskeyAssertion {
  source_turn_sha256: string;
  receipt_sha256: string;
  sign_count: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = (input: Buffer | string) => createHash("sha256").update(input).digest();
const LIFE_MS = 120_000;
function deny(code: string): never { throw new Error(code); }
function decode(value: unknown, maxChars = 8192): Buffer {
  if (typeof value !== "string" || !value || value.length > maxChars ||
      !/^[A-Za-z0-9_-]+$/.test(value)) deny("PASSKEY_FORMAT_INVALID");
  const b = Buffer.from(value, "base64url");
  if (!b.length || b.toString("base64url") !== value) deny("PASSKEY_FORMAT_INVALID");
  return b;
}
function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "localhost" &&
      url.port.length > 0 && !url.username && !url.password &&
      !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}
export function validatePinnedCredential(raw: unknown): PasskeyCredential {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) deny("PASSKEY_TRUST_ANCHOR_INVALID");
  const c = raw as Record<string, unknown>;
  if (c.schema_version !== 1 || typeof c.credential_id !== "string" ||
      typeof c.public_key_spki_base64url !== "string" ||
      c.rp_id !== "localhost" || typeof c.origin !== "string" || !validOrigin(c.origin)) {
    deny("PASSKEY_TRUST_ANCHOR_INVALID");
  }
  const id = decode(c.credential_id, 512);
  const spki = decode(c.public_key_spki_base64url, 2048);
  if (id.length < 16 || id.length > 256) deny("PASSKEY_TRUST_ANCHOR_INVALID");
  try {
    const key = createPublicKey({ key: spki, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      deny("PASSKEY_TRUST_ANCHOR_INVALID");
    }
  } catch { deny("PASSKEY_TRUST_ANCHOR_INVALID"); }
  return raw as PasskeyCredential;
}

function requestFile(storeDir: string, id: string): string {
  if (!UUID.test(id)) deny("PASSKEY_REQUEST_INVALID");
  return path.join(storeDir, "requests", id + ".json");
}
async function durableCreate(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(content, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
export async function issuePasskeyApprovalRequest(
  storeDir: string,
  goal: {id:string;revision:number;objective:string;status:string;owner_session?:string},
  criterion: string,
  pinned: PasskeyCredential,
): Promise<PasskeyApprovalRequest> {
  validatePinnedCredential(pinned);
  if (goal.status !== "active" || !goal.owner_session ||
      typeof criterion !== "string" || !criterion.trim() || criterion.length > 300 ||
      !Number.isSafeInteger(goal.revision) || goal.revision < 1) deny("PASSKEY_GOAL_NOT_ELIGIBLE");
  const now=Date.now();
  const request: PasskeyApprovalRequest = {
    schema_version:1, request_id:randomUUID(), challenge_base64url:randomBytes(32).toString("base64url"),
    goal_id:goal.id, goal_revision:goal.revision, owner_session:goal.owner_session,
    criterion, goal_objective:goal.objective.slice(0,4000), credential_id:pinned.credential_id,
    credential_spki_sha256:DIGEST(decode(pinned.public_key_spki_base64url,2048)).toString("hex"),
    created_at_ms:now,expires_at_ms:now+LIFE_MS,
  };
  await durableCreate(requestFile(storeDir,request.request_id),JSON.stringify(request)+"\n");
  return request;
}
export async function readPasskeyApprovalRequest(storeDir:string,id:string): Promise<PasskeyApprovalRequest> {
  let raw: unknown;
  try { raw=JSON.parse(await fs.readFile(requestFile(storeDir,id),"utf8")); }
  catch { deny("PASSKEY_REQUEST_NOT_FOUND"); }
  const r=raw as PasskeyApprovalRequest;
  if (!r || r.schema_version!==1 || r.request_id!==id || !UUID.test(r.goal_id) ||
      !Number.isSafeInteger(r.goal_revision) || r.goal_revision<1 ||
      typeof r.owner_session!=="string" || !r.owner_session ||
      typeof r.criterion!=="string" || !r.criterion ||
      typeof r.credential_id!=="string" ||
      typeof r.credential_spki_sha256!=="string" ||
      !/^[a-f0-9]{64}$/.test(r.credential_spki_sha256) ||
      typeof r.goal_objective!=="string" ||
      !Number.isSafeInteger(r.created_at_ms) || !Number.isSafeInteger(r.expires_at_ms) ||
      decode(r.challenge_base64url,128).length!==32 || r.expires_at_ms-r.created_at_ms!==LIFE_MS) {
    deny("PASSKEY_REQUEST_INVALID");
  }
  return r;
}
export function verifyPasskeyApprovalAssertion(
  request: PasskeyApprovalRequest, pinned: PasskeyCredential, raw: unknown
): VerifiedPasskeyAssertion {
  validatePinnedCredential(pinned);
  if (Date.now()>=request.expires_at_ms || Date.now()<request.created_at_ms-15000) deny("PASSKEY_REQUEST_EXPIRED");
  if (request.credential_id!==pinned.credential_id ||
      request.credential_spki_sha256!==DIGEST(decode(pinned.public_key_spki_base64url,2048)).toString("hex")) {
    deny("PASSKEY_CREDENTIAL_MISMATCH");
  }
  if (!raw || typeof raw!=="object" || Array.isArray(raw)) deny("PASSKEY_ASSERTION_INVALID");
  const assertion=raw as Partial<PasskeyAssertion>;
  if (assertion.type!=="public-key" || assertion.id!==pinned.credential_id) deny("PASSKEY_CREDENTIAL_MISMATCH");
  const clientData=decode(assertion.client_data_json_base64url,8192);
  const authData=decode(assertion.authenticator_data_base64url,4096);
  const signature=decode(assertion.signature_base64url,2048);
  if (authData.length<37 || authData.length>2048) deny("PASSKEY_ASSERTION_INVALID");
  let client: Record<string,unknown>;
  try { client=JSON.parse(clientData.toString("utf8")); }
  catch { deny("PASSKEY_ASSERTION_INVALID"); }
  if (!client || typeof client!=="object" || client.type!=="webauthn.get" ||
      client.challenge!==request.challenge_base64url || client.origin!==pinned.origin ||
      (client.crossOrigin!==undefined && client.crossOrigin!==false) ||
      client.topOrigin!==undefined) deny("PASSKEY_ORIGIN_OR_CHALLENGE_MISMATCH");
  if (!timingSafeEqual(authData.subarray(0,32),DIGEST(pinned.rp_id))) deny("PASSKEY_RP_MISMATCH");
  const flags=authData[32];
  if ((flags&0x22)!==0) deny("PASSKEY_ASSERTION_INVALID"); // WebAuthn RFU bits 1 and 5
  if ((flags&0x01)===0 || (flags&0x04)===0) deny("PASSKEY_USER_VERIFICATION_REQUIRED");
  // Multi-device passkeys may legitimately set BE/BS. BS implies BE.
  if ((flags&0x10)!==0 && (flags&0x08)===0) {
    deny("PASSKEY_ASSERTION_INVALID");
  }
  if ((flags&0x40)!==0) deny("PASSKEY_ASSERTION_INVALID"); // no attestedCredentialData in assertions
  const key=createPublicKey({key:decode(pinned.public_key_spki_base64url,2048),format:"der",type:"spki"});
  const payload=Buffer.concat([authData,DIGEST(clientData)]);
  if (!verify("sha256",payload,key,signature)) deny("PASSKEY_SIGNATURE_INVALID");
  return {
    source_turn_sha256:DIGEST("passkey-out-of-band:"+request.request_id).toString("hex"),
    receipt_sha256:DIGEST(Buffer.concat([clientData,authData,signature])).toString("hex"),
    sign_count:authData.readUInt32BE(33),
  };
}

/** Claim before Goal commit. If the host crashes, require a fresh user gesture. */
export async function claimPasskeyApprovalOnce(storeDir:string,request:PasskeyApprovalRequest): Promise<void> {
  try {
    await durableCreate(path.join(storeDir,"consumed",request.request_id+".json"),
      JSON.stringify({request_id:request.request_id,goal_id:request.goal_id,
        revision:request.goal_revision,consumed_at:new Date().toISOString()})+"\n");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code==="EEXIST") deny("PASSKEY_APPROVAL_ALREADY_CONSUMED");
    throw e;
  }
}
