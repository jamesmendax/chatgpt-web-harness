import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { shouldPruneRuntimeFile } from '../desktop/scripts/lib/runtime-file-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
assert.equal(pkg.dependencies.typescript, '6.0.3');
assert.equal(pkg.devDependencies?.typescript, undefined);
assert.equal(lock.packages[''].dependencies.typescript, '6.0.3');
const entries = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/typescript$/.test(name));
assert.equal(entries.length, 1, 'one TypeScript package in the locked dependency graph');
assert.equal(entries[0][1].version, '6.0.3');
assert.notEqual(entries[0][1].dev, true, 'semantic runtime dependency must survive --omit=dev');
assert.equal(ts.version, '6.0.3');
assert.equal(fs.existsSync(path.join(root, 'vendor/typescript-semantic/lib/typescript.js')), false);
assert.match(fs.readFileSync(path.join(root, 'src/lib/code-intelligence.ts'), 'utf8'), /import ts from "typescript"/);
assert.equal(fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink(), false, 'candidate dependencies must not mutate another release');
console.log('PASS single locked production TypeScript dependency serves build and semantic API');

for (const name of ['lib.d.ts', 'lib.es5.d.ts', 'lib.es2022.full.d.ts', 'lib.dom.d.ts']) {
  assert.equal(shouldPruneRuntimeFile('node_modules/typescript/lib/' + name), false);
}
assert.equal(shouldPruneRuntimeFile('node_modules/other/index.d.ts'), true);
assert.equal(shouldPruneRuntimeFile('node_modules/typescript/lib/typescript.d.ts'), true);
assert.equal(shouldPruneRuntimeFile('node_modules/typescript/lib/typescript.js'), false);
assert.equal(shouldPruneRuntimeFile('node_modules/other/index.js.map'), true);
assert.equal(shouldPruneRuntimeFile('dist/local.d.ts'), false);
console.log('PASS declaration pruning preserves semantic runtime standard libraries');

// Simulate the pruned production dependency in a disposable directory. This is
// not an installer/staging run and never touches an existing release payload.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-ts6-runtime-'));
try {
  const from = path.join(root, 'node_modules/typescript');
  const to = path.join(scratch, 'node_modules/typescript');
  let libraries = 0;
  fs.cpSync(from, to, {
    recursive: true,
    filter(source) {
      if (fs.statSync(source).isDirectory()) return true;
      const relative = 'node_modules/typescript/' + path.relative(from, source).split(path.sep).join('/');
      const keep = !shouldPruneRuntimeFile(relative);
      if (keep && /\/lib[^/]*\.d\.ts$/.test(relative)) libraries++;
      return keep;
    },
  });
  const load = createRequire(path.join(scratch, 'fixture.cjs'));
  const deployed = load('typescript');
  assert.equal(deployed.version, '6.0.3');
  const file = path.join(scratch, 'probe.ts');
  fs.writeFileSync(file, "const names: Array<string> = ['a'];\nconst result: Promise<number> = Promise.resolve(names.length);\n");
  const program = deployed.createProgram([file], { noEmit: true, strict: true, target: deployed.ScriptTarget.ES2022 });
  const errors = deployed.getPreEmitDiagnostics(program).filter((item) => item.category === deployed.DiagnosticCategory.Error);
  assert.deepEqual(errors.map((item) => [item.code, deployed.flattenDiagnosticMessageText(item.messageText, '\n')]), []);
  assert.ok(libraries > 0);
  console.log(JSON.stringify({ suite: 'typescript-unified', status: 'PASS', version: ts.version, retained_standard_libraries: libraries, pruned_runtime_diagnostics: errors.length, installer_run: false }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
