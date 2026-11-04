export interface JsonRpcRequestLike {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcMethodNotFoundResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: -32601;
    message: "Method not found";
  };
}

/**
 * MCP protocol 2026-07-28 clients may probe a legacy server with the stateless
 * `server/discover` RPC before falling back to the legacy initialize handshake.
 * Our stateful Streamable HTTP transport intentionally does not implement that
 * RPC, but it must reject it at the JSON-RPC layer (HTTP 200), not at the HTTP
 * session layer (HTTP 400). A transport-level 400 can poison the client's
 * streamable connection before it has a chance to send legacy `initialize`.
 */
export function isServerDiscoverRequest(body: unknown): body is JsonRpcRequestLike {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const request = body as JsonRpcRequestLike;
  return request.jsonrpc === "2.0" && request.method === "server/discover";
}

export function buildServerDiscoverFallback(
  body: JsonRpcRequestLike
): JsonRpcMethodNotFoundResponse {
  const id =
    typeof body.id === "string" || typeof body.id === "number" || body.id === null
      ? body.id
      : null;

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: "Method not found",
    },
  };
}
