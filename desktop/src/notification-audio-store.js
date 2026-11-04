"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const context=require("./account-context");
const {validateWav}=require("./notification-sound");

const MAX_BASE64=700000;
function customPath(accountDataDir) {
  const base=context.assertUnlinked(path.resolve(accountDataDir));
  const file=context.assertUnlinked(path.join(base,"notification-sounds","custom.wav"));
  if(path.relative(base,file).startsWith("..")||path.isAbsolute(path.relative(base,file)))
    throw Error("自定义提示音目录越界");
  return file;
}
function importCustomWav({ accountDataDir, audioBase64, commitConfig }) {
  if(typeof audioBase64!=="string"||audioBase64.length>MAX_BASE64 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64))
    throw Error("音频数据不是有效的受限 WAV 格式。");
  const bytes=Buffer.from(audioBase64,"base64");
  if(bytes.toString("base64")!==audioBase64)throw Error("音频数据编码不规范。");
  validateWav(bytes);
  if(typeof commitConfig!=="function")throw Error("缺少目标账号配置更新能力。");
  const file=customPath(accountDataDir),dir=path.dirname(file);
  context.assertUnlinked(dir);
  fs.mkdirSync(dir,{recursive:true});
  context.assertUnlinked(file);
  const prior=fs.existsSync(file)?fs.readFileSync(file):null;
  if(prior&&prior.length>512*1024)throw Error("旧自定义提示音超出安全限制，已拒绝覆盖。");
  const temp=file+"."+crypto.randomBytes(8).toString("hex")+".tmp";
  const publish=buffer=>{
    const staged=file+"."+crypto.randomBytes(8).toString("hex")+".tmp";
    try {fs.writeFileSync(staged,buffer,{flag:"wx",mode:0o600});fs.renameSync(staged,file);}
    finally {if(fs.existsSync(staged))fs.rmSync(staged,{force:true});}
  };
  try {
    fs.writeFileSync(temp,bytes,{flag:"wx",mode:0o600});
    fs.renameSync(temp,file);
    try {commitConfig();}
    catch(error){
      try {if(prior)publish(prior);else if(fs.existsSync(file))fs.rmSync(file,{force:true});}
      catch {throw Error("音效设置提交失败且原自定义音频恢复失败，请保留账号备份。");}
      throw error;
    }
  }finally{if(fs.existsSync(temp))fs.rmSync(temp,{force:true});}
  return {bytes:bytes.length,durationMs:Math.round(bytes.readUInt32LE(40)/2/44100*1000),
    sha256:crypto.createHash("sha256").update(bytes).digest("hex")};
}
module.exports={customPath,importCustomWav};
