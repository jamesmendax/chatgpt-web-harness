#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-process-unicode-"));
const previousEnv = new Map([
  ["CODEX_HOME", process.env.CODEX_HOME],
  ["MCP_SHELL_STATE_DIR", process.env.MCP_SHELL_STATE_DIR],
]);
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
process.env.MCP_SHELL_STATE_DIR = path.join(sandbox, "shell-state");

const stdoutText = "stdout: 中文😀 café\n";
const stderrText = "stderr: 状态🛠️ café\n";
const stdoutSplitAt = Buffer.byteLength("stdout: 中文", "utf8") + 1;
const stderrSplitAt = Buffer.byteLength("stderr: 状态", "utf8") + 1;
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated Unicode process-control fixtures",
  scope: ["temporary Unicode child process in sandbox"],
  out_of_scope: [], deliverables: ["UTF-8 process output assertions"],
  success_criteria: ["start, observe, and cleanup preserve split UTF-8 output"],
  constraints: [], protected_resources: [], known_facts: ["child process belongs to this isolated test"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

function quoteForShell(value) {
  if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toolData(result, name) {
  if (!result?.structuredContent?.ok) {
    throw new Error(`${name} failed: ${JSON.stringify(result?.structuredContent ?? result)}`);
  }
  return result.structuredContent.data;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readUntil(filePath, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      last = await fs.readFile(filePath, "utf8");
      if (predicate(last)) return last;
    } catch {}
    await delay(20);
  }
  throw new Error(`timed out waiting for complete log ${filePath}: ${JSON.stringify(last.slice(-400))}`);
}

function extractTaggedOutput(log, stream) {
  const markers = [...log.matchAll(/\[(stdout|stderr)\]\n/g)].map((match) => ({
    stream: match[1],
    index: match.index,
    contentStart: match.index + match[0].length,
  }));
  let output = "";
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (marker.stream !== stream) continue;
    let end = markers[index + 1]?.index ?? log.length;
    const trailer = log.indexOf("\n# ", marker.contentStart);
    if (trailer >= 0) end = Math.min(end, trailer);
    output += log.slice(marker.contentStart, end);
  }
  return output;
}

async function waitForProcess(client, id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = toolData(await client.callTool({ name: "process_status", arguments: { id } }), "process_status");
    const processRecord = status.processes?.find((item) => item.id === id);
    if (processRecord && !processRecord.running) return processRecord;
    await delay(25);
  }
  throw new Error(`timed out waiting for process ${id}`);
}

const childPath = path.join(sandbox, "split-unicode-output.mjs");
await fs.writeFile(childPath, `
const stdout = Buffer.from(${JSON.stringify(stdoutText)}, "utf8");
const stderr = Buffer.from(${JSON.stringify(stderrText)}, "utf8");
function splitWrite(stream, bytes, splitAt) {
  // Split immediately after the first byte of a selected multi-byte code
  // point. The delay forces separate data events in the parent process.
  stream.write(bytes.subarray(0, splitAt));
  setTimeout(() => stream.write(bytes.subarray(splitAt)), 35);
}
splitWrite(process.stdout, stdout, ${stdoutSplitAt});
splitWrite(process.stderr, stderr, ${stderrSplitAt});
setTimeout(() => process.exit(0), 120);
`, "utf8");

const command = `node ${quoteForShell(childPath)}`;
let client;
let server;
let startedId;
try {
  const { bootstrapShellSession, execInShellSession } = await import("../dist/lib/persistent-shell.js");
  await bootstrapShellSession(sandbox);

  const direct = await execInShellSession(command, sandbox, 5000, sandbox);
  assert.equal(direct.exit_code, 0, `execInShellSession failed: ${direct.stderr}`);
  assert.ok(direct.stdout.includes(stdoutText.trim()), `stdout lost split Unicode: ${JSON.stringify(direct.stdout)}`);
  assert.ok(direct.stderr.includes(stderrText.trim()), `stderr lost split Unicode: ${JSON.stringify(direct.stderr)}`);
  assert.ok(!direct.stdout.includes("\uFFFD"), "execInShellSession stdout contains replacement character");
  assert.ok(!direct.stderr.includes("\uFFFD"), "execInShellSession stderr contains replacement character");
  assert.ok(direct.full_output_path, "execInShellSession did not expose its persistent log");
  const directLog = await fs.readFile(direct.full_output_path, "utf8");
  assert.equal(extractTaggedOutput(directLog, "stdout"), stdoutText, "execInShellSession log lost stdout Unicode");
  assert.equal(extractTaggedOutput(directLog, "stderr"), stderrText, "execInShellSession log lost stderr Unicode");
  assert.ok(!directLog.includes("\uFFFD"), "execInShellSession log contains replacement character");
  assert.ok(direct.stdout_chars > 0 && direct.stderr_chars > 0, "execInShellSession byte accounting was empty");

  const { createMcpServer } = await import("../dist/server-factory.js");
  server = createMcpServer(sandbox, 5000, [sandbox], true);
  client = new Client({ name: "process-unicode-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = "process-unicode-session";
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const started = toolData(await client.callTool({
    name: "start_process",
    arguments: { command, working_directory: sandbox, _intent: TEST_INTENT },
  }), "start_process");
  startedId = started.id;
  assert.ok(startedId, "start_process did not return an id");
  assert.ok(started.full_output_path, "start_process did not expose its persistent log");

  const status = await waitForProcess(client, startedId);
  assert.equal(status.exit_code, 0, `start_process failed: ${JSON.stringify(status)}`);
  const observed = toolData(await client.callTool({
    name: "process_output",
    arguments: { id: startedId, output_mode: "full", tail_chars: 200000 },
  }), "process_output");
  assert.ok(observed.stdout.includes(stdoutText.trim()), `process_output lost split stdout: ${JSON.stringify(observed.stdout)}`);
  assert.ok(observed.stderr.includes(stderrText.trim()), `process_output lost split stderr: ${JSON.stringify(observed.stderr)}`);
  assert.ok(!observed.stdout.includes("\uFFFD"), "process_output stdout contains replacement character");
  assert.ok(!observed.stderr.includes("\uFFFD"), "process_output stderr contains replacement character");
  assert.ok(observed.full_output_path, "process_output did not expose its persistent log");
  const processLog = await readUntil(
    observed.full_output_path,
    (value) => extractTaggedOutput(value, "stdout") === stdoutText
      && extractTaggedOutput(value, "stderr") === stderrText
      && !value.includes("\uFFFD"),
  );
  assert.equal(extractTaggedOutput(processLog, "stdout"), stdoutText, "start_process log lost stdout Unicode");
  assert.equal(extractTaggedOutput(processLog, "stderr"), stderrText, "start_process log lost stderr Unicode");
  assert.ok(!processLog.includes("\uFFFD"), "start_process log contains replacement character");
  assert.ok(observed.stdout_chars > 0 && observed.stderr_chars > 0, "start_process byte accounting was empty");

  console.log("process-unicode PASS: delayed UTF-8 stdout/stderr preserved by execInShellSession and start_process/process_output");
} finally {
  if (client && startedId) {
    await client.callTool({ name: "stop_process", arguments: { id: startedId, force: true, _intent: TEST_INTENT } }).catch(() => {});
  }
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(sandbox, { recursive: true, force: true });
}
