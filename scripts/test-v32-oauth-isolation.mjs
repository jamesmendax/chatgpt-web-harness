import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { FileOAuthClientProvider } from "../dist/lib/mcp-oauth-provider.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-oauth-isolation-"));
const make = (serverId, serverUrl = "https://one.example.test/mcp") => new FileOAuthClientProvider({
  serverId, serverUrl, authDir: dir, openBrowser: false,
});
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`OK  ${name}`);
}

try {
  await test("concurrent first-load writes retain all fields across provider instances", async () => {
    const first = make("concurrent-fields");
    await Promise.all([
      first.saveClientInformation({ client_id: "concurrent-client" }),
      first.saveTokens({ access_token: "concurrent-token", token_type: "Bearer" }),
    ]);
    assert.equal((await make("concurrent-fields").clientInformation())?.client_id, "concurrent-client");
    assert.equal((await make("concurrent-fields").tokens())?.access_token, "concurrent-token");
    const left = make("concurrent-fields"), right = make("concurrent-fields");
    await Promise.all([left.tokens(), right.tokens()]);
    await Promise.all([
      left.saveCodeVerifier("concurrent-verifier"),
      right.saveTokens({ access_token: "next-token", token_type: "Bearer" }),
    ]);
    assert.equal(await make("concurrent-fields").codeVerifier(), "concurrent-verifier");
    assert.equal((await make("concurrent-fields").tokens())?.access_token, "next-token");
    await Promise.all([
      left.saveTokens({ access_token: "earlier-write", token_type: "Bearer" }),
      right.invalidateCredentials("tokens"),
    ]);
    assert.equal(await make("concurrent-fields").tokens(), undefined, "an earlier queued write cannot resurrect tokens after invalidation");
    assert.equal((await make("concurrent-fields").clientInformation())?.client_id, "concurrent-client");
  });

  await test("failed OAuth publication preserves the prior file and does not poison the queue", async () => {
    const authDir = path.join(dir, "publication-failure");
    const options = { serverId: "publication", serverUrl: "https://one.example.test/mcp", authDir, openBrowser: false };
    const provider = new FileOAuthClientProvider(options);
    await provider.saveClientInformation({ client_id: "retained-client" });
    const filename = (await fs.readdir(authDir))[0];
    const target = path.join(authDir, filename), before = await fs.readFile(target);
    const rename = fs.rename;
    let injected = false;
    fs.rename = async (...args) => {
      if (!injected && path.resolve(String(args[1])) === path.resolve(target)) {
        injected = true;
        throw Object.assign(new Error("synthetic publication failure"), { code: "EACCES" });
      }
      return rename(...args);
    };
    try {
      await assert.rejects(provider.saveTokens({ access_token: "unpublished-token", token_type: "Bearer" }), /synthetic publication failure/);
    } finally { fs.rename = rename; }
    assert.equal(injected, true);
    assert.deepEqual(await fs.readFile(target), before);
    assert.equal(await new FileOAuthClientProvider(options).tokens(), undefined);
    await provider.saveTokens({ access_token: "committed-token", token_type: "Bearer" });
    assert.equal((await new FileOAuthClientProvider(options).tokens())?.access_token, "committed-token");
    assert.deepEqual(await fs.readdir(authDir), [filename], "failed publication leaves no owned temporary file");
  });

  await test("IDs differing by case or filename filtering are isolated and survive restart", async () => {
    const ids = ["Demo", "demo", "slash/name", "slash?name", "slash_name"];
    const states = new Map();
    for (const id of ids) {
      const provider = make(id);
      assert.equal(await provider.tokens(), undefined);
      await provider.saveTokens({ access_token: `token:${id}`, token_type: "Bearer" });
      await provider.saveClientInformation({ client_id: `client:${id}` });
      await provider.beginAuthorization();
      states.set(id, await provider.state());
      await provider.saveCodeVerifier(`verifier:${id}`);
    }
    for (const id of ids) {
      const provider = make(id);
      assert.equal((await provider.tokens()).access_token, `token:${id}`);
      assert.equal((await provider.clientInformation()).client_id, `client:${id}`);
      assert.equal(await provider.codeVerifier(), `verifier:${id}`);
      assert.equal(await provider.verifyState(states.get(id)), true);
      assert.equal(await provider.verifyState(states.get(ids[(ids.indexOf(id) + 1) % ids.length])), false);
    }
    const filenames = await fs.readdir(dir);
    assert.equal(new Set(filenames.filter(name => name.startsWith("v2-")).map((name) => name.toLowerCase())).size, ids.length + 1);
  });

  await test("same ID at a different URL never receives tokens, state, client or verifier", async () => {
    const one = make("same", "https://one.example.test/mcp");
    await one.saveTokens({ access_token: "one-token", token_type: "Bearer" });
    await one.saveClientInformation({ client_id: "one-client" });
    await one.beginAuthorization();
    const state = await one.state();
    await one.saveCodeVerifier("one-verifier");
    const two = make("same", "https://two.example.test/mcp");
    assert.equal(await two.tokens(), undefined);
    assert.equal(await two.clientInformation(), undefined);
    assert.equal(await two.verifyState(state), false);
    await assert.rejects(two.codeVerifier(), /missing/);
    await two.saveTokens({ access_token: "two-token", token_type: "Bearer" });
    assert.equal((await make("same", "https://one.example.test/mcp").tokens()).access_token, "one-token");
    assert.equal((await make("same", "https://two.example.test/mcp").tokens()).access_token, "two-token");
  });

  await test("legacy credentials stay untouched and are not imported for any colliding ID", async () => {
    const legacyPath = path.join(dir, "legacy_name.json");
    const legacy = JSON.stringify({ tokens: { access_token: "legacy-secret", token_type: "Bearer" } });
    await fs.writeFile(legacyPath, legacy);
    assert.equal(await make("legacy/name").tokens(), undefined);
    assert.equal(await make("legacy?name").tokens(), undefined);
    assert.equal(await make("legacy_name").tokens(), undefined);
    assert.equal(await make("legacy_name", "https://elsewhere.example.test/mcp").tokens(), undefined);
    assert.equal(await fs.readFile(legacyPath, "utf8"), legacy);
  });

  await test("copied or malformed identity fails closed", async () => {
    const before = new Set(await fs.readdir(dir));
    const source = make("copy-source");
    await source.saveTokens({ access_token: "source-secret", token_type: "Bearer" });
    const sourceFile = (await fs.readdir(dir)).find((name) => !before.has(name));
    const nextBefore = new Set(await fs.readdir(dir));
    await make("copy-target").saveTokens({ access_token: "target", token_type: "Bearer" });
    const targetFile = (await fs.readdir(dir)).find((name) => !nextBefore.has(name));
    await fs.copyFile(path.join(dir, sourceFile), path.join(dir, targetFile));
    await assert.rejects(make("copy-target").tokens(), /identity mismatch/);
  });

  await test("a URL and ID are required", async () => {
    assert.throws(() => new FileOAuthClientProvider({ serverId: "no-url", authDir: dir }), /requires/);
    assert.throws(() => new FileOAuthClientProvider({ serverId: "", serverUrl: "https://one.example.test", authDir: dir }), /requires/);
  });

  await test("manager binds credentials to the URL across reconfiguration without network", async () => {
    const authDir = path.join(dir, "manager-auth");
    const configPath = path.join(dir, "manager-config.json");
    const oldAuthDir = process.env.MCP_OAUTH_STORE;
    const oldFetch = globalThis.fetch;
    const oldConnect = net.Socket.prototype.connect;
    let networkAttempts = 0;
    process.env.MCP_OAUTH_STORE = authDir;
    globalThis.fetch = async () => { networkAttempts++; throw new Error("network forbidden in OAuth isolation test"); };
    net.Socket.prototype.connect = function () { networkAttempts++; throw new Error("network forbidden in OAuth isolation test"); };
    const manager = new McpUpstreamManager(configPath);
    const id = "manager-server";
    const firstUrl = "https://first.example.invalid/mcp";
    const secondUrl = "https://second.example.invalid/mcp";
    const config = (url) => ({ version: 1, servers: [{ id, name: id, enabled: false,
      transport: "http", url, auth: { type: "oauth" }, expose: "none" }] });
    const provider = (serverUrl) => new FileOAuthClientProvider({ serverId: id, serverUrl, authDir, openBrowser: false });
    try {
      await provider(firstUrl).saveTokens({ access_token: "first-token", token_type: "Bearer" });
      await manager.init();
      await manager.updateConfig(config(firstUrl));
      assert.equal((await manager.oauthStatus(id)).connected, true);

      await manager.updateConfig(config(secondUrl));
      assert.equal((await manager.oauthStatus(id)).connected, false);
      await provider(secondUrl).saveTokens({ access_token: "second-token", token_type: "Bearer" });
      await manager.reloadConfig();
      assert.equal((await manager.oauthStatus(id)).connected, true);
      await manager.disconnectOAuth(id);
      assert.equal(await provider(secondUrl).tokens(), undefined);
      assert.equal((await provider(firstUrl).tokens()).access_token, "first-token");

      await manager.updateConfig(config(firstUrl));
      assert.equal((await manager.oauthStatus(id)).connected, true);
      for (let i = 0; i < 8; i++) {
        await provider(firstUrl).saveTokens({ access_token: "disconnect-race-token", token_type: "Bearer" });
        await manager.reloadConfig();
        await Promise.all([manager.disconnectOAuth(id), manager.oauthStatus(id)]);
        assert.equal(await provider(firstUrl).tokens(), undefined, "concurrent status cannot restore credentials after successful disconnect");
      }
      assert.equal(networkAttempts, 0);
    } finally {
      await manager.shutdown();
      if (oldAuthDir === undefined) delete process.env.MCP_OAUTH_STORE;
      else process.env.MCP_OAUTH_STORE = oldAuthDir;
      globalThis.fetch = oldFetch;
      net.Socket.prototype.connect = oldConnect;
    }
  });
  console.log(`\n${passed} passed, 0 failed`);
} finally {
  const [realTemp, realDir] = await Promise.all([fs.realpath(os.tmpdir()), fs.realpath(dir)]);
  const normalizeForComparison = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  if (normalizeForComparison(path.dirname(realDir)) !== normalizeForComparison(realTemp) ||
      !path.basename(realDir).startsWith("mcp-oauth-isolation-")) {
    throw new Error("Refusing to remove OAuth test directory outside the expected temporary root");
  }
  await fs.rm(realDir, { recursive: true, force: true });
}
