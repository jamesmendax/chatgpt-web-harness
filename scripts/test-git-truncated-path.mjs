import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = process.cwd();
const { gitExecutableCandidates, resolveGitExecutable } = await import("../dist/tools/git.js");

const fakeEnv = {
  ProgramFiles: "C:\\FixturePF",
  LOCALAPPDATA: "C:\\FixtureLocal",
};
const fakeCandidates = gitExecutableCandidates("win32", fakeEnv);
assert.ok(fakeCandidates.some((p) => p.toLowerCase() === "c:\\fixturepf\\git\\cmd\\git.exe"));
assert.ok(fakeCandidates.some((p) => p.toLowerCase() === "c:\\fixturelocal\\programs\\git\\cmd\\git.exe"));
const fakeResolved = resolveGitExecutable("win32", fakeEnv, (file) => file.toLowerCase() === "c:\\fixturepf\\git\\bin\\git.exe");
assert.equal(fakeResolved.toLowerCase(), "c:\\fixturepf\\git\\bin\\git.exe");
assert.throws(() => resolveGitExecutable("win32", {}, () => false), /git not found in trusted Git for Windows install locations/);
assert.equal(resolveGitExecutable("linux", {}, () => false), "git");

if (process.platform !== "win32") {
  console.log("GIT_TRUNCATED_PATH_WINDOWS_RUNTIME_SKIPPED");
  process.exit(0);
}
const trustedGit = resolveGitExecutable();
await fs.access(trustedGit);
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-git-path-"));
const keys = ["PATH", "Path", "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "CHATGPT_TOOL_PROFILE"];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
try {
  delete process.env.Path;
  process.env.PATH = tmp;
  delete process.env.ProgramFiles;
  delete process.env.ProgramW6432;
  delete process.env["ProgramFiles(x86)"];
  process.env.CHATGPT_TOOL_PROFILE = "full";

  const fixedResolved = resolveGitExecutable();
  assert.equal(fixedResolved.toLowerCase(), "c:\\program files\\git\\cmd\\git.exe",
    "fixed trusted Windows fallback should survive a truncated PATH and missing ProgramFiles env");

  const { createMcpServer } = await import("../dist/server-factory.js");
  const server = createMcpServer(root, 30_000, [root], true);
  const client = new Client({ name: "git-truncated-path-fixture", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  serverTransport.sessionId = "git-truncated-path-fresh-session";
  try {
    const result = await client.callTool({ name: "git_status", arguments: { path: root } });
    assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.data?.path, root);
    assert.match(result.structuredContent?.data?.output || "", /^##|^Clean working tree/m);
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
  console.log(`GIT_TRUNCATED_PATH_PASS executable=${fixedResolved}`);
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true });
}
