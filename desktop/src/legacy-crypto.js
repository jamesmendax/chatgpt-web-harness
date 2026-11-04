"use strict";
// No legacy plaintext is persisted. The source Local State is cloned to a
// short-lived, per-operation private dir and loaded in a separate Electron process.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const context = require("./account-context");
const MAX_LOCAL_STATE = 4 * 1024 * 1024;
function assertSourceState(sourceRoot) {
  const root = context.assertUnlinked(sourceRoot);
  const file = context.assertUnlinked(path.join(root,"Local State"));
  if (!fs.existsSync(file)) throw new Error("旧版缺少 Local State 加密上下文；无法安全恢复旧密钥，源账号没有被修改。");
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 16 || stat.size > MAX_LOCAL_STATE) throw new Error("旧版加密上下文文件格式异常，导入已取消。");
  const data = fs.readFileSync(file);
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.os_crypt?.encrypted_key) {
      throw new Error("invalid");
    }
  } catch { throw new Error("旧版加密上下文无法解析，导入已取消。"); }
  return { file, data };
}
async function decryptFromSource({ sourceRoot, apiKeyEnc, adminTokenEnc = "" }) {
  if (typeof apiKeyEnc !== "string" || !apiKeyEnc || typeof adminTokenEnc !== "string") {
    throw new Error("旧账户缺少有效的 Runtime API Key，无法完整迁移。");
  }
  const { data } = assertSourceState(sourceRoot);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"wh-crypto-migrate-"));
  const nonce = crypto.randomBytes(24).toString("hex");
  try {
    fs.writeFileSync(path.join(dir,"Local State"),data,{flag:"wx",mode:0o600});
    const env = { ...process.env, WH_IMPORT_CONTEXT_DIR:dir, WH_IMPORT_NONCE:nonce };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const { app } = require("electron");
    const childArgs = app.isPackaged ? ["--wh-internal-crypto-bridge"] :
      [path.resolve(__dirname,".."), "--wh-internal-crypto-bridge"];
    const child = spawn(process.execPath, childArgs, {
      cwd:path.dirname(process.execPath),env,windowsHide:true,
      stdio:["ignore","ignore","ignore","pipe","pipe"]
    });
    return await new Promise((resolve,reject)=>{
      let output="", completed=false;
      const done=(error,result)=>{
        if(completed)return;
        completed=true;clearTimeout(deadline);
        if(error)reject(error);else resolve(result);
      };
      const deadline=setTimeout(()=>{child.kill();done(Error("旧版密钥解密超时，已取消导入。"));},30000);
      child.on("error",()=>done(Error("无法启动旧版加密上下文读取助手。")));
      child.stdio[4].on("data",chunk=>{output+=chunk.toString("utf8");if(output.length>100000){child.kill();done(Error("旧版密钥响应超出安全限制。"));}});
      child.stdio[4].on("error",()=>done(Error("旧版密钥传输中断。")));
      child.on("close",code=>{
        if(code!==0 || !output) {done(Error("旧版密钥解密失败：旧配置的加密上下文可能缺失或不匹配。"));return;}
        try {
          const response=JSON.parse(output);
          if(response.nonce!==nonce || typeof response.apiKey!=="string" ||
             !response.apiKey.trim() || typeof response.adminToken!=="string") throw Error("INVALID");
          done(null,{apiKey:response.apiKey,adminToken:response.adminToken});
        } catch { done(Error("旧版密钥响应校验失败，已取消导入。")); }
      });
      child.stdio[3].end(JSON.stringify({nonce,apiKeyEnc,adminTokenEnc}));
    });
  } finally {
    // Never leave a copy of the old profile crypto context behind.
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
    data.fill(0);
  }
}
module.exports={decryptFromSource,assertSourceState};
