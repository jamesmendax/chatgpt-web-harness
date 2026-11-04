import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import path from "node:path";
import util from "node:util";
import vm from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

const port = parentPort!;
interface Evaluation { id: number; output: string[] }
const calls = new AsyncLocalStorage<Evaluation>();
let active: number | undefined;
let nextRequest = 0;
const bridge = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function write(value: unknown): void {
  const call = calls.getStore();
  if (!call || call.id !== active) return;
  call.output.push(String(value));
}
function computerUse(request: unknown): Promise<unknown> {
  const call = calls.getStore();
  if (!call || call.id !== active) return Promise.reject(new Error("REPL evaluation has ended"));
  const requestId = ++nextRequest;
  return new Promise((resolve, reject) => {
    bridge.set(requestId, { resolve, reject });
    port.postMessage({ kind: "computer_use", id: call.id, requestId, request });
  });
}
const context = vm.createContext({
  Buffer, process, setTimeout, clearTimeout, fetch,
  require: createRequire(path.join(workerData.workspaceRoot, "package.json")),
  console: { log: (...values: unknown[]) => write(values.map(value => util.inspect(value, { depth: 4, maxStringLength: 16384 })).join(" ")) },
  nodeRepl: { write }, sky: Object.freeze({ computerUse, computer_use: computerUse }),
});
port.on("message", async (message) => {
  if (message.kind === "bridge_result") {
    const pending = bridge.get(message.requestId);
    bridge.delete(message.requestId);
    if (pending) message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.data);
    return;
  }
  if (message.kind !== "eval") return;
  active = message.id;
  const call: Evaluation = { id: message.id, output: [] };
  await calls.run(call, async () => {
    try {
      // VM timeout bounds synchronous execution. The parent terminates this
      // worker for async deadlines/cancellation, so late code cannot keep running.
      const value = await vm.runInContext(`(async () => { ${message.code}\n})()`, context, { timeout: message.timeout });
      port.postMessage({ kind: "result", id: message.id, output: call.output.join("\n"), value: value === undefined ? undefined : util.inspect(value, { depth: 5, maxArrayLength: 100, maxStringLength: 16384 }) });
    } catch (error) {
      port.postMessage({ kind: "result", id: message.id, error: error instanceof Error ? error.message : String(error), code: (error as NodeJS.ErrnoException)?.code });
    } finally { active = undefined; }
  });
});
