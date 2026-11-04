"use strict";
// Transaction journal for importing account-owned configuration and Skills.
// Committed journals are retained as bounded recovery copies, never as active state.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const context=require("./account-context");
const ID="(?:default|[a-f0-9]{32})";
function allowed(relative) {
  const v=relative.split(path.sep).join("/");
  if(v==="accounts.json"||v==="config.json")return true;
  if(/^accounts\/[a-f0-9]{32}\/config\.json$/.test(v))return true;
  if(v==="notification-sounds/custom.wav" ||
      /^accounts\/[a-f0-9]{32}\/notification-sounds\/custom\.wav$/.test(v))return true;
  const prefix=v.startsWith("runtime/profiles/")? "runtime/profiles/" :
    /^accounts\/[a-f0-9]{32}\/runtime\/profiles\//.test(v)?v.match(/^accounts\/[a-f0-9]{32}\/runtime\/profiles\//)[0]:"";
  if(!prefix)return false;
  const tail=v.slice(prefix.length);
  if(tail==="plugins.json"||tail==="mcp-upstream.json"||tail==="conversation-index.json")return true;
  const parts=tail.split("/");
  return parts[0]==="local-skills"&&parts.length>=3&&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(parts[1])&&
    parts.slice(2).every(x=>x&&x!=="."&&x!==".."&&!/[\u0000-\u001f]/.test(x));
}
function inside(root,file) {
  const base=context.assertUnlinked(root),out=context.assertUnlinked(file),rel=path.relative(base,out);
  if(!rel||path.isAbsolute(rel)||rel===".."||rel.startsWith(".."+path.sep)||!allowed(rel))
    throw Error("迁移目标不属于允许的账号配置或 Skill 文件。");
  return {file:out,relative:rel};
}
const digest=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function copySafely(input,output) {
  context.assertUnlinked(input);context.assertUnlinked(output);
  const stat=fs.lstatSync(input);
  if(!stat.isFile())throw Error("迁移备份不是普通文件。");
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const tmp=output+"."+crypto.randomBytes(4).toString("hex")+".tmp";
  fs.copyFileSync(input,tmp,fs.constants.COPYFILE_EXCL);
  try {
    fs.renameSync(tmp,output);
  } finally {if(fs.existsSync(tmp))fs.rmSync(tmp,{force:true});}
}
function state(file) {
  context.assertUnlinked(file);
  try {
    if (!fs.lstatSync(file).isFile()) throw Error("恢复目标不是普通文件。 "+file);
    return {existed:true,sha256:digest(fs.readFileSync(file))};
  } catch(e) { if(e.code==="ENOENT") return {existed:false}; throw e; }
}
function same(a,b) {return a.existed===b.existed && (!a.existed || a.sha256===b.sha256);}
function isDeadOwner(file) {
  context.assertUnlinked(file);
  let owner;
  try {if(!fs.lstatSync(file).isFile())throw Error();owner=JSON.parse(fs.readFileSync(file,"utf8"));}
  catch {throw Error("账号事务锁内容不明确，请保留并检查："+file);}
  if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)throw Error("账号事务锁所有者不明确，请保留并检查："+file);
  try {process.kill(owner.pid,0);return false;}
  catch(e) {if(e.code==="ESRCH")return true;throw Error("无法确认账号事务锁所有者是否退出："+file);}
}
function withLock(root,fn) {
  const base=context.assertUnlinked(root);
  fs.mkdirSync(base,{recursive:true});
  const lock=context.assertUnlinked(path.join(base,".account-mutation.lock"));
  const gate=context.assertUnlinked(path.join(base,".account-mutation.gate"));
  const recovery=context.assertUnlinked(path.join(base,".account-mutation.gate-recovery"));
  const owner=context.assertUnlinked(path.join(base,".account-owner-"+process.pid+"-"+crypto.randomBytes(8).toString("hex")));
  let ownerFd,gateHeld=false,lockInstalled=false,fd;
  try {
    ownerFd=fs.openSync(owner,"wx",0o600);
    fs.writeFileSync(ownerFd,JSON.stringify({pid:process.pid})+"\n");fs.fsyncSync(ownerFd);fs.closeSync(ownerFd);ownerFd=undefined;
    try {fs.linkSync(owner,gate);gateHeld=true;}
    catch(e) {
      if(e.code!=="EEXIST")throw e;
      // Serialize stale-gate reclamation. A crashed recovery guard is left
      // intact: recursively breaking it would reintroduce a check/unlink race.
      try {fs.linkSync(owner,recovery);} catch(claim) {if(claim.code==="EEXIST")throw Error("账号事务锁恢复正在进行或状态不明确："+recovery);throw claim;}
      try {
        if(fs.existsSync(gate)) {
          if(!isDeadOwner(gate))throw Error("账号事务协调锁由仍在运行的进程持有："+gate);
          fs.unlinkSync(gate);
        }
        try {fs.linkSync(owner,gate);gateHeld=true;} catch(claim) {if(claim.code==="EEXIST")throw Error("账号事务协调锁正在使用："+gate);throw claim;}
      } finally {fs.unlinkSync(recovery);}
    }
    if(fs.existsSync(lock)) {
      if(!isDeadOwner(lock))throw Error("账号事务锁由仍在运行的进程持有："+lock);
      fs.unlinkSync(lock);
    }
    // The fully written owner record is linked atomically into the lock name.
    fs.linkSync(owner,lock);lockInstalled=true;
    fd=fs.openSync(lock,"r");
  } catch(e) {
    if(lockInstalled&&fd===undefined)fs.unlinkSync(lock);
    throw e;
  } finally {
    if(ownerFd!==undefined)fs.closeSync(ownerFd);
    if(gateHeld)fs.unlinkSync(gate);
    try {fs.unlinkSync(owner);} catch(e) {if(e.code!=="ENOENT")throw e;}
  }
  try {return fn();}
  finally {fs.closeSync(fd);fs.unlinkSync(lock);}
}
function restore(root,dir,journal) {
  if(![1,2].includes(journal.version)||journal.root!==path.resolve(root)||!Array.isArray(journal.files)||journal.files.length>12010)
    throw Error("迁移恢复清单不可信，原始备份仍保留。");
  const seen=new Set(),actions=[];
  // Validate every backup and every target before changing any target.
  for(const item of journal.files) {
    if(!item||typeof item.rel!=="string"||!allowed(item.rel)||typeof item.existed!=="boolean"||seen.has(item.rel))
      throw Error("迁移恢复清单包含无效或重复目标，原数据未修改。");
    seen.add(item.rel);
    const file=inside(root,path.join(root,item.rel)).file;
    const old={existed:item.existed,...(item.existed?{sha256:item.sha256}:{})};
    if(journal.version===2 && item.rel.split(path.sep).join("/")==="accounts.json" &&
      (typeof item.newIndex!=="string" || digest(Buffer.from(item.newIndex,"base64"))!==item.newSha256))
      throw Error("迁移索引预定内容校验失败，原数据未修改。");
    if(item.existed) {
      if(typeof item.backup!=="string"||!/^\d+\.bak$/.test(item.backup)||!/^[a-f0-9]{64}$/.test(item.sha256||""))
        throw Error("迁移备份索引或校验值无效，原数据未修改。");
      const backup=context.assertUnlinked(path.join(dir,item.backup));
      if(!fs.lstatSync(backup).isFile()||digest(fs.readFileSync(backup))!==item.sha256)
        throw Error("迁移备份校验失败，未覆盖当前账号配置。");
    }
    const now=state(file);
    if(same(now,old)) continue; // Includes already restored items on a retry.
    // Legacy journals lack intended bytes, so never guess that an edit is ours.
    if(journal.version!==2 || !/^[a-f0-9]{64}$/.test(item.newSha256||"") || !same(now,{existed:true,sha256:item.newSha256}))
      throw Error("迁移恢复遇到外部修改或旧版不明状态；保留当前文件与备份："+file);
    actions.push({item,file,observed:now});
  }
  for(const {item,file,observed} of actions.reverse()) {
    if(!same(state(file),observed)) throw Error("恢复期间目标发生变化；已保留备份："+file);
    if(item.existed) copySafely(path.join(dir,item.backup),file);
    else fs.unlinkSync(file);
  }
}
function recoverPendingUnlocked(root) {
  const base=context.assertUnlinked(root),recovery=path.join(base,"account-recovery");
  if(!fs.existsSync(recovery))return [];
  context.assertUnlinked(recovery);
  const restored=[];
  for(const name of fs.readdirSync(recovery).filter(x=>/^import-txn-[0-9]+-[a-f0-9]{16}$/.test(x)).sort()) {
    const dir=path.join(recovery,name),journalFile=path.join(dir,"journal.json"),flag=path.join(dir,"committed.flag");
    context.assertUnlinked(dir);
    if(!fs.lstatSync(dir).isDirectory())throw Error("迁移恢复目录类型异常。");
    context.assertUnlinked(journalFile);context.assertUnlinked(flag);
    if(!fs.existsSync(journalFile))continue;
    if(!fs.lstatSync(journalFile).isFile())throw Error("迁移恢复清单不是普通文件。");
    const rolledBack=context.assertUnlinked(path.join(dir,"rolled-back.flag"));
    let finished=false;
    for(const [f,expected] of [[flag,"committed\n"],[rolledBack,"rolled-back\n"]])if(fs.existsSync(f)) {
      if(!fs.lstatSync(f).isFile()||fs.readFileSync(f,"utf8")!==expected)throw Error("迁移恢复标记无效："+f);
      finished=true;
    }
    if(finished)continue;
    const journal=JSON.parse(fs.readFileSync(journalFile,"utf8"));
    restore(base,dir,journal);
    fs.writeFileSync(rolledBack,"rolled-back\n",{flag:"wx"});
    restored.push(name);
  }
  return restored;
}
function recoverPending(root) {return withLock(root,()=>recoverPendingUnlocked(root));}
function commit(root,changes) {
 return withLock(root,()=> {
  const base=context.assertUnlinked(root),recovery=path.join(base,"account-recovery");
  const seen=new Set(),files=[];
  // Reject stale plans before creating any journal or modifying data.
  for(const change of changes) {
    if(!Buffer.isBuffer(change.data))throw Error("迁移内容必须是已验证的字节数据。");
    const result=inside(base,change.file);
    if(seen.has(result.relative))throw Error("迁移目标文件重复，未执行导入。");
    seen.add(result.relative);
    const current=state(result.file);
    if(change.expected&&!same(current,change.expected))throw Error("迁移目标在预览后发生变化；已拒绝覆盖。");
    files.push({rel:result.relative,...current,...(current.existed?{backup:files.length+".bak"}:{}),newSha256:digest(change.data),
      ...(result.relative.split(path.sep).join("/")==="accounts.json"?{newIndex:change.data.toString("base64")}:{})});
  }
  fs.mkdirSync(recovery,{recursive:true});context.assertUnlinked(recovery);
  const dir=path.join(recovery,"import-txn-"+Date.now()+"-"+crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir,{recursive:false});
  for(const item of files) if(item.existed) {
    fs.copyFileSync(path.join(base,item.rel),path.join(dir,item.backup),fs.constants.COPYFILE_EXCL);
    if(digest(fs.readFileSync(path.join(dir,item.backup)))!==item.sha256)throw Error("迁移备份发生变化，未执行导入。");
  }
  const journal={version:2,root:base,files};
  fs.writeFileSync(path.join(dir,"journal.json"),JSON.stringify(journal,null,2)+"\n",{flag:"wx",mode:0o600});
  let mutated=false;
  try {
    for(const item of files) if(!same(state(inside(base,path.join(base,item.rel)).file),item))
      throw Error("迁移目标在预览后发生变化；已拒绝覆盖。");
    for(let i=0;i<changes.length;i++) {
      const change=changes[i],item=files[i],file=inside(base,change.file).file;
      if(!same(state(file),item))throw Error("迁移期间目标发生变化；已拒绝覆盖。");
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const tmp=file+"."+crypto.randomBytes(6).toString("hex")+".import-tmp";
      fs.writeFileSync(tmp,change.data,{flag:"wx",mode:0o600});
      try {fs.renameSync(tmp,file);mutated=true;} finally {try {fs.unlinkSync(tmp);} catch(e) {if(e.code!=="ENOENT")throw e;}}
    }
    fs.writeFileSync(path.join(dir,"committed.flag"),"committed\n",{flag:"wx",mode:0o600});
    return {recoveryDir:dir};
  } catch(error) {
    try {if(mutated)restore(base,dir,journal);fs.writeFileSync(path.join(dir,"rolled-back.flag"),"rolled-back\n",{flag:"wx",mode:0o600});}
    catch(recoveryError) {throw Error("导入中断且恢复冲突，请保留备份目录："+dir+"；"+recoveryError.message);}
    throw error;
  }
 });
}
module.exports={commit,recoverPending,recoverPendingUnlocked,withLock,state,digest};
