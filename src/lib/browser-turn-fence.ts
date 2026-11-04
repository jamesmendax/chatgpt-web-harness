export interface BrowserTurnSnapshot {
  tab_id: string;
  observed_at_ms: number;
  user_turn_count: number;
  assistant_turn_count: number;
  generation_active: boolean;
  tool_inflight_count: number;
  activity_revision: number;
  visible_text_hash: string;
  // UI delivery state, not evidence that the backend model has terminated.
  failure_visible?: boolean;
}

export interface BrowserTurnFenceOptions {
  ambiguity_ms?: number;
  stable_ms?: number;
}

export interface BrowserTurnFenceState {
  session_id: string;
  tab_id: string;
  baseline: BrowserTurnSnapshot;
  send_activated_at_ms: number;
  accepted: boolean;
  acceptance_reason: "user_turn" | "assistant_turn" | "generation" | "mcp_activity" | null;
  tool_activity_seen: boolean;
  post_tool_baseline: BrowserTurnSnapshot | null;
  last_snapshot: BrowserTurnSnapshot | null;
  completion_candidate: BrowserTurnSnapshot | null;
  completed: boolean;
  // Optional for compatibility with checkpoints written before this field.
  delivery_failure?: BrowserTurnSnapshot | null;
  options: Required<BrowserTurnFenceOptions>;
}

export interface BrowserTurnFenceDecision {
  state: BrowserTurnFenceState;
  phase: "awaiting_acceptance" | "accepted" | "running" | "candidate_complete" | "complete" | "delivery_failed" | "send_ambiguous" | "wrong_tab";
  next_action: "observe_same_tab" | "rebind_same_tab" | "none";
  resubmit_allowed: false;
  reason: string;
}

const DEFAULT_AMBIGUITY_MS = 15_000;
const DEFAULT_STABLE_MS = 750;

function normalizedOptions(options: BrowserTurnFenceOptions = {}): Required<BrowserTurnFenceOptions> {
  return {
    ambiguity_ms: Math.max(1_000, Math.min(120_000, Math.floor(options.ambiguity_ms ?? DEFAULT_AMBIGUITY_MS))),
    stable_ms: Math.max(100, Math.min(10_000, Math.floor(options.stable_ms ?? DEFAULT_STABLE_MS))),
  };
}

function snapshotStable(left: BrowserTurnSnapshot, right: BrowserTurnSnapshot): boolean {
  return left.tab_id === right.tab_id
    && left.user_turn_count === right.user_turn_count
    && left.assistant_turn_count === right.assistant_turn_count
    && left.generation_active === right.generation_active
    && left.tool_inflight_count === right.tool_inflight_count
    && left.activity_revision === right.activity_revision
    && Boolean(left.failure_visible) === Boolean(right.failure_visible)
    && left.visible_text_hash === right.visible_text_hash;
}

function acceptedReason(state: BrowserTurnFenceState, snapshot: BrowserTurnSnapshot): BrowserTurnFenceState["acceptance_reason"] {
  if (snapshot.user_turn_count > state.baseline.user_turn_count) return "user_turn";
  if (snapshot.assistant_turn_count > state.baseline.assistant_turn_count) return "assistant_turn";
  if (snapshot.generation_active) return "generation";
  if (snapshot.activity_revision > state.baseline.activity_revision) return "mcp_activity";
  return null;
}

export function beginBrowserTurnFence(
  sessionId: string,
  baseline: BrowserTurnSnapshot,
  options: BrowserTurnFenceOptions = {}
): BrowserTurnFenceState {
  return {
    session_id: sessionId,
    tab_id: baseline.tab_id,
    baseline,
    send_activated_at_ms: baseline.observed_at_ms,
    accepted: false,
    acceptance_reason: null,
    tool_activity_seen: false,
    post_tool_baseline: null,
    last_snapshot: baseline,
    completion_candidate: null,
    completed: false,
    delivery_failure: baseline.failure_visible ? baseline : null,
    options: normalizedOptions(options),
  };
}

export function observeBrowserTurnFence(
  previous: BrowserTurnFenceState,
  snapshot: BrowserTurnSnapshot
): BrowserTurnFenceDecision {
  const state: BrowserTurnFenceState = {
    ...previous,
    last_snapshot: snapshot,
    completion_candidate: previous.completion_candidate ? { ...previous.completion_candidate } : null,
  };

  if (snapshot.tab_id !== state.tab_id) {
    return {
      state: previous,
      phase: "wrong_tab",
      next_action: "rebind_same_tab",
      resubmit_allowed: false,
      reason: "Observation came from a different tab/session; rebind the original tab and do not resubmit the send.",
    };
  }

  // A late read must not roll the observed tool revision or turn backwards.
  // This mirrors the reference completion tracker's monotonic batch fence.
  const last = previous.last_snapshot ?? previous.baseline;
  if (!Number.isFinite(snapshot.observed_at_ms) || !Number.isSafeInteger(snapshot.activity_revision)
    || snapshot.observed_at_ms <= last.observed_at_ms || snapshot.activity_revision < last.activity_revision) {
    return { state: { ...previous, completion_candidate: null }, phase: previous.accepted ? "accepted" : "awaiting_acceptance",
      next_action: "observe_same_tab", resubmit_allowed: false,
      reason: "Observation is stale or its activity revision regressed; require a fresh same-tab read." };
  }
  if (snapshot.activity_revision > last.activity_revision || snapshot.tool_inflight_count > 0) {
    state.tool_activity_seen = true;
    state.post_tool_baseline = snapshot;
    state.completion_candidate = null;
    state.completed = false;
  }
  if (snapshot.generation_active) state.completed = false;

  // A stable red error is not a stable final answer. Failure takes precedence
  // over a candidate or previously completed read, but never permits replay.
  if (snapshot.failure_visible === true) {
    if (!state.accepted) {
      const reason = acceptedReason(state, snapshot);
      if (reason) {
        state.accepted = true;
        state.acceptance_reason = reason;
      }
    }
    state.delivery_failure = snapshot;
    state.post_tool_baseline = snapshot;
    state.completion_candidate = null;
    state.completed = false;
    return {
      state, phase: "delivery_failed", next_action: "observe_same_tab", resubmit_allowed: false,
      reason: "A visible delivery error blocks successful completion; backend status and send effects remain unknown. Do not retry or resubmit.",
    };
  }

  if (state.delivery_failure) {
    const freshResponse = snapshot.generation_active
      || snapshot.assistant_turn_count > state.delivery_failure.assistant_turn_count;
    if (!freshResponse) {
      state.completion_candidate = null;
      state.completed = false;
      return {
        state, phase: "delivery_failed", next_action: "observe_same_tab", resubmit_allowed: false,
        reason: "The error UI cleared, but no fresh assistant/generation evidence proves recovery. Banner removal or tool/DOM activity alone is not successful completion.",
      };
    }
    state.delivery_failure = null;
  }

  if (!state.accepted) {
    const reason = acceptedReason(state, snapshot);
    if (reason) {
      state.accepted = true;
      state.acceptance_reason = reason;
    } else if (snapshot.observed_at_ms - state.send_activated_at_ms >= state.options.ambiguity_ms) {
      return {
        state,
        phase: "send_ambiguous",
        next_action: "rebind_same_tab",
        resubmit_allowed: false,
        reason: "Send was activated but acceptance is still ambiguous; rebind the same tab rather than sending again.",
      };
    } else {
      return {
        state,
        phase: "awaiting_acceptance",
        next_action: "observe_same_tab",
        resubmit_allowed: false,
        reason: "Waiting for a new turn, generation, or current-turn MCP activity to prove send acceptance.",
      };
    }
  }

  if (state.completed) {
    return {
      state,
      phase: "complete",
      next_action: "none",
      resubmit_allowed: false,
      reason: "Completion fence already satisfied by a fresh same-tab observation.",
    };
  }

  if (snapshot.generation_active || snapshot.tool_inflight_count > 0) {
    state.completion_candidate = null;
    return {
      state,
      phase: "running",
      next_action: "observe_same_tab",
      resubmit_allowed: false,
      reason: snapshot.generation_active ? "Generation is active." : "External tool activity is still in flight.",
    };
  }

  const postToolBaseline = state.post_tool_baseline ?? state.baseline;
  const hasPostToolText = snapshot.assistant_turn_count > postToolBaseline.assistant_turn_count
    || snapshot.visible_text_hash !== postToolBaseline.visible_text_hash;
  if (!hasPostToolText) {
    state.completion_candidate = null;
    return {
      state,
      phase: "accepted",
      next_action: "observe_same_tab",
      resubmit_allowed: false,
      reason: "No assistant/text change after the send or latest tool batch has been observed yet.",
    };
  }

  const candidate = state.completion_candidate;
  if (!candidate || !snapshotStable(candidate, snapshot)) {
    state.completion_candidate = snapshot;
    return {
      state,
      phase: "candidate_complete",
      next_action: "observe_same_tab",
      resubmit_allowed: false,
      reason: "Quiescent completion candidate captured; require a fresh same-tab read before completion.",
    };
  }

  if (snapshot.observed_at_ms - candidate.observed_at_ms < state.options.stable_ms) {
    return {
      state,
      phase: "candidate_complete",
      next_action: "observe_same_tab",
      resubmit_allowed: false,
      reason: "Completion candidate is stable so far, but the minimum stability interval has not elapsed.",
    };
  }

  state.completed = true;
  return {
    state,
    phase: "complete",
    next_action: "none",
    resubmit_allowed: false,
    reason: "Send acceptance is proven and a fresh stable observation confirms no generation/tool race remains.",
  };
}
