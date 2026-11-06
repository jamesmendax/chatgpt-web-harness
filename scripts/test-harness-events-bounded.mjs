import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setup, source, instrument, receipt } from './lib/context-events-test-fixture.mjs';

const { run, workspace } = await setup('events');
const records = [];
const events = await source('lib/harness-events.ts');
const projections = await source('lib/projection.ts');
const { module: inspected } = await instrument(run, 'harness-events.ts', text => `${text}\nexport const auditStats = () => ({states:logStates.size,ready:readyChains.size,append:appendChains.size});`);
const hash = value => createHash('sha256').update(value).digest('hex');
function event(seq, extra = {}) {
  return { type: 'evidence/recorded', seq, time: '2026-11-06T00:00:00.000Z', task_id: seq % 2 ? 'task-b' : 'task-a',
    project_roots: [workspace], evidence_kind: 'deterministic', data: { summary: `record-${seq} 中文 🧪 ${'x'.repeat(700)}`, artifact_sha256: hash(`artifact-${seq}`) }, ...extra };
}
const header = ws => ({ kind: 'harness-log', version: 2, workspace_root: ws, created_at: '2026-11-06T00:00:00.000Z' });
async function createLog(ws, count, legacy = false) {
  await fs.mkdir(ws, { recursive: true });
  const file = events.harnessEventLogPath(ws);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'w');
  try {
    if (!legacy) await handle.writeFile(`${JSON.stringify(header(ws))}\r\n`);
    for (let start = 0; start < count; start += 80) {
      const lines = [];
      for (let seq = start; seq < Math.min(count, start + 80); seq++) lines.push(JSON.stringify({ ...event(seq), ...(legacy ? { version: 1, workspace_root: ws } : {}) }));
      await handle.writeFile(`${lines.join('\r\n')}\r\n`);
    }
  } finally { await handle.close(); }
  return file;
}
const largeCount = 2400;
const logPath = await createLog(workspace, largeCount);
const initialBytes = (await fs.stat(logPath)).size;
assert.ok(initialBytes > 2 * 1024 * 1024);

let maxRead = 0, maxAllocation = 0, readCalls = 0;
const originalOpen = fs.open, originalReadFile = fs.readFile, originalAlloc = Buffer.alloc;
const watched = new Set([logPath]);
let shortReadPath;
fs.readFile = async (target, ...args) => {
  assert.ok(!watched.has(String(target)), 'production log reader must not allocate/read a whole file');
  return originalReadFile.call(fs, target, ...args);
};
fs.open = async (target, ...args) => {
  const handle = await originalOpen.call(fs, target, ...args);
  if (watched.has(String(target))) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      maxRead = Math.max(maxRead, length); readCalls++;
      return read(buffer, offset, target === shortReadPath ? Math.min(length, 37) : length, position);
    };
  }
  return handle;
};
Buffer.alloc = (size, ...args) => { maxAllocation = Math.max(maxAllocation, size); return originalAlloc(size, ...args); };
try {
  const health = await events.getHarnessEventLogHealth(workspace);
  assert.equal(health.events, largeCount);
  assert.equal(health.last_seq, largeCount - 1);
  assert.equal(health.format, 'v2');
  const strict = await events.readHarnessEvents(workspace, { limit: 7, task_id: 'task-a', from_seq: 2300 });
  assert.deepEqual(strict.map(item => item.seq), [2386, 2388, 2390, 2392, 2394, 2396, 2398]);
  assert.equal(strict.at(-1).data.artifact_sha256, hash('artifact-2398'));
  assert.ok(strict.at(-1).data.summary.includes('中文 🧪'));
  const tail = await events.readHarnessEventTail(workspace, 0, { limit: 7, type: 'evidence/recorded', task_id: 'task-a' });
  assert.deepEqual(tail.events, strict);
  assert.equal(tail.next_offset, initialBytes);
  assert.equal(tail.windowed, true);
  assert.equal(tail.matched_events, 1200);
  const appended = await events.appendHarnessEvent(workspace, { type: 'tool/observation', data: { summary: 'first append large log' } });
  assert.equal(appended.seq, largeCount, 'initial append must stream full count without collecting history');
  const incremental = await events.readHarnessEventTail(workspace, tail.next_offset, { file_identity: tail.file_identity });
  assert.equal(incremental.events.length, 1);
  assert.equal(incremental.events[0].seq, largeCount);
  assert.ok(maxRead <= 32768);
  assert.ok(maxAllocation <= 66560);
  records.push({ id: 'large-log-bounded-read', file_bytes: initialBytes, events: largeCount, max_read_bytes: maxRead, max_allocation_bytes: maxAllocation, read_calls: readCalls });

  const small = path.join(run, 'short-reads');
  const smallPath = await createLog(small, 4); watched.add(smallPath); shortReadPath = smallPath;
  const short = await events.readHarnessEvents(small, { limit: 10 });
  assert.deepEqual(short.map(item => item.seq), [0, 1, 2, 3]);
  assert.equal(short[3].data.summary, event(3).data.summary);
  shortReadPath = undefined;
  records.push({ id: 'short-read-utf8-crlf', passed: true });

  const torn = Buffer.from('{"type":"tool/observation","seq":2401,"time":"partial 中文');
  const beforeTorn = (await fs.stat(logPath)).size;
  await fs.appendFile(logPath, torn);
  const tornTail = await events.readHarnessEventTail(workspace, beforeTorn);
  assert.equal(tornTail.next_offset, beforeTorn);
  assert.equal(tornTail.events.length, 0);
  assert.equal((await events.getHarnessEventLogHealth(workspace)).torn_tail, true);
  assert.equal((await events.appendHarnessEvent(workspace, { type: 'tool/observation', data: { summary: 'repaired' } })).seq, 2401);
  const tails = (await fs.readdir(path.dirname(logPath))).filter(name => name.startsWith('harness-events.jsonl.tail-'));
  assert.equal(tails.length, 1);
  assert.equal(hash(await originalReadFile(path.join(path.dirname(logPath), tails[0]))), hash(torn), 'damaged bytes must survive repair');
  assert.equal((await events.getHarnessEventLogHealth(workspace)).events, 2402);
  const foreign = event(2402, { type: 'tool/observation', data: { summary: 'foreign append' } });
  await fs.appendFile(logPath, `${JSON.stringify(foreign)}\n`);
  assert.equal((await events.appendHarnessEvent(workspace, { type: 'tool/observation', data: {} })).seq, 2403);
  records.push({ id: 'torn-tail-preservation-foreign-append', passed: true });

  const noNewlineWs = path.join(run, 'no-newline');
  const noNewlinePath = await createLog(noNewlineWs, 1); watched.add(noNewlinePath);
  await fs.truncate(noNewlinePath, (await fs.stat(noNewlinePath)).size - 2);
  assert.equal((await events.appendHarnessEvent(noNewlineWs, { type: 'tool/observation', data: {} })).seq, 1);
  assert.equal((await events.getHarnessEventLogHealth(noNewlineWs)).events, 2);
  records.push({ id: 'valid-unterminated-line-append', passed: true });

  const corruptWs = path.join(run, 'mid-corrupt');
  const corruptPath = await createLog(corruptWs, 2); watched.add(corruptPath);
  await fs.appendFile(corruptPath, `not-json\n${JSON.stringify(event(2))}\n`);
  const corruptedHash = hash(await originalReadFile(corruptPath));
  assert.equal((await events.getHarnessEventLogHealth(corruptWs)).degraded, true);
  assert.equal((await events.appendHarnessEvent(corruptWs, { type: 'tool/observation', data: {} })).seq, 0);
  const archive = (await fs.readdir(path.dirname(corruptPath))).find(name => name.startsWith('harness-events.jsonl.corrupt-'));
  assert.ok(archive);
  assert.equal(hash(await originalReadFile(path.join(path.dirname(corruptPath), archive))), corruptedHash);
  records.push({ id: 'mid-corruption-whole-archive', passed: true });

  const legacyWs = path.join(run, 'legacy');
  const legacyPath = await createLog(legacyWs, 1100, true); watched.add(legacyPath);
  assert.equal((await events.getHarnessEventLogHealth(legacyWs)).format, 'legacy');
  assert.equal((await events.appendHarnessEvent(legacyWs, { type: 'tool/observation', data: {} })).seq, 1100);
  const legacyHealth = await events.getHarnessEventLogHealth(legacyWs);
  assert.equal(legacyHealth.events, 1101); assert.equal(legacyHealth.format, 'v2');
  const legacyWindow = await events.readHarnessEvents(legacyWs, { limit: 3 });
  assert.equal(legacyWindow[0].data.artifact_sha256, event(1098).data.artifact_sha256);
  records.push({ id: 'streamed-legacy-migration', events: legacyHealth.events, passed: true });

  const oversizedWs = path.join(run, 'oversized-valid-legacy');
  const oversizedPath = events.harnessEventLogPath(oversizedWs);
  await fs.mkdir(path.dirname(oversizedPath), { recursive: true }); watched.add(oversizedPath);
  await fs.writeFile(oversizedPath, `${JSON.stringify({ ...event(0), version: 1, workspace_root: oversizedWs, data: { summary: 'x'.repeat(200000) } })}\n`);
  const oversizedHash = hash(await originalReadFile(oversizedPath));
  assert.match((await events.getHarnessEventLogHealth(oversizedWs)).error, /bounded reader limit.*left untouched/);
  await assert.rejects(events.readHarnessEvents(oversizedWs), /bounded reader limit/);
  await assert.rejects(events.appendHarnessEvent(oversizedWs, { type: 'tool/observation', data: {} }), /bounded reader limit/);
  const oversizedTail = await events.readHarnessEventTail(oversizedWs, 0);
  assert.equal(oversizedTail.oversized_lines, 1);
  assert.equal(hash(await originalReadFile(oversizedPath)), oversizedHash, 'reader limit must never mutate a valid oversized legacy line');
  assert.equal((await fs.readdir(path.dirname(oversizedPath))).length, 1);
  records.push({ id: 'oversized-legacy-explicit-read-limit-no-repair', bytes: (await fs.stat(oversizedPath)).size, passed: true });

  const replacedWs = path.join(run, 'same-size-replacement');
  const replacedPath = await createLog(replacedWs, 2); watched.add(replacedPath);
  const originalTail = await events.readHarnessEventTail(replacedWs, 0);
  const replacement = `${replacedPath}.replacement`;
  await fs.copyFile(replacedPath, replacement); await fs.rename(replacement, replacedPath);
  const replacementTail = await events.readHarnessEventTail(replacedWs, originalTail.next_offset, { file_identity: originalTail.file_identity });
  assert.equal(replacementTail.reset, true); assert.equal(replacementTail.events.length, 2);
  records.push({ id: 'same-size-replacement-cursor-reset', passed: true });

  const newerWs = path.join(run, 'newer-header');
  const newerPath = events.harnessEventLogPath(newerWs); watched.add(newerPath);
  await fs.mkdir(path.dirname(newerPath), { recursive: true });
  await fs.writeFile(newerPath, `${JSON.stringify({ ...header(newerWs), version: 3 })}\n`);
  await assert.rejects(events.readHarnessEvents(newerWs), events.HarnessLogFormatError);
  await assert.rejects(events.appendHarnessEvent(newerWs, { type: 'tool/observation', data: {} }), events.HarnessLogFormatError);
  records.push({ id: 'newer-format-refusal', passed: true });
} finally {
  fs.open = originalOpen; fs.readFile = originalReadFile; Buffer.alloc = originalAlloc;
}

// Many concurrently active logs may outnumber the metadata cache. Active file
// locks remain until completion; cache eviction must never reuse seq=-1.
await Promise.all(Array.from({ length: 16 }, async (_, index) => {
  const ws = path.join(run, `concurrent-${index}`);
  await Promise.all(Array.from({ length: 8 }, () => inspected.appendHarnessEvent(ws, { type: 'tool/observation', data: { index } })));
  assert.equal((await inspected.getHarnessEventLogHealth(ws)).events, 8);
  assert.deepEqual((await inspected.readHarnessEvents(ws)).map(item => item.seq), Array.from({ length: 8 }, (_, seq) => seq));
}));
assert.deepEqual(inspected.auditStats(), { states: 4, ready: 0, append: 0 });
records.push({ id: 'bounded-metadata-concurrent-appends', workspaces: 16, events_per_workspace: 8, stats: inspected.auditStats() });

const parityWs = path.join(run, 'projection-parity');
let expectedGoal, expectedTask;
for (let i = 0; i < 8; i++) {
  expectedGoal = { id: 'goal-fixture', revision: i, phase: `phase-${i}` };
  expectedTask = { id: 'task-fixture', revision: i, step: `step-${i}` };
  await events.appendHarnessEvent(parityWs, { type: 'goal/change', data: { goal: expectedGoal } });
  await events.appendHarnessEvent(parityWs, { type: 'task/change', data: { task: expectedTask } });
}
const parityEvents = await events.readHarnessEvents(parityWs, { limit: 1000 });
assert.deepEqual(projections.replayProjection(projections.goalProjection, parityEvents), expectedGoal);
assert.deepEqual(projections.replayProjection(projections.taskProjection, parityEvents), expectedTask);
records.push({ id: 'projection-replay-parity', passed: true });
await receipt(run, ['src/lib/harness-events.ts', 'src/lib/bounded-context-cache.ts', 'scripts/test-harness-events-bounded.mjs'], records);
