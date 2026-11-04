import { createRelayFixtureScope } from "./relay-fixture-scope.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testRoot = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(testRoot, "relay-foundation-"));
const workspace = path.join(tempRoot, "workspace");
await fs.mkdir(workspace, { recursive: true });

const originalCodexHome = process.env.CODEX_HOME;
const originalRelay = process.env.HARNESS_RELAY_ENABLED;
const originalWatchdog = process.env.GOAL_WATCHDOG_ENABLED;
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
process.env.HARNESS_RELAY_ENABLED = "true";
process.env.GOAL_WATCHDOG_ENABLED = "false";

const { registerGoalTool } = await import("../dist/tools/goal.js");
const { EffectiveToolRegistry } = await import("../dist/lib/effective-tool-registry.js");
const { InvocationGateway } = await import("../dist/lib/invocation-gateway.js");
const { createRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");
const { getWorkspaceGoalProjection } = await import("../dist/lib/goals.js");
const fixtureScopes = createRelayFixtureScope((await import("../dist/lib/relay-scope.js")).withRelayGoal);
const driver = fixtureScopes.wrap(await import("../dist/lib/driver-lease.js"));
const handoffs = fixtureScopes.wrap(await import("../dist/lib/handoff-store.js"));
const resumes = fixtureScopes.wrap(await import("../dist/lib/resume-bundle.js"));

const SOURCE = "relay-chat-a-session";
const TARGET = "relay-chat-b-session";

function scopeFor(sessionId) {
  return createRuntimeScope({ workspaceRoot: workspace, projectRoots: [workspace] }, { sessionId });
}

function requestExtra(sessionId, requestId) {
  return {
    sessionId,
    requestId,
    signal: new AbortController().signal,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  };
}

function requirementIntent() {
  return JSON.stringify({
    intent_revision: 1,
    objective: "Exercise isolated dual-chat relay fencing",
    scope: ["relay test fixture"],
    out_of_scope: [],
    deliverables: ["relay handoff assertions"],
    success_criteria: ["only the active Driver may mutate"],
    constraints: ["never touch production runtime"],
    protected_resources: [],
    known_facts: ["all state lives under a temporary CODEX_HOME"],
    assumptions: [],
    delegated_decisions: [],
    remaining_nonblocking_uncertainties: [],
    closure_items: [],
    ambiguities: [],
    clarification_round: 0,
    questions_in_round: 0,
    resolution_mode: "none",
  });
}

function marker(value) {
  return {
    content: [{ type: "text", text: value }],
    structuredContent: { marker: value },
  };
}

let goalTool;
registerGoalTool({
  registerTool(name, config, callback) {
    if (name === "goal") goalTool = { config, callback };
  },
}, workspace);
assert.ok(goalTool, "goal tool was not registered");
const goalSchema = z.object(goalTool.config.inputSchema);

function invokeGoal(sessionId, args) {
  return runWithRuntimeScope(scopeFor(sessionId), () => goalTool.callback(goalSchema.parse(args)));
}

let slowEnteredResolve;
let slowReleaseResolve;
const slowEntered = new Promise((resolve) => { slowEnteredResolve = resolve; });
const slowRelease = new Promise((resolve) => { slowReleaseResolve = resolve; });
let writes = 0;

const registry = new EffectiveToolRegistry("full");
const writeDefinition = registry.prepare(
  "write_file",
  { inputSchema: { path: z.string() }, annotations: { readOnlyHint: false } },
  async (args) => {
    writes += 1;
    if (args?.path === "slow") {
      slowEnteredResolve();
      await slowRelease;
    }
    return marker(`written:${args?.path}`);
  }
);
assert.ok(writeDefinition);
registry.register(writeDefinition);
const gateway = new InvocationGateway(registry, {
  workspaceRoot: workspace,
  projectRoots: [workspace],
});

async function invokeWrite(sessionId, requestId, file = "fast") {
  return gateway.invoke("write_file", [{ path: file, _intent: requirementIntent() }, requestExtra(sessionId, requestId)]);
}

try {
  const created = await invokeGoal(SOURCE, {
    action: "create",
    objective: "Verify dual Chat A/B autonomous relay foundation",
    success_criteria: [{ name: "relay fencing verified" }],
    constraints: ["temporary fixture only"],
    current_phase: "source driver active",
  });
  assert.equal(created.structuredContent.ok, true);
  const goalId = created.structuredContent.data.goal.id;
  fixtureScopes.set(workspace, goalId);

  // Enter one real mutation and keep it in flight. The handoff must first move
  // the Driver to DRAINING, reject new mutations, then wait for this one.
  const slowWrite = invokeWrite(SOURCE, 1, "slow");
  await slowEntered;
  const initialLease = await driver.readDriverLease(workspace);
  assert.equal(initialLease?.goal_id, goalId);
  assert.equal(initialLease?.epoch, 1);
  assert.equal(initialLease?.owner_session_id, SOURCE);
  assert.equal(initialLease?.state, "ACTIVE");
  assert.ok(Date.parse(initialLease.expires_at) > Date.now());
  assert.equal(driver.activeDriverMutationCount(workspace, initialLease.lease_id), 1);

  let prepareSettled = false;
  const preparePromise = invokeGoal(SOURCE, {
    action: "handoff_prepare",
  }).finally(() => { prepareSettled = true; });

  let drainingLease = null;
  // The contract is fencing before drain, not sub-500ms Windows disk latency.
  // Stop early on a settled handler so a real failure is reported directly.
  const drainDeadline = Date.now() + 5_000;
  while (Date.now() < drainDeadline) {
    drainingLease = await driver.readDriverLease(workspace);
    if (drainingLease?.state === "DRAINING" || prepareSettled) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const prepareDiagnostic = prepareSettled ? JSON.stringify(await preparePromise) : "pending within fixture deadline";
  assert.equal(drainingLease?.state, "DRAINING", `handoff did not fence new mutations before draining: ${prepareDiagnostic}`);
  assert.equal(prepareSettled, false, "handoff completed before the in-flight mutation drained");

  const duringDrain = await invokeWrite(SOURCE, 2, "must-not-run");
  assert.equal(duringDrain.structuredContent.ok, false);
  assert.equal(duringDrain.structuredContent.data.error_code, "DRIVER_NOT_ACTIVE");
  assert.equal(writes, 1, "a mutation entered after Driver moved to DRAINING");

  slowReleaseResolve();
  const slowResult = await slowWrite;
  assert.equal(slowResult.structuredContent.marker, "written:slow");
  const preparedResult = await preparePromise;
  assert.equal(preparedResult.structuredContent.ok, true);
  const prepared = preparedResult.structuredContent.data;
  const handoffId = prepared.handoff.handoff_id;
  assert.match(handoffId, /^hf_/);
  assert.equal(prepared.driver_lease.state, "HANDOFF_PREPARED");
  assert.equal(prepared.handoff.source_driver_epoch, 1);
  assert.equal(prepared.handoff.target_session_id, null, "untargeted handoff should be claimed by the standby session at bind time");
  assert.equal(prepared.handoff.state, "PREPARED");
  assert.ok(prepared.handoff.snapshot_hash.length === 64);
  assert.equal(prepared.resume_bundle.goal_id, goalId);
  assert.equal(prepared.resume_bundle.goal_run_id, goalId);
  assert.equal(prepared.resume_bundle.state, "PREPARED");
  assert.equal(prepared.resume_bundle.snapshot_hash, prepared.handoff.snapshot_hash);
  const durableResume = await resumes.readResumeBundle(workspace, handoffId);
  assert.equal(durableResume?.goal_id, goalId);
  assert.equal(durableResume?.goal_run_id, goalId);
  assert.equal(durableResume?.state, "PREPARED");
  assert.equal(driver.activeDriverMutationCount(workspace, initialLease.lease_id), 0);

  // A prepared snapshot is a freeze point. Source A remains readable but can no
  // longer begin side effects while target B is being awakened.
  const afterPrepare = await invokeWrite(SOURCE, 3, "must-not-run-after-prepare");
  assert.equal(afterPrepare.structuredContent.data.error_code, "DRIVER_NOT_ACTIVE");
  assert.equal(writes, 1);

  const targetStatus = await invokeGoal(TARGET, { action: "status", handoff_id: handoffId });
  assert.equal(targetStatus.structuredContent.ok, true);
  assert.equal(targetStatus.structuredContent.data.relay.prepared_handoff.handoff_id, handoffId);

  // Prepared handoff is a machine authorization. It replaces only the manual
  // takeover token for this exact target/revision and performs Goal + Driver
  // ownership migration in one recoverable path.
  const bound = await invokeGoal(TARGET, { action: "bind", handoff_id: handoffId });
  assert.equal(bound.structuredContent.ok, true);
  assert.equal(bound.structuredContent.data.relay_takeover, true);
  assert.equal(bound.structuredContent.data.driver_lease.owner_session_id, TARGET);
  assert.equal(bound.structuredContent.data.driver_lease.epoch, 2);
  assert.equal(bound.structuredContent.data.driver_lease.state, "ACTIVE");

  const committedSnapshot = await handoffs.readHandoffSnapshot(workspace, handoffId);
  assert.equal(committedSnapshot?.state, "COMMITTED");
  assert.equal(committedSnapshot?.target_session_id, TARGET);
  const committedResume = await resumes.readResumeBundle(workspace, handoffId);
  assert.equal(committedResume?.state, "COMMITTED");
  assert.equal(committedResume?.target_session_id, TARGET);
  assert.equal(committedResume?.goal_id, goalId);
  const globalGoal = await getWorkspaceGoalProjection(workspace);
  assert.equal(globalGoal?.owner_session, TARGET);

  // Lost ACK / retry after ownership migration is idempotent: no epoch bump.
  const rebound = await invokeGoal(TARGET, { action: "bind", handoff_id: handoffId });
  assert.equal(rebound.structuredContent.ok, true);
  assert.equal(rebound.structuredContent.data.driver_lease.epoch, 2);
  assert.equal(rebound.structuredContent.data.driver_lease.owner_session_id, TARGET);

  // If old A wakes up after Connection interrupted it is fenced even though the
  // tool call itself is otherwise valid and carries a READY Execution Contract.
  const staleA = await invokeWrite(SOURCE, 4, "stale-a");
  assert.equal(staleA.structuredContent.ok, false);
  assert.equal(staleA.structuredContent.data.error_code, "DRIVER_LEASE_LOST");
  assert.equal(writes, 1);

  const liveB = await invokeWrite(TARGET, 5, "live-b");
  assert.equal(liveB.structuredContent.marker, "written:live-b");
  assert.equal(writes, 2);

  // Exercise the reverse lane preparation and rollback path. Aborting restores
  // the same epoch/owner and permits B to continue without a split-brain window.
  const reversePrepare = await invokeGoal(TARGET, {
    action: "handoff_prepare",
    target_session_id: SOURCE,
  });
  assert.equal(reversePrepare.structuredContent.ok, true);
  const reverseId = reversePrepare.structuredContent.data.handoff.handoff_id;
  assert.equal((await driver.readDriverLease(workspace))?.state, "HANDOFF_PREPARED");

  const aborted = await invokeGoal(TARGET, { action: "handoff_abort", handoff_id: reverseId });
  assert.equal(aborted.structuredContent.ok, true);
  assert.equal(aborted.structuredContent.data.driver_lease.owner_session_id, TARGET);
  assert.equal(aborted.structuredContent.data.driver_lease.epoch, 2);
  assert.equal(aborted.structuredContent.data.driver_lease.state, "ACTIVE");
  assert.equal((await handoffs.readHandoffSnapshot(workspace, reverseId))?.state, "ABORTED");
  assert.equal((await resumes.readResumeBundle(workspace, reverseId))?.state, "ABORTED");

  const resumedB = await invokeWrite(TARGET, 6, "after-abort");
  assert.equal(resumedB.structuredContent.marker, "written:after-abort");
  assert.equal(writes, 3);

  console.log("Relay foundation: drain-before-snapshot, durable Resume Bundle, Goal bind authorization, epoch fencing, idempotent commit, stale-driver rejection, and abort rollback passed");
} finally {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalRelay === undefined) delete process.env.HARNESS_RELAY_ENABLED;
  else process.env.HARNESS_RELAY_ENABLED = originalRelay;
  if (originalWatchdog === undefined) delete process.env.GOAL_WATCHDOG_ENABLED;
  else process.env.GOAL_WATCHDOG_ENABLED = originalWatchdog;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
