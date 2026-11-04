import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { attachBrowserUseProvider, callBrowserUseProvider } from "../lib/browser-use-registry.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

async function browserToolResult(
  server: McpServer,
  tool: "browser_exec" | "browser_screenshot",
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const upstream = await callBrowserUseProvider(server, tool, args);
  return wrapBrowserUseResult(tool, upstream);
}

export function wrapBrowserUseResult(tool: "browser_exec" | "browser_screenshot", upstream: CallToolResult): CallToolResult {
  const publicTool = tool === "browser_exec" ? "browser_use_exec" : "browser_use_screenshot";
  const output = upstream.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const envelope = toolResult(publicTool, {
    provider: "browser-use-official",
    // Structured-result clients otherwise hide plain upstream Python stdout.
    output: output.slice(0, 24000),
    output_chars: output.length,
    output_truncated: output.length > 24000,
    ...(output.length > 24000 ? { output_retrieval_hint: "Full text remains in the MCP text content; use bounded page queries for structured-only clients." } : {}),
    ...(upstream.structuredContent ? { upstream_result: upstream.structuredContent } : {}),
  }, {
    ok: upstream.isError !== true,
    summary: publicTool + (upstream.isError ? ": upstream error" : ": done"),
  });
  // Native tools advertise the Harness envelope. Keep upstream images/text and
  // failure semantics while supplying the structured content required by SDK.
  return { ...upstream, ...envelope, content: [...upstream.content, ...envelope.content] };
}

export function registerBrowserUseTools(server: McpServer): void {
  attachBrowserUseProvider(server);
  server.registerTool(
    "browser_use_exec",
    {
      title: "Browser Use Exec",
      description:
        "Execute Python in the bundled official Browser Use 0.13.10 browser-harness session. Helpers such as new_tab(url), goto_url(url), page_info(), click_at_xy(x,y), type_text(text), js(code), wait_for_load(), and list_tabs() are pre-imported; the namespace persists across calls.",
      inputSchema: {
        code: z.string().min(1).max(200_000).describe("Python code using the pre-imported browser-harness helpers"),
      },
      annotations: toolAnnotations("command"),
    },
    async ({ code }) => browserToolResult(server, "browser_exec", { code })
  );
  server.registerTool(
    "browser_use_screenshot",
    {
      title: "Browser Use Screenshot",
      description: "Capture the current page from the bundled Browser Use session as MCP image content.",
      inputSchema: {
        full: z.boolean().optional().default(false),
        max_dim: z.number().int().min(1).max(8192).optional(),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ full, max_dim }) => browserToolResult(server, "browser_screenshot", {
      full,
      ...(max_dim ? { max_dim } : {}),
    })
  );
}
