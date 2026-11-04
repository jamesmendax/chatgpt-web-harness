import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { assertStagingSafe } from "./lib/sanitize-profiles.mjs";
import { shouldPruneRuntimeFile } from "./lib/runtime-file-policy.mjs";

assert.equal(shouldPruneRuntimeFile("vendor/browser-use/chrome/chrome-win64/debug.log"), true, "browser diagnostics must not ship");
assert.equal(shouldPruneRuntimeFile("vendor/browser-use/chrome/chrome-win64/chrome.exe"), false, "browser executable remains runtime data");
assert.equal(shouldPruneRuntimeFile("node_modules/typescript/lib/lib.es2024.d.ts"), false, "semantic tooling retains standard library declarations");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "clc-stage-sanitize-"));
const profiles = path.join(tmp, "profiles");
await fs.mkdir(profiles, { recursive: true });
for (const [name, content] of [
  ["chatgpt-connector-description.txt", "http://127.0.0.1:3000\n"],
  ["mcp-upstream.json", JSON.stringify({ version: 1, servers: [] })],
  ["plugins.json", JSON.stringify({ schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: false }, skills: [] })],
  ["post-edit-hooks.json", JSON.stringify({ enabled: false, hooks: [] })],
]) await fs.writeFile(path.join(profiles, name), content, "utf8");

try {
  assert.equal(assertStagingSafe(tmp), true);
  await fs.writeFile(path.join(profiles, "mcp-upstream.json"), JSON.stringify({ cwd: "D:\\Coding\\private" }), "utf8");
  assert.throws(() => assertStagingSafe(tmp), /绝对盘符/);
  await fs.writeFile(path.join(profiles, "mcp-upstream.json"), JSON.stringify({ url: "http://example.test/path" }), "utf8");
  assert.doesNotThrow(() => assertStagingSafe(tmp), "URL text should not trigger drive guard");
  await fs.writeFile(path.join(profiles, "mcp-upstream.json"), JSON.stringify({
    version: 1,
    servers: [{ id: "enabled-local", enabled: true, transport: "stdio", command: "node", cwd: "D:/private/project", expose: "none" }],
  }), "utf8");
  assert.throws(() => assertStagingSafe(tmp), /绝对盘符/, "enabled server with forward-slash drive path must be rejected");
  await fs.writeFile(path.join(profiles, "mcp-upstream.json"), JSON.stringify({ version: 1, servers: [] }), "utf8");
  const outside = path.join(tmp, "outside");
  await fs.mkdir(outside, { recursive: true });
  const linked = path.join(tmp, "linked-profile-dir");
  try {
    await fs.symlink(outside, linked, "junction");
    assert.throws(() => assertStagingSafe(tmp), /符号链接|真实路径/, "nested junction must be rejected");
  } finally {
    await fs.rm(linked, { recursive: true, force: true });
  }
  await fs.mkdir(path.join(tmp, "nested"), { recursive: true });
  await fs.writeFile(path.join(tmp, "nested", "data.json"), "{\"path\":\"D:\\Crack\\private\"}", "utf8");
  assert.throws(() => assertStagingSafe(tmp), /开发机路径/);
  await fs.rm(path.join(tmp, "nested"), { recursive: true, force: true });
  await fs.mkdir(path.join(profiles, "local-skills"));
  assert.throws(() => assertStagingSafe(tmp), /local-skills/);
  await fs.rm(path.join(profiles, "local-skills"), { recursive: true, force: true });
  await fs.rm(path.join(profiles, "plugins.json"));
  assert.throws(() => assertStagingSafe(tmp), /文件集不安全/);
  console.log("stage-sanitize: profile whitelist, generic drive guards, URL tolerance, nested scan and local-skills exclusion OK");
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
