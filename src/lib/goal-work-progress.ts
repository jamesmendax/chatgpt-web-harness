import { createHash } from "node:crypto";

export interface GoalWorkObservation {
  readonly fingerprint: string;
  readonly productive: boolean;
}

// Evidence IDs, timestamps and process ages change on every observation. They
// cannot establish forward progress, nor can a successful status query alone.
const CONTROL_TOOLS = new Set(["goal", "task_state", "agent_status", "shell_status", "task_status", "task_list"]);
const VOLATILE = /^(?:goal_run_evidence|harness_context|skill_discovery|timestamp|time|observed_at|updated_at|created_at|started_at|finished_at|duration_ms|elapsed_ms|elapsed_seconds|uptime_ms|uptime_seconds|age_ms|age_seconds|invocation_id|request_id|session_id|evidence_id|memory|resource_usage)$/i;

/** Only hashes are retained; tool inputs and outputs are not an activity log. */
export function goalWorkObservation(tool: string, args: unknown, result: unknown): GoalWorkObservation | undefined {
  if (!result || typeof result !== "object") return undefined;
  const response = result as { isError?: boolean; structuredContent?: Record<string, unknown> };
  const payload = response.structuredContent;
  if (!payload || !payload.data || typeof payload.data !== "object") return undefined;
  const data = payload.data as Record<string, unknown>;
  const failed = response.isError === true || payload.ok === false ||
    data.timed_out === true || typeof data.error === "string" ||
    (typeof data.exit_code === "number" && data.exit_code !== 0);
  const control = CONTROL_TOOLS.has(tool);
  try {
    let nodes = 0, chars = 0;
    const stable = (value: unknown, depth = 0): unknown => {
      if (++nodes > 10_000 || depth > 24) throw new Error("observation budget");
      if (typeof value === "string") {
        chars += value.length;
        if (chars > 512_000) throw new Error("observation budget");
        return value;
      }
      if (Array.isArray(value)) return value.map(item => stable(item, depth + 1));
      if (value && typeof value === "object") return Object.fromEntries(
        Object.keys(value).sort().filter(key => !VOLATILE.test(key))
          .map(key => [key, stable((value as Record<string, unknown>)[key], depth + 1)])
      );
      return value ?? null;
    };
    // Control state changes are already handled by continuationProgressKey.
    const material = control ? [tool, stable(args), failed] : [tool, stable(args), stable(data), failed];
    return {
      fingerprint: createHash("sha256").update(JSON.stringify(material)).digest("hex"),
      productive: !control && !failed,
    };
  } catch {
    // An unclassifiable or very large result warrants a checkpoint reminder,
    // never a fabricated proof of either progress or a stalled loop.
    return undefined;
  }
}

export interface GoalWorkHistory {
  readonly seen: Set<string>;
  readonly repeated: number;
  /** Exact previous result, used to require a consecutive repeat streak. */
  readonly lastFingerprint?: string;
  readonly repeatStreakStartedAtMs?: number;
  readonly repeatedForMs: number;
}

export const GOAL_NO_PROGRESS_REPEAT_WINDOW_MS = 30 * 60 * 1_000;
export const GOAL_NO_PROGRESS_MIN_REPEATS = 3;

export function goalWorkHistoryIsStalled(history: GoalWorkHistory | undefined): boolean {
  return Boolean(
    history &&
    history.repeated >= GOAL_NO_PROGRESS_MIN_REPEATS &&
    history.repeatedForMs >= GOAL_NO_PROGRESS_REPEAT_WINDOW_MS
  );
}

export function advanceGoalWorkHistory(
  prior: GoalWorkHistory | undefined,
  observation: GoalWorkObservation | undefined,
  nowMs = Date.now()
): GoalWorkHistory & { advanced: boolean } {
  const seen = prior?.seen ?? new Set<string>();
  const observedAtMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!observation) {
    return {
      seen,
      repeated: 0,
      lastFingerprint: undefined,
      repeatStreakStartedAtMs: undefined,
      repeatedForMs: 0,
      advanced: false,
    };
  }
  if (prior?.lastFingerprint === observation.fingerprint) {
    // Start the thirty-minute window on the first actual repeat, not on the
    // original observation. A single identical result after a long idle gap
    // therefore starts a new timer instead of immediately looking stalled.
    const startedAtMs = prior.repeatStreakStartedAtMs ?? observedAtMs;
    return {
      seen,
      repeated: (prior?.repeated ?? 0) + 1,
      lastFingerprint: observation.fingerprint,
      repeatStreakStartedAtMs: startedAtMs,
      repeatedForMs: Math.max(0, observedAtMs - startedAtMs),
      advanced: false,
    };
  }
  if (seen.has(observation.fingerprint)) {
    return {
      seen,
      repeated: 0,
      lastFingerprint: observation.fingerprint,
      repeatStreakStartedAtMs: undefined,
      repeatedForMs: 0,
      advanced: false,
    };
  }
  // Do not evict old fingerprints: cycling through calls must not turn old
  // output into new work. Saturation is uncertainty, so the first untracked
  // fingerprint cannot claim progress. Keeping the exact previous result
  // still detects a truly consecutive repeat without treating varied work as
  // an automatic reason to stop.
  if (seen.size >= 256) {
    return {
      seen,
      repeated: 0,
      lastFingerprint: observation.fingerprint,
      repeatStreakStartedAtMs: undefined,
      repeatedForMs: 0,
      advanced: false,
    };
  }
  seen.add(observation.fingerprint);
  return {
    seen,
    repeated: 0,
    lastFingerprint: observation.fingerprint,
    repeatStreakStartedAtMs: undefined,
    repeatedForMs: 0,
    advanced: observation.productive,
  };
}
