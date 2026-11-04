import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const testRoot = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(testRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(testRoot, "requirement-readiness-"));
const originalCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(tempRoot, "codex-home");

const readiness = await import("../dist/lib/requirement-readiness.js");
const contracts = await import("../dist/lib/execution-contract.js");
const { EffectiveToolRegistry } = await import("../dist/lib/effective-tool-registry.js");
const { InvocationGateway } = await import("../dist/lib/invocation-gateway.js");
const { buildHarnessRuntimeContext } = await import("../dist/lib/context-broker.js");
const { buildServerInstructions } = await import("../dist/lib/quickstart.js");

function model(overrides = {}) {
  return {
    intent_revision: 1,
    objective: "Update the requested fixture safely",
    scope: ["fixture.txt"],
    out_of_scope: [],
    deliverables: ["updated fixture"],
    success_criteria: ["fixture matches the requested content"],
    constraints: [],
    protected_resources: [],
    known_facts: ["fixture path is known"],
    assumptions: [],
    delegated_decisions: [],
    remaining_nonblocking_uncertainties: [],
    closure_items: [],
    ambiguities: [],
    clarification_round: 0,
    questions_in_round: 0,
    resolution_mode: "none",
    ...overrides,
  };
}

function intentJson(value) {
  return JSON.stringify(value);
}

function result(marker) {
  return {
    content: [{ type: "text", text: marker }],
    structuredContent: { marker },
  };
}

function requestExtra(sessionId, requestId = 1) {
  return {
    sessionId,
    requestId,
    signal: new AbortController().signal,
    sendNotification: async () => {},
    sendRequest: async () => ({}),
  };
}

try {
  // Dynamic readiness: irrelevant/N/A dimensions never force fake questions.
  const simple = readiness.requirementModelSchema.parse(model({
    closure_items: [
      { id: "format", status: "na", materiality: "medium", basis: "not relevant" },
      { id: "target", status: "closed", materiality: "high", basis: "explicit path" },
    ],
  }));
  const simpleAssessment = readiness.assessRequirementReadiness(simple);
  assert.equal(simpleAssessment.score, 100);
  assert.equal(simpleAssessment.ready, true);
  assert.equal(simpleAssessment.blocking_ambiguities.length, 0);

  const lowOpen = readiness.requirementModelSchema.parse(model({
    closure_items: [{ id: "minor-format", status: "open", materiality: "low" }],
  }));
  const lowAssessment = readiness.assessRequirementReadiness(lowOpen);
  assert.equal(lowAssessment.score, 96);
  assert.equal(lowAssessment.ready, true, "non-material low uncertainty should not deadlock execution");

  const materialOpen = readiness.requirementModelSchema.parse(model({
    closure_items: [{ id: "scope-boundary", status: "open", materiality: "medium" }],
    clarification_round: 2,
  }));
  const materialAssessment = readiness.assessRequirementReadiness(materialOpen);
  assert.equal(materialAssessment.score, 92);
  assert.equal(materialAssessment.ready, false);
  assert.equal(materialAssessment.normal_clarification_allowed, false);
  assert.equal(materialAssessment.resolution_stage_required, true);

  const delegated = readiness.requirementModelSchema.parse(model({
    ambiguities: [{
      id: "filename-style",
      question: "Which harmless filename style should be used?",
      materiality: "medium",
      reversible: true,
      blocking: true,
      delegated: true,
    }],
    delegated_decisions: ["Assistant may choose a reasonable filename style"],
  }));
  const delegatedAssessment = readiness.assessRequirementReadiness(delegated);
  assert.equal(delegatedAssessment.ready, true, "delegated noncritical choice should close the ambiguity");

  const critical = readiness.requirementModelSchema.parse(model({
    ambiguities: [{
      id: "production-delete",
      question: "Delete production data or only the backup?",
      materiality: "critical",
      reversible: false,
      blocking: false,
      delegated: true,
    }],
  }));
  const criticalAssessment = readiness.assessRequirementReadiness(critical);
  assert.equal(criticalAssessment.ready, false);
  assert.equal(criticalAssessment.blocking_ambiguities.length, 1, "critical ambiguity must not be delegatable");

  assert.throws(
    () => readiness.requirementModelSchema.parse(model({ questions_in_round: 6 })),
    /<=5|too big/i,
    "per-round question budget was not enforced"
  );
  assert.throws(
    () => readiness.requirementModelSchema.parse(model({ clarification_round: 3 })),
    /<=2|too big/i,
    "normal clarification round budget was not enforced"
  );

  // Contract hash is semantic with respect to string-list ordering.
  const contractA = contracts.compileExecutionContract(readiness.requirementModelSchema.parse(model({
    scope: ["b", "a"],
    constraints: ["second", "first"],
  })));
  const contractB = contracts.compileExecutionContract(readiness.requirementModelSchema.parse(model({
    scope: ["a", "b"],
    constraints: ["first", "second"],
  })));
  assert.equal(contractA.requirement_hash, contractB.requirement_hash);
  assert.equal(contractA.readiness_score, 100);

  // Persisted admission makes one intent revision immutable and rejects stale revisions.
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const session = "requirement-session";
  const rev1 = readiness.requirementModelSchema.parse(model());
  const firstAdmission = await contracts.admitExecutionContract(workspace, session, rev1);
  assert.equal(firstAdmission.reused, false);
  const secondAdmission = await contracts.admitExecutionContract(workspace, session, rev1);
  assert.equal(secondAdmission.reused, true);
  await assert.rejects(
    contracts.admitExecutionContract(workspace, session, readiness.requirementModelSchema.parse(model({ scope: ["different.txt"] }))),
    /INTENT_REVISION_CONFLICT/
  );
  const rev2 = readiness.requirementModelSchema.parse(model({ intent_revision: 2, scope: ["different.txt"] }));
  const upgraded = await contracts.admitExecutionContract(workspace, session, rev2);
  assert.equal(upgraded.reused, false);
  assert.equal(upgraded.state.intent_revision, 2);
  await assert.rejects(contracts.admitExecutionContract(workspace, session, rev1), /STALE_INTENT_REVISION/);
  const stored = await contracts.readAcceptedExecutionContractState(workspace, session);
  assert.equal(stored?.intent_revision, 2);
  assert.equal(stored?.requirement_hash, upgraded.contract.requirement_hash);

  // Registry adds one compact reserved field only to real side-effect tools.
  const registry = new EffectiveToolRegistry("full");
  const readDefinition = registry.prepare(
    "read_fixture",
    { inputSchema: { path: {} }, annotations: { readOnlyHint: true } },
    async () => result("read")
  );
  const controlDefinition = registry.prepare(
    "goal",
    { inputSchema: { action: {} }, annotations: { readOnlyHint: false } },
    async () => result("goal")
  );
  const writeDefinition = registry.prepare(
    "write_fixture",
    { inputSchema: { path: {} }, annotations: { readOnlyHint: false } },
    async () => result("write")
  );
  assert.ok(readDefinition && controlDefinition && writeDefinition);
  assert.equal(Object.hasOwn(readDefinition.config.inputSchema, readiness.INTENT_ASSURANCE_FIELD), false);
  assert.equal(Object.hasOwn(controlDefinition.config.inputSchema, readiness.INTENT_ASSURANCE_FIELD), false);
  assert.equal(Object.hasOwn(writeDefinition.config.inputSchema, readiness.INTENT_ASSURANCE_FIELD), true);

  registry.register(readDefinition);
  registry.register(controlDefinition);

  let writes = 0;
  let writeArgs;
  const guardedWrite = registry.prepare(
    "write_file",
    { inputSchema: { path: {} }, annotations: { readOnlyHint: false } },
    async (args) => {
      writes += 1;
      writeArgs = args;
      return result("written");
    }
  );
  assert.ok(guardedWrite);
  registry.register(guardedWrite);

  let visualMutations = 0;
  const mixedVisual = registry.prepare(
    "visual_review",
    { inputSchema: { action: {}, review_id: {} }, annotations: { readOnlyHint: false } },
    async (args) => {
      if (args?.action !== "status") visualMutations += 1;
      return result(`visual-${args?.action ?? "review"}`);
    }
  );
  assert.ok(mixedVisual);
  registry.register(mixedVisual);

  const gatewayWorkspace = path.join(tempRoot, "gateway-workspace");
  await fs.mkdir(gatewayWorkspace, { recursive: true });
  const gateway = new InvocationGateway(registry, {
    workspaceRoot: gatewayWorkspace,
    projectRoots: [gatewayWorkspace],
  });

  const understanding = await buildHarnessRuntimeContext(gatewayWorkspace, undefined, "fresh-session");
  assert.equal(understanding.intent_assurance?.state, "UNDERSTANDING");

  const readResult = await gateway.invoke("read_fixture", [{ path: "x" }, requestExtra("read-session", 10)]);
  assert.equal(readResult.structuredContent.marker, "read", "read-only discovery was incorrectly gated");
  const controlResult = await gateway.invoke("goal", [{ action: "status" }, requestExtra("control-session", 11)]);
  assert.equal(controlResult.structuredContent.marker, "goal", "harness control state was incorrectly gated");
  const visualStatus = await gateway.invoke("visual_review", [{ action: "status", review_id: "r1" }, requestExtra("visual-session", 111)]);
  assert.equal(visualStatus.structuredContent.marker, "visual-status", "mixed-tool read-only action was incorrectly gated");
  const visualBlocked = await gateway.invoke("visual_review", [{ action: "critique", review_id: "r1" }, requestExtra("visual-session", 112)]);
  assert.equal(visualBlocked.structuredContent.data.error_code, "REQUIREMENT_CONTRACT_REQUIRED");
  assert.equal(visualMutations, 0);
  const visualAllowed = await gateway.invoke(
    "visual_review",
    [{ action: "critique", review_id: "r1", _intent: intentJson(model()) }, requestExtra("visual-session", 113)]
  );
  assert.equal(visualAllowed.structuredContent.marker, "visual-critique");
  assert.equal(visualMutations, 1);

  const missingIntent = await gateway.invoke("write_file", [{ path: "x" }, requestExtra("gateway-session", 12)]);
  assert.equal(missingIntent.structuredContent.ok, false);
  assert.equal(missingIntent.structuredContent.data.error_code, "REQUIREMENT_CONTRACT_REQUIRED");
  assert.equal(writes, 0);

  const notReady = intentJson(model({
    closure_items: [{ id: "scope", status: "open", materiality: "high" }],
  }));
  const notReadyResult = await gateway.invoke("write_file", [{ path: "x", _intent: notReady }, requestExtra("gateway-session", 13)]);
  assert.equal(notReadyResult.structuredContent.data.error_code, "REQUIREMENT_NOT_READY");
  assert.equal(writes, 0);

  const readyOne = intentJson(model());
  const writeResult = await gateway.invoke("write_file", [{ path: "x", _intent: readyOne }, requestExtra("gateway-session", 14)]);
  assert.equal(writeResult.structuredContent.marker, "written");
  assert.equal(writes, 1);
  assert.deepEqual(writeArgs, { path: "x" }, "_intent leaked into the actual tool handler");

  const conflictResult = await gateway.invoke(
    "write_file",
    [{ path: "x", _intent: intentJson(model({ scope: ["changed-scope"] })) }, requestExtra("gateway-session", 15)]
  );
  assert.equal(conflictResult.structuredContent.data.error_code, "INTENT_REVISION_CONFLICT");
  assert.equal(writes, 1);

  const readyTwo = intentJson(model({ intent_revision: 2, scope: ["changed-scope"] }));
  const writeRev2 = await gateway.invoke("write_file", [{ path: "x", _intent: readyTwo }, requestExtra("gateway-session", 16)]);
  assert.equal(writeRev2.structuredContent.marker, "written");
  assert.equal(writes, 2);

  const broker = await buildHarnessRuntimeContext(gatewayWorkspace, undefined, "gateway-session");
  assert.equal(broker.intent_assurance?.state, "READY");
  assert.equal(broker.intent_assurance?.intent_revision, 2);
  assert.equal(broker.intent_assurance?.readiness_score, 100);

  const instructions = buildServerInstructions(gatewayWorkspace, [gatewayWorkspace], true);
  assert.match(instructions, /Requirement readiness gate/);
  assert.match(instructions, /at most 5 high-value questions per round and at most 2 normal rounds/);
  assert.match(instructions, /reserved _intent string/);

  console.log("Requirement readiness: dynamic RRS, bounded clarification, immutable revisions, gateway admission, and broker projection passed");
} finally {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
