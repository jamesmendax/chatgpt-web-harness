import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// A separate MCP instance and temporary account; never connects to the running desktop runtime.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] || path.join(repo, "dist"));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-error-feedback-"));
const workspace = path.join(temp, "workspace");
await fs.mkdir(workspace, { recursive: true });
process.env.CODEX_HOME = path.join(temp, "state");
process.env.AUDIT_LOG_PATH = path.join(temp, "audit.jsonl");
process.env.HARNESS_ACCOUNT_ID = "isolated-error-feedback-fixture";
process.env.CHATGPT_TOOL_PROFILE = "slim";
const load = file => import(pathToFileURL(path.join(dist, file)).href);
const { createMcpServer } = await load("server-factory.js");
const { toolFailureDiagnostic, toolDiagnosticTokens, redactSensitiveText } = await load("lib/tool-diagnostics.js");
const { observeMcpToolResult, consumeMcpOutcome } = await load("lib/mcp-outcome.js");
const { getRecentActivity, logMcpRequest } = await load("lib/activity-log.js");
const { saveVisualReviewRecord, getVisualReviewRecord } = await load("lib/visual-review-state.js");
const { visualActionInputGuide } = await load("lib/visual-feedback.js");
const server = createMcpServer(workspace, 30000, [workspace], false);
const client = new Client({ name: "isolated-error-feedback-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const savedConsole = { log: console.log, warn: console.warn };
const lines = [];
console.log = (...values) => lines.push(values.join(" "));
console.warn = console.log;
const intent = {
  intent_revision: 1, objective: "Exercise isolated tool admission and error recovery fixtures",
  scope: ["temporary fixture workspace only"], success_criteria: ["missing inputs never execute commands and corrected calls complete"],
  out_of_scope: ["live runtime, user data and services"], deliverables: ["focused fixture assertions"],
  constraints: ["all mutations stay in the temporary test workspace"], protected_resources: [],
  known_facts: ["the test owns the temporary workspace"], assumptions: [], delegated_decisions: [],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [], clarification_round: 0,
  questions_in_round: 0, resolution_mode: "none"
};
const call = (name, args) => client.callTool({ name, arguments: args });
const okData = result => {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent || result));
  return result.structuredContent.data;
};
try {
  const catalog = await client.listTools();
  const schema = name => catalog.tools.find(tool => tool.name === name).inputSchema.properties;
  assert.match(schema("list_skills").max_bytes.description, /2000.20000/);
  assert.match(schema("grep").context_after.description, /0.20/);
  assert.match(schema("visual_review").review_id.description, /status\/critique\/assess/);
  assert.match(schema("visual_review").further_improvement_worthwhile.description, /passing assess/);
  assert.match(schema("run_command")._intent.description, /intent_revision/);

  const args = { command: "node -e \"require('node:fs').appendFileSync('executed.txt','x')\"", working_directory: workspace };
  const marker = path.join(workspace, "executed.txt");
  const blocked = await call("run_command", args);
  assert.equal(blocked.structuredContent.data.error_code, "REQUIREMENT_CONTRACT_REQUIRED");
  assert.equal(blocked.structuredContent.data.outcome_kind, "needs_input");
  assert.equal(blocked.structuredContent.data.operation_started, false);
  assert.equal(blocked.structuredContent.data.retry_policy, "retry_with_changed_args");
  assert.ok(blocked.structuredContent.data.required_intent_fields.includes("scope"));
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });

  const first = await call("run_command", { ...args, _intent: JSON.stringify(intent) });
  assert.equal(okData(first).exit_code, 0);
  assert.equal(await fs.readFile(marker, "utf8"), "x");
  const reference = first._meta?.["harness/intent_reference"]?.reference;
  assert.ok(reference, "a scoped first admission must return its compact reference");

  const conflict = await call("run_command", { ...args, _intent: JSON.stringify({ ...intent, objective: intent.objective + " (rephrased)" }) });
  const conflictData = conflict.structuredContent.data;
  assert.equal(conflictData.error_code, "INTENT_REVISION_CONFLICT");
  assert.equal(conflictData.operation_started, false);
  assert.deepEqual(conflictData.accepted_intent_reference.reference, reference);
  assert.match(conflictData.next_action, /material change/);
  assert.doesNotMatch(JSON.stringify(conflictData.accepted_intent_reference), /objective|canonical_requirement_json|scope_binding/);
  assert.equal(await fs.readFile(marker, "utf8"), "x");
  const compact = JSON.stringify({ reference: conflictData.accepted_intent_reference.reference });
  assert.equal(okData(await call("run_command", { ...args, _intent: compact })).exit_code, 0);
  assert.equal(await fs.readFile(marker, "utf8"), "xx", "rejected calls never ran and the corrected call ran exactly once");
  if (process.platform === "win32") {
    const desktop = okData(await call("run_command", { command: "[Environment]::GetFolderPath('Desktop')", working_directory: workspace, _intent: compact }));
    assert.equal(desktop.exit_code, 0);
    assert.ok(desktop.stdout.trim(), "the screenshot's exact PowerShell expression works after valid admission");
  }
  const executionFailure = await call("run_command", { command: "node -e \"process.exit(7)\"", working_directory: workspace, _intent: compact });
  assert.equal(executionFailure.structuredContent.ok, false);
  assert.equal(executionFailure.structuredContent.data.error_code, "COMMAND_EXIT_NONZERO");
  assert.equal(executionFailure.structuredContent.data.operation_started, true);
  assert.equal(toolFailureDiagnostic(executionFailure).outcome_kind, "execution_error");

  // Synthetic state tests the contract only; these scores are not visual approval of any user artifact.
  const review = await saveVisualReviewRecord(workspace, {
    target: "synthetic-contract-fixture", kind: "image", renderer: "synthetic-contract-fixture",
    quality_bar: "polished", output_paths: [], page_paths: [], focus_paths: [],
    machine_blocking_issues: [], machine_advisories: [], diagnostics: { synthetic_fixture: true }
  });
  const status = okData(await call("visual_review", { action: "status", review_id: review.id }));
  assert.equal(status.quality_requirements.minimum_each_score, 4);
  assert.equal(status.quality_requirements.minimum_average_score, 4.2);
  assert.equal(status.next_action.quality_requirements.minimum_professional_readiness, 4.25);
  const missing = await call("visual_review", { action: "critique", review_id: review.id, _intent: compact });
  assert.equal(missing.structuredContent.data.error_code, "VISUAL_INPUT_REQUIRED");
  assert.ok(missing.structuredContent.data.missing_or_invalid_fields.includes("first_impression"));
  assert.ok(missing.structuredContent.data.missing_or_invalid_fields.includes("quality_scores (all six dimensions)"));
  assert.ok(missing.structuredContent.data.missing_or_invalid_fields.includes("further_improvement_worthwhile"));
  assert.equal((await getVisualReviewRecord(workspace, review.id)).model_visual_critique, undefined);
  const scores = Object.fromEntries(["task_fidelity", "composition", "visual_hierarchy", "coherence", "craft_precision", "professional_readiness"].map(key => [key, 4]));
  const critique = { action: "critique", review_id: review.id, inspected_full_render: true, first_impression: "polished",
    delivery_recommendation: "accept", quality_scores: scores, further_improvement_worthwhile: true,
    improvement_opportunities: ["Synthetic fixture does not meet the locked readiness threshold"], _intent: compact };
  const inconsistent = await call("visual_review", critique);
  assert.equal(inconsistent.structuredContent.data.error_code, "VISUAL_CRITIQUE_CONTRADICTION");
  assert.equal(inconsistent.structuredContent.data.outcome_kind, "review_rejected");
  assert.match(inconsistent.structuredContent.data.error, /4.25/);
  assert.equal((await getVisualReviewRecord(workspace, review.id)).model_visual_critique, undefined);
  okData(await call("visual_review", { ...critique, delivery_recommendation: "revise" }));
  assert.deepEqual((await getVisualReviewRecord(workspace, review.id)).model_visual_critique.quality_scores, scores, "correction changes recommendation, never inflates scores");
  const incompleteAssess = await call("visual_review", { action: "assess", review_id: review.id, verdict: "pass", inspected_full_render: true, _intent: compact });
  assert.equal(incompleteAssess.structuredContent.data.error_code, "VISUAL_INPUT_REQUIRED");
  assert.ok(incompleteAssess.structuredContent.data.missing_or_invalid_fields.includes("further_improvement_worthwhile"));
  const failedAssessment = okData(await call("visual_review", { action: "assess", review_id: review.id, verdict: "fail", inspected_full_render: true, issues: ["Synthetic fixture remains below the locked quality bar"], _intent: compact }));
  assert.equal(failedAssessment.delivery_ready, false);
  const unknownReview = await call("visual_review", { action: "status", review_id: "11111111-1111-1111-1111-111111111111" });
  assert.equal(unknownReview.structuredContent.data.error_code, "VISUAL_REVIEW_NOT_FOUND");
  assert.equal(unknownReview.structuredContent.data.outcome_kind, "needs_input");
  const guide = visualActionInputGuide("assess", { comparison_path: "synthetic-comparison", model_visual_critique: { further_improvement_worthwhile: true } });
  assert.ok(guide.supply_after_inspection.includes("further_improvement_worthwhile"));
  assert.ok(guide.supply_after_inspection.includes("comparison"));
  assert.match(guide.comparison_requirement, /Comparison pixels are present/);
  assert.equal(guide.critique_further_improvement_worthwhile, true);

  const sensitive = {
    isError: true, content: [{ type: "text", text: "RAW_RESULT_SENTINEL" }],
    structuredContent: { ok: false, data: { error: 'FIXTURE_ERROR: API_KEY="SECRET_KEY_SENTINEL" token: SECRET_TOKEN_SENTINEL\nBearer SECRET_BEARER_SENTINEL',
      error_code: "FIXTURE_ERROR", outcome_kind: "needs_input", failure_phase: "validation", operation_started: false,
      retry_policy: "retry_with_changed_args", raw_args: "RAW_ARGS_SENTINEL", stdout: "RAW_STDOUT_SENTINEL" } }
  };
  observeMcpToolResult({ requestId: "diagnostic-test", tool: "fixture", invocationId: "fixture-call", result: sensitive });
  const observed = consumeMcpOutcome("diagnostic-test", "fixture");
  assert.equal(observed.rpc_result_status, "success");
  assert.equal(observed.tool_result_status, "error");
  assert.equal(observed.client_delivery, "unknown");
  assert.doesNotMatch(JSON.stringify(observed), /SECRET_.*_SENTINEL|RAW_.*_SENTINEL/);
  assert.match(toolDiagnosticTokens(observed.failure), /outcome=needs_input.*started=false/);
  assert.equal(redactSensitiveText('{"password":"SECRET_PASSWORD_SENTINEL"}'), '{"password":[REDACTED]}');
  logMcpRequest({ method: "tools/call", params: { name: "fixture", arguments: {} } }, "fixture-session", 1, 200, undefined, observed);
  const logged = getRecentActivity(1)[0];
  assert.equal(logged.status, "error");
  assert.equal(logged.details.outcome_kind, "needs_input");
  assert.equal(logged.details.operation_started, false);
  assert.match(lines.at(-1), /outcome=needs_input code=FIXTURE_ERROR phase=validation started=false retry=retry_with_changed_args call=fixture-call/);
  assert.doesNotMatch(JSON.stringify(logged), /SECRET_.*_SENTINEL|RAW_.*_SENTINEL/);
  const canonical = getRecentActivity(500).find(entry => entry.details?.canonical_lifecycle && entry.details?.error_code === "COMMAND_EXIT_NONZERO");
  assert.equal(canonical?.details?.outcome_kind, "execution_error");
  assert.equal(canonical?.details?.operation_started, true);
} finally {
  Object.assign(console, savedConsole);
  await client.close();
  await server.close();
  await fs.rm(temp, { recursive: true, force: true });
}
console.log("Tool error feedback: real MCP invalid→corrected admission, scoped conflict recovery, PowerShell probe, execution errors, visual contracts, locked thresholds and safe diagnostic transport passed");
