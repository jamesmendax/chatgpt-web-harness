import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRuntimeScope } from "./runtime-scope.js";
import { accountProjectDir } from "./account-project-scope.js";

export type VisualArtifactKind = "image" | "svg" | "html" | "url" | "pdf" | "pptx" | "docx";

export type VisualAssessmentVerdict = "pass" | "fail";
export type VisualComparisonVerdict = "improved" | "unchanged" | "regressed" | "not_compared";
export type VisualQualityBar = "draft" | "standard" | "polished";
export type VisualFirstImpression = "rough" | "acceptable" | "polished";
export type VisualDeliveryRecommendation = "reject" | "revise" | "accept";

export interface VisualQualityScores {
  task_fidelity: number;
  composition: number;
  visual_hierarchy: number;
  coherence: number;
  craft_precision: number;
  professional_readiness: number;
}

export interface ModelVisualCritique {
  inspected_full_render: true;
  first_impression: VisualFirstImpression;
  delivery_recommendation: VisualDeliveryRecommendation;
  quality_scores: VisualQualityScores;
  critical_issues: string[];
  major_issues: string[];
  minor_issues: string[];
  strengths: string[];
  improvement_opportunities: string[];
  further_improvement_worthwhile?: boolean;
  summary?: string;
  critiqued_at: string;
  source_signature?: string;
}

export interface VisualQualityGate {
  bar: VisualQualityBar;
  status: "pending" | "failed" | "acceptable";
  average_score?: number;
  minimum_score?: number;
  reasons: string[];
}

export interface ModelVisualAssessment {
  verdict: VisualAssessmentVerdict;
  inspected_full_render: true;
  issues: string[];
  comparison: VisualComparisonVerdict;
  strengths: string[];
  improvement_opportunities: string[];
  further_improvement_worthwhile?: boolean;
  summary?: string;
  assessed_at: string;
  source_signature?: string;
}

export interface VisualReviewRecord {
  version: 1 | 2 | 3 | 4;
  id: string;
  target: string;
  kind: VisualArtifactKind;
  quality_bar?: VisualQualityBar;
  renderer: string;
  source_path?: string;
  source_signature?: string;
  source_size?: number;
  source_mtime_ms?: number;
  overview_path?: string;
  output_paths: string[];
  page_paths: string[];
  page_count?: number;
  rendered_pages?: number[];
  delivered_pages?: number[];
  focus_paths: string[];
  comparison_path?: string;
  baseline_review_id?: string;
  machine_blocking_issues: string[];
  machine_advisories: string[];
  model_visual_critique?: ModelVisualCritique;
  model_visual_assessment?: ModelVisualAssessment;
  owner_session?: string;
  owner_scope?: string;
  review_history?: Array<{ action: string; at: string; source: string; session_id?: string; previous?: unknown }>;
  diagnostics: Record<string, unknown>;
  created_at: string;
}

export interface VisualReviewFreshness {
  review_id: string;
  fresh: boolean;
  verifiable: boolean;
  machine_ready: boolean;
  model_visual_ready: boolean;
  model_visual_iteration_ready: boolean;
  model_visual_status: "pending" | VisualAssessmentVerdict;
  model_visual_quality_status: "pending" | "failed" | "improvable" | "ready";
  model_visual_quality_gate: VisualQualityGate;
  model_visual_coverage: {
    page_count: number;
    passed_pages: number[];
    missing_pages: number[];
    complete: boolean;
  };
  model_visual_iteration: {
    current_iteration: number;
    max_iterations: number | null;
    limit_reached: boolean;
    further_improvement_worthwhile: boolean;
    continuation_required: boolean;
    termination_reason: "continue" | "no_worthwhile_improvement" | "max_iterations_reached";
    review_ids: string[];
    improvement_opportunities: string[];
  };
  reason: string;
  record: VisualReviewRecord;
  current_signature?: string;
}

const QUALITY_SCORE_KEYS: Array<keyof VisualQualityScores> = [
  "task_fidelity",
  "composition",
  "visual_hierarchy",
  "coherence",
  "craft_precision",
  "professional_readiness",
];

/** Quality preference and score scale are informational. */
export function visualQualityRequirements(bar: VisualQualityBar): Record<string, unknown> {
  return { quality_bar: bar, score_scale: "1–5", thresholds_enforced: false };
}

const visualReviewChains = new Map<string, Promise<void>>();

async function withVisualReviewLock<T>(
  workspaceRoot: string,
  reviewId: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = `${path.resolve(workspaceRoot).toLowerCase()}::${reviewId}`;
  const previous = visualReviewChains.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  visualReviewChains.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (visualReviewChains.get(key) === chain) visualReviewChains.delete(key);
  }
}

function qualityBarFor(record: VisualReviewRecord): VisualQualityBar {
  return record.quality_bar ?? "standard";
}

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean).slice(0, 30);
}

function normalizedQualityScores(scores: VisualQualityScores): VisualQualityScores {
  const next = {} as VisualQualityScores;
  for (const key of QUALITY_SCORE_KEYS) {
    const value = scores[key];
    if (!Number.isFinite(value) || value < 1 || value > 5) {
      throw new Error(`Visual quality score ${key} must be a finite number from 1 to 5.`);
    }
    next[key] = Math.round(value * 100) / 100;
  }
  return next;
}

export function evaluateVisualQualityGate(record: VisualReviewRecord): VisualQualityGate {
  const critique = record.model_visual_critique;
  if (!critique) return { bar: qualityBarFor(record), status: "pending", reasons: [] };
  const values = QUALITY_SCORE_KEYS.map(key => critique.quality_scores[key]);
  return { bar: qualityBarFor(record), status: "acceptable", average_score: values.reduce((a,b) => a+b,0)/values.length, minimum_score: Math.min(...values), reasons: [] };
}

async function siblingReviewRecords(workspaceRoot: string): Promise<VisualReviewRecord[]> {
  let names: string[] = [];
  try {
    names = (await fs.readdir(visualReviewDir(workspaceRoot))).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name));
  } catch {
    return [];
  }
  const records: VisualReviewRecord[] = [];
  for (const name of names) {
    try {
      records.push(JSON.parse(await fs.readFile(path.join(visualReviewDir(workspaceRoot), name), "utf-8")) as VisualReviewRecord);
    } catch {}
  }
  return records;
}

function pagesForRecord(record: VisualReviewRecord): number[] {
  if (record.delivered_pages?.length) return record.delivered_pages;
  if (!record.page_count || record.page_count <= 1) return [1];
  return [];
}

async function modelVisualCoverage(workspaceRoot: string, record: VisualReviewRecord): Promise<VisualReviewFreshness["model_visual_coverage"]> {
  const pageCount = Math.max(1, Math.floor(record.page_count || 1));
  const passed = new Set<number>();
  const candidates = record.source_signature
    ? (await siblingReviewRecords(workspaceRoot)).filter((candidate) =>
        candidate.target === record.target &&
        candidate.source_signature === record.source_signature &&
        candidate.owner_session === record.owner_session && candidate.owner_scope === record.owner_scope
      )
    : [record];
  for (const candidate of candidates) {
    const qualityGate = evaluateVisualQualityGate(candidate);
    if (candidate.model_visual_assessment?.verdict !== "pass" || !candidate.model_visual_assessment.inspected_full_render) continue;
    for (const pageNumber of pagesForRecord(candidate)) {
      if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) passed.add(pageNumber);
    }
  }
  const passedPages = [...passed].sort((a, b) => a - b);
  const missingPages = Array.from({ length: pageCount }, (_, index) => index + 1).filter((pageNumber) => !passed.has(pageNumber));
  return {
    page_count: pageCount,
    passed_pages: passedPages,
    missing_pages: missingPages,
    complete: missingPages.length === 0,
  };
}

async function modelVisualIterationState(
  workspaceRoot: string,
  record: VisualReviewRecord
): Promise<VisualReviewFreshness["model_visual_iteration"]> {
  const candidates = record.source_signature
    ? (await siblingReviewRecords(workspaceRoot)).filter((candidate) =>
        candidate.target === record.target &&
        candidate.source_signature === record.source_signature &&
        candidate.owner_session === record.owner_session && candidate.owner_scope === record.owner_scope
      )
    : [record];
  const improvable = candidates.filter((candidate) =>
    candidate.machine_blocking_issues.length === 0 &&
    candidate.model_visual_assessment?.verdict === "pass" &&
    evaluateVisualQualityGate(candidate).status === "acceptable" &&
    candidate.model_visual_critique?.further_improvement_worthwhile === true
  );
  const opportunities = [...new Set(improvable.flatMap((candidate) =>
    candidate.model_visual_critique?.improvement_opportunities ?? []
  ))].slice(0, 30);
  const allRecords = await siblingReviewRecords(workspaceRoot);
  const byId = new Map(allRecords.map((candidate) => [candidate.id, candidate]));
  const chain: VisualReviewRecord[] = [];
  const seen = new Set<string>();
  let cursor: VisualReviewRecord | undefined = record;
  while (cursor && !seen.has(cursor.id) && chain.length < 100) {
    chain.push(cursor);
    seen.add(cursor.id);
    if (!cursor.baseline_review_id) break;
    const baseline = byId.get(cursor.baseline_review_id);
    if (!baseline || baseline.target !== record.target) break;
    cursor = baseline;
  }
  chain.reverse();
  let currentIteration = 0;
  let previousVersionKey: string | undefined;
  for (const candidate of chain) {
    const versionKey = candidate.source_signature
      ? `source:${candidate.source_signature}`
      : `review:${candidate.id}`;
    if (versionKey !== previousVersionKey) {
      currentIteration += 1;
      previousVersionKey = versionKey;
    }
  }
  currentIteration = Math.max(1, currentIteration);
  return {
    current_iteration: currentIteration,
    max_iterations: null,
    limit_reached: false,
    further_improvement_worthwhile: improvable.length > 0,
    continuation_required: false,
    termination_reason: "no_worthwhile_improvement",
    review_ids: improvable.map(candidate => candidate.id),
    improvement_opportunities: opportunities,
  };
}

function projectSlug(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
}

export function visualReviewDir(workspaceRoot: string): string {
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(accountProjectDir(path.join(base, "projects", projectSlug(workspaceRoot))), "visual-reviews");
}

function reviewPath(workspaceRoot: string, reviewId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(reviewId)) throw new Error("VISUAL_REVIEW_ID_INVALID: Invalid visual review_id");
  return path.join(visualReviewDir(workspaceRoot), `${reviewId}.json`);
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", "utf-8");
  await fs.rename(temporary, filePath);
}

export async function fileSignature(filePath: string): Promise<{
  signature: string;
  size: number;
  mtime_ms: number;
}> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error("VISUAL_REVIEW_SOURCE_INVALID: Visual review source is not a regular file");
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
      if (bytesRead <= 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return {
    signature: hash.digest("hex"),
    size: stat.size,
    mtime_ms: stat.mtimeMs,
  };
}

function currentVisualOwner(): { session: string; scope: string } | null {
  const runtime = getRuntimeScope();
  const session = runtime?.conversationSessionId;
  if (runtime?.conversationContinuity !== "trusted" || !session) return null;
  return { session, scope: createHash("sha256").update(JSON.stringify([runtime?.principalId ?? "", runtime?.tunnelProfile ?? ""])).digest("hex") };
}

export async function saveVisualReviewRecord(
  workspaceRoot: string,
  input: Omit<VisualReviewRecord, "version" | "id" | "created_at">
): Promise<VisualReviewRecord> {
  const record: VisualReviewRecord = {
    version: 4,
    id: randomUUID(),
    ...input,
    quality_bar: input.quality_bar ?? "standard",
    created_at: new Date().toISOString(),
    ...(currentVisualOwner() ? { owner_session: currentVisualOwner()!.session, owner_scope: currentVisualOwner()!.scope } : {}),
  };
  await atomicWriteJson(reviewPath(workspaceRoot, record.id), record);
  return record;
}

export async function critiqueVisualReviewRecord(
  workspaceRoot: string,
  reviewId: string,
  input: {
    inspected_full_render: true;
    first_impression: VisualFirstImpression;
    delivery_recommendation: VisualDeliveryRecommendation;
    quality_scores: VisualQualityScores;
    critical_issues?: string[];
    major_issues?: string[];
    minor_issues?: string[];
    strengths?: string[];
    improvement_opportunities?: string[];
    further_improvement_worthwhile?: boolean;
    summary?: string;
  }
): Promise<VisualReviewRecord> {
  return withVisualReviewLock(workspaceRoot, reviewId, async () => {
  const record = await getVisualReviewRecord(workspaceRoot, reviewId);
  if (!record.delivered_pages?.length) throw new Error("VISUAL_IMAGES_UNAVAILABLE: no rendered image was delivered for inspection.");
  if (record.source_path && record.source_signature) {
    const current = await fileSignature(record.source_path);
    if (current.signature !== record.source_signature) {
      throw new Error("VISUAL_REVIEW_STALE: Cannot critique a stale visual review. Run visual_review again on the current source first.");
    }
  }

  const criticalIssues = normalizeList(input.critical_issues);
  const majorIssues = normalizeList(input.major_issues);
  const minorIssues = normalizeList(input.minor_issues);
  const strengths = normalizeList(input.strengths);
  const improvementOpportunities = normalizeList(input.improvement_opportunities);
  const summary = input.summary?.trim().slice(0, 4000) || undefined;
  const qualityScores = normalizedQualityScores(input.quality_scores);

  const critique: ModelVisualCritique = {
    inspected_full_render: true,
    first_impression: input.first_impression,
    delivery_recommendation: input.delivery_recommendation,
    quality_scores: qualityScores,
    critical_issues: criticalIssues,
    major_issues: majorIssues,
    minor_issues: minorIssues,
    strengths,
    improvement_opportunities: improvementOpportunities,
    ...(input.further_improvement_worthwhile !== undefined ? { further_improvement_worthwhile: input.further_improvement_worthwhile } : {}),
    ...(summary ? { summary } : {}),
    critiqued_at: new Date().toISOString(),
    ...(record.source_signature ? { source_signature: record.source_signature } : {}),
  };
  const next: VisualReviewRecord = {
    ...record,
    version: 4,
    model_visual_critique: critique,
    review_history: [...(record.review_history ?? []), { action: "critique", at: critique.critiqued_at, source: "calling_model", session_id: getRuntimeScope()?.mcpSessionId, previous: record.model_visual_critique }],
  };
  await atomicWriteJson(reviewPath(workspaceRoot, reviewId), next);
  return next;
  });
}

export async function assessVisualReviewRecord(
  workspaceRoot: string,
  reviewId: string,
  input: {
    verdict: VisualAssessmentVerdict;
    inspected_full_render: true;
    issues?: string[];
    comparison?: VisualComparisonVerdict;
    strengths?: string[];
    improvement_opportunities?: string[];
    further_improvement_worthwhile?: boolean;
    summary?: string;
  }
): Promise<VisualReviewRecord> {
  return withVisualReviewLock(workspaceRoot, reviewId, async () => {
  const record = await getVisualReviewRecord(workspaceRoot, reviewId);
  const issues = (input.issues ?? []).map((issue) => issue.trim()).filter(Boolean).slice(0, 30);
  const strengths = (input.strengths ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 30);
  const improvementOpportunities = (input.improvement_opportunities ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 30);
  const summary = input.summary?.trim().slice(0, 4000) || undefined;
  const comparison: VisualComparisonVerdict = input.comparison ?? "not_compared";
  const hasComparisonEvidence = Boolean(record.comparison_path);
  if (!record.delivered_pages?.length) throw new Error("VISUAL_IMAGES_UNAVAILABLE: no rendered image was delivered for inspection.");

  if (record.source_path && record.source_signature) {
    const current = await fileSignature(record.source_path);
    if (current.signature !== record.source_signature) {
      throw new Error("VISUAL_REVIEW_STALE: Cannot assess a stale visual review. Run visual_review again on the current source first.");
    }
  }

  const next: VisualReviewRecord = {
    ...record,
    version: 4,
    review_history: [...(record.review_history ?? []), { action: "assess", at: new Date().toISOString(), source: "calling_model", session_id: getRuntimeScope()?.mcpSessionId, previous: record.model_visual_assessment }],
    model_visual_assessment: {
      verdict: input.verdict,
      inspected_full_render: true,
      issues,
      comparison,
      strengths,
      improvement_opportunities: improvementOpportunities,
      ...(input.further_improvement_worthwhile !== undefined ? { further_improvement_worthwhile: input.further_improvement_worthwhile } : {}),
      ...(summary ? { summary } : {}),
      assessed_at: new Date().toISOString(),
      ...(record.source_signature ? { source_signature: record.source_signature } : {}),
    },
  };
  await atomicWriteJson(reviewPath(workspaceRoot, reviewId), next);
  return next;
  });
}

export async function getVisualReviewRecord(workspaceRoot: string, reviewId: string): Promise<VisualReviewRecord> {
  try {
    const record = JSON.parse(await fs.readFile(reviewPath(workspaceRoot, reviewId), "utf-8")) as VisualReviewRecord;
    const owner = currentVisualOwner();
    if (owner && record.owner_scope && owner.scope !== record.owner_scope) throw new Error("VISUAL_REVIEW_NOT_FOUND: No saved review matches this account.");
    return record;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("VISUAL_REVIEW_NOT_FOUND: No saved review matches this review_id. Use the exact ID returned by review in this workspace, or review the current artifact.");
    throw error;
  }
}

export async function latestSessionVisualReview(workspaceRoot: string): Promise<VisualReviewRecord | null> {
  const owner = currentVisualOwner();
  if (!owner) return null;
  const records = (await siblingReviewRecords(workspaceRoot)).filter(record => record.owner_session === owner.session && record.owner_scope === owner.scope);
  return records.sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export async function withdrawVisualReview(workspaceRoot: string, reviewId: string, reason?: string): Promise<VisualReviewRecord> {
  return withVisualReviewLock(workspaceRoot, reviewId, async () => {
    const record = await getVisualReviewRecord(workspaceRoot, reviewId);
    const next = { ...record, model_visual_critique: undefined, model_visual_assessment: undefined,
      review_history: [...(record.review_history ?? []), { action: "withdraw", at: new Date().toISOString(), source: "calling_model", session_id: getRuntimeScope()?.mcpSessionId, previous: { critique: record.model_visual_critique, assessment: record.model_visual_assessment, reason } }] };
    await atomicWriteJson(reviewPath(workspaceRoot, reviewId), next);
    return next;
  });
}

export async function getVisualReviewFreshness(
  workspaceRoot: string,
  reviewId: string
): Promise<VisualReviewFreshness> {
  const record = await getVisualReviewRecord(workspaceRoot, reviewId);
  const machineReady = record.machine_blocking_issues.length === 0;
  const modelVisualStatus = record.model_visual_assessment?.verdict ?? "pending";
  const qualityGate = evaluateVisualQualityGate(record);
  const coverage = await modelVisualCoverage(workspaceRoot, record);
  const iteration = await modelVisualIterationState(workspaceRoot, record);
  // The assessment is a caller declaration about images returned; it is not
  // independent verification and does not depend on scores or iterations.
  const modelVisualReady = modelVisualStatus === "pass" && coverage.complete;
  const modelVisualQualityStatus: VisualReviewFreshness["model_visual_quality_status"] = modelVisualStatus === "pass" ? "ready" : modelVisualStatus === "fail" ? "failed" : "pending";
  const modelVisualIterationReady = modelVisualReady;

  if (!record.source_path || !record.source_signature) {
    return {
      review_id: record.id,
      fresh: true,
      verifiable: false,
      machine_ready: machineReady,
      model_visual_ready: modelVisualReady,
      model_visual_iteration_ready: modelVisualIterationReady,
      model_visual_status: modelVisualStatus,
      model_visual_quality_status: modelVisualQualityStatus,
      model_visual_quality_gate: qualityGate,
      model_visual_coverage: coverage,
      model_visual_iteration: iteration,
      reason: "Live/remote target has no stable local source signature; task mutation time must be used as the freshness guard.",
      record,
    };
  }

  try {
    const current = await fileSignature(record.source_path);
    const fresh = current.signature === record.source_signature;
    return {
      review_id: record.id,
      fresh,
      verifiable: true,
      machine_ready: machineReady,
      model_visual_ready: modelVisualReady,
      model_visual_iteration_ready: modelVisualIterationReady,
      model_visual_status: modelVisualStatus,
      model_visual_quality_status: modelVisualQualityStatus,
      model_visual_quality_gate: qualityGate,
      model_visual_coverage: coverage,
      model_visual_iteration: iteration,
      reason: fresh ? "Reviewed source signature is current." : "Source changed after the visual review.",
      record,
      current_signature: current.signature,
    };
  } catch (error) {
    return {
      review_id: record.id,
      fresh: false,
      verifiable: true,
      machine_ready: machineReady,
      model_visual_ready: modelVisualReady,
      model_visual_iteration_ready: modelVisualIterationReady,
      model_visual_status: modelVisualStatus,
      model_visual_quality_status: modelVisualQualityStatus,
      model_visual_quality_gate: qualityGate,
      model_visual_coverage: coverage,
      model_visual_iteration: iteration,
      reason: `Reviewed source is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      record,
    };
  }
}
