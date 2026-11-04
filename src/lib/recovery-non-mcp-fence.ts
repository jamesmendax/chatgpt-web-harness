import type { NextFunction, Request, Response } from "express";
import { recoveryStrictEnabled } from "./recovery-integrity.js";

/**
 * Temporary RI ingress boundary: these channels have no independently
 * trustworthy per-effect authorization adapter. Until they do, NONE of their
 * requests are executable in the isolated strict preview. In particular,
 * GET is not inherently read-only: OAuth completion and relay command claims
 * are effectful GETs.
 *
 * The main full-service entrypoint still refuses strict mode entirely. This
 * module protects direct mounts/launchers and supports isolated negative tests;
 * it is not an alternative way to enable shared runtime Recovery Integrity.
 */
function strictOrInvalid(): boolean {
  try {
    return recoveryStrictEnabled();
  } catch {
    // Unknown or malformed strict configuration must not become an allow.
    return true;
  }
}

/** Mount before OAuth callbacks, Companion auth, all Admin routes and UI. */
export function recoveryNonMcpHttpFence(
  _req: Request, res: Response, next: NextFunction
): void {
  if (!strictOrInvalid()) {
    next();
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(423).json({
    ok: false,
    error: "RI_NON_MCP_BLOCKED",
    detail: "Admin and Companion HTTP surfaces are unavailable in the isolated Recovery Integrity preview.",
    next_action: "Use read-only reconciliation; a separately verified adapter is required before enabling any HTTP effect.",
  });
}

/** Guard direct background launcher entrypoints before timers, files or spawn. */
export function assertRecoveryBackgroundIngress(entry: string): void {
  if (!strictOrInvalid()) return;
  throw new Error(`RI_NON_MCP_BLOCKED: ${entry} is not an authorized background effect adapter in the isolated Recovery Integrity preview`);
}
