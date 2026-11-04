import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { GoalRunEvidence, GoalRunMetadataValue } from "./goal-run-state.js";
import { getVisualReviewFreshness } from "./visual-review-state.js";

/** A declared check has a narrower claim than overall task quality. */
export interface GoalVerification {
  kind: "command" | "visual" | "file_exists";
  target: string;
  command?: string;
  files?: string[];
}

export function normalizeGoalVerification(value: unknown): GoalVerification | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid criterion verification contract.");
  const v = value as Record<string, unknown>;
  if (!["command", "visual", "file_exists"].includes(String(v.kind)) || typeof v.target !== "string" || !path.isAbsolute(v.target) || v.target.length > 2000) {
    throw new Error("Criterion verification requires kind=command|visual|file_exists and an absolute target path.");
  }
  const target = path.resolve(v.target);
  if (v.kind !== "command") return { kind: v.kind as "visual" | "file_exists", target };
  if (typeof v.command !== "string" || !v.command.trim() || v.command.length > 2000 || !Array.isArray(v.files) || v.files.length < 1 || v.files.length > 128 || v.files.some((file) => typeof file !== "string" || !file.trim() || file.length > 2000)) {
    throw new Error("Command verification requires the exact command and 1-128 source/test files whose current bytes it verifies (relative to target or absolute).");
  }
  return { kind: "command", target, command: v.command.trim(), files: [...new Set((v.files as string[]).map((file) => path.resolve(target, file)))].sort() };
}

export function verificationDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left: unknown, right: string): boolean {
  if (typeof left !== "string" || !path.isAbsolute(left)) return false;
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function snapshotKey(contract: GoalVerification): string {
  return `verification_${verificationDigest(JSON.stringify(contract)).slice(0, 24)}`;
}

function commandInvocationMatches(contract: GoalVerification, metadata: Readonly<Record<string, GoalRunMetadataValue>>): boolean {
  return ["run_command", "start_process", "process_output", "process_status"].includes(String(metadata.tool)) &&
    metadata.commandHash === verificationDigest(contract.command ?? "") && samePath(metadata.cwd, contract.target);
}

export async function verificationFileHash(file: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes as Buffer);
  return digest.digest("hex");
}

async function sourceSnapshot(contract: GoalVerification): Promise<string> {
  const entries: string[] = [];
  for (const file of contract.files ?? []) entries.push(`${file}\n${await verificationFileHash(file)}`);
  return verificationDigest(entries.join("\n"));
}

function commandMatches(contract: GoalVerification, metadata: Readonly<Record<string, GoalRunMetadataValue>>): boolean {
  return commandInvocationMatches(contract, metadata) &&
    metadata.ok === true && metadata.exitCode === 0 && metadata.running !== true &&
    metadata.verificationSourceStable !== false;
}

/** Capture source bytes before a check starts, binding later evidence to its launch. */
export async function captureVerificationLaunchSnapshots(
  criteria: readonly { verification?: GoalVerification }[],
  metadata: Readonly<Record<string, GoalRunMetadataValue>>
): Promise<Record<string, GoalRunMetadataValue>> {
  const snapshots: Record<string, GoalRunMetadataValue> = {};
  for (const criterion of criteria) {
    const contract = criterion.verification;
    if (!contract || contract.kind !== "command" || !commandInvocationMatches(contract, metadata)) continue;
    try { snapshots[snapshotKey(contract)] = await sourceSnapshot(contract); }
    catch { /* Missing or unreadable sources cannot provide passing evidence. */ }
  }
  return snapshots;
}

/** Capture source bytes when the declared check finishes, preserving launch binding. */
export async function captureVerificationSnapshots(
  criteria: readonly { verification?: GoalVerification }[],
  metadata: Readonly<Record<string, GoalRunMetadataValue>>,
  launchSnapshots: Readonly<Record<string, GoalRunMetadataValue>>
): Promise<Record<string, GoalRunMetadataValue>> {
  const snapshots: Record<string, GoalRunMetadataValue> = {};
  for (const criterion of criteria) {
    const contract = criterion.verification;
    if (!contract || contract.kind !== "command" || !commandMatches(contract, metadata)) continue;
    const key = snapshotKey(contract);
    if (launchSnapshots[key] === undefined) continue;
    try {
      const completionSnapshot = await sourceSnapshot(contract);
      if (completionSnapshot === launchSnapshots[key]) snapshots[key] = completionSnapshot;
    }
    catch { /* Missing or unreadable sources cannot provide passing evidence. */ }
  }
  return snapshots;
}

/** Only the Web adapter can interpret a tool result against a declared criterion. */
export async function assertGoalCriterionVerified(
  workspaceRoot: string,
  criterion: { name: string; verification?: GoalVerification; requires_confirmation?: boolean },
  evidence: readonly GoalRunEvidence[]
): Promise<void> {
  if (criterion.requires_confirmation) return;
  const contract = criterion.verification;
  if (!contract) throw new Error(`GOAL_VERIFICATION_REQUIRED: "${criterion.name}" has no declared check. Use goal(action=update) to set this criterion's verification {kind,target,command,files}, run that check, then confirm its evidence. file_exists proves only file existence; use command for code tests and visual for appearance.`);
  for (const item of evidence) {
    const metadata = item.metadata;
    if (metadata.ok !== true || metadata.verifiesCriterion !== true || !item.source?.startsWith("native:")) continue;
    try {
      if (contract.kind === "command" && commandMatches(contract, metadata) &&
          typeof metadata[snapshotKey(contract)] === "string" && metadata[snapshotKey(contract)] === await sourceSnapshot(contract)) return;
      if (contract.kind === "file_exists" && metadata.tool === "file_info" && samePath(metadata.target, contract.target) &&
          typeof metadata.sha256 === "string" && metadata.sha256 === await verificationFileHash(contract.target)) return;
      if (contract.kind === "visual" && metadata.tool === "visual_review" && samePath(metadata.target, contract.target) && typeof metadata.reviewId === "string") {
        const fresh = await getVisualReviewFreshness(workspaceRoot, metadata.reviewId);
        if (fresh.fresh && fresh.machine_ready && fresh.model_visual_ready && fresh.model_visual_iteration_ready && fresh.model_visual_coverage.complete) return;
      }
    } catch { /* Stale, missing, or invalid evidence is rejected with an actionable error below. */ }
  }
  throw new Error(`GOAL_VERIFICATION_MISMATCH: evidence does not verify "${criterion.name}" (${contract.kind}: ${contract.target}) at its current source version. Re-run the declared check in the target directory after the last edit; file checks require file_info(sha256=true), visual checks require a fresh complete visual_review. A successful unrelated tool call is not acceptance evidence.`);
}
