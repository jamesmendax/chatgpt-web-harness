import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-code-intel-implementations-'));
const { codeImplementations } = await import('../dist/lib/code-intelligence.js');

try {
  const serviceFile = path.join(sandbox, 'service.ts');
  const duplicateA = path.join(sandbox, 'duplicate-a.ts');
  const duplicateB = path.join(sandbox, 'duplicate-b.ts');
  const config = path.join(sandbox, 'tsconfig.json');
  fs.writeFileSync(
    config,
    JSON.stringify({ compilerOptions: { strict: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' } }, null, 2)
  );
  fs.writeFileSync(
    serviceFile,
    [
      'export interface Service { run(): void; }',
      'export class Alpha implements Service { run() {} }',
      'export class Beta implements Service { run() {} }',
      'export class Gamma implements Service { run() {} }',
      '',
    ].join('\n')
  );
  fs.writeFileSync(duplicateA, 'export interface Duplicate { value: string; }\n');
  fs.writeFileSync(duplicateB, 'export interface Duplicate { value: number; }\n');

  const bounded = await codeImplementations(sandbox, 'Service', serviceFile, 20, 2);
  assert.equal(bounded.ambiguous, false);
  assert.equal(bounded.implementations.length, 2);
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.implementations.map((item) => item.name), ['Alpha', 'Beta']);
  assert.ok(bounded.implementations.every((item) => item.kind === 'class'));
  assert.ok(bounded.implementations.every((item) => item.file === path.resolve(serviceFile)));

  const complete = await codeImplementations(sandbox, 'Service', serviceFile, 20, 10);
  assert.equal(complete.ambiguous, false);
  assert.equal(complete.truncated, false);
  assert.deepEqual(complete.implementations.map((item) => item.name), ['Alpha', 'Beta', 'Gamma']);
  assert.ok(complete.implementations.every((item) => item.line >= 1 && item.character >= 1));

  const ambiguous = await codeImplementations(sandbox, 'Duplicate', undefined, 20, 10);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.implementations.length, 0);
  assert.equal(ambiguous.candidates.length, 2);

  console.log('code-intelligence-implementations: interface-to-class lookup, ambiguity guard, and result bound OK');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
