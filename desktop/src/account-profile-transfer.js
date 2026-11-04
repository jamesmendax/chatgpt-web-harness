"use strict";
// Read-only legacy profile inventory and conservative merge planner.
// No source file is ever executed, overwritten or removed by this module.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const context=require("./account-context");
const MAX_FILES=12000,MAX_BYTES=1024*1024*1024,MAX_SINGLE=256*1024*1024;
const ID=/^[a-z0-9][a-z0-9._-]{0,63}$/;
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
function inside(root,file) {
  const base=path.resolve(root),target=path.resolve(file),relative=path.relative(base,target);
  if(!relative || path.isAbsolute(relative)||relative===".."||relative.startsWith(".."+path.sep))throw Error("迁移路径超出账号目录。");
  return context.assertUnlinked(target);
}
function readJson(file,optional=false) {
  if(!fs.existsSync(file)) {if(optional)return null;throw Error("必要的旧版配置不存在。");}
  context.assertUnlinked(file);
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.size>2*1024*1024)throw Error("旧版 Skills/MCP 配置文件格式或体积异常。");
  let value;try{value=JSON.parse(fs.readFileSync(file,"utf8"));}catch{throw Error("旧版 Skills/MCP 配置 JSON 无效，原数据没有修改。");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("旧版 Skills/MCP 配置不是对象。");
  return value;
}
function scan(sourceDataDir) {
  const root=context.assertUnlinked(sourceDataDir);
  const profiles=path.join(root,"runtime","profiles");
  const records=[];
  const attachments=[];
  let count=0,total=0;
  function push(file,rel) {
    context.assertUnlinked(file);
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.size>MAX_SINGLE)throw Error("Skill 包含不受支持的大文件或非普通文件。");
    count++;total+=stat.size;
    if(count>MAX_FILES||total>MAX_BYTES)throw Error("旧版 Skill 文件数或总体积超出安全限制，未执行迁移。");
    const data=fs.readFileSync(file);
    records.push({rel,bytes:stat.size,sha256:hash(data)});
  }
  function walk(dir,rel) {
    context.assertUnlinked(dir);
    const st=fs.lstatSync(dir);
    if(st.isSymbolicLink()||!st.isDirectory())throw Error("Skill 目录不能包含链接或非普通目录。");
    for(const name of fs.readdirSync(dir).sort()) {
      const file=path.join(dir,name),nested=path.join(rel,name);
      const item=fs.lstatSync(file);
      if(item.isSymbolicLink())throw Error("旧版 Skill 目录含链接或 junction，已拒绝导入。");
      if(item.isDirectory())walk(file,nested);
      else push(file,nested);
    }
  }
  if(fs.existsSync(profiles)) {
    for(const name of ["plugins.json","mcp-upstream.json"]) {
      const file=path.join(profiles,name);
      if(fs.existsSync(file))push(file,name);
    }
    const skills=path.join(profiles,"local-skills");
    if(fs.existsSync(skills))walk(skills,"local-skills");
  }
  // These are owned by the account data directory, not the Skill package.
  for(const [rel,maxBytes] of [
    [path.join("runtime","profiles","conversation-index.json"),1024*1024],
    [path.join("notification-sounds","custom.wav"),512*1024]
  ]) {
    const file=inside(root,path.join(root,rel));
    if(!fs.existsSync(file))continue;
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.size>maxBytes)throw Error("会话名称或提示音文件超出允许范围。");
    const data=fs.readFileSync(file);
    if(rel.endsWith("custom.wav"))require("./notification-sound").validateWav(data);
    if(rel.endsWith("conversation-index.json")) {
      let parsed;
      try {parsed=JSON.parse(data.toString("utf8"));}catch{throw Error("来源会话显示索引损坏；未执行迁移。");}
      if(parsed?.schema!==1||!Array.isArray(parsed.records)||!Number.isSafeInteger(parsed.nextNumber))
        throw Error("来源会话显示索引格式不支持；未执行迁移。");
    }
    attachments.push({rel,bytes:stat.size,sha256:hash(data)});
  }
  records.sort((a,b)=>a.rel.localeCompare(b.rel));
  const plugins=readJson(path.join(profiles,"plugins.json"),true);
  const upstream=readJson(path.join(profiles,"mcp-upstream.json"),true);
  if(plugins&&(!Array.isArray(plugins.skills)||![1,2].includes(Number(plugins.schema_version)))) {
    throw Error("旧版 Skills 注册表格式不受支持，未执行迁移。");
  }
  if(upstream&&(!Array.isArray(upstream.servers)||Number(upstream.version)!==1)) {
    throw Error("旧版 MCP 配置格式不受支持，未执行迁移。");
  }
  const names=records.filter(row=>row.rel.startsWith("local-skills"+path.sep))
    .map(row=>row.rel.split(path.sep)[1]).filter(Boolean);
  const installed=[...new Set(names)];
  return { sourceDataDir:root,profiles,files:records,attachments,plugins,upstream,
    fingerprint:hash(Buffer.from(JSON.stringify([records,attachments]))),
    summary:{installedSkills:installed.length,registeredSkills:plugins?.skills.length||0,
      mcpServers:upstream?.servers.length||0,skillFiles:records.filter(r=>r.rel.startsWith("local-skills"+path.sep)).length,bytes:total,
      hasPlugins:Boolean(plugins),hasMcp:Boolean(upstream),
      hasCustomAudio:attachments.some(x=>x.rel.endsWith("custom.wav")),
      hasConversationNames:attachments.some(x=>x.rel.endsWith("conversation-index.json"))} };
}
function verify(snapshot) {
  const current=scan(snapshot.sourceDataDir);
  if(current.fingerprint!==snapshot.fingerprint)throw Error("旧版 Skills 或 MCP 文件在预览后变化，请重新预览；原数据未修改。");
  return current;
}
function normalizedRow(row,sourceProfiles) {
  if(!row||typeof row!=="object"||Array.isArray(row))throw Error("旧版 Skill 注册项无效。");
  const origin=String(row.id||row.name||"").trim().toLowerCase();
  if(!ID.test(origin))throw Error("旧版 Skill id 格式无效，导入已取消。");
  const localRoot=path.join(sourceProfiles,"local-skills");
  let source=row.source;
  if(typeof row.path==="string"&&path.isAbsolute(row.path)) {
    const relative=path.relative(localRoot,row.path);
    if(relative&&!path.isAbsolute(relative)&&relative!==".."&&!relative.startsWith(".."+path.sep))source="installed";
  }
  if(!["installed","builtin","external"].includes(source))source="external";
  const output={...row,id:origin,source,enabled:row.enabled!==false};
  if(source==="installed"||source==="builtin")delete output.path;
  if(source==="external") {
    if(typeof row.path!=="string"||!path.isAbsolute(row.path)||!fs.existsSync(row.path))throw Error("旧版外部 Skill 路径无效或不存在，不能宣称完整导入。");
    context.assertUnlinked(row.path);
  }
  return output;
}
function equal(a,b) {return JSON.stringify(a)===JSON.stringify(b);}
function mergeRegistries(source,existing,sourceProfiles) {
  const destination=existing||{schema_version:2,computer_use:{enabled:false},browser_use:{enabled:false},skills:[]};
  if(destination.schema_version!==2||!Array.isArray(destination.skills))throw Error("新版 Skills 注册表格式无效，未覆盖。");
  const sourceRows=source.skills.map(row=>normalizedRow(row,sourceProfiles));
  const seen=new Map(destination.skills.map(row=>[String(row.id).toLowerCase()+"|"+row.source,row]));
  const result=[...destination.skills];
  for(const row of sourceRows) {
    const key=row.id+"|"+row.source,old=seen.get(key);
    if(old) {
      if(!equal(old,row))throw Error("Skill「"+row.id+"」与新版已有注册状态不同，请先解决冲突；旧数据未修改。");
      continue;
    }
    result.push(row);
    seen.set(key,row);
  }
  const noExisting= !existing || (existing.skills.length===0&&!existing.computer_use?.enabled&&!existing.browser_use?.enabled);
  const flags={computer_use:{enabled:noExisting?source.computer_use?.enabled===true:destination.computer_use?.enabled===true},
    browser_use:{enabled:noExisting?source.browser_use?.enabled===true:destination.browser_use?.enabled===true}};
  if(!noExisting &&
    (source.computer_use?.enabled===true&&!flags.computer_use.enabled ||
     source.browser_use?.enabled===true&&!flags.browser_use.enabled))throw Error("旧版内置工具开关与新版设置冲突，请先确认后重试。");
  return {...destination,...flags,schema_version:2,skills:result};
}
function mergeMcp(source,existing) {
  if(!source||!Array.isArray(source.servers))throw Error("旧版 MCP 配置无效。");
  if(!existing)return source;
  if(existing.version!==1||!Array.isArray(existing.servers))throw Error("新版 MCP 配置格式无效，未覆盖。");
  const result=[...existing.servers];
  const key=row=>String(row?.id||row?.name||row?.url||"").trim();
  for(const row of source.servers) {
    const id=key(row);
    if(!id)throw Error("旧版 MCP 服务缺少稳定标识，已阻止不安全合并。");
    const old=result.find(item=>key(item)===id);
    if(old) {
      if(!equal(old,row))throw Error("MCP 服务「"+id+"」与新版不同，未自动覆盖，请先解决冲突。");
    } else result.push(row);
  }
  return {...existing,servers:result};
}
function targetSnapshot(file) {
  context.assertUnlinked(file);
  try {
    if (!fs.lstatSync(file).isFile()) throw Error("迁移目标不是普通文件。");
    const bytes=fs.readFileSync(file);
    return { existed:true, sha256:hash(bytes), bytes };
  } catch(error) { if(error.code==="ENOENT") return { existed:false }; throw error; }
}
function makePlan(snapshot,targetDataDir) {
  verify(snapshot);
  const target=context.assertUnlinked(targetDataDir),root=path.join(target,"runtime","profiles");
  const changes=[];
  for(const item of snapshot.attachments||[]) {
    const src=inside(snapshot.sourceDataDir,path.join(snapshot.sourceDataDir,item.rel));
    const dst=inside(target,path.join(target,item.rel));
    if(fs.existsSync(dst)) {
      if(!fs.lstatSync(dst).isFile()||hash(fs.readFileSync(dst))!==item.sha256)
        throw Error("新版已有不同的会话标签或自定义提示音；已拒绝自动覆盖："+item.rel);
    } else {
      const data=fs.readFileSync(src);
      if(hash(data)!==item.sha256)throw Error("旧版会话标签或提示音在预览后发生变化。");
      changes.push({file:dst,data,sourceHash:item.sha256,expected:{existed:false}});
    }
  }
  for(const file of snapshot.files.filter(f=>f.rel.startsWith("local-skills"+path.sep))) {
    const sourceFile=inside(snapshot.profiles,path.join(snapshot.profiles,file.rel));
    const targetFile=inside(root,path.join(root,file.rel));
    if(fs.existsSync(targetFile)) {
      const st=fs.lstatSync(targetFile);
      if(!st.isFile()||hash(fs.readFileSync(targetFile))!==file.sha256)
        throw Error("已安装 Skill 文件发生冲突，未覆盖："+file.rel);
    } else {
      const data=fs.readFileSync(sourceFile);
      if(hash(data)!==file.sha256)throw Error("旧版 Skill 在规划复制期间变化，请重新预览。");
      changes.push({file:targetFile,data,sourceHash:file.sha256,expected:{existed:false}});
    }
  }
  for (const [source,name,merge] of [[snapshot.plugins,"plugins.json",(source,existing)=>mergeRegistries(source,existing,snapshot.profiles)],
    [snapshot.upstream,"mcp-upstream.json",mergeMcp]]) {
    if (!source) continue;
    const p=inside(target,path.join(root,name)), snap=targetSnapshot(p);
    let existing=null;
    if (snap.existed) {
      if (snap.bytes.length>2*1024*1024) throw Error("新版配置体积异常。");
      try { existing=JSON.parse(snap.bytes.toString("utf8")); } catch { throw Error("新版配置 JSON 无效。"); }
      if (!existing || typeof existing!=="object" || Array.isArray(existing)) throw Error("新版配置不是对象。");
    }
    const merged=merge(source,existing);
    if (!snap.existed || !equal(merged,existing)) changes.push({file:p,data:Buffer.from(JSON.stringify(merged,null,2)+"\n"),expected:{existed:snap.existed,...(snap.existed?{sha256:snap.sha256}:{})}});
  }
  return {changes,summary:snapshot.summary};
}
module.exports={scan,verify,makePlan};
