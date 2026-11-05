import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { registerNodeReplTool } from "./tools/node-repl.js";
import { registerPonytailTurnTool } from "./tools/ponytail.js";
import { registerVisualTools } from "./tools/visual.js";
import { registerVisualReviewTool } from "./tools/visual-review.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerGoalTool } from "./tools/goal.js";
import { registerRecoveryTools } from "./tools/recovery.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerBrowserUseTools } from "./tools/browser-use.js";
import { registerComputerUseTool } from "./tools/computer-use.js";
import { registerCodeIntelligenceTool } from "./tools/code-intelligence.js";
import { isBrowserUseEnabled, isComputerUseEnabled } from "./lib/plugin-config.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { resetHarnessSnapshotRetention } from "./lib/context-broker.js";
import { createWebHarnessResultPipeline } from "./lib/result-pipeline.js";
import {
  EffectiveToolRegistry,
  type EffectiveToolConfig,
  type RawToolCallback,
} from "./lib/effective-tool-registry.js";
import {
  InvocationGateway,
  type InvocationTraceRecord,
} from "./lib/invocation-gateway.js";
import { setAllowedRoots, setDefaultCwd, setFullDiskAccess } from "./lib/path-security.js";
import { runtimePrincipalId } from "./lib/mcp-request-identity.js";
import { APP_VERSION, setRuntimeToolCatalog } from "./lib/runtime-manifest.js";

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

export interface McpServerHarnessRuntime {
  readonly registry: EffectiveToolRegistry;
  readonly gateway: InvocationGateway;
}

const harnessRuntimeByServer = new WeakMap<McpServer, McpServerHarnessRuntime>();

/** Test/diagnostic seam for the effective catalog owned by one MCP server. */
export function getMcpServerHarnessRuntime(server: McpServer): McpServerHarnessRuntime | undefined {
  return harnessRuntimeByServer.get(server);
}

function traceInvocation(record: InvocationTraceRecord): void {
  const mode = (process.env.HARNESS_INVOCATION_TRACE || "off").trim().toLowerCase();
  if (mode !== "1" && mode !== "true" && mode !== "all") return;
  const safe = (value: string | number | undefined): string =>
    String(value ?? "-").replace(/[\r\n\t\u2028\u2029]/g, " ").slice(0, 160);
  const fields = [
    `status=${record.status}`,
    `invocation=${record.invocationId}`,
    `tool=${safe(record.tool)}`,
    `source=${safe(record.source)}`,
    `session=${safe(record.sessionId)}`,
    `request=${safe(record.requestId)}`,
    `duration_ms=${record.durationMs}`,
    `deadline_at=${record.deadlineAt ?? "-"}`,
    `aborted=${record.aborted}`,
  ];
  if (record.errorCategory) fields.push(`error_category=${record.errorCategory}`);
  const line = `[HARNESS] ${fields.join(" ")}`;
  if (record.status === "failure") console.warn(line);
  else console.log(line);
}

function configureToolRegistration(
  server: McpServer,
  workspaceRoot: string,
  workspaceRoots: string[]
): McpServerHarnessRuntime {
  const registry = new EffectiveToolRegistry();
  setRuntimeToolCatalog(registry);
  const tunnelProfile = process.env.CHATGPT_TUNNEL_PROFILE?.trim() || undefined;
  const resultPipeline = createWebHarnessResultPipeline(workspaceRoot);
  const gateway = new InvocationGateway(
    registry,
    {
      workspaceRoot,
      principalId: runtimePrincipalId(workspaceRoot),
      projectRoots: workspaceRoots,
      tunnelProfile,
      // Anonymous embedded transports still need a per-server fallback.
      // Trusted conversation identity takes precedence in createRuntimeScope.
      fallbackSessionId: `local_mcp_${randomUUID()}`,
    },
    {
      onSuccess: (context, result) => resultPipeline.processSuccess(context, result),
      onFailure: (context, error) => resultPipeline.processFailure(context, error),
      trace: traceInvocation,
    }
  );
  const original = server.registerTool.bind(server);
  server.registerTool = ((name, config, callback) => {
    const toolName = String(name);
    const definition = registry.prepare(
      toolName,
      config as EffectiveToolConfig,
      callback as unknown as RawToolCallback
    );
    if (!definition) return NOOP_TOOL;

    const wrappedCallback = (async (...callbackArgs: unknown[]) =>
      gateway.invoke(toolName, callbackArgs)) as typeof callback;
    const registered = original(name, definition.config as any, wrappedCallback as any);
    registry.register(definition);

    // Dynamic upstream refresh removes RegisteredTool handles. Mirror that
    // lifecycle so the effective registry never keeps a stale callable tool.
    const originalRemove = registered.remove.bind(registered);
    registered.remove = () => {
      originalRemove();
      registry.remove(toolName);
    };
    return registered;
  }) as typeof server.registerTool;

  return { registry, gateway };
}

export function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string
): McpServer {
  // The server factory is the composition root for runtime policy. Direct
  // in-memory/test servers must see the same workspace boundary as the HTTP
  // entrypoint, so configure path security here rather than only in index.ts.
  setDefaultCwd(workspaceRoot);
  setAllowedRoots(workspaceRoots.length ? workspaceRoots : [workspaceRoot]);
  setFullDiskAccess(fullDiskAccess);
  // Each MCP session is a fresh ChatGPT conversation: its first tool result
  // must carry a snapshot even if the process already delivered one elsewhere.
  resetHarnessSnapshotRetention(workspaceRoot);
  const server = new McpServer(
    {
      name: "codex-mcp-server",
      version: APP_VERSION,
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
      instructions: buildServerInstructions(
        workspaceRoot,
        workspaceRoots,
        fullDiskAccess,
        projectMemoryInstructions
      ),
    }
  );

  const harnessRuntime = configureToolRegistration(server, workspaceRoot, workspaceRoots);
  harnessRuntimeByServer.set(server, harnessRuntime);

  registerFilesystemTools(server, workspaceRoot);
  registerCodeIntelligenceTool(server, workspaceRoot);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerNodeReplTool(server, workspaceRoot);
  registerPonytailTurnTool(server);
  registerVisualTools(server);
  registerVisualReviewTool(server, workspaceRoot);
  registerGoalTool(server, workspaceRoot);
  registerTaskTools(server, workspaceRoot);
  registerRecoveryTools(server, workspaceRoot);
  registerBrowserTools(server);
  // Provider tools are capability-bearing. Do not even add them to the full
  // catalog unless the account-scoped plugin switch is enabled for this MCP.
  if (isComputerUseEnabled()) registerComputerUseTool(server);
  if (isBrowserUseEnabled()) registerBrowserUseTools(server);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    upstreamManager.registerMcpServer(server);
  }

  return server;
}
