/** Web Harness A1.1 standalone demo-only passkey preview.
 *
 * This is deliberately NOT the 3.0.3 MCP/Admin server, and never imports or
 * attaches to live 3.0.2 state. It accepts an automatically pinned public
 * key ONLY in its disposable demo sandbox. Production credentials must be
 * provisioned and protected by an independent trusted operator.
 *
 * Run: node scripts/passkey-preview-server.mjs
 * The printed localhost URL is the only intended human entry point.
 */
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createGoal, getGoal } from "../dist/lib/goals.js";
import {
  validatePinnedCredential, issuePasskeyApprovalRequest,
  readPasskeyApprovalRequest,
} from "../dist/lib/passkey-approval.js";
import { runWithVerifiedPasskeyUserApproval } from "../dist/lib/host-user-confirmation.js";
import { confirmGoalRunCriterion } from "../dist/lib/goal-run-web.js";
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";

const pageFile=new URL("../public/ui/passkey-preview.html", import.meta.url);
const b64re=/^[A-Za-z0-9_-]+$/;
function fromBase64url(value,max=9000) {
  if(typeof value!=="string" || !value || value.length>max || !b64re.test(value)) throw Error("PREVIEW_BAD_FORMAT");
  const b=Buffer.from(value,"base64url");
  if(!b.length || b.toString("base64url")!==value) throw Error("PREVIEW_BAD_FORMAT");
  return b;
}
function code(error) {
  const name=error instanceof Error?error.message:String(error);
  return /^[A-Z][A-Z0-9_]{5,100}$/.test(name)?name:"PREVIEW_OPERATION_FAILED";
}
function responseError(res,error) {
  const errorCode=code(error);
  return res.status(errorCode==="PREVIEW_OPERATION_FAILED"?500:409).json({ok:false,error:errorCode});
}
function safeOrigin(req,origin) {
  return req.headers.origin===origin && req.headers.host===new URL(origin).host &&
    req.headers["sec-fetch-site"]!=="cross-site" &&
    req.headers["content-type"]?.startsWith("application/json") === true;
}
function checkEnrollmentClient(record,raw,origin) {
  if(!raw || typeof raw!=="object" || Array.isArray(raw)) throw Error("PREVIEW_BAD_ENROLLMENT");
  const id=raw.credential_id;
  const spki=raw.public_key_spki_base64url;
  const clientData=fromBase64url(raw.client_data_json_base64url,8192);
  if(typeof id!=="string" || typeof spki!=="string" || raw.type!=="public-key" ||
     raw.algorithm!==-7) throw Error("PREVIEW_BAD_ENROLLMENT");
  let client;
  try{client=JSON.parse(clientData.toString("utf8"));}catch{throw Error("PREVIEW_BAD_ENROLLMENT");}
  if(!client || client.type!=="webauthn.create" ||
     client.challenge!==record.challenge || client.origin!==origin ||
     client.crossOrigin===true || client.topOrigin!==undefined)
    throw Error("PREVIEW_BAD_ENROLLMENT");
  const pinned=validatePinnedCredential({
    schema_version:1,credential_id:id,public_key_spki_base64url:spki,
    rp_id:"localhost",origin,
  });
  return pinned;
}

export async function startPasskeyPreview({port=0}={}) {
  if(!Number.isInteger(port) || port<0 || port>65535) throw Error("PREVIEW_BAD_PORT");
  // Ownership of every created file is per-preview, never shared with an
  // installed Web Harness profile, a project folder or a user's actual Goal.
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"web-harness-a11-preview-"));
  const workspace=path.join(root,"demo-workspace");
  const home=path.join(root,"demo-codex-home");
  const requestDir=path.join(root,"demo-approvals");
  await fs.mkdir(workspace,{recursive:true});
  await fs.mkdir(requestDir,{recursive:true});
  const oldEnv=Object.fromEntries(
    ["CODEX_HOME","GOAL_WATCHDOG_ENABLED","HARNESS_RELAY_ENABLED","HARNESS_COMPANION_ENABLED","HARNESS_RELAY_AUTOMATION_ENABLED"].map(k=>[k,process.env[k]]));
  process.env.CODEX_HOME=home;
  process.env.GOAL_WATCHDOG_ENABLED="false";
  process.env.HARNESS_RELAY_ENABLED="false";
  process.env.HARNESS_RELAY_AUTOMATION_ENABLED="false";
  process.env.HARNESS_COMPANION_ENABLED="false";
  const ownerSession="demo-passkey-"+randomUUID();
  const withOwner=(fn)=>runWithRuntimeScope(
    createRuntimeScope({workspaceRoot:workspace,projectRoots:[workspace]},{sessionId:ownerSession}),fn);
  const criterion="仅确认这项隔离演示，不批准真实项目操作";
  let goal;
  try {
    goal=await withOwner(()=>createGoal(workspace,{
      objective:"WebAuthn 演示：验证 Windows Hello 用户在独立测试环境中确认操作",
      success_criteria:[{name:criterion,requires_confirmation:true,passed:false}],
    }));
  }catch(error){
    for(const [key,val] of Object.entries(oldEnv))val===undefined?delete process.env[key]:process.env[key]=val;
    throw error;
  }
  let origin="";
  let enrollment=null;
  let pinned=null;
  const credentialFile=path.join(root,"demo-public-credential.json");
  const app=express();
  app.disable("x-powered-by");
  app.use(express.json({limit:"24kb"}));
  app.use((req,res,next)=>{
    const remote=req.socket.remoteAddress?.replace(/^::ffff:/i,"");
    if(remote!=="127.0.0.1" && remote!=="::1") {
      res.status(403).json({ok:false,error:"PREVIEW_LOOPBACK_ONLY"});return;
    }
    if(origin && req.headers.host!==new URL(origin).host) {
      res.status(403).json({ok:false,error:"PREVIEW_HOST_DENIED"});return;
    }
    res.setHeader("Cache-Control","no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    next();
  });
  const ui=await fs.readFile(pageFile,"utf8");
  const scripts=[...ui.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(s=>
    "'sha256-"+createHash("sha256").update(s[1]).digest("base64")+"'");
  app.get("/preview/",(_req,res)=>{
    res.setHeader("Content-Security-Policy",
      "default-src 'none'; connect-src 'self'; script-src "+scripts.join(" ")+
      "; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.type("html").send(ui);
  });
  app.get("/preview/health",(_req,res)=>res.json({
    ok:true,mode:"isolated-demo-only",runtime:"standalone-no-mcp",live_service_connected:false,
    port:new URL(origin).port,
  }));
  app.get("/preview/api/status",async(_req,res)=>{
    const current=await withOwner(()=>getGoal(workspace));
    res.json({ok:true,mode:"demo-only",registered:Boolean(pinned),
      goal_id:goal.id,goal_objective:goal.objective,criterion,
      confirmed:Boolean(current?.success_criteria[0]?.passed),preview_session_only:true});
  });
  app.use("/preview/api",(req,res,next)=>{
    if(!safeOrigin(req,origin)) {
      res.status(403).json({ok:false,error:"PREVIEW_ORIGIN_DENIED"});return;
    }
    next();
  });
  app.post("/preview/api/enroll/start",(req,res)=>{
    if(pinned){res.status(409).json({ok:false,error:"PREVIEW_ALREADY_ENROLLED"});return;}
    const now=Date.now();
    enrollment={challenge:randomBytes(32).toString("base64url"),expires:now+120000,used:false};
    res.json({ok:true,public_key:{
      rp:{id:"localhost",name:"Web Harness 演示专用"},
      user:{id:randomBytes(24).toString("base64url"),name:"passkey-preview",
        displayName:"隔离 WebAuthn 测试"},
      challenge:enrollment.challenge,
      pubKeyCredParams:[{type:"public-key",alg:-7}],
      authenticatorSelection:{residentKey:"preferred",userVerification:"required"},
      timeout:120000,attestation:"none",
    }});
  });
  app.post("/preview/api/enroll/finish",async(req,res)=>{
    try{
      if(!enrollment||enrollment.used||Date.now()>=enrollment.expires||pinned)
        throw Error("PREVIEW_ENROLLMENT_STALE");
      enrollment.used=true; // fail closed; retry requires a fresh human gesture
      const selected=checkEnrollmentClient(enrollment,req.body,origin);
      await fs.writeFile(credentialFile,JSON.stringify({
        ...selected,preview_demo_only:true,attestation_verified:false,
      },null,2)+"\n",{flag:"wx",mode:0o600});
      pinned=selected;
      res.json({ok:true,registered:true,attestation_verified:false,mode:"demo-only"});
    }catch(error){responseError(res,error);}
  });
  app.post("/preview/api/approve/start",async(_req,res)=>{
    try {
      if(!pinned)throw Error("PREVIEW_NOT_ENROLLED");
      const current=await withOwner(()=>getGoal(workspace));
      if(!current||current.id!==goal.id||current.status!=="active"||
         current.success_criteria[0].passed)throw Error("PREVIEW_GOAL_NOT_ELIGIBLE");
      const request=await issuePasskeyApprovalRequest(requestDir,current,criterion,pinned);
      res.json({ok:true,request_id:request.request_id,
        goal_id:request.goal_id,goal_objective:request.goal_objective,
        goal_revision:request.goal_revision,criterion,
        expires_at_ms:request.expires_at_ms,
        public_key:{rpId:pinned.rp_id,challenge:request.challenge_base64url,
          allowCredentials:[{type:"public-key",id:pinned.credential_id}],
          userVerification:"required",timeout:60000}});
    }catch(error){responseError(res,error);}
  });
  app.post("/preview/api/approve/finish",async(req,res)=>{
    try {
      if(!pinned)throw Error("PREVIEW_NOT_ENROLLED");
      const pending=await readPasskeyApprovalRequest(requestDir,req.body?.request_id);
      const current=await withOwner(()=>getGoal(workspace));
      if(!current||current.id!==pending.goal_id||current.revision!==pending.goal_revision||
         current.owner_session!==pending.owner_session||current.status!=="active"||
         current.success_criteria[0]?.passed)throw Error("PREVIEW_GOAL_STALE");
      const result=await withOwner(()=>runWithVerifiedPasskeyUserApproval(
        requestDir,pending,pinned,req.body?.assertion,
        ()=>confirmGoalRunCriterion(workspace,{criterion,expectedRevision:pending.goal_revision,
          detail:"Passkey-confirmed isolated preview only"})));
      res.json({ok:true,confirmed:result.goal.success_criteria[0]?.passed===true,
        goal_id:result.goal.id,verified_via:"webauthn_uv_v1",demo_only:true});
    }catch(error){responseError(res,error);}
  });
  let server;
  try{
    server=await new Promise((resolve,reject)=>{
      const instance=app.listen(port,"127.0.0.1",()=>resolve(instance));
      instance.once("error",reject);
    });
    origin="http://localhost:"+server.address().port;
  }catch(error){
    for(const [key,val] of Object.entries(oldEnv))val===undefined?delete process.env[key]:process.env[key]=val;
    throw error;
  }
  return {
    app,server,origin,root,goal_id:goal.id,owner_session:ownerSession,
    async close({deletePreviewFiles=false}={}){
      await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
      if(deletePreviewFiles)await fs.rm(root,{recursive:true,force:true});
      for(const [key,val] of Object.entries(oldEnv))val===undefined?delete process.env[key]:process.env[key]=val;
    },
  };
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const preview=await startPasskeyPreview({port:Number(process.env.WH_PREVIEW_PORT||"0")});
  console.log("PASSKEY_PREVIEW_READY "+JSON.stringify({
    url:preview.origin+"/preview/",root:preview.root,mode:"demo-only",
    live_302_modified:false,
  }));
  for(const signal of ["SIGTERM","SIGINT"]){
    process.once(signal,async()=>{
      try{await preview.close();}finally{process.exit(0);}
    });
  }
}
