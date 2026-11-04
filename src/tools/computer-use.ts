import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getComputerUseProvider } from "../lib/computer-use-registry.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

const ACTIONS = [
  "status", "list_windows", "select_target", "screenshot", "click", "double_click",
  "move", "type", "scroll", "keypress", "drag", "wait", "close",
] as const;

export function registerComputerUseTool(server: McpServer): void {
  server.registerTool(
    "computer_use",
    {
      title: "Computer Use",
      description:
        "Bundled Windows UI provider. First call list_windows, then select_target for desktop or one hwnd. Coordinates are relative to the selected target. Supports screenshot, click, double_click, move, type, scroll, keypress, drag, wait and close. type can atomically select/clear the focused field with replace_existing=true. High-impact key chords require confirmed=true.",
      inputSchema: {
        action: z.enum(ACTIONS),
        target: z.enum(["desktop", "window"]).optional(),
        hwnd: z.string().regex(/^\d{1,20}$/).optional().describe("Decimal hwnd returned by list_windows"),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        to_x: z.number().int().optional(),
        to_y: z.number().int().optional(),
        delta_x: z.number().int().min(-10000).max(10000).optional(),
        delta_y: z.number().int().min(-10000).max(10000).optional(),
        button: z.enum(["left", "right", "middle"]).optional().default("left"),
        text: z.string().max(100_000).optional(),
        replace_existing: z.boolean().optional().default(false),
        key: z.string().max(100).optional().describe("Key chord such as CTRL+L"),
        keys: z.array(z.string().min(1).max(32)).max(8).optional(),
        duration_ms: z.number().int().min(0).max(30_000).optional(),
        timeout_ms: z.number().int().min(1000).max(60_000).optional().default(30_000),
        confirmed: z.boolean().optional().default(false),
      },
      annotations: toolAnnotations("command"),
    },
    async (input) => {
      const result = await getComputerUseProvider().execute(input);
      const envelope = toolResult("computer_use", result.data, {
        summary: `computer_use ${input.action}: done`,
      });
      if (!result.image) return envelope;
      return {
        ...envelope,
        content: [
          ...envelope.content,
          { type: "image" as const, data: result.image.toString("base64"), mimeType: "image/png" },
        ],
      };
    }
  );
}
