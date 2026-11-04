import path from "node:path";

const auditPath = process.env.AUDIT_LOG_PATH || path.resolve(process.cwd(), ".mcp-audit.log");

export function getAuditPath(): string {
  return auditPath;
}