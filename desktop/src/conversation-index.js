"use strict";
// Account-scoped, bounded display metadata. This is NOT a ChatGPT conversation
// history cache and never stores prompts, response bodies or raw host sessions.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const context = require("./account-context");

const CONVERSATION_ID = /^oai_conv_[a-f0-9]{32}$/;
const AUTO_MAX = 200;
const PINNED_MAX = 50;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const FILE_MAX_BYTES = 1024 * 1024;
const WRITE_INTERVAL_MS = 60 * 60 * 1000;
const DISPLAY_MAX = 40;
const NAME_FILE = "conversation-index.json";

function titleOf(value) {
  if (typeof value !== "string") return "";
  let title = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ").trim();
  if (!title || /(?:api[_-]?key|bearer|token|password|secret|授权码|密钥|密码)\s*[:=]/i.test(title) ||
      /(?:https?:\/\/|[a-z]:\\|\\\\|sk-[a-z0-9]{12,}|-----BEGIN)/i.test(title)) return "";
  title = [...title].slice(0, DISPLAY_MAX).join("");
  return title;
}

function newState() { return { schema: 2, nextNumber: 1, records: [] }; }
function checkId(id) {
  if (!CONVERSATION_ID.test(id)) throw new Error("无法可靠识别当前会话，未保存备注。");
  return id;
}
function relativeFile(root) {
  const base = context.assertUnlinked(path.resolve(root));
  const file = context.assertUnlinked(path.join(base, "runtime", "profiles", NAME_FILE));
  const rel = path.relative(base, file);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("会话索引路径超出当前账号。");
  return file;
}
function validateRecord(record) {
  return record && typeof record === "object" && CONVERSATION_ID.test(record.id) &&
    Number.isSafeInteger(record.number) && record.number > 0 &&
    Number.isFinite(record.createdAt) && Number.isFinite(record.lastAt) &&
    typeof record.title === "string" && record.title.length <= DISPLAY_MAX * 2 &&
    typeof record.alias === "string" && record.alias.length <= DISPLAY_MAX * 2 &&
    typeof record.pinned === "boolean";
}
function load(file) {
  if (!fs.existsSync(file)) return newState();
  context.assertUnlinked(file);
  if (fs.lstatSync(file).size > FILE_MAX_BYTES) throw new Error("会话显示索引超过限额，未覆盖旧文件。");
  let state;
  try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("会话显示索引损坏，未覆盖旧文件。"); }
  if (![1, 2].includes(state?.schema) || !Number.isSafeInteger(state.nextNumber) || state.nextNumber < 1 ||
      !Array.isArray(state.records) || !state.records.every(validateRecord)) {
    throw new Error("会话显示索引格式不支持，未覆盖旧文件。");
  }
  if (new Set(state.records.map(r => r.id)).size !== state.records.length ||
      new Set(state.records.map(r => r.number)).size !== state.records.length) {
    throw new Error("会话显示索引含重复身份，未覆盖旧文件。");
  }
  if (state.schema === 1) {
    return { ...state, schema: 2, migratedFrom: 1, records: state.records.map(record => ({
      ...record, originalId: record.id, identitySource: "legacy-unknown", identityVersion: 1,
    })) };
  }
  return state;
}
function prune(state, now) {
  const records = state.records.filter(r => r.pinned || (r.lastAt <= now && now - r.lastAt < TTL_MS));
  const newest = (a,b) => (b.lastAt - a.lastAt) || (b.number - a.number);
  const pinned = records.filter(r => r.pinned).sort(newest).slice(0, PINNED_MAX);
  const rest = records.filter(r => !r.pinned).sort(newest).slice(0, AUTO_MAX);
  const limited = [...pinned, ...rest];
  // Avoid an unbounded file even if future metadata fields are added.
  while (Buffer.byteLength(JSON.stringify({ ...state, records: limited })) > FILE_MAX_BYTES && limited.length) {
    const drop = limited.findIndex(r => !r.pinned);
    if (drop < 0) break;
    limited.splice(drop, 1);
  }
  return { ...state, schema: 2, nextNumber: state.nextNumber, records: limited.sort((a,b)=>a.number-b.number) };
}
function publish(file, state) {
  const dir=path.dirname(file);
  context.assertUnlinked(dir);
  fs.mkdirSync(dir,{recursive:true});
  context.assertUnlinked(file);
  // Preserve the exact prior format once; never infer identity aliases from
  // titles, timing, language or transport IDs during this schema migration.
  if (fs.existsSync(file)) {
    const original = fs.readFileSync(file);
    if (JSON.parse(original.toString("utf8")).schema === 1) {
      const backup = file + ".v1.backup";
      context.assertUnlinked(backup);
      try { fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  }
  const bytes=Buffer.from(JSON.stringify(state,null,2)+"\n");
  if(bytes.length>FILE_MAX_BYTES) throw new Error("会话索引容量已满，请清理收藏记录。");
  const temp=file+"."+process.pid+"."+crypto.randomBytes(6).toString("hex")+".tmp";
  try {
    fs.writeFileSync(temp,bytes,{flag:"wx",mode:0o600});
    fs.renameSync(temp,file);
  } finally {
    if (fs.existsSync(temp)) fs.rmSync(temp,{force:true});
  }
}
class ConversationIndex {
  constructor({ rootFor, now = Date.now } = {}) {
    if (typeof rootFor !== "function") throw Error("Missing account root provider");
    this.rootFor=rootFor; this.now=now;
  }
  file(accountId) { return relativeFile(this.rootFor(accountId)); }
  observe(accountId, conversationId, { hint, at, tool, identitySource, identityVersion } = {}) {
    checkId(conversationId);
    const file=this.file(accountId),now=this.now(),current=load(file);
    const state=prune(current,now);
    let record=state.records.find(r=>r.id===conversationId);
    const proposed=titleOf(hint);
    let dirty = state.records.length!==current.records.length;
    if(!record) {
      record={id:conversationId,number:state.nextNumber++,title:proposed,alias:"",
        createdAt:now,lastAt:now,pinned:false,lastTool:"",originalId:conversationId,
        identitySource:identitySource === "openai/session" ? identitySource : "unspecified",
        identityVersion:identitySource === "openai/session" && identityVersion === 2 ? 2 : 1};
      state.records.push(record);dirty=true;
    } else if(proposed && !record.title && !record.alias) { record.title=proposed;dirty=true; }
    if(typeof tool==="string" && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(tool) && record.lastTool!==tool) {
      record.lastTool=tool;dirty=true;
    }
    if(now-record.lastAt>=WRITE_INTERVAL_MS) {record.lastAt=now;dirty=true;}
    const after=prune(state,now);
    if(dirty)publish(file,after);
    const result=after.records.find(r=>r.id===conversationId);
    return result?this.format(result):{display:"会话未识别"};
  }
  format(record) {
    const date=new Date(record.createdAt),day=(date.getMonth()+1)+"月"+date.getDate()+"日";
    const number=String(record.number).padStart(2,"0");
    return {number:record.number,id:record.id,display:"会话 "+number+(record.alias||record.title?"「"+(record.alias||record.title)+"」":" · "+day),
      title:record.alias||record.title,source:record.alias?"manual":record.title?"task":"number",
      pinned:record.pinned,lastAt:record.lastAt,lastTool:record.lastTool||"",
      identitySource:record.identitySource || "legacy-unknown",identityVersion:record.identityVersion || 1,
      originalId:record.originalId || record.id};
  }
  lookup(accountId,conversationId) {
    if(!CONVERSATION_ID.test(conversationId||"")) return null;
    const state=load(this.file(accountId)),record=state.records.find(r=>r.id===conversationId);
    if(!record||(!record.pinned && this.now()-record.lastAt>=TTL_MS))return null;
    return this.format(record);
  }
  list(accountId) {
    return prune(load(this.file(accountId)),this.now()).records
      .slice().sort((a,b)=>(b.lastAt-a.lastAt)||(b.number-a.number)).map(r=>this.format(r));
  }
  rename(accountId,conversationId,alias) {
    checkId(conversationId);
    if(typeof alias!=="string"||(!titleOf(alias)&&alias.trim())) throw new Error("备注名称包含不安全的内容。");
    const file=this.file(accountId),state=prune(load(file),this.now());
    const record=state.records.find(r=>r.id===conversationId);
    if(!record)throw Error("未找到这个账号中的会话记录。");
    record.alias=titleOf(alias);publish(file,state);return this.format(record);
  }
  pin(accountId,conversationId,enabled) {
    checkId(conversationId);
    const file=this.file(accountId),state=prune(load(file),this.now());
    const record=state.records.find(r=>r.id===conversationId);
    if(!record)throw Error("未找到会话。");
    if(enabled && !record.pinned && state.records.filter(r=>r.pinned).length>=PINNED_MAX)
      throw Error("最多收藏 50 条会话，请先取消旧收藏。");
    record.pinned=enabled===true;publish(file,prune(state,this.now()));return this.format(record);
  }
  cleanup(accountId,{clearUnpinned=false}={}) {
    const file=this.file(accountId),state=load(file);
    const after=clearUnpinned?{...state,records:state.records.filter(r=>r.pinned)}:prune(state,this.now());
    if(JSON.stringify(state)!==JSON.stringify(after))publish(file,after);
    return {removed:state.records.length-after.records.length,remaining:after.records.length};
  }
}
module.exports={ConversationIndex,titleOf,CONVERSATION_ID,TTL_MS,AUTO_MAX,PINNED_MAX,FILE_MAX_BYTES};
