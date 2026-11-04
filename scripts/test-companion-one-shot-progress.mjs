import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { normalizeVisibleFeedbackLedger } from "../dist/lib/visible-feedback-ledger.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = await fs.readFile(path.join(root, "browser-companion", "visible-feedback-ledger.js"), "utf8");
const contentSource = await fs.readFile(path.join(root, "browser-companion", "content.js"), "utf8");
const bootEnd = contentSource.indexOf("setInterval(tick, TICK_MS);");
assert.ok(bootEnd > 0, "test needs actual Companion content.js before its network tick bootstrap");

function fixture() {
  let clock = 1000;
  let observer;
  let seq = 1;
  const handlers = new Map();
  class TestElement {
    constructor(tagName, attrs = {}, text = "") {
      this.nodeType = 1;
      this.tagName = tagName.toUpperCase();
      this.attrs = attrs;
      this.innerText = text;
      this.textContent = text;
      this.childNodes = [{ nodeType: 3, nodeValue: text, parentElement: this }];
      this.hidden = false;
      this.parentElement = null;
      this.disabled = false;
    }
    getAttribute(k) { return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null; }
    getBoundingClientRect() { return { width: 30, height: 20, left: 0, top: 0 }; }
    matches(selector) {
      const role = this.attrs["data-message-author-role"];
      return Boolean((role === "assistant" && selector.includes("data-message-author-role='assistant'")) ||
        (role === "tool" && selector.includes("data-message-author-role='tool'")) ||
        (this.attrs["aria-busy"] === "true" && selector.includes("aria-busy='true'")));
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    contains(node) {
      for (let current = node; current; current = current.parentElement) if (current === this) return true;
      return false;
    }
    querySelectorAll() { return []; }
  }
  const oldAnswer = new TestElement("article", { "data-message-author-role": "assistant", "data-message-id": "old-1" }, "Earlier visible answer");
  const composer = new TestElement("div", { id: "prompt-textarea", contenteditable: "true" }, "Draft prepared");
  const send = new TestElement("button", { "data-testid": "send-button", "aria-label": "Send message" }, "Send");
  const chat = new TestElement("button", { "aria-pressed": "true" }, "Chat");
  const work = new TestElement("button", { "aria-pressed": "false" }, "Work");
  const answers = [oldAnswer];
  const document = {
    documentElement: new TestElement("html"),
    body: new TestElement("body"),
    querySelectorAll(selector) {
      if (selector === "[data-message-author-role='assistant']") return answers;
      if (selector === "#prompt-textarea") return [composer];
      if (selector === "button[data-testid='send-button']") return [send];
      if (selector === "button, [role='radio'], [role='tab']") return [chat, work, send];
      if (selector === "button") return [chat, work, send];
      return [];
    },
    addEventListener(type, handler) { handlers.set(type, [...(handlers.get(type) || []), handler]); },
  };
  class TestDate extends Date { static now() { return clock; } }
  const sandbox = {
    Date: TestDate, document, Element: TestElement,
    crypto: { randomUUID: () => "turn-" + seq++ },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MutationObserver: class { constructor(handler) { observer = handler; } observe() {} },
    location: { href: "https://chatgpt.com/c/test" },
    URL, console, setInterval() {},
    chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
  };
  vm.createContext(sandbox);
  vm.runInContext(helperSource, sandbox, { filename: "visible-feedback-ledger.js" });
  vm.runInContext(contentSource.slice(0, bootEnd), sandbox, { filename: "content.js" });
  const sample = () => vm.runInContext("telemetry()", sandbox);
  const fire = (type, event) => {
    for (const handler of handlers.get(type) || []) handler(event);
  };
  const addReply = (content, id = "new-1") => {
    clock += 100;
    const reply = new TestElement("article", { "data-message-author-role": "assistant", "data-message-id": id }, content);
    answers.push(reply);
    observer([{ target: reply, addedNodes: [reply], removedNodes: [] }]);
  };
  const sampleGenerating = (generating) => {
    const x = vm.runInContext("refreshTurnTelemetry(" + String(generating) + ",false,false)", sandbox);
    const l = sandbox.HarnessVisibleFeedbackLedger.buildVisibleFeedbackLedger({
      turn_id: x.turn_id,
      turn_started_at_ms: x.turn_started_at ? Date.parse(x.turn_started_at) : null,
      observed_at_ms: x.observed_at_ms,
      rendered: x.rendered_snapshot, render_state: x.render_state,
      mutation_revision: vm.runInContext("activityRevision", sandbox),
      execution_revision: vm.runInContext("executionActivityRevision", sandbox),
      execution_event_time_ms: vm.runInContext("lastExecutionActivityAtMs", sandbox),
      generation_active: generating, tool_inflight_count: 0,
      transport: { state: "unknown", revision: 0, event_time_ms: null },
    });
    return { turn_id: x.turn_id, feedback_ledger: l };
  };
  return { sample, fire, addReply, sampleGenerating, send, composer };
}

const checks = [];
{
  const x = fixture();
  assert.equal(x.sample().feedback_ledger.signals.assistant_text_rendered.status, "unavailable");
  x.fire("click", { isTrusted: true, target: x.send });
  x.addReply("One-shot answer already complete", "one-shot");
  const observed = x.sample();
  assert.equal(observed.turn_id, "turn-1", "trusted send must open the new turn before polling sees generation");
  assert.equal(observed.feedback_ledger.signals.assistant_text_rendered.status, "observed",
    "new answer completed between ticks cannot be discarded as a historical baseline");
  assert.equal(observed.feedback_ledger.text_revision, 1);
  assert.ok(observed.feedback_ledger.signals.assistant_text_rendered.event_time_ms !== null);
  const received = normalizeVisibleFeedbackLedger(observed.feedback_ledger, 1500, null, observed.turn_id);
  assert.equal(received.ok, true, received.ok ? "" : received.detail);
  assert.equal(received.value.signals.assistant_text_emitted.status, "unavailable");
  checks.push("trusted send and one-shot answer between ticks yield a DOM-only receipt");

  const nextGeneration = x.sampleGenerating(true);
  assert.equal(nextGeneration.turn_id, "turn-2",
    "after one-shot answer was delivered in a non-generating poll, a later independent generation edge must not reuse its send intent");
  checks.push("completed one-shot send intent is retired before a later generation turn");
}
{
  const x = fixture();
  x.sample();
  x.addReply("Rehydrated answer without any current send", "hydration");
  const observed = x.sample();
  assert.equal(observed.turn_id, null);
  assert.equal(observed.feedback_ledger.signals.assistant_text_rendered.status, "unavailable");
  checks.push("history hydration without a trusted send never fabricates a new turn");
}
{
  const x = fixture();
  x.sample();
  x.fire("click", { isTrusted: false, target: x.send });
  x.addReply("Untrusted click cannot claim fresh answer", "untrusted");
  assert.equal(x.sample().turn_id, null);
  x.fire("click", { isTrusted: true, target: x.composer });
  x.addReply("Composer click is not send", "draft");
  assert.equal(x.sample().turn_id, null);
  checks.push("synthetic click and ordinary composer editing do not mint authority");
}
{
  const x = fixture();
  x.sample();
  x.fire("click", { isTrusted: true, target: x.send });
  const baseline = x.sample();
  assert.equal(baseline.feedback_ledger.signals.assistant_text_rendered.status, "unavailable");
  x.addReply("Answer before generation was ever sampled", "generation");
  const generating = x.sampleGenerating(true);
  assert.equal(generating.turn_id, "turn-1", "generation edge must not discard the already observed send turn");
  assert.equal(generating.feedback_ledger.text_revision, 1);
  checks.push("generation state appearing after fast send preserves original turn and DOM evidence");
}
{
  const x = fixture();
  x.sample();
  x.fire("keydown", { isTrusted: true, key: "Enter", target: x.composer,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false });
  x.addReply("Keyboard-sent fast answer", "keyboard");
  assert.equal(x.sample().feedback_ledger.signals.assistant_text_rendered.status, "observed");
  checks.push("trusted keyboard Send in canonical composer handles a fast answer");
}
assert.ok(/beginObservedSendTurn\(\);\s*send\.element\.click\(\);/.test(contentSource),
  "Relay's own authorized Send activation must open a DOM baseline before it clicks");
checks.push("authorized Relay Send binds the observation baseline before activation");
console.log("A2 WP13 one-shot progress PASS:", checks.length, "groups");
for (const c of checks) console.log(" PASS", c);
