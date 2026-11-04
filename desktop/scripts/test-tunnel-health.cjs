"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const {probeTunnel,readLoopback,parseManagedDiagnostic}=require("../src/tunnel-health");
const now=1788868800000;
const defaultMeta={client_instance_id:"instance-current",control_plane_tunnel_id:"tunnel_fixture",started_at:new Date(now-120000).toISOString(),control_plane_poll_timeout:"30s",control_plane_poll_deadline_guardrail:"5s",control_plane_route:{route_mode:"proxy",proxy_source:"control-plane.http-proxy",proxy_url:"http://127.0.0.1:7890"}};
function sample(at){return 'commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane",otel_scope_schema_url="",otel_scope_version=""} '+(at/1000)+'\n';}
function failure(at,error="unexpected EOF",overrides={}){return {seq:1,time:new Date(at).toISOString(),level:"WARN",message:"poll failed; backing off",attrs:{component:"controlplane",client_instance_id:"instance-current",tunnel_id:"tunnel_fixture",error,...overrides}};}
async function fixture(run){
 const data={ready:"ready",meta:{...defaultMeta},metric:sample(now-10000),events:[],logsStatus:200,statusCalls:0};
 const server=http.createServer((req,res)=>{
   if(req.url==="/abort"){res.writeHead(200,{"content-length":"1000"});res.write("partial");setTimeout(()=>res.destroy(),5);return;}
   if(req.url==="/hang"){return;}
   if(req.url==="/large"){res.end("x".repeat(4096));return;}
   if(req.url==="/redirect"){res.writeHead(302,{Location:"http://example.com"});res.end();return;}
   if(req.url==="/readyz"){res.end(data.ready);return;}
   if(req.url==="/api/status"){data.statusCalls++;res.end(JSON.stringify(data.confirmMeta&&data.statusCalls%2===0?data.confirmMeta:data.meta));return;}
   if(req.url==="/metrics"){res.writeHead(data.metricsStatus||200);res.end(data.metric);return;}
   if(req.url==="/api/logs"){res.writeHead(data.logsStatus);res.end(JSON.stringify({events:data.events}));return;}
   res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;
 try{await run(data,options=>probeTunnel(port,{now,expectedTunnelId:"tunnel_fixture",...options}),port);}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test("fresh real poll metric plus local ready proves online",()=>fixture(async(data,probe)=>{const result=await probe();assert.equal(result.ready,true);assert.equal(result.cloudState,"online");assert.equal(result.lastPollSuccessAt,now-10000);assert.deepEqual(result.proxyRoute,{mode:"proxy",source:"control-plane.http-proxy",url:"http://127.0.0.1:7890"});}));
test("local ready and metadata alone cannot prove cloud online",()=>fixture(async(data,probe)=>{data.metric="";data.events=[{message:"tunnel metadata fetched",time:new Date(now-1000).toISOString()}];assert.equal((await probe()).cloudState,"unknown");data.metric=sample(0);assert.equal((await probe()).cloudState,"connecting");}));
test("not ready is not matched as ready",()=>fixture(async(data,probe)=>{data.ready="not ready";assert.equal((await probe()).ready,false);}));
test("EOF warns without misreporting authentication",()=>fixture(async(data,probe)=>{data.events=[failure(now-3000)];const result=await probe();assert.equal(result.cloudState,"error");assert.match(result.metaError.line,/unexpected EOF/);assert.equal(result.authError,null);}));
test("401 and 403 are distinct authentication failures",()=>fixture(async(data,probe)=>{for(const text of ["status=401 unauthorized","HTTP 403 Forbidden","invalid_api_key"]){data.events=[failure(now-3000,text)];const result=await probe();assert.equal(result.cloudState,"error");assert.ok(result.authError);}}));
test("actual later successful poll clears prior failure but same second does not",()=>fixture(async(data,probe)=>{data.events=[failure(now-5000)];data.metric=sample(now-1000);assert.equal((await probe()).cloudState,"online");data.metric=sample(now-5000+500);assert.equal((await probe()).cloudState,"error");data.events=[failure(now-100)];assert.equal((await probe()).cloudState,"error");}));
test("old success is stale even when local ready",()=>fixture(async(data,probe)=>{data.metric=sample(now-100000);assert.equal((await probe()).cloudState,"stale");}));
test("failure from other instance or tunnel cannot contaminate snapshot",()=>fixture(async(data,probe)=>{data.events=[failure(now-1000,"unexpected EOF",{client_instance_id:"old"}),failure(now-1000,"unexpected EOF",{tunnel_id:"other"})];assert.equal((await probe()).cloudState,"online");}));
test("old success before daemon restart is rejected",()=>fixture(async(data,probe)=>{data.meta.started_at=new Date(now-5000).toISOString();assert.equal((await probe()).cloudState,"connecting");}));
test("configured Tunnel ID mismatch refuses cloud-online claim",()=>fixture(async(data,probe)=>{data.meta.control_plane_tunnel_id="tunnel_other";const result=await probe();assert.equal(result.cloudState,"error");assert.equal(result.metaError.code,"tunnel_mismatch");}));
test("port reuse during snapshot invalidates mixed-generation success",()=>fixture(async(data,probe)=>{data.confirmMeta={...data.meta,client_instance_id:"replacement"};const result=await probe();assert.equal(result.cloudState,"unknown");assert.equal(result.lastPollSuccessAt,null);}));
test("unavailable metrics or logs fail closed without inventing online",()=>fixture(async(data,probe)=>{data.metricsStatus=404;assert.equal((await probe()).cloudState,"unknown");data.metricsStatus=200;data.logsStatus=404;assert.equal((await probe()).cloudState,"unknown");}));
test("managed fallback works without status API and later metric clears it",()=>fixture(async(data,probe)=>{const item=parseManagedDiagnostic('16:00:00 ! time='+new Date(now-5000).toISOString()+' level=WARN msg="poll failed; backing off" component=controlplane client_instance_id=instance-current tunnel_id=tunnel_fixture error="unexpected EOF"');assert.ok(item);data.meta=null;assert.equal((await probe({managedDiagnostics:[item]})).cloudState,"error");data.meta={...defaultMeta};data.metric=sample(now-1000);assert.equal((await probe({managedDiagnostics:[item]})).cloudState,"online");}));
test("v0.0.14 managed 401 survives a failed local startup generation",()=>fixture(async(data,probe)=>{const line='16:00:00 ! time='+new Date(now-3000).toISOString()+' level=WARN msg="poll failed; backing off" component=controlplane client_instance_id=instance-current tunnel_id=tunnel_fixture status_code=401 status="401 Unauthorized" error_code=invalid_api_key error="controlplane client: unexpected status 401: invalid_api_key"';const item=parseManagedDiagnostic(line);assert.ok(item);assert.equal(item.kind,"authError");data.meta=null;data.ready="not ready";data.metric="";data.logsStatus=404;const result=await probe({managedStartedAt:now-10000,managedDiagnostics:[item]});assert.equal(result.ready,false);assert.equal(result.cloudState,"error");assert.equal(result.authError.code,"authentication_failed");assert.doesNotMatch(result.authError.line,/api key provided/i);}));
test("managed JSON diagnostic is sanitized and ignores MCP OAuth errors",()=>{const item=parseManagedDiagnostic('16:00:00   '+JSON.stringify({time:new Date(now-5000).toISOString(),level:"WARN",msg:"poll failed; backing off",component:"controlplane",error:"unexpected EOF sk-secretfixture https://api.openai.com/private?key=secret",client_instance_id:"instance-current"}));assert.ok(item);assert.doesNotMatch(item.line,/sk-secretfixture|key=secret/);assert.equal(parseManagedDiagnostic('time='+new Date(now).toISOString()+' level=WARN component=oauth msg="OAuth discovery failed" error="Unauthorized"'),null);});
test("proxy origin is sanitized including SOCKS5",()=>fixture(async(data,probe)=>{data.meta.control_plane_route.proxy_url="http://user:secret@127.0.0.1:7890/private?key=secret";assert.equal((await probe()).proxyRoute.url,"http://127.0.0.1:7890");data.meta.control_plane_route.proxy_url="socks5://localhost:1080";assert.equal((await probe()).proxyRoute.url,"socks5://localhost:1080");}));
test("malformed/future/foreign-scoped metrics never prove success",()=>fixture(async(data,probe)=>{for(const text of [sample(now+10000),sample(NaN),sample(now-1000).replace('scope_name="controlplane"','scope_name="other"'),sample(now-1000).replace('otel_scope_name="controlplane"','tunnel_id="other"')]){data.metric=text;assert.notEqual((await probe()).cloudState,"online");}}));
test("loopback deadline, abort, limit, redirects and invalid ports are bounded",()=>fixture(async(data,probe,port)=>{assert.equal((await readLoopback(port,"/hang",{timeoutMs:30})).error,"timeout");assert.ok((await readLoopback(port,"/abort",{timeoutMs:300})).error);assert.equal((await readLoopback(port,"/large",{maxBytes:256})).error,"response_too_large");assert.equal((await readLoopback(port,"/redirect")).status,302);assert.equal((await readLoopback(99999,"/health")).error,"invalid_port");}));
const bloat = 'unrelated_histogram_bucket{route="fixture",le="1"} 1\n'.repeat(9000);
test("large scrape reproduces old cap and streaming selection recovers only after newer poll",()=>fixture(async(data,probe,port)=>{
 data.metric=bloat+sample(now-1000);data.events=[failure(now-5000)];
 assert.ok(Buffer.byteLength(data.metric)>256*1024);
 assert.equal((await readLoopback(port,"/metrics",{maxBytes:256*1024})).error,"response_too_large");
 const filtered=await readLoopback(port,"/metrics",{selectPollMetric:true});assert.equal(filtered.error,null);assert.ok(filtered.text.length<1024);
 let result=await probe();assert.equal(result.cloudState,"online");assert.equal(result.lastPollSuccessAt,now-1000);assert.equal(result.metaError,null);
 for(const error of ["unexpected EOF","HTTP 401 Unauthorized"]){data.events=[failure(now-500,error)];result=await probe();assert.equal(result.cloudState,"error");assert.ok(error.includes("401")?result.authError:result.metaError);}
}));
test("large missing, over-budget, overlong and excessive gauge bodies fail safe",()=>fixture(async(data,probe)=>{
 for(const text of [bloat,'x'.repeat(17*1024*1024)+sample(now-1000),'commands_poll_last_successful_timestamp_seconds'+ ' '.repeat(17000)+(now/1000)+'\n',sample(now-1000).repeat(2000)]){
  data.metric=text;assert.notEqual((await probe()).cloudState,"online");
 }
}));
test("streamed metric selection handles split lines, tail without newline and slow drip deadline",async()=>{
 const server=http.createServer((req,res)=>{if(req.url==='/split'){res.write('unrelated 1\ncommands_poll_last_successful_time');setTimeout(()=>res.end('stamp_seconds '+(now/1000)),5);}else{res.write('unrelated 1\n');const timer=setInterval(()=>res.write('unrelated 2\n'),5);res.on('close',()=>clearInterval(timer));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
 try{const split=await readLoopback(port,'/split',{selectPollMetric:true});assert.equal(split.error,null);assert.match(split.text,/timestamp_seconds/);const start=Date.now();const drip=await readLoopback(port,'/drip',{selectPollMetric:true,timeoutMs:40});assert.equal(drip.error,'timeout');assert.equal(drip.text,'');assert.ok(Date.now()-start<1000);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test("v0.0.14 poll timed out overrides older success and only later poll clears it",()=>fixture(async(data,probe)=>{
 data.events=[{...failure(now-5000,"context deadline exceeded"),message:"poll timed out; backing off"}];
 data.metric=sample(now-10000);let result=await probe();assert.equal(result.cloudState,"error");assert.equal(result.metaError.code,"poll_failed");assert.match(result.metaError.line,/timeout/);
 data.metric=sample(now-1000);result=await probe();assert.equal(result.cloudState,"online");assert.equal(result.metaError,null);
}));
