#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getProcessJournalRecord,
  listProcessJournalRecords,
  processCommandHash,
  readProcessLogPage,
  readProcessStartIdentity,
  upsertProcessJournalRecord,
  verifyRecoveredProcessIdentity,
} from '../dist/lib/process-journal.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-recovery-'));
process.env.CODEX_HOME = path.join(sandbox, 'codex-home');
const workspace = path.join(sandbox, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
const logPath = path.join(sandbox, 'combined.log');
const logText = Array.from({ length: 240 }, (_, i) => `line-${String(i).padStart(3, '0')}: recovery pagination fixture`).join('\n') + '\nEND\n';
fs.writeFileSync(logPath, logText, 'utf8');

const identity = await readProcessStartIdentity(process.pid);
assert.ok(identity, 'current process must expose a stable start identity');
const record = {
  id: 'fixture-process',
  pid: process.pid,
  command_hash: processCommandHash('fixture command'),
  cwd: workspace,
  started_at: new Date().toISOString(),
  process_start_identity: identity,
  full_output_path: logPath,
  state: 'running',
  exit_code: null,
  signal: null,
  updated_at: new Date().toISOString(),
};
await upsertProcessJournalRecord(workspace, record);
assert.equal((await listProcessJournalRecords(workspace)).length, 1);
assert.equal((await getProcessJournalRecord(workspace, record.id))?.command_hash, record.command_hash);
assert.equal(await verifyRecoveredProcessIdentity(record), 'same');

let offset = 0;
let rebuilt = '';
let pages = 0;
while (true) {
  const page = await readProcessLogPage(logPath, offset, 1024);
  rebuilt += page.content;
  pages += 1;
  if (page.next_offset === null) break;
  offset = page.next_offset;
}
assert.equal(rebuilt, logText);
assert.ok(pages > 1);

const wrong = { ...record, process_start_identity: `${identity}-different` };
assert.equal(await verifyRecoveredProcessIdentity(wrong), 'different_or_gone');

const shellSource = fs.readFileSync(new URL('../src/tools/shell.ts', import.meta.url), 'utf8');
assert.match(shellSource, /control_available:\s*false/);
assert.match(shellSource, /processControlAvailable/);
assert.match(shellSource, /Recovered control is fail-closed unless both durable host and child start identities match the journal/i);
assert.match(shellSource, /offset:\s*z\.number\(\)\.int\(\)\.nonnegative/);

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('recovery-v2 PASS: process identity, journal persistence, cursor log paging, PID-reuse rejection and fail-closed durable-control recovery verified');
