import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = process.env.HARNESS_TEST_BROWSER_COMPANION_ROOT
  ? path.resolve(process.env.HARNESS_TEST_BROWSER_COMPANION_ROOT)
  : path.join(root, "browser-companion");
const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
const serviceWorker = await fs.readFile(path.join(extensionRoot, "service-worker.js"), "utf8");
const content = await fs.readFile(path.join(extensionRoot, "content.js"), "utf8");
const feedbackLedgerHelper = await fs.readFile(path.join(extensionRoot, "visible-feedback-ledger.js"), "utf8");
const popup = await fs.readFile(path.join(extensionRoot, "popup.js"), "utf8");
const popupHtml = await fs.readFile(path.join(extensionRoot, "popup.html"), "utf8");
const readme = await fs.readFile(path.join(extensionRoot, "README.md"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.deepEqual(new Set(manifest.permissions), new Set(["storage", "alarms", "debugger"]));
assert.ok(!manifest.permissions.includes("activeTab"), "Relay control plane must not depend on a user-gesture activeTab grant");
assert.ok(!manifest.permissions.includes("tabs"), "broad tabs permission is unnecessary when exact ChatGPT host permissions are already declared");
assert.ok(!manifest.permissions.includes("cookies"));
assert.ok(!manifest.permissions.includes("webRequest"));
assert.ok(!manifest.host_permissions.includes("<all_urls>"));
assert.deepEqual(
  new Set(manifest.host_permissions),
  new Set(["https://chatgpt.com/*", "https://chat.openai.com/*", "http://127.0.0.1/*"])
);
assert.equal(manifest.background.service_worker, "service-worker.js");
assert.equal(manifest.content_scripts.length, 1);
assert.deepEqual(manifest.content_scripts[0].js, ["visible-feedback-ledger.js", "content.js"],
  "the feedback helper must load before the Companion content script");

for (const script of ["service-worker.js", "visible-feedback-ledger.js", "content.js", "popup.js"]) {
  execFileSync(process.execPath, ["--check", path.join(extensionRoot, script)], { stdio: "pipe" });
}

const combined = `${serviceWorker}\n${feedbackLedgerHelper}\n${content}\n${popup}\n${popupHtml}`;
assert.equal(/ADMIN_TOKEN|x-admin-token/i.test(combined), false, "extension must never know the Admin credential");
assert.equal(/OPENAI_TUNNEL_API_KEY|CONTROL_PLANE_API_KEY/i.test(combined), false, "extension must never know tunnel credentials");
assert.ok(serviceWorker.includes("const REQUEST_TIMEOUT_MS = 10_000"), "Companion requests must have a bounded timeout");
assert.equal(
  [...serviceWorker.matchAll(/AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/g)].length,
  2,
  "both Desktop bootstrap and Companion API requests must be abortable"
);
assert.ok(serviceWorker.includes('const TARGETS_KEY = "laneTargets"'));
assert.ok(serviceWorker.includes("normalizeConversationUrl"));
assert.ok(serviceWorker.includes("activation_ambiguous"));
assert.ok(serviceWorker.includes("do_not_activate"));
assert.ok(content.includes("if (doNotActivate)"));
assert.ok(content.includes("markerVisibleInTranscript(command.marker)"));
assert.ok(content.includes("activation_ambiguous"));
assert.ok(content.includes("sent_proven"));
assert.ok(content.includes("failed_before_activation"));
assert.ok(content.includes("adapterConfidence() === \"low\""));
assert.ok(content.includes('if (composer?.confidence === "high") return "medium"'), "fresh blank Chat with a canonical composer must be eligible for safe bootstrap");
assert.ok(content.includes("waitForSendAfterInput"), "activation must re-discover Send after relay text populates a blank Chat composer");
assert.ok(content.includes("attemptKeyboardSend"), "canonical composer must have a bounded keyboard fallback when Send does not materialize");
assert.ok(content.includes("requiresConversationEstablishment"), "fresh Chat delivery must require formal conversation establishment before proof");
assert.ok(content.includes("isFormalConversationUrl"), "bootstrap proof must capture a formal /c/<id> conversation URL");
assert.equal(content.includes("document.body?.innerText"), false, "delivery proof must not accept the marker while it only exists in the composer/body");
assert.ok(content.includes('const REQUIRED_CHAT_PLUGIN_NAME = "chatgpt_web_harness"'), "Chat relay must target the installed Harness plugin explicitly");
assert.ok(content.includes('const REQUIRED_CHAT_PLUGIN_ID = "plugin_asdk_app_6aa6c3909b6c81918435d1d6b83a1762"'),
  "Chat relay must bind the exact Harness plugin identity");
assert.ok(content.includes("ensureChatModeSelected"), "relay activation must be fenced to Chat mode");
assert.ok(content.includes("findRequiredChatPluginToken"), "relay activation must verify the inline plugin token");
assert.ok(content.includes("classifyConversationSurfaceEvidence"), "Chat and Work must be classified independently from plugin presence");
assert.equal(content.includes("activateRequiredChatPluginPage"), false, "fresh Workers must never enter through the plugin detail page that opens Work");
assert.equal(content.includes("findTryInChatButton"), false, "the unsafe Try in chat path must be absent");
assert.ok(content.includes("findRequiredChatPluginMenuItem"),
  "established Chat conversations must reattach the exact plugin for every relayed turn");
assert.ok(content.includes('type: "companion:trusted-plugin-input"'));
assert.ok(content.includes('type: "companion:trusted-plugin-click"'));
assert.ok(serviceWorker.includes('"Input.insertText"'));
assert.ok(serviceWorker.includes('"Input.dispatchMouseEvent"'));
assert.ok(serviceWorker.indexOf('type: "mouseMoved"') < serviceWorker.indexOf('type: "mousePressed"'),
  "trusted plugin selection must move the real pointer before press/release");
assert.ok(serviceWorker.includes('{ text: "chatgpt_web_harness" }'),
  "the privileged input path must be fixed to the exact Harness plugin query");
assert.ok(serviceWorker.includes("await chrome.debugger.detach(target).catch"),
  "the per-tab debugger must always detach after its bounded input operation");
assert.ok(serviceWorker.includes('const NEW_CHAT_URL = "https://chatgpt.com/"'),
  "new Worker tabs must open the ordinary Chat home before attaching the plugin");
assert.equal(serviceWorker.includes("chatgpt.com/plugins/${REQUIRED_CHAT_PLUGIN_ID}"), false,
  "new Worker tabs must not use the plugin page because it can open Work mode");
assert.ok(content.includes("conversation_surface: surface"), "browser telemetry must carry the classified Chat/Work surface");
assert.ok(serviceWorker.includes('reason: "chat_surface_required"'), "non-Chat tabs must never receive relay commands");
assert.equal(content.includes("dispatchInput(composer.element, command.message)"), false,
  "relay text must not replace and discard the required inline plugin token");
const capabilityIndex = content.indexOf("const capability = await ensureRequiredChatPlugin()");
const appendIndex = content.indexOf("appendInputAfterRequiredPlugin(composer.element, command.message)");
const waitSendIndex = content.indexOf("const send = await waitForSendAfterInput()");
assert.ok(capabilityIndex >= 0 && appendIndex > capabilityIndex && waitSendIndex > appendIndex,
  "Chat mode, exact plugin token, and token-preserving input must all precede Send discovery");
assert.ok(content.includes("send.element.click()"));
assert.ok(content.includes('"message delivery timed out"'), "delivery timeout must be promoted to interruption telemetry");
assert.ok(content.includes("mutationTouchesExecution"), "execution activity must be separated from general page mutations");
assert.ok(content.includes("feedback_ledger: feedbackLedger"), "the four-signal ledger must be sent in the Companion heartbeat");
assert.ok(feedbackLedgerHelper.includes("host_emission_callback_unavailable"), "DOM observation must not be promoted to host text emission");
for (const field of [
  "turn_id",
  "turn_started_at",
  "stop_button_visible",
  "retry_visible",
  "tool_inflight_count",
  "assistant_token_revision",
]) {
  assert.ok(content.includes(field), `per-turn telemetry must include ${field}`);
}
assert.ok(content.includes("crypto.randomUUID()"), "each observed web turn must carry an opaque turn identity");
assert.ok(content.includes("latestAssistantSignature"), "assistant activity must be reduced to a local signature/revision without sending transcript text");
assert.equal(content.includes("lastAssistantText"), false, "raw assistant text must not enter Companion telemetry");
assert.ok(content.includes("retryButtons"), "delivery timeout detection must be scoped to a visible Retry/重试 error surface");
assert.equal(
  content.includes('const text = (document.body?.innerText || "").toLowerCase();'),
  false,
  "interruption detection must not treat ordinary transcript text as liveness evidence"
);

const ambiguousIndex = content.indexOf('status: "activation_ambiguous"');
const clickIndex = content.indexOf("send.element.click()");
const keyboardIndex = content.indexOf("attemptKeyboardSend(composer)");
assert.ok(clickIndex >= 0 && keyboardIndex >= 0, "delivery must have explicit click and bounded keyboard activation paths");
assert.ok(ambiguousIndex > keyboardIndex, "keyboard fallback outcome must be fenced as sent_proven or activation_ambiguous");
const doNotActivateIndex = content.indexOf("if (doNotActivate)");
assert.ok(doNotActivateIndex >= 0 && doNotActivateIndex < clickIndex, "ambiguous recovery must fence repeat activation before click");

const pluginHelpersStart = content.indexOf("function normalizedElementText(");
const appendHelperStart = content.indexOf("function appendInputAfterRequiredPlugin(");
const pluginHelpersEnd = appendHelperStart;
const appendHelperEnd = content.indexOf("function findStopButton(", appendHelperStart);
assert.ok(pluginHelpersStart >= 0 && pluginHelpersEnd > pluginHelpersStart && appendHelperStart >= 0 && appendHelperEnd > appendHelperStart,
  "Chat plugin capability helpers must remain independently testable");
let activeComposer;
const selection = { removeAllRanges() {}, addRange() {} };
const pluginHelperSandbox = {
  URL,
  location: { href: "https://chatgpt.com/" },
  getSelection: () => selection,
  InputEvent: class InputEvent { constructor(type, init) { this.type = type; this.init = init; } },
  document: {
    createRange: () => ({ selectNodeContents() {}, collapse() {} }),
    execCommand: (command, _showUi, value) => {
      assert.equal(command, "insertText");
      activeComposer.textContent += value;
      return true;
    },
  },
};
vm.createContext(pluginHelperSandbox);
vm.runInContext(`
  const REQUIRED_CHAT_PLUGIN_NAME = "chatgpt_web_harness";
  const REQUIRED_CHAT_PLUGIN_ID = "plugin_asdk_app_test";
  const REQUIRED_CHAT_PLUGIN_ORIGIN = "inline_selection_pill";
  ${content.slice(pluginHelpersStart, pluginHelpersEnd)}
  ${content.slice(appendHelperStart, appendHelperEnd)}
`, pluginHelperSandbox);
assert.equal(pluginHelperSandbox.isRequiredChatPluginUrl(
  "https://chatgpt.com/plugins/plugin_asdk_app_test?plugin_detail_origin=inline_selection_pill"
), true);
assert.equal(pluginHelperSandbox.isRequiredChatPluginUrl(
  "https://chatgpt.com/plugins/plugin_asdk_app_test?plugin_detail_origin=menu"
), false, "a generic plugin link is not proof of an attached inline token");
assert.equal(pluginHelperSandbox.isRequiredChatPluginUrl(
  "https://evil.example/plugins/plugin_asdk_app_test?plugin_detail_origin=inline_selection_pill"
), false, "plugin proof must remain on the exact ChatGPT origin");
assert.equal(pluginHelperSandbox.isRequiredChatPluginUrl(
  "https://chatgpt.com/plugins/plugin_asdk_app_other?plugin_detail_origin=inline_selection_pill"
), false, "plugin proof must match the exact Harness plugin id");
const classifierStart = content.indexOf("function classifyConversationSurfaceEvidence(");
const classifierEnd = content.indexOf("function conversationSurface(", classifierStart);
const classifierSandbox = {};
vm.createContext(classifierSandbox);
vm.runInContext(content.slice(classifierStart, classifierEnd), classifierSandbox);
const classifySurface = classifierSandbox.classifyConversationSurfaceEvidence;
assert.equal(classifySurface({ workSelected: true, chatSelected: true, composerEvidence: "Ask ChatGPT", headingTexts: [] }), "WORK",
  "positive Work evidence must override stale Chat hints");
assert.equal(classifySurface({ workSelected: false, chatSelected: false, composerEvidence: "Work on anything", headingTexts: [] }), "WORK");
assert.equal(classifySurface({ workSelected: false, chatSelected: false, composerEvidence: "Ask ChatGPT", headingTexts: [] }), "CHAT");
assert.equal(classifySurface({ workSelected: false, chatSelected: false, composerEvidence: "", headingTexts: ["Goal status check · Work"] }), "WORK");
assert.equal(classifySurface({ workSelected: false, chatSelected: false, composerEvidence: "chatgpt_web_harness", headingTexts: [] }), "UNKNOWN",
  "the exact plugin token alone must never prove Chat mode");
const pluginLink = {
  innerText: "chatgpt_web_harness",
  textContent: "chatgpt_web_harness",
  getAttribute: (name) => name === "href"
    ? "https://chatgpt.com/plugins/plugin_asdk_app_test?plugin_detail_origin=inline_selection_pill"
    : null,
};
activeComposer = {
  textContent: "chatgpt_web_harness ",
  querySelectorAll: () => [pluginLink],
  getAttribute: (name) => name === "contenteditable" ? "true" : null,
  focus() {},
  dispatchEvent() {},
};
assert.equal(pluginHelperSandbox.appendInputAfterRequiredPlugin(activeComposer, "[WH-BOOTSTRAP:test]"), true);
assert.ok(activeComposer.textContent.includes("[WH-BOOTSTRAP:test]"));
assert.equal(pluginHelperSandbox.findRequiredChatPluginToken(activeComposer), pluginLink,
  "token-preserving input must retain the exact inline plugin token");
const composerWithoutPlugin = { ...activeComposer, querySelectorAll: () => [], textContent: "" };
assert.equal(pluginHelperSandbox.appendInputAfterRequiredPlugin(composerWithoutPlugin, "must-not-send"), false,
  "relay input must fail closed when the required plugin token is absent");

assert.ok(popup.includes("^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/companion\\/v[12]$"), "popup must restrict configuration to an explicit IPv4 loopback Companion API");
assert.equal(popup.includes("localhost"), false, "popup must not accept hostname aliases that can resolve away from the explicit loopback trust boundary");
assert.ok(popup.includes("TARGETS_KEY"), "popup must persist exact A/B conversation targets for browser-restart rebinding");
assert.ok(serviceWorker.includes("matches.length !== 1"), "auto-rebind must fail closed on ambiguous conversation target matches");
assert.ok(serviceWorker.includes('const IDENTITY_RECOVERY_KEY = "identityRecovery"'), "upgrade recovery intent must be durable in extension storage");
assert.ok(serviceWorker.includes('reason: "companion_identity_storage_recovery"'), "empty extension identity must request a fresh standby Worker through the authenticated control plane");
assert.ok(serviceWorker.includes("const MAX_LIVE_MANAGED_WORKER_TABS = 2"), "Companion must cap the topology at Driver plus one standby");
assert.ok(serviceWorker.includes("const MAX_LIVE_MANAGED_WORKER_TABS_PER_LANE = 1"), "a lane must never own two live managed tabs");
assert.ok(serviceWorker.includes("const PROVISION_CREATION_WINDOW_MS = 30 * 60_000"), "tab churn must have a durable rolling time budget");
const persistRecoveryIndex = serviceWorker.indexOf("saveIdentityRecovery(goalId, pending)");
const replaceRecoveryIndex = serviceWorker.indexOf("api(`/lanes/${plan.lane}/replace`");
assert.ok(persistRecoveryIndex >= 0 && replaceRecoveryIndex > persistRecoveryIndex, "identity recovery intent must persist before the server-side replacement effect");

const planStart = serviceWorker.indexOf("function planIdentityRecovery(");
const planEnd = serviceWorker.indexOf("async function recoverLostWorkerIdentity", planStart);
assert.ok(planStart >= 0 && planEnd > planStart);
const sandbox = { Date, Set };
vm.createContext(sandbox);
vm.runInContext(`const IDENTITY_STALE_MS = 45000; const IDENTITY_RETRY_MS = 300000; ${serviceWorker.slice(planStart, planEnd)}`, sandbox);
const planIdentityRecovery = sandbox.planIdentityRecovery;
const nowMs = Date.parse("2026-09-15T08:00:00.000Z");
const staleStatus = {
  automation_enabled: true,
  goal_id: "goal-1",
  driver: { goal_id: "goal-1", state: "ACTIVE" },
  control_plane: { state: "WAITING_CONTROL_PLANE", active_lane: "A", standby_lane: "B", standby_worker_id: "B:g4" },
  manager: { lanes: { B: { replacement_worker_id: "B:g4" } } },
  workers: {
    lanes: { B: { standby_worker_id: "B:g4" } },
    workers: { "B:g4": { state: "READY_BLANK", generation: 4, last_browser_seen_at: "2026-09-15T07:00:00.000Z" } },
  },
};
const recoveryPlan = planIdentityRecovery(staleStatus, {}, null, nowMs);
assert.equal(recoveryPlan.lane, "B");
assert.equal(recoveryPlan.source_worker_id, "B:g4");
assert.equal(planIdentityRecovery(staleStatus, { "7": { goal_id: "goal-1", worker_id: "B:g4", retired: false } }, null, nowMs), null, "an existing live binding must suppress upgrade recovery");
assert.equal(planIdentityRecovery(staleStatus, {}, { signature: recoveryPlan.signature, requested_at: new Date(nowMs - 1_000).toISOString() }, nowMs), null, "the same replacement effect must be duplicate-suppressed");
assert.equal(planIdentityRecovery(staleStatus, { "8": { goal_id: "other-goal", worker_id: "B:g4", retired: false } }, null, nowMs)?.lane, "B",
  "another Goal's binding must not suppress this Goal's recovery");
assert.equal(planIdentityRecovery(staleStatus, { "9": { worker_id: "B:g4", retired: false } }, null, nowMs), null,
  "unattributed legacy bindings require reconciliation before automatic provisioning");
const freshStatus = structuredClone(staleStatus);
freshStatus.workers.workers["B:g4"].last_browser_seen_at = new Date(nowMs - 1_000).toISOString();
assert.equal(planIdentityRecovery(freshStatus, {}, null, nowMs), null, "fresh browser truth must not be replaced merely because local storage is empty");
const activeStandby = structuredClone(staleStatus);
activeStandby.workers.workers["B:g4"].state = "ACTIVE";
assert.equal(planIdentityRecovery(activeStandby, {}, null, nowMs), null, "identity repair must never replace an authoritative Worker");

const bindingMatchStart = serviceWorker.indexOf("function workerBindingMatchesTab(");
const bindingMatchEnd = serviceWorker.indexOf("async function reconcileWorkerBindings", bindingMatchStart);
assert.ok(bindingMatchStart >= 0 && bindingMatchEnd > bindingMatchStart, "browser-restart recovery must validate durable tab-id bindings");
const bindingSandbox = { URL };
vm.createContext(bindingSandbox);
vm.runInContext(`${serviceWorker.slice(serviceWorker.indexOf("function normalizeConversationUrl("), serviceWorker.indexOf("async function resolveLane"))}\n${serviceWorker.slice(bindingMatchStart, bindingMatchEnd)}`, bindingSandbox);
const workerBindingMatchesTab = bindingSandbox.workerBindingMatchesTab;
const binding = { goal_id: "goal-1", worker_id: "B:g4", lane: "B", generation: 4, provision_id: "pv-4", retired: false };
const bindingStatus = { goal_id: "goal-1", workers: { workers: { "B:g4": { goal_id: "goal-1", state: "ACTIVATING", lane: "B", generation: 4, provision_id: "pv-4", conversation_url: "https://chatgpt.com/c/conversation-4" } } } };
assert.equal(workerBindingMatchesTab(binding, null, bindingStatus), false, "a binding whose browser tab vanished must not suppress restart recovery");
assert.equal(workerBindingMatchesTab(binding, { url: "https://example.com/" }, bindingStatus), false, "a reused tab id on a non-ChatGPT page must not retain Worker authority");
assert.equal(workerBindingMatchesTab(binding, { url: "https://chatgpt.com/c/other" }, bindingStatus), false, "a reused tab id for another conversation must not retain Worker authority");
assert.equal(workerBindingMatchesTab(binding, { url: "https://chatgpt.com/c/conversation-4?utm_source=test#tail" }, bindingStatus), true, "the observable matching conversation remains a live binding");
assert.equal(workerBindingMatchesTab({ ...binding, goal_id: "other-goal" },
  { url: "https://chatgpt.com/c/conversation-4" }, bindingStatus), false,
  "identical Worker and provision ids from another Goal cannot adopt this binding");
const retiredBindingStatus = structuredClone(bindingStatus);
const blankBindingStatus = structuredClone(bindingStatus);
blankBindingStatus.workers.workers["B:g4"].conversation_url = "https://chatgpt.com/";
for (const state of ["TAB_CREATED", "READY_BLANK", "ACTIVATING"]) {
  blankBindingStatus.workers.workers["B:g4"].state = state;
  assert.equal(workerBindingMatchesTab(binding, { url: "https://chatgpt.com/c/conversation-4" }, blankBindingStatus), true,
    "first Send navigation must retain the provisioned binding before its formal-URL heartbeat reaches the server");
}
blankBindingStatus.workers.workers["B:g4"].state = "ACTIVE";
assert.equal(workerBindingMatchesTab(binding, { url: "https://chatgpt.com/c/other" }, blankBindingStatus), false,
  "an authoritative Worker cannot use the blank-to-formal bootstrap exception");
blankBindingStatus.workers.workers["B:g4"].state = "ACTIVATING";
assert.equal(workerBindingMatchesTab(binding, { url: "https://chatgpt.com/settings" }, blankBindingStatus), false,
  "bootstrap navigation must lead to a formal conversation");
retiredBindingStatus.workers.workers["B:g4"].state = "RETIRED";
assert.equal(workerBindingMatchesTab(binding, { url: "https://chatgpt.com/c/conversation-4" }, retiredBindingStatus), false, "a terminal server Worker cannot remain live through stale extension storage");

const provisionStart = serviceWorker.indexOf("function sameProvisionAttempt(");
const provisionEnd = serviceWorker.indexOf("async function handleRetirementCommand", provisionStart);
assert.ok(provisionStart >= 0 && provisionEnd > provisionStart, "provisioning logic must expose durable duplicate suppression");
const provisionTransactions = {};
const provisionCreationBudget = { schema_version: 1, reservations: [] };
const workerBindings = {};
const provisionAcks = [];
let createdTabCount = 0;
const createdTabUrls = [];
let nextTabId = 100;
const liveTabs = new Set();
const provisionSandbox = {
  Date,
  Number,
  Object,
  Set,
  Error,
  NEW_CHAT_URL: "https://chatgpt.com/",
  PROVISION_TRANSACTIONS_KEY: "provisionTransactions",
  PROVISION_CREATION_BUDGET_KEY: "provisionCreationBudget",
  WORKER_BINDINGS_KEY: "workerBindings",
  MAX_LIVE_MANAGED_WORKER_TABS: 2,
  MAX_LIVE_MANAGED_WORKER_TABS_PER_LANE: 1,
  PROVISION_CREATION_WINDOW_MS: 30 * 60_000,
  MAX_PROVISION_CREATIONS_PER_WINDOW: 2,
  getProvisionTransactions: async () => provisionTransactions,
  getProvisionCreationBudget: async () => provisionCreationBudget,
  getWorkerBindings: async () => workerBindings,
  ackGlobalCommand: async (command, status, detail) => provisionAcks.push({ commandId: command.command_id, goal_id: command.goal_id, status, detail }),
  chrome: {
    tabs: {
      get: async (tabId) => {
        if (!liveTabs.has(tabId)) throw new Error("missing tab");
        return { id: tabId, url: "https://chatgpt.com/" };
      },
      create: async ({ url }) => {
        createdTabCount += 1;
        createdTabUrls.push(url);
        const id = nextTabId++;
        liveTabs.add(id);
        return { id };
      },
    },
    storage: {
      local: {
        set: async (updates) => {
          if (updates.provisionTransactions) {
            const nextTransactions = structuredClone(updates.provisionTransactions);
            for (const key of Object.keys(provisionTransactions)) delete provisionTransactions[key];
            Object.assign(provisionTransactions, nextTransactions);
          }
          if (updates.workerBindings) {
            const nextBindings = structuredClone(updates.workerBindings);
            for (const key of Object.keys(workerBindings)) delete workerBindings[key];
            Object.assign(workerBindings, nextBindings);
          }
          if (updates.provisionCreationBudget) {
            const nextBudget = structuredClone(updates.provisionCreationBudget);
            for (const key of Object.keys(provisionCreationBudget)) delete provisionCreationBudget[key];
            Object.assign(provisionCreationBudget, nextBudget);
          }
        },
      },
    },
  },
};
vm.createContext(provisionSandbox);
vm.runInContext(serviceWorker.slice(provisionStart, provisionEnd), provisionSandbox);
const baseProvision = {
  goal_id: "goal-1",
  command_id: "provision-command-1",
  worker_id: "B:g4",
  lane: "B",
  generation: 4,
  registry_revision: 10,
  provision_id: "pv-b-g4",
  provision_attempt_id: "pva-b-g4",
};
const firstProvision = await provisionSandbox.provisionWorker(baseProvision);
assert.equal(firstProvision.ok, true);
assert.equal(createdTabCount, 1);
assert.deepEqual(createdTabUrls, ["https://chatgpt.com/"],
  "fresh Worker provisioning must start at ordinary Chat home");
const replayedProvision = await provisionSandbox.provisionWorker({ ...baseProvision, command_id: "provision-command-replayed" });
assert.equal(replayedProvision.idempotent, true, "a new command id for the same durable attempt must reuse the original tab");
assert.equal(createdTabCount, 1, "same-attempt replay opened another tab");
for (let replay = 2; replay <= 8_000; replay += 1) {
  const replayResult = await provisionSandbox.provisionWorker({
    ...baseProvision,
    command_id: `provision-command-storm-${replay}`,
  });
  assert.equal(replayResult.idempotent, true);
}
assert.equal(createdTabCount, 1,
  "8,000 command ids for one durable attempt must still produce exactly one tabs.create side effect");
const sameWorkerNewIds = await provisionSandbox.provisionWorker({
  ...baseProvision,
  goal_id: "goal-1",
  command_id: "provision-command-worker-replayed",
  provision_id: "pv-b-g4-replayed",
  provision_attempt_id: "pva-b-g4-replayed",
});
assert.equal(sameWorkerNewIds.idempotent, true, "the same Worker generation must remain single-tab even if control-plane ids drift");
assert.equal(createdTabCount, 1, "same Worker generation with drifted ids opened another tab");

const crossGoalReplay = await provisionSandbox.provisionWorker({ ...baseProvision, goal_id: "other-goal" });
assert.equal(crossGoalReplay.circuit_breaker, "provision_id_collision",
  "a Goal must not adopt another Goal's provision transaction");
assert.equal(createdTabCount, 1, "cross Goal replay produced a browser side effect");
assert.equal(Object.values(workerBindings)[0].goal_id, "goal-1");
const secondProvision = await provisionSandbox.provisionWorker({
  goal_id: "goal-1",
  command_id: "provision-command-2",
  worker_id: "A:g1",
  lane: "A",
  generation: 1,
  registry_revision: 11,
  provision_id: "pv-a-g1",
  provision_attempt_id: "pva-a-g1",
});
assert.equal(secondProvision.ok, true, "Driver plus one standby must fit the live topology");
assert.equal(createdTabCount, 2);
for (const binding of Object.values(workerBindings)) binding.retired = true;
liveTabs.clear();
const budgetBlocked = await provisionSandbox.provisionWorker({
  goal_id: "goal-1",
  command_id: "provision-command-budget-blocked",
  worker_id: "B:g5",
  lane: "B",
  generation: 5,
  registry_revision: 12,
  provision_id: "pv-b-g5",
  provision_attempt_id: "pva-b-g5",
});
assert.equal(budgetBlocked.circuit_breaker, "creation_budget",
  "closing tabs must not reset the durable 30-minute creation budget");
assert.equal(createdTabCount, 2, "rolling creation budget allowed a third tabs.create side effect");

for (const [tabId, lane] of [[201, "A"], [203, "B"]]) {
  liveTabs.add(tabId);
  workerBindings[String(tabId)] = { goal_id: "goal-1", worker_id: `${lane}:cap-${tabId}`, lane, generation: tabId, provision_id: `pv-cap-${tabId}`, retired: false };
}
const cappedProvision = await provisionSandbox.provisionWorker({
  goal_id: "goal-1",
  command_id: "provision-command-capped",
  worker_id: "A:g99",
  lane: "A",
  generation: 99,
  registry_revision: 11,
  provision_id: "pv-a-g99",
  provision_attempt_id: "pva-a-g99",
});
assert.equal(cappedProvision.circuit_breaker, "managed_tab_limit");
assert.equal(createdTabCount, 2, "managed-tab circuit breaker allowed another tabs.create side effect");
assert.equal(provisionAcks.at(-1).status, "ambiguous");
assert.ok(readme.includes("不会再次点击发送"));
assert.ok(readme.includes("不会静默安装浏览器扩展"));

assert.ok(serviceWorker.includes('headers.set("x-relay-goal-id", selectedGoal)'), "transport must carry the selected Goal");
assert.ok(popupHtml.includes('id="goalId"'), "operator configuration must expose an explicit Goal selector");

console.log("browser-companion: MV3 least privilege, exact conversation rebinding, crash-safe upgrade identity recovery, fail-closed DOM adapter, and ambiguous-send no-retry contract passed");
