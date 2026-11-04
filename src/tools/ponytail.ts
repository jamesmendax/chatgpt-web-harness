import { createRequire } from "node:module";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getCodexHooks, runCodexHook, type CodexHook } from "../lib/codex-hooks.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

type PonytailMode = "lite" | "full" | "ultra" | "review" | "off";

interface PonytailState {
  mode: PonytailMode;
  instructions?: string;
  instructionsSent: boolean;
}

interface PonytailInstructionsModule {
  getPonytailInstructions?(mode: Exclude<PonytailMode, "off">): string;
}

const states = new WeakMap<McpServer, PonytailState>();

function requestedMode(prompt: string): PonytailMode | undefined {
  const normalized = prompt.trim().toLowerCase();
  if (/\b(stop ponytail|normal mode)\b/.test(normalized)) return "off";
  if (/^[/@$]ponytail(?:\s|$)/.test(normalized)) {
    if (/^[/@$]ponytail(?:\s*:\s*ponytail)?-review\b/.test(normalized)) return "review";
    const mode = normalized.match(/^[/@$]ponytail(?:\s*:\s*ponytail)?\s+(lite|full|ultra|off)\b/)?.[1];
    return mode as PonytailMode | undefined;
  }
  return undefined;
}

function ponytailHooks(hooks: CodexHook[]): { activate?: CodexHook; tracker?: CodexHook } {
  const matching = hooks.filter((hook) => hook.plugin === "ponytail@ponytail" && hook.enabled && hook.trusted);
  return {
    activate: matching.find((hook) => hook.event === "session_start"),
    tracker: matching.find((hook) => hook.event === "user_prompt_submit"),
  };
}

function modeFromInstructions(instructions: string): PonytailMode {
  return (instructions.match(/PONYTAIL MODE ACTIVE\s*[—-]\s*level:\s*(lite|full|ultra|review|off)/i)?.[1]?.toLowerCase() as PonytailMode | undefined) ?? "full";
}

function instructionsFor(pluginRoot: string, mode: Exclude<PonytailMode, "off">): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const plugin = require(path.join(pluginRoot, "hooks", "ponytail-instructions.js")) as PonytailInstructionsModule;
    return plugin.getPonytailInstructions?.(mode);
  } catch {
    return undefined;
  }
}

async function activate(server: McpServer, prompt: string): Promise<{ available: boolean; state?: PonytailState; error?: string }> {
  const { activate: activationHook, tracker } = ponytailHooks(await getCodexHooks());
  if (!activationHook) return { available: false, error: "Ponytail plugin or its trusted SessionStart hook is disabled" };

  const requested = requestedMode(prompt);
  let state = states.get(server);
  if (requested !== undefined && tracker) {
    await runCodexHook(tracker, JSON.stringify({ prompt }));
  }
  if (requested === "off") {
    state = { mode: "off", instructionsSent: false };
  } else if (requested !== undefined) {
    state = {
      mode: requested,
      instructions: instructionsFor(activationHook.plugin_root, requested),
      instructionsSent: false,
    };
  } else if (!state) {
    const instructions = await runCodexHook(activationHook);
    state = { mode: modeFromInstructions(instructions), instructions, instructionsSent: false };
  }
  states.set(server, state!);
  return { available: true, state };
}

export function registerPonytailTurnTool(server: McpServer): void {
  server.registerTool(
    "ponytail_turn",
    {
      title: "Ponytail Turn Controller",
      description: "Call before every user-facing response when Ponytail is enabled. Pass the exact current user prompt. It applies /ponytail lite|full|ultra|off and returns active instructions only when they need to be loaded or refreshed.",
      inputSchema: {
        prompt: z.string().describe("The exact current user prompt."),
        action: z.enum(["turn", "refresh", "status"]).default("turn"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ prompt, action }) => {
      const result = await activate(server, prompt);
      if (!result.available || !result.state) {
        return toolResult("ponytail_turn", { available: false, error: result.error });
      }
      const state = result.state;
      const includeInstructions = action === "refresh" || !state.instructionsSent;
      state.instructionsSent = true;
      return toolResult("ponytail_turn", {
        available: true,
        mode: state.mode,
        active: state.mode !== "off",
        active_instructions: includeInstructions ? state.instructions : undefined,
        refresh_hint: includeInstructions ? undefined : "Use action refresh if earlier Ponytail instructions are no longer in context.",
      });
    }
  );
}
