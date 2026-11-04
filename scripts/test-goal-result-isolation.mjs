import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EffectiveToolRegistry } from '../dist/lib/effective-tool-registry.js';
import { InvocationGateway } from '../dist/lib/invocation-gateway.js';
import { createWebHarnessResultPipeline } from '../dist/lib/result-pipeline.js';
import { createRuntimeScope, runWithRuntimeScope } from '../dist/lib/runtime-scope.js';
import { createGoal } from '../dist/lib/goals.js';
import { readGoalRun } from '../dist/lib/goal-run-store.js';
import { createDurableTask, getDurableTask } from '../dist/lib/durable-tasks.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'wh-late-result-'));
const saved = new Map(['CODEX_HOME', 'HARNESS_RELAY_ENABLED', 'GOAL_WATCHDOG_ENABLED'].map(key => [key, process.env[key]]));
process.env.CODEX_HOME = path.join(temp, 'runtime');
process.env.HARNESS_RELAY_ENABLED = 'false';
process.env.GOAL_WATCHDOG_ENABLED = 'false';
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
let count = 0;
try {
  for (const scenario of [
    { name: 'late success after Goal replacement', originalGoal: true, fail: false },
    { name: 'late failure after Goal replacement', originalGoal: true, fail: true },
    { name: 'pre-Goal result after a new Goal starts', originalGoal: false, fail: false },
  ]) {
    const workspace = path.join(temp, String(++count));
    await fs.mkdir(workspace);
    const session = 'fixture-session';
    const seed = { workspaceRoot: workspace, projectRoots: [workspace] };
    const inSession = operation => runWithRuntimeScope(createRuntimeScope(seed, { sessionId: session }), operation);
    if (scenario.originalGoal) {
      await inSession(() => createGoal(workspace, {
        objective: 'old Goal', success_criteria: [{ name: 'old proof', passed: false }],
      }));
      await inSession(() => createDurableTask(workspace, { goal: 'old task' }));
    }
    const started = latch(), release = latch();
    const registry = new EffectiveToolRegistry('full');
    const definition = registry.prepare('read_text_file', { inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
      started.resolve();
      await release.promise;
      if (scenario.fail) throw new Error('late fixture failure');
      return {
        content: [{ type: 'text', text: 'old invocation result' }],
        structuredContent: { ok: true, tool: 'read_text_file', summary: 'old invocation result', data: { path: path.join(workspace, 'old.txt') } },
      };
    });
    registry.register(definition);
    const pipeline = createWebHarnessResultPipeline(workspace);
    const gateway = new InvocationGateway(registry, seed, {
      onSuccess: (context, result) => pipeline.processSuccess(context, result),
      onFailure: (context, error) => pipeline.processFailure(context, error),
    });
    const call = gateway.invoke('read_text_file', [{ path: path.join(workspace, 'old.txt') }, {
      sessionId: session, requestId: 1, signal: new AbortController().signal,
    }]).then(value => ({ value }), error => ({ error }));
    let timer;
    try {
      await Promise.race([started.promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('owned fixture did not start')), 5000);
      })]);
      clearTimeout(timer);
      const replacement = await inSession(() => createGoal(workspace, {
        objective: 'new Goal', success_criteria: [{ name: 'new proof', passed: false }],
      }));
      const task = await inSession(() => createDurableTask(workspace, { goal: 'new task' }));
      const beforeRun = JSON.stringify(await readGoalRun(workspace, session));
      const beforeTask = JSON.stringify(await inSession(() => getDurableTask(workspace, task.id)));
      release.resolve();
      const finished = await call;
      if (scenario.fail) assert.match(String(finished.error), /late fixture failure/);
      else assert.notEqual(finished.value?.isError, true);
      assert.equal(JSON.stringify(await readGoalRun(workspace, session)), beforeRun, 'late result changed the replacement GoalRun');
      assert.equal(JSON.stringify(await inSession(() => getDurableTask(workspace, task.id))), beforeTask, 'late result changed the replacement task');
      assert.equal((await readGoalRun(workspace, session)).run.runId, replacement.id);
      console.log('PASS ' + scenario.name);
    } finally {
      clearTimeout(timer);
      release.resolve();
      await call;
    }
  }
  console.log('Goal result isolation: ' + count + '/' + count + ' passed');
} finally {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await fs.rm(temp, { recursive: true, force: true });
}
