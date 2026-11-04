import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-code-intel-v3-'));
const checkpointDir = path.join(sandbox, '.checkpoints');
process.env.CHECKPOINT_PATH = checkpointDir;

const { codeFind, codeRenameApply } = await import('../dist/lib/code-intelligence.js');

try {
  const a = path.join(sandbox, 'a.ts');
  const b = path.join(sandbox, 'b.ts');
  const config = path.join(sandbox, 'tsconfig.json');
  fs.writeFileSync(config, JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' } }, null, 2));
  fs.writeFileSync(a, 'export class Counter { value = 0; inc(){ this.value++; } }\nexport function makeCounter(){ return new Counter(); }\n');
  fs.writeFileSync(b, "import { Counter, makeCounter } from './a.js';\nconst c: Counter = makeCounter();\nc.inc();\n");

  const first = await codeFind(sandbox, 'Counter', 20, 20);
  assert.equal(first.cache_hit, false);
  assert.equal(path.resolve(first.config_file), path.resolve(config));
  assert.match(first.backend_fingerprint, /^[a-f0-9]{64}$/);

  const second = await codeFind(sandbox, 'Counter', 20, 20);
  assert.equal(second.cache_hit, true);
  assert.equal(second.backend_fingerprint, first.backend_fingerprint);

  fs.appendFileSync(b, 'const extra = 1;\n');
  const afterSourceChange = await codeFind(sandbox, 'Counter', 20, 20);
  assert.equal(afterSourceChange.cache_hit, false);
  assert.notEqual(afterSourceChange.backend_fingerprint, first.backend_fingerprint);

  const applied = await codeRenameApply(sandbox, 'Counter', 'Accumulator', a, 20, 50);
  assert.equal(applied.applied, true);
  assert.ok(applied.file_count >= 2);
  assert.ok(applied.edit_count >= 4);
  assert.match(String(applied.checkpoint_id), /^cp_[a-f0-9]{12}$/);
  assert.match(fs.readFileSync(a, 'utf8'), /class Accumulator/);
  assert.match(fs.readFileSync(a, 'utf8'), /new Accumulator\(\)/);
  assert.match(fs.readFileSync(b, 'utf8'), /import \{ Accumulator, makeCounter \}/);
  assert.match(fs.readFileSync(b, 'utf8'), /const c: Accumulator/);
  assert.doesNotMatch(fs.readFileSync(a, 'utf8'), /class Counter|new Counter\(\)/);

  const afterRename = await codeFind(sandbox, 'Accumulator', 20, 20);
  assert.equal(afterRename.cache_hit, false, 'successful rename must invalidate cached language services');
  assert.ok(afterRename.items.some((item) => item.name === 'Accumulator'));
  const afterRenameCached = await codeFind(sandbox, 'Accumulator', 20, 20);
  assert.equal(afterRenameCached.cache_hit, true);

  await assert.rejects(() => codeRenameApply(sandbox, 'Accumulator', 'not-valid-name', a, 20, 50), /CODE_RENAME_INVALID_NAME/);

  fs.writeFileSync(path.join(sandbox, 'c.ts'), 'export const unrelated = 1;\n');
  const truncated = await codeRenameApply(sandbox, 'Accumulator', 'Totalizer', a, 1, 50);
  assert.equal(truncated.applied, false);
  assert.equal(truncated.reason, 'inventory_truncated');
  assert.match(fs.readFileSync(a, 'utf8'), /class Accumulator/);

  const checkpointIndex = JSON.parse(fs.readFileSync(path.join(checkpointDir, 'index.json'), 'utf8'));
  assert.ok(checkpointIndex.checkpoints.some((entry) => entry.id === applied.checkpoint_id));

  console.log('code-intelligence-v3: tsconfig, cache hit/invalidation, checkpointed CAS cross-file rename, invalid-name and truncated-inventory guards OK');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}