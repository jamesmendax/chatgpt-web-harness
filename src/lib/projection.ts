import type { DurableGoal } from "./goal-state-store.js";
import type { DurableTask } from "./durable-tasks.js";
import type { HarnessEvent } from "./harness-events.js";

/**
 * Projection contract (ported from DeepSeek Harness session-projection):
 * a projection derives state from the append-only event stream by replay.
 * Rules:
 *  - `apply` must be synchronous and pure.
 *  - `apply` MUST return the SAME state reference for events it does not
 *    consume (callers use Object.is as free change detection).
 *  - State-carrying events are whole-value: they carry the complete
 *    post-change state, never a bare delta.
 *  - Bumping `stateVersion` discards any persisted projection state derived
 *    from an older version — never migrate, replay from the log instead.
 *
 * Scope note: goal/change and task/change events carry whole snapshots, so
 * explicit state operations replay exactly. Observation-driven task fields
 * (changed_files, observed_checks, recent_events from tool/observation events)
 * are NOT folded yet — folding them is a prerequisite for switching the read
 * path to projections, not for this parity contract.
 */

export interface ProjectionDefinition<S> {
  key: string;
  stateVersion: number;
  init(): S;
  apply(state: S, event: HarnessEvent): S;
}

export function replayProjection<S>(definition: ProjectionDefinition<S>, events: HarnessEvent[]): S {
  let state = definition.init();
  for (const event of events) {
    state = definition.apply(state, event);
  }
  return state;
}

export const goalProjection: ProjectionDefinition<DurableGoal | null> = {
  key: "goal",
  stateVersion: 1,
  init: () => null,
  apply(state, event) {
    if (event.type !== "goal/change") return state;
    const goal = event.data.goal;
    return goal && typeof goal === "object" ? (goal as DurableGoal) : null;
  },
};

export const taskProjection: ProjectionDefinition<DurableTask | null> = {
  key: "task",
  stateVersion: 1,
  init: () => null,
  apply(state, event) {
    if (event.type !== "task/change") return state;
    const task = event.data.task;
    return task && typeof task === "object" ? (task as DurableTask) : state;
  },
};
