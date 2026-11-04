import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";

import type { McpUpstreamManager } from "./mcp-upstream-manager.js";
import type { UpstreamServerConfig } from "./mcp-upstream-config.js";
import { toolAnnotations } from "./tool-annotations.js";
import { getRuntimeScope } from "./runtime-scope.js";

interface ProxyEntry {
  registered: RegisteredTool;
  ownerId: string;
  upstreamToolName: string;
}

interface DesiredProxy {
  config: UpstreamServerConfig;
  tool?: Tool;
  preserveExisting: boolean;
}

const proxyRegistry = new WeakMap<McpServer, Map<string, ProxyEntry>>();
const refreshQueues = new WeakMap<McpServer, Promise<string[]>>();

function getRegistry(server: McpServer): Map<string, ProxyEntry> {
  let map = proxyRegistry.get(server);
  if (!map) {
    map = new Map();
    proxyRegistry.set(server, map);
  }
  return map;
}

export interface ResolvedProxyOwner {
  ownerId: string;
  upstreamToolName: string;
}

export function getResolvedProxyOwner(
  server: McpServer,
  proxyName: string
): ResolvedProxyOwner | undefined {
  const entry = getRegistry(server).get(proxyName);
  return entry
    ? { ownerId: entry.ownerId, upstreamToolName: entry.upstreamToolName }
    : undefined;
}

function jsonSchemaNodeToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== "object") return z.any();

  const node = schema as {
    type?: string | string[];
    description?: string;
    enum?: unknown[];
    const?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
    items?: unknown;
    additionalProperties?: boolean | unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    nullable?: boolean;
  };

  let field: z.ZodTypeAny;

  const literalValues = Array.isArray(node.enum)
    ? node.enum.filter(
        (value): value is string | number | boolean | null =>
          value === null || ["string", "number", "boolean"].includes(typeof value)
      )
    : [];

  if (
    node.const === null ||
    ["string", "number", "boolean"].includes(typeof node.const)
  ) {
    field = z.literal(node.const as string | number | boolean | null);
  } else if (literalValues.length === 1) {
    field = z.literal(literalValues[0]);
  } else if (literalValues.length > 1) {
    const literals = literalValues.map((value) => z.literal(value));
    field = z.union(
      literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
    );
  } else {
    const variants = node.oneOf ?? node.anyOf;
    if (Array.isArray(variants) && variants.length > 0) {
      const options = variants.map(jsonSchemaNodeToZod);
      field =
        options.length === 1
          ? options[0]
          : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    } else {
      const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
      const nonNullTypes = types.filter((type) => type !== "null");

      const schemaForType = (type: string): z.ZodTypeAny => {
        if (type === "string") return z.string();
        if (type === "number") return z.number();
        if (type === "integer") return z.number().int();
        if (type === "boolean") return z.boolean();
        if (type === "array") return z.array(jsonSchemaNodeToZod(node.items));
        if (type !== "object" && !node.properties) return z.any();

        const required = new Set(Array.isArray(node.required) ? node.required : []);
        const shape: Record<string, z.ZodTypeAny> = {};
        for (const [key, child] of Object.entries(node.properties ?? {})) {
          const childSchema = jsonSchemaNodeToZod(child);
          shape[key] = required.has(key) ? childSchema : childSchema.optional();
        }

        // Be intentionally permissive at proxy boundaries. We preserve the
        // declared properties/types but allow extra fields so a lossy JSON
        // Schema -> Zod conversion can never reject valid upstream output.
        return z.object(shape).passthrough();
      };

      const effectiveTypes = nonNullTypes.length
        ? nonNullTypes
        : node.properties
          ? ["object"]
          : [];
      const options = effectiveTypes.map(schemaForType);
      field = options.length === 0
        ? z.any()
        : options.length === 1
          ? options[0]
          : z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);

      if (types.includes("null") || node.nullable) field = field.nullable();
    }
  }

  if (node.description) field = field.describe(node.description);
  return field;
}

export function jsonSchemaToZodShape(schema: Tool["inputSchema"]): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object") return {};
  const schemaObj = schema as { properties?: Record<string, unknown>; required?: string[] };
  const props = schemaObj.properties;
  if (!props || typeof props !== "object") return {};

  const required = new Set(Array.isArray(schemaObj.required) ? schemaObj.required : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const field = jsonSchemaNodeToZod(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function shouldExposeTool(config: UpstreamServerConfig, toolName: string): boolean {
  if (!config.enabled || config.expose === "none" || config.expose === "meta_only") return false;
  if ((config.disabled_tools ?? []).includes(toolName)) return false;
  return config.expose === "all" || (config.tools ?? []).includes(toolName);
}

export async function refreshProxiedTools(
  server: McpServer,
  manager: McpUpstreamManager,
  options?: RequestOptions
): Promise<string[]> {
  const requestOptions = withRuntimeSignal(options);
  const previous = refreshQueues.get(server) ?? Promise.resolve([] as string[]);
  const run = previous.catch(() => []).then(() => refreshProxiedToolsNow(server, manager, requestOptions));
  refreshQueues.set(server, run);
  try {
    return await run;
  } finally {
    if (refreshQueues.get(server) === run) refreshQueues.delete(server);
  }
}

async function refreshProxiedToolsNow(
  server: McpServer,
  manager: McpUpstreamManager,
  options?: RequestOptions
): Promise<string[]> {
  const signal = options?.signal;
  throwIfAborted(signal);
  const startingGeneration = readConfigGeneration(manager);
  const registry = getRegistry(server);
  const desired = new Map<string, DesiredProxy>();

  // Codex-style semantics: enabled upstream MCPs expose all of their tools.
  // Fetch tool lists concurrently so creating a ChatGPT MCP session does not
  // serialize network/auth latency across every configured upstream server.
  const enabled = manager.listServerConfigs().filter(
    (config) => config.enabled && config.expose !== "none" && config.expose !== "meta_only"
  );
  const upstreams = await Promise.all(
    enabled.map(async (config) => {
      try {
        throwIfAborted(signal);
        return {
          config,
          tools: await manager.listTools(config.id, options),
          failed: false,
        };
      } catch (error) {
        if (isAbortError(error, signal)) throw error;
        return { config, tools: [] as Tool[], failed: true };
      }
    })
  );

  throwIfAborted(signal);
  const endingGeneration = readConfigGeneration(manager);
  if (startingGeneration !== undefined && endingGeneration !== startingGeneration) {
    throw new Error("Upstream configuration changed during proxy refresh");
  }

  for (const { config, tools, failed } of upstreams) {
    const prefix = `${config.tool_prefix ?? config.id}__`;
    if (failed) {
      // Preserve only registrations that are still permitted by the current
      // config. A failed discovery must not resurrect a newly-disabled tool or
      // retain a proxy under an obsolete prefix.
      for (const [name, entry] of registry) {
        const expectedName = `${prefix}${entry.upstreamToolName}`;
        if (
          entry.ownerId === config.id &&
          name === expectedName &&
          shouldExposeTool(config, entry.upstreamToolName) &&
          !desired.has(name)
        ) {
          desired.set(name, { config, preserveExisting: true });
        }
      }
      continue;
    }

    for (const tool of tools) {
      if (!shouldExposeTool(config, tool.name)) continue;
      const proxyName = `${prefix}${tool.name}`;
      const collision = desired.get(proxyName);
      if (collision) {
        console.warn(`[MCP] Upstream tool name collision: ${proxyName}; keeping ${collision.config.id}`);
        continue;
      }
      desired.set(proxyName, { config, tool, preserveExisting: false });
    }
  }

  // Remove registrations that are no longer desired before adding their
  // replacements. This makes owner hand-over in a single refresh atomic from
  // the registry's perspective instead of dropping the new owner until a
  // later refresh.
  for (const [name, entry] of [...registry.entries()]) {
    const candidate = desired.get(name);
    if (!candidate || (!candidate.preserveExisting && candidate.config.id !== entry.ownerId)) {
      entry.registered.remove();
      registry.delete(name);
    }
  }

  for (const [proxyName, candidate] of desired) {
    if (candidate.preserveExisting) continue;
    const tool = candidate.tool!;
    const config = candidate.config;

    // Re-register successful discoveries even for the same owner so changed
    // descriptions, schemas, annotations and callbacks cannot remain stale.
    const previous = registry.get(proxyName);
    if (previous) {
      previous.registered.remove();
      registry.delete(proxyName);
    }

    const inputShape = jsonSchemaToZodShape(tool.inputSchema);
    const hasSchema = Object.keys(inputShape).length > 0;
    const outputShape = tool.outputSchema
      ? jsonSchemaToZodShape(tool.outputSchema as Tool["inputSchema"])
      : undefined;
    const hasOutputSchema = !!outputShape && Object.keys(outputShape).length > 0;

    const registered = server.registerTool(
      proxyName,
      {
        title: tool.title ?? tool.name,
        description: `[${config.name}] ${tool.description ?? tool.name}`,
        inputSchema: hasSchema ? inputShape : {},
        ...(hasOutputSchema ? { outputSchema: outputShape } : {}),
        annotations: tool.annotations ?? toolAnnotations("edit"),
      },
      async (args: Record<string, unknown>) => {
        // Transparent MCP proxy: preserve the upstream CallToolResult exactly
        // (text, images, embedded resources, structuredContent and isError).
        const signal = getRuntimeScope()?.signal;
        return (await manager.callTool(
          config.id,
          tool.name,
          args ?? {},
          signal ? { signal } : undefined
        )) as any;
      }
    );
    registry.set(proxyName, { registered, ownerId: config.id, upstreamToolName: tool.name });
  }

  return [...desired.keys()];
}

function withRuntimeSignal(options?: RequestOptions): RequestOptions | undefined {
  const signal = options?.signal ?? getRuntimeScope()?.signal;
  if (!signal) return options;
  if (options?.signal === signal) return options;
  return { ...options, signal };
}

function readConfigGeneration(manager: McpUpstreamManager): number | undefined {
  const getter = (manager as McpUpstreamManager & {
    getConfigGeneration?: () => number;
  }).getConfigGeneration;
  return typeof getter === "function" ? getter.call(manager) : undefined;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}

export function clearProxiedTools(server: McpServer): void {
  const registry = getRegistry(server);
  for (const entry of registry.values()) {
    entry.registered.remove();
  }
  registry.clear();
}
