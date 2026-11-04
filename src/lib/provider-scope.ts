import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeScope } from "./runtime-scope.js";

export interface ProviderScope {
  /** Stable across transports; never derived from tool arguments. */
  readonly key: string;
  /** Changes when the authoritative Goal or owner changes. */
  readonly binding: string;
  /** Only prevents queued work from starting; an in-flight effect is never replayed. */
  readonly signal?: AbortSignal;
  /** Gateway-owned deferred admission check; never supplied by the caller. */
  readonly beforeDispatch?: () => Promise<void>;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Resolve inside a gateway callback, after trusted invocation scope is installed. */
export function currentProviderScope(): ProviderScope {
  const scope = getRuntimeScope();
  if (!scope?.mcpSessionId || !scope.workspaceRoot) {
    throw new Error("Provider sessions require a trusted invocation scope");
  }
  let workspace = path.resolve(scope.workspaceRoot);
  try {
    workspace = fs.realpathSync.native(workspace);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (process.platform === "win32") workspace = workspace.toLowerCase();
  return Object.freeze({
    key: digest([
      "harness-provider-session-v1",
      scope.mcpSessionId,
      workspace,
      scope.principalId ?? null,
      scope.tunnelProfile ?? null,
    ]),
    binding: digest([
      "harness-provider-binding-v1",
      scope.goalId ?? null,
      scope.goalOwnerSessionId ?? null,
      scope.goalStatus ?? null,
    ]),
    signal: scope.signal,
    beforeDispatch: scope.beforeDispatch,
  });
}
