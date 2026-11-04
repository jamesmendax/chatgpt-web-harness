import { Worker } from "node:worker_threads";
import { getRuntimeScope } from "./runtime-scope.js";
import { synchronousCommandBudget } from "./transport-resilience.js";
import { MAX_SEARCH_MS, type GrepOptions, type GrepSearchPage } from "./grep-search-core.js";

export { GREP_MAX_OUTPUT_CHARS } from "./grep-search-core.js";
export type { GrepOutputMode, GrepSearchPage } from "./grep-search-core.js";

// A clock check around RegExp.test cannot interrupt catastrophic backtracking.
// Keep all matching off the MCP event loop so health, cancellation and other
// tools remain responsive. Waiting for a worker counts against the same limit.
const MAX_WORKERS = 2;
let activeWorkers = 0;
const waiting = new Set<() => void>();

function drain(): void {
  for (const start of waiting) {
    if (activeWorkers >= MAX_WORKERS) break;
    waiting.delete(start);
    start();
  }
}

function incomplete(options: GrepOptions, reason: string): GrepSearchPage {
  return {
    output: `[search incomplete: ${reason}. Narrow the path or simplify the pattern.]`,
    offset: Math.max(0, Math.floor(options.offset ?? 0)),
    rows: 0, next_offset: null, complete: false, truncated: true,
    reasons: [reason], visited_files: 0, total_matches_observed: 0,
  };
}

export async function grepSearchPage(options: GrepOptions): Promise<GrepSearchPage> {
  const scope = getRuntimeScope();
  const signal = scope?.signal;
  const budget = synchronousCommandBudget(MAX_SEARCH_MS, scope?.deadlineAt);
  if (signal?.aborted) return incomplete(options, "cancelled");
  if (budget <= 0) return incomplete(options, "time budget");

  return new Promise<GrepSearchPage>((resolve, reject) => {
    let settled = false;
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result?: GrepSearchPage, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      waiting.delete(start);
      // Termination may need time to release a blocked filesystem operation.
      // The caller's deadline does not wait for it, while its slot stays held.
      if (worker) void worker.terminate().catch(() => undefined);
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = (): void => finish(incomplete(options, "cancelled"));
    const start = (): void => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      try {
        worker = new Worker(new URL("./grep-search-worker.js", import.meta.url), {
          workerData: options,
          execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")),
          resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
        });
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error("Search worker could not start"));
        queueMicrotask(drain);
        return;
      }
      activeWorkers++;
      worker.once("message", (message: { result?: GrepSearchPage; error?: { name: string; message: string; code?: string } }) => {
        if (message.error) {
          const error = message.error.name === "SyntaxError"
            ? new SyntaxError(message.error.message) : new Error(message.error.message);
          if (message.error.code) Object.assign(error, { code: message.error.code });
          finish(undefined, error);
        } else if (message.result) finish(message.result);
        else finish(undefined, new Error("Search worker returned no result"));
      });
      worker.once("error", (error) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
      worker.once("exit", () => {
        activeWorkers--;
        if (!settled) finish(undefined, new Error("Search worker exited before returning a result"));
        drain();
      });
    };
    timer = setTimeout(() => finish(incomplete(options, "time budget")), budget);
    signal?.addEventListener("abort", abort, { once: true });
    waiting.add(start);
    drain();
  });
}

export async function grepSearch(options: GrepOptions): Promise<string> {
  return (await grepSearchPage(options)).output;
}
