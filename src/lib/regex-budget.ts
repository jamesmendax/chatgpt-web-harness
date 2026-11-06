import vm from "node:vm";

/**
 * A model-supplied regex runs on the server's only JavaScript thread, so one
 * catastrophic pattern (e.g. ^(a+)+$ on a long line) froze every tool of every
 * conversation. Run it inside a vm script with a deadline instead: V8
 * interrupts the backtracking and the caller gets REGEX_TIMEOUT.
 */
const MATCH = new vm.Script("hits.length = 0; for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) hits.push(i);");
const REPLACE = new vm.Script("out = text.replace(re, repl);");

export class RegexTimeoutError extends Error {
  readonly code = "REGEX_TIMEOUT";
  constructor(timeoutMs: number) {
    super(`REGEX_TIMEOUT: the pattern did not finish within ${Math.round(timeoutMs / 1000)}s (likely catastrophic backtracking). Simplify it, anchor it, or use grep for large trees.`);
  }
}

function run(script: vm.Script, context: vm.Context, timeoutMs: number): void {
  try {
    script.runInContext(context, { timeout: Math.max(1, Math.floor(timeoutMs)) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new RegexTimeoutError(timeoutMs);
    throw error;
  }
}

/** Reusable per search: returns the indexes of matching lines. */
export function createLineMatcher(re: RegExp): (lines: string[], timeoutMs: number) => number[] {
  const context = vm.createContext({ re, lines: [] as string[], hits: [] as number[] });
  return (lines, timeoutMs) => {
    context.lines = lines;
    run(MATCH, context, timeoutMs);
    return [...(context.hits as number[])];
  };
}

export function replaceWithDeadline(text: string, re: RegExp, replacement: string, timeoutMs: number): string {
  const context = vm.createContext({ text, re, repl: replacement, out: "" });
  run(REPLACE, context, timeoutMs);
  return context.out as string;
}
