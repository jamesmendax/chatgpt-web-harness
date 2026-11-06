import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {gzipSync} from 'node:zlib';
import http from 'node:http';
import net from 'node:net';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.resolve(process.env.HARNESS_TRANSFER_DIST||path.join(root,'dist'));
const {resolveFileProxy,parseWindowsFileProxy,validateFileProxy,fileProxyBypass,fetchFileResponse}=await import(pathToFileURL(path.join(dist,'lib/file-download-network.js')).href);
const target=new URL('https://files.oaiusercontent.com/');
const tests=[];
async function test(name,fn){try{await fn();tests.push({name,passed:true});console.log('PASS '+name)}catch(e){tests.push({name,passed:false,error:e.message});console.error('FAIL '+name+' '+e.stack)}}
const system={enabled:true,server:'127.0.0.1:7890',bypass:'localhost;*.example.org',pac:''};
await test('static-system-proxy-selected-without-global-mutation',async()=>{const env={};const a=https.globalAgent;assert.deepEqual(await resolveFileProxy(target,{env,platform:'win32',readSystem:async()=>system}),{mode:'proxy',source:'windows-system',url:'http://127.0.0.1:7890'});assert.deepEqual(env,{});assert.equal(https.globalAgent,a)});
await test('explicit-direct-respected-without-system-read',async()=>assert.equal((await resolveFileProxy(target,{env:{HARNESS_FILE_DOWNLOAD_PROXY:'direct'},platform:'win32',readSystem:()=>{throw Error('should not read')}})).mode,'direct'));
await test('explicit-proxy-precedes-environment',async()=>assert.equal((await resolveFileProxy(target,{env:{HARNESS_FILE_DOWNLOAD_PROXY:'http://127.0.0.1:8888',HTTPS_PROXY:'http://bad.example:9999'}})).url,'http://127.0.0.1:8888'));
await test('no-proxy-domain-and-port-respected',async()=>{assert.equal((await resolveFileProxy(target,{env:{HTTPS_PROXY:'http://127.0.0.1:7890',NO_PROXY:'.oaiusercontent.com:443'}})).mode,'direct');assert.equal(fileProxyBypass('files.oaiusercontent.com','443','.oaiusercontent.com:444'),false)});
await test('https-specific-system-proxy-used',async()=>assert.equal(parseWindowsFileProxy({...system,server:'http=127.0.0.1:8000;https=127.0.0.1:8001'},target).url,'http://127.0.0.1:8001'));
await test('http-only-system-rule-does-not-proxy-https',async()=>assert.equal(parseWindowsFileProxy({...system,server:'http=127.0.0.1:8000'},target).mode,'direct'));
await test('system-bypass-does-not-leak-to-other-domains',async()=>{assert.equal(parseWindowsFileProxy(system,new URL('https://a.example.org/')).mode,'direct');assert.equal(parseWindowsFileProxy(system,new URL('https://example.org.evil.test/')).mode,'proxy')});
// A PAC used to fail every download. It is read as text (never executed): its
// named proxy wins, then the manual proxy, then a direct attempt.
await test('PAC-uses-its-named-proxy-then-manual-then-direct',async()=>{
  const pac={...system,pac:'http://127.0.0.1:7890/pac'};
  assert.deepEqual(parseWindowsFileProxy(pac,target,'http://127.0.0.1:7891'),{mode:'proxy',source:'windows-pac',url:'http://127.0.0.1:7891'});
  assert.equal(parseWindowsFileProxy(pac,target).url,'http://127.0.0.1:7890');
  assert.equal(parseWindowsFileProxy({...pac,enabled:false},target).mode,'direct');
  assert.deepEqual(await resolveFileProxy(target,{env:{},platform:'win32',readSystem:async()=>({...pac,enabled:false}),readPacProxy:async()=>'http://127.0.0.1:7897'}),{mode:'proxy',source:'windows-pac',url:'http://127.0.0.1:7897'});
  assert.equal((await resolveFileProxy(target,{env:{},platform:'win32',readSystem:async()=>({...pac,enabled:false}),readPacProxy:async()=>{throw new Error('PAC unreachable')}})).mode,'direct');
});
await test('PAC-text-hint-reads-first-proxy-directive-without-running-it',async()=>{
  const {pacProxyHint}=await import(pathToFileURL(path.join(dist,'lib/file-download-network.js')).href);
  const file=path.join(root,'.validation','pac-hint-'+process.pid+'.pac');
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,'function FindProxyForURL(url,host){ if (isPlainHostName(host)) return "DIRECT"; return "PROXY 127.0.0.1:7890; DIRECT"; }');
  try { assert.equal(await pacProxyHint(pathToFileURL(file).href),'http://127.0.0.1:7890'); } finally { await fs.rm(file,{force:true}); }
});
await test('proxy-credentials-and-unsupported-protocol-rejected',async()=>{for(const u of ['socks5://127.0.0.1:1080','http://user:password@127.0.0.1:7890','http://127.0.0.1:7890/path'])assert.throws(()=>validateFileProxy(u),/FILE_PROXY_INVALID/)});
await test('disabled-system-proxy-means-direct',async()=>assert.equal(parseWindowsFileProxy({...system,enabled:false},target).mode,'direct'));
await test('non-Windows-without-environment-does-not-read-registry',async()=>assert.equal((await resolveFileProxy(target,{env:{},platform:'linux',readSystem:()=>{throw Error('no registry')}})).mode,'direct'));
await test('registry-read-error-fails-closed',async()=>assert.rejects(resolveFileProxy(target,{env:{},platform:'win32',readSystem:async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'})}}),/denied/));
// Local transport fixtures exercise the production adapter without registry or network.
async function withTransport({status=200,headers={},bytes=Buffer.from('fixture'),hang=false},fn){
  const original=https.request, originalFetch=globalThis.fetch, seen=[];
  https.request=(url,options,callback)=>{
    seen.push({url,options});const req=new EventEmitter();
    req.end=()=>queueMicrotask(()=>{const res=new PassThrough();res.statusCode=status;res.headers=headers;res.complete=false;
      const abort=()=>{const error=Object.assign(new Error('Fixture aborted'),{name:'AbortError',code:'ABORT_ERR'});res.destroy(error);req.emit('error',error)};
      options.signal.addEventListener('abort',abort,{once:true});res.once('close',()=>options.signal.removeEventListener('abort',abort));
      callback(res);if(!hang){res.complete=true;res.end(bytes)}
    });return req;
  };syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('Global fetch must not select the route')};
  try{return await fn(seen)}finally{https.request=original;syncBuiltinESMExports();globalThis.fetch=originalFetch}
}
await test('pre-resolved-direct-enforces-NO_PROXY-without-global-fetch',async()=>withTransport({},async seen=>{
  const response=await fetchFileResponse(target,AbortSignal.timeout(1000),{mode:'direct',source:'NO_PROXY'});
  assert.equal(await response.text(),'fixture');assert.equal(seen.length,1);assert.deepEqual(seen[0].options.agent.options.proxyEnv,{});
}));
await test('pre-resolved-proxy-used-exactly-without-registry-reresolution',async()=>withTransport({},async seen=>{
  const response=await fetchFileResponse(target,AbortSignal.timeout(1000),{mode:'proxy',source:'fixture',url:'http://127.0.0.1:8123'});
  assert.equal(await response.text(),'fixture');assert.deepEqual(seen[0].options.agent.options.proxyEnv,{HTTPS_PROXY:'http://127.0.0.1:8123'});
}));
await test('manual-redirect-is-returned-and-body-cancellable',async()=>withTransport({status:302,headers:{location:'https://example.invalid/next'},hang:true},async()=>{
  const response=await fetchFileResponse(target,AbortSignal.timeout(1000),{mode:'direct',source:'fixture'});
  assert.equal(response.status,302);assert.equal(response.headers.get('location'),'https://example.invalid/next');await response.body.cancel();
}));
await test('gzip-body-decoded-completely',async()=>withTransport({headers:{'content-encoding':'gzip'},bytes:gzipSync('decoded fixture')},async()=>{
  assert.equal(await (await fetchFileResponse(target,AbortSignal.timeout(1000),{mode:'direct',source:'fixture'})).text(),'decoded fixture');
}));
await test('encoded-empty-status-drains-without-decoder-error',async()=>withTransport({status:204,headers:{'content-encoding':'gzip'},bytes:Buffer.alloc(0)},async()=>{
  const response=await fetchFileResponse(target,AbortSignal.timeout(1000),{mode:'direct',source:'fixture'});assert.equal(response.status,204);assert.equal(response.body,null);
}));
await test('abort-after-headers-rejects-compressed-body',async()=>withTransport({headers:{'content-encoding':'gzip'},hang:true},async()=>{
  const controller=new AbortController();const response=await fetchFileResponse(target,controller.signal,{mode:'direct',source:'fixture'});
  const text=response.text();controller.abort();await assert.rejects(text,/abort/i);
}));

// Public fixture certificate and key are test-only, with trust limited to these requests.
const fixtureCert="-----BEGIN CERTIFICATE-----\nMIIDJTCCAg2gAwIBAgIUBuQKSPiBzi7MPsh5s7/eKLsfGMYwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyMDExMjYwM1oXDTM2MTAx\nNzExMjYwM1owFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEA1JNRm1pQAgpsqwVUl6Etri5DgzoVBUJIOyO9QH612OUF\nI0Tv+WhIGhKwFUD3IgXYsignl81/byLulGE0J/cfffsdKiUTuPMBDbNfWUfcjWvr\n2r50vo9lxkbZboqXhFQ/9L0tHBlzR5YDV9exLw+Zg8jYzGrBnFvhVNgF0v+c6arl\nEqcRw9OpP5Lf2Ltv+YLCvfUTHTz2N5f44HA89Iuv2KNaMTtjlybb4yujggsgdsjl\n2szl6t2mLpXeoUp6PfECx+webaURdy2eapExvtRy5pLdEggN5/up8Axyo4MKADGd\nLMQPmQcCitkwiaZvYec7qDZkh7L08Cf2fI8UAJxvTwIDAQABo28wbTAdBgNVHQ4E\nFgQUNSJUY1WJ5+9x3KZZ9zGxKWLBOQIwHwYDVR0jBBgwFoAUNSJUY1WJ5+9x3KZZ\n9zGxKWLBOQIwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH\nBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAFz9FQ6v6+YsLt43j2OhBFTToHUOakwX\nhKCbO6KZD5RfSO+BOS9nqw4UKk649+dskIwJ76Nl1AfK6hGPMrN31RDuQjUyOmj5\nlwaPcZDTs6cxWS9+77VT6bA9lV3cxT23f/dbyYxl/JNo9mehWgXrAp9Ikb/ipP+P\nr3aa9sYHbcvtSaOUqKxDQINvz5W+oqSwUIwh3LqCk4lRhtfrxjEqyJK99xkdIM4C\nP27L6ftgJLhvO1IHL7t0929CxvtaBTvoer0vLZPqeD1YFcCyp3NJzU6e9mp4JfSI\n6HXGEQscTh5DKbGcJ2g+jx8ns8giya0oYOg1lYOet9rPFc9cYKp9aYI=\n-----END CERTIFICATE-----\n";
const fixtureKey="-----BEGIN PRIVATE KEY-----\nMIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDUk1GbWlACCmyr\nBVSXoS2uLkODOhUFQkg7I71AfrXY5QUjRO/5aEgaErAVQPciBdiyKCeXzX9vIu6U\nYTQn9x99+x0qJRO48wENs19ZR9yNa+vavnS+j2XGRtluipeEVD/0vS0cGXNHlgNX\n17EvD5mDyNjMasGcW+FU2AXS/5zpquUSpxHD06k/kt/Yu2/5gsK99RMdPPY3l/jg\ncDz0i6/Yo1oxO2OXJtvjK6OCCyB2yOXazOXq3aYuld6hSno98QLH7B5tpRF3LZ5q\nkTG+1HLmkt0SCA3n+6nwDHKjgwoAMZ0sxA+ZBwKK2TCJpm9h5zuoNmSHsvTwJ/Z8\njxQAnG9PAgMBAAECggEATmVkR8hnUFFa4TmOiHsjNyUNtfQyM2XN8K2OCp6QXwSb\nP/YZEGCCkscIlFYIrk38rDt92pCpaim2VheBHioXvaTiDRxuaRuJbG2WAP2tG6TM\n7zelI3AMBzMy1f8bwOw3SAGKhN3n82MiKX+88w+sPHtSZRUMASercthWUYn+avf1\nAMM/2qM3zIjybF60ChTZXPH4tah8AcrouYSyTjSE5l3GBwCLD24Fo697FKianm8q\no80mF88HXAhrVtwx+m3mYiSjGQhvz7UOOAzompaKtxiIh7ezBeC4Gl16xVnAFgqi\n8ugGP2bTZN3khoKMpdoklXn58p3olbHmlqQ3J2aVxQKBgQDqnOv6e3BawBJRI+gV\nxXjvEulAW8qTG/U9bg/fICCXbXOsAmE1ypRrpCaaK2BoEOopjobW9oArbMcEvD0C\nwgMPQTXb61tXaj+Hk4x4jQ1EFiWCiBENFcCszZOhswNBuKAklztCzKLHFSSHGfTQ\n/4+cKVm2pZ/sRR4XeMeIepgJXQKBgQDn9B2UAM1TmGlgqlwH2++7/11MrVzTXj+w\nAiKjlruyxm2R3N1+Valf2QeEd6tOInnv8xI9JWd4neofCm5QrJhYM49xgNNxnHpH\nUVeuus8IlNWv/czh0sSeohen1DVDk4qTabCMs9lzAxaQRsAMZca4xDeGxDDhLN5T\nM6VrkmmUmwKBgEkZw900APoFxq9JhNLjyJ6VQeAvuZrEp1EQrhlTpVQJYnVB+JAO\nIti3ON/ojA1g19VC93ibLaxaJFixXkExukpSgzmWx8sg69KOgsI9ENkaHW3if42Y\nLYSqOUm0wVsE78D27hwOLtnhGJSP3dwRBOofaDikuoOftZSSqXk42Y5xAoGAWh0P\n5LEPFBwRTHnC+Var45jJMYHkn0Vtbr7VoEJuN305kkKBVpSHEfKqJf+r8NYaE2uW\nuWSvtz96dobB5tu28AVQBCOtgeTt6IkkjICM8GOKRS5QC6ertYl5sT0TWGaYnr6f\n1XoFz9XyTSj/cZGUy7GHdPcBmmmpEh/tc0ZVeGMCgYB2UG4Yp/TIo5ewCJDTLv8x\nF3Tm6WK5hfi2p/mNqg/DQ24MjjX0MWBw/HBTXUG6fnd5XBr+BN8HQarTfcQptDBv\nKwTdIiyLRSncSPOwoPpVa3axNPCN9wLeLVveok2Mx2f+llkHM+wLGsoF9hf2Jud7\nGOBRbhmbbGeG1SNAlZtoqw==\n-----END PRIVATE KEY-----\n";
await test('local-TLS-direct-CONNECT-proxy-encoding-empty-redirect-and-cancel',async()=>{
  const sockets=new Set();const track=s=>{sockets.add(s);s.once('close',()=>sockets.delete(s))};
  const origin=https.createServer({key:fixtureKey,cert:fixtureCert},(req,res)=>{
    if(req.url==='/gzip'){res.writeHead(200,{'content-encoding':'gzip'});res.end(gzipSync('local TLS payload'))}
    else if(req.url==='/empty'){res.writeHead(204,{'content-encoding':'gzip'});res.end()}
    else if(req.url==='/redirect'){res.writeHead(302,{location:'/gzip'});res.end()}
    else if(req.url==='/hang'){res.writeHead(200,{'content-encoding':'gzip'});res.flushHeaders()}
    else res.end('direct TLS');
  });origin.on('connection',track);
  let connects=0;const proxy=http.createServer();proxy.on('connection',track);
  proxy.on('connect',(req,client,head)=>{connects++;const [host,port]=req.url.split(':');const upstream=net.connect(Number(port),host,()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client)});track(upstream);upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy())});
  await new Promise(r=>origin.listen(0,'127.0.0.1',r));await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  const original=https.request;https.request=(url,opts,cb)=>original(url,{...opts,ca:fixtureCert},cb);syncBuiltinESMExports();
  const direct={mode:'direct',source:'NO_PROXY'},proxied={mode:'proxy',source:'fixture',url:'http://127.0.0.1:'+proxy.address().port};
  const url=p=>new URL('https://127.0.0.1:'+origin.address().port+p);
  try{
    assert.equal(await(await fetchFileResponse(url('/'),AbortSignal.timeout(2000),direct)).text(),'direct TLS');assert.equal(connects,0);
    assert.equal(await(await fetchFileResponse(url('/gzip'),AbortSignal.timeout(2000),proxied)).text(),'local TLS payload');assert.equal(connects,1);
    assert.equal((await fetchFileResponse(url('/empty'),AbortSignal.timeout(2000),direct)).body,null);
    const redirect=await fetchFileResponse(url('/redirect'),AbortSignal.timeout(2000),direct);assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),'/gzip');await redirect.body.cancel();
    const abort=new AbortController();const hanging=await fetchFileResponse(url('/hang'),abort.signal,direct);const reading=hanging.text();abort.abort();await assert.rejects(reading,/abort|reset/i);
  }finally{https.request=original;syncBuiltinESMExports();for(const socket of sockets)socket.destroy();await Promise.all([new Promise(r=>origin.close(r)),new Promise(r=>proxy.close(r))])}
});

const connections=[];
if(process.argv.includes('--native-connectivity')){
  for(const host of ['example.com','files.oaiusercontent.com']){
    await test('native-scoped-proxy-GET-'+host,async()=>{
      const url=new URL('https://'+host+'/');const before=https.globalAgent;
      const route=await resolveFileProxy(url);assert.equal(route.mode,'proxy','This optional machine-specific probe expects the already configured system proxy.');
      const start=Date.now();const res=await fetchFileResponse(url,AbortSignal.timeout(15000));const text=await res.text();
      assert.equal(res.status,host==='example.com'?200:404);assert.equal(https.globalAgent,before);
      connections.push({host,status:res.status,bytes:Buffer.byteLength(text),elapsed_ms:Date.now()-start,route_source:route.source,original_attachment:false});
    });
  }
}
const report={at:new Date().toISOString(),node:process.version,electron:process.versions.electron||null,tests,connections,passed:tests.filter(x=>x.passed).length,failed:tests.filter(x=>!x.passed).length,real_chatgpt_attachment_download:false};
if(process.env.HARNESS_NETWORK_REPORT)await fs.writeFile(process.env.HARNESS_NETWORK_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(report.failed)process.exitCode=1;
