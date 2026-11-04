import { parentPort, workerData } from "node:worker_threads";
import { grepSearchPage, type GrepOptions } from "./grep-search-core.js";

if (parentPort) {
  try {
    parentPort.postMessage({ result: await grepSearchPage(workerData as GrepOptions) });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Search failed");
    parentPort.postMessage({
      error: { name: error.name, message: error.message,
        ...("code" in error ? { code: error.code } : {}) },
    });
  }
}
