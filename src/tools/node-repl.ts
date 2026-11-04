import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { isComputerUseEnabled } from "../lib/plugin-config.js";
import { getComputerUseProvider } from "../lib/computer-use-registry.js";
import type { ComputerUseRequest } from "../lib/computer-use-provider.js";
import { currentProviderScope } from "../lib/provider-scope.js";
import { getRuntimeScope, runWithRuntimeScope } from "../lib/runtime-scope.js";

interface ReplState {
  worker?: Worker;
  queue: Promise<unknown>;
  pending: number;
  lastUsed: number;
}
const states = new Map<string, ReplState>();
const MAX_SESSIONS = 32;
const IDLE_MS = 2 * 60 * 60_000;
let nextEval = 0;
let cleanup: NodeJS.Timeout | undefined;
async function stop(state: ReplState): Promise<void> {
  const worker = state.worker;
  state.worker = undefined;
  if (worker) await worker.terminate();
}
function prune(): void {
  for (const [key, entry] of states) {
    if (!entry.pending && Date.now() - entry.lastUsed >= IDLE_MS) {
      states.delete(key);
      void stop(entry);
    }
  }
}
function session(key: string): ReplState {
  prune();
  let state = states.get(key);
  if (!state) {
    if (states.size >= MAX_SESSIONS) {
      const oldest = [...states].filter(([, entry]) => !entry.pending).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) throw new Error("Node REPL session capacity reached; wait for an active call");
      states.delete(oldest[0]);
      void stop(oldest[1]);
    }
    state = { queue: Promise.resolve(), pending: 0, lastUsed: Date.now() };
    states.set(key, state);
  }
  if (!cleanup) { cleanup = setInterval(prune, 60_000); cleanup.unref(); }
  return state;
}
/** Shutdown/test cleanup; idle workers never keep the MCP process alive. */
export async function closeNodeReplSessions(): Promise<void> {
  if (cleanup) clearInterval(cleanup);
  cleanup = undefined;
  const pending = [...states.values()].map(stop);
  states.clear();
  await Promise.all(pending);
}
async function evaluate(state: ReplState, workspaceRoot: string, code: string, timeout: number) {
  const scope = getRuntimeScope();
  if (scope?.signal?.aborted) throw new Error("Node REPL evaluation cancelled before execution");
  if (!state.worker) {
    const created = new Worker(new URL("../lib/node-repl-worker.js", import.meta.url), {
      workerData: { workspaceRoot }, resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    state.worker = created;
    created.on("error", () => { if (state.worker === created) state.worker = undefined; });
    created.on("exit", () => { if (state.worker === created) state.worker = undefined; });
  }
  const worker = state.worker;
  worker.ref();
  const id = ++nextEval;
  const cancellation = new AbortController();
  const callScope = scope ? { ...scope, signal: cancellation.signal } : undefined;
  let image: Buffer | undefined;
  const reply = await new Promise<{ output: string; value?: string }>((resolve, reject) => {
    let done = false;
    const detach = () => {
      clearTimeout(timer);
      scope?.signal?.removeEventListener("abort", abort);
      worker.off("message", message); worker.off("error", failure); worker.off("exit", exited);
      worker.unref();
    };
    const failure = (error: Error) => { if (!done) { done = true; cancellation.abort(); detach(); reject(error); } };
    const exited = (exitCode: number) => failure(new Error(`Node REPL worker exited (${exitCode}); session reset`));
    const terminate = async (reason: string) => {
      if (done) return;
      done = true;
      cancellation.abort();
      detach();
      await stop(state);
      reject(new Error(`${reason}; execution terminated and session reset; already dispatched external effects may have completed`));
    };
    const abort = () => { void terminate("Node REPL evaluation cancelled"); };
    const timer = setTimeout(() => { void terminate(`node_repl eval exceeded ${timeout}ms`); }, timeout);
    const message = (value: { id: number; kind: string; output: string; value?: string; error?: string; code?: string; requestId: number; request: ComputerUseRequest }) => {
      if (done || value.id !== id) return;
      if (value.kind === "computer_use") {
        const dispatch = async () => {
          if (!isComputerUseEnabled()) throw new Error("Computer Use is disabled for this Desktop account");
          const result = await getComputerUseProvider().execute(value.request);
          if (!done && result.image) image = result.image;
          return result.data;
        };
        const operation = callScope ? runWithRuntimeScope(callScope, dispatch) : Promise.reject(new Error("Computer Use requires a trusted invocation scope"));
        void operation.then(data => {
          if (!done) worker.postMessage({ kind: "bridge_result", id, requestId: value.requestId, data });
        }, error => {
          if (!done) worker.postMessage({ kind: "bridge_result", id, requestId: value.requestId, error: error instanceof Error ? error.message : String(error) });
        });
        return;
      }
      if (value.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") { void terminate(`node_repl eval exceeded ${timeout}ms`); return; }
      done = true;
      cancellation.abort();
      detach();
      if (value.error) reject(new Error(value.error));
      else resolve({ output: value.output, value: value.value });
    };
    worker.on("message", message); worker.once("error", failure); worker.once("exit", exited);
    scope?.signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({ kind: "eval", id, code, timeout });
  });
  const envelope = toolResult("node_repl", { ...reply, computer_use_tool_enabled: isComputerUseEnabled() });
  return image ? { ...envelope, content: [...envelope.content, { type: "image" as const, data: image.toString("base64"), mimeType: "image/png" }] } : envelope;
}
export function registerNodeReplTool(server: McpServer, workspaceRoot: string): void {
  const fallback = randomUUID();
  server.registerTool("node_repl", {
    title: "Node REPL",
    description: "Stateful JavaScript session, isolated by trusted conversation. Store state on globalThis. Timeout/cancellation resets the session. Prefer computer_use; when unavailable in the client snapshot, sky.computerUse(request) (alias sky.computer_use) uses the same provider and returns screenshots.",
    inputSchema: {
      action: z.enum(["eval", "reset", "status"]).default("eval"),
      code: z.string().optional().describe("JavaScript. Use globalThis for state across calls; nodeRepl.write() emits text."),
      timeout_ms: z.number().int().min(100).max(60000).optional().default(30000),
    },
    annotations: toolAnnotations("edit"),
  }, async ({ action, code, timeout_ms }) => {
    const state = session(getRuntimeScope() ? currentProviderScope().key : fallback);
    state.pending++;
    const run = state.queue.then(async () => {
      if (getRuntimeScope()?.signal?.aborted) throw new Error("Node REPL evaluation cancelled before execution");
      if (action === "reset") { await stop(state); return toolResult("node_repl", { reset: true }); }
      if (action === "status") return toolResult("node_repl", {
        persistent: true, session_initialized: Boolean(state.worker), idle_ttl_ms: IDLE_MS, computer_use_tool_enabled: isComputerUseEnabled(),
        computer_use_fallback: "globalThis.sky.computerUse(request)",
      });
      if (!code?.trim()) throw new Error("code is required for node_repl eval");
      return evaluate(state, workspaceRoot, code, timeout_ms ?? 30000);
    });
    state.queue = run.then(() => undefined, () => undefined);
    try { return await run; }
    finally { state.pending--; state.lastUsed = Date.now(); }
  });
}
