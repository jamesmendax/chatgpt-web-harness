"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const dir=path.resolve(__dirname,'../renderer/v3/aura');
const policyCode=fs.readFileSync(path.join(dir,'quality.js'),'utf8'),sceneCode=fs.readFileSync(path.join(dir,'scene.js'),'utf8');
const policyContext={};vm.runInNewContext(policyCode,policyContext);const Q=policyContext.AuraQuality;

test('four honest quality budgets; no user explanation strings',()=>{
  assert.deepEqual(Object.keys(Q.tiers),['ultra','high','standard','static']);
  assert.deepEqual(Object.values(Q.tiers).map(x=>x.label),['极致','高','普通','节能']);
  assert.equal(Q.tiers.static.pixels,0);assert.equal(Q.tiers.static.idleFps,0);
  assert.ok(Q.tiers.ultra.pixels>=Q.tiers.high.pixels&&Q.tiers.high.pixels>Q.tiers.standard.pixels);
  for(const t of Object.values(Q.tiers)){assert.ok(t.pixels<=8294400);assert.ok(t.activeFps<=60);assert.ok(Object.isFrozen(t));}
});
test('high pins the original visual baseline; ultra adds opaque choreography, ordinary removes screen glow',()=>{
  const {ultra,high,standard,static:still}=Q.tiers;
  assert.deepEqual([high.edge,high.halo,high.ripple,high.detail,high.speed,high.dpr,high.pixels],
    [1,1,1,4,1,2,8294400], 'High is not a downgraded original');
  assert.equal(high.glass,0);assert.equal(ultra.glass,0);assert.equal(ultra.motion,1);
  assert.ok(ultra.halo<=high.halo,'Ultra improves state choreography instead of adding bloom');
  assert.equal(standard.edge,0);assert.equal(standard.halo,0);assert.equal(standard.ripple,0);
  assert.ok(standard.speed>0);assert.equal(still.speed,0);
  assert.match(sceneCode,/uniform vec4 uEffects/);
  assert.match(sceneCode,/uniform float uUltra/);
  assert.match(sceneCode,/vec4 animatedOriginal\(/);
  assert.match(sceneCode,/vec3 selectedOriginal\(/);
  assert.doesNotMatch(sceneCode,/refract\(/);
  assert.match(fs.readFileSync(path.join(dir,'app.js'),'utf8'),/frameState\.visual = currentTier\(\)/);
});
test('persistent preference is bounded, invalid or unavailable storage defaults to high',()=>{
  const store=new Map(),s={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
  assert.equal(Q.read(s),'high');for(const key of Object.keys(Q.tiers)){assert.equal(Q.save(s,key),true);assert.equal(Q.read(s),key);}
  store.set(Q.KEY,'__proto__');assert.equal(Q.read(s),'high');assert.equal(Q.read(null),'high');assert.equal(Q.save(null,'ultra'),false);
});
test('independent curtain starts at original High/Ultra setting and persists a manual choice across tiers',()=>{
  const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
  let preference=Q.readCurtain(storage);
  assert.equal(preference,null);
  assert.deepEqual(['ultra','high','standard','static'].map(t=>Q.curtainEnabled(preference,t)),[true,true,false,false]);
  assert.equal(Q.saveCurtain(storage,true),true);
  preference=Q.readCurtain(storage);
  for(const name of Object.keys(Q.tiers))assert.equal(Q.curtainEnabled(preference,name),true);
  assert.equal(Q.saveCurtain(storage,false),true);
  preference=Q.readCurtain(storage);
  for(const name of Object.keys(Q.tiers))assert.equal(Q.curtainEnabled(preference,name),false);
  store.set(Q.CURTAIN_KEY,'bad');assert.equal(Q.readCurtain(storage),null);
  assert.equal(Q.readCurtain(null),null);assert.equal(Q.saveCurtain(null,true),false);
});
test('10000 dynamic changes reuse one scene; 1000 static roundtrips release everything',()=>{
  let creates=0,releases=0,replaces=0;
  const owner=Q.createOwner({canvas:{},create:()=>{creates++;let gone=false;return{dispose(){assert.equal(gone,false);gone=true;releases++;}};},replace:()=>{replaces++;return{};}});
  const first=owner.enable(true);for(let i=0;i<10000;i++)assert.equal(owner.enable(true),first);
  assert.equal(creates,1);assert.equal(owner.status().live,1);
  for(let i=0;i<1000;i++){owner.enable(false);assert.equal(creates,releases);assert.equal(owner.status().live,0);owner.enable(true);assert.equal(creates-releases,1);}
  owner.destroy();owner.destroy();assert.equal(creates,releases);assert.equal(owner.enable(true),null);assert.equal(replaces,1000);
});
function fakeScene({pending=false,badLink=false,width=960,height=540}={}){
  let now=0,id=0,disabled=0;const timers=new Map(),events=new Map(),windowEvents=new Map(),uploaded=new Map();
  const resources={buffers:new Set(),programs:new Set(),shaders:new Set(),observers:new Set()};
  const create=type=>{const h={id:++id,type};resources[type].add(h);return h;};
  const del=(type,h)=>{assert.ok(resources[type].delete(h),'delete exactly once '+type);};
  const gl={FRAGMENT_SHADER:1,VERTEX_SHADER:2,LINK_STATUS:3,ARRAY_BUFFER:4,STATIC_DRAW:5,FLOAT:6,TRIANGLES:7,MAX_RENDERBUFFER_SIZE:8,
    createProgram:()=>create('programs'),createShader:()=>create('shaders'),createBuffer:()=>create('buffers'),
    deleteProgram:h=>del('programs',h),deleteShader:h=>del('shaders',h),deleteBuffer:h=>del('buffers',h),
    shaderSource(){},compileShader(){},attachShader(){},linkProgram(){},useProgram(){},bindBuffer(){},bufferData(){},getAttribLocation:()=>0,enableVertexAttribArray(){},vertexAttribPointer(){},
    getProgramParameter:(p,k)=>k===3?!badLink:!pending,getProgramInfoLog:()=> 'controlled link failure',getParameter:()=>8192,
    getUniformLocation:(p,n)=>n,uniform2f(){},uniform1f(n,v){uploaded.set(n,v);},uniform4fv(n,v){uploaded.set(n,Array.from(v));},viewport(){},drawArrays(){},isContextLost:()=>false,
    getExtension:name=>name==='KHR_parallel_shader_compile'?(pending?{COMPLETION_STATUS_KHR:9}:null):name==='WEBGL_lose_context'?{loseContext(){}}:null};
  const canvas={width:0,height:0,clientWidth:width,clientHeight:height,getContext:()=>gl,addEventListener:(n,f)=>events.set(n,f),removeEventListener:(n,f)=>{if(events.get(n)===f)events.delete(n);}};
  const global={devicePixelRatio:2,AuraMemoryGuard:{disable(){disabled++;}},addEventListener:(n,f)=>windowEvents.set(n,f),removeEventListener:(n,f)=>{if(windowEvents.get(n)===f)windowEvents.delete(n);},ResizeObserver:class{constructor(cb){this.cb=cb;resources.observers.add(this);}observe(){}disconnect(){resources.observers.delete(this);}}};
  const context={window:global,document:{documentElement:{classList:{add(){}}}},console:{error(){}},performance:{now:()=>now},setTimeout:(fn)=>{const key=++id;timers.set(key,fn);return key;},clearTimeout:key=>timers.delete(key)};
  vm.runInNewContext(sceneCode,context);const scene=global.AuraScene.create(canvas);
  const args={orb:[240,180,90,1],mood:[0,0,0,0],minis:[],on:1,active:0,pulse:0,night:0,dim:0,quality:1};
  return{scene,canvas,args,resources,events,windowEvents,timers,uploaded,get disabled(){return disabled;},advance(ms){now+=ms;for(const [key,fn]of Array.from(timers)){timers.delete(key);fn();}}};
}
test('changing visual effects reuses one shader program and uploads every tier',()=>{
  const f=fakeScene();f.scene.freeze(10);
  for(let i=0;i<120;i++)for(const name of ['ultra','high','standard']){
    const t=Q.tiers[name];f.args.visual=t;f.scene.draw(f.args);
    const u=f.uploaded.get('uEffects');
    [t.edge,t.halo,t.ripple,t.detail].forEach((x,n)=>assert.ok(Math.abs(u[n]-x)<.00001));
    assert.equal(f.uploaded.get('uUltra'),t.motion===1?1:0);
    assert.ok(Math.abs(f.uploaded.get('uTime')-10*t.speed)<.00001);
    assert.equal(f.resources.programs.size,1);assert.equal(f.resources.shaders.size,2);
  }
  f.scene.dispose();for(const v of Object.values(f.resources))assert.equal(v.size,0);
});
test('curtain toggle is a truly independent uniform; it never recompiles a shader or changes the pixel budget',()=>{
  const f=fakeScene();f.scene.freeze(12);
  for(let i=0;i<2000;i++){
    const mode=i%3===0?'standard':i%3===1?'high':'ultra';
    const on=i%2===0;
    Object.assign(f.args,{visual:Q.tiers[mode],curtain:on,dprCap:Q.tiers[mode].dpr,pixelBudget:Q.tiers[mode].pixels});
    assert.equal(f.scene.draw(f.args),true);
    assert.equal(f.uploaded.get('uEffects')[0],on?1:0);
    assert.equal(f.uploaded.get('uCurtainTime'),12);
    assert.ok(Math.abs(f.uploaded.get('uTime')-12*Q.tiers[mode].speed)<.00001);
    assert.equal(f.resources.programs.size,1);
    assert.equal(f.resources.buffers.size,1);
    assert.equal(f.resources.shaders.size,2);
  }
  f.scene.dispose();
  for(const v of Object.values(f.resources))assert.equal(v.size,0);
});
for(const tier of ['ultra','high','standard'])test(tier+' scene: exact GPU ownership, strict pixel bound, stable allocations across 5000 draws',()=>{
  const f=fakeScene({width:18000,height:10000}),t=Q.tiers[tier];Object.assign(f.args,{dprCap:t.dpr,pixelBudget:t.pixels,visual:t});
  for(let i=0;i<5000;i++)assert.equal(f.scene.draw(f.args),true);
  assert.ok(f.canvas.width*f.canvas.height<=t.pixels);
  assert.equal(f.resources.buffers.size,1);assert.equal(f.resources.programs.size,1);assert.equal(f.resources.shaders.size,2);assert.equal(f.resources.observers.size,1);
  assert.equal(f.scene.stats().resizes,1);
  const obsoleteLoss=f.events.get('webglcontextlost');f.scene.dispose();f.scene.dispose();obsoleteLoss({preventDefault(){}});
  assert.equal(f.disabled,0,'old async context loss must not disable new scene');
  for(const value of Object.values(f.resources))assert.equal(value.size,0);
  assert.equal(f.events.size,0);assert.equal(f.windowEvents.size,0);assert.equal(f.timers.size,0);assert.equal(f.scene.draw(f.args),false);
});
test('cancel pending compilation releases callback/timer/observer/shaders and cannot resurrect',()=>{
  const f=fakeScene({pending:true});let ready=0;const cancel=f.scene.whenReady(()=>ready++);assert.equal(f.timers.size,1);cancel();assert.equal(f.scene.stats().pending,0);
  f.scene.dispose();f.advance(12000);assert.equal(ready,0);assert.equal(f.timers.size,0);
  for(const v of Object.values(f.resources))assert.equal(v.size,0);
});
test('compiler timeout and failed shader link release all acquired resources',()=>{
  const f=fakeScene({pending:true});f.advance(11000);assert.equal(f.scene.stats().disposed,true);assert.equal(f.disabled,1);assert.equal(f.timers.size,0);
  for(const v of Object.values(f.resources))assert.equal(v.size,0);
  const broken=fakeScene({badLink:true});assert.equal(broken.scene,null);for(const v of Object.values(broken.resources))assert.equal(v.size,0);
});
test('static selection CSS and existing chips require no description elements',()=>{
  const app=fs.readFileSync(path.join(dir,'app.js'),'utf8');
  const start=app.indexOf('const qualityChips ='),end=app.indexOf('const remindInd',start),part=app.slice(start,end);
  assert.ok(start>=0&&end>start);assert.doesNotMatch(part,/h\("small"|say-help|title:/);assert.match(part,/role: "radio"/);
  assert.match(app,/id: "quality-row"/);assert.match(fs.readFileSync(path.join(dir,'aura.css'),'utf8'),/data-quality="static"/);
});
