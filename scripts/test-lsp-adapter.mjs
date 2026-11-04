#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-lsp-adapter-"));
const oldConfig = process.env.WEB_HARNESS_LSP_SERVERS;
const oldMarker = process.env.LSP_CANCEL_MARKER;
const sourceFile = path.join(sandbox, "sample.py");
const mockServer = path.join(sandbox, "mock-lsp.mjs");
const cancelMarker = path.join(sandbox, "cancelled.txt");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await fs.writeFile(sourceFile, "class Thing:\n    pass\n", "utf8");
await fs.writeFile(mockServer, `
import fs from "node:fs/promises";
let buffer = Buffer.alloc(0);
let modifiedOnce = false;
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
function loc() {
  const uri = process.env.LSP_TEST_URI;
  return { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } };
}
async function handle(message) {
  if (message.method === 'initialize') {
    send({ jsonrpc:'2.0', id:message.id, result:{ capabilities:{ definitionProvider:true, referencesProvider:true, implementationProvider:true, documentSymbolProvider:true, diagnosticProvider:{ interFileDependencies:false, workspaceDiagnostics:false } } } });
    return;
  }
  if (message.method === 'shutdown') { send({ jsonrpc:'2.0', id:message.id, result:null }); return; }
  if (message.method === 'textDocument/documentSymbol') {
    send({ jsonrpc:'2.0', id:message.id, result:[{ name:'Thing', kind:5, range:{start:{line:0,character:0},end:{line:1,character:8}}, selectionRange:{start:{line:0,character:6},end:{line:0,character:11}} }] });
    return;
  }
  if (message.method === 'textDocument/definition') {
    if (!modifiedOnce) { modifiedOnce = true; send({ jsonrpc:'2.0', id:message.id, error:{ code:-32801, message:'Content modified' } }); }
    else send({ jsonrpc:'2.0', id:message.id, result:[loc()] });
    return;
  }
  if (message.method === 'textDocument/references') { send({ jsonrpc:'2.0', id:message.id, result:[loc(), loc()] }); return; }
  if (message.method === 'textDocument/implementation') {
    if (process.env.LSP_HANG_IMPLEMENTATION === '1') return;
    send({ jsonrpc:'2.0', id:message.id, result:[loc()] }); return;
  }
  if (message.method === 'textDocument/diagnostic') {
    send({ jsonrpc:'2.0', id:message.id, result:{ kind:'full', items:[{ range:{start:{line:0,character:0},end:{line:0,character:5}}, severity:2, message:'mock diagnostic' }] } });
    return;
  }
  if (message.method === '$/cancelRequest') {
    if (process.env.LSP_CANCEL_MARKER) await fs.writeFile(process.env.LSP_CANCEL_MARKER, String(message.params?.id ?? 'unknown'));
    return;
  }
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\\r\\n\\r\\n');
    if (end < 0) return;
    const head = buffer.subarray(0,end).toString('ascii');
    const match = /Content-Length:\\s*(\\d+)/i.exec(head);
    if (!match) { buffer = buffer.subarray(end+4); continue; }
    const len = Number(match[1]), start=end+4;
    if (buffer.length < start+len) return;
    const body = buffer.subarray(start,start+len); buffer = buffer.subarray(start+len);
    Promise.resolve(handle(JSON.parse(body.toString('utf8')))).catch(() => {});
  }
});
setInterval(() => {}, 1000);
`, "utf8");

process.env.LSP_TEST_URI = new URL(`file:///${sourceFile.replaceAll("\\", "/")}`).href;
process.env.LSP_CANCEL_MARKER = cancelMarker;
process.env.WEB_HARNESS_LSP_SERVERS = JSON.stringify({ version: 1, servers: [{ id: "mock-python", extensions: [".py"], command: process.execPath, args: [mockServer], language_id: "python", timeout_ms: 2000 }] });

let client;
let server;
try {
  const { queryConfiguredLsp, probeConfiguredLsp } = await import("../dist/lib/lsp-adapter.js");
  const probe = await probeConfiguredLsp(sandbox, sourceFile);
  assert.equal(probe?.configured, true);
  assert.equal(probe?.server_id, "mock-python");

  const definition = await queryConfiguredLsp({ root: sandbox, file: sourceFile, action: "definition", query: "Thing" });
  assert.equal(definition?.backend, "lsp");
  assert.equal(definition?.content_modified_retries, 1, "ContentModified must retry exactly once in fixture");
  assert.equal(definition?.locations?.length, 1);
  assert.equal(definition?.locations?.[0]?.file, path.resolve(sourceFile));

  const refs = await queryConfiguredLsp({ root: sandbox, file: sourceFile, action: "references", query: "Thing" });
  assert.equal(refs?.locations?.length, 2);
  const diagnostics = await queryConfiguredLsp({ root: sandbox, file: sourceFile, action: "diagnostics" });
  assert.equal(diagnostics?.diagnostics?.[0]?.message, "mock diagnostic");

  const controller = new AbortController();
  process.env.LSP_HANG_IMPLEMENTATION = "1";
  const pending = queryConfiguredLsp({ root: sandbox, file: sourceFile, action: "implementations", query: "Thing", signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /aborted/i);
  delete process.env.LSP_HANG_IMPLEMENTATION;
  for (let i = 0; i < 40; i += 1) {
    try { if ((await fs.readFile(cancelMarker, "utf8")).trim()) break; } catch {}
    await delay(25);
  }
  assert.ok((await fs.readFile(cancelMarker, "utf8")).trim(), "$/cancelRequest marker missing");

  const { createMcpServer } = await import("../dist/server-factory.js");
  server = createMcpServer(sandbox, 5000, [sandbox], true);
  client = new Client({ name: "lsp-tool-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const toolResult = await client.callTool({ name: "code_intelligence", arguments: { action: "definition", backend: "auto", root: sandbox, file: sourceFile, query: "Thing" } });
  assert.equal(toolResult.structuredContent?.ok, true, JSON.stringify(toolResult.structuredContent));
  assert.equal(toolResult.structuredContent?.data?.backend, "lsp");

  const tsFile = path.join(sandbox, "sample.ts");
  await fs.writeFile(tsFile, "export const value = 1;\n", "utf8");
  const tsStatus = await client.callTool({ name: "code_intelligence", arguments: { action: "backend_status", root: sandbox, file: tsFile } });
  assert.equal(tsStatus.structuredContent?.data?.built_in_typescript, true);
  assert.equal(tsStatus.structuredContent?.data?.lsp_configured, false);
  assert.equal(tsStatus.structuredContent?.data?.selected_backend, "typescript-language-service");

  console.log("lsp-adapter PASS: optional stdio LSP, capability probe, ContentModified retry, cancellation, tool integration, TS fallback");
} finally {
  await client?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (oldConfig === undefined) delete process.env.WEB_HARNESS_LSP_SERVERS; else process.env.WEB_HARNESS_LSP_SERVERS = oldConfig;
  if (oldMarker === undefined) delete process.env.LSP_CANCEL_MARKER; else process.env.LSP_CANCEL_MARKER = oldMarker;
  delete process.env.LSP_HANG_IMPLEMENTATION;
  delete process.env.LSP_TEST_URI;
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
