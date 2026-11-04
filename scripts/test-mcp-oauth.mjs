import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileOAuthClientProvider } from "../dist/lib/mcp-oauth-provider.js";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-oauth-"));
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`OK  ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

const make = () => new FileOAuthClientProvider({
  serverId: "test-server",
  authDir: dir,
  callbackBase: "http://127.0.0.1:3999",
  openBrowser: false,
});

await test("oauth state persists across provider instances", async () => {
  const a = make();
  await a.beginAuthorization();
  const state = await a.state();
  assert.equal(await a.verifyState(state), true);
  const b = make();
  assert.equal(await b.verifyState(state), true);
  assert.equal(await b.verifyState("wrong"), false);
});

await test("oauth client info, verifier and tokens persist", async () => {
  const a = make();
  await a.saveClientInformation({ client_id: "client-1" });
  await a.saveCodeVerifier("verifier-1");
  await a.saveTokens({ access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1" });
  const b = make();
  assert.equal((await b.clientInformation())?.client_id, "client-1");
  assert.equal(await b.codeVerifier(), "verifier-1");
  assert.equal((await b.tokens())?.access_token, "access-1");
  assert.equal((await b.authorizationStatus()).connected, true);
});

await test("oauth disconnect removes tokens without client registration", async () => {
  const a = make();
  await a.invalidateCredentials("tokens");
  assert.equal(await a.tokens(), undefined);
  assert.equal((await a.clientInformation())?.client_id, "client-1");
});

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, 0 failed`);
