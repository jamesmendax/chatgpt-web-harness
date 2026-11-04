import { resolveExecutionContractReference } from "./execution-contract.js";
import type { RuntimeScope } from "./runtime-scope.js";

export interface IntentReference { intent_revision: number; requirement_hash: string }
/** _intent remains a JSON string. Recognize the compact reference form only. */
export function parseIntentReference(value: unknown): IntentReference | null {
  if (typeof value !== "string") return null;
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { return null; }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded) || !("reference" in decoded)) return null;
  const outer = decoded as Record<string, unknown>;
  const ref = outer.reference;
  if (Object.keys(outer).length !== 1 || !ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error("INTENT_REFERENCE_INVALID: malformed reference");
  const record = ref as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "intent_revision,requirement_hash" ||
      !Number.isSafeInteger(record.intent_revision) || (record.intent_revision as number) < 1 ||
      typeof record.requirement_hash !== "string" || !/^[a-f0-9]{64}$/.test(record.requirement_hash)) {
    throw new Error("INTENT_REFERENCE_INVALID: malformed reference");
  }
  return { intent_revision: record.intent_revision as number, requirement_hash: record.requirement_hash };
}
export function resolveIntentReference(scope: RuntimeScope, reference: IntentReference) {
  return resolveExecutionContractReference(scope.workspaceRoot, scope.mcpSessionId, scope.goalId,
    reference.intent_revision, reference.requirement_hash);
}
