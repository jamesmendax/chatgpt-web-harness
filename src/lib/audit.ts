import fs from "fs/promises";
import path from "path";
import { appendActivity } from "./activity-log.js";
import { getAuditPath } from "./audit-path.js";

export type AuditStatus = "ok" | "error" | "blocked" | "dry-run";

export interface AuditEvent {
  tool: string;
  action: string;
  target?: string;
  status?: AuditStatus;
  details?: Record<string, unknown>;
}

const MAX_AUDIT_BYTES = 20 * 1024 * 1024;
let appendsSinceCheck = 0;

export async function audit(event: AuditEvent): Promise<void> {
  const record = {
    time: new Date().toISOString(),
    pid: process.pid,
    ...event,
  };

  try {
    const auditPath = getAuditPath();
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.appendFile(auditPath, JSON.stringify(record) + "\n", "utf-8");
    // The audit log only ever grew. Keep the current file plus one rotation.
    if ((++appendsSinceCheck % 64) === 0 && (await fs.stat(auditPath)).size > MAX_AUDIT_BYTES) {
      await fs.rm(`${auditPath}.1`, { force: true });
      await fs.rename(auditPath, `${auditPath}.1`);
    }
  } catch {
    // Audit must never break the requested tool call.
  }

  try {
    appendActivity({
      kind: "tool",
      tool: event.tool,
      action: event.action,
      target: event.target,
      status: event.status ?? "ok",
      summary: event.target || (event.details ? JSON.stringify(event.details).slice(0, 120) : undefined),
      details: event.details,
    });
  } catch {}
}

export { getAuditPath } from "./audit-path.js";
