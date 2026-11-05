/**
 * Public Goal API and cross-store lifecycle coordination.
 *
 * Low-level consumers import goal-state-store directly. This facade preserves
 * existing caller imports while coordinating GoalRun, Task and Relay mutation.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "fs/promises";
import path from "path";
import { notifyStateInvalidated } from "./state-invalidate.js";
import {
  archiveGoalRun, createGoalRun as createStoredGoalRun, goalRunIsTerminal,
  importLegacyGoal, readGoalRun, rebindGoalRunSession, replaceGoalRunIdentity, withGoalRunCreationSnapshot,
} from "./goal-run-store.js";
import {
  assertGoalCreationIdle, getGoal, getGoalBindSource, goalCreationJournalPath, goalStateStore,
  unknownGoalIntentProvenance, withGoalTaskDefinitionFence,
} from "./goal-state-store.js";
import type {
  DurableGoal, GoalCriterion, GoalMutationOptions, GoalCreationJournal, GoalCreationPhase,
} from "./goal-state-store.js";
import {
  cancelDurableTaskForGoalReplacement, withActiveDurableTaskSnapshot, withDurableTaskGoalTransition,
} from "./durable-tasks.js";
import { fenceRetiredRelayIfPresent } from "./retired-relay-compat.js";
import { currentRelayGoal, withRelayGoalTransition } from "./relay-scope.js";
import { activeDriverMutationCount, readDriverLease } from "./driver-lease.js";
import { enterGoalReplacement } from "./goal-effect-scope.js";

export {
  type GoalStatus,
  type GoalCriterion,
  type DurableGoal,
  GOAL_GROUNDING_NOTE,
  GOAL_WATCHDOG_POLICY,
  GOAL_VISIBLE_PROGRESS_HEARTBEAT,
  GOAL_CONTINUATION_CONTRACT,
  GOAL_CONTINUATION_SNAPSHOT,
  type GoalMutationOptions,
  type GoalSummary,
  goalVisibleToSession,
  assertGoalAccessibleBySession,
  type GoalTakeoverCandidate,
  getGoalTakeoverCandidate,
  goalTakeoverToken,
  getGoalOwnerSession,
  getGoalBindSource,
  resolveGoalForSession,
  getGoal,
  getWorkspaceGoalProjection,
  writeGoalRunProjection,
  goalCreationJournalPath,
  getGoalCreationStatus,
  assertGoalCreationIdle,
  updateGoal,
  pauseGoal,
  resumeGoal,
  cancelGoal,
  completeGoal,
  goalSummary,
  formatActiveGoalForInstructions,
  assertGoalAllowsTaskCompletion,
} from "./goal-state-store.js";

/** Compatibility facade: confirmation requires actual recorded evidence. */
export async function confirmGoalCriterion(
  workspaceRoot: string,
  input: { criterion: string; detail?: string; expectedRevision?: number; evidenceIds?: readonly string[] }
): Promise<DurableGoal> {
  const { confirmGoalRunCriterion } = await import("./goal-run-web.js");
  return (await confirmGoalRunCriterion(workspaceRoot, input)).goal;
}

const {
  assertExpectedRevision, atomicWriteJson, cleanString, currentSessionId,
  goalPath, goalShardDir, normalizeConstraints, normalizeCriteria,
  readCreationJournal, readGoalFile, recordGoalChange, sessionSegment,
  withGoalCreationContext, withGoalLock, writeGoalState,
} = goalStateStore;

async function runGoalCreation(workspaceRoot: string, journal: GoalCreationJournal): Promise<DurableGoal> {
  const session = currentSessionId();
  if (journal.owner_session !== session) throw new Error("GOAL_CREATION_OWNER_MISMATCH: transaction owner changed.");
  const save = async (phase: GoalCreationPhase) => {
    journal = { ...journal, phase };
    await atomicWriteJson(goalCreationJournalPath(workspaceRoot, session), journal);
  };
  if (journal.phase === "prepared") {
    if (journal.previous_run) await archiveGoalRun(workspaceRoot, journal.previous_run, session);
    if (journal.previous_goal) {
      const previous = journal.previous_goal;
      const historical = (previous.status === "active" || previous.status === "paused")
        ? { ...previous, status: "cancelled" as const, revision: previous.revision + 1,
            current_phase: "Superseded by a new goal", updated_at: journal.new_goal.created_at }
        : previous;
      await atomicWriteJson(path.join(goalShardDir(workspaceRoot, sessionSegment(session)), "goal-history",
        previous.id + "-revision-" + previous.revision + ".json"), {
        goal: historical, original_goal: previous, successor_goal_id: journal.new_goal.id, transaction_id: journal.transaction_id,
      });
    }
    await save("archived");
  }
  if (journal.phase === "archived") {
    if (journal.previous_goal) {
      await assertCreationDriverIdle(workspaceRoot, journal.previous_goal.id);
      await fenceRetiredRelayIfPresent(workspaceRoot, journal.previous_goal.id);
    }
    await save("relay_fenced");
  }
  if (journal.phase === "relay_fenced") {
    if (journal.previous_goal) await assertCreationDriverIdle(workspaceRoot, journal.previous_goal.id);
    if (journal.previous_task_id) {
      await cancelDurableTaskForGoalReplacement(workspaceRoot, journal.previous_task_id,
        "Cancelled together with superseded Goal " + journal.previous_goal?.id);
    }
    await save("task_cancelled");
  }
  if (journal.phase === "task_cancelled") {
    const current = await getGoal(workspaceRoot);
    if (current && current.owner_session === session && current.id !== journal.new_goal.id &&
        (current.id !== journal.previous_goal?.id || current.revision !== journal.previous_goal.revision)) {
      throw new Error("GOAL_CREATION_CONFLICT: current Goal changed after the replacement was prepared.");
    }
    if (journal.previous_goal && !current && journal.previous_goal.owner_session === session) {
      throw new Error("GOAL_CREATION_CONFLICT: previous Goal disappeared before replacement.");
    }
    await writeGoalState(workspaceRoot, journal.new_goal);
    await save("goal_published");
  }
  if (journal.phase === "goal_published") {
    const existing = await readGoalRun(workspaceRoot, session);
    if (existing?.run.runId !== journal.new_goal.id) {
      const imported = importLegacyGoal(journal.new_goal);
      if (!existing) await createStoredGoalRun(workspaceRoot, imported, {}, session);
      else {
        if (journal.previous_run && (existing.run.runId !== journal.previous_run.runId ||
            existing.run.revision !== journal.previous_run.runRevision ||
            (existing.envelopeRevision ?? 1) !== journal.previous_run.envelopeRevision)) {
          throw new Error("GOAL_CREATION_CONFLICT: previous GoalRun changed during replacement.");
        }
        await replaceGoalRunIdentity(workspaceRoot, imported, {
          expectedRunId: existing.run.runId, expectedRunRevision: existing.run.revision,
          expectedEnvelopeRevision: existing.envelopeRevision ?? 1, allowActiveSupersede: true,
        });
      }
    }
    await save("run_published");
  }
  const goal = await getGoal(workspaceRoot);
  const run = await readGoalRun(workspaceRoot, session);
  if (!goal || goal.id !== journal.new_goal.id || run?.run.runId !== goal.id) {
    throw new Error("GOAL_CREATION_INCOMPLETE: new Goal and GoalRun do not agree; retain the creation transaction.");
  }
  if (journal.phase !== "committed") {
    if (journal.previous_goal && ["active", "paused"].includes(journal.previous_goal.status)) {
      await recordGoalChange(workspaceRoot, "status:cancelled", {
        ...journal.previous_goal, status: "cancelled", revision: journal.previous_goal.revision + 1,
        current_phase: "Superseded by a new goal", updated_at: journal.new_goal.created_at,
      });
    }
    await recordGoalChange(workspaceRoot, "create", goal);
    await save("committed");
    notifyStateInvalidated(workspaceRoot);
  }
  return goal;
}

async function withCreationRelayGoal<T>(workspaceRoot: string, goalId: string, operation: () => Promise<T>): Promise<T> {
  return withRelayGoalTransition(workspaceRoot, currentRelayGoal(workspaceRoot), goalId, operation);
}

async function assertCreationDriverIdle(_workspaceRoot: string, _goalId: string): Promise<void> {
  // Prior Driver admission state does not block a new Goal.
}

/** Explicit, authorized recovery; status/getGoal never calls this. */
export async function recoverGoalCreation(workspaceRoot: string): Promise<DurableGoal | null> {
  return withGoalTaskDefinitionFence(workspaceRoot, () => withDurableTaskGoalTransition(workspaceRoot, () => withGoalLock(workspaceRoot, () => withGoalCreationContext(workspaceRoot, async () => {
    const journal = await readCreationJournal(workspaceRoot);
    if (!journal) return null;
    const previous = journal.previous_goal;
    const release = previous ? await enterGoalReplacement(workspaceRoot, previous.id, previous.owner_session,
      { transaction: journal.transaction_id, revision: previous.revision }) : async () => {};
    // Keep a failed transaction reserved for explicit recovery; a dead PID is
    // never enough to prove that its journal/publication steps finished.
    const result = journal.phase === "committed" ? null : await runGoalCreation(workspaceRoot, journal);
    await release();
    return result;
  }))));
}

export async function createGoal(
  workspaceRoot: string,
  input: { objective: string; success_criteria: GoalCriterion[]; constraints?: string[]; current_phase?: string; supersede?: boolean }
): Promise<DurableGoal> {
  // Validate all definition fields before journaling or cancelling anything.
  const objective = cleanString(input.objective, 4000);
  if (!objective) throw new Error("Goal objective is required.");
  const criteria = normalizeCriteria(input.success_criteria);
  if (!criteria.length) throw new Error("Goal requires at least one success criterion.");
  for (const criterion of criteria) if (criterion.requires_confirmation) criterion.passed = false;
  const definition = {
    objective, success_criteria: criteria, constraints: normalizeConstraints(input.constraints),
    current_phase: cleanString(input.current_phase, 2000) || "Work toward the goal",
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(definition)).digest("hex");
  // Lock order: durable Goal-definition fence -> Task workspace lock -> Goal
  // process lock -> GoalRun journal/projection. Task completion uses the same
  // outer fence, so a different Node process cannot finish stale work between
  // the replacement journal and its old-Task cancellation/Goal publication.
  return withGoalTaskDefinitionFence(workspaceRoot, () => withDurableTaskGoalTransition(workspaceRoot, () => withGoalLock(workspaceRoot, () => withGoalCreationContext(workspaceRoot, async () => {
    const owner = currentSessionId();
    const pending = await readCreationJournal(workspaceRoot);
    if (pending && pending.phase !== "committed") {
      if (pending.input_fingerprint !== fingerprint) {
        throw new Error("GOAL_CREATION_PENDING: a different creation transaction must be explicitly reconciled before starting this Goal.");
      }
      const old = pending.previous_goal;
      const release = old ? await enterGoalReplacement(workspaceRoot, old.id, old.owner_session,
        { transaction: pending.transaction_id, revision: old.revision }) : async () => {};
      const recovered = await runGoalCreation(workspaceRoot, pending);
      await release();
      return recovered;
    }
    const visible = await getGoal(workspaceRoot);
    // An unbound legacy projection is discovery, not this Chat's ownership.
    const previous = visible && visible.owner_session === owner ? visible : null;
    const transactionId = randomUUID();
    const releaseReplacement = previous ? await enterGoalReplacement(workspaceRoot, previous.id, previous.owner_session,
      { transaction: transactionId, revision: previous.revision, preJournalUnchanged: true }) : async () => {};
    let journalPublished = false;
    try {
    if (!owner && previous && ["active", "paused"].includes(previous.status) && !input.supersede) {
      throw new Error("An active goal already exists. For a DIFFERENT task in a session-less client use supersede=true.");
    }
    // Legacy Driver admission does not gate Goal replacement.
    const now = new Date().toISOString();
    const next: DurableGoal = {
      version: 1, id: randomUUID(), revision: 1, ...definition, status: "active",
      intent_provenance: unknownGoalIntentProvenance(),
      ...(owner ? { owner_session: owner } : {}), created_at: now, updated_at: now,
    };
    let journal!: GoalCreationJournal;
    // An evidence writer either commits before this snapshot or observes the
    // pending journal under the same store lock. Capture the latest durable run.
    await withGoalRunCreationSnapshot(workspaceRoot, async (previousRun) => {
      if (previous && previousRun && previousRun.run.runId !== previous.id && !goalRunIsTerminal(previousRun)) {
        throw new Error("GOAL_CREATION_CONFLICT: current Goal and active GoalRun identities differ.");
      }
      const publishJournal = async (taskId: string | null) => {
        journal = {
          version: 1, transaction_id: transactionId, ...(owner ? { owner_session: owner } : {}),
          input_fingerprint: fingerprint, phase: "prepared", previous_goal: previous,
          previous_run: previousRun ? { runId: previousRun.run.runId, runRevision: previousRun.run.revision,
            envelopeRevision: previousRun.envelopeRevision ?? 1 } : null,
          previous_task_id: previous ? taskId : null, new_goal: next,
        };
        await atomicWriteJson(goalCreationJournalPath(workspaceRoot), journal);
        journalPublished = true;
      };
      // A source session may still have the old task pointer after a partially
      // committed bind. With no owned Goal, it is not this new Goal's task.
      if (previous) await withActiveDurableTaskSnapshot(workspaceRoot, publishJournal);
      else await publishJournal(null);
    }, owner);
    const created = await runGoalCreation(workspaceRoot, journal);
    await releaseReplacement();
    return created;
    } catch (error) {
      // If journal publication threw, its rename might already have succeeded.
      // Only release after verifying that this transaction is absent.
      if (!journalPublished) {
        const observed = await readCreationJournal(workspaceRoot);
        if (!observed || observed.transaction_id !== transactionId) await releaseReplacement();
      }
      throw error;
    }
  }))));
}

/**
 * Cross-session adoption: a NEW ChatGPT conversation (new MCP session) binds
 * the existing goal to itself, moving the continuation signals and gates into
 * that window. Requires this window's session id; bumps revision. This low-level
 * store helper coordinates Goal and GoalRun state; the public `goal(action=bind)` tool
 * preflights and migrates the paired session-scoped durable task around it.
 */
async function finishBindSourceCleanup(workspaceRoot: string, goal: DurableGoal): Promise<void> {
  const previous = goal.previous_owner_session;
  if (!previous || previous === goal.owner_session) return;
  const sourcePath = goalPath(workspaceRoot, sessionSegment(previous));
  const source = await readGoalFile(sourcePath);
  if (!source || source.id !== goal.id || source.revision >= goal.revision) return;
  // Preserve a fencing tombstone even if removal fails. A newer/different
  // source Goal is never deleted by a retry of an older bind.
  await atomicWriteJson(sourcePath, goal);
  await fs.rm(sourcePath, { force: true }).catch(() => {});
}

export async function bindGoalToSession(workspaceRoot: string, opts?: GoalMutationOptions): Promise<DurableGoal> {
  return withGoalLock(workspaceRoot, async () => {
    const session = currentSessionId();
    if (!session) throw new Error("goal(action=bind) requires a ChatGPT session context (none available).");
    await assertGoalCreationIdle(workspaceRoot, session);
    const shard = sessionSegment(session);
    const destination = await readGoalFile(goalPath(workspaceRoot, shard));
    if (destination && destination.owner_session === session &&
        (["active", "paused"].includes(destination.status) || opts?.expectedGoalId === destination.id)) {
      if (opts?.expectedGoalId && opts.expectedGoalId !== destination.id) {
        throw new Error("GOAL_BIND_DESTINATION_CONFLICT: This window already owns another active goal.");
      }
      const release = await enterGoalReplacement(workspaceRoot, destination.id, destination.owner_session);
      await finishBindSourceCleanup(workspaceRoot, destination);
      await release();
      return destination;
    }
    const goal = opts?.sourceSessionId
      ? await getGoal(workspaceRoot, opts.sourceSessionId)
      : await getGoalBindSource(workspaceRoot);
    if (goal?.owner_session === session && (!opts?.expectedGoalId || goal.id === opts.expectedGoalId)) {
      const release = await enterGoalReplacement(workspaceRoot, goal.id, goal.owner_session);
      await finishBindSourceCleanup(workspaceRoot, goal);
      await release();
      return goal;
    }
    if (!goal || !["active", "paused"].includes(goal.status)) throw new Error("No active or paused goal to bind in this workspace.");
    if (opts?.expectedGoalId && goal.id !== opts.expectedGoalId) throw new Error("GOAL_BIND_SOURCE_CHANGED: discovered Goal identity changed.");
    assertExpectedRevision(goal, opts);
    const releaseSource = await enterGoalReplacement(workspaceRoot, goal.id, goal.owner_session);
    let releaseDestination: (() => Promise<void>) | undefined;
    let bindingStarted = false;
    try {
    if (destination && destination.id !== goal.id) {
      releaseDestination = await enterGoalReplacement(workspaceRoot, destination.id, destination.owner_session);
    }
    const targetRun = await readGoalRun(workspaceRoot, session);
    if (targetRun && targetRun.run.runId !== goal.id && !goalRunIsTerminal(targetRun)) {
      throw new Error("GOAL_BIND_DESTINATION_CONFLICT: destination has another nonterminal GoalRun.");
    }
    if (destination && destination.id !== goal.id && ["active", "paused"].includes(destination.status)) {
      throw new Error("GOAL_BIND_DESTINATION_CONFLICT: destination contains another nonterminal Goal.");
    }
    if (goal.owner_session) {
      const sourceRun = await readGoalRun(workspaceRoot, goal.owner_session);
      if (sourceRun && sourceRun.run.runId !== goal.id) throw new Error("GOAL_BIND_SOURCE_RUN_MISMATCH: source GoalRun identity changed.");
      if (sourceRun) { bindingStarted = true; await rebindGoalRunSession(workspaceRoot, goal.owner_session, session); }
    }
    if (destination && destination.id !== goal.id) {
      bindingStarted = true;
      await atomicWriteJson(path.join(goalShardDir(workspaceRoot, shard), "goal-history",
        destination.id + "-revision-" + destination.revision + ".json"), { goal: destination, replaced_by_bind: goal.id });
    }
    const next: DurableGoal = {
      ...goal, owner_session: session, revision: goal.revision + 1, updated_at: new Date().toISOString(),
      ...(goal.owner_session ? { previous_owner_session: goal.owner_session } : {}),
    };
    bindingStarted = true;
    await writeGoalState(workspaceRoot, next);
    await finishBindSourceCleanup(workspaceRoot, next);
    notifyStateInvalidated(workspaceRoot);
    await recordGoalChange(workspaceRoot, "bind", next);
    if (releaseDestination) await releaseDestination();
    await releaseSource();
    return next;
    } catch (error) {
      if (!bindingStarted) {
        if (releaseDestination) await releaseDestination();
        await releaseSource();
      }
      throw error;
    }
  });
}

