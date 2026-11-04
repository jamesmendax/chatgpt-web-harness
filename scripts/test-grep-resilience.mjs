import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grepSearch, grepSearchPage, GREP_MAX_OUTPUT_CHARS } from '../dist/lib/grep-search.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'grep-resilience-'));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('PASS ' + name); }
try {
  await fs.writeFile(path.join(root, 'a.ts'), 'first\nneedle\nthird\nNEEDLE\n');
  await test('explicit file path really searches the file', async () => {
    const result = await grepSearch({ path: path.join(root, 'a.ts'), pattern: 'needle' });
    assert.match(result, /a\.ts:2: needle/); assert.ok(!result.includes('No matches'));
  });
  await test('case-insensitive matches and count mode', async () => {
    assert.match(await grepSearch({ path: root, pattern: 'needle', caseInsensitive: true, outputMode: 'count' }), /a\.ts:2/);
  });
  await test('context and head limits are explicit', async () => {
    const result = await grepSearch({ path: root, pattern: 'needle', contextAround: 1, headLimit: 2 });
    assert.match(result, /first/); assert.match(result, /search incomplete: head_limit/);
  });
  await test('cursor continuation advances without repeating result rows', async () => {
    const first = await grepSearchPage({ path: path.join(root, 'a.ts'), pattern: 'needle', caseInsensitive: true, headLimit: 1 });
    assert.equal(first.rows, 1);
    assert.equal(first.offset, 0);
    assert.equal(first.next_offset, 1);
    assert.equal(first.complete, false);
    assert.match(first.output, /a\.ts:2: needle/);
    const second = await grepSearchPage({ path: path.join(root, 'a.ts'), pattern: 'needle', caseInsensitive: true, headLimit: 1, offset: first.next_offset });
    assert.equal(second.rows, 1);
    assert.equal(second.offset, 1);
    assert.match(second.output, /a\.ts:4: NEEDLE/);
    assert.doesNotMatch(second.output, /a\.ts:2: needle/);
  });
  await test('recursive glob and files-with-matches mode', async () => {
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'b.ts'), 'needle');
    const result = await grepSearch({ path: root, glob: '**/*.ts', pattern: 'needle', outputMode: 'files_with_matches' });
    assert.match(result, /a\.ts/); assert.match(result, /b\.ts/);
  });
  await test('binary and overlarge inputs are omitted with an explicit warning', async () => {
    await fs.writeFile(path.join(root, 'payload.exe'), Buffer.alloc(4096));
    await fs.writeFile(path.join(root, 'large.txt'), 'needle'.repeat(400000));
    const result = await grepSearch({ path: root, pattern: 'needle' });
    assert.match(result, /binary files omitted/); assert.match(result, /files larger than 2 MiB omitted/);
  });
  await test('very long matching line cannot exceed the output budget', async () => {
    const target = path.join(root, 'long.txt'); await fs.writeFile(target, 'needle' + 'x'.repeat(100000));
    const result = await grepSearch({ path: target, pattern: 'needle' });
    assert.ok(result.length < GREP_MAX_OUTPUT_CHARS + 300); assert.match(result, /output character budget/);
  });
  await test('exact output budget remains incomplete when another match is pending', async () => {
    const target = path.join(root, 'exact-budget.txt');
    const match = 'needle';
    const prefix = `${target}:1: `;
    const firstLine = match + 'x'.repeat(GREP_MAX_OUTPUT_CHARS - 1 - prefix.length - match.length);
    assert.equal(prefix.length + firstLine.length + 1, GREP_MAX_OUTPUT_CHARS);
    await fs.writeFile(target, `${firstLine}\n${match}\n`);
    const result = await grepSearchPage({ path: target, pattern: 'needle', headLimit: 10 });
    assert.equal(result.rows, 1);
    assert.ok(result.output.startsWith(`${prefix}${firstLine}\n`));
    assert.ok(!result.output.includes(`${target}:2: ${match}`));
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.ok(result.reasons.includes('output character budget'));
  });
  await test('multiline match count is not capture-group count', async () => {
    const target = path.join(root, 'multi.txt'); await fs.writeFile(target, 'foo\nbar\nfoo\nbar');
    assert.match(await grepSearch({ path: target, pattern: '(foo)\\n(bar)', multiline: true, outputMode: 'count' }), /multi\.txt:2/);
  });
  await test('invalid regular expressions remain errors', async () => {
    await assert.rejects(grepSearch({ path: root, pattern: '[' }), SyntaxError);
  });
  await test('no-match small file retains established response', async () => {
    assert.equal(await grepSearch({ path: path.join(root, 'a.ts'), pattern: 'absent' }), 'No matches found');
  });
  console.log(`grep-resilience: ${passed}/${passed} PASS`);
} finally { await fs.rm(root, { recursive: true, force: true }); }
