import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { searchDirectoryPage } from '../dist/tools/filesystem.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-search-cursor-'));
try {
  await fs.mkdir(path.join(root, 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.txt'), 'needle one\nother\nneedle two\n', 'utf8');
  await fs.writeFile(path.join(root, 'nested', 'b.txt'), 'needle three\nneedle four\n', 'utf8');

  const first = await searchDirectoryPage(root, 'needle', '*.txt', 0, 2);
  assert.equal(first.offset, 0);
  assert.equal(first.matches.length, 2);
  assert.equal(first.next_offset, 2);
  assert.equal(first.complete, false);
  assert.equal(first.truncated, true);
  assert.match(first.matches[0], /a\.txt:1: needle one$/);
  assert.match(first.matches[1], /a\.txt:3: needle two$/);

  const second = await searchDirectoryPage(root, 'needle', '*.txt', first.next_offset, 2);
  assert.equal(second.offset, 2);
  assert.equal(second.matches.length, 2);
  assert.equal(second.next_offset, null);
  assert.equal(second.complete, true);
  assert.equal(second.truncated, false);
  assert.match(second.matches[0], /nested[\\/]b\.txt:1: needle three$/);
  assert.match(second.matches[1], /nested[\\/]b\.txt:2: needle four$/);
  assert.equal(second.matches.some((row) => first.matches.includes(row)), false);

  const repeated = await searchDirectoryPage(root, 'needle', '*.txt', 2, 2);
  assert.deepEqual(repeated, second);
  console.log('search-cursor: deterministic paging, next_offset, completion, and no-repeat continuation OK');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}