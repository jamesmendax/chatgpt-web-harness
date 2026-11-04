import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { localhostOnly, adminAuth } from "./localhost-guard.js";
import { getGoal } from "../lib/goal-state-store.js";
import { confirmGoalRunCriterion } from "../lib/goal-run-web.js";
import { createRuntimeScope, runWithRuntimeScope } from "../lib/runtime-scope.js";
import { runWithVerifiedPasskeyUserApproval } from "../lib/host-user-confirmation.js";
import {
  issuePasskeyApprovalRequest, readPasskeyApprovalRequest,
  validatePinnedCredential, type PasskeyCredential, type PasskeyAssertion,
} from "../lib/passkey-approval.js";

/**
 * Optional local human-approval lane. OFF by default, and never mounted in
 * the running 3.0.2 binary. The only credential authority is a separately
 * operator-pinned public key (outside the source workspace); the user must
 * actively use a passkey/Windows Hello for each specific Goal criterion.
 */
const uiDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../public/ui");
function errorCode(error: unknown): string {
  const m=error instanceof Error?error.message:String(error);
  return /^[A-Z][A-Z0-9_]{5,100}$/.test(m)?m:"PASSKEY_APPROVAL_FAILED";
}
function requiresSecureConfig(req:Request,res:Response, origin:string):boolean {
  if (!process.env.ADMIN_TOKEN?.trim()) {
    res.status(503).json({ok:false,error:"PASSKEY_ADMIN_AUTH_REQUIRED"}); return false;
  }
  if (req.headers.origin !== origin ||
      req.headers.host !== new URL(origin).host ||
      req.headers["sec-fetch-site"] === "cross-site") {
    res.status(403).json({ok:false,error:"PASSKEY_ORIGIN_DENIED"}); return false;
  }
  return true;
}
async function page(res:Response,file:string):Promise<void> {
  const html=await fs.readFile(path.join(uiDir,file),"utf8");
  const hashes=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (part)=>"'sha256-"+createHash("sha256").update(part[1]).digest("base64")+"'"
  );
  res.setHeader("Cache-Control","no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Content-Security-Policy",
    "default-src 'none'; connect-src 'self'; script-src "+hashes.join(" ")+
    "; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.type("html").send(html);
}
async function trustedConfig(workspaceRoot:string,expectedOrigin:string):Promise<{
  pinned: PasskeyCredential; stateDir:string;
}> {
  const credentialPath=process.env.HARNESS_PASSKEY_APPROVAL_CREDENTIAL_FILE?.trim()||"";
  const stateDir=process.env.HARNESS_PASSKEY_APPROVAL_STATE_DIR?.trim()||"";
  if (!path.isAbsolute(credentialPath) || !path.isAbsolute(stateDir)) {
    throw new Error("PASSKEY_OPERATOR_CONFIG_REQUIRED");
  }
  const workspace=await fs.realpath(workspaceRoot);
  const credentialFile=await fs.realpath(credentialPath);
  const stateReal=await fs.realpath(stateDir);
  const relative=path.relative(workspace,credentialFile);
  const stateRelative=path.relative(workspace,stateReal);
  const withinWorkspace=(r:string)=>!r || (!r.startsWith(".."+path.sep) && r!==".." && !path.isAbsolute(r));
  if (withinWorkspace(relative) || withinWorkspace(stateRelative)) {
    throw new Error("PASSKEY_OPERATOR_CONFIG_OUTSIDE_WORKSPACE_REQUIRED");
  }
  const pinned=validatePinnedCredential(JSON.parse(await fs.readFile(credentialFile,"utf8")));
  if (pinned.origin!==expectedOrigin || pinned.rp_id!=="localhost") {
    throw new Error("PASSKEY_ORIGIN_CONFIG_MISMATCH");
  }
  return {pinned,stateDir};
}
export function createPasskeyApprovalRouter(options:{workspaceRoot:string;adminPort:number}):Router {
  const router=Router();
  const origin="http://localhost:"+options.adminPort;
  router.use(localhostOnly);
  router.get("/",async (_req,res)=>{
    try {await page(res,"passkey-approval.html");}
    catch {res.status(500).send("Approval page unavailable");}
  });
  router.get("/enroll",async (_req,res)=>{
    try {await page(res,"passkey-enroll.html");}
    catch {res.status(500).send("Enrollment reference page unavailable");}
  });
  router.use("/api",(req,res,next)=>{
    if(!requiresSecureConfig(req,res,origin))return;
    adminAuth(req,res,next);
  });
  router.post("/api/begin",async(req,res)=>{
    try {
      const session=req.body?.owner_session;
      const criterion=req.body?.criterion;
      if (typeof session!=="string" || session.length>512 || !session ||
          typeof criterion!=="string" || !criterion.trim() || criterion.length>300) {
        res.status(400).json({ok:false,error:"PASSKEY_REQUEST_INVALID"});return;
      }
      const {pinned,stateDir}=await trustedConfig(options.workspaceRoot,origin);
      const goal=await getGoal(options.workspaceRoot,session);
      if (!goal || goal.owner_session!==session || goal.status!=="active") {
        throw new Error("PASSKEY_GOAL_NOT_FOUND");
      }
      const item=goal.success_criteria.find(c=>c.name===criterion && c.requires_confirmation && !c.passed);
      if (!item) throw new Error("PASSKEY_CRITERION_NOT_ELIGIBLE");
      const pending=await issuePasskeyApprovalRequest(stateDir,goal,item.name,pinned);
      res.json({ok:true,request_id:pending.request_id,goal_id:pending.goal_id,
        goal_revision:pending.goal_revision,goal_objective:pending.goal_objective,
        criterion:pending.criterion,expires_at_ms:pending.expires_at_ms,
        public_key:{rpId:pinned.rp_id,challenge:pending.challenge_base64url,
          allowCredentials:[{type:"public-key",id:pinned.credential_id}],
          userVerification:"required",timeout:60000}});
    }catch(e){res.status(409).json({ok:false,error:errorCode(e)});}
  });
  router.post("/api/finish",async(req,res)=>{
    try {
      const id=req.body?.request_id;
      const assertion=req.body?.assertion as PasskeyAssertion;
      const {pinned,stateDir}=await trustedConfig(options.workspaceRoot,origin);
      const pending=await readPasskeyApprovalRequest(stateDir,id);
      const goal=await getGoal(options.workspaceRoot,pending.owner_session);
      const criterion=goal?.success_criteria.find(c=>c.name===pending.criterion);
      if (!goal || goal.id!==pending.goal_id || goal.revision!==pending.goal_revision ||
          goal.owner_session!==pending.owner_session || goal.status!=="active" ||
          !criterion?.requires_confirmation || criterion.passed) throw new Error("PASSKEY_GOAL_STALE");
      const scope=createRuntimeScope({workspaceRoot:options.workspaceRoot,
        projectRoots:[options.workspaceRoot]}, {sessionId:pending.owner_session});
      const result=await runWithRuntimeScope(scope,()=>
        runWithVerifiedPasskeyUserApproval(stateDir,pending,pinned,assertion,
          ()=>confirmGoalRunCriterion(options.workspaceRoot,{
            criterion:pending.criterion,expectedRevision:pending.goal_revision,
            detail:"Passkey-confirmed out-of-band approval",
          })));
      res.json({ok:true,goal_id:result.goal.id,criterion:pending.criterion,
        verified_via:"webauthn_uv_v1",goal_revision:result.goal.revision,
        goal_status:result.goal.status});
    }catch(e){res.status(409).json({ok:false,error:errorCode(e)});}
  });
  return router;
}
