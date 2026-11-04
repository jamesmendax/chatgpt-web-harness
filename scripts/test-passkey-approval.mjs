import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import {
  validatePinnedCredential, issuePasskeyApprovalRequest,
  readPasskeyApprovalRequest, verifyPasskeyApprovalAssertion,
  claimPasskeyApprovalOnce,
} from "../dist/lib/passkey-approval.js";
import { runWithVerifiedPasskeyUserApproval } from "../dist/lib/host-user-confirmation.js";
import { createGoal, getGoal } from "../dist/lib/goals.js";
import { confirmGoalRunCriterion } from "../dist/lib/goal-run-web.js";
import { readGoalRun } from "../dist/lib/goal-run-store.js";
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"a11-passkey-approval-"));
const envKeys=["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_COMPANION_ENABLED"];
const original=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
const sha=(raw)=>createHash("sha256").update(raw).digest();
const b64=(raw)=>Buffer.from(raw).toString("base64url");
const privateFixture=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
const credentialId=b64(randomBytes(32));
const pinned={
  schema_version:1,credential_id:credentialId,
  public_key_spki_base64url:b64(privateFixture.publicKey.export({type:"spki",format:"der"})),
  rp_id:"localhost",origin:"http://localhost:35993",
};
const proof=(request,override={})=>{
  const authData=Buffer.alloc(37);
  sha("localhost").copy(authData,0);
  authData[32]=override.flags??0x05; // UP+UV; both require a user gesture in the real browser
  authData.writeUInt32BE(3,33);
  if(override.authHash) Buffer.from(override.authHash).copy(authData,0,0,32);
  const clientData=Buffer.from(JSON.stringify({
    type:"webauthn.get",
    challenge:override.challenge??request.challenge_base64url,
    origin:override.origin??pinned.origin,
    crossOrigin:override.crossOrigin??false,
  }));
  const signed=Buffer.concat([authData,sha(clientData)]);
  return {
    id:override.id??pinned.credential_id,type:"public-key",
    client_data_json_base64url:b64(clientData),
    authenticator_data_base64url:b64(authData),
    signature_base64url:b64(sign("sha256",signed,override.signer??privateFixture.privateKey)),
  };
};
const checks=[];
try{
  process.env.CODEX_HOME=path.join(root,"state");
  process.env.GOAL_WATCHDOG_ENABLED="false";
  process.env.HARNESS_RELAY_ENABLED="false";
  process.env.HARNESS_COMPANION_ENABLED="false";
  assert.equal(validatePinnedCredential(pinned).rp_id,"localhost");
  assert.throws(()=>validatePinnedCredential({...pinned,origin:"https://chatgpt.com"}),/PASSKEY_TRUST_ANCHOR_INVALID/);
  assert.throws(()=>validatePinnedCredential({...pinned,rp_id:"evil.site"}),/PASSKEY_TRUST_ANCHOR_INVALID/);
  const ed=generateKeyPairSync("ed25519");
  assert.throws(()=>validatePinnedCredential({...pinned,
    public_key_spki_base64url:b64(ed.publicKey.export({type:"spki",format:"der"}))}),/PASSKEY_TRUST_ANCHOR_INVALID/);
  checks.push("Pinned credential requires ES256/P-256 and an exact local relying-party origin");

  const workspace=path.join(root,"workspace");
  const store=path.join(root,"approval-store");
  await fs.mkdir(workspace,{recursive:true});
  const sessionId="a11-passkey-owner";
  const owner=fn=>runWithRuntimeScope(
    createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId}),fn);
  const created=await owner(()=>createGoal(workspace,{
    objective:"Only passkey-verified human may approve this exact Goal",
    success_criteria:[{name:"Approve shipping to real user",passed:false,requires_confirmation:true}],
  }));
  const pending=await issuePasskeyApprovalRequest(store,created,
    "Approve shipping to real user",pinned);
  assert.equal((await readPasskeyApprovalRequest(store,pending.request_id)).goal_revision,created.revision);
  assert.equal(Buffer.from(pending.challenge_base64url,"base64url").length,32);
  assert.equal(pending.expires_at_ms-pending.created_at_ms,120000);
  checks.push("Server creates a durable one-time random challenge bound to Goal/revision/session/criterion");

  const valid=proof(pending);
  const ok=verifyPasskeyApprovalAssertion(pending,pinned,valid);
  assert.match(ok.source_turn_sha256,/^[a-f0-9]{64}$/);
  assert.equal(ok.sign_count,3);
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{signer:generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey})),/PASSKEY_SIGNATURE_INVALID/);
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{challenge:b64(randomBytes(32))})),/PASSKEY_ORIGIN_OR_CHALLENGE_MISMATCH/);
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{origin:"https://malicious.example"})),/PASSKEY_ORIGIN_OR_CHALLENGE_MISMATCH/);
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{authHash:sha("malicious.example")})),/PASSKEY_RP_MISMATCH/);
  const replacementKey=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,{...pinned,
    public_key_spki_base64url:b64(replacementKey.publicKey.export({type:"spki",format:"der"}))},valid),/PASSKEY_CREDENTIAL_MISMATCH/);
  checks.push("Correct ES256 assertion works; forged key, challenge, browser origin and RP hash are rejected");

  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{flags:0x01})),/PASSKEY_USER_VERIFICATION_REQUIRED/);
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{flags:0x04})),/PASSKEY_USER_VERIFICATION_REQUIRED/);
  assert.equal(verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{flags:0x1d})).sign_count,3,
    "backup-eligible multi-device passkeys are permitted with UV");
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{flags:0x15})),/PASSKEY_ASSERTION_INVALID/);
  assert.throws(()=>verifyPasskeyApprovalAssertion(pending,pinned,proof(pending,{id:b64(randomBytes(32))})),/PASSKEY_CREDENTIAL_MISMATCH/);
  assert.throws(()=>verifyPasskeyApprovalAssertion({...pending,expires_at_ms:Date.now()-1},pinned,valid),/PASSKEY_REQUEST_EXPIRED/);
  checks.push("Presence + user verification required; wrong credential, expired request and invalid backup flags rejected");

  const before=await owner(()=>readGoalRun(workspace,sessionId));
  await assert.rejects(()=>owner(()=>confirmGoalRunCriterion(workspace,{
    criterion:pending.criterion,detail:"User already approved in chat"
  })),/HOST_USER_TURN_REQUIRED/);
  assert.deepEqual((await owner(()=>readGoalRun(workspace,sessionId))).run.typedEvidence,before.run.typedEvidence);
  await assert.rejects(()=>runWithRuntimeScope(
    createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:"other-session"}),
    ()=>runWithVerifiedPasskeyUserApproval(store,pending,pinned,valid,
      ()=>confirmGoalRunCriterion(workspace,{criterion:pending.criterion}))),
    /PASSKEY_SCOPE_MISMATCH/);
  checks.push("Plain model/user-text claims and foreign session cannot confirm the goal");

  const confirmed=await owner(()=>runWithVerifiedPasskeyUserApproval(
    store,pending,pinned,valid,
    ()=>confirmGoalRunCriterion(workspace,{
      criterion:pending.criterion,expectedRevision:pending.goal_revision
    })));
  assert.equal(confirmed.goal.success_criteria[0].passed,true);
  assert.equal(confirmed.goal.intent_provenance?.origin,"unknown","Passkey action consent is not ChatGPT message-origin proof");
  const after=await owner(()=>readGoalRun(workspace,sessionId));
  const evidence=after.run.typedEvidence.filter(e=>e.kind==="user_confirmed");
  assert.equal(evidence.length,1);
  assert.equal(evidence[0].metadata.source_verification,"webauthn_uv_v1");
  assert.equal(JSON.stringify(evidence).includes(pending.challenge_base64url),false);
  checks.push("Verified out-of-band passkey approves only one criterion; provenance remains unknown");

  await assert.rejects(()=>owner(()=>runWithVerifiedPasskeyUserApproval(
    store,pending,pinned,valid,()=>confirmGoalRunCriterion(workspace,{criterion:pending.criterion}))),
    /PASSKEY_APPROVAL_ALREADY_CONSUMED/);
  const consumed=await fs.readFile(path.join(store,"consumed",pending.request_id+".json"),"utf8");
  assert.equal(JSON.parse(consumed).goal_id,created.id);
  checks.push("Durable exclusive-write consumption blocks replay even after prior approval completes");

  const moduleUrl=new URL("../dist/lib/passkey-approval.js",import.meta.url).href;
  const childCode='import {readPasskeyApprovalRequest,claimPasskeyApprovalOnce} from '+JSON.stringify(moduleUrl)+
    ';try{const q=await readPasskeyApprovalRequest(process.env.APPROVAL_TEST_STORE,process.env.APPROVAL_TEST_ID);'+
    'await claimPasskeyApprovalOnce(process.env.APPROVAL_TEST_STORE,q);process.exit(2)'+
    '}catch(e){if(String(e).includes("PASSKEY_APPROVAL_ALREADY_CONSUMED"))process.exit(17);throw e}';
  const child=spawnSync(process.execPath,["--input-type=module","-e",childCode],{
    env:{...process.env,APPROVAL_TEST_STORE:store,APPROVAL_TEST_ID:pending.request_id},
    encoding:"utf8",timeout:8000,
  });
  assert.equal(child.status,17,"fresh process must reject replay: "+child.stderr);
  checks.push("A new process also rejects a previously consumed approval request");

  const nextPending=await issuePasskeyApprovalRequest(store,await owner(()=>getGoal(workspace)),
    "Approve shipping to real user",pinned);
  // A pending challenge is not an authorization until the authenticator signs it.
  await assert.rejects(()=>owner(()=>confirmGoalRunCriterion(workspace,{
    criterion:nextPending.criterion
  })),/HOST_USER_TURN_REQUIRED/);
  checks.push("Merely issuing a challenge never grants or mints confirmation evidence");

  for(const html of ["passkey-approval.html","passkey-enroll.html"]){
    const source=await fs.readFile(new URL("../public/ui/"+html,import.meta.url),"utf8");
    const script=source.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(script,html+" must include a working browser script");
    new vm.Script(script[1],{filename:html});
    assert.match(source,/navigator\.credentials\.(?:get|create)/);
  }
  checks.push("Both human-facing WebAuthn pages have syntactically valid scripts");

  console.log(`A1.1 passkey consent boundary PASS: ${checks.length} groups (software simulated signer; real Windows Hello NOT_RUN)`);
  for(const c of checks)console.log("  PASS",c);
}finally{
  for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await fs.rm(root,{recursive:true,force:true});
}
