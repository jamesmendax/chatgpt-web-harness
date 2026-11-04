import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-resilience-test-'));
const oldHome = process.env.CODEX_HOME;
const oldBudget = process.env.MCP_RESULT_MAX_BYTES;
process.env.CODEX_HOME = path.join(temp, 'home');
const { guardToolResult, resultByteBudget, synchronousCommandBudget, withSynchronousCommandSlot,
  resilienceDirectory, MAX_SERIALIZED_RESULT_BYTES, recordTransportEvent } = await import('../dist/lib/transport-resilience.js');
const { InvocationGateway } = await import('../dist/lib/invocation-gateway.js');
const context = { definition: { name: 'fixture', source: 'native' }, scope: { invocationId: 'fixture-1',
  workspaceRoot: temp, projectRoots: [temp], mcpSessionId: 'test-session', requestId: 'r1' }, rawArgs: { secret: 'SECRET_ARGUMENT' }, callbackArgs: [] };
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const envelope = data => { const payload = { ok: true, tool: 'fixture', summary: 'fixture', data };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload }; };
try {
  await test('safe default, configured cap, malformed and excessive budgets', () => {
    delete process.env.MCP_RESULT_MAX_BYTES;
    assert.equal(resultByteBudget(), 6 * 1024 * 1024);
    process.env.MCP_RESULT_MAX_BYTES = '999999999'; assert.equal(resultByteBudget(), MAX_SERIALIZED_RESULT_BYTES);
    process.env.MCP_RESULT_MAX_BYTES = '65536'; assert.equal(resultByteBudget(), 65536);
    process.env.MCP_RESULT_MAX_BYTES = 'NaN'; assert.equal(resultByteBudget(), MAX_SERIALIZED_RESULT_BYTES);
    delete process.env.MCP_RESULT_MAX_BYTES;
  });
  await test('sync budgets preserve smaller limits and known deadline reserve', () => {
    assert.equal(synchronousCommandBudget(120000), 90000);
    assert.equal(synchronousCommandBudget(30000), 30000);
    assert.equal(synchronousCommandBudget(120000, 21000, 1000), 5000);
    assert.equal(synchronousCommandBudget(120000, 12000, 1000), 0);
  });
  await test('small result and image block remain byte-equivalent', async () => {
    const value = envelope({ text: 'ok' }); value.content.push({ type: 'image', data: 'AA==', mimeType: 'image/png' });
    assert.deepEqual(await guardToolResult(context, value), value);
  });
  await test('UTF-8 overflow persists exact original with SHA256, not false success', async () => {
    const value = envelope({ text: '\u4e2d'.repeat(9000) });
    const guarded = await guardToolResult(context, value, { budget: 16384 });
    assert.equal(guarded.isError, true); assert.ok(bytes(guarded) < 16384);
    const data = guarded.structuredContent.data;
    assert.equal(data.spill_saved, true); assert.equal(data.verifies_criterion, false);
    const original = await fs.readFile(data.full_output_path);
    assert.equal(data.serialized_bytes, original.length);
    assert.deepEqual(JSON.parse(original), value);
    assert.equal(data.sha256, createHash('sha256').update(original).digest('hex'));
  });
  await test('only exact duplicate envelope text is compacted; structured data and images survive', async () => {
    const value = envelope({ text: 'x'.repeat(90000) });
    value.content.push({ type: 'text', text: 'independent annotation' }, { type: 'image', data: 'AA==', mimeType: 'image/png' });
    const guarded = await guardToolResult(context, value, { compactDuplicates: true });
    assert.deepEqual(guarded.structuredContent, value.structuredContent);
    assert.deepEqual(guarded.content.slice(1), value.content.slice(1));
    assert.ok(bytes(guarded) < bytes(value) * 0.6);
    assert.equal(JSON.parse(guarded.content[0].text).data.duplicate_text_omitted, true);
  });
  await test('arbitrary proxy text is never silently dropped', async () => {
    const value = envelope({ text: 'x'.repeat(90000) }); value.content[0].text = 'not a duplicate';
    assert.deepEqual(await guardToolResult(context, value, { compactDuplicates: true }), value);
  });
  await test('oversized image result fails small and retains complete source bytes', async () => {
    const value = { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(7 * 1024 * 1024) }] };
    const guarded = await guardToolResult(context, value);
    assert.equal(guarded.isError, true); assert.ok(bytes(guarded) < MAX_SERIALIZED_RESULT_BYTES);
    assert.deepEqual(JSON.parse(await fs.readFile(guarded.structuredContent.data.full_output_path, 'utf8')), value);
  });
  await test('spill failure is explicit and does not invent a saved path', async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(temp, 'not-a-directory'); await fs.writeFile(process.env.CODEX_HOME, 'fixture');
    const guarded = await guardToolResult(context, envelope({ text: 'x'.repeat(50000) }), { budget: 16384 });
    assert.equal(guarded.isError, true); assert.equal(guarded.structuredContent.data.spill_saved, false);
    assert.equal(guarded.structuredContent.data.full_output_path, undefined);
    process.env.CODEX_HOME = previous;
  });
  await test('serialization failure returns an explicit small error', async () => {
    const value = { content: [] }; value.circular = value;
    const guarded = await guardToolResult(context, value);
    assert.equal(guarded.isError, true); assert.match(guarded.content[0].text, /RESULT_SERIALIZATION_FAILED/);
  });
  await test('gateway guards BEFORE evidence hooks and AFTER enrichment', async () => {
    const large = { content: [{ type: 'text', text: 'x'.repeat(7 * 1024 * 1024) }] };
    let protectedBeforeHook = false;
    // Mirror the current EffectiveToolDefinition contract. The transport test
    // intentionally uses a read-only fixture so Requirement/Relay admission is
    // not part of this assertion; omitting config made the benchmark depend on
    // an obsolete pre-gateway definition shape.
    const registry = { get: () => ({
      name: 'fixture',
      source: 'native',
      config: { annotations: { readOnlyHint: true } },
      execute: async () => large,
    }) };
    const gateway = new InvocationGateway(registry, { workspaceRoot: temp, projectRoots: [temp] }, {
      onSuccess: async (_ctx, value) => { protectedBeforeHook = value.isError === true; return large; },
    });
    const guarded = await gateway.invoke('fixture', [{}, { requestId: 3, signal: new AbortController().signal }]);
    assert.equal(protectedBeforeHook, true); assert.equal(guarded.isError, true); assert.ok(bytes(guarded) < MAX_SERIALIZED_RESULT_BYTES);
  });
  await test('duplicate compaction safely handles circular structured results', async () => {
    const value = { content: [], structuredContent: { ok: true, tool: 'fixture' } };
    value.structuredContent.self = value.structuredContent;
    const guarded = await guardToolResult(context, value, { compactDuplicates: true });
    assert.equal(guarded.isError, true);
    assert.match(guarded.content[0].text, /RESULT_SERIALIZATION_FAILED/);
  });
  await test('expired queued operation NEVER runs later', async () => {
    let release; let executed = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const first = withSynchronousCommandSlot(async () => { await gate; return 'first'; }, 1000);
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = withSynchronousCommandSlot(async () => { executed++; }, 15);
    await assert.rejects(second, /COMMAND_NOT_STARTED/);
    release(); await first;
    await withSynchronousCommandSlot(async remaining => { assert.ok(remaining > 0 && remaining <= 1000); }, 1000);
    assert.equal(executed, 0);
  });
  await test('queue cancellation and prior failures preserve later valid work', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(withSynchronousCommandSlot(async () => { throw Error('must not start'); }, 100, controller.signal), /COMMAND_NOT_STARTED/);
    await assert.rejects(withSynchronousCommandSlot(async () => { throw Error('fixture failure'); }, 100), /fixture failure/);
    assert.equal(await withSynchronousCommandSlot(async () => 'recovered', 1000), 'recovered');
  });
  await test('diagnostic journal excludes arguments and raw tool contents', async () => {
    await guardToolResult(context, envelope({ content: 'SECRET_CONTENT' }));
    const log = await fs.readFile(path.join(resilienceDirectory(temp), 'events.jsonl'), 'utf8');
    assert.ok(!log.includes('SECRET_CONTENT') && !log.includes('SECRET_ARGUMENT'));
    assert.match(log, /result_bytes/); assert.match(log, /deadline_known/);
    assert.match(log, /oversize_result_blocked/);
  });
  await test('journal rotation is bounded', async () => {
    const file = path.join(resilienceDirectory(temp), 'events.jsonl');
    await fs.writeFile(file, 'x'.repeat(2 * 1024 * 1024));
    await recordTransportEvent(temp, { outcome: 'fixture' });
    assert.equal((await fs.stat(file + '.1')).size, 2 * 1024 * 1024);
    assert.ok((await fs.stat(file)).size < 500);
  });
  await test('integrated binary chunk cap is below Base64 transport envelope budget', async () => {
    const source = await fs.readFile(new URL('../src/tools/filesystem.ts', import.meta.url), 'utf8');
    assert.match(source, /MAX_BINARY_CHUNK_BYTES = 1024 \* 1024/);
    const value = envelope({ content: Buffer.alloc(1024 * 1024).toString('base64') });
    assert.ok(bytes(value) < MAX_SERIALIZED_RESULT_BYTES);
  });
  console.log(`transport-resilience: ${passed}/${passed} PASS (offline fixtures; no live MCP/Tunnel lifecycle)`);
} finally {
  if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
  if (oldBudget === undefined) delete process.env.MCP_RESULT_MAX_BYTES; else process.env.MCP_RESULT_MAX_BYTES = oldBudget;
  await fs.rm(temp, { recursive: true, force: true });
}
