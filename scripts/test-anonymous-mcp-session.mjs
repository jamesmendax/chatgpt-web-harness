/**
 * Anonymous factory sessions use server-owned identity, including the complete
 * MCP client -> SDK -> InvocationGateway -> Goal/evidence path.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wh-anonymous-mcp-"));
const workspace = path.join(tempRoot, "workspace");
const environment = {
  CODEX_HOME: path.join(tempRoot, "runtime"),
  AUDIT_LOG_PATH: path.join(tempRoot, "audit.log"),
  MCP_SHELL_STATE_DIR: path.join(tempRoot, "shell"),
  MCP_UPSTREAM_CONFIG: path.join(tempRoot, "upstream.json"),
  CHATGPT_TOOL_PROFILE: "full",
  HARNESS_RELAY_ENABLED: "true",
  HARNESS_RELAY_AUTOMATION_ENABLED: "false",
  HARNESS_COMPANION_ENABLED: "false",
  GOAL_WATCHDOG_ENABLED: "false",
};
const saved = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
Object.assign(process.env, environment);
await fs.mkdir(workspace);
const fixtureFile = path.join(workspace, "verified.txt");
await fs.writeFile(fixtureFile, "anonymous session evidence\n", "utf8");
const servers = new Set();
let stopGoalWatchdog;

function payload(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result));
  return result.structuredContent.data;
}

try {
  const { createMcpServer } = await import("../dist/server-factory.js");
  const { getRuntimeScope } = await import("../dist/lib/runtime-scope.js");
  const { getGoal, getWorkspaceGoalProjection } = await import("../dist/lib/goals.js");
  const { readGoalRun } = await import("../dist/lib/goal-run-store.js");
  const { EffectiveToolRegistry } = await import("../dist/lib/effective-tool-registry.js");
  const { InvocationGateway } = await import("../dist/lib/invocation-gateway.js");
  ({ stopGoalWatchdog } = await import("../dist/lib/goal-watchdog.js"));

  const probeName = "anonymous_session_probe";
  const probeSchema = {
    sessionId: z.string().optional(),
    mcpSessionId: z.string().optional(),
    owner_session: z.string().optional(),
    goalId: z.string().optional(),
    goal_id: z.string().optional(),
    requestId: z.number().optional(),
    signal: z.object({ aborted: z.boolean().optional() }).optional(),
    _meta: z.record(z.unknown()).optional(),
  };
  function probeHandler(args) {
    const scope = getRuntimeScope();
    assert.ok(scope, "production callback must have an invocation scope");
    const data = {
      session: scope.mcpSessionId ?? null,
      goal: scope.goalId ?? null,
      owner: scope.goalOwnerSessionId ?? null,
      received: args,
    };
    const value = { ok: true, tool: probeName, summary: "captured trusted session", data };
    return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
  }

  async function connect(name, transportSessionId) {
    const server = createMcpServer(workspace, 30_000, [workspace], false);
    server.registerTool(probeName, {
      inputSchema: probeSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }, probeHandler);
    const client = new Client({ name, version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    assert.equal(serverTransport.sessionId, undefined, "SDK anonymous transport fixture changed");
    if (transportSessionId !== undefined) serverTransport.sessionId = transportSessionId;
    const configured = { server, client, serverTransport };
    servers.add(configured);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return configured;
  }

  const call = async (configured, name, args = {}) =>
    payload(await configured.client.callTool({ name, arguments: args }));
  const probe = (configured, args = {}) => call(configured, probeName, args);
  const create = (configured, label) => call(configured, "goal", {
    action: "create",
    objective: label,
    success_criteria: [{
      name: "file evidence",
      passed: false,
      verification: { kind: "file_exists", target: fixtureFile },
    }],
  });

  const first = await connect("anonymous-A");
  const second = await connect("anonymous-B");
  const initialA = await probe(first);
  const initialB = await probe(second);
  assert.equal(first.serverTransport.sessionId, undefined, "A must remain genuinely anonymous");
  assert.equal(second.serverTransport.sessionId, undefined, "B must remain genuinely anonymous");
  assert.match(initialA.session, /^local_mcp_.+$/);
  assert.match(initialB.session, /^local_mcp_.+$/);
  assert.notEqual(initialA.session, initialB.session, "factories shared their fallback identity");
  assert.equal(initialA.goal, null);
  assert.equal(initialB.goal, null);
  const { skill_discovery: firstDiscovery, ...stableInitialA } = initialA;
  assert.equal(firstDiscovery.catalog.schema_version, 1, "first native result must advertise discovery");
  assert.deepEqual(await probe(first), stableInitialA, "anonymous identity and handler data changed on a second request");

  const goalA = (await create(first, "anonymous A independent Goal")).goal;
  assert.equal(goalA.owner_session, initialA.session);
  const afterA = await probe(first);
  assert.equal(afterA.session, initialA.session);
  assert.equal(afterA.goal, goalA.id);
  assert.equal(afterA.owner, initialA.session);

  const goalB = (await create(second, "anonymous B independent Goal")).goal;
  assert.notEqual(goalA.id, goalB.id);
  assert.equal(goalB.owner_session, initialB.session);
  assert.equal((await getWorkspaceGoalProjection(workspace)).id, goalB.id,
    "B must be the discovery projection before A re-enters");

  const spoof = {
    sessionId: initialB.session,
    mcpSessionId: initialB.session,
    owner_session: initialB.session,
    goalId: goalB.id,
    goal_id: goalB.id,
    requestId: 999_999,
    signal: { aborted: false },
    _meta: { "openai/conversation-id": initialB.session },
  };
  const spoofedA = await probe(first, spoof);
  assert.deepEqual(spoofedA.received, spoof, "spoofed fields must reach the handler, not be stripped by its schema");
  assert.equal(spoofedA.session, initialA.session, "raw arguments replaced the trusted anonymous owner");
  assert.equal(spoofedA.goal, goalA.id, "raw Goal identity borrowed another factory's authority");
  assert.equal(spoofedA.owner, initialA.session);
  const afterB = await probe(second);
  assert.equal(afterB.session, initialB.session);
  assert.equal(afterB.goal, goalB.id);
  assert.equal(afterB.owner, initialB.session);

  assert.equal((await call(first, "goal", { action: "status" })).goal.id, goalA.id);
  assert.equal((await call(second, "goal", { action: "status" })).goal.id, goalB.id);
  assert.equal((await getGoal(workspace, initialA.session)).id, goalA.id);
  assert.equal((await getGoal(workspace, initialB.session)).id, goalB.id);
  const evidenceA = await call(first, "file_info", { path: fixtureFile, sha256: true });
  const evidenceB = await call(second, "file_info", { path: fixtureFile, sha256: true });
  assert.ok(evidenceA.goal_run_evidence?.id, "A lost evidence without a transport session ID");
  assert.ok(evidenceB.goal_run_evidence?.id, "B lost evidence without a transport session ID");
  assert.equal(evidenceA.goal_run_evidence.verifies_criterion, true);
  assert.equal(evidenceB.goal_run_evidence.verifies_criterion, true);
  assert.notEqual(evidenceA.goal_run_evidence.id, evidenceB.goal_run_evidence.id);
  assert.equal(evidenceA.harness_context.goal.goal_id, goalA.id);
  assert.equal(evidenceB.harness_context.goal.goal_id, goalB.id);
  const runA = (await readGoalRun(workspace, initialA.session)).run;
  const runB = (await readGoalRun(workspace, initialB.session)).run;
  assert.equal(runA.runId, goalA.id);
  assert.equal(runB.runId, goalB.id);
  assert.ok(runA.typedEvidence.some(evidence => evidence.id === evidenceA.goal_run_evidence.id));
  assert.ok(runB.typedEvidence.some(evidence => evidence.id === evidenceB.goal_run_evidence.id));
  assert.equal(runA.typedEvidence.some(evidence => evidence.id === evidenceB.goal_run_evidence.id), false);
  assert.equal(runB.typedEvidence.some(evidence => evidence.id === evidenceA.goal_run_evidence.id), false);

  // The SDK copies the server transport's identity into callback extra. This is
  // intentionally assigned on the server transport, never in callTool arguments.
  const trustedTransportSession = "server-owned-transport-C";
  const explicit = await connect("transport-C", trustedTransportSession);
  const explicitBeforeGoal = await probe(explicit, spoof);
  assert.equal(explicitBeforeGoal.session, trustedTransportSession,
    "factory fallback overrode the real transport session");
  assert.equal(explicitBeforeGoal.goal, null, "new transport borrowed the discovery Goal");
  const goalC = (await create(explicit, "explicit transport Goal")).goal;
  assert.equal(goalC.owner_session, trustedTransportSession);
  const explicitAfterGoal = await probe(explicit, spoof);
  assert.equal(explicitAfterGoal.session, trustedTransportSession);
  assert.equal(explicitAfterGoal.goal, goalC.id);
  assert.equal(explicitAfterGoal.owner, trustedTransportSession);
  assert.equal((await probe(first)).goal, goalA.id);
  assert.equal((await probe(second)).goal, goalB.id);

  // The production factory supplies the fallback. A bare Gateway has no basis
  // to fabricate a session or authorize the workspace's latest Goal.
  const registry = new EffectiveToolRegistry("full");
  assert.ok(registry.register(probeName, {
    inputSchema: probeSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, probeHandler));
  const bare = new InvocationGateway(registry, { workspaceRoot: workspace, projectRoots: [workspace] });
  const anonymousExtra = { requestId: 1, signal: new AbortController().signal };
  const bareResult = payload(await bare.invoke(probeName, [spoof, anonymousExtra]));
  assert.equal(bareResult.session, null);
  assert.equal(bareResult.goal, null);
  assert.equal(bareResult.owner, null);
  assert.equal((await getWorkspaceGoalProjection(workspace)).id, goalC.id);
  console.log("Anonymous MCP factory sessions: stable distinct owners, per-Goal evidence, transport precedence, raw-argument rejection and bare-Gateway isolation passed");
} finally {
  for (const { client, server } of servers) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
  stopGoalWatchdog?.();
  await fs.rm(tempRoot, { recursive: true, force: true });
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
