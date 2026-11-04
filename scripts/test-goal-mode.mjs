import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "goal-mode");
const workspace = path.join(tmpRoot, "workspace");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.CHATGPT_TOOL_PROFILE = "slim";
// This suite exercises the generic Goal/session bind contract. Keep it
// independent from a developer machine or parent test runner that happens to
// have Relay enabled; Relay-specific Driver takeover behavior has dedicated
// coverage in test-relay-foundation/manager/orphan-recovery.
process.env.HARNESS_RELAY_ENABLED = "false";
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated Goal binding and evidence fixtures",
  scope: ["goal-mode temporary workspaces"],
  out_of_scope: [], deliverables: ["Goal migration and evidence assertions"],
  success_criteria: ["pre/post-bind evidence is recorded on the correct Goal task"],
  constraints: [], protected_resources: [], known_facts: ["all commands are isolated test fixtures"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });

const {
  bindGoalToSession,
  completeGoal,
  confirmGoalCriterion,
  createGoal,
  formatActiveGoalForInstructions,
  getGoal,
  GOAL_CONTINUATION_CONTRACT,
  GOAL_VISIBLE_PROGRESS_HEARTBEAT,
  GOAL_WATCHDOG_POLICY,
  pauseGoal,
  resumeGoal,
  updateGoal,
} = await import("../dist/lib/goals.js");
const {
  commitActiveDurableTaskSessionRebind,
  createDurableTask,
  completeDurableTask,
  getActiveTaskId,
  getDurableTask,
  runWithActiveDurableTaskSessionRebind,
} = await import("../dist/lib/durable-tasks.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const { buildInstructionContext } = await import("../dist/lib/instruction-context.js");
const { buildHarnessRuntimeContext, formatHarnessRuntimeContext } = await import("../dist/lib/context-broker.js");

function readTaskAsSession(workspaceRoot, sessionId, taskId) {
  return runWithRuntimeScope(
    createRuntimeScope({ workspaceRoot, projectRoots: [workspaceRoot] }, { sessionId }),
    () => getDurableTask(workspaceRoot, taskId),
  );
}

try {
  const created = await createGoal(workspace, {
    objective: "Ship a reliable Goal Mode V1",
    success_criteria: [
      { name: "implementation complete", passed: false },
      { name: "tests pass", passed: false },
    ],
    constraints: ["Keep task_state as the execution log"],
    current_phase: "Implement core state",
  });
  if (created.status !== "active" || created.success_criteria.length !== 2) throw new Error("goal create failed");

  const persisted = await getGoal(workspace);
  if (persisted?.id !== created.id) throw new Error("goal did not persist");

  const instructions = await formatActiveGoalForInstructions(workspace);
  if (!instructions.includes("## ACTIVE GOAL") || !instructions.includes(created.objective)) throw new Error("active goal instructions missing");
  if (!instructions.includes(GOAL_CONTINUATION_CONTRACT) || !instructions.includes("checkpoint, not a stop condition")) {
    throw new Error("active goal instructions missing continuous-execution contract");
  }
  if (!instructions.includes(GOAL_VISIBLE_PROGRESS_HEARTBEAT) || !instructions.includes("user-visible assistant text")) {
    throw new Error("active goal instructions missing visible-progress heartbeat contract");
  }
  if (!instructions.includes(GOAL_WATCHDOG_POLICY) || !instructions.includes("do not manually run watchdog scripts")) {
    throw new Error("active goal instructions missing managed watchdog policy");
  }

  const context = await buildInstructionContext({ workspaceRoot: workspace, workspaceRoots: [workspace], pid: process.pid, adminPort: 0 });
  // Session scoping: the goal reaches windows through the HOT channel (broker
  // snapshots/tails), never through boot instructions (which every window
  // sharing this server would inherit).
  if (context.instructionsText.includes("## ACTIVE GOAL") || context.instructionsText.includes(created.objective)) {
    throw new Error("boot instructions must not leak the goal across sessions");
  }

  const summary = (await import("../dist/lib/goals.js")).goalSummary(created);
  if (summary.execution_mode !== "continuous" || summary.continuation_contract !== GOAL_CONTINUATION_CONTRACT) {
    throw new Error("goal summary missing structured continuous-execution contract");
  }
  if (summary.execution_policy?.visible_heartbeat?.soft_after_ms !== 270000 ||
      summary.execution_policy?.visible_heartbeat?.hard_before_ms !== 300000 ||
      summary.execution_policy?.visible_heartbeat?.tool_activity_counts_as_heartbeat !== false ||
      summary.execution_policy?.visible_heartbeat?.ends_execution !== false) {
    throw new Error("goal summary missing structured visible-progress heartbeat policy");
  }
  if (summary.watchdog_policy?.mode !== "goal_scoped" || summary.watchdog_policy?.lifecycle !== "managed_by_goal" || summary.watchdog_policy?.auto_resume_web !== false) {
    throw new Error("goal summary missing structured watchdog lifecycle policy");
  }

  const brokerContext = await buildHarnessRuntimeContext(workspace, workspace);
  const brokerText = formatHarnessRuntimeContext(brokerContext);
  if (!brokerText.includes("GOAL CONTINUATION CONTRACT") || !brokerText.includes("checkpoint, not a stop condition")) {
    throw new Error("Context Broker V2 missing continuous-execution contract");
  }

  await pauseGoal(workspace, "Waiting for user");
  await resumeGoal(workspace, "Continue implementation");

  const task = await createDurableTask(workspace, {
    goal: "Goal-mode completion gate fixture",
    blocking_checks: [{ name: "task check", passed: true }],
  });

  // A bounded Task may finish while its parent Goal is still active. Preserve
  // the stronger invariant: Task completion cannot change any Goal criterion,
  // revision or terminal state, and Goal completion remains separately gated.
  const beforeSubtask = await getGoal(workspace);
  const completedSubtask = await completeDurableTask(workspace, task.id);
  if (completedSubtask.status !== "completed") throw new Error("passed subtask cannot finish under active Goal");
  const afterSubtask = await getGoal(workspace);
  if (afterSubtask.status !== "active" ||
      afterSubtask.revision !== beforeSubtask.revision ||
      afterSubtask.success_criteria.some((criterion) => criterion.passed)) {
    throw new Error("subtask completion mutated or auto-confirmed the parent Goal");
  }
  let unmetBlocked = false;
  try {
    await completeGoal(workspace);
  } catch (error) {
    unmetBlocked = String(error).includes("Cannot complete goal");
  }
  if (!unmetBlocked) throw new Error("Goal completion ignored unmet Goal criteria");

  await updateGoal(workspace, {
    success_criteria: [
      { name: "implementation complete", passed: true },
      { name: "tests pass", passed: true },
    ],
    current_phase: "Ready to finish",
  });

  const readyGoal = await getGoal(workspace);
  const finalSubtask = await createDurableTask(workspace, {
    goal: "Goal-mode final-subtask delivery fixture",
    blocking_checks: [{ name: "second task check", passed: true }],
  });
  if ((await completeDurableTask(workspace, finalSubtask.id)).status !== "completed") {
    throw new Error("second subtask did not complete after its own checks passed");
  }
  const stillActive = await getGoal(workspace);
  if (stillActive.status !== "active" || stillActive.revision !== readyGoal.revision) {
    throw new Error("all-passed Goal was implicitly completed by its final subtask");
  }

  const completedGoal = await completeGoal(workspace);
  if (completedGoal.status !== "completed" || !completedGoal.completed_at) throw new Error("goal did not complete");

  let duplicateTaskRejected = false;
  try {
    await completeDurableTask(workspace, task.id);
  } catch (error) {
    duplicateTaskRejected = String(error).includes("already completed");
  }
  if (!duplicateTaskRejected) throw new Error("completed Task was accepted a second time");

  // --- Stage 4: revision CAS, requires_confirmation, user_confirmed evidence ---
  const wsCAS = path.join(tmpRoot, "ws-cas");
  await fs.mkdir(wsCAS, { recursive: true });
  const casGoal = await createGoal(wsCAS, {
    objective: "CAS and confirmation probe",
    success_criteria: [
      { name: "free criterion", passed: false },
      { name: "human sign-off", passed: false, requires_confirmation: true },
    ],
  });
  if (casGoal.revision !== 1) throw new Error("new goal must start at revision 1");

  let staleRejected = false;
  try {
    await updateGoal(wsCAS, { current_phase: "bump" }, { expectedRevision: casGoal.revision + 5 });
  } catch (error) {
    staleRejected = String(error).includes("GOAL_STALE_REVISION");
  }
  if (!staleRejected) throw new Error("stale goal revision must be rejected");

  const bumped = await updateGoal(wsCAS, { current_phase: "bump" }, { expectedRevision: casGoal.revision });
  if (bumped.revision !== casGoal.revision + 1) throw new Error("goal revision must increment on mutation");

  let confirmBypassRejected = false;
  try {
    await updateGoal(wsCAS, { success_criteria: [{ name: "human sign-off", passed: true }] });
  } catch (error) {
    confirmBypassRejected = String(error).includes("requires explicit user confirmation");
  }
  if (!confirmBypassRejected) throw new Error("requires_confirmation criterion must reject self-asserted pass");

  let untrustedRelayedTextRejected = false;
  try {
    await confirmGoalCriterion(wsCAS, { criterion: "human sign-off", detail: "user said ok in chat" });
  } catch (error) {
    untrustedRelayedTextRejected = String(error).includes("HOST_USER_TURN_REQUIRED");
  }
  if (!untrustedRelayedTextRejected) throw new Error("model-relayed user text was accepted as Host authorization");
  // A genuine Host turn is not available in this local test. Use an ephemeral
  // test-only signature to preserve a positive legacy contract fixture.
  const { generateKeyPairSync, randomUUID, sign } = await import("node:crypto");
  const { runWithVerifiedHostUserTurn } = await import("../dist/lib/host-user-confirmation.js");
  const testKeys = generateKeyPairSync("ed25519");
  const hostTestSession = "goal-mode-test-only-host-owner";
  const t = Date.now();
  const signedFixture = Buffer.from(JSON.stringify({
    version: 1, audience: "web-harness-goal-user-confirmation-v1",
    issuer: "operator-trusted-host-v1",
    goal_id: bumped.id, goal_revision: bumped.revision,
    session_id: hostTestSession, criterion: "human sign-off",
    source_turn_ref: "goal-mode-only-fake-host-turn-0001",
    nonce: randomUUID().replace(/-/g, ""),
    issued_at_ms: t - 1000, expires_at_ms: t + 60000,
  }));
  const fixtureReceipt = {
    body_base64url: signedFixture.toString("base64url"),
    signature_base64url: sign(null, signedFixture, testKeys.privateKey).toString("base64url"),
  };
  const savedTrustAnchor = process.env.HARNESS_HOST_USER_TURN_PUBLIC_KEY_SPKI;
  let confirmed;
  try {
    process.env.HARNESS_HOST_USER_TURN_PUBLIC_KEY_SPKI =
      testKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    confirmed = await runWithRuntimeScope(
      createRuntimeScope({ workspaceRoot: wsCAS, projectRoots: [wsCAS] }, { sessionId: hostTestSession }),
      () => runWithVerifiedHostUserTurn(fixtureReceipt, () =>
        confirmGoalCriterion(wsCAS, { criterion: "human sign-off", detail: "isolated signature fixture only" })),
    );
  } finally {
    if (savedTrustAnchor === undefined) delete process.env.HARNESS_HOST_USER_TURN_PUBLIC_KEY_SPKI;
    else process.env.HARNESS_HOST_USER_TURN_PUBLIC_KEY_SPKI = savedTrustAnchor;
  }
  if (!confirmed.success_criteria.find((c) => c.name === "human sign-off")?.passed) {
    throw new Error("confirm must pass the criterion");
  }

  await updateGoal(wsCAS, { success_criteria: [{ name: "free criterion", passed: true }] });
  const casDone = await completeGoal(wsCAS);
  if (casDone.status !== "completed") throw new Error("CAS goal did not complete");

  const { readHarnessEvents } = await import("../dist/lib/harness-events.js");
  const casEvidence = await readHarnessEvents(wsCAS, { type: "evidence/recorded", limit: 10 });
  if (!casEvidence.some((event) => event.evidence_kind === "user_confirmed" &&
      event.data?.criterion === "human sign-off" &&
      event.data?.source_verification === "operator_pinned_signature_v1")) {
    throw new Error("user_confirmed evidence event missing");
  }

  // --- Goal tool entry: bind action and cancellation CAS ---
  const wsTool = path.join(tmpRoot, "ws-tool");
  await fs.mkdir(wsTool, { recursive: true });
  const toolGoal = await createGoal(wsTool, {
    objective: "Exercise Goal Mode tool entry",
    success_criteria: [{ name: "tool entry exercised", passed: false }],
  });
  process.env.GOAL_WATCHDOG_ENABLED = "false";
  const { createMcpServer } = await import("../dist/server-factory.js");
  const server = createMcpServer(wsTool, 30_000, [wsTool], true);
  const client = new Client({ name: "goal-mode-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  serverTransport.sessionId = "goal-tool-test-session";
  try {
    const listed = await client.listTools();
    const goalTool = listed.tools.find((tool) => tool.name === "goal");
    if (!goalTool || !JSON.stringify(goalTool.inputSchema).includes("bind")) {
      throw new Error("goal tools/list schema must expose action=bind");
    }

    const staleBind = await client.callTool({
      name: "goal",
      arguments: { action: "bind", expected_revision: toolGoal.revision + 1 },
    });
    if (staleBind.structuredContent?.ok !== false || !JSON.stringify(staleBind).includes("GOAL_STALE_REVISION")) {
      throw new Error("goal action=bind must enforce expected_revision");
    }

    const boundResult = await client.callTool({
      name: "goal",
      arguments: { action: "bind", expected_revision: toolGoal.revision },
    });
    const bound = boundResult.structuredContent?.data?.goal;
    if (boundResult.structuredContent?.ok !== true || bound?.owner_session !== serverTransport.sessionId || bound?.revision !== toolGoal.revision + 1) {
      throw new Error("goal action=bind did not adopt the session with a revision bump");
    }

    const staleCancel = await client.callTool({
      name: "goal",
      arguments: { action: "cancel", expected_revision: toolGoal.revision },
    });
    if (staleCancel.structuredContent?.ok !== false || !JSON.stringify(staleCancel).includes("GOAL_STALE_REVISION")) {
      throw new Error("goal action=cancel must enforce expected_revision");
    }
    const afterStaleCancel = await getGoal(wsTool);
    if (afterStaleCancel?.status !== "active" || afterStaleCancel.revision !== bound.revision) {
      throw new Error("stale goal cancellation mutated the goal");
    }

    const cancelledResult = await client.callTool({
      name: "goal",
      arguments: { action: "cancel", expected_revision: bound.revision },
    });
    if (cancelledResult.structuredContent?.data?.goal?.status !== "cancelled") {
      throw new Error("goal action=cancel did not cancel with the current revision");
    }
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }

  // --- Goal bind must migrate the session-scoped durable task too ---
  const wsBindTask = path.join(tmpRoot, "ws-bind-task");
  await fs.mkdir(wsBindTask, { recursive: true });
  const bindServer = createMcpServer(wsBindTask, 30_000, [wsBindTask], true);
  const bindClient = new Client({ name: "goal-task-bind-test", version: "1" });
  const [bindClientTransport, bindServerTransport] = InMemoryTransport.createLinkedPair();
  await bindServer.connect(bindServerTransport);
  await bindClient.connect(bindClientTransport);
  const oldSession = "goal-task-old-session";
  const newSession = "goal-task-new-session";
  bindServerTransport.sessionId = oldSession;
  try {
    const createdGoalResult = await bindClient.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "Verify Goal/task session migration",
        success_criteria: [{ name: "migration verified", passed: false }],
      },
    });
    const createdGoal = createdGoalResult.structuredContent?.data?.goal;
    if (createdGoalResult.structuredContent?.ok !== true || createdGoal?.owner_session !== oldSession) {
      throw new Error("session-scoped Goal was not created in the old session");
    }

    const createdTaskResult = await bindClient.callTool({
      name: "task_state",
      arguments: {
        action: "create",
        goal: "Durable task paired with the migration Goal",
        current_step: "Wait for Goal rebind",
        blocking_checks: [{ name: "migration verified", passed: false }],
      },
    });
    const taskId = createdTaskResult.structuredContent?.data?.handoff?.task_id;
    if (!taskId) throw new Error("session-scoped durable task was not created");
    const oldTask = await readTaskAsSession(wsBindTask, oldSession, taskId);
    if (oldTask.owner_session !== oldSession || (await getActiveTaskId(wsBindTask, oldSession)) !== taskId) {
      throw new Error("durable task owner/pointer was not scoped to the old session");
    }

    // Reproduce a real long-running Goal where evidence-only tool results have
    // advanced GoalRun far beyond the legacy goal.json revision. Bind must not
    // treat that expected revision skew as a projection divergence.
    for (let i = 0; i < 2; i += 1) {
      const preBindObservation = await bindClient.callTool({
        name: "run_command",
        arguments: {
          command: `node -e \"console.log('pre-bind-evidence-${i}')\"`,
          working_directory: wsBindTask,
          _intent: TEST_INTENT,
        },
      });
      if (preBindObservation.structuredContent?.ok !== true) {
        throw new Error("pre-bind evidence command failed");
      }
    }
    const oldSessionStatus = await bindClient.callTool({ name: "goal", arguments: { action: "status" } });
    const legacyBeforeBind = oldSessionStatus.structuredContent?.data?.goal;
    const runBeforeBind = oldSessionStatus.structuredContent?.data?.goal_run;
    if (!legacyBeforeBind || !runBeforeBind || runBeforeBind.revision <= legacyBeforeBind.revision) {
      throw new Error("bind revision-skew fixture did not advance GoalRun beyond legacy goal revision");
    }

    // Simulate opening the same Goal from a fresh ChatGPT/MCP session.
    bindServerTransport.sessionId = newSession;
    const foreignStatus = await bindClient.callTool({ name: "goal", arguments: { action: "status" } });
    const takeoverCandidate = foreignStatus.structuredContent?.data?.takeover_candidate;
    if (
      foreignStatus.structuredContent?.data?.takeover_confirmation_required !== true ||
      takeoverCandidate?.goal_id !== createdGoal.id ||
      takeoverCandidate?.revision !== legacyBeforeBind.revision
    ) {
      throw new Error("fresh session must see a redacted takeover candidate before bind");
    }

    const firstBind = await bindClient.callTool({
      name: "goal",
      arguments: { action: "bind", expected_revision: legacyBeforeBind.revision },
    });
    const firstBindData = firstBind.structuredContent?.data;
    if (
      firstBind.structuredContent?.ok !== false ||
      firstBindData?.error !== "GOAL_TAKEOVER_CONFIRMATION_REQUIRED" ||
      typeof firstBindData?.takeover_token !== "string"
    ) {
      throw new Error("first cross-window bind must return a confirmation token without migrating ownership");
    }

    const reboundResult = await bindClient.callTool({
      name: "goal",
      arguments: {
        action: "bind",
        expected_revision: legacyBeforeBind.revision,
        takeover_token: firstBindData.takeover_token,
      },
    });
    const rebound = reboundResult.structuredContent?.data?.goal;
    const reboundRun = reboundResult.structuredContent?.data?.goal_run;
    const taskRebind = reboundResult.structuredContent?.data?.durable_task_rebind;
    if (
      reboundResult.structuredContent?.ok !== true ||
      rebound?.owner_session !== newSession ||
      rebound?.revision !== reboundRun?.revision ||
      taskRebind?.migrated !== true ||
      taskRebind?.task_id !== taskId
    ) {
      throw new Error("goal action=bind did not migrate the paired durable task and return the synchronized GoalRun projection");
    }
    if ((await getActiveTaskId(wsBindTask, oldSession)) !== null) {
      throw new Error("old session active-task pointer survived Goal bind");
    }
    if ((await getActiveTaskId(wsBindTask, newSession)) !== taskId) {
      throw new Error("new session did not receive the migrated active-task pointer");
    }
    const reboundTask = await readTaskAsSession(wsBindTask, newSession, taskId);
    if (reboundTask.owner_session !== newSession) {
      throw new Error("durable task owner_session did not migrate with Goal bind");
    }

    bindServerTransport.sessionId = oldSession;
    const oldSessionTaskAccess = await bindClient.callTool({
      name: "task_state",
      arguments: { action: "resume", task_id: taskId },
    });
    if (oldSessionTaskAccess.structuredContent?.ok !== false || !JSON.stringify(oldSessionTaskAccess).includes("different ChatGPT window")) {
      throw new Error("explicit task_id must not bypass durable-task session ownership after bind");
    }
    bindServerTransport.sessionId = newSession;

    const resumedTask = await bindClient.callTool({ name: "task_state", arguments: { action: "resume" } });
    if (
      resumedTask.structuredContent?.ok !== true ||
      resumedTask.structuredContent?.data?.handoff?.task_id !== taskId ||
      resumedTask.structuredContent?.data?.handoff?.owner_session !== newSession
    ) {
      throw new Error("new session could not resume the migrated durable task");
    }

    // Exact regression for the production failure: a post-bind tool result
    // must be recorded on the migrated task instead of disappearing into the
    // old session's pointer.
    const observation = await bindClient.callTool({
      name: "run_command",
      arguments: {
        command: "node -e \"console.log('post-bind-observation')\"",
        working_directory: wsBindTask,
        _intent: TEST_INTENT,
      },
    });
    if (observation.structuredContent?.ok !== true) throw new Error("post-bind observation command failed");
    const observedTask = await readTaskAsSession(wsBindTask, newSession, taskId);
    if (!observedTask.recent_events.some((event) => event.tool === "run_command" && event.ok === true)) {
      throw new Error("post-bind tool observation was not attached to the migrated task");
    }
  } finally {
    await bindClient.close().catch(() => {});
    await bindServer.close().catch(() => {});
  }

  // The durable-task lock must span preflight -> Goal owner mutation -> task
  // migration. Otherwise a destination-session task mutation can interleave
  // after preflight and make migration fail after Goal ownership already moved.
  const wsBindAtomic = path.join(tmpRoot, "ws-bind-atomic");
  await fs.mkdir(wsBindAtomic, { recursive: true });
  const atomicOldSession = "goal-task-atomic-old";
  const atomicNewSession = "goal-task-atomic-new";
  const atomicOldScope = createRuntimeScope(
    { workspaceRoot: wsBindAtomic, projectRoots: [wsBindAtomic] },
    { sessionId: atomicOldSession }
  );
  const atomicNewScope = createRuntimeScope(
    { workspaceRoot: wsBindAtomic, projectRoots: [wsBindAtomic] },
    { sessionId: atomicNewSession }
  );
  const atomicSeed = await runWithRuntimeScope(atomicOldScope, async () => {
    const goal = await createGoal(wsBindAtomic, {
      objective: "Keep Goal/task rebind atomic across task mutations",
      success_criteria: [{ name: "atomic bind verified", passed: false }],
    });
    const task = await createDurableTask(wsBindAtomic, {
      goal: "Atomic durable task migration",
      current_step: "Bind to new session",
    });
    return { goal, task };
  });
  let competingTaskMutationSettled = false;
  let competingTaskMutation;
  const atomicRebound = await runWithRuntimeScope(atomicNewScope, () =>
    runWithActiveDurableTaskSessionRebind(
      wsBindAtomic,
      atomicOldSession,
      atomicNewSession,
      async () => {
        competingTaskMutation = commitActiveDurableTaskSessionRebind(wsBindAtomic, null).then((result) => {
          competingTaskMutationSettled = true;
          return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (competingTaskMutationSettled) {
          throw new Error("durable-task lock was released between rebind preflight and Goal ownership mutation");
        }
        return bindGoalToSession(wsBindAtomic, { expectedRevision: atomicSeed.goal.revision });
      }
    )
  );
  if (atomicRebound.value.owner_session !== atomicNewSession || atomicRebound.durable_task_rebind.migrated !== true) {
    throw new Error("atomic Goal/task rebind did not migrate both owners");
  }
  if ((await readTaskAsSession(wsBindAtomic, atomicNewSession, atomicSeed.task.id)).owner_session !== atomicNewSession) {
    throw new Error("atomic rebind left durable task ownership behind");
  }
  if ((await getActiveTaskId(wsBindAtomic, atomicOldSession)) !== null || (await getActiveTaskId(wsBindAtomic, atomicNewSession)) !== atomicSeed.task.id) {
    throw new Error("atomic rebind left session task pointers inconsistent");
  }
  await competingTaskMutation;
  if (!competingTaskMutationSettled) throw new Error("queued durable-task mutation did not resume after atomic rebind released the lock");

  // Destination-session work must never be overwritten by a Goal bind. The
  // conflict is rejected before Goal ownership changes.
  const wsBindConflict = path.join(tmpRoot, "ws-bind-conflict");
  await fs.mkdir(wsBindConflict, { recursive: true });
  const conflictServer = createMcpServer(wsBindConflict, 30_000, [wsBindConflict], true);
  const conflictClient = new Client({ name: "goal-task-bind-conflict-test", version: "1" });
  const [conflictClientTransport, conflictServerTransport] = InMemoryTransport.createLinkedPair();
  await conflictServer.connect(conflictServerTransport);
  await conflictClient.connect(conflictClientTransport);
  const conflictOldSession = "goal-task-conflict-old";
  const conflictNewSession = "goal-task-conflict-new";
  conflictServerTransport.sessionId = conflictOldSession;
  try {
    const conflictGoalResult = await conflictClient.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "Do not overwrite destination session task",
        success_criteria: [{ name: "conflict handled", passed: false }],
      },
    });
    const conflictGoal = conflictGoalResult.structuredContent?.data?.goal;
    const sourceTaskResult = await conflictClient.callTool({
      name: "task_state",
      arguments: { action: "create", goal: "source task", current_step: "source" },
    });
    const sourceTaskId = sourceTaskResult.structuredContent?.data?.handoff?.task_id;
    if (!conflictGoal || !sourceTaskId) throw new Error("bind conflict fixture failed to create source state");

    conflictServerTransport.sessionId = conflictNewSession;
    const destinationTaskResult = await conflictClient.callTool({
      name: "task_state",
      arguments: { action: "create", goal: "destination task", current_step: "destination" },
    });
    const destinationTaskId = destinationTaskResult.structuredContent?.data?.handoff?.task_id;
    if (!destinationTaskId) throw new Error("bind conflict fixture failed to create destination task");

    const conflictFirstBind = await conflictClient.callTool({
      name: "goal",
      arguments: { action: "bind", expected_revision: conflictGoal.revision },
    });
    const conflictToken = conflictFirstBind.structuredContent?.data?.takeover_token;
    if (
      conflictFirstBind.structuredContent?.ok !== false ||
      conflictFirstBind.structuredContent?.data?.error !== "GOAL_TAKEOVER_CONFIRMATION_REQUIRED" ||
      typeof conflictToken !== "string"
    ) {
      throw new Error("conflict bind must still issue a takeover token before migration preflight");
    }
    const rejectedBind = await conflictClient.callTool({
      name: "goal",
      arguments: {
        action: "bind",
        expected_revision: conflictGoal.revision,
        takeover_token: conflictToken,
      },
    });
    if (rejectedBind.structuredContent?.ok !== false || !JSON.stringify(rejectedBind).includes("GOAL_BIND_TASK_CONFLICT")) {
      throw new Error("Goal bind must reject a destination active-task conflict");
    }
    const afterRejectedBind = await getGoal(wsBindConflict);
    if (afterRejectedBind?.owner_session !== conflictOldSession || afterRejectedBind.revision !== conflictGoal.revision) {
      throw new Error("rejected task migration must not mutate Goal ownership/revision");
    }
    if ((await getActiveTaskId(wsBindConflict, conflictOldSession)) !== sourceTaskId) {
      throw new Error("rejected bind changed the source active-task pointer");
    }
    if ((await getActiveTaskId(wsBindConflict, conflictNewSession)) !== destinationTaskId) {
      throw new Error("rejected bind changed the destination active-task pointer");
    }
  } finally {
    await conflictClient.close().catch(() => {});
    await conflictServer.close().catch(() => {});
  }

  // --- Supersede: a different new task must get a CLEAN goal, never append ---
  const wsSuper = path.join(tmpRoot, "ws-supersede");
  await fs.mkdir(wsSuper, { recursive: true });
  const oldGoal = await createGoal(wsSuper, {
    objective: "old unrelated task goal",
    success_criteria: [{ name: "old criterion", passed: true }],
  });
  let existsRejected = false;
  try {
    await createGoal(wsSuper, { objective: "new unrelated task", success_criteria: [{ name: "new criterion", passed: false }] });
  } catch (error) {
    existsRejected = String(error).includes("DIFFERENT task") && String(error).includes("supersede=true");
  }
  if (!existsRejected) throw new Error("goal-exists rejection must offer the supersede path");

  const newGoal = await createGoal(wsSuper, {
    objective: "new unrelated task",
    success_criteria: [{ name: "new criterion", passed: false }],
    supersede: true,
  });
  if (newGoal.id === oldGoal.id) throw new Error("supersede must mint a fresh goal id");
  if (newGoal.success_criteria.length !== 1 || newGoal.success_criteria[0].name !== "new criterion") {
    throw new Error("superseded goal must be clean — no inherited criteria");
  }
  const superEvents = await readHarnessEvents(wsSuper, { type: "goal/change", limit: 20 });
  if (!superEvents.some((event) => event.goal_id === oldGoal.id && event.data?.operation === "status:cancelled")) {
    throw new Error("supersede must cancel the old goal via event");
  }
  const policy = (await import("../dist/lib/goals.js")).goalSummary(newGoal).execution_policy;
  if (policy.progress_messages !== "checkpoint_and_visible_heartbeat" ||
      policy.user_reply !== "visible_heartbeat_then_continue_until_DELIVERABLE_READY_or_verified_blocker" ||
      policy.visible_heartbeat?.counts_as_heartbeat !== "user_visible_assistant_text_only" ||
      policy.visible_heartbeat?.tool_activity_counts_as_heartbeat !== false ||
      policy.visible_heartbeat?.ends_execution !== false) {
    throw new Error("goal summary missing execution_policy");
  }

  console.log("goal-mode: persistence, session instructions, pause/resume, criteria gate, explicit completion, revision CAS, user confirmation, and supersede OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
