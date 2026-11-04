import { ComputerUseProvider, type ComputerUseRequest } from "./computer-use-provider.js";
import { currentProviderScope, type ProviderScope } from "./provider-scope.js";

const IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 128;

interface Entry {
  provider: ComputerUseProvider;
  lastUsedAt: number;
  pending: number;
}

const entries = new Map<string, Entry>();
let cleanupTimer: NodeJS.Timeout | undefined;

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.pending === 0 && now - entry.lastUsedAt >= IDLE_TTL_MS) entries.delete(key);
  }
  if (!entries.size && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}

function entryFor(key: string): Entry {
  const now = Date.now();
  prune(now);
  let entry = entries.get(key);
  if (!entry) {
    if (entries.size >= MAX_SESSIONS) {
      let oldest: [string, Entry] | undefined;
      for (const candidate of entries) {
        if (candidate[1].pending === 0 &&
            (!oldest || candidate[1].lastUsedAt < oldest[1].lastUsedAt)) oldest = candidate;
      }
      if (!oldest) throw new Error("Computer Use session capacity reached; wait for an active operation to finish");
      entries.delete(oldest[0]);
    }
    entry = { provider: new ComputerUseProvider(), lastUsedAt: now, pending: 0 };
    entries.set(key, entry);
  }
  if (!cleanupTimer) {
    cleanupTimer = setInterval(() => prune(Date.now()), 60_000);
    cleanupTimer.unref();
  }
  return entry;
}

async function executeInScope(scope: ProviderScope, request: ComputerUseRequest) {
  const entry = entryFor(scope.key);
  entry.pending += 1;
  entry.lastUsedAt = Date.now();
  try {
    // The binding transition and action share the provider queue. Retarget,
    // screenshot, close and Goal changes cannot race across transport objects.
    return await entry.provider.execute(request, scope.binding, scope.signal, scope.beforeDispatch);
  } finally {
    entry.pending -= 1;
    entry.lastUsedAt = Date.now();
  }
}

/** A per-invocation facade; its state belongs to the trusted conversation, not the server. */
export function getComputerUseProvider() {
  const scope = currentProviderScope();
  return { execute: (request: ComputerUseRequest) => executeInScope(scope, request) };
}
