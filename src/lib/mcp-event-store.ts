import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { writeTextFileCas } from "./safe-text-write.js";

interface StoredMcpEvent {
  readonly event_id: string;
  readonly stream_id: string;
  readonly stored_at: string;
  readonly message: JSONRPCMessage;
}

interface McpEventStoreState {
  readonly schema_version: 1;
  readonly session_fingerprint: string;
  readonly next_sequence: number;
  readonly events: readonly StoredMcpEvent[];
  readonly updated_at: string;
}

interface StateSnapshot {
  readonly state: McpEventStoreState;
  readonly sha256: string | null;
}

export interface PersistentMcpEventStoreOptions {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly maxEvents?: number;
  readonly maxBytes?: number;
  readonly retentionMs?: number;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), min), max);
}

function eventStoreRoot(workspaceRoot: string): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  return path.join(home, "chatgpt-local-coder", "mcp-sse-events", sha256(path.resolve(workspaceRoot)));
}

function cloneMessage(message: JSONRPCMessage): JSONRPCMessage {
  // The SDK also uses an empty object as a resumability priming event. JSON
  // round-tripping gives the durable store a detached, serializable snapshot.
  const serialized = JSON.stringify(message);
  if (serialized === undefined) throw new Error("MCP_EVENT_NOT_SERIALIZABLE");
  return JSON.parse(serialized) as JSONRPCMessage;
}

function parseState(raw: string, expectedFingerprint: string): McpEventStoreState {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("MCP_EVENT_STORE_CORRUPT"); }
  if (!value || typeof value !== "object") throw new Error("MCP_EVENT_STORE_CORRUPT");
  const state = value as Partial<McpEventStoreState>;
  if (
    state.schema_version !== 1 ||
    state.session_fingerprint !== expectedFingerprint ||
    !Number.isSafeInteger(state.next_sequence) ||
    (state.next_sequence as number) < 1 ||
    !Array.isArray(state.events) ||
    typeof state.updated_at !== "string"
  ) throw new Error("MCP_EVENT_STORE_CORRUPT");
  for (const event of state.events) {
    if (
      !event || typeof event !== "object" ||
      typeof event.event_id !== "string" || !event.event_id ||
      typeof event.stream_id !== "string" || !event.stream_id ||
      typeof event.stored_at !== "string" || !Number.isFinite(Date.parse(event.stored_at)) ||
      !event.message || typeof event.message !== "object"
    ) throw new Error("MCP_EVENT_STORE_CORRUPT");
  }
  return state as McpEventStoreState;
}

/**
 * Bounded, account-local MCP SSE cursor store. JSON request/response traffic
 * remains JSON; this store only makes actual SSE notifications and responses
 * resumable through Last-Event-ID. Event and stream identifiers are opaque,
 * and the raw MCP session id never appears in a filename.
 */
export class PersistentMcpEventStore implements EventStore {
  private readonly sessionFingerprint: string;
  private readonly file: string;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly retentionMs: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: PersistentMcpEventStoreOptions) {
    const normalizedSessionId = options.sessionId.trim();
    if (!normalizedSessionId) throw new Error("MCP_EVENT_SESSION_REQUIRED");
    this.sessionFingerprint = sha256(normalizedSessionId);
    this.file = path.join(eventStoreRoot(options.workspaceRoot), `${this.sessionFingerprint}.json`);
    this.maxEvents = boundedInt(options.maxEvents, 2048, 1, 16_384);
    this.maxBytes = boundedInt(options.maxBytes, 16 * 1024 * 1024, 1024, 128 * 1024 * 1024);
    this.retentionMs = boundedInt(options.retentionMs, 24 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  private emptyState(): McpEventStoreState {
    return Object.freeze({
      schema_version: 1,
      session_fingerprint: this.sessionFingerprint,
      next_sequence: 1,
      events: Object.freeze([]),
      updated_at: new Date().toISOString(),
    });
  }

  private async readSnapshot(): Promise<StateSnapshot> {
    let raw: string;
    try { raw = await fs.readFile(this.file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: this.emptyState(), sha256: null };
      throw error;
    }
    return { state: parseState(raw, this.sessionFingerprint), sha256: sha256(raw) };
  }

  private prune(events: readonly StoredMcpEvent[], nowMs: number): readonly StoredMcpEvent[] {
    const cutoff = nowMs - this.retentionMs;
    const kept = events.filter((event) => Date.parse(event.stored_at) >= cutoff).slice(-this.maxEvents);
    let bytes = kept.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event)), 0);
    while (kept.length > 1 && bytes > this.maxBytes) {
      bytes -= Buffer.byteLength(JSON.stringify(kept.shift()));
    }
    if (kept.length === 1 && bytes > this.maxBytes) throw new Error("MCP_EVENT_TOO_LARGE");
    return Object.freeze(kept);
  }

  private async publish(state: McpEventStoreState, expectedSha256: string | null): Promise<void> {
    const content = `${JSON.stringify(state)}\n`;
    await writeTextFileCas(
      this.file,
      content,
      expectedSha256 ? { expectedSha256 } : { createOnly: true }
    );
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const normalizedStreamId = streamId.trim();
    if (!normalizedStreamId) throw new Error("MCP_EVENT_STREAM_REQUIRED");
    const durableMessage = cloneMessage(message);
    return this.enqueue(async () => {
      const eventId = `evt_${this.sessionFingerprint.slice(0, 12)}_${randomBytes(12).toString("base64url")}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        const snapshot = await this.readSnapshot();
        const now = new Date();
        const event: StoredMcpEvent = Object.freeze({
          event_id: eventId,
          stream_id: normalizedStreamId,
          stored_at: now.toISOString(),
          message: durableMessage,
        });
        const next: McpEventStoreState = Object.freeze({
          schema_version: 1,
          session_fingerprint: this.sessionFingerprint,
          next_sequence: snapshot.state.next_sequence + 1,
          events: this.prune([...snapshot.state.events, event], now.getTime()),
          updated_at: now.toISOString(),
        });
        try {
          await this.publish(next, snapshot.sha256);
          return eventId;
        } catch (error) {
          if (!String(error).includes("WRITE_CONFLICT") || attempt === 3) throw error;
        }
      }
      throw new Error("MCP_EVENT_STORE_BUSY");
    });
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return this.enqueue(async () => {
      const { state } = await this.readSnapshot();
      return state.events.find((event) => event.event_id === eventId)?.stream_id;
    });
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }
  ): Promise<string> {
    return this.enqueue(async () => {
      const { state } = await this.readSnapshot();
      const cursor = state.events.findIndex((event) => event.event_id === lastEventId);
      if (cursor < 0) throw new Error("MCP_EVENT_CURSOR_NOT_FOUND");
      const streamId = state.events[cursor].stream_id;
      for (const event of state.events.slice(cursor + 1)) {
        if (event.stream_id === streamId) await send(event.event_id, event.message);
      }
      return streamId;
    });
  }
}

