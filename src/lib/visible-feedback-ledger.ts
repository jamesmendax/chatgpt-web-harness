export const VISIBLE_FEEDBACK_LEDGER_SCHEMA_VERSION = 1 as const;

export type VisibleFeedbackTransportState = "online" | "offline" | "unbound" | "unknown";
export type VisibleFeedbackStatus = "observed" | "unavailable" | "unknown";

export interface VisibleFeedbackLedgerInput {
  readonly schema_version: typeof VISIBLE_FEEDBACK_LEDGER_SCHEMA_VERSION;
  readonly turn_id: string | null;
  readonly turn_started_at_ms: number | null;
  readonly observed_at_ms: number;
  readonly text_revision: number;
  readonly signals: {
    readonly assistant_text_emitted: {
      readonly status: "unavailable";
      readonly source: "host_callback";
      readonly reason_code: "host_emission_callback_unavailable";
      readonly event_time_ms: null;
    };
    readonly assistant_text_rendered: {
      readonly status: "observed" | "unavailable";
      readonly source: "dom_observation";
      readonly event_time_ms: number | null;
      readonly revision: number;
      readonly signature: string | null;
      readonly reason_code?: string;
    };
    readonly execution_activity: {
      readonly status: "observed";
      readonly source: "dom_mutation_observer";
      readonly event_time_ms: number | null;
      readonly mutation_revision: number;
      readonly execution_revision: number;
      readonly generation_active: boolean;
      readonly tool_inflight_count: number;
      readonly composer_mutations_excluded: true;
    };
    readonly transport_state: {
      readonly status: "observed" | "unknown";
      readonly source: "browser_companion_api_ack";
      readonly state: VisibleFeedbackTransportState;
      readonly event_time_ms: number | null;
      readonly revision: number;
      readonly reason_code?: string;
    };
  };
}

export interface VisibleFeedbackSignalReceipt {
  readonly status: VisibleFeedbackStatus;
  readonly source: string;
  readonly event_time_ms: number | null;
  readonly received_at_ms: number | null;
  readonly revision?: number;
  readonly reason_code?: string;
}

export interface VisibleFeedbackLedger extends VisibleFeedbackLedgerInput {
  readonly received_at_ms: number;
  readonly signals: VisibleFeedbackLedgerInput["signals"] & {
    readonly assistant_text_emitted: VisibleFeedbackLedgerInput["signals"]["assistant_text_emitted"] & { readonly received_at_ms: null };
    readonly assistant_text_rendered: VisibleFeedbackLedgerInput["signals"]["assistant_text_rendered"] & { readonly received_at_ms: number | null };
    readonly execution_activity: VisibleFeedbackLedgerInput["signals"]["execution_activity"] & { readonly received_at_ms: number };
    readonly transport_state: VisibleFeedbackLedgerInput["signals"]["transport_state"] & { readonly received_at_ms: number | null };
  };
}

export type VisibleFeedbackLedgerResult =
  | { readonly ok: true; readonly value: VisibleFeedbackLedger }
  | { readonly ok: false; readonly reason: "invalid" | "stale"; readonly detail: string };

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableTime(value: unknown): value is number | null {
  return value === null || safeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(detail: string): VisibleFeedbackLedgerResult {
  return { ok: false, reason: "invalid", detail };
}

function stale(detail: string): VisibleFeedbackLedgerResult {
  return { ok: false, reason: "stale", detail };
}

/**
 * Validate an untrusted browser snapshot and stamp receive time at the host.
 * Browser event time is retained separately; it is never substituted for the
 * time at which the local Companion API actually received the heartbeat.
 */
export function normalizeVisibleFeedbackLedger(
  value: unknown,
  receivedAtMs: number,
  previous: VisibleFeedbackLedger | null = null,
  expectedTurnId?: string | null,
): VisibleFeedbackLedgerResult {
  if (!isRecord(value) || value.schema_version !== VISIBLE_FEEDBACK_LEDGER_SCHEMA_VERSION) {
    return invalid("unsupported_schema");
  }
  if (!safeInteger(receivedAtMs)) return invalid("invalid_receive_time");
  const turnId = value.turn_id;
  const turnStartedAt = value.turn_started_at_ms;
  if (turnId !== null && (typeof turnId !== "string" || !turnId.trim() || turnId.length > 256)) {
    return invalid("invalid_turn_id");
  }
  if (!nullableTime(turnStartedAt) || (turnId === null) !== (turnStartedAt === null)) {
    return invalid("invalid_turn_started_at");
  }
  if (!safeInteger(value.observed_at_ms) || !safeInteger(value.text_revision) || !isRecord(value.signals)) {
    return invalid("invalid_snapshot_clock_or_signals");
  }
  if (expectedTurnId !== undefined && turnId !== expectedTurnId) {
    return stale("turn_identity_mismatch");
  }

  const signals = value.signals;
  const emitted = signals.assistant_text_emitted;
  const rendered = signals.assistant_text_rendered;
  const execution = signals.execution_activity;
  const transport = signals.transport_state;

  // No host emission callback is available in the browser companion. This
  // signal must remain explicitly unavailable instead of being inferred from
  // rendered DOM, a tool card, or a successful transport request.
  if (!isRecord(emitted) || emitted.status !== "unavailable" || emitted.source !== "host_callback" ||
      emitted.reason_code !== "host_emission_callback_unavailable" || emitted.event_time_ms !== null) {
    return invalid("assistant_text_emitted_requires_unavailable_host_callback");
  }

  if (!isRecord(rendered) || rendered.source !== "dom_observation" ||
      !["observed", "unavailable"].includes(String(rendered.status)) ||
      !safeInteger(rendered.revision) || rendered.revision !== value.text_revision ||
      !nullableTime(rendered.event_time_ms) ||
      (rendered.signature !== null && (typeof rendered.signature !== "string" || rendered.signature.length < 1 || rendered.signature.length > 128))) {
    return invalid("invalid_assistant_text_rendered_signal");
  }
  if (rendered.status === "observed" && (!rendered.signature || rendered.event_time_ms === null)) {
    return invalid("observed_render_requires_signature_and_event_time");
  }
  if (rendered.status === "unavailable" && (rendered.signature !== null || rendered.event_time_ms !== null)) {
    return invalid("unavailable_render_must_not_claim_content");
  }

  if (!isRecord(execution) || execution.status !== "observed" || execution.source !== "dom_mutation_observer" ||
      !nullableTime(execution.event_time_ms) || !safeInteger(execution.mutation_revision) ||
      !safeInteger(execution.execution_revision) || typeof execution.generation_active !== "boolean" ||
      !safeInteger(execution.tool_inflight_count) || execution.tool_inflight_count > 10_000 ||
      execution.composer_mutations_excluded !== true) {
    return invalid("invalid_execution_activity_signal");
  }

  if (!isRecord(transport) || !["observed", "unknown"].includes(String(transport.status)) ||
      transport.source !== "browser_companion_api_ack" ||
      !["online", "offline", "unbound", "unknown"].includes(String(transport.state)) ||
      !nullableTime(transport.event_time_ms) || !safeInteger(transport.revision)) {
    return invalid("invalid_transport_state_signal");
  }

  const observedAt = value.observed_at_ms;
  const eventTimes = [rendered.event_time_ms, execution.event_time_ms, transport.event_time_ms];
  if (eventTimes.some((time) => time !== null && time > observedAt)) {
    return invalid("signal_event_time_after_snapshot");
  }
  if (turnStartedAt !== null && observedAt < turnStartedAt) {
    return invalid("snapshot_precedes_turn_start");
  }
  if (turnStartedAt !== null && rendered.event_time_ms !== null && rendered.event_time_ms < turnStartedAt) {
    return invalid("rendered_event_precedes_turn_start");
  }
  if ((transport.status === "unknown") !== (transport.state === "unknown")) {
    return invalid("transport_status_state_mismatch");
  }

  if (previous) {
    if (observedAt < previous.observed_at_ms) return stale("snapshot_observed_at_regressed");
    if (turnId !== previous.turn_id && turnStartedAt !== null && previous.turn_started_at_ms !== null &&
        turnStartedAt < previous.turn_started_at_ms) {
      return stale("older_turn_arrived_after_newer_turn");
    }
    if (execution.mutation_revision < previous.signals.execution_activity.mutation_revision ||
        execution.execution_revision < previous.signals.execution_activity.execution_revision ||
        transport.revision < previous.signals.transport_state.revision) {
      return stale("session_signal_revision_regressed");
    }
    const previousTransportTime = previous.signals.transport_state.event_time_ms;
    if (transport.event_time_ms !== null && previousTransportTime !== null && transport.event_time_ms < previousTransportTime) {
      return stale("transport_event_time_regressed");
    }
    if (turnId === previous.turn_id) {
      if (turnStartedAt !== previous.turn_started_at_ms) return stale("turn_start_identity_changed");
      if (value.text_revision < previous.text_revision) return stale("text_revision_regressed");
      const previousRender = previous.signals.assistant_text_rendered;
      if ((rendered.revision === previousRender.revision && rendered.signature !== previousRender.signature) ||
          (rendered.revision > previousRender.revision && rendered.signature === previousRender.signature)) {
        return stale("render_signature_revision_mismatch");
      }
      for (const [name, eventTime, previousTime] of [
        ["rendered", rendered.event_time_ms, previousRender.event_time_ms],
        ["execution", execution.event_time_ms, previous.signals.execution_activity.event_time_ms],
      ] as const) {
        if (eventTime !== null && previousTime !== null && eventTime < previousTime) {
          return stale(`${name}_event_time_regressed`);
        }
      }
    }
  }

  const receiveTime = Math.max(receivedAtMs, previous?.received_at_ms ?? 0);
  const normalized: VisibleFeedbackLedger = Object.freeze({
    schema_version: VISIBLE_FEEDBACK_LEDGER_SCHEMA_VERSION,
    turn_id: turnId as string | null,
    turn_started_at_ms: turnStartedAt as number | null,
    observed_at_ms: observedAt,
    received_at_ms: receiveTime,
    text_revision: value.text_revision,
    signals: Object.freeze({
      assistant_text_emitted: Object.freeze({
        status: "unavailable" as const,
        source: "host_callback" as const,
        reason_code: "host_emission_callback_unavailable" as const,
        event_time_ms: null,
        received_at_ms: null,
      }),
      assistant_text_rendered: Object.freeze({
        status: rendered.status as "observed" | "unavailable",
        source: "dom_observation" as const,
        event_time_ms: rendered.event_time_ms as number | null,
        revision: rendered.revision as number,
        signature: rendered.signature as string | null,
        ...(typeof rendered.reason_code === "string" ? { reason_code: rendered.reason_code.slice(0, 80) } : {}),
        received_at_ms: rendered.status === "observed" ? receiveTime : null,
      }),
      execution_activity: Object.freeze({
        status: "observed" as const,
        source: "dom_mutation_observer" as const,
        event_time_ms: execution.event_time_ms as number | null,
        mutation_revision: execution.mutation_revision as number,
        execution_revision: execution.execution_revision as number,
        generation_active: execution.generation_active as boolean,
        tool_inflight_count: execution.tool_inflight_count as number,
        composer_mutations_excluded: true as const,
        received_at_ms: receiveTime,
      }),
      transport_state: Object.freeze({
        status: transport.status as "observed" | "unknown",
        source: "browser_companion_api_ack" as const,
        state: transport.state as VisibleFeedbackTransportState,
        event_time_ms: transport.event_time_ms as number | null,
        revision: transport.revision as number,
        ...(typeof transport.reason_code === "string" ? { reason_code: transport.reason_code.slice(0, 80) } : {}),
        received_at_ms: transport.status === "observed" ? receiveTime : null,
      }),
    }),
  });
  return { ok: true, value: normalized };
}

/** A dashboard-safe view: no transcript text and no raw browser payload. */
export function summarizeVisibleFeedbackLedger(ledger: VisibleFeedbackLedger | null | undefined) {
  if (!ledger) return null;
  return {
    schema_version: ledger.schema_version,
    turn_id: ledger.turn_id,
    observed_at_ms: ledger.observed_at_ms,
    received_at_ms: ledger.received_at_ms,
    signals: {
      assistant_text_emitted: {
        status: ledger.signals.assistant_text_emitted.status,
        source: ledger.signals.assistant_text_emitted.source,
        reason_code: ledger.signals.assistant_text_emitted.reason_code,
      },
      assistant_text_rendered: {
        status: ledger.signals.assistant_text_rendered.status,
        source: ledger.signals.assistant_text_rendered.source,
        revision: ledger.signals.assistant_text_rendered.revision,
        event_time_ms: ledger.signals.assistant_text_rendered.event_time_ms,
        received_at_ms: ledger.signals.assistant_text_rendered.received_at_ms,
      },
      execution_activity: {
        status: ledger.signals.execution_activity.status,
        source: ledger.signals.execution_activity.source,
        event_time_ms: ledger.signals.execution_activity.event_time_ms,
        received_at_ms: ledger.signals.execution_activity.received_at_ms,
        execution_revision: ledger.signals.execution_activity.execution_revision,
        tool_inflight_count: ledger.signals.execution_activity.tool_inflight_count,
      },
      transport_state: {
        status: ledger.signals.transport_state.status,
        source: ledger.signals.transport_state.source,
        state: ledger.signals.transport_state.state,
        event_time_ms: ledger.signals.transport_state.event_time_ms,
        received_at_ms: ledger.signals.transport_state.received_at_ms,
      },
    },
  };
}