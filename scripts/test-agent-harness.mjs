import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertToolsListBudget } from "./lib/tools-list-budget.mjs";

process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.READ_TEXT_MAX_FILE_BYTES = "200000";
// This fixture exercises the generic agent/tool harness, not Relay authority.
// Keep it hermetic when invoked from a Relay-enabled production Harness so an
// inherited HARNESS_RELAY_ENABLED cannot turn its deliberately ownerless Goal
// fixtures into DRIVER_GOAL_UNBOUND failures.
process.env.HARNESS_RELAY_ENABLED = "false";
process.env.HARNESS_RELAY_AUTOMATION_ENABLED = "false";
process.env.HARNESS_COMPANION_ENABLED = "false";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = path.join(repoRoot, ".tool-test-tmp", "agent-harness");
const workspace = path.join(tmpRoot, "workspace");
const pluginConfigPath = path.join(tmpRoot, "plugins.json");
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
process.env.CHATGPT_PLUGINS_CONFIG = pluginConfigPath;
const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated agent-harness integration fixtures",
  scope: ["temporary agent-harness workspaces and owned task fixtures"],
  out_of_scope: [], deliverables: ["Goal, task, file, command, and process integration assertions"],
  success_criteria: ["all isolated harness integration behaviors remain deterministic"],
  constraints: [], protected_resources: [], known_facts: ["all side effects are confined to tmpRoot"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(pluginConfigPath, JSON.stringify({
  schema_version: 2,
  computer_use: { enabled: false },
  browser_use: { enabled: false },
  skills: [],
}), "utf8");
await fs.writeFile(
  path.join(workspace, "sample.test.mjs"),
  'import test from "node:test"; import assert from "node:assert/strict"; test("ok",()=>assert.equal(2+2,4));\n'
);
await fs.writeFile(
  path.join(workspace, "background.mjs"),
  'console.log("background-start"); setTimeout(()=>{ console.log("background-done"); }, 80);\n'
);
await fs.writeFile(
  path.join(workspace, "large.txt"),
  Array.from({ length: 2_000 }, (_, index) => `${String(index + 1).padStart(4, "0")}:${"x".repeat(60)}`).join("\n"),
  "utf-8"
);
await fs.writeFile(path.join(workspace, "too-large.txt"), Buffer.alloc(210_000, 0x78));
const manyDir = path.join(workspace, "many");
await fs.mkdir(manyDir, { recursive: true });
await Promise.all(Array.from({ length: 510 }, (_, index) => fs.writeFile(path.join(manyDir, `${String(index).padStart(4, "0")}.txt`), "x")));

const { createMcpServer } = await import("../dist/server-factory.js");
const server = createMcpServer(workspace, 30_000, [workspace], true);
const client = new Client({ name: "agent-harness-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

function data(result) {
  if (!result?.structuredContent?.ok) {
    throw new Error(`tool failed: ${JSON.stringify(result?.structuredContent)}`);
  }
  return result.structuredContent.data;
}

try {
  const listed = await client.listTools();
  if (listed.tools.length !== 34) throw new Error(`expected 34 slim tools, got ${listed.tools.length}`);
  if (!listed.tools.some((tool) => tool.name === "recovery_submit") || !listed.tools.some((tool) => tool.name === "recovery_status")) {
    throw new Error("native durable recovery tools missing from slim ChatGPT Web profile");
  }
  if (listed.tools.some((tool) => tool.outputSchema)) throw new Error("slim repeated outputSchema");
  const toolsListBudget = assertToolsListBudget(listed, { label: "agent-harness slim tools/list" });

  const largeRead = data(await client.callTool({
    name: "read_text_file",
    arguments: { path: path.join(workspace, "large.txt") },
  }));
  if (!largeRead.truncated || !largeRead.next_offset || largeRead.content.length > 50_000) {
    throw new Error(`large read was not bounded: ${JSON.stringify({ truncated: largeRead.truncated, next_offset: largeRead.next_offset, chars: largeRead.content.length })}`);
  }
  const largeListing = data(await client.callTool({ name: "list_directory", arguments: { path: manyDir } }));
  if (!largeListing.truncated || largeListing.count !== 500 || largeListing.omitted_entries !== 10) {
    throw new Error(`large directory listing was not bounded: ${JSON.stringify(largeListing)}`);
  }
  const tooLarge = await client.callTool({
    name: "read_text_file",
    arguments: { path: path.join(workspace, "too-large.txt") },
  });
  const tooLargeText = JSON.stringify(tooLarge);
  const tooLargeRejected = tooLarge.isError === true || tooLarge.structuredContent?.ok === false;
  if (!tooLargeRejected || !tooLargeText.includes("READ_TEXT_MAX_FILE_BYTES")) {
    throw new Error(`oversized text file was not rejected safely: ${JSON.stringify(tooLarge.structuredContent)}`);
  }

  const createdGoal = data(await client.callTool({
    name: "goal",
    arguments: {
      action: "create",
      objective: "Verify Goal and Task records preserve evidence",
      success_criteria: [{ name: "tests pass", passed: false, verification: { kind: "command", target: workspace, command: "node --test", files: ["sample.test.mjs"] } }],
      current_phase: "Run harness checks",
    },
  }));
  if (createdGoal.goal?.status !== "active" || createdGoal.goal.success_criteria[0]?.passed !== false) {
    throw new Error("goal creation did not preserve its active state and unverified criterion");
  }
  // Create a Task while the Goal is active and verify each record separately.
  const created = data(await client.callTool({
    name: "task_state",
    arguments: {
      action: "create",
      goal: "Verify compact task tracking and command evidence",
      current_step: "Create fixture",
      blocking_checks: [{ name: "tests pass", passed: false }],
      next_actions: ["Run tests", "Inspect background process"],
    },
  }));
  const taskId = created.handoff.task_id;

  const generatedPath = path.join(workspace, "generated.txt");
  const writeResult = await client.callTool({ name: "write_file", arguments: { path: generatedPath, content: "tracked\n", _intent: TEST_INTENT } });
  data(writeResult);
  if (!JSON.stringify(writeResult.content).includes("ACTIVE GOAL")) {
    throw new Error("active goal snapshot was not appended to tool result");
  }
  if (!writeResult.structuredContent?.data?.harness_context?.goal?.goal_id) {
    throw new Error("active goal was not appended to structured harness context");
  }

  const tested = data(await client.callTool({
    name: "run_command",
    arguments: { command: "node --test", working_directory: workspace, _intent: TEST_INTENT },
  }));
  if (tested.exit_code !== 0 || tested.command_kind !== "test" || tested.outcome !== "passed") {
    throw new Error(`unexpected test observation: ${JSON.stringify(tested)}`);
  }
  if (!tested.full_output_path) throw new Error("run_command full_output_path missing");
  await fs.stat(tested.full_output_path);
  const testEvidenceId = tested.goal_run_evidence?.id;
  if (!testEvidenceId || tested.goal_run_evidence.verifies_criterion !== true) {
    throw new Error(`run_command did not expose successful GoalRun evidence: ${JSON.stringify(tested.goal_run_evidence)}`);
  }

  const started = data(await client.callTool({
    name: "start_process",
    arguments: { command: "node background.mjs", working_directory: workspace, _intent: TEST_INTENT },
  }));
  if (!started.full_output_path) throw new Error("start_process full_output_path missing");

  let status;
  for (let attempt = 0; attempt < 80; attempt++) {
    status = data(await client.callTool({ name: "process_status", arguments: { id: started.id } }));
    if (!status.processes[0]?.running) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (status?.processes[0]?.running) throw new Error("background process did not finish");
  const output = data(await client.callTool({
    name: "process_output",
    arguments: { id: started.id, output_mode: "compact" },
  }));
  if (!output.stdout.includes("background-done")) throw new Error("background output missing completion marker");
  await fs.stat(output.full_output_path);

  const resumed = data(await client.callTool({ name: "task_state", arguments: { action: "resume", task_id: taskId } }));
  if (!resumed.handoff.changed_files.some((file) => file.endsWith("generated.txt"))) {
    throw new Error("task did not auto-record changed file");
  }
  if (!resumed.handoff.observed_checks.some((check) => check.name === "tests" && check.passed)) {
    throw new Error("task did not auto-record passing tests");
  }

  const checkpointed = data(await client.callTool({
    name: "task_state",
    arguments: {
      action: "checkpoint",
      task_id: taskId,
      current_step: "Ready to deliver",
      done: ["Created fixture", "Ran tests", "Inspected background process"],
      blocking_checks: [{ name: "tests pass", passed: true, detail: "node --test passed" }],
      next_actions: [],
    },
  }));
  if (checkpointed.handoff?.current_step !== "Ready to deliver") {
    throw new Error("checkpoint did not preserve the current step");
  }

  data(await client.callTool({
    name: "goal",
    arguments: {
      action: "update",
      current_phase: "Finish delivery",
    },
  }));

  data(await client.callTool({
    name: "goal",
    arguments: {
      action: "confirm",
      criterion: "tests pass",
      evidence_ids: [testEvidenceId],
    },
  }));

  const completed = data(await client.callTool({
    name: "task_state",
    arguments: { action: "complete", task_id: taskId, note: "Harness integration passed" },
  }));
  if (completed.deliverable_ready !== false || completed.completion_status !== "model_declared" ||
      completed.handoff.status !== "completed" || completed.goal_still_active !== true) {
    throw new Error("Task completion must be recorded as model-declared while preserving the separate active Goal: " + JSON.stringify(completed));
  }
  data(await client.callTool({ name: "goal", arguments: { action: "complete" } }));

  let resumeFailed = false;
  const afterComplete = await client.callTool({ name: "task_state", arguments: { action: "resume" } });
  resumeFailed = afterComplete.structuredContent?.ok === false;
  if (!resumeFailed) throw new Error("completed task remained active");

  // Full-profile Task APIs must apply the same current-session ownership
  // check as the compact task_state surface. This fixture also exercises the
  // result pipeline's observation/context projection for foreign/no-session
  // calls without exposing the owner's task or evidence.
  const previousProfile = process.env.CHATGPT_TOOL_PROFILE;
  const taskApiWorkspace = path.join(tmpRoot, "task-api-workspace");
  await fs.mkdir(taskApiWorkspace, { recursive: true });
  let taskApiServer;
  let taskApiClient;
  try {
    process.env.CHATGPT_TOOL_PROFILE = "full";
    taskApiServer = createMcpServer(taskApiWorkspace, 30_000, [taskApiWorkspace], true);
    taskApiClient = new Client({ name: "task-session-ownership-test", version: "1" });
    const [taskApiClientTransport, taskApiServerTransport] = InMemoryTransport.createLinkedPair();
    await taskApiServer.connect(taskApiServerTransport);
    await taskApiClient.connect(taskApiClientTransport);
    taskApiServerTransport.sessionId = "transport-owner-A";

    const owned = data(await taskApiClient.callTool({
      name: "task_create",
      arguments: {
        goal: "Verify full Task API ownership",
        current_step: "Keep private state isolated",
        blocking_checks: [{ name: "owner check", passed: true }],
        notes: ["PRIVATE TASK NOTE"],
        _intent: TEST_INTENT,
      },
    }));
    const ownedTaskId = owned.task_id;
    if (!ownedTaskId) throw new Error("Task ownership fixture did not create a task");

    taskApiServerTransport.sessionId = "foreign-B";
    const foreignStatus = await taskApiClient.callTool({ name: "task_status", arguments: { task_id: ownedTaskId } });
    if (foreignStatus.structuredContent?.ok !== false || JSON.stringify(foreignStatus).includes("PRIVATE TASK NOTE")) {
      throw new Error("foreign task_status read was not rejected without leaking task state");
    }
    const foreignUpdate = await taskApiClient.callTool({
      name: "task_update",
      arguments: { task_id: ownedTaskId, current_step: "FOREIGN MUTATION", _intent: TEST_INTENT },
    });
    if (foreignUpdate.structuredContent?.ok !== false) throw new Error("foreign task_update mutation was accepted");
    const foreignComplete = await taskApiClient.callTool({ name: "task_complete", arguments: { task_id: ownedTaskId, _intent: TEST_INTENT } });
    if (foreignComplete.structuredContent?.ok !== false) throw new Error("foreign task_complete mutation was accepted");
    const foreignList = data(await taskApiClient.callTool({ name: "task_list", arguments: {} }));
    if (foreignList.tasks.some((task) => task.id === ownedTaskId || task.task_id === ownedTaskId)) {
      throw new Error("foreign task_list exposed an owned task");
    }

    const foreignWrite = await taskApiClient.callTool({
      name: "write_file",
      arguments: { path: path.join(taskApiWorkspace, "foreign-write.txt"), content: "foreign\n", _intent: TEST_INTENT },
    });
    data(foreignWrite);
    const foreignContext = foreignWrite.structuredContent?.data?.harness_context;
    if (foreignContext?.task || (foreignContext?.recent_evidence?.length ?? 0) > 0) {
      throw new Error("foreign result pipeline leaked the owner's task or evidence");
    }

    taskApiServerTransport.sessionId = undefined;
    const noSessionStatus = await taskApiClient.callTool({ name: "task_status", arguments: { task_id: ownedTaskId } });
    if (noSessionStatus.structuredContent?.ok !== false) throw new Error("no-session task_status read was accepted");
    const noSessionUpdate = await taskApiClient.callTool({
      name: "task_update",
      arguments: { task_id: ownedTaskId, current_step: "NO SESSION MUTATION", _intent: TEST_INTENT },
    });
    if (noSessionUpdate.structuredContent?.ok !== false) throw new Error("no-session task_update mutation was accepted");
    const noSessionComplete = await taskApiClient.callTool({ name: "task_complete", arguments: { task_id: ownedTaskId, _intent: TEST_INTENT } });
    if (noSessionComplete.structuredContent?.ok !== false) throw new Error("no-session task_complete mutation was accepted");
    const noSessionList = data(await taskApiClient.callTool({ name: "task_list", arguments: {} }));
    if (noSessionList.tasks.some((task) => task.id === ownedTaskId || task.task_id === ownedTaskId)) {
      throw new Error("no-session task_list exposed an owned task");
    }

    taskApiServerTransport.sessionId = "transport-owner-A";
    const ownerStatus = data(await taskApiClient.callTool({ name: "task_status", arguments: { task_id: ownedTaskId } }));
    if (ownerStatus.task.current_step !== "Keep private state isolated" || ownerStatus.task.notes[0] !== "PRIVATE TASK NOTE") {
      throw new Error("foreign/no-session Task API calls mutated the owner task");
    }
    if (ownerStatus.task.recent_events.some((event) => event.paths?.some((item) => item.endsWith("foreign-write.txt")))) {
      throw new Error("foreign observation was recorded on the owner task");
    }
  } finally {
    await taskApiClient?.close().catch(() => {});
    await taskApiServer?.close().catch(() => {});
    if (previousProfile === undefined) delete process.env.CHATGPT_TOOL_PROFILE;
    else process.env.CHATGPT_TOOL_PROFILE = previousProfile;
  }

  console.log(`agent-harness: ${toolsListBudget.toolCount}-tool slim (${toolsListBudget.bytes} bytes), Goal Mode, compact task tracking, durable process input, automatic observations, command logs, and background logs OK`);
} finally {
  await client.close().catch(() => {});
  await server.close().catch(() => {});
  // Windows can briefly report ENOTEMPTY while recently closed MCP state/log
  // handles are finishing their final flush. fs.rm's bounded retry policy is
  // specifically designed for this recursive-cleanup race; it does not mask
  // persistent cleanup failures because the promise still rejects after the
  // retry budget is exhausted.
  await fs.rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
