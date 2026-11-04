import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

// Isolated fixtures only. Never use the live CODEX_HOME or launch a watchdog.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-goal-status-purity-'));
const savedHome = process.env.CODEX_HOME;
const savedWatchdog = process.env.GOAL_WATCHDOG_ENABLED;
process.env.CODEX_HOME = path.join(temp, 'home');
process.env.GOAL_WATCHDOG_ENABLED = 'false';
const workspace = path.join(temp, 'workspace');
await fs.mkdir(workspace);
const { registerGoalTool } = await import('../dist/tools/goal.js');
const { createGoal, getGoal } = await import('../dist/lib/goals.js');
const { readGoalRun } = await import('../dist/lib/goal-run-store.js');
const { createRuntimeScope, runWithRuntimeScope } = await import('../dist/lib/runtime-scope.js');
let registration;
registerGoalTool({ registerTool(name, config, callback) { registration = { name, config, callback }; } }, workspace);
const schema = z.object(registration.config.inputSchema);
const invoke = async (args) => {
  const result = await registration.callback(schema.parse(args));
  return { ...result.structuredContent, isError: result.isError === true };
};
async function inventory(dir) {
  const files = [];
  async function visit(current) {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) {
        const stat = await fs.stat(full);
        files.push({ path: path.relative(dir, full), hash: createHash('sha256').update(await fs.readFile(full)).digest('hex'), mtime: stat.mtimeMs });
      }
    }
  }
  await visit(dir);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
let passed = 0;
async function test(name, callback) { await callback(); passed++; console.log(`PASS ${name}`); }
try {
  await test('status on empty workspace creates no state', async () => {
    const before = await inventory(temp);
    const result = await invoke({ action: 'status' });
    assert.equal(result.ok, true);
    assert.equal(result.data.goal, null);
    assert.equal(result.data.status_read_only, true);
    assert.deepEqual(await inventory(temp), before);
  });
  const legacy = await createGoal(workspace, { objective: 'private fixture objective', success_criteria: [{ name: 'fixture obligation', passed: false }] });
  await test('legacy status reports migration without performing it', async () => {
    const before = await inventory(temp);
    const result = await invoke({ action: 'status' });
    assert.equal(result.ok, true);
    assert.equal(result.data.reconciliation_required, true);
    assert.equal(result.data.goal_run, null);
    assert.equal(await readGoalRun(workspace), null);
    assert.deepEqual(await inventory(temp), before);
  });
  await test('reconcile requires a fresh stored revision', async () => {
    const before = await inventory(temp);
    for (const args of [{ action: 'reconcile' }, { action: 'reconcile', expected_revision: legacy.revision + 10 }]) {
      const result = await invoke(args);
      assert.equal(result.ok, false);
      assert.equal(result.isError, true);
      assert.match(result.summary, /GOAL_STALE_REVISION/);
      assert.equal(result.data.error_code, 'GOAL_STALE_REVISION');
      assert.equal(result.data.failure_layer, 'local_goal_handler');
      assert.equal(result.data.host_approval_status, 'not_observable_from_handler');
    }
    assert.deepEqual(await inventory(temp), before);
  });
  await test('explicit owned reconcile performs migration', async () => {
    const result = await invoke({ action: 'reconcile', expected_revision: legacy.revision });
    assert.equal(result.ok, true);
    assert.equal((await readGoalRun(workspace)).shadow, false);
    assert.equal(result.data.watchdog.running, false);
  });
  await test('repeated normal status leaves files and revision unchanged', async () => {
    const before = await inventory(temp);
    const a = await invoke({ action: 'status' });
    const b = await invoke({ action: 'status' });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.data.goal.revision, b.data.goal.revision);
    assert.equal(a.data.goal_run.revision, b.data.goal_run.revision);
    assert.equal(a.data.reconciliation_required, false);
    assert.equal(a.data.watchdog_unchanged, true);
    assert.deepEqual(await inventory(temp), before);
  });
  await test('invalid action is rejected by schema, never treated as cancel', async () => {
    const before = (await getGoal(workspace)).status;
    assert.equal(schema.safeParse({ action: 'not-an-action' }).success, false);
    assert.equal((await getGoal(workspace)).status, before);
    const snapshot = await inventory(temp);
    const direct = await registration.callback({ action: 'not-an-action' });
    assert.equal(direct.structuredContent.ok, false);
    assert.equal(direct.structuredContent.data.error_code, 'GOAL_ACTION_UNSUPPORTED');
    assert.deepEqual(await inventory(temp), snapshot);
  });
  await test('composite tool still declares write capability truthfully', async () => {
    assert.equal(registration.config.annotations.readOnlyHint, false);
    assert.equal(registration.config.annotations.destructiveHint, true);
  });
  await test('foreign-session status preserves other session and hides objective', async () => {
    const otherWorkspace = path.join(temp, 'other-workspace');
    await fs.mkdir(otherWorkspace);
    let other;
    registerGoalTool({ registerTool(name, config, callback) { other = { config, callback }; } }, otherWorkspace);
    const scope = (id) => createRuntimeScope({ workspaceRoot: otherWorkspace, projectRoots: [otherWorkspace] }, { sessionId: id });
    await runWithRuntimeScope(scope('fixture-owner'), () => createGoal(otherWorkspace, { objective: 'foreign private objective', success_criteria: [{ name: 'private criterion', passed: false }] }));
    const before = await inventory(temp);
    const result = await runWithRuntimeScope(scope('fixture-reader'), () => other.callback(z.object(other.config.inputSchema).parse({ action: 'status' })));
    const data = result.structuredContent.data;
    assert.equal(data.goal, null);
    assert.ok(data.takeover_candidate);
    assert.equal(JSON.stringify(data).includes('foreign private objective'), false);
    assert.equal(data.watchdog_unchanged, true);
    assert.deepEqual(await inventory(temp), before);
    const reconcile = await runWithRuntimeScope(scope('fixture-reader'), () => other.callback(z.object(other.config.inputSchema).parse({ action: 'reconcile', expected_revision: data.takeover_candidate.revision })));
    assert.equal(reconcile.structuredContent.ok, false);
    assert.equal(reconcile.structuredContent.data.error_code, 'GOAL_RECONCILE_UNAVAILABLE');
    assert.deepEqual(await inventory(temp), before);
  });
  console.log(JSON.stringify({ suite: 'goal-status-purity', passed, failed: 0, live_goal_modified: false }));
} finally {
  if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
  if (savedWatchdog === undefined) delete process.env.GOAL_WATCHDOG_ENABLED; else process.env.GOAL_WATCHDOG_ENABLED = savedWatchdog;
  await fs.rm(temp, { recursive: true, force: true });
}
