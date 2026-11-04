import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import {
  normalizeVisibleFeedbackLedger,
  summarizeVisibleFeedbackLedger,
} from "../dist/lib/visible-feedback-ledger.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = await fs.readFile(path.join(root, "browser-companion", "visible-feedback-ledger.js"), "utf8");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(helperSource, sandbox, { filename: "visible-feedback-ledger.js" });
const helper = sandbox.HarnessVisibleFeedbackLedger;
assert.ok(helper, "browser companion must expose the visible feedback helper");

function element(tagName, attributes = {}, children = [], options = {}) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    childNodes: children,
    hidden: Boolean(options.hidden),
    _visible: options.visible !== false,
    getAttribute(name) { return Object.hasOwn(attributes, name) ? attributes[name] : null; },
  };
  for (const child of children) if (child && typeof child === "object") child.parentElement = node;
  return node;
}

const text = (nodeValue) => ({ nodeType: 3, nodeValue });
const visible = (node) => node?._visible !== false && !node?.hidden && node?.getAttribute?.("aria-hidden") !== "true";
const assistant = element("article", { "data-message-author-role": "assistant" }, [
  text("Visible assistant answer"),
  element("div", { "data-testid": "tool-card" }, [text("PRIVATE TOOL OUTPUT")]),
  element("div", { "data-message-author-role": "tool" }, [text("PRIVATE TOOL ROLE")]),
  element("div", { "aria-hidden": "true" }, [text("PRIVATE HIDDEN TEXT")]),
  element("button", {}, [text("Copy")]),
  element("div", { contenteditable: "true" }, [text("PRIVATE COMPOSER DRAFT")]),
]);
const hiddenAssistant = element("article", { "data-message-author-role": "assistant" }, [text("HIDDEN OLD ANSWER")], { visible: false });
const documentFixture = {
  querySelectorAll(selector) {
    assert.equal(selector, "[data-message-author-role='assistant']");
    return [hiddenAssistant, assistant];
  },
};
const rendered = helper.readVisibleAssistantSnapshot(documentFixture, visible);
assert.equal(rendered.status, "observed");
assert.equal(rendered.text_length, "Visible assistant answer".length);
assert.equal(rendered.source, "dom_observation");
for (const privateText of ["PRIVATE TOOL OUTPUT", "PRIVATE TOOL ROLE", "PRIVATE HIDDEN TEXT", "Copy", "PRIVATE COMPOSER DRAFT", "HIDDEN OLD ANSWER"]) {
  assert.equal(rendered.signature.includes(privateText), false, "render signature must not expose transcript or hidden UI text");
}
const messageOne = element("article", { "data-message-author-role": "assistant", "data-message-id": "message-one-secret" }, [text("Same assistant text")]);
const messageTwo = element("article", { "data-message-author-role": "assistant", "data-message-id": "message-two-secret" }, [text("Same assistant text")]);
const snapshotFor = (node) => helper.readVisibleAssistantSnapshot({ querySelectorAll: () => [node] }, visible);
const messageOneSnapshot = snapshotFor(messageOne);
const messageTwoSnapshot = snapshotFor(messageTwo);
assert.notEqual(messageOneSnapshot.signature, messageTwoSnapshot.signature,
  "identical text in different assistant message identities must be distinguishable");
assert.equal(messageOneSnapshot.signature.includes("message-one-secret"), false,
  "DOM message identity must be hashed rather than exposed");

const baseline = helper.updateAssistantRenderRevision(null, "turn-1", rendered, 1_100);
assert.equal(baseline.revision, 0);
assert.equal(baseline.event_time_ms, null, "the prior turn's visible answer must not be claimed as newly rendered in this turn");
assert.equal(baseline.visible, true);
const duplicate = helper.updateAssistantRenderRevision(baseline, "turn-1", rendered, 1_200);
assert.equal(duplicate.revision, 0, "duplicate DOM snapshots must not increment the text revision");
assert.equal(duplicate.event_time_ms, null, "duplicate baseline snapshots must not invent a turn-local render event");

const changed = { ...rendered, signature: "24:changed" };
const changedState = helper.updateAssistantRenderRevision(duplicate, "turn-1", changed, 1_300);
assert.equal(changedState.revision, 1);
assert.equal(changedState.event_time_ms, 1_300);
const hiddenState = helper.updateAssistantRenderRevision(changedState, "turn-1", { status: "unavailable", signature: null }, 1_400);
assert.equal(hiddenState.revision, 1, "temporarily unavailable text must not invent a new revision");
assert.equal(hiddenState.visible, false);
const reappeared = helper.updateAssistantRenderRevision(hiddenState, "turn-1", changed, 1_500);
assert.equal(reappeared.revision, 1, "the exact same assistant text reappearing after temporary hiding is NOT new progress");
assert.equal(reappeared.event_time_ms, 1_300, "DOM reappearance must not manufacture a new current-turn text event");
assert.equal(reappeared.visible, true, "the text is visible again despite no new progress");
const baselineHidden = helper.updateAssistantRenderRevision(duplicate, "turn-1", { status: "unavailable", signature: null }, 1_410);
const baselineReappeared = helper.updateAssistantRenderRevision(baselineHidden, "turn-1", rendered, 1_510);
assert.equal(baselineReappeared.revision, 0, "historical pre-turn text reappearing must remain a baseline");
assert.equal(baselineReappeared.event_time_ms, null, "reappearing historical text must not establish a new rendered-message receipt");
const genuineNewText = helper.updateAssistantRenderRevision(hiddenState, "turn-1", { ...changed, signature: "25:actually-new" }, 1_550);
assert.equal(genuineNewText.revision, 2, "a different message after hiding still counts as fresh visible assistant text");
assert.equal(genuineNewText.event_time_ms, 1_550);
const reappearLedger = helper.buildVisibleFeedbackLedger({
  turn_id: "turn-1", turn_started_at_ms: 1_000, observed_at_ms: 1_600,
  rendered: changed, render_state: reappeared,
  mutation_revision: 7, execution_revision: 3,
  execution_event_time_ms: 1_590, generation_active: true, tool_inflight_count: 1,
  transport: { state: "online", revision: 2, event_time_ms: 1_590 },
});
const reappearReceipt = normalizeVisibleFeedbackLedger(reappearLedger, 1_700, null, "turn-1");
assert.equal(reappearReceipt.ok, true, reappearReceipt.ok ? "" : reappearReceipt.detail);
assert.equal(reappearReceipt.value.signals.assistant_text_rendered.revision, 1);
assert.equal(reappearReceipt.value.signals.assistant_text_rendered.event_time_ms, 1_300,
  "a new Companion receive/ACK time does not make old assistant text fresh");
assert.equal(reappearReceipt.value.signals.assistant_text_emitted.status, "unavailable");
const baselineReappearLedger = helper.buildVisibleFeedbackLedger({
  turn_id: "turn-1", turn_started_at_ms: 1_000, observed_at_ms: 1_600,
  rendered, render_state: baselineReappeared,
  mutation_revision: 7, execution_revision: 3,
  execution_event_time_ms: 1_590, generation_active: true, tool_inflight_count: 1,
  transport: { state: "online", revision: 2, event_time_ms: 1_590 },
});
const baselineReceipt = normalizeVisibleFeedbackLedger(baselineReappearLedger, 1_700, null, "turn-1");
assert.equal(baselineReceipt.ok, true, baselineReceipt.ok ? "" : baselineReceipt.detail);
assert.equal(baselineReceipt.value.signals.assistant_text_rendered.status, "unavailable",
  "pre-turn baseline must not be promoted to displayed new progress by heartbeat transport");
const nextTurn = helper.updateAssistantRenderRevision(reappeared, "turn-2", changed, 1_600);
assert.equal(nextTurn.revision, 0, "a new turn must start a fresh text revision");
assert.equal(nextTurn.event_time_ms, null, "the previous turn's answer is only a baseline for the new turn");
const nextTurnChanged = helper.updateAssistantRenderRevision(nextTurn, "turn-2", { ...changed, signature: "25:new-turn-text" }, 1_700);
assert.equal(nextTurnChanged.revision, 1);
assert.equal(nextTurnChanged.event_time_ms, 1_700);

const emittedUnavailable = {
  status: "unavailable",
  source: "host_callback",
  reason_code: "host_emission_callback_unavailable",
  event_time_ms: null,
};
const baseSnapshot = {
  schema_version: 1,
  turn_id: "turn-1",
  turn_started_at_ms: 1_000,
  observed_at_ms: 1_200,
  text_revision: 0,
  signals: {
    assistant_text_emitted: emittedUnavailable,
    assistant_text_rendered: {
      status: "observed",
      source: "dom_observation",
      event_time_ms: 1_100,
      revision: 0,
      signature: "12:answer-hash",
    },
    execution_activity: {
      status: "observed",
      source: "dom_mutation_observer",
      event_time_ms: 1_150,
      mutation_revision: 5,
      execution_revision: 2,
      generation_active: true,
      tool_inflight_count: 1,
      composer_mutations_excluded: true,
    },
    transport_state: {
      status: "observed",
      source: "browser_companion_api_ack",
      state: "online",
      event_time_ms: 1_190,
      revision: 1,
    },
  },
};
const accepted = normalizeVisibleFeedbackLedger(baseSnapshot, 1_300, null, "turn-1");
assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.detail);
assert.equal(accepted.value.received_at_ms, 1_300);
assert.equal(accepted.value.signals.assistant_text_rendered.event_time_ms, 1_100);
assert.equal(accepted.value.signals.assistant_text_rendered.received_at_ms, 1_300);
assert.equal(accepted.value.signals.execution_activity.received_at_ms, 1_300);
assert.equal(accepted.value.signals.transport_state.received_at_ms, 1_300);
assert.equal(accepted.value.signals.assistant_text_emitted.status, "unavailable");

const secondSnapshot = structuredClone(baseSnapshot);
secondSnapshot.observed_at_ms = 1_400;
secondSnapshot.signals.execution_activity.event_time_ms = 1_350;
secondSnapshot.signals.execution_activity.mutation_revision = 6;
secondSnapshot.signals.execution_activity.execution_revision = 3;
secondSnapshot.signals.transport_state.event_time_ms = 1_390;
const acceptedSecond = normalizeVisibleFeedbackLedger(secondSnapshot, 1_500, accepted.value, "turn-1");
assert.equal(acceptedSecond.ok, true, acceptedSecond.ok ? "" : acceptedSecond.detail);

function expectInvalid(snapshot, reason, previous = null, expectedTurnId = "turn-1", receivedAt = 1_600) {
  const result = normalizeVisibleFeedbackLedger(snapshot, receivedAt, previous, expectedTurnId);
  assert.equal(result.ok, false, `expected rejection: ${reason}`);
  assert.equal(result.detail, reason);
}

const emittedFalseProof = structuredClone(baseSnapshot);
emittedFalseProof.signals.assistant_text_emitted.status = "observed";
expectInvalid(emittedFalseProof, "assistant_text_emitted_requires_unavailable_host_callback");

const futureEvent = structuredClone(baseSnapshot);
futureEvent.signals.assistant_text_rendered.event_time_ms = 1_201;
expectInvalid(futureEvent, "signal_event_time_after_snapshot");

const preTurnRender = structuredClone(baseSnapshot);
preTurnRender.signals.assistant_text_rendered.event_time_ms = 999;
expectInvalid(preTurnRender, "rendered_event_precedes_turn_start");

const mismatchedTurn = structuredClone(baseSnapshot);
const mismatchResult = normalizeVisibleFeedbackLedger(mismatchedTurn, 1_300, null, "turn-other");
assert.equal(mismatchResult.ok, false);
assert.equal(mismatchResult.reason, "stale");
assert.equal(mismatchResult.detail, "turn_identity_mismatch");

const regressedClock = structuredClone(secondSnapshot);
regressedClock.observed_at_ms = 1_399;
const regressedClockResult = normalizeVisibleFeedbackLedger(regressedClock, 1_600, acceptedSecond.value, "turn-1");
assert.equal(regressedClockResult.ok, false);
assert.equal(regressedClockResult.detail, "snapshot_observed_at_regressed");

const regressedExecutionRevision = structuredClone(secondSnapshot);
regressedExecutionRevision.observed_at_ms = 1_600;
regressedExecutionRevision.signals.execution_activity.execution_revision = 2;
const regressedExecutionResult = normalizeVisibleFeedbackLedger(regressedExecutionRevision, 1_700, acceptedSecond.value, "turn-1");
assert.equal(regressedExecutionResult.ok, false);
assert.equal(regressedExecutionResult.detail, "session_signal_revision_regressed");

const changedSignatureWithoutRevision = structuredClone(secondSnapshot);
changedSignatureWithoutRevision.observed_at_ms = 1_600;
changedSignatureWithoutRevision.signals.assistant_text_rendered.signature = "12:other-hash";
const changedSignatureResult = normalizeVisibleFeedbackLedger(changedSignatureWithoutRevision, 1_700, acceptedSecond.value, "turn-1");
assert.equal(changedSignatureResult.ok, false);
assert.equal(changedSignatureResult.detail, "render_signature_revision_mismatch");

const newTurn = structuredClone(baseSnapshot);
newTurn.turn_id = "turn-2";
newTurn.turn_started_at_ms = 1_500;
newTurn.observed_at_ms = 1_600;
newTurn.text_revision = 0;
newTurn.signals.assistant_text_rendered.revision = 0;
newTurn.signals.assistant_text_rendered.event_time_ms = 1_550;
newTurn.signals.assistant_text_rendered.signature = "8:new-turn";
newTurn.signals.execution_activity.event_time_ms = 1_560;
newTurn.signals.execution_activity.mutation_revision = 7;
newTurn.signals.execution_activity.execution_revision = 4;
newTurn.signals.transport_state.event_time_ms = 1_590;
const acceptedNewTurn = normalizeVisibleFeedbackLedger(newTurn, 1_700, acceptedSecond.value, "turn-2");
assert.equal(acceptedNewTurn.ok, true, acceptedNewTurn.ok ? "" : acceptedNewTurn.detail);
assert.equal(acceptedNewTurn.value.text_revision, 0, "text revision may reset for a new turn");

const staleOldTurn = structuredClone(baseSnapshot);
staleOldTurn.observed_at_ms = 1_650;
const staleOldTurnResult = normalizeVisibleFeedbackLedger(staleOldTurn, 1_800, acceptedNewTurn.value, "turn-1");
assert.equal(staleOldTurnResult.ok, false);
assert.equal(staleOldTurnResult.reason, "stale");
assert.equal(staleOldTurnResult.detail, "older_turn_arrived_after_newer_turn");

const unknownTransport = structuredClone(baseSnapshot);
unknownTransport.signals.transport_state.status = "unknown";
unknownTransport.signals.transport_state.state = "unknown";
unknownTransport.signals.transport_state.event_time_ms = null;
const acceptedUnknownTransport = normalizeVisibleFeedbackLedger(unknownTransport, 1_300, null, "turn-1");
assert.equal(acceptedUnknownTransport.ok, true, acceptedUnknownTransport.ok ? "" : acceptedUnknownTransport.detail);

const badTransport = structuredClone(baseSnapshot);
badTransport.signals.transport_state.status = "unknown";
const badTransportResult = normalizeVisibleFeedbackLedger(badTransport, 1_300, null, "turn-1");
assert.equal(badTransportResult.ok, false);
assert.equal(badTransportResult.detail, "transport_status_state_mismatch");

const unavailableRendered = structuredClone(baseSnapshot);
unavailableRendered.signals.assistant_text_rendered.status = "unavailable";
unavailableRendered.signals.assistant_text_rendered.signature = null;
unavailableRendered.signals.assistant_text_rendered.event_time_ms = null;
const acceptedUnavailableRendered = normalizeVisibleFeedbackLedger(unavailableRendered, 1_300, null, "turn-1");
assert.equal(acceptedUnavailableRendered.ok, true, acceptedUnavailableRendered.ok ? "" : acceptedUnavailableRendered.detail);
assert.equal(acceptedUnavailableRendered.value.signals.assistant_text_rendered.received_at_ms, null);

const summary = summarizeVisibleFeedbackLedger(accepted.value);
assert.equal(JSON.stringify(summary).includes("12:answer-hash"), false, "dashboard summary must not expose even the DOM signature");
assert.equal(JSON.stringify(summary).includes("PRIVATE"), false);
assert.equal(summary.signals.assistant_text_emitted.status, "unavailable");

const helperLedger = helper.buildVisibleFeedbackLedger({
  turn_id: "turn-dom",
  turn_started_at_ms: 2_000,
  observed_at_ms: 2_200,
  rendered,
  render_state: helper.updateAssistantRenderRevision(null, "turn-dom", rendered, 2_100),
  mutation_revision: 10,
  execution_revision: 2,
  execution_event_time_ms: 2_150,
  generation_active: true,
  tool_inflight_count: 1,
  transport: { state: "online", revision: 1, event_time_ms: 2_190 },
});
const helperLedgerAccepted = normalizeVisibleFeedbackLedger(helperLedger, 2_250, null, "turn-dom");
assert.equal(helperLedgerAccepted.ok, true, helperLedgerAccepted.ok ? "" : helperLedgerAccepted.detail);

console.log("OK visible feedback ledger: DOM isolation, four-signal provenance, turn identity, revision monotonicity, event/receive clocks, and no host-emission inference");