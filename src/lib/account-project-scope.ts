import { createHash } from "node:crypto";
import path from "node:path";
import { getRuntimeScope } from "./runtime-scope.js";

/**
 * Keep accounts separate even when a host configures a shared CODEX_HOME.
 * Unscoped legacy data remains in place and is not automatically attributed.
 */
export function accountProjectDir(projectDir: string): string {
  const scope = getRuntimeScope();
  if (!scope?.principalId) return projectDir;
  const key = createHash("sha256").update(JSON.stringify([scope.principalId, scope.tunnelProfile ?? ""])).digest("hex");
  return path.join(projectDir, "accounts-v1", key);
}