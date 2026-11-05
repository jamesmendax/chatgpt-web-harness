import type { NextFunction, Request, Response } from "express";

/** Compatibility shims: retired product approvals never gate HTTP/background work. */
export function recoveryNonMcpHttpFence(_req: Request, _res: Response, next: NextFunction): void { next(); }
export function assertRecoveryBackgroundIngress(_entry: string): void {}
