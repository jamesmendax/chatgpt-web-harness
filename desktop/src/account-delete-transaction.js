"use strict";
// Durable, conservative archive transaction. Caller holds account-mutation lock.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const context=require("./account-context"), tx=require("./account-import-transaction");
const leaves=/^(?:config\.json|runtime|logs|browser-use|computer-use|notification-sounds|config\.json\.\d+\.\d+\.bak)$/;
function tree(file) {
  context.assertUnlinked(file);
  const rows=[];
  function walk(p,rel) {
    const st=fs.lstatSync(p);
    if(st.isSymbolicLink())throw Error("账号归档中发现链接。");
    if(st.isDirectory()) {rows.push([rel,"d"]);for(const n of fs.readdirSync(p).sort())walk(path.join(p,n),rel+"/"+n);}
    else if(st.isFile()) {
      const hash=crypto.createHash("sha256"),buffer=Buffer.allocUnsafe(1024*1024),fd=fs.openSync(p,"r");
      try {let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));} finally {fs.closeSync(fd);}
      rows.push([rel,"f",hash.digest("hex")]);
    }
    else throw Error("账号归档中发现非普通文件。");
  }
  try {walk(file,"");} catch(e) {if(e.code==="ENOENT"&&!fs.existsSync(file))return null;throw e;}
  return tx.digest(Buffer.from(JSON.stringify(rows)));
}
function validate(root,dir,j) {
 if(j.version!==1||j.root!==path.resolve(root)||!context.ID_RE.test(j.id)||!Array.isArray(j.moves)||j.moves.length>1000)throw Error("账号删除恢复清单无效。");
 if(j.replacement!==undefined && (!j.replacement || !/^[a-f0-9]{32}$/.test(j.replacement.id) || j.replacement.id===j.id))throw Error("替代账号恢复清单无效。");
 const scope=j.id==="default"?root:path.join(root,"accounts",j.id),seen=new Set();
 for(const m of j.moves) {
   if(!m||!leaves.test(m.name)||seen.has(m.name)||!/^[a-f0-9]{64}$/.test(m.hash||""))throw Error("账号删除恢复项目无效。");
   seen.add(m.name);context.assertUnlinked(path.join(scope,m.name));context.assertUnlinked(path.join(dir,m.name));
 }
 if(typeof j.newIndex!=="string"||tx.digest(Buffer.from(j.newIndex,"base64"))!==j.newSha256||
    (j.old?.existed && (typeof j.oldIndex!=="string"||tx.digest(Buffer.from(j.oldIndex,"base64"))!==j.old.sha256)) || (!j.old?.existed && j.oldIndex!==null))throw Error("账号删除索引备份无效。");
 if(!j.old||typeof j.old.existed!=="boolean"||(j.old.existed&&!/^[a-f0-9]{64}$/.test(j.old.sha256||""))||!/^[a-f0-9]{64}$/.test(j.newSha256||""))throw Error("账号删除索引记录无效。");
}
function reconcile(root,dir,j) {
 validate(root,dir,j);
 const scope=j.id==="default"?root:path.join(root,"accounts",j.id),index=tx.state(path.join(root,"accounts.json"));
 const isOld=index.existed===j.old.existed&&(!index.existed||index.sha256===j.old.sha256);
 const isNew=index.existed&&index.sha256===j.newSha256;
 if(!isOld&&!isNew)throw Error("账号删除恢复索引发生外部修改；保留归档："+dir);
 const actions=[];
 let replacementAction=null;
 if(j.replacement) {
   const target=context.assertUnlinked(path.join(root,"accounts",j.replacement.id));
   const stage=context.assertUnlinked(path.join(dir,"replacement-stage"));
   const ready=context.assertUnlinked(path.join(dir,"replacement-ready.json"));
   const a=tree(target), b=tree(stage);let hash=null;
   if(fs.existsSync(ready)) {
     try {if(!fs.lstatSync(ready).isFile())throw Error();hash=JSON.parse(fs.readFileSync(ready,"utf8")).hash;} catch {if(a!==null||isNew)throw Error("替代账号备份记录无效。");}
     if(hash!==null&&!/^[a-f0-9]{64}$/.test(hash)) {if(a!==null||isNew)throw Error("替代账号备份校验值无效。");hash=null;}
   }
   if(isNew) {if(!hash||a!==hash||b!==null)throw Error("已发布索引与替代账号状态冲突："+target);}
   else if(a!==null) {
     if(!hash||a!==hash||b!==null)throw Error("替代账号发生外部修改；保留当前文件："+target);
     replacementAction={target,stage,hash};
   }
 }
 for(const m of j.moves) {
   const src=path.join(scope,m.name),dst=path.join(dir,m.name),a=tree(src),b=tree(dst);
   if(a===m.hash&&b===null) {if(isNew)throw Error("已发布索引与账号归档状态冲突："+src);}
   else if(a===null&&b===m.hash) {if(isOld)actions.push({src,dst,hash:m.hash});}
   else throw Error("账号归档发生外部修改；保留当前文件和备份："+src);
 }
 if(isNew) {fs.writeFileSync(path.join(dir,"committed.flag"),"committed\n",{flag:"wx"});return "committed";}
 if(replacementAction) {
   const a=replacementAction;
   if(tree(a.target)!==a.hash||tree(a.stage)!==null)throw Error("恢复期间替代账号发生变化："+a.target);
   fs.renameSync(a.target,a.stage);
 }
 for(const a of actions.reverse()) {
   if(tree(a.src)!==null||tree(a.dst)!==a.hash)throw Error("账号恢复期间目录发生变化："+a.src);
   fs.mkdirSync(path.dirname(a.src),{recursive:true});fs.renameSync(a.dst,a.src);
 }
 fs.writeFileSync(path.join(dir,"rolled-back.flag"),"rolled-back\n",{flag:"wx"});return "rolled-back";
}
function recoverPending(root) {
 const recovery=context.assertUnlinked(path.join(root,"account-recovery"));
 if(!fs.existsSync(recovery))return [];
 const result=[];
 for(const name of fs.readdirSync(recovery).filter(x=>/^delete-txn-\d+-[a-f0-9]{16}$/.test(x)).sort()) {
   const dir=context.assertUnlinked(path.join(recovery,name));
   if(!fs.lstatSync(dir).isDirectory())throw Error("账号删除恢复目录类型异常。");
   let finished=false;
   for(const [name,text] of [["committed.flag","committed\n"],["rolled-back.flag","rolled-back\n"]]) {
     const flag=context.assertUnlinked(path.join(dir,name));
     if(fs.existsSync(flag)) {if(!fs.lstatSync(flag).isFile()||fs.readFileSync(flag,"utf8")!==text)throw Error("账号删除恢复标记无效："+flag);finished=true;}
   }
   if(finished)continue;
   const f=context.assertUnlinked(path.join(dir,"journal.json"));if(!fs.existsSync(f))continue;
   if(!fs.lstatSync(f).isFile())throw Error("账号删除恢复清单不是普通文件。");
   result.push({name,status:reconcile(root,dir,JSON.parse(fs.readFileSync(f,"utf8")))});
 }
 return result;
}
function commit(root,id,sources,oldText,newText,publish,replacement=null) {
 const recovery=context.assertUnlinked(path.join(root,"account-recovery"));fs.mkdirSync(recovery,{recursive:true});
 const old=oldText===null?{existed:false}:{existed:true,sha256:tx.digest(Buffer.from(oldText))};
 const current=tx.state(path.join(root,"accounts.json"));
 if(current.existed!==old.existed||(old.existed&&current.sha256!==old.sha256))throw Error("账号索引被其他程序修改；未覆盖。");
 const moves=sources.map(s=>({name:s.name,hash:tree(s.file)}));
 if(moves.some(m=>!m.hash))throw Error("账号归档来源已变化。");
 const dir=path.join(recovery,"delete-txn-"+Date.now()+"-"+crypto.randomBytes(8).toString("hex"));fs.mkdirSync(dir);
 const journal={version:1,root:path.resolve(root),id,moves,old,oldIndex:oldText===null?null:Buffer.from(oldText).toString("base64"),newIndex:Buffer.from(newText).toString("base64"),newSha256:tx.digest(Buffer.from(newText)),...(replacement?{replacement:{id:replacement.id}}:{})};
 validate(root,dir,journal);
 fs.writeFileSync(path.join(dir,"journal.json"),JSON.stringify(journal,null,2)+"\n",{flag:"wx",mode:0o600});
 try {
   if(replacement) {
     const stage=context.assertUnlinked(path.join(dir,"replacement-stage")),target=context.assertUnlinked(path.join(root,"accounts",replacement.id));
     if(tree(target)!==null)throw Error("新账号目录已存在，未覆盖。");
     replacement.prepare(stage);
     const hash=tree(stage);if(!hash)throw Error("替代账号准备失败。");
     fs.writeFileSync(path.join(dir,"replacement-ready.json"),JSON.stringify({hash})+"\n",{flag:"wx",mode:0o600});
     if(tree(target)!==null||tree(stage)!==hash)throw Error("替代账号准备期间发生变化。");
     fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(stage,target);
   }
   for(const m of moves) {
     const src=path.join(id==="default"?root:path.join(root,"accounts",id),m.name),dst=path.join(dir,m.name);
     if(tree(src)!==m.hash||tree(dst)!==null)throw Error("账号归档来源在操作期间变化。");
     fs.renameSync(src,dst);
   }
   publish();
   fs.writeFileSync(path.join(dir,"committed.flag"),"committed\n",{flag:"wx",mode:0o600});
   return dir;
 } catch(e) {
   try {if(reconcile(root,dir,journal)==="committed")return dir;} catch(recovery) {throw Error("账号移除中断，恢复冲突；保留归档："+dir+"；"+recovery.message);}
   throw e;
 }
}
module.exports={commit,recoverPending,tree};
