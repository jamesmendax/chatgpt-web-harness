import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP ToolAnnotations describe tool behavior; they are not an approval switch.
 * ChatGPT decides confirmation at the host/app-permission layer before the MCP
 * callback runs. Keep these hints truthful and conservative. In particular,
 * destructiveHint=false means "additive only" in the MCP specification, so it
 * must never be used merely to suppress a confirmation dialog.
 */
export type ToolRisk = "read" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    };
  }

  if (risk === "command") {
    return {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    };
  }

  return {
    readOnlyHint: false,
    // Generic edit tools may overwrite existing state; advertise that risk
    // rather than pretending the operation is additive-only.
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  };
}