import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2] ? path.resolve(process.argv[2]) : repo;
const temporary = await fs.mkdtemp(path.join(repo, ".quality-feedback-test-"));
const workspace = path.join(temporary, "workspace");
const previousHome = process.env.CODEX_HOME;
const previousRelayEnabled = process.env.HARNESS_RELAY_ENABLED;
const previousRelayAutomationEnabled = process.env.HARNESS_RELAY_AUTOMATION_ENABLED;
const previousCompanionEnabled = process.env.HARNESS_COMPANION_ENABLED;
process.env.CODEX_HOME = path.join(temporary, "state");
process.env.CHATGPT_TOOL_PROFILE = "slim";
// This fixture characterizes generic Goal verification / operation evidence,
// not Relay authority. Keep it hermetic when the parent test runner itself was
// launched from a Relay-enabled production Harness.
process.env.HARNESS_RELAY_ENABLED = "false";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_ENABLED = "false";
await fs.mkdir(workspace, { recursive: true });
const load = (name) => import(pathToFileURL(path.join(source, "dist", name)).href);
const { createMcpServer } = await load("server-factory.js");
const { createGoal } = await load("lib/goals.js");
const { confirmGoalRunCriterion, transitionGoalRunLifecycle } = await load("lib/goal-run-web.js");
const { createRuntimeScope, runWithRuntimeScope } = await load("lib/runtime-scope.js");
const fixtureSessionId = "quality-feedback-fixture";
const fixtureScopeSeed = { workspaceRoot: workspace, projectRoots: [workspace] };
const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "quality-feedback-regression", version: "1" });
const [ct, st] = InMemoryTransport.createLinkedPair();
// Direct Goal helpers and SDK callbacks must share the same trusted owner.
// This identity belongs to the server transport, not to tool arguments.
st.sessionId = fixtureSessionId;
await server.connect(st);
await client.connect(ct);
const results = [];
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated quality-feedback acceptance fixtures",
  scope: ["temporary quality-feedback workspace"],
  out_of_scope: [], deliverables: ["quality feedback and Goal verification assertions"],
  success_criteria: ["isolated mutation and verification semantics remain correct"],
  constraints: [], protected_resources: [], known_facts: ["all MCP side effects are isolated under temporary"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});
const MUTATING_TOOLS = new Set(["write_file", "run_command", "start_process"]);
async function check(name, run) {
  try {
    await runWithRuntimeScope(createRuntimeScope(fixtureScopeSeed, { sessionId: fixtureSessionId }), run);
    results.push({ name, passed: true });
  }
  catch (error) { results.push({ name, passed: false, error: String(error.message ?? error) }); }
}
const call = (name, args) => client.callTool({
  name,
  arguments: MUTATING_TOOLS.has(name) ? { ...args, _intent: TEST_INTENT } : args,
});
const payload = (result) => result.structuredContent.data;
try {
  await check("oversized final line is completely recoverable", async () => {
    const original = "BEGIN" + "a".repeat(49990) + "😀" + "b".repeat(65000) + "END";
    const file = path.join(workspace, "long.svg");
    await fs.writeFile(file, original);
    let chunk = payload(await call("read_text_file", { path: file }));
    assert.equal(chunk.truncated, true, "partial final line was advertised as complete");
    let rebuilt = chunk.content;
    for (let count = 0; chunk.truncated && count < 10; count++) {
      assert.equal(chunk.next_offset, 1, "long-line continuation skipped unread characters");
      assert.ok(chunk.next_character_offset > 0);
      chunk = payload(await call("read_text_file", { path: file, offset: chunk.next_offset, character_offset: chunk.next_character_offset, limit: 1 }));
      rebuilt += chunk.content.replace(/^\s*\d+\|/, "");
    }
    assert.equal(chunk.truncated, false);
    assert.equal(rebuilt, original);
  });
  await check("requested range beyond EOF does not invent another page", async () => {
    const file = path.join(workspace, "short.txt");
    await fs.writeFile(file, "only line");
    const value = payload(await call("read_text_file", { path: file, offset: 1, limit: 1000 }));
    assert.equal(value.truncated, false);
    assert.equal(value.next_offset, null);
  });
  await check("business errors carry the MCP error flag", async () => {
    const result = await call("visual_review", { action: "status" });
    assert.equal(result.structuredContent.ok, false);
    assert.equal(result.isError, true);
  });
  await check("plain visual write declares pending review without a Goal", async () => {
    const result = payload(await call("write_file", { path: path.join(workspace, "figure.svg"), content: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50"><rect width="50" height="50"/></svg>' }));
    assert.equal(result.visual_review_required, true);
    assert.equal(result.visual_review_status, "not_reviewed_after_edit");
    assert.equal(result.visual_review_targets[0].arguments.action, "review");
  });
  await check("code acceptance rejects unrelated checks and source edits after passing tests", async () => {
    const original = "export function add(a,b){return a+b;}\n";
    await fs.writeFile(path.join(workspace, "source.mjs"), original);
    await fs.writeFile(path.join(workspace, "checks.mjs"), 'import assert from "node:assert/strict"; import {add} from "./source.mjs"; assert.equal(add(2,3),5); assert.equal(add(-2,2),0);\n');
    const other = path.join(temporary, "unrelated");
    await fs.mkdir(other);
    await fs.writeFile(path.join(other, "checks.mjs"), 'console.log("unrelated success");\n');
    const criterion = "Addition handles positive and negative inputs";
    await createGoal(workspace, { objective: "Verify the requested implementation", success_criteria: [{ name: criterion, passed: false, verification: { kind: "command", target: workspace, command: "node checks.mjs", files: ["source.mjs", "checks.mjs"] } }] });
    const unrelated = payload(await call("run_command", { command: "node checks.mjs", working_directory: other }));
    assert.equal(unrelated.exit_code, 0);
    await assert.rejects(confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [unrelated.goal_run_evidence.id] }), /GOAL_VERIFICATION_MISMATCH/);
    let checked = payload(await call("run_command", { command: "node checks.mjs", working_directory: workspace }));
    assert.equal(checked.exit_code, 0);
    await confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [checked.goal_run_evidence.id] });
    await fs.writeFile(path.join(workspace, "source.mjs"), "export function add(a,b){return a-b;}\n");
    await assert.rejects(transitionGoalRunLifecycle(workspace, "complete"), /GOAL_VERIFICATION_MISMATCH/);
    const failed = payload(await call("run_command", { command: "node checks.mjs", working_directory: workspace }));
    assert.notEqual(failed.exit_code, 0);
    await assert.rejects(confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [failed.goal_run_evidence.id] }), /GOAL_VERIFICATION_MISMATCH/);
    await fs.writeFile(path.join(workspace, "source.mjs"), original);
    checked = payload(await call("run_command", { command: "node checks.mjs", working_directory: workspace }));
    await confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [checked.goal_run_evidence.id] });
    assert.equal((await transitionGoalRunLifecycle(workspace, "complete")).goal.status, "completed");
  });
  await check("completed background results cannot be replayed against edited sources", async () => {
    const sourceFile = path.join(workspace, "background-source.txt");
    await fs.writeFile(sourceFile, "expected");
    await fs.writeFile(path.join(workspace, "background-check.mjs"), 'import fs from "node:fs"; import assert from "node:assert/strict"; assert.equal(fs.readFileSync("background-source.txt","utf8"),"expected");');
    const criterion = "Background check validates current source";
    await createGoal(workspace, { objective: criterion, success_criteria: [{ name: criterion, passed: false, verification: { kind: "command", target: workspace, command: "node background-check.mjs", files: ["background-source.txt", "background-check.mjs"] } }] });
    const started = payload(await call("start_process", { command: "node background-check.mjs", working_directory: workspace }));
    let observed;
    const deadline = Date.now() + 15_000;
    while (true) {
      observed = payload(await call("process_output", { id: started.id }));
      if (!observed.running) break;
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(observed.running, false);
    assert.equal(observed.exit_code, 0);
    await confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [observed.goal_run_evidence.id] });
    await fs.writeFile(sourceFile, "changed after completion");
    for (const tool of ["process_output", "process_status"]) {
      const replay = payload(await call(tool, { id: started.id }));
      await assert.rejects(confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [replay.goal_run_evidence.id] }), /GOAL_VERIFICATION_MISMATCH/);
    }
    await assert.rejects(transitionGoalRunLifecycle(workspace, "complete"), /GOAL_VERIFICATION_MISMATCH/);
  });
  await check("legacy criteria recover by declaring a check without discarding the goal", async () => {
    // The preceding stale-background case deliberately leaves an active goal.
    await transitionGoalRunLifecycle(workspace, "cancel");
    const file = path.join(workspace, "legacy-proof.txt");
    await fs.writeFile(file, "migration fixture");
    const criterion = "Proof file exists";
    const created = await createGoal(workspace, { objective: "Recover a legacy acceptance contract", success_criteria: [{ name: criterion, passed: false }] });
    const before = payload(await call("file_info", { path: file, sha256: true }));
    await assert.rejects(confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [before.goal_run_evidence.id] }), /GOAL_VERIFICATION_REQUIRED/);
    const updated = await call("goal", { action: "update", success_criteria: [{ name: criterion, verification: { kind: "file_exists", target: file } }] });
    assert.equal(updated.structuredContent.ok, true, JSON.stringify(updated.structuredContent));
    assert.equal(payload(updated).goal.id, created.id);
    const verified = payload(await call("file_info", { path: file, sha256: true }));
    await confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [verified.goal_run_evidence.id] });
    assert.equal((await transitionGoalRunLifecycle(workspace, "complete")).goal.status, "completed");
  });
  await check("a successful command cannot verify inputs it changed during execution", async () => {
    await fs.writeFile(path.join(workspace, "changing-source.txt"), "before");
    await fs.writeFile(path.join(workspace, "changing-check.mjs"), 'import fs from "node:fs"; fs.writeFileSync("changing-source.txt","after");');
    const criterion = "Check current immutable inputs";
    await createGoal(workspace, { objective: criterion, success_criteria: [{ name: criterion, verification: { kind: "command", target: workspace, command: "node changing-check.mjs", files: ["changing-source.txt", "changing-check.mjs"] } }] });
    const observed = payload(await call("run_command", { command: "node changing-check.mjs", working_directory: workspace }));
    assert.equal(observed.exit_code, 0);
    assert.equal(await fs.readFile(path.join(workspace, "changing-source.txt"), "utf8"), "after");
    await assert.rejects(confirmGoalRunCriterion(workspace, { criterion, evidenceIds: [observed.goal_run_evidence.id] }), /GOAL_VERIFICATION_MISMATCH/);
  });
  console.log(JSON.stringify({ source, results }, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
  await client.close();
  await server.close();
  // The only recursively removed directory is the absolute mkdtemp result above.
  if (!temporary.startsWith(path.join(repo, ".quality-feedback-test-"))) throw new Error("Unsafe fixture path");
  await fs.rm(temporary, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousRelayEnabled === undefined) delete process.env.HARNESS_RELAY_ENABLED;
  else process.env.HARNESS_RELAY_ENABLED = previousRelayEnabled;
  if (previousRelayAutomationEnabled === undefined) delete process.env.HARNESS_RELAY_AUTOMATION_ENABLED;
  else process.env.HARNESS_RELAY_AUTOMATION_ENABLED = previousRelayAutomationEnabled;
  if (previousCompanionEnabled === undefined) delete process.env.HARNESS_COMPANION_ENABLED;
  else process.env.HARNESS_COMPANION_ENABLED = previousCompanionEnabled;
}
