/**
 * F0 characterization: freeze the current MCP surface before F1 refactoring.
 *
 * This test intentionally exercises the built server through an MCP client and
 * keeps every fixture and runtime side effect below .tool-test-tmp.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { assertToolsListBudget } from "./lib/tools-list-budget.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const toolTestRoot = path.join(repoRoot, ".tool-test-tmp");
await fs.mkdir(toolTestRoot, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(toolTestRoot, "f0-characterization-"));
const pluginConfigPath = path.join(tempRoot, "plugins.json");
const originalCwd = process.cwd();
const environmentNames = [
  "CHATGPT_TOOL_PROFILE",
  "CHATGPT_PLUGINS_CONFIG",
  "CODEX_HOME",
  "AUDIT_LOG_PATH",
  "MCP_SHELL_STATE_DIR",
  "MCP_UPSTREAM_CONFIG",
];
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
const configuredServers = new Set();

const EXPECTED_SLIM_TOOLS = [
  "read_text_file",
  "read_file_base64",
  "file_info",
  "write_file",
  "write_file_base64",
  "save_chatgpt_file",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "run_command",
  "start_process",
  "process_status",
  "process_output",
  "process_input",
  "stop_process",
  "git_status",
  "git_diff",
  "agent_status",
  "project_context",
  "code_intelligence",
  "remember",
  "route_skills",
  "list_skills",
  "load_skill",
  "install_skill",
  "uninstall_skill",
  "set_skill_enabled",
  "goal",
  "task_state",
  "visual_review",
  "rewind",
  "recovery_submit",
  "recovery_status",
];

const EXPECTED_NATIVE_TOOLS = [
  "read_text_file",
  "read_file_base64",
  "file_info",
  "write_file",
  "write_file_base64",
  "save_chatgpt_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "directory_tree",
  "search_files",
  "create_directory",
  "delete_file",
  "delete_directory",
  "copy_file",
  "move_file",
  "replace_regex",
  "list_allowed_directories",
  "run_command",
  "shell_status",
  "shell_reset",
  "start_process",
  "process_status",
  "process_output",
  "process_input",
  "stop_process",
  "clear_processes",
  "node_repl",
  "ponytail_turn",
  "open_image",
  "render_svg",
  "capture_webpage",
  "visual_review",
  "goal",
  "task_state",
  "task_create",
  "task_status",
  "task_update",
  "task_complete",
  "task_list",
  "browser_open",
  "browser_action",
  "browser_close",
  "git_status",
  "git_diff",
  "git_log",
  "git_add",
  "git_commit",
  "git_branch",
  "git_checkout",
  "git_restore",
  "git_stash",
  "git_reset",
  "git_pull",
  "git_push",
  "agent_status",
  "project_context",
  "code_intelligence",
  "remember",
  "load_path_rules",
  "route_skills",
  "list_skills",
  "load_skill",
  "install_skill",
  "uninstall_skill",
  "set_skill_enabled",
  "rewind",
  "mcp_servers",
  "mcp_tools",
  "mcp_call",
  "recovery_submit",
  "recovery_status",
];

function configureEnvironment() {
  process.chdir(repoRoot);
  process.env.CHATGPT_PLUGINS_CONFIG = pluginConfigPath;
  process.env.CODEX_HOME = path.join(tempRoot, "codex-home");
  process.env.AUDIT_LOG_PATH = path.join(tempRoot, "audit.log");
  process.env.MCP_SHELL_STATE_DIR = path.join(tempRoot, "shell-state");
  process.env.MCP_UPSTREAM_CONFIG = path.join(tempRoot, "upstream.json");
}

async function makeWorkspace(name) {
  const workspace = path.join(tempRoot, name);
  await fs.mkdir(workspace, { recursive: true });
  return workspace;
}

function emptyUpstreamManager(McpUpstreamManager) {
  return new McpUpstreamManager(path.join(tempRoot, "empty-upstream.json"));
}

/**
 * Test-local configured server factory. The production tree currently exports
 * createMcpServer; this wrapper makes profile selection and the in-memory MCP
 * transport explicit at every characterization call site.
 */
async function createConfiguredServer(createMcpServer, profile, workspaceRoot, upstreamManager) {
  process.env.CHATGPT_TOOL_PROFILE = profile;
  const server = createMcpServer(workspaceRoot, 30_000, [workspaceRoot], true, upstreamManager);
  const client = new Client({ name: `f0-characterization-${profile}`, version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  assert.equal(serverTransport.sessionId, undefined, "F0 must retain anonymous transport coverage");

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  } catch (error) {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    throw error;
  }

  const configured = { client, server };
  configuredServers.add(configured);
  return configured;
}

async function closeConfiguredServer(configured) {
  configuredServers.delete(configured);
  await configured.client.close().catch(() => {});
  await configured.server.close().catch(() => {});
}

function assertCatalog(listed, expected, label) {
  const names = listed.tools.map((tool) => tool.name);
  assert.equal(names.length, expected.length, `${label} tool count changed`);
  assert.equal(new Set(names).size, names.length, `${label} tools contain duplicate names`);
  assert.deepEqual([...names].sort(), [...expected].sort(), `${label} tool names changed`);
}

function findTool(listed, name) {
  const tool = listed.tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} missing from tools/list`);
  return tool;
}

function assertSchemaAndAnnotationsPreserved(slimListed, fullListed) {
  for (const slim of slimListed.tools) {
    const full = findTool(fullListed, slim.name);
    assert.deepEqual(slim.inputSchema, full.inputSchema, `${slim.name} input constraints changed by compaction`);
    assert.deepEqual(slim.annotations, full.annotations, `${slim.name} risk annotations changed by compaction`);
  }
  assertToolsListBudget(slimListed, { label: "F0 slim tools/list" });
  for (const name of ["read_text_file", "write_file"]) {
    const slimTool = findTool(slimListed, name);
    const fullTool = findTool(fullListed, name);
    assert.deepEqual(slimTool.inputSchema, fullTool.inputSchema, `${name} input schema differs by profile`);
    assert.deepEqual(slimTool.annotations, fullTool.annotations, `${name} annotations differ by profile`);
    assert.equal(slimTool.outputSchema, undefined, `${name} unexpectedly advertises slim outputSchema`);
  }

  const readTool = findTool(slimListed, "read_text_file");
  assert.equal(readTool.inputSchema.type, "object");
  assert.equal(readTool.inputSchema.properties.path.type, "string");
  assert.ok(readTool.inputSchema.required.includes("path"));
  assert.equal(readTool.annotations.readOnlyHint, true);
  assert.equal(readTool.annotations.openWorldHint, false);

  const writeTool = findTool(slimListed, "write_file");
  assert.deepEqual(Object.keys(writeTool.inputSchema.properties).sort(), ["content", "create_only", "expected_sha256", "path"]);
  assert.deepEqual([...writeTool.inputSchema.required].sort(), ["content", "path"]);
  assert.equal(writeTool.inputSchema.properties.expected_sha256.type, "string");
  assert.equal(writeTool.inputSchema.properties.create_only.type, "boolean");
  assert.equal(writeTool.inputSchema.properties._intent, undefined, "retired requirement metadata must not be advertised");
  assert.equal(writeTool.annotations.readOnlyHint, false);
  assert.equal(writeTool.annotations.destructiveHint, true);
  assert.equal(writeTool.annotations.idempotentHint, false);
  assert.equal(writeTool.annotations.openWorldHint, false);

  const commandTool = findTool(slimListed, "run_command");
  assert.equal(commandTool.annotations.readOnlyHint, false);
  assert.equal(commandTool.annotations.destructiveHint, true);
  assert.equal(commandTool.annotations.idempotentHint, false);
  assert.equal(commandTool.annotations.openWorldHint, true);
}

function assertFullOutputSchemas(listed) {
  const outputKeys = ["data", "ok", "summary", "tool"];
  for (const tool of listed.tools) {
    assert.ok(tool.outputSchema, `${tool.name} missing full-profile outputSchema`);
    assert.equal(tool.outputSchema.type, "object", `${tool.name} outputSchema is not an object`);
    assert.deepEqual(Object.keys(tool.outputSchema.properties).sort(), outputKeys, `${tool.name} outputSchema properties changed`);
    assert.deepEqual([...tool.outputSchema.required].sort(), outputKeys, `${tool.name} outputSchema required fields changed`);
    assert.equal(tool.outputSchema.properties.ok.type, "boolean");
    assert.equal(tool.outputSchema.properties.tool.type, "string");
    assert.equal(tool.outputSchema.properties.summary.type, "string");
    assert.equal(tool.outputSchema.properties.data.type, "object");
  }
}

function textEntries(result) {
  return result.content.filter((entry) => entry.type === "text");
}

function assertNoActiveGoalTail(result, label) {
  const texts = textEntries(result);
  assert.ok(texts.length > 0, `${label} has no text entries`);
  const text = texts.map(entry => entry.text).join("\n");
  assert.doesNotMatch(text, /MUST_CONTINUE_TO_TOOL|STOP_AUTONOMOUS_TOOL_CALLS|Your next action must be a tool call/, `${label} imposed a retired execution gate`);
}

function assertActiveGoalTail(result, label) {
  const texts = textEntries(result);
  assert.ok(texts.length > 0, `${label} has no text entries`);
  const last = texts.at(-1);
  assert.equal(result.content.at(-1), last, `${label} active-Goal tail is not the final content entry`);
  assert.match(last.text, /^GOAL RECORD\b/, `${label} missing Goal record`);
  assertNoActiveGoalTail(result, label);
}

function assertGoalFinishTail(result, label) {
  const texts = textEntries(result);
  assert.ok(texts.length > 0, `${label} has no text entries`);
  const last = texts.at(-1);
  assert.equal(result.content.at(-1), last, `${label} finish tail is not the final content entry`);
  assert.match(last.text, /^GOAL RECORD\b/, `${label} missing Goal record`);
  assertNoActiveGoalTail(result, label);
}

function resultPayload(result) {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object", "missing structuredContent");
  return result.structuredContent;
}

async function main(createMcpServer, McpUpstreamManager, refreshProxiedTools, stopGoalWatchdog) {
  configureEnvironment();

  const catalogWorkspace = await makeWorkspace("catalog-workspace");
  await fs.writeFile(path.join(catalogWorkspace, "success.txt"), "F0 stable fixture\n", "utf8");
  const emptyManager = emptyUpstreamManager(McpUpstreamManager);
  const slim = await createConfiguredServer(createMcpServer, "slim", catalogWorkspace, emptyManager);
  let full;
  try {
    const slimListed = await slim.client.listTools();
    assert.equal(slimListed.tools.length, 34);
    assertCatalog(slimListed, EXPECTED_SLIM_TOOLS, "slim");

    full = await createConfiguredServer(
      createMcpServer,
      "full",
      catalogWorkspace,
      emptyUpstreamManager(McpUpstreamManager)
    );
    const fullListed = await full.client.listTools();
    assert.equal(fullListed.tools.length, EXPECTED_NATIVE_TOOLS.length);
    assertCatalog(fullListed, EXPECTED_NATIVE_TOOLS, "full native");
    assertFullOutputSchemas(fullListed);
    assertSchemaAndAnnotationsPreserved(slimListed, fullListed);

    const successPath = path.join(catalogWorkspace, "success.txt");
    const ordinarySuccess = await slim.client.callTool({
      name: "read_text_file",
      arguments: { path: successPath, head: 1 },
    });
    const stableData = {
      path: successPath,
      content: "F0 stable fixture",
      head: 1,
      lines: 1,
      total_lines: 2,
      truncated: false,
      next_offset: null,
      next_character_offset: null,
      single_line_truncated: false,
    };
    const stablePayload = {
      ok: true,
      tool: "read_text_file",
      summary: `read_text_file: ${successPath}`,
      data: stableData,
    };
    const discovery = ordinarySuccess.structuredContent.data.skill_discovery;
    assert.equal(discovery.catalog.schema_version, 1);
    assert.match(discovery.catalog.catalog_sha256, /^[a-f0-9]{64}$/);
    assert.equal(ordinarySuccess.content.length, 2, "only one discovery text block may be appended");
    assert.equal(ordinarySuccess.content[1].type, "text");
    assert.ok(ordinarySuccess.content[1].text.startsWith("## Available Harness skills\n"));
    const { skill_discovery: _discovery, ...originalData } = ordinarySuccess.structuredContent.data;
    assert.deepEqual({ ...ordinarySuccess, content: ordinarySuccess.content.slice(0, 1),
      structuredContent: { ...ordinarySuccess.structuredContent, data: originalData } }, {
      content: [{ type: "text", text: JSON.stringify(stablePayload, null, 2) }],
      structuredContent: stablePayload,
    }, "discovery must preserve every original success field and text byte");

    const { visualReviewDir } = await import("../dist/lib/visual-review-state.js");
    const missingReviewDirectory = visualReviewDir(catalogWorkspace);
    const workspaceBeforeMissingReview = (await fs.readdir(catalogWorkspace)).sort();
    await assert.rejects(fs.stat(missingReviewDirectory), { code: "ENOENT" });
    const emptyReview = await slim.client.callTool({
      name: "visual_review",
      arguments: { action: "status" },
    });
    assert.equal(emptyReview.isError, undefined);
    assert.equal(emptyReview.structuredContent?.ok, true);
    assert.equal(emptyReview.structuredContent?.data?.action, "status");
    assert.equal(emptyReview.structuredContent?.data?.review, null);
    const businessError = await slim.client.callTool({
      name: "visual_review",
      arguments: { action: "withdraw" },
    });
    assert.equal(businessError.isError, true, "business failures must carry the MCP error signal");
    assert.deepEqual(Object.keys(businessError).sort(), ["content", "isError", "structuredContent"]);
    assert.equal(businessError.content.length, 1);
    assert.equal(businessError.content[0].type, "text");
    const businessPayload = JSON.parse(businessError.content[0].text);
    assert.deepEqual(Object.keys(businessPayload).sort(), ["data", "ok", "summary", "tool"]);
    assert.equal(businessPayload.ok, false);
    assert.equal(businessPayload.tool, "visual_review");
    assert.equal(businessPayload.data.error, businessPayload.summary);
    assert.equal(businessPayload.summary, "VISUAL_INPUT_REQUIRED: review_id");
    assert.equal(businessPayload.data.error_code, "VISUAL_INPUT_REQUIRED");
    assert.equal(businessPayload.data.outcome_kind, "needs_input");
    assert.equal(businessPayload.data.failure_phase, "validation");
    assert.equal(businessPayload.data.operation_started, false);
    assert.equal(businessPayload.data.retryable, false, "unchanged arguments must not be blindly retried");
    assert.equal(businessPayload.data.retry_policy, "retry_with_changed_args");
    assert.equal(businessPayload.data.delivery_ready, false);
    assert.deepEqual(businessPayload.data.missing_or_invalid_fields, ["review_id"]);
    assert.deepEqual(businessPayload.data.next_action, {
      tool: "visual_review",
      arguments: { action: "withdraw" },
      required_fields: ["review_id"],
    });
    assert.deepEqual(businessError.structuredContent, businessPayload, "business error structured payload changed");
    assert.equal(businessError.content[0].text, JSON.stringify(businessPayload, null, 2));
    await assert.rejects(fs.stat(missingReviewDirectory), { code: "ENOENT" }, "missing status input must not create review state");
    assert.deepEqual((await fs.readdir(catalogWorkspace)).sort(), workspaceBeforeMissingReview, "missing status input must not create workspace artifacts");
    assert.equal(await fs.readFile(successPath, "utf8"), "F0 stable fixture\n", "missing status input must not mutate the existing artifact");

    const thrownCallback = await slim.client.callTool({
      name: "file_info",
      arguments: { path: path.join(catalogWorkspace, "missing-f0-file.txt") },
    });
    assert.equal(thrownCallback.isError, true);
    assert.equal(thrownCallback.structuredContent, undefined);
    assert.deepEqual(Object.keys(thrownCallback).sort(), ["content", "isError"]);
    assert.equal(thrownCallback.content.length, 1);
    assert.equal(thrownCallback.content[0].type, "text");
    assert.match(thrownCallback.content[0].text, /^ENOENT\b/, "thrown callback lost filesystem error category");
  } finally {
    if (full) await closeConfiguredServer(full);
    await closeConfiguredServer(slim);
  }

  const overrideCwd = path.join(tempRoot, "override-cwd");
  await fs.mkdir(path.join(overrideCwd, "profiles"), { recursive: true });
  await fs.writeFile(
    path.join(overrideCwd, "profiles", "tool-overrides.json"),
    JSON.stringify(
      {
        enabled: ["edit_file", "git_diff"],
        disabled: ["git_diff"],
      },
      null,
      2
    ),
    "utf8"
  );

  let overrideSlim;
  let overrideFull;
  process.chdir(overrideCwd);
  try {
    overrideSlim = await createConfiguredServer(
      createMcpServer,
      "slim",
      catalogWorkspace,
      emptyUpstreamManager(McpUpstreamManager)
    );
    overrideFull = await createConfiguredServer(
      createMcpServer,
      "full",
      catalogWorkspace,
      emptyUpstreamManager(McpUpstreamManager)
    );
  } finally {
    process.chdir(repoRoot);
  }

  try {
    const slimOverrideList = await overrideSlim.client.listTools();
    const slimOverrideNames = slimOverrideList.tools.map((tool) => tool.name);
    assert.equal(slimOverrideNames.length, EXPECTED_SLIM_TOOLS.length, "slim override changed the expected net catalog size");
    assert.equal(slimOverrideNames.includes("edit_file"), true, "slim enabled override was ignored");
    assert.equal(slimOverrideNames.includes("git_diff"), false, "disabled override did not win over enabled/slim");

    const fullOverrideList = await overrideFull.client.listTools();
    const fullOverrideNames = fullOverrideList.tools.map((tool) => tool.name);
    // Characterize the production seam exactly: server-factory bypasses
    // shouldExposeTool entirely for full, so local disabled overrides currently
    // affect slim registration only. F1 must not silently change this contract.
    assertCatalog(fullOverrideList, EXPECTED_NATIVE_TOOLS, "full profile overrides");
    assert.equal(fullOverrideNames.includes("edit_file"), true, "full profile unexpectedly lost an enabled native tool");
    assert.equal(fullOverrideNames.includes("git_diff"), true, "full profile no longer ignores disabled override");
    assertFullOutputSchemas(fullOverrideList);
  } finally {
    await closeConfiguredServer(overrideFull);
    await closeConfiguredServer(overrideSlim);
  }

  const goalWorkspace = await makeWorkspace("goal-workspace");
  const goalFile = path.join(goalWorkspace, "goal-fixture.txt");
  await fs.writeFile(goalFile, "Goal fixture\n", "utf8");
  const goalServer = await createConfiguredServer(
    createMcpServer,
    "slim",
    goalWorkspace,
    emptyUpstreamManager(McpUpstreamManager)
  );
  try {
    const createdGoal = await goalServer.client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "F0 Goal tail characterization",
        success_criteria: [{ name: "F0 criterion", passed: false, verification: { kind: "file_exists", target: goalFile } }],
      },
    });
    const createdPayload = resultPayload(createdGoal);
    assert.equal(createdPayload.ok, true);
    assert.equal(createdPayload.tool, "goal");
    assert.equal(createdPayload.data.goal.status, "active");
    const goalOwner = createdPayload.data.goal.owner_session;
    assert.equal(typeof goalOwner, "string");
    assert.ok(goalOwner.length > 0, "anonymous factory must own a trusted stable session");
    assertActiveGoalTail(createdGoal, "goal create");

    const activeResult = await goalServer.client.callTool({
      name: "read_text_file",
      arguments: { path: goalFile, offset: 1, limit: 1 },
    });
    assert.equal(resultPayload(activeResult).data.harness_context.goal.status, "active");
    assertActiveGoalTail(activeResult, "active Goal tool result");

    const updatedGoal = await goalServer.client.callTool({
      name: "goal",
      arguments: {
        action: "update",
        current_phase: "Verify F0 criterion",
      },
    });
    assert.equal(resultPayload(updatedGoal).data.goal.success_criteria[0].passed, false);
    assert.equal(resultPayload(updatedGoal).data.goal.owner_session, goalOwner);
    assertActiveGoalTail(updatedGoal, "all-passed active Goal result");

    const bypass = await goalServer.client.callTool({
      name: "goal",
      arguments: {
        action: "update",
        success_criteria: [{ name: "F0 criterion", passed: true }],
      },
    });
    assert.equal(bypass.structuredContent?.ok, false);
    assert.match(JSON.stringify(bypass.structuredContent), /UNVERIFIED_CRITERION_UPDATE/);

    const evidenceResult = await goalServer.client.callTool({
      name: "file_info",
      arguments: {
        path: goalFile,
        sha256: true,
      },
    });
    const evidencePayload = resultPayload(evidenceResult);
    const evidenceId = evidencePayload.data.goal_run_evidence?.id;
    assert.ok(evidenceId);
    assert.equal(evidencePayload.data.goal_run_evidence.verifies_criterion, true);

    const confirmedGoal = await goalServer.client.callTool({
      name: "goal",
      arguments: {
        action: "confirm",
        criterion: "F0 criterion",
        evidence_ids: [evidenceId],
      },
    });
    assert.equal(resultPayload(confirmedGoal).data.goal.success_criteria[0].passed, true);
    assertGoalFinishTail(confirmedGoal, "all-passed active Goal result");

    const completedGoal = await goalServer.client.callTool({
      name: "goal",
      arguments: { action: "complete" },
    });
    assert.equal(resultPayload(completedGoal).ok, true, JSON.stringify(resultPayload(completedGoal)));
    assert.equal(resultPayload(completedGoal).data.goal.status, "completed");
    assertNoActiveGoalTail(completedGoal, "goal completion result");

    const afterCompletion = await goalServer.client.callTool({
      name: "read_text_file",
      arguments: { path: goalFile, tail: 1 },
    });
    assertNoActiveGoalTail(afterCompletion, "post-completion tool result");

    const replacementGoal = await goalServer.client.callTool({
      name: "goal",
      arguments: {
        action: "create",
        objective: "F0 cancellation tail characterization",
        success_criteria: [{ name: "cancel criterion", passed: false }],
      },
    });
    const replacementPayload = resultPayload(replacementGoal);
    assert.equal(replacementPayload.ok, true, JSON.stringify(replacementPayload));
    assert.equal(replacementPayload.data?.goal?.status, "active", JSON.stringify(replacementPayload));
    assert.equal(replacementPayload.data.goal.owner_session, goalOwner, "factory owner changed across Goal lifecycles");
    assertActiveGoalTail(replacementGoal, "replacement Goal create");

    const cancelledGoal = await goalServer.client.callTool({
      name: "goal",
      arguments: { action: "cancel" },
    });
    assert.equal(resultPayload(cancelledGoal).data.goal.status, "cancelled");
    assertNoActiveGoalTail(cancelledGoal, "goal cancellation result");

    const afterCancellation = await goalServer.client.callTool({
      name: "read_text_file",
      arguments: { path: goalFile, head: 1 },
    });
    assertNoActiveGoalTail(afterCancellation, "post-cancellation tool result");
  } finally {
    await closeConfiguredServer(goalServer);
    stopGoalWatchdog();
  }

  const proxyWorkspace = await makeWorkspace("proxy-workspace");
  const proxyConfig = {
    id: "fake-upstream",
    name: "F0 Fake Upstream",
    enabled: true,
    transport: "stdio",
    command: "fake-upstream",
    expose: "allowlist",
    tools: ["echo"],
    tool_prefix: "f0",
  };
  const proxySuccess = {
    content: [
      { type: "text", text: "F0_PROXY_SUCCESS" },
      { type: "resource", resource: { uri: "urn:f0:success", mimeType: "text/plain", text: "resource" } },
    ],
    structuredContent: { marker: "F0_PROXY_SUCCESS" },
  };
  const proxyIsError = {
    content: [{ type: "text", text: "F0_PROXY_IS_ERROR" }],
    structuredContent: { marker: "F0_PROXY_IS_ERROR" },
    isError: true,
  };
  const proxyManager = {
    tools: [{
      name: "echo",
      title: "F0 Echo",
      description: "F0 dynamic echo",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          mode: { type: "string", enum: ["success", "is_error", "reject"] },
        },
        required: ["message"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }],
    calls: [],
    registerMcpServer() {},
    listServerConfigs() {
      return [proxyConfig];
    },
    async listTools() {
      return this.tools;
    },
    async callTool(serverId, toolName, args) {
      this.calls.push({ serverId, toolName, args });
      if (args.mode === "is_error") return proxyIsError;
      if (args.mode === "reject") throw new Error("F0_PROXY_REJECTED");
      return proxySuccess;
    },
  };
  const proxyServer = await createConfiguredServer(
    createMcpServer,
    "slim",
    proxyWorkspace,
    proxyManager
  );
  try {
    const refreshedNames = await refreshProxiedTools(proxyServer.server, proxyManager);
    assert.deepEqual(refreshedNames, ["f0__echo"]);
    const listedWithProxy = await proxyServer.client.listTools();
    const proxiedTool = findTool(listedWithProxy, "f0__echo");
    assert.equal(proxiedTool.inputSchema.properties.message.type, "string");
    assert.equal(proxiedTool.annotations.readOnlyHint, true);

    const proxiedSuccess = await proxyServer.client.callTool({
      name: "f0__echo",
      arguments: { message: "success", mode: "success" },
    });
    assert.deepEqual(proxiedSuccess, proxySuccess, "proxy changed successful upstream CallToolResult");

    const proxiedIsError = await proxyServer.client.callTool({
      name: "f0__echo",
      arguments: { message: "error", mode: "is_error" },
    });
    assert.deepEqual(proxiedIsError, proxyIsError, "proxy changed upstream isError CallToolResult");

    const rejectedProxy = await proxyServer.client.callTool({
      name: "f0__echo",
      arguments: { message: "reject", mode: "reject" },
    });
    assert.equal(rejectedProxy.isError, true);
    assert.equal(rejectedProxy.structuredContent, undefined);
    assert.deepEqual(Object.keys(rejectedProxy).sort(), ["content", "isError"]);
    assert.equal(rejectedProxy.content.length, 1);
    assert.equal(rejectedProxy.content[0].type, "text");
    assert.equal(rejectedProxy.content[0].text, "F0_PROXY_REJECTED");

    proxyManager.tools = [];
    const afterRefreshNames = await refreshProxiedTools(proxyServer.server, proxyManager);
    assert.deepEqual(afterRefreshNames, []);
    const listedAfterRefresh = await proxyServer.client.listTools();
    assert.equal(listedAfterRefresh.tools.some((tool) => tool.name === "f0__echo"), false, "stale proxy survived refresh");
  } finally {
    await closeConfiguredServer(proxyServer);
  }
}

let createMcpServer;
let McpUpstreamManager;
let refreshProxiedTools;
let stopGoalWatchdog;

try {
  configureEnvironment();
  await fs.writeFile(pluginConfigPath, JSON.stringify({
    schema_version: 2,
    computer_use: { enabled: false },
    browser_use: { enabled: false },
    skills: [],
  }), "utf8");
  ({ createMcpServer } = await import("../dist/server-factory.js"));
  ({ McpUpstreamManager } = await import("../dist/lib/mcp-upstream-manager.js"));
  ({ refreshProxiedTools } = await import("../dist/lib/mcp-tool-proxy.js"));
  ({ stopGoalWatchdog } = await import("../dist/lib/goal-watchdog.js"));
  await main(createMcpServer, McpUpstreamManager, refreshProxiedTools, stopGoalWatchdog);
  console.log("F0 characterization: slim/full catalogs, schemas, annotations, results, Goal tails, and upstream proxy behavior passed");
} finally {
  for (const configured of [...configuredServers]) await closeConfiguredServer(configured);
  stopGoalWatchdog?.();
  await fs.rm(tempRoot, { recursive: true, force: true });
  process.chdir(originalCwd);
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
