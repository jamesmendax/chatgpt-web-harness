#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const self = fileURLToPath(import.meta.url);
const data = (result, name) => {
  if (!result?.structuredContent?.ok) throw new Error(`${name} failed: ${JSON.stringify(result?.structuredContent ?? result)}`);
  return result.structuredContent.data;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated process recovery/control fixtures",
  scope: ["temporary durable child process across test MCP restart"],
  out_of_scope: [], deliverables: ["recovered stdin and stop assertions"],
  success_criteria: ["durable host identity, stdin recovery, and stop recovery behave deterministically"],
  constraints: [], protected_resources: [], known_facts: ["the child process belongs to this isolated test"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});
async function removeSandbox(root) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fs.rm(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 199) throw error;
      await delay(50);
    }
  }
}
const quote = (value) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;

async function createClient(workspace) {
  const { createMcpServer } = await import("../dist/server-factory.js");
  const server = createMcpServer(workspace, 5000, [workspace], true);
  const client = new Client({ name: "process-recovery-control", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = "process-recovery-control-session";
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

if (process.argv[2] === "--phase1") {
  const sandbox = process.argv[3];
  process.env.CODEX_HOME = path.join(sandbox, "codex-home");
  process.env.CHATGPT_TOOL_PROFILE = "full";
  const childPath = path.join(sandbox, "restart-child.mjs");
  const { client, server } = await createClient(sandbox);
  const started = data(await client.callTool({ name: "start_process", arguments: { command: `node ${quote(childPath)}`, working_directory: sandbox, _intent: TEST_INTENT } }), "start_process");
  await fs.writeFile(path.join(sandbox, "process-id.txt"), started.id, "utf8");
  await client.close();
  await server.close();
  process.exit(0);
}

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-process-recovery-control-"));
const oldCodeHome = process.env.CODEX_HOME;
const oldToolProfile = process.env.CHATGPT_TOOL_PROFILE;
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "full";
let client;
let server;
let id;
try {
  const childPath = path.join(sandbox, "restart-child.mjs");
  await fs.writeFile(childPath, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
console.log("READY-RESTART");
rl.on("line", (line) => console.log("AFTER-RESTART:" + line));
setInterval(() => {}, 1000);
`, "utf8");

  const phase1 = spawn(process.execPath, [self, "--phase1", sandbox], { cwd: process.cwd(), env: { ...process.env, CODEX_HOME: process.env.CODEX_HOME }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let phaseErr = "";
  phase1.stderr.on("data", (chunk) => { phaseErr += chunk.toString(); });
  const phaseCode = await new Promise((resolve, reject) => { phase1.once("error", reject); phase1.once("close", resolve); });
  assert.equal(phaseCode, 0, `phase1 failed: ${phaseErr}`);
  id = (await fs.readFile(path.join(sandbox, "process-id.txt"), "utf8")).trim();
  assert.ok(id);

  ({ client, server } = await createClient(sandbox));
  let status = data(await client.callTool({ name: "process_status", arguments: { id } }), "process_status").processes[0];
  assert.equal(status.recovered, true, JSON.stringify(status));
  assert.equal(status.running, true, JSON.stringify(status));
  assert.equal(status.control_available, true, JSON.stringify(status));
  assert.equal(status.control_mode, "durable_host");

  const { getProcessJournalRecord } = await import("../dist/lib/process-journal.js");
  const { processControlAvailable } = await import("../dist/lib/process-control.js");
  const record = await getProcessJournalRecord(sandbox, id);
  assert.ok(record);
  assert.equal(await processControlAvailable({ ...record, process_start_identity: "definitely-not-the-real-start-identity" }), false, "child identity mismatch must fail closed");
  assert.equal(await processControlAvailable({ ...record, host_start_identity: "definitely-not-the-real-host-identity" }), false, "host identity mismatch must fail closed");

  const input = data(await client.callTool({ name: "process_input", arguments: { id, text: "hello", append_newline: true, _intent: TEST_INTENT } }), "process_input");
  assert.equal(input.recovered, true);
  assert.equal(input.accepted, true);

  const deadline = Date.now() + 5000;
  let output;
  while (Date.now() < deadline) {
    output = data(await client.callTool({ name: "process_output", arguments: { id, output_mode: "full", tail_chars: 100000 } }), "process_output");
    if (String(output.stdout).includes("AFTER-RESTART:hello")) break;
    await delay(25);
  }
  assert.match(String(output?.stdout), /AFTER-RESTART:hello/);
  assert.equal(output.recovered, true);
  assert.equal(output.control_available, true);

  const stopped = data(await client.callTool({ name: "stop_process", arguments: { id, force: true, _intent: TEST_INTENT } }), "stop_process");
  assert.equal(stopped.recovered, true);
  assert.equal(stopped.stopped, true);

  const stopDeadline = Date.now() + 5000;
  while (Date.now() < stopDeadline) {
    status = data(await client.callTool({ name: "process_status", arguments: { id } }), "process_status").processes[0];
    if (status && !status.running) break;
    await delay(25);
  }
  assert.equal(status?.running, false, JSON.stringify(status));
  console.log("process-recovery-control PASS: durable host survives MCP process restart, stdin/stop recover, identity mismatch fails closed");
} finally {
  if (client && id) await client.callTool({ name: "stop_process", arguments: { id, force: true, _intent: TEST_INTENT } }).catch(() => {});
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (oldCodeHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodeHome;
  if (oldToolProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE; else process.env.CHATGPT_TOOL_PROFILE = oldToolProfile;
  await removeSandbox(sandbox);
}
