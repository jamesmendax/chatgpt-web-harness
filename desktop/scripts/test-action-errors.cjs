const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname + '/../renderer/ui.js','utf8');
function harness() {
  const nodes = new Map(['mcp-action-error','tunnel-action-error'].map(x=>[x,{hidden:true,textContent:''}]));
  const state = {accountId:'a',status:{at:1,mcp:{pid:1},tunnel:{pid:2,instanceId:'old'}}};
  const context = vm.createContext({ctx:{state}, byId:id=>nodes.get(id), priorLabels:new Map(), Date:{now:()=>100,parse:Date.parse}});
  const section = source.slice(source.indexOf('  // Account/action records'),source.indexOf('  function ready(state, error)'));
  vm.runInContext('const actionButtons = {};\n'+section,context);
  return {context,nodes,state,run:s=>vm.runInContext(s,context)};
}
test('startAll/stopAll identify explicit failed service; unknown combined errors appear on both',()=>{
  const h=harness();
  h.run('pending("startAll",false,"Tunnel 未在 60 秒内就绪",ctx.state)');
  assert.equal(h.nodes.get('mcp-action-error').hidden,true);
  assert.match(h.nodes.get('tunnel-action-error').textContent,/全部服务操作/);
  h.run('pending("stopAll",false,"无法确认停止",ctx.state)');
  assert.match(h.nodes.get('mcp-action-error').textContent,/无法确认停止/);
  assert.match(h.nodes.get('tunnel-action-error').textContent,/无法确认停止/);
});
test('local startup timeout clears only on newer same-service healthy generation; cloud warning retained separately',()=>{
  const h=harness();h.run('pending("startTunnel",false,"Tunnel 未在 60 秒内就绪，请检查日志",ctx.state)');
  h.state.status={at:200,tunnel:{pid:2,instanceId:'old',ready:true,state:'running'}};
  h.run('renderActionErrors(ctx.state,ctx.state.status)');assert.equal(h.nodes.get('tunnel-action-error').hidden,false);
  h.state.status.tunnel={pid:3,instanceId:'new',ready:true,state:'running',cloudState:'error',metaError:{code:'poll_failed'}};
  h.run('renderActionErrors(ctx.state,ctx.state.status)');assert.equal(h.nodes.get('tunnel-action-error').hidden,true);
  assert.equal(h.state.status.tunnel.cloudState,'error');
});
test('auth/config errors survive unrelated recovery; account records remain isolated',()=>{
  const h=harness();h.run('pending("startTunnel",false,"认证失败401",ctx.state); pending("startMcp",true); pending("startMcp",false)');
  h.state.status={at:200,tunnel:{pid:3,instanceId:'new',ready:true,state:'running'}};
  h.run('renderActionErrors(ctx.state,ctx.state.status)');assert.match(h.nodes.get('tunnel-action-error').textContent,/401/);
  h.state.accountId='b';h.run('renderActionErrors(ctx.state,ctx.state.status)');assert.equal(h.nodes.get('tunnel-action-error').hidden,true);
  h.run('pending("startTunnel",false,"旧账号返回错误",{accountId:"a",status:{}})');assert.equal(h.nodes.get('tunnel-action-error').hidden,true);
  h.state.accountId='a';h.run('renderActionErrors(ctx.state,ctx.state.status)');assert.match(h.nodes.get('tunnel-action-error').textContent,/401/);
});
test('matching retry clears prior auth error; failed retry restores error without clearing unrelated action',()=>{
  const h=harness();
  h.run('pending("startAll",false,"Tunnel 认证失败401",ctx.state); pending("startTunnel",false,"认证失败401",ctx.state)');
  h.run('pending("startTunnel",true); pending("startTunnel",false)');
  assert.match(h.nodes.get('tunnel-action-error').textContent,/全部服务操作/);
  assert.equal(h.nodes.get('tunnel-action-error').textContent.split('\n').length,1);
  h.run('pending("startAll",true); pending("startAll",false)');
  assert.equal(h.nodes.get('tunnel-action-error').hidden,true);
  h.state.status={at:200,tunnel:{pid:3,instanceId:'new',ready:true,state:'running',cloudState:'error',authError:{code:'authentication_failed'}}};
  h.run('pending("startTunnel",false,"认证失败401 重试失败",ctx.state)');
  assert.match(h.nodes.get('tunnel-action-error').textContent,/重试失败/);
  assert.equal(h.state.status.tunnel.cloudState,'error');
  assert.ok(h.state.status.tunnel.authError);
});
test('stale account failures are excluded at app action boundary',()=>{
  const app=fs.readFileSync(__dirname+'/../renderer/app.js','utf8');
  assert.match(app,/err.code !== "STALE_ACCOUNT_RESPONSE" && state.accountId === actionScope.accountId/);
});
