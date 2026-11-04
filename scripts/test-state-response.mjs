#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedGoalRunView, DEFAULT_GOAL_EVIDENCE_PAGE_SIZE, MAX_GOAL_EVIDENCE_PAGE_SIZE } from '../dist/lib/goal-run-view.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = Array.from({ length: 100 }, (_, i) => ({
  id: `ev-${i}`,
  kind: 'deterministic',
  summary: `evidence ${i}`,
  source: 'fixture',
  metadata: {},
  recordedAt: new Date(1700000000000 + i).toISOString(),
}));
const run = {
  runId: 'fixture-run', revision: 1, state: 'RUNNING', objective: 'fixture', criteria: [], typedEvidence: evidence,
  currentPhase: 'test', nextAction: null, resumeCursor: null, waitCondition: null, lease: null, stopReason: null,
  timestamps: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stateChangedAt: new Date().toISOString() },
};

const first = boundedGoalRunView(run);
assert.equal(first.typedEvidence.length, DEFAULT_GOAL_EVIDENCE_PAGE_SIZE);
assert.equal(first.typedEvidencePage.total, 100);
assert.equal(first.typedEvidencePage.next_offset, DEFAULT_GOAL_EVIDENCE_PAGE_SIZE);
assert.equal(first.typedEvidencePage.complete, false);
assert.equal(run.typedEvidence.length, 100, 'authoritative run must not be mutated');

const last = boundedGoalRunView(run, 96, 64);
assert.equal(last.typedEvidence.length, 4);
assert.equal(last.typedEvidencePage.next_offset, null);
assert.equal(last.typedEvidence[0].id, 'ev-96');
assert.equal(last.typedEvidence[3].id, 'ev-99');

const clamped = boundedGoalRunView(run, 0, 9999);
assert.equal(clamped.typedEvidence.length, MAX_GOAL_EVIDENCE_PAGE_SIZE);

const goalSource = fs.readFileSync(path.join(root, 'src/tools/goal.ts'), 'utf8');
assert.match(goalSource, /evidence_offset/);
assert.match(goalSource, /evidence_limit/);
assert.match(goalSource, /boundedGoalRunView/);
assert.ok(!/goal_run:\s*envelope\.run/.test(goalSource), 'goal tool must not return an unbounded envelope.run');

console.log('state-response PASS: 100 persisted evidence records remain intact; default response=8; cursor pagination and 64-record cap verified');
