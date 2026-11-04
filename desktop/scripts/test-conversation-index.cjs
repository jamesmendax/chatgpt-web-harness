"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {ConversationIndex,titleOf,TTL_MS,AUTO_MAX,PINNED_MAX,FILE_MAX_BYTES}=require("../src/conversation-index");
const id=i=>"oai_conv_"+i.toString(16).padStart(32,"0");
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"wh-conversations-fixture-"));
  let now=new Date(2026,10,4,8,0,0).getTime();
  const create=()=>new ConversationIndex({rootFor:account=>path.join(root,account),now:()=>now});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,create,advance:ms=>{now+=ms;},now:()=>now};
}
test("per-account numbering, first trusted task label and reload are stable",t=>{
  const f=fixture(t),a=f.create();
  assert.equal(a.observe("js",id(1),{hint:"SVG 动画制作",tool:"task_state"}).display,"会话 01「SVG 动画制作」");
  assert.equal(a.observe("js",id(2),{tool:"grep"}).display,"会话 02 · 11月4日");
  assert.equal(f.create().lookup("js",id(1)).source,"task");
  assert.equal(f.create().observe("other",id(1),{hint:"隔离账号"}).number,1);
  assert.equal(a.lookup("js",id(1)).title,"SVG 动画制作");
  assert.equal(a.lookup("other",id(1)).title,"隔离账号");
});
test("short id collisions do not mix records and unauthenticated prefixes cannot be stored",t=>{
  const f=fixture(t),a=f.create();
  const x="oai_conv_aaaaaaaa"+"1".repeat(24),y="oai_conv_aaaaaaaa"+"2".repeat(24);
  assert.equal(a.observe("acct",x).number,1);
  assert.equal(a.observe("acct",y).number,2);
  assert.throws(()=>a.observe("acct","aaaaaaaa"),/无法可靠识别/);
  assert.equal(a.lookup("acct","aaaaaaaa"),null);
  assert.equal(a.list("acct").length,2);
});
test("manually changed name wins over later automated task hints; malformed names rejected",t=>{
  const f=fixture(t),a=f.create();
  a.observe("acct",id(5),{hint:"原任务"});
  assert.equal(a.rename("acct",id(5),"修复账户导入").display,"会话 01「修复账户导入」");
  a.observe("acct",id(5),{hint:"其他任务"});
  assert.equal(a.lookup("acct",id(5)).title,"修复账户导入");
  for(const suspicious of ["https://chatgpt.com/c/123", "apiKey=secret", "sk-0123456789abcdef", "C:\\Users\\secret"]) {
    assert.equal(titleOf(suspicious),"");
    assert.throws(()=>a.rename("acct",id(5),suspicious),/不安全/);
  }
  assert.equal(a.lookup("acct",id(5)).title,"修复账户导入");
});
test("expired auto entries prune but pinned entries remain until explicit clear",t=>{
  const f=fixture(t),a=f.create();
  a.observe("acct",id(1));a.observe("acct",id(2));
  a.pin("acct",id(1),true);
  f.advance(TTL_MS+1);
  assert.equal(a.lookup("acct",id(2)),null);
  assert.equal(a.cleanup("acct").removed,1);
  assert.equal(a.list("acct").length,1);
  assert.equal(a.cleanup("acct",{clearUnpinned:true}).remaining,1);
  a.pin("acct",id(1),false);
  assert.equal(a.cleanup("acct").remaining,0);
});
test("a thousand synthetic observations cannot grow auto cache without bound",t=>{
  const f=fixture(t),a=f.create();
  for(let n=1;n<=1000;n++)a.observe("acct",id(n),{tool:"grep"});
  assert.equal(a.list("acct").length,AUTO_MAX);
  assert.equal(a.list("acct")[0].number,1000);
  assert.equal(a.list("acct").at(-1).number,801);
  const recordFile=path.join(f.root,"acct","runtime","profiles","conversation-index.json");
  assert.ok(fs.statSync(recordFile).size<FILE_MAX_BYTES);
  assert.equal(f.create().list("acct").length,AUTO_MAX);
});
test("pin limit is enforced and clear unpinned never removes explicitly saved entries",t=>{
 const f=fixture(t),a=f.create();
 for(let n=1;n<=PINNED_MAX+1;n++)a.observe("acct",id(n));
 for(let n=1;n<=PINNED_MAX;n++)a.pin("acct",id(n),true);
 assert.throws(()=>a.pin("acct",id(PINNED_MAX+1),true),/50/);
 assert.equal(a.cleanup("acct",{clearUnpinned:true}).remaining,PINNED_MAX);
 assert.equal(a.list("acct").length,PINNED_MAX);
});
test("corrupt existing index is not overwritten, and full text never stored",t=>{
 const f=fixture(t),a=f.create(),p=path.join(f.root,"acct","runtime","profiles","conversation-index.json");
 fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,"corrupt important data");
 assert.throws(()=>a.observe("acct",id(1)),/损坏/);
 assert.equal(fs.readFileSync(p,"utf8"),"corrupt important data");
 const b=f.create();
 b.observe("else",id(2),{hint:"安全检查"});
 const raw=fs.readFileSync(path.join(f.root,"else","runtime","profiles","conversation-index.json"),"utf8");
 assert.doesNotMatch(raw,/api[_-]?key|firstPrompt|messageBody|promptText/);
});
