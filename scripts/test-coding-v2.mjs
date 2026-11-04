#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeTextFileCas } from '../dist/lib/safe-text-write.js';
import { codeDefinition, codeDiagnostics, codeFind, codeReferences, codeRenameLocations } from '../dist/lib/code-intelligence.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-coding-'));
try {
  const file = path.join(sandbox, 'cas.txt');
  const created = await writeTextFileCas(file, 'one', { createOnly: true });
  assert.equal(created.created, true);
  assert.equal(created.sha256, sha('one'));

  const updated = await writeTextFileCas(file, 'two', { expectedSha256: sha('one') });
  assert.equal(updated.previous_sha256, sha('one'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');

  await assert.rejects(() => writeTextFileCas(file, 'stale', { expectedSha256: sha('one') }), /WRITE_CONFLICT/);
  await assert.rejects(() => writeTextFileCas(file, 'duplicate', { createOnly: true }), /WRITE_CONFLICT/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'two');

  const concurrencyFile = path.join(sandbox, 'concurrent.txt');
  fs.writeFileSync(concurrencyFile, 'base');
  const baseSha = sha('base');
  const attempts = await Promise.allSettled([
    writeTextFileCas(concurrencyFile, 'left', { expectedSha256: baseSha }),
    writeTextFileCas(concurrencyFile, 'right', { expectedSha256: baseSha }),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((item) => item.status === 'rejected').length, 1);
  assert.match(String(attempts.find((item) => item.status === 'rejected')?.reason), /WRITE_CONFLICT/);

  const a = path.join(sandbox, 'a.ts');
  const b = path.join(sandbox, 'b.ts');
  fs.writeFileSync(a, 'export class Counter { value = 0; inc(){ this.value++; } }\nexport function makeCounter(){ return new Counter(); }\n');
  fs.writeFileSync(b, "import { Counter, makeCounter } from './a.js';\nconst c: Counter = makeCounter();\nc.inc();\nconst bad: number = 'x';\n");

  const found = await codeFind(sandbox, 'Counter', 20, 20);
  assert.ok(found.items.some((item) => item.name === 'Counter' && path.resolve(item.file) === path.resolve(a)));
  assert.ok(found.items.every((item) => path.resolve(item.file).startsWith(path.resolve(sandbox))), 'find must exclude TypeScript standard-library symbols');

  const refs = await codeReferences(sandbox, 'Counter', a, 20, 20);
  assert.equal(refs.ambiguous, false);
  assert.ok(refs.references.length >= 4);
  assert.ok(refs.references.some((item) => path.resolve(item.file) === path.resolve(b)));

  const defs = await codeDefinition(sandbox, 'Counter', a, 20, 20);
  assert.equal(defs.ambiguous, false);
  assert.ok(defs.definitions.some((item) => path.resolve(item.file) === path.resolve(a)));

  const diagnostics = await codeDiagnostics(b, 20);
  assert.ok(diagnostics.diagnostics.some((item) => item.code === 2322));

  const rename = await codeRenameLocations(sandbox, 'Counter', a, 20, 20);
  assert.equal(rename.ambiguous, false);
  assert.ok(rename.locations.length >= 4);
  assert.ok(rename.locations.some((item) => path.resolve(item.file) === path.resolve(b)));

  console.log('coding-v2 PASS: create-only/CAS/lost-update conflict and TS semantic find/definition/reference/diagnostic/rename preview verified');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
