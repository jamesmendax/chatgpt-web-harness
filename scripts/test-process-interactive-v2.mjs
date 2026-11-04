#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-process-interactive-v2-"));
const oldCodeHome = process.env.CODEX_HOME;
const oldToolProfile = process.env.CHATGPT_TOOL_PROFILE;
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "full";
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated interactive process-control fixtures",
  scope: ["temporary interactive child process in sandbox"],
  out_of_scope: [], deliverables: ["stdin and output paging assertions"],
  success_criteria: ["process start, stdin writes, paging, and cleanup complete deterministically"],
  constraints: [], protected_resources: [], known_facts: ["the child process belongs to this isolated test"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

const quote = (value) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
const data = (result, name) => {
  if (!result?.structuredContent?.ok) throw new Error(`${name} failed: ${JSON.stringify(result?.structuredContent ?? result)}`);
  return result.structuredContent.data;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function removeSandbox(root) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await fs.rm(root, { recursive: true, force: true }); return; }
    catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 19) throw error;
      await delay(50);
    }
  }
}

async function waitOutput(client, id, needle, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = data(await client.callTool({ name: "process_output", arguments: { id, output_mode: "full", tail_chars: 100000 } }), "process_output");
    if (`${last.stdout}\n${last.stderr}`.includes(needle)) return last;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${needle}: ${JSON.stringify(last)}`);
}

let client;
let server;
let id;
try {
  const child = path.join(sandbox, "interactive-child.mjs");
  await fs.writeFile(child, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, terminal: false });
console.log("READY");
rl.on("line", (line) => {
  console.log("ECHO:" + line);
  if (line === "quit") process.exit(0);
});
`, "utf8");

  const { createMcpServer } = await import("../dist/server-factory.js");
  server = createMcpServer(sandbox, 5000, [sandbox], true);
  client = new Client({ name: "process-interactive-v2", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = "process-interactive-v2-session";
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const started = data(await client.callTool({ name: "start_process", arguments: { command: `node ${quote(child)}`, working_directory: sandbox, _intent: TEST_INTENT } }), "start_process");
  id = started.id;
  assert.equal(started.control_mode, "durable_host");
  await waitOutput(client, id, "READY");

  const firstPage = data(await client.callTool({ name: "process_output", arguments: { id, view: "absolute", offset: 0, max_bytes: 4096 } }), "process_output");
  assert.equal(firstPage.cursor_mode, "absolute");
  const cursor = firstPage.log_page.size;

  const inputA = data(await client.callTool({ name: "process_input", arguments: { id, text: "alpha", append_newline: true, _intent: TEST_INTENT } }), "process_input");
  assert.equal(inputA.accepted, true);
  await waitOutput(client, id, "ECHO:alpha");

  const newPage = data(await client.callTool({ name: "process_output", arguments: { id, view: "new", offset: cursor, max_bytes: 4096 } }), "process_output");
  assert.equal(newPage.cursor_mode, "new");
  assert.match(newPage.log_page.content, /ECHO:alpha/);

  const inputB = data(await client.callTool({ name: "process_input", arguments: { id, text: "beta", append_newline: true, _intent: TEST_INTENT } }), "process_input");
  assert.equal(inputB.accepted, true);
  await waitOutput(client, id, "ECHO:beta");
  const tailPage = data(await client.callTool({ name: "process_output", arguments: { id, view: "tail", max_bytes: 4096 } }), "process_output");
  assert.equal(tailPage.cursor_mode, "tail");
  assert.match(tailPage.log_page.content, /ECHO:beta/);

  await client.callTool({ name: "process_input", arguments: { id, text: "quit", append_newline: true, close_stdin: true, _intent: TEST_INTENT } });
  const deadline = Date.now() + 5000;
  let finalStatus;
  while (Date.now() < deadline) {
    finalStatus = data(await client.callTool({ name: "process_status", arguments: { id } }), "process_status").processes[0];
    if (finalStatus && !finalStatus.running) break;
    await delay(25);
  }
  assert.equal(finalStatus?.running, false);
  assert.equal(finalStatus?.exit_code, 0);
  console.log("process-interactive-v2 PASS: stdin plus absolute/new/tail paging over durable logs");
} finally {
  if (client && id) await client.callTool({ name: "stop_process", arguments: { id, force: true, _intent: TEST_INTENT } }).catch(() => {});
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (oldCodeHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodeHome;
  if (oldToolProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE; else process.env.CHATGPT_TOOL_PROFILE = oldToolProfile;
  await removeSandbox(sandbox);
}
