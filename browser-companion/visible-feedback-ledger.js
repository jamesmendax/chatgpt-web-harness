"use strict";

(function exposeVisibleFeedbackLedger(global) {
  const ASSISTANT_SELECTOR = "[data-message-author-role='assistant']";

  function compactSignature(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
  }

  function attribute(element, name) {
    try { return element?.getAttribute?.(name) ?? null; } catch { return null; }
  }

  function excludedFromAssistantText(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.hidden || attribute(element, "hidden") !== null || attribute(element, "aria-hidden") === "true") return true;
    const tagName = String(element.tagName || "").toUpperCase();
    if (["BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tagName)) return true;
    if (attribute(element, "contenteditable") === "true") return true;
    if (attribute(element, "data-message-author-role") === "tool") return true;
    const testId = String(attribute(element, "data-testid") || "").toLowerCase();
    if (testId.includes("tool") || testId.includes("code-interpreter") || testId.includes("tool-result")) return true;
    const role = String(attribute(element, "role") || "").toLowerCase();
    if (role === "progressbar" || role === "status" && attribute(element, "aria-busy") === "true") return true;
    return false;
  }

  function collectVisibleText(node, root, isVisible) {
    if (!node) return "";
    if (node.nodeType === 3) return String(node.nodeValue || "");
    if (node.nodeType !== 1) return "";
    if (excludedFromAssistantText(node)) return "";
    if (node !== root && typeof isVisible === "function" && !isVisible(node)) return "";
    const children = Array.from(node.childNodes || []);
    if (children.length) return children.map((child) => collectVisibleText(child, root, isVisible)).join(" ");
    return String(node.innerText || node.textContent || "");
  }

  /**
   * Observe rendered assistant-role text only. This is a DOM observation, not
   * proof that the ChatGPT host emitted or delivered an assistant message.
   * The returned value contains a hash/length only; raw transcript text stays
   * in the page and is never sent to the Companion API.
   */
  function readVisibleAssistantSnapshot(documentRef, isVisible) {
    if (!documentRef || typeof documentRef.querySelectorAll !== "function") {
      return { status: "unavailable", signature: null, text_length: 0, source: "dom_observation", reason_code: "document_unavailable" };
    }
    const turns = Array.from(documentRef.querySelectorAll(ASSISTANT_SELECTOR));
    const latest = turns.filter((element) => typeof isVisible !== "function" || isVisible(element)).at(-1);
    if (!latest) {
      return { status: "unavailable", signature: null, text_length: 0, source: "dom_observation", reason_code: "no_visible_assistant_message" };
    }
    const text = collectVisibleText(latest, latest, isVisible).replace(/\s+/g, " ").trim();
    if (!text) {
      return { status: "unavailable", signature: null, text_length: 0, source: "dom_observation", reason_code: "assistant_message_has_no_visible_text" };
    }
    const messageIdentity = attribute(latest, "data-message-id") || attribute(latest, "id") || "";
    const signatureInput = messageIdentity ? `${messageIdentity}\n${text}` : text;
    return { status: "observed", signature: compactSignature(signatureInput), text_length: text.length, source: "dom_observation" };
  }

  function updateAssistantRenderRevision(previous, turnId, snapshot, observedAtMs) {
    const observed = snapshot?.status === "observed" && Boolean(snapshot.signature);
    const baseline = {
      turn_id: turnId || null,
      revision: 0,
      signature: observed ? snapshot.signature : null,
      // The latest visible assistant node may be the previous turn's answer.
      // Keep its signature as a baseline, but do not claim it was rendered in
      // this turn until genuinely unseen DOM content appears.
      event_time_ms: null,
      visible: observed,
      baseline_signature: observed ? snapshot.signature : null,
      // Keep a bounded record of revisions seen in this turn. A virtualized
      // latest assistant node can disappear, exposing an older visible reply;
      // switching back to that old signature is not fresh assistant output.
      seen_signatures: observed ? [snapshot.signature] : [],
    };
    if (!previous || previous.turn_id !== (turnId || null)) return baseline;
    if (!observed) {
      return previous.visible === false ? previous : { ...previous, visible: false };
    }
    if (snapshot.signature === previous.signature) {
      return previous.visible === true ? previous : { ...previous, visible: true };
    }
    const earlier = Array.isArray(previous.seen_signatures)
      ? previous.seen_signatures
      : (previous.signature ? [previous.signature] : []);
    const originalBaseline = previous.baseline_signature
      ?? (previous.revision === 0 ? previous.signature : null);
    if (snapshot.signature === originalBaseline || earlier.includes(snapshot.signature)) {
      // A newer message was hidden or detached, so an older assistant
      // response became the last visible node. Preserve the latest revision
      // and its event clock; it is temporarily not visible, not newly emitted.
      return previous.visible === false ? previous : { ...previous, visible: false };
    }
    return {
      turn_id: turnId || null,
      revision: previous.revision + 1,
      signature: snapshot.signature,
      event_time_ms: observedAtMs,
      visible: true,
      baseline_signature: originalBaseline,
      seen_signatures: [...earlier, snapshot.signature].slice(-64),
    };
  }

  function buildVisibleFeedbackLedger(input) {
    const turnId = input.turn_id || null;
    const turnStartedAtMs = input.turn_started_at_ms ?? null;
    const rendered = input.rendered || {};
    const renderState = input.render_state || { revision: 0, signature: null, event_time_ms: null };
    const transport = input.transport || { state: "unknown", revision: 0, event_time_ms: null, reason_code: "awaiting_companion_api_ack" };
    const observedAt = input.observed_at_ms;
    const renderedVisible = rendered.status === "observed" && Boolean(renderState.signature)
      && renderState.visible !== false && Number.isSafeInteger(renderState.event_time_ms);
    return {
      schema_version: 1,
      turn_id: turnId,
      turn_started_at_ms: turnStartedAtMs,
      observed_at_ms: observedAt,
      text_revision: renderState.revision,
      signals: {
        assistant_text_emitted: {
          status: "unavailable",
          source: "host_callback",
          reason_code: "host_emission_callback_unavailable",
          event_time_ms: null,
        },
        assistant_text_rendered: {
          status: renderedVisible ? "observed" : "unavailable",
          source: "dom_observation",
          event_time_ms: renderedVisible ? renderState.event_time_ms : null,
          revision: renderState.revision,
          signature: renderedVisible ? renderState.signature : null,
          ...(!renderedVisible ? { reason_code: rendered.reason_code || (rendered.status === "observed" ? "render_baseline_not_new_in_turn" : "no_visible_assistant_message") } : {}),
        },
        execution_activity: {
          status: "observed",
          source: "dom_mutation_observer",
          event_time_ms: input.execution_event_time_ms ?? null,
          mutation_revision: input.mutation_revision,
          execution_revision: input.execution_revision,
          generation_active: Boolean(input.generation_active),
          tool_inflight_count: input.tool_inflight_count,
          composer_mutations_excluded: true,
        },
        transport_state: {
          status: transport.state === "unknown" ? "unknown" : "observed",
          source: "browser_companion_api_ack",
          state: transport.state,
          event_time_ms: transport.event_time_ms,
          revision: transport.revision,
          ...(transport.reason_code ? { reason_code: transport.reason_code } : {}),
        },
      },
    };
  }

  global.HarnessVisibleFeedbackLedger = Object.freeze({
    readVisibleAssistantSnapshot,
    updateAssistantRenderRevision,
    buildVisibleFeedbackLedger,
  });
})(globalThis);