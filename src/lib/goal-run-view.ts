import type { GoalRun } from "./goal-run-state.js";

export const DEFAULT_GOAL_EVIDENCE_PAGE_SIZE = 8;
export const MAX_GOAL_EVIDENCE_PAGE_SIZE = 64;

export interface GoalRunEvidencePage {
  readonly offset: number;
  readonly limit: number;
  readonly returned: number;
  readonly total: number;
  readonly next_offset: number | null;
  readonly complete: boolean;
}

/**
 * Keep the authoritative GoalRun untouched while returning only a bounded view
 * of typed evidence. Long goals can accumulate hundreds of evidence records;
 * repeatedly sending the full history wastes MCP/tunnel bytes and ChatGPT
 * context. Criteria keep their evidence ids, so acceptance truth is unchanged.
 */
export function boundedGoalRunView(
  run: GoalRun,
  requestedOffset = 0,
  requestedLimit = DEFAULT_GOAL_EVIDENCE_PAGE_SIZE,
) {
  const total = run.typedEvidence.length;
  const offset = Math.min(total, Math.max(0, Math.floor(requestedOffset)));
  const limit = Math.min(
    MAX_GOAL_EVIDENCE_PAGE_SIZE,
    Math.max(1, Math.floor(requestedLimit || DEFAULT_GOAL_EVIDENCE_PAGE_SIZE)),
  );
  const typedEvidence = run.typedEvidence.slice(offset, offset + limit);
  const nextOffset = offset + typedEvidence.length;
  const page: GoalRunEvidencePage = {
    offset,
    limit,
    returned: typedEvidence.length,
    total,
    next_offset: nextOffset < total ? nextOffset : null,
    complete: offset === 0 && typedEvidence.length === total,
  };

  return {
    ...run,
    typedEvidence,
    typedEvidencePage: page,
  };
}
