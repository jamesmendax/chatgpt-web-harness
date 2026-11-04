import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "projection-replay");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "slim";

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(tmpRoot, { recursive: true });

const { createGoal, updateGoal, pauseGoal, resumeGoal, cancelGoal, completeGoal, getGoal } =
  await import("../dist/lib/goals.js");
const { createDurableTask, checkpointDurableTask, updateDurableTask, completeDurableTask, getDurableTask } =
  await import("../dist/lib/durable-tasks.js");
const { readHarnessEvents } = await import("../dist/lib/harness-events.js");
const { goalProjection, taskProjection, replayProjection } = await import("../dist/lib/projection.js");

// Deterministic LCG so failures reproduce.
let seed = 20260830;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

try {
  let goalParityChecks = 0;
  let taskParityChecks = 0;

  for (let round = 0; round < 30; round++) {
    const ws = path.join(tmpRoot, `ws-${round}`);
    await fs.mkdir(ws, { recursive: true });

    if (rand() < 0.9) {
      await createGoal(ws, {
        objective: `Round ${round} objective with root ${ws}`,
        success_criteria: [{ name: "c1", passed: false }, { name: "c2", passed: rand() < 0.5 }],
        current_phase: `phase-0-${Math.floor(rand() * 1000)}`,
      });
      const goalSteps = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < goalSteps; i++) {
        const roll = rand();
        if (roll < 0.4) await updateGoal(ws, { current_phase: `phase-${i + 1}-${Math.floor(rand() * 1000)}` });
        else if (roll < 0.6) {
          try { await pauseGoal(ws, `pause-${i}`); } catch {}
        } else if (roll < 0.8) {
          try { await resumeGoal(ws, `resume-${i}`); } catch {}
        }
      }
      if (rand() < 0.5) {
        await updateGoal(ws, { success_criteria: [{ name: "c1", passed: true }, { name: "c2", passed: true }] });
        try {
          if (rand() < 0.7) await completeGoal(ws);
          else await cancelGoal(ws);
        } catch {}
      }
    }

    let lastTaskId = null;
    if (rand() < 0.8) {
      const task = await createDurableTask(ws, {
        goal: `task for round ${round}`,
        current_step: `start-${Math.floor(rand() * 1000)}`,
        blocking_checks: [{ name: "b1", passed: false }],
      });
      lastTaskId = task.id;
      const taskSteps = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < taskSteps; i++) {
        const wantsBlocked = rand() < 0.3;
        const wantsResolved = rand() < 0.4;
        await checkpointDurableTask(ws, task.id, {
          current_step: `step-${i}-${Math.floor(rand() * 1000)}`,
          done: [`done-${i}`],
          ...(rand() < 0.5 ? { decisions: [`decision-${i}`] } : {}),
          ...(rand() < 0.4 ? { blocking_checks: [{ name: "b1", passed: true }] } : {}),
          ...(wantsBlocked ? { blocked_reason: { code: "test-blocked", message: `blocked-${i}` } } : {}),
          ...(wantsResolved ? { resolved_blockers: ["test-blocked"] } : {}),
        });
      }
      if (rand() < 0.4) await updateDurableTask(ws, task.id, { current_step: "final explicit update" });
      if (rand() < 0.4) {
        await updateDurableTask(ws, task.id, { blocking_checks: [{ name: "b1", passed: true }] });
        try { await completeDurableTask(ws, task.id); } catch {}
      }
    }

    // Parity: replay events through projections and compare with the snapshots.
    const events = await readHarnessEvents(ws, { limit: 1000 });
    for (let index = 1; index < events.length; index++) {
      assert.equal(events[index].seq, events[index - 1].seq + 1, `round ${round}: event seq must stay contiguous`);
    }

    const projectedGoal = replayProjection(goalProjection, events);
    const goalSnapshot = await getGoal(ws);
    assert.deepEqual(projectedGoal, goalSnapshot, `round ${round}: goal projection must equal the goal snapshot`);
    goalParityChecks += 1;

    if (lastTaskId) {
      const projectedTask = replayProjection(taskProjection, events);
      assert.ok(projectedTask, `round ${round}: task projection must have state`);
      const taskSnapshot = await getDurableTask(ws, lastTaskId);
      assert.deepEqual(projectedTask, taskSnapshot, `round ${round}: task projection must equal the task snapshot`);
      taskParityChecks += 1;
    }
  }

  // Contract checks: apply returns the same reference for unconsumed events.
  const untouched = { type: "tool/observation", seq: 999, time: new Date().toISOString(), data: { tool: "x", ok: true } };
  const goalState = { version: 1, id: "g", revision: 1, objective: "o", success_criteria: [], constraints: [], status: "active", current_phase: "p", created_at: "t", updated_at: "t" };
  assert.ok(replayProjection(goalProjection, [untouched]) !== undefined);
  const applySameRef = goalProjection.apply(goalState, untouched);
  assert.ok(applySameRef === goalState, "goal projection must return the same reference for unconsumed events");
  const taskApplySameRef = taskProjection.apply(null, untouched);
  assert.ok(taskApplySameRef === null, "task projection must return the same reference for unconsumed events");

  console.log(`projection-replay: ${goalParityChecks} goal + ${taskParityChecks} task random-op parity checks, reference contract OK`);
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
