"use strict";

const ADAPTER_VERSION = "chatgpt-dom-v1";
const TICK_MS = 2000;
const REQUIRED_CHAT_PLUGIN_NAME = "chatgpt_web_harness";
const REQUIRED_CHAT_PLUGIN_ID = "plugin_asdk_app_6aa6c3909b6c81918435d1d6b83a1762";
const REQUIRED_CHAT_PLUGIN_ORIGIN = "inline_selection_pill";
const CONNECTION_INTERRUPTED_PATTERNS = [
  "connection interrupted",
  "waiting for the complete answer",
  "message delivery timed out",
  "chatgpt stream recovery polling timed out",
  "连接中断",
  "正在等待完整回复",
  "消息传递超时",
  "消息发送超时",
];

let activityRevision = 0;
let executionActivityRevision = 0;
let lastExecutionActivityAtMs = null;
let tickRunning = false;
let currentTurnId = "";
let currentTurnStartedAt = "";
let previousGenerationActive = false;
let previousFailureVisible = false;
let assistantTokenRevision = 0;
let lastAssistantSignature = "";
let assistantRenderState = null;
let observedSendAtMs = null;
let companionTransport = {
  state: "unknown",
  revision: 0,
  event_time_ms: null,
  reason_code: "awaiting_companion_api_ack",
};
const EXECUTION_SURFACE_SELECTOR = [
  "[data-message-author-role='assistant']",
  "[data-message-author-role='tool']",
  "[data-testid*='tool']",
  "button[data-testid='stop-button']",
  "button[aria-label*='Stop']",
  "[aria-busy='true']",
].join(",");

/**
 * An entire short assistant answer can appear between two 2-second ticks.
 * Capture a *local DOM baseline* just before an observed send activation;
 * this proves neither Host emission nor successful ChatGPT delivery.
 */
function beginObservedSendTurn() {
  const helper = globalThis.HarnessVisibleFeedbackLedger;
  if (!helper?.readVisibleAssistantSnapshot || !helper?.updateAssistantRenderRevision) return false;
  const now = Date.now();
  if (observedSendAtMs !== null && currentTurnId && now - observedSendAtMs < 600) return true;
  const snapshot = helper.readVisibleAssistantSnapshot(document, visible);
  currentTurnId = crypto.randomUUID();
  currentTurnStartedAt = new Date(now).toISOString();
  assistantRenderState = helper.updateAssistantRenderRevision(null, currentTurnId, snapshot, now);
  assistantTokenRevision = assistantRenderState.revision;
  lastAssistantSignature = assistantRenderState.signature || "";
  observedSendAtMs = now;
  return true;
}

function observeTurnAssistantTextChange(atMs) {
  if (!currentTurnId || !assistantRenderState) return;
  const helper = globalThis.HarnessVisibleFeedbackLedger;
  if (!helper?.readVisibleAssistantSnapshot || !helper?.updateAssistantRenderRevision) return;
  const snapshot = helper.readVisibleAssistantSnapshot(document, visible);
  assistantRenderState = helper.updateAssistantRenderRevision(assistantRenderState, currentTurnId, snapshot, atMs);
  assistantTokenRevision = assistantRenderState.revision;
  lastAssistantSignature = assistantRenderState.signature || "";
}

function mutationIsWithinComposer(node) {
  const composer = findComposer()?.element;
  if (!composer) return false;
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return Boolean(element && (element === composer || composer.contains(element)));
}

function mutationTargetVisible(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  return !element || visible(element);
}

function nodeIsVisibleExecutionSurface(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element || mutationIsWithinComposer(element)) return false;
  const surface = element.matches?.(EXECUTION_SURFACE_SELECTOR)
    ? element
    : element.closest?.(EXECUTION_SURFACE_SELECTOR);
  return Boolean(surface && visible(surface));
}

function mutationTouchesExecution(record) {
  if (mutationIsWithinComposer(record.target)) return false;
  if (nodeIsVisibleExecutionSurface(record.target)) return true;
  return [...(record.addedNodes || []), ...(record.removedNodes || [])].some(nodeIsVisibleExecutionSurface);
}

new MutationObserver((records) => {
  activityRevision += 1;
  const executionMutation = records.some(mutationTouchesExecution);
  if (executionMutation) {
    executionActivityRevision += 1;
    lastExecutionActivityAtMs = Date.now();
    // Mutation callbacks run independently of heartbeat polling and can
    // observe an entire one-shot reply before any generating-state tick.
    observeTurnAssistantTextChange(lastExecutionActivityAtMs);
  }
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ["disabled", "aria-disabled", "data-state"],
});

document.addEventListener("click", (event) => {
  if (event.isTrusted !== true || conversationSurface() !== "CHAT") return;
  const send = findSendButton()?.element;
  if (send && (event.target === send || send.contains?.(event.target)) &&
      !send.disabled && send.getAttribute("aria-disabled") !== "true") {
    beginObservedSendTurn();
  }
}, true);

document.addEventListener("keydown", (event) => {
  if (event.isTrusted !== true || event.key !== "Enter" || event.isComposing ||
      event.shiftKey || event.altKey || event.ctrlKey || event.metaKey ||
      conversationSurface() !== "CHAT") return;
  const composer = findComposer()?.element;
  const send = findSendButton()?.element;
  if (composer && send && composer.contains(event.target) &&
      !send.disabled && send.getAttribute("aria-disabled") !== "true") {
    beginObservedSendTurn();
  }
}, true);

function visible(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element)) return { element, selector };
    }
  }
  return null;
}

function findComposer() {
  const known = firstVisible([
    "#prompt-textarea",
    "textarea[data-id='root']",
    "[contenteditable='true'][data-lexical-editor='true']",
  ]);
  if (known) return { ...known, confidence: "high" };
  const fallback = firstVisible(["textarea", "[contenteditable='true']"]);
  return fallback ? { ...fallback, confidence: "medium" } : null;
}

function findSendButton() {
  const known = firstVisible([
    "button[data-testid='send-button']",
    "button[aria-label='Send prompt']",
    "button[aria-label='Send message']",
    "button[aria-label='发送提示']",
    "button[aria-label='发送消息']",
  ]);
  if (known) return { ...known, confidence: "high" };
  const buttons = [...document.querySelectorAll("button")].filter(visible);
  const fallback = buttons.find((button) => /^(send|发送)$/i.test((button.getAttribute("aria-label") || button.textContent || "").trim()));
  return fallback ? { element: fallback, selector: "semantic-send-fallback", confidence: "medium" } : null;
}

function normalizedElementText(element) {
  return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
}

function selectedToggle(element) {
  if (!element) return false;
  if (["true", "active", "checked", "on"].includes(element.getAttribute("aria-checked"))) return true;
  if (["true", "active", "checked", "on"].includes(element.getAttribute("aria-selected"))) return true;
  if (["true", "active", "checked", "on"].includes(element.getAttribute("aria-pressed"))) return true;
  return ["active", "checked", "on"].includes(element.getAttribute("data-state"));
}

function findModeToggle(label) {
  return [...document.querySelectorAll("button, [role='radio'], [role='tab']")].find((element) => (
    visible(element) && normalizedElementText(element) === label
  )) || null;
}

function surfaceEvidenceText(composerElement) {
  if (!composerElement) return "";
  const elements = [composerElement];
  for (let current = composerElement.parentElement, depth = 0; current && depth < 3; current = current.parentElement, depth += 1) {
    elements.push(current);
  }
  for (const descendant of composerElement.querySelectorAll("[placeholder], [aria-label], [data-placeholder]")) {
    elements.push(descendant);
  }
  return elements.map((element) => [
    element.getAttribute?.("placeholder"),
    element.getAttribute?.("aria-label"),
    element.getAttribute?.("data-placeholder"),
  ].filter(Boolean).join(" ")).join(" ").replace(/\s+/g, " ").trim();
}

function visibleHeadingTexts() {
  return [...document.querySelectorAll("h1, h2, h3, [role='heading']")]
    .filter(visible)
    .map(normalizedElementText)
    .filter(Boolean);
}

function classifyConversationSurfaceEvidence({ workSelected, chatSelected, composerEvidence, headingTexts }) {
  if (workSelected) return "WORK";
  if (/\bwork on anything\b|\bwork mode\b|处理任何任务|处理任意任务|工作模式/i.test(composerEvidence)) return "WORK";
  if (headingTexts.some((text) => /(?:^|[·•]\s*)Work$/i.test(text))) return "WORK";
  if (chatSelected) return "CHAT";
  if (/\bask chatgpt\b|\bmessage chatgpt\b|询问\s*ChatGPT|给\s*ChatGPT\s*发送消息/i.test(composerEvidence)) return "CHAT";
  return "UNKNOWN";
}

function conversationSurface() {
  const chat = findModeToggle("Chat");
  const work = findModeToggle("Work");
  const composer = findComposer();
  const workSelected = Boolean(work && selectedToggle(work));
  return classifyConversationSurfaceEvidence({
    workSelected,
    chatSelected: Boolean(chat && selectedToggle(chat) && !workSelected),
    composerEvidence: surfaceEvidenceText(composer?.element),
    headingTexts: visibleHeadingTexts(),
  });
}

function chatModeSelected() {
  return conversationSurface() === "CHAT";
}

async function waitUntil(predicate, timeoutMs, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function ensureChatModeSelected(timeoutMs = 2500) {
  if (chatModeSelected()) return true;
  const chat = findModeToggle("Chat");
  const work = findModeToggle("Work");
  if (!chat || !work) return false;
  const clicked = await trustedClickElement(chat);
  if (!clicked) return false;
  return Boolean(await waitUntil(chatModeSelected, timeoutMs));
}

function isRequiredChatPluginUrl(value) {
  try {
    const url = new URL(String(value || ""), location.href);
    return ["chatgpt.com", "chat.openai.com"].includes(url.hostname)
      && url.pathname.replace(/\/$/, "") === `/plugins/${REQUIRED_CHAT_PLUGIN_ID}`
      && url.searchParams.get("plugin_detail_origin") === REQUIRED_CHAT_PLUGIN_ORIGIN;
  } catch {
    return false;
  }
}

function findRequiredChatPluginToken(composerElement) {
  if (!composerElement) return null;
  return [...composerElement.querySelectorAll("a[href]")].find((anchor) => (
    normalizedElementText(anchor) === REQUIRED_CHAT_PLUGIN_NAME
      && isRequiredChatPluginUrl(anchor.getAttribute("href"))
  )) || null;
}

function findComposerPlusButton() {
  const candidates = [...document.querySelectorAll("#composer-plus-btn, button[aria-label='Add files and more'], button[aria-label='添加文件及更多内容']")]
    .filter(visible);
  return candidates.length === 1 ? candidates[0] : null;
}

function findRequiredChatPluginMenuItem(composerElement) {
  const candidates = [...document.querySelectorAll("[role='menuitem'], [data-radix-collection-item], .__menu-item")]
    .filter((element) => {
      if (!visible(element) || composerElement?.contains(element)) return false;
      const exactNames = [...element.querySelectorAll("span, div, p")].filter((child) => (
        visible(child) && normalizedElementText(child) === REQUIRED_CHAT_PLUGIN_NAME
      ));
      return exactNames.length === 1;
    });
  return candidates.length === 1 ? candidates[0] : null;
}

async function trustedClickElement(element) {
  if (!element || !visible(element)) return false;
  const rect = element.getBoundingClientRect();
  const response = await chrome.runtime.sendMessage({
    type: "companion:trusted-plugin-click",
    point: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  });
  return Boolean(response?.ok);
}

async function selectRequiredChatPlugin(composerElement) {
  if (!composerElement || normalizedElementText(composerElement)) {
    return { ok: false, detail: "Chat composer was not empty before plugin selection" };
  }
  const plus = findComposerPlusButton();
  if (!plus) return { ok: false, detail: "Unique Chat plugin menu control is unavailable" };
  if (!(await trustedClickElement(plus))) {
    return { ok: false, detail: "Trusted Chat plugin menu activation failed" };
  }
  const menuOpened = await waitUntil(() => (
    plus.getAttribute("aria-expanded") === "true"
      || normalizedElementText(document.querySelector("[role='dialog'], [role='menu']"))
        .includes("Type to search plugins")
  ), 2500);
  if (!menuOpened) return { ok: false, detail: "Chat plugin menu did not open" };

  composerElement.focus();
  const typed = await chrome.runtime.sendMessage({ type: "companion:trusted-plugin-input" });
  if (!typed?.ok) return { ok: false, detail: `Trusted plugin search input failed: ${typed?.reason || "unknown"}` };
  const menuItem = await waitUntil(() => findRequiredChatPluginMenuItem(composerElement), 6000);
  if (!menuItem) {
    dispatchInput(composerElement, "");
    return { ok: false, detail: "Required Chat plugin was not the unique exact menu result" };
  }
  if (!(await trustedClickElement(menuItem))) {
    dispatchInput(composerElement, "");
    return { ok: false, detail: "Trusted plugin selection failed" };
  }
  const selectedComposer = await waitUntil(() => {
    const current = findComposer();
    return current?.confidence === "high" && findRequiredChatPluginToken(current.element) ? current : null;
  }, 6000);
  if (!selectedComposer) {
    dispatchInput(findComposer()?.element, "");
    return { ok: false, detail: "Exact Harness plugin token did not appear after selection" };
  }
  if (conversationSurface() !== "CHAT") {
    return { ok: false, detail: "Harness plugin selection left the verified Chat surface" };
  }
  return { ok: true, composer: selectedComposer };
}

async function ensureRequiredChatPlugin() {
  if (conversationSurface() !== "CHAT" && !(await ensureChatModeSelected())) {
    return { ok: false, detail: `Verified Chat surface is required; observed ${conversationSurface()}` };
  }
  let composer = findComposer();
  if (!composer || composer.confidence !== "high") {
    return { ok: false, detail: "Canonical Chat composer is unavailable after Chat-mode selection" };
  }
  if (findRequiredChatPluginToken(composer.element)) {
    return conversationSurface() === "CHAT"
      ? { ok: true, composer }
      : { ok: false, detail: "Harness plugin token exists outside a verified Chat surface" };
  }
  composer = findComposer();
  if (!composer || composer.confidence !== "high") {
    return { ok: false, detail: "Canonical Chat composer is unavailable after Chat-mode selection" };
  }
  const existingText = normalizedElementText(composer.element);
  if (existingText === REQUIRED_CHAT_PLUGIN_NAME) {
    // Clean residue left by a pre-rc.6 search-based activation attempt. New
    // Workers enter through the plugin page and never synthesize this query.
    dispatchInput(composer.element, "");
  } else if (existingText) {
    return { ok: false, detail: "Chat composer was not empty before plugin selection" };
  }
  return selectRequiredChatPlugin(composer.element);
}

function appendInputAfterRequiredPlugin(composerElement, text) {
  if (!composerElement || !findRequiredChatPluginToken(composerElement)) return false;
  if (composerElement.getAttribute("contenteditable") !== "true") return false;
  composerElement.focus();
  const selection = getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(composerElement);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
  const insertion = /\s$/.test(composerElement.textContent || "") ? text : ` ${text}`;
  let inserted = false;
  try { inserted = document.execCommand("insertText", false, insertion); } catch {}
  if (!inserted) return false;
  composerElement.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: insertion,
  }));
  return Boolean(
    findRequiredChatPluginToken(composerElement)
      && (composerElement.textContent || "").includes(text),
  );
}

function findStopButton() {
  const known = firstVisible([
    "button[data-testid='stop-button']",
    "button[aria-label='Stop streaming']",
    "button[aria-label='Stop generating']",
    "button[aria-label='停止生成']",
  ]);
  if (known) return known;
  const buttons = [...document.querySelectorAll("button")].filter(visible);
  const fallback = buttons.find((button) => /stop (streaming|generating)|停止生成/i.test((button.getAttribute("aria-label") || button.textContent || "").trim()));
  return fallback ? { element: fallback, selector: "semantic-stop-fallback", confidence: "medium" } : null;
}

function generationActive() {
  return Boolean(findStopButton());
}

function retryVisible() {
  return Boolean([...document.querySelectorAll("button")].find((button) => {
    if (!visible(button)) return false;
    const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
    return /^(retry|重试)$/i.test(label);
  }));
}

function toolInflightCount() {
  const selectors = [
    "[data-testid*='tool'][data-state='loading']",
    "[data-testid*='tool'][aria-busy='true']",
    "[data-message-author-role='tool'][data-state='loading']",
    "[data-message-author-role='tool'][aria-busy='true']",
  ];
  return new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)].filter(visible))).size;
}

function compactSignature(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function latestAssistantSignature() {
  const helper = globalThis.HarnessVisibleFeedbackLedger;
  if (helper?.readVisibleAssistantSnapshot) {
    return helper.readVisibleAssistantSnapshot(document, visible).signature || "";
  }
  const turns = [...document.querySelectorAll("[data-message-author-role='assistant']")].filter(visible);
  const latest = turns.at(-1);
  if (!latest) return "";
  return compactSignature(latest.innerText || latest.textContent || "");
}

function refreshTurnTelemetry(generating, interrupted, retry) {
  const failureVisible = interrupted || retry;
  const observedAtMs = Date.now();
  const helper = globalThis.HarnessVisibleFeedbackLedger;
  const renderedSnapshot = helper?.readVisibleAssistantSnapshot
    ? helper.readVisibleAssistantSnapshot(document, visible)
    : { status: "unavailable", signature: null, reason_code: "ledger_helper_unavailable" };
  // Never overwrite a previously captured trusted-send baseline just because
  // the generating indicator appears after the new assistant DOM text.
  const hasRecentSend = observedSendAtMs !== null && currentTurnId &&
    observedAtMs >= observedSendAtMs && observedAtMs - observedSendAtMs <= 120_000;
  if (((generating && !previousGenerationActive) || (failureVisible && !previousFailureVisible)) &&
      !hasRecentSend) {
    currentTurnId = crypto.randomUUID();
    currentTurnStartedAt = new Date(observedAtMs).toISOString();
    assistantTokenRevision = 0;
    lastExecutionActivityAtMs = null;
    lastAssistantSignature = renderedSnapshot.signature || "";
    assistantRenderState = helper?.updateAssistantRenderRevision
      ? helper.updateAssistantRenderRevision(null, currentTurnId, renderedSnapshot, observedAtMs)
      : { turn_id: currentTurnId, revision: 0, signature: lastAssistantSignature || null, event_time_ms: null };
  }
  if (observedSendAtMs !== null && observedAtMs - observedSendAtMs > 120_000) {
    observedSendAtMs = null;
  }
  if (currentTurnId) {
    if (helper?.updateAssistantRenderRevision) {
      assistantRenderState = helper.updateAssistantRenderRevision(assistantRenderState, currentTurnId, renderedSnapshot, observedAtMs);
      assistantTokenRevision = assistantRenderState.revision;
      lastAssistantSignature = assistantRenderState.signature || "";
    } else {
      const signature = renderedSnapshot.signature || latestAssistantSignature();
      if (signature && signature !== lastAssistantSignature) {
        assistantTokenRevision += 1;
        lastAssistantSignature = signature;
        assistantRenderState = { turn_id: currentTurnId, revision: assistantTokenRevision, signature, event_time_ms: observedAtMs };
      }
    }
  }
  // A fully rendered one-shot answer with no active generation has completed
  // this send observation. Do not let its token suppress the next turn's own
  // generation rising edge. Until text appears, keep the bounded send intent
  // so a late reply can still be attributed to the original visible send.
  if (observedSendAtMs !== null && !generating && !failureVisible && assistantTokenRevision > 0) {
    observedSendAtMs = null;
  }
  previousGenerationActive = generating;
  previousFailureVisible = failureVisible;
  return {
    turn_id: currentTurnId || null,
    turn_started_at: currentTurnStartedAt || null,
    assistant_token_revision: assistantTokenRevision,
    observed_at_ms: observedAtMs,
    rendered_snapshot: renderedSnapshot,
    render_state: assistantRenderState,
  };
}

function observeCompanionTransport(response, eventTimeMs) {
  let state = "offline";
  let reasonCode = "companion_api_unavailable";
  if (response?.ok === true) {
    state = "online";
    reasonCode = "companion_api_acknowledged";
  } else if (response?.reason === "unbound_goal_scope") {
    state = "unbound";
    reasonCode = "worker_binding_unavailable";
  } else if (response?.reason === "missing_tab") {
    state = "unknown";
    reasonCode = "tab_identity_unavailable";
  }
  if (state !== companionTransport.state || reasonCode !== companionTransport.reason_code) {
    companionTransport = {
      state,
      revision: companionTransport.revision + 1,
      event_time_ms: eventTimeMs,
      reason_code: reasonCode,
    };
  } else {
    companionTransport = { ...companionTransport, event_time_ms: eventTimeMs };
  }
}

function connectionInterrupted() {
  const matchesPattern = (element) => {
    if (!visible(element)) return false;
    const text = (element.innerText || element.textContent || "").toLowerCase();
    return CONNECTION_INTERRUPTED_PATTERNS.some((pattern) => text.includes(pattern));
  };

  // Prefer explicit live-region/error surfaces. Never scan the whole
  // transcript: a user can legitimately discuss an error string such as
  // "Message delivery timed out", and conversation text is not runtime
  // liveness evidence.
  for (const selector of [
    "[role='alert']",
    "[aria-live='assertive']",
    "[data-testid*='error']",
    "[data-testid*='retry']",
  ]) {
    for (const element of document.querySelectorAll(selector)) {
      if (matchesPattern(element)) return true;
    }
  }

  // Current ChatGPT delivery failures surface a visible Retry/重试 control
  // next to the error. Walk only a small ancestor window around that control
  // so the signal remains local to the failure UI rather than the transcript.
  const retryButtons = [...document.querySelectorAll("button")].filter((button) => {
    if (!visible(button)) return false;
    const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
    return /^(retry|重试)$/i.test(label);
  });
  for (const button of retryButtons) {
    let element = button;
    for (let depth = 0; element && depth < 5; depth += 1, element = element.parentElement) {
      // Never promote a quoted transcript error merely because another Retry
      // control shares its page/turn ancestor. Only the local failure UI counts.
      if (element === document.body || element === document.documentElement
        || ["BODY", "HTML", "MAIN"].includes(element.tagName)
        || ["user", "assistant"].includes(element.getAttribute?.("data-message-author-role"))) break;
      if (matchesPattern(element)) return true;
    }
  }
  return false;
}

function adapterConfidence() {
  const composer = findComposer();
  const send = findSendButton();
  if (composer?.confidence === "high" && (generationActive() || send?.confidence === "high")) return "high";
  // A freshly provisioned ChatGPT conversation can expose the canonical
  // composer before it renders/enables the Send control.  That state is safe
  // enough to receive a relay activation because deliver() still refuses to
  // click until the Send control is re-discovered *after* the relay text is
  // populated.  Reporting "low" here creates a deadlock: Relay will never
  // deliver the text that causes ChatGPT to materialize the Send control.
  if (composer?.confidence === "high") return "medium";
  if (composer && (generationActive() || send)) return "medium";
  return "low";
}

function telemetry() {
  const composer = findComposer();
  const stop = findStopButton();
  const generating = Boolean(stop);
  const interrupted = connectionInterrupted();
  const retry = retryVisible();
  const turn = refreshTurnTelemetry(generating, interrupted, retry);
  const { observed_at_ms: observedAtMs, rendered_snapshot: renderedSnapshot, render_state: renderState, ...turnFields } = turn;
  const surface = conversationSurface();
  const inflight = toolInflightCount();
  const feedbackLedger = globalThis.HarnessVisibleFeedbackLedger?.buildVisibleFeedbackLedger?.({
    turn_id: turnFields.turn_id,
    turn_started_at_ms: currentTurnStartedAt ? Date.parse(currentTurnStartedAt) : null,
    observed_at_ms: observedAtMs,
    rendered: renderedSnapshot,
    render_state: renderState,
    mutation_revision: activityRevision,
    execution_revision: executionActivityRevision,
    execution_event_time_ms: lastExecutionActivityAtMs,
    generation_active: generating,
    tool_inflight_count: inflight,
    transport: companionTransport,
  }) || null;
  return {
    conversation_url: location.href,
    adapter_version: ADAPTER_VERSION,
    adapter_confidence: adapterConfidence(),
    composer_ready: Boolean(composer && !generating),
    conversation_surface: surface,
    chat_mode_selected: surface === "CHAT",
    required_plugin_ready: Boolean(composer && findRequiredChatPluginToken(composer.element)),
    generation_active: generating,
    connection_interrupted: interrupted,
    stop_button_visible: Boolean(stop),
    retry_visible: retry,
    tool_inflight_count: inflight,
    activity_revision: activityRevision,
    feedback_ledger: feedbackLedger,
    ...turnFields,
  };
}

function isFormalConversationUrl(value = location.href) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname) && /^\/c\/[^/?#]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function markerVisibleInTranscript(marker) {
  if (!marker) return false;
  // Never treat text still sitting in the composer as delivery proof.  Only
  // recognized conversation-turn surfaces can prove that ChatGPT accepted the
  // message.  This closes the READY_BLANK false-positive where a repeated tick
  // saw its own unsent marker and reported sent_proven.
  for (const selector of [
    "[data-message-author-role='user']",
    "[data-testid^='conversation-turn-']",
    "article",
  ]) {
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element) && (element.innerText || element.textContent || "").includes(marker)) return true;
    }
  }
  return false;
}

function dispatchInput(element, text) {
  element.focus();
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor?.set?.call(element, text);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return element.value === text;
  }
  if (element.getAttribute("contenteditable") === "true") {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch {}
    if (!inserted) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
    return (element.textContent || "").includes(text);
  }
  return false;
}

async function waitForProof(marker, requireFormalConversation = false, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (markerVisibleInTranscript(marker) && (!requireFormalConversation || isFormalConversationUrl())) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function waitForSendAfterInput(timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (generationActive()) return null;
    const send = findSendButton();
    if (send && !send.element.disabled && send.element.getAttribute("aria-disabled") !== "true") return send;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function attemptKeyboardSend(composer) {
  if (!composer || composer.confidence !== "high") return false;
  // A synthetic Enter is only a bounded compatibility fallback.  If ChatGPT
  // ignores untrusted key events nothing is assumed; if it accepts the event,
  // the caller still requires transcript + formal-conversation proof and
  // otherwise records an ambiguous activation instead of retrying.
  beginObservedSendTurn();
  const options = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
  composer.element.dispatchEvent(new KeyboardEvent("keydown", options));
  composer.element.dispatchEvent(new KeyboardEvent("keypress", options));
  composer.element.dispatchEvent(new KeyboardEvent("keyup", options));
  return true;
}

async function deliver(command, doNotActivate) {
  if (!command?.command_id || !command?.marker || !command?.message) return;
  const surface = conversationSurface();
  if (surface !== "CHAT") {
    await chrome.runtime.sendMessage({
      type: "companion:delivery",
      command_id: command.command_id,
      status: "failed_before_activation",
      detail: `Relay activation requires a verified Chat surface; observed ${surface}`,
    });
    return;
  }
  const requiresConversationEstablishment = !isFormalConversationUrl();
  if (markerVisibleInTranscript(command.marker) && (!requiresConversationEstablishment || isFormalConversationUrl())) {
    await chrome.runtime.sendMessage({ type: "companion:delivery", command_id: command.command_id, status: "sent_proven" });
    return;
  }
  if (doNotActivate) {
    // A previous click may already have reached ChatGPT. Never click again;
    // retain the same claim and only wait for the unique marker to prove it.
    return;
  }
  if (generationActive()) {
    await chrome.runtime.sendMessage({
      type: "companion:delivery",
      command_id: command.command_id,
      status: "failed_before_activation",
      detail: "Standby lane started generating before relay activation",
    });
    return;
  }
  const initialComposer = findComposer();
  if (!initialComposer || adapterConfidence() === "low") {
    await chrome.runtime.sendMessage({
      type: "companion:delivery",
      command_id: command.command_id,
      status: "failed_before_activation",
      detail: "ChatGPT composer could not be identified safely",
    });
    return;
  }
  const capability = await ensureRequiredChatPlugin();
  if (!capability.ok) {
    await chrome.runtime.sendMessage({
      type: "companion:delivery",
      command_id: command.command_id,
      status: "failed_before_activation",
      detail: capability.detail,
    });
    return;
  }
  const composer = capability.composer;
  if (!appendInputAfterRequiredPlugin(composer.element, command.message)) {
    await chrome.runtime.sendMessage({
      type: "companion:delivery",
      command_id: command.command_id,
      status: "failed_before_activation",
      detail: "Could not append relay text while preserving the required Chat plugin token",
    });
    return;
  }

  // On a brand-new ChatGPT tab the Send control is commonly absent/disabled
  // until input has been committed to the composer.  Re-discover it only
  // after dispatchInput, and keep the operation fail-closed if ChatGPT never
  // exposes an enabled, recognized control.  No click has happened yet, so a
  // failure here remains safely retryable.
  const send = await waitForSendAfterInput();
  if (!send) {
    if (!attemptKeyboardSend(composer)) {
      await chrome.runtime.sendMessage({
        type: "companion:delivery",
        command_id: command.command_id,
        status: "failed_before_activation",
        detail: "ChatGPT send control did not become safely available after composer input",
      });
      return;
    }
    if (await waitForProof(command.marker, requiresConversationEstablishment)) {
      await chrome.runtime.sendMessage({ type: "companion:delivery", command_id: command.command_id, status: "sent_proven" });
    } else {
      await chrome.runtime.sendMessage({ type: "companion:delivery", command_id: command.command_id, status: "activation_ambiguous" });
    }
    return;
  }

  // From this line onward the send outcome may be ambiguous. The worker stores
  // that ambiguity durably for this browser session before any retry can occur.
  beginObservedSendTurn();
  send.element.click();
  if (await waitForProof(command.marker, requiresConversationEstablishment)) {
    await chrome.runtime.sendMessage({ type: "companion:delivery", command_id: command.command_id, status: "sent_proven" });
  } else {
    await chrome.runtime.sendMessage({ type: "companion:delivery", command_id: command.command_id, status: "activation_ambiguous" });
  }
}

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "companion:tick", telemetry: telemetry() });
    observeCompanionTransport(response, Date.now());
    if (response?.ok && response.command) {
      await deliver(response.command, Boolean(response.do_not_activate));
    }
  } catch {
    observeCompanionTransport(null, Date.now());
    // Browser UI must never be disturbed by bridge outages. The local manager
    // will retain/expire the command and restore the source Driver if needed.
  } finally {
    tickRunning = false;
  }
}

setInterval(tick, TICK_MS);
void tick();
