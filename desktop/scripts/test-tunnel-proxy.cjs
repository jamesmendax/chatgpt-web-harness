"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateProxyUrl, validateProxySettings, bypassesControlPlane, parseSystemProxy, resolveTunnelProxy, applyTunnelProxy } = require("../src/tunnel-proxy");

test("proxy URL validation normalizes approved schemes", () => {
  assert.equal(validateProxyUrl(" http://127.0.0.1:7890/ "), "http://127.0.0.1:7890");
  assert.equal(validateProxyUrl("socks5://[::1]:1080"), "socks5://[::1]:1080");
  assert.equal(validateProxyUrl("https://proxy.example:8443"), "https://proxy.example:8443");
});
for (const [name, value] of Object.entries({ empty:"", noScheme:"127.0.0.1:7890", userInfo:"http://user:password@127.0.0.1:7890", path:"http://127.0.0.1:7890/path", query:"http://127.0.0.1:7890?token=secret", fragment:"http://127.0.0.1:7890#secret", badScheme:"file:///tmp/a", socks4:"socks4://127.0.0.1:1080", newline:"http://127.0.0.1:7890\n--log.http-raw-unsafe", badPort:"http://127.0.0.1:99999" })) {
  test("reject proxy " + name + " without echoing input", () => {
    assert.throws(() => validateProxyUrl(value), error => { assert.ok(!error.message.includes("password") && !error.message.includes("secret")); return true; });
  });
}
test("settings validate mode and require custom URL", () => {
  assert.doesNotThrow(() => validateProxySettings({}));
  assert.doesNotThrow(() => validateProxySettings({tunnelProxyMode:"direct"}));
  assert.throws(() => validateProxySettings({tunnelProxyMode:"invalid"}));
  assert.throws(() => validateProxySettings({tunnelProxyMode:"custom",tunnelProxyUrl:""}));
});
test("PAC priority and proxy protocols", () => {
  assert.deepEqual(parseSystemProxy("PROXY localhost:7890; DIRECT"), {mode:"proxy",source:"system",url:"http://localhost:7890"});
  assert.equal(parseSystemProxy("HTTPS proxy.example:8443").url, "https://proxy.example:8443");
  assert.equal(parseSystemProxy("SOCKS5 localhost:1080").url, "socks5://localhost:1080");
  assert.equal(parseSystemProxy("DIRECT; PROXY localhost:7890").mode, "direct");
  assert.throws(() => parseSystemProxy("SOCKS localhost:1080; DIRECT"));
  assert.throws(() => parseSystemProxy(""));
});
test("NO_PROXY matches the exact OpenAI destination, domains, wildcard and port", () => {
  for (const value of ["*", "api.openai.com", ".openai.com", "*.openai.com:443", "localhost,api.openai.com"]) assert.equal(bypassesControlPlane(value), true, value);
  for (const value of ["", "notopenai.com", "api.openai.com.evil", "api.openai.com:80", "127.0.0.1,localhost"]) assert.equal(bypassesControlPlane(value), false, value);
});
test("explicit direct/custom never invoke automatic discovery", async () => {
  const options={env:{HTTPS_PROXY:"http://localhost:9999"},resolveSystem:()=>{throw Error("must not run");}};
  assert.equal((await resolveTunnelProxy({tunnelProxyMode:"direct"},options)).mode,"direct");
  assert.equal((await resolveTunnelProxy({tunnelProxyMode:"custom",tunnelProxyUrl:"http://localhost:7890"},options)).url,"http://localhost:7890");
});
test("auto follows environment before system proxy and does not mutate parent env", async () => {
  const env={https_proxy:"http://127.0.0.1:7890",HTTP_PROXY:"http://127.0.0.1:7891"};const old={...env};
  const proxy=await resolveTunnelProxy({}, {env,resolveSystem:()=>{throw Error("must not run");}});
  assert.equal(proxy.source,"HTTPS_PROXY");assert.equal(proxy.url,"http://127.0.0.1:7890");assert.deepEqual(env,old);
});
test("auto honors NO_PROXY rather than routing a bypass target", async () => {
  const proxy=await resolveTunnelProxy({}, {env:{HTTPS_PROXY:"http://localhost:7890",no_proxy:".openai.com"},resolveSystem:()=>{throw Error("must not run");}});
  assert.equal(proxy.mode,"direct");assert.equal(proxy.source,"NO_PROXY");
});
test("auto resolves Windows/PAC for the actual API origin", async () => {
  const proxy=await resolveTunnelProxy({}, {env:{},resolveSystem:async url=>{assert.equal(url,"https://api.openai.com");return "PROXY 127.0.0.1:7890";}});
  assert.equal(proxy.source,"system");assert.equal(proxy.url,"http://127.0.0.1:7890");
});
test("proxy resolution timeout is bounded and never silently falls back to direct", async () => {
  await assert.rejects(resolveTunnelProxy({}, {env:{},resolveSystem:()=>new Promise(()=>{}),timeoutMs:10}), /超时/);
  await assert.rejects(resolveTunnelProxy({}, {env:{},resolveSystem:()=>Promise.reject(Error("lookup failed"))}), /lookup failed/);
});
test("child proxy application is control-plane-only with no raw URL in command arguments", () => {
  const env={HTTPS_PROXY:"http://wrong:1",http_proxy:"http://wrong:2",ALL_PROXY:"socks5://wrong:3",no_proxy:"*",OTHER:"kept"};
  const args=["run","--profile-file","fixture.yaml"];
  applyTunnelProxy(env,args,{mode:"proxy",url:"http://127.0.0.1:7890"});
  assert.deepEqual(args.slice(-2),["--control-plane.http-proxy","env:CLC_TUNNEL_HTTP_PROXY"]);
  assert.equal(env.CLC_TUNNEL_HTTP_PROXY,"http://127.0.0.1:7890");assert.equal(env.NO_PROXY,"127.0.0.1,localhost,::1");assert.equal(env.OTHER,"kept");
  assert.ok(!("HTTPS_PROXY" in env)&&!("http_proxy" in env)&&!("ALL_PROXY" in env));
  assert.ok(!args.includes("--http-proxy")&&!args.includes("--mcp.http-proxy"));
});
test("explicit direct scrubs only child proxy policy", () => {
  const env={HTTPS_PROXY:"http://wrong:1",CLC_TUNNEL_HTTP_PROXY:"http://wrong:2",HOME:"kept"};const args=["run"];
  applyTunnelProxy(env,args,{mode:"direct",url:""});assert.deepEqual(args,["run"]);assert.deepEqual(env,{HOME:"kept",NO_PROXY:"127.0.0.1,localhost,::1"});
});
