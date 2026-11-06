import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bootstrapIsolatedTestEnv, assertAuditFixture } from "./lib/isolated-test-env.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv.slice(2).find(value => !value.startsWith("--")) || path.join(repo, "dist"));
const fixture = await bootstrapIsolatedTestEnv("v32-process");
const root = fixture.root;
const moduleAt = file => import(pathToFileURL(path.join(dist, file)).href);
await assertAuditFixture(fixture, await moduleAt("lib/audit.js"), "v32-process");
if (process.argv.includes("--isolation-only")) process.exit(0);
const { setDefaultCwd } = await moduleAt("lib/path-security.js");
const { registerShellTools } = await moduleAt("tools/shell.js");
const { runWithRuntimeScope } = await moduleAt("lib/runtime-scope.js");
const { toolFailureDiagnostic } = await moduleAt("lib/tool-diagnostics.js");
const { createMcpServer } = await moduleAt("server-factory.js");
setDefaultCwd(root);
const handlers = new Map();
registerShellTools({ registerTool: (name, _schema, handler) => handlers.set(name, handler) }, root, 20);
const scope = { invocationId: "test", workspaceRoot: root, projectRoots: [root], mcpSessionId: "fixture-session",
  goalId: "fixture-goal", goalOwnerSessionId: "fixture-session",
  beforeDispatch: async () => { throw new Error("obsolete gate invoked"); } };
const call = (name, args) => runWithRuntimeScope(scope, () => handlers.get(name)(args));
async function completed(id) {
  for (let i = 0; i < 100; i++) {
    const result = await call("process_output", { id, tail_chars: 12000, output_mode: "full", view: "legacy", max_bytes: 12000 });
    const data = result.structuredContent.data;
    if (!data.running) return data;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("process did not finish");
}
try {
  const options = { output_encoding: "utf-8", working_directory: root, output_mode: "full", output_chars: 12000 };
  const failed = await call("run_command", { ...options, executable: process.execPath, args: ["-e", "process.exit(1)"] });
  const failedDiagnostic = toolFailureDiagnostic(failed);
  assert.equal(failedDiagnostic.exit_code, 1); assert.equal(failedDiagnostic.timed_out, false);
  assert.equal(failedDiagnostic.operation_started, true); assert.equal(failedDiagnostic.may_have_partially_completed, true);
  const noSpawn = await call("run_command", { ...options, executable: path.join(root, "missing.exe"), args: [] });
  const noSpawnDiagnostic = toolFailureDiagnostic(noSpawn);
  assert.equal(noSpawnDiagnostic.error_code, "COMMAND_SPAWN_FAILED"); assert.equal(noSpawnDiagnostic.operation_started, false);
  assert.equal(noSpawnDiagnostic.may_have_partially_completed, false);
  const argv = ["$foo", "a`b", 'a" b', "中文"];
  const launched = await call("start_process", { executable: process.execPath, args: ["-e",
    "setTimeout(() => process.stdout.write(JSON.stringify(process.argv.slice(1))), 300)", ...argv], output_encoding: "utf-8", working_directory: root });
  assert.equal(launched.structuredContent.data.execution_mode, "argv");
  let result = await completed(launched.structuredContent.data.id);
  assert.equal(result.exit_code, 0); assert.deepEqual(JSON.parse(result.stdout), argv);
  const gbk = await call("start_process", { executable: process.execPath, args: ["-e",
    "setTimeout(() => process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4])), 300)"], output_encoding: "cp936", working_directory: root });
  result = await completed(gbk.structuredContent.data.id);
  assert.equal(result.stdout, "中文"); assert.equal(result.output_encoding, "gbk");
  assert.deepEqual(await fs.readFile(result.raw_stdout_path), Buffer.from([0xd6,0xd0,0xce,0xc4]));
  if (process.platform === "win32") {
    const ps = await call("start_process", { command: "Start-Sleep -Milliseconds 300; [Console]::Write('中文')", output_encoding: "utf-8", working_directory: root });
    result = await completed(ps.structuredContent.data.id);
    assert.equal(result.stdout, "中文"); assert.equal(result.exit_code, 0);
  }
  const connections = [];
  async function clientFor(id) {
    const server = createMcpServer(root, 20_000, [root], true);
    const client = new Client({ name: "no-meta-process-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); st.sessionId = id;
    await server.connect(st); await client.connect(ct);
    connections.push({ client, server });
    return client;
  }
  try {
    let checkedValidation = false;
    for (const sessions of [["transport-a", "transport-b"], [undefined, undefined]]) {
      const a = await clientFor(sessions[0]), b = await clientFor(sessions[1]);
      if (!checkedValidation) {
        checkedValidation = true;
        for (const name of ["run_command", "start_process"]) {
          const marker = path.join(root, name + "-validated.txt");
          const exact = { executable: process.execPath, args: ["-e",
            "require('node:fs').appendFileSync(process.argv[1], 'x')", marker], working_directory: root };
          for (const bad of [{ ...exact, command: "unused" }, { ...exact, output_encoding: "not-a-real-encoding" }]) {
            const rejected = await a.callTool({ name, arguments: bad });
            const failure = toolFailureDiagnostic(rejected);
            assert.equal(failure?.error_code, "COMMAND_INPUT_INVALID");
            assert.equal(failure?.outcome_kind, "needs_input"); assert.equal(failure?.failure_phase, "validation");
            assert.equal(failure?.operation_started, false); assert.equal(failure?.may_have_partially_completed, false);
            await assert.rejects(fs.access(marker), /ENOENT/);
          }
          const corrected = await a.callTool({ name, arguments: exact });
          assert.equal(corrected.structuredContent.ok, true, JSON.stringify(corrected.structuredContent));
          if (name === "start_process") {
            const id = corrected.structuredContent.data.id;
            for (let i = 0; i < 100; i++) {
              const status = await a.callTool({ name: "process_status", arguments: { id } });
              if (!status.structuredContent.data.processes[0].running) break;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
          assert.equal(await fs.readFile(marker, "utf8"), "x", "corrected operation executes exactly once");
        }
      }
      const started = await a.callTool({ name: "start_process", arguments: {
        executable: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], working_directory: root,
      } });
      assert.equal(started.structuredContent.ok, true, JSON.stringify(started.structuredContent));
      const id = started.structuredContent.data.id;
      try {
        const own = await a.callTool({ name: "process_status", arguments: { id } });
        assert.equal(own.structuredContent.data.processes[0].id, id);
        const foreign = await b.callTool({ name: "process_status", arguments: { id } });
        assert.equal(foreign.structuredContent.data.processes.length, 0);
        const denied = await b.callTool({ name: "process_output", arguments: { id } });
        assert.equal(denied.isError, true);
      } finally {
        const stopped = await a.callTool({ name: "stop_process", arguments: { id, force: true } });
        assert.equal(stopped.structuredContent.ok, true, JSON.stringify(stopped.structuredContent));
      }
    }
  } finally {
    for (const connection of connections) { await connection.client.close(); await connection.server.close(); }
  }
  console.log("PASS v32 process host: exact argv, ownership without retired gate, cp936 raw bytes and PowerShell UTF-8");
} finally { await fs.rm(root, { recursive: true, force: true }); }
