import assert from "node:assert/strict";
import { generateKeyPairSync, createHash, randomBytes, sign } from "node:crypto";
import fs from "node:fs/promises";
import vm from "node:vm";
import { startPasskeyPreview } from "./passkey-preview-server.mjs";

const hash=b=>createHash("sha256").update(b).digest();
const b64=b=>Buffer.from(b).toString("base64url");
const key=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
let preview;
const checks=[];
try {
  preview=await startPasskeyPreview({port:0});
  const root=preview.origin;
  const fetchApi=async(route,body,origin=root)=>{
    const uri=new URL(route,root);
    const response=await fetch(uri,{method:body===undefined?"GET":"POST",
      headers:{"Origin":origin,"Content-Type":"application/json"},
      body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,data:await response.json()};
  };
  const health=await fetchApi("/preview/health");
  assert.equal(health.data.ok,true);
  assert.equal(health.data.runtime,"standalone-no-mcp");
  assert.equal(health.data.live_service_connected,false);
  assert.ok(root.startsWith("http://localhost:"));
  const page=await fetch(new URL("/preview/",root));
  assert.equal(page.status,200);
  assert.match(page.headers.get("content-security-policy"),/script-src.*sha256-/);
  const html=await page.text();
  const script=html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(script);
  new vm.Script(script[1]);
  assert.match(html,/不会连接、停止、重启或修改运行中的 Web Harness 3\.0\.2/);
  checks.push("Private loopback preview exposes only demo pages/health and valid browser JS");

  const before=await fetchApi("/preview/api/status");
  assert.equal(before.data.registered,false);
  assert.equal(before.data.confirmed,false);
  const denied=await fetchApi("/preview/api/enroll/start",{},"https://untrusted.site");
  assert.equal(denied.status,403);
  assert.equal(denied.data.error,"PREVIEW_ORIGIN_DENIED");
  checks.push("Untrusted browser origin is denied before any enrollment challenge is issued");

  const enrollment=await fetchApi("/preview/api/enroll/start",{});
  assert.equal(enrollment.status,200);
  const options=enrollment.data.public_key;
  assert.equal(Buffer.from(options.challenge,"base64url").length,32);
  const spki=key.publicKey.export({type:"spki",format:"der"});
  const registration={
    type:"public-key",algorithm:-7,credential_id:b64(randomBytes(32)),
    public_key_spki_base64url:b64(spki),
    client_data_json_base64url:b64(Buffer.from(JSON.stringify({
      type:"webauthn.create",challenge:options.challenge,origin:root,crossOrigin:false
    }))),
  };
  const spoof={...registration,client_data_json_base64url:b64(Buffer.from(JSON.stringify({
    type:"webauthn.create",challenge:options.challenge,origin:"http://localhost:1"
  })))};
  assert.equal((await fetchApi("/preview/api/enroll/finish",spoof)).status,409);
  const newEnrollment=await fetchApi("/preview/api/enroll/start",{});
  registration.client_data_json_base64url=b64(Buffer.from(JSON.stringify({
    type:"webauthn.create",challenge:newEnrollment.data.public_key.challenge,
    origin:root,crossOrigin:false,
  })));
  const registered=await fetchApi("/preview/api/enroll/finish",registration);
  assert.equal(registered.status,200);
  assert.equal(registered.data.registered,true);
  assert.equal(registered.data.attestation_verified,false);
  assert.equal((await fetchApi("/preview/api/status")).data.registered,true);
  checks.push("Server challenge/origin are bound; demo public-key enrollment succeeds only in isolated sandbox");

  const pending=(await fetchApi("/preview/api/approve/start",{})).data;
  assert.equal(pending.ok,true);
  assert.equal(pending.goal_id,before.data.goal_id);
  assert.equal(pending.public_key.userVerification,"required");
  assert.equal(pending.criterion,before.data.criterion);
  const authenticator=Buffer.alloc(37);
  hash("localhost").copy(authenticator,0);
  authenticator[32]=0x05;
  authenticator.writeUInt32BE(7,33);
  const clientData=Buffer.from(JSON.stringify({
    type:"webauthn.get",challenge:pending.public_key.challenge,
    origin:root,crossOrigin:false,
  }));
  const signedData=Buffer.concat([authenticator,hash(clientData)]);
  const assertion={
    id:registration.credential_id,type:"public-key",
    client_data_json_base64url:b64(clientData),
    authenticator_data_base64url:b64(authenticator),
    signature_base64url:b64(sign("sha256",signedData,key.privateKey)),
  };
  const bad=await fetchApi("/preview/api/approve/finish",{
    request_id:pending.request_id,assertion:{...assertion,
      signature_base64url:b64(sign("sha256",signedData,generateKeyPairSync("ec",{namedCurve:"prime256v1"}).privateKey))}
  });
  assert.equal(bad.status,409);
  assert.equal(bad.data.error,"PASSKEY_SIGNATURE_INVALID");
  assert.equal((await fetchApi("/preview/api/status")).data.confirmed,false);
  checks.push("Forged assertion denied; demo Goal remains unconfirmed");

  const success=await fetchApi("/preview/api/approve/finish",{
    request_id:pending.request_id,assertion,
  });
  assert.equal(success.status,200,JSON.stringify(success));
  assert.equal(success.data.confirmed,true);
  assert.equal(success.data.demo_only,true);
  const after=await fetchApi("/preview/api/status");
  assert.equal(after.data.confirmed,true);
  assert.equal(after.data.goal_id,before.data.goal_id);
  const replay=await fetchApi("/preview/api/approve/finish",{
    request_id:pending.request_id,assertion,
  });
  assert.equal(replay.status,409);
  assert.equal((await fetchApi("/preview/api/approve/start",{})).status,409);
  checks.push("Signed WebAuthn assertion confirms only demo Goal and cannot be replayed");

  const files=await fs.readdir(preview.root);
  assert.ok(files.includes("demo-workspace"));
  assert.ok(files.includes("demo-codex-home"));
  assert.ok(files.includes("demo-public-credential.json"));
  assert.equal(files.some(f=>f.includes("3.0.2")||f.includes("portable.data")),false);
  checks.push("Preview data isolated in a fresh owned temporary root with no live 3.0.2 profile");

  console.log("PASSKEY_PREVIEW_HTTP_PASS",checks.length,"groups",root);
  for(const check of checks)console.log(" PASS",check);
}finally {
  if(preview)await preview.close({deletePreviewFiles:true});
}
