import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, RequestId } from "@modelcontextprotocol/sdk/types.js";
import { appendActivity } from "./activity-log.js";
import { getMcpRequestIdentity } from "./mcp-request-identity.js";
import { observeMcpFinalOutcome } from "./mcp-outcome.js";

const installed = new WeakSet<Server>();
const wrapped = new WeakSet<Transport>();
const calls = new AsyncLocalStorage<{ tool: string; requestId: RequestId; started: number }>();

/** Observe the SDK's actual response, including both input and output validation. */
export function installMcpFinalOutcomeObserver(server: Server): void {
  if (installed.has(server)) return;
  installed.add(server);
  const connect = server.connect.bind(server);
  server.connect = async (transport) => {
    if (!wrapped.has(transport)) {
      wrapped.add(transport);
      const start = transport.start.bind(transport);
      // Protocol installs onmessage before start. Wrap it there so even a
      // transport that delivers buffered requests during start is covered.
      transport.start = async () => {
        const receive = transport.onmessage;
        transport.onmessage = (message, extra) => {
          if ("method" in message && message.method === "tools/call" &&
              "id" in message && typeof message.params?.name === "string") {
            return calls.run({ tool: message.params.name, requestId: message.id, started: Date.now() },
              () => receive?.(message, extra));
          }
          return receive?.(message, extra);
        };
        await start();
      };
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        const call = calls.getStore();
        if (call && "id" in message && message.id === call.requestId &&
            ("result" in message || "error" in message)) {
          try {
            const result = "result" in message ? message.result : undefined;
            // Task acknowledgements do not represent a completed tool result.
            if (!result || Array.isArray(result.content)) {
              const final = observeMcpFinalOutcome({ requestId: call.requestId, tool: call.tool,
                result: result as CallToolResult | undefined, rpcError: "error" in message });
              // The SDK converts a thrown handler error into a successful RPC
              // envelope containing isError:true. The canonical tool lifecycle
              // already records that failure; update the stored RPC outcome for
              // HTTP consumption without appending the same tool error twice.
              // SDK input/output rejection still creates/corrects tool status.
              if (final && (!final.previous ||
                  final.previous.tool_result_status !== final.outcome.tool_result_status)) {
                const { outcome } = final;
                const identity = getMcpRequestIdentity();
                appendActivity({ kind: "tool", action: "tools/call", tool: call.tool,
                  status: outcome.tool_result_status === "success" ? "ok"
                    : outcome.tool_result_status === "running" ? "running"
                    : outcome.tool_result_status === "unknown" ? "unknown" : "error",
                  duration_ms: Math.max(0, Date.now() - call.started),
                  session_id: identity?.transportSessionId,
                  conversation_id: identity?.conversationSessionId,
                  summary: outcome.failure?.error_summary ?? "Tool call completed",
                  details: { invocation_id: outcome.invocation_id, canonical_lifecycle: true,
                    sdk_final_result: true, ...(outcome.failure ?? {}) },
                });
              }
            }
          } catch { /* Diagnostics must not change delivery of the SDK response. */ }
        }
        await send(message, options);
      };
    }
    await connect(transport);
  };
}
