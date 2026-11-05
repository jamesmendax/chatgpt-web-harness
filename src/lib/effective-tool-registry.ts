import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { getChatGptToolProfile, shouldExposeTool, type ToolProfileName } from "./tool-profile.js";
import { TOOL_RESULT_OUTPUT_SCHEMA } from "./tool-result.js";
import type { RuntimeScope } from "./runtime-scope.js";
import { SLIM_TOOL_DESCRIPTIONS } from "./slim-tool-descriptions.js";

export type ToolSource = "native" | "upstream";

/** The registration metadata retained by the effective registry. */
export interface EffectiveToolConfig {
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

/** Raw MCP callback boundary; argument validation remains the SDK's job. */
export type RawToolCallback = (
  ...callbackArgs: unknown[]
) => CallToolResult | Promise<CallToolResult>;

export type EffectiveToolExecutor = (
  rawCallbackArgs: readonly unknown[],
  scope: RuntimeScope
) => CallToolResult | Promise<CallToolResult>;

/** A tool definition after profile admission and config shaping. */
export interface EffectiveToolDefinition {
  readonly name: string;
  readonly source: ToolSource;
  readonly config: EffectiveToolConfig;
  readonly execute: EffectiveToolExecutor;
}

export interface EffectiveToolRegistryOptions {
  readonly profile?: ToolProfileName;
}

/**
 * Instance-owned, insertion-ordered effective tool definitions.
 * It deliberately does not validate callback arguments or maintain a global
 * dispatcher; the MCP SDK remains the input-validation authority.
 */
export class EffectiveToolRegistry {
  public readonly profile: ToolProfileName;
  private readonly definitions = new Map<string, EffectiveToolDefinition>();

  constructor(profile?: ToolProfileName);
  constructor(options?: EffectiveToolRegistryOptions);
  constructor(profileOrOptions: ToolProfileName | EffectiveToolRegistryOptions = getChatGptToolProfile()) {
    this.profile =
      typeof profileOrOptions === "string"
        ? profileOrOptions
        : profileOrOptions.profile ?? getChatGptToolProfile();
  }

  /**
   * Applies current production admission/config behavior without registering
   * the result. `undefined` means that a slim native tool was not admitted.
   */
  prepare(
    name: string,
    config: EffectiveToolConfig,
    callback: RawToolCallback
  ): EffectiveToolDefinition | undefined {
    const source: ToolSource = name.includes("__") ? "upstream" : "native";

    // Namespaced upstream tools are admitted by the native registration seam;
    // upstream-specific allowlisting remains owned by the upstream proxy.
    if (source === "native" && this.profile !== "full" && !shouldExposeTool(name, this.profile)) {
      return undefined;
    }

    // This is intentionally the same shallow clone and truthiness check as
    // server-factory: full native tools advertise the shared schema only when
    // their registration did not already provide one.
    let effectiveConfig =
      source === "native" && this.profile === "full" && !config.outputSchema
        ? { ...config, outputSchema: TOOL_RESULT_OUTPUT_SCHEMA }
        : config;

    // Tool schemas describe execution parameters. Legacy _intent fields are
    // accepted/ignored by the callback boundary, never advertised or required.

    if (source === "native" && this.profile === "slim" && SLIM_TOOL_DESCRIPTIONS[name]) {
      // Human-readable titles duplicate stable tool names. Only display metadata
      // is compacted; schema validation, risk hints and execution stay intact.
      const { title: _displayTitle, ...rest } = effectiveConfig;
      effectiveConfig = { ...rest, description: SLIM_TOOL_DESCRIPTIONS[name] };
    }

    return {
      name,
      source,
      config: effectiveConfig,
      execute: (rawCallbackArgs, _scope) => callback(...rawCallbackArgs),
    };
  }

  /** Registers or replaces one prepared definition while retaining its map position. */
  register(definition: EffectiveToolDefinition): EffectiveToolDefinition;
  register(
    name: string,
    config: EffectiveToolConfig,
    callback: RawToolCallback
  ): EffectiveToolDefinition | undefined;
  register(
    definitionOrName: EffectiveToolDefinition | string,
    config?: EffectiveToolConfig,
    callback?: RawToolCallback
  ): EffectiveToolDefinition | undefined {
    if (typeof definitionOrName !== "string") {
      this.definitions.set(definitionOrName.name, definitionOrName);
      return definitionOrName;
    }

    if (config === undefined || callback === undefined) return undefined;
    const definition = this.prepare(definitionOrName, config, callback);
    if (!definition) return undefined;
    this.definitions.set(definition.name, definition);
    return definition;
  }

  /** Removes a definition and reports whether it was present. */
  remove(name: string): boolean {
    return this.definitions.delete(name);
  }

  /** Returns a definition without exposing the registry's mutable map. */
  get(name: string): EffectiveToolDefinition | undefined {
    return this.definitions.get(name);
  }

  /** Returns definitions in registration order. */
  list(): EffectiveToolDefinition[] {
    return [...this.definitions.values()];
  }
}
