"use strict";

const CONFIG_KEY = "relayConfig";
const RUNTIME_BOOTSTRAP_URL = chrome.runtime.getURL("runtime-bootstrap.json");
const BINDINGS_KEY = "laneBindings";
const TARGETS_KEY = "laneTargets";
const WORKER_BINDINGS_KEY = "workerBindings";
const PROVISION_TRANSACTIONS_KEY = "provisionTransactions";
const PROVISION_CREATION_BUDGET_KEY = "provisionCreationBudget";
const IDENTITY_RECOVERY_KEY = "identityRecovery";
const COMPANION_INSTANCE_KEY = "companionInstanceId";
const AMBIGUOUS_KEY = "ambiguousCommands";
const SYNC_ALARM = "web-harness-worker-sync";
const NEW_CHAT_URL = "https://chatgpt.com/";
const IDENTITY_STALE_MS = 45_000;
const IDENTITY_RETRY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
// This is a final browser-side blast-radius guard. The relay normally needs
// Exactly one Driver and one standby is the largest safe live topology. A
// replacement cannot coexist as a third tab; the old generation must be
// retired first. The rolling creation budget also survives tab closure and a
// service-worker restart, so an A/B state-machine regression cannot churn tabs.
const MAX_LIVE_MANAGED_WORKER_TABS = 2;
const MAX_LIVE_MANAGED_WORKER_TABS_PER_LANE = 1;
const PROVISION_CREATION_WINDOW_MS = 30 * 60_000;
const MAX_PROVISION_CREATIONS_PER_WINDOW = 2;
const DEBUGGER_PROTOCOL_VERSION = "1.3";
let globalSyncRunning = false;
let lastGlobalSyncAt = 0;
const lastIdentityRecoveryChecks = new Map();

async function storageGet(area, key, fallback) {
  const value = await area.get(key);
  return value[key] ?? fallback;
}

function normalizeLoopbackBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return "";
    if (!url.port || !/^\/companion\/v[12]$/.test(url.pathname) || url.username || url.password || url.search || url.hash) return "";
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "";
    return `http://127.0.0.1:${port}${url.pathname}`;
  } catch {
    return "";
  }
}

async function readDesktopBootstrap() {
  try {
    const response = await fetch(`${RUNTIME_BOOTSTRAP_URL}?t=${Date.now()}`, {
      cache: "no-store", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const value = await response.json();
    const baseUrl = normalizeLoopbackBaseUrl(value?.base_url);
    const token = String(value?.token || "").trim();
    if (Number(value?.schema_version) !== 1 || !baseUrl || !token) return null;
    const instanceId = String(value?.instance_id || "").trim();
    const expiresAt = String(value?.expires_at || "").trim();
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) return null;
    return { baseUrl, token, instanceId, expiresAt, source: "desktop" };
  } catch {
    return null;
  }
}

async function getConfig() {
  const managed = await readDesktopBootstrap();
  const config = await storageGet(chrome.storage.local, CONFIG_KEY, {});
  const goalId = String(config.goalId || "").trim();
  if (managed) return { ...managed, goalId };
  const baseUrl = normalizeLoopbackBaseUrl(config.baseUrl);
  const token = String(config.token || "").trim();
  if (!baseUrl || !token) {
    throw new Error("COMPANION_UNPAIRED: Desktop bootstrap unavailable and no valid manual loopback configuration exists");
  }
  return { baseUrl, token, goalId, source: "manual" };
}

function versionedBase(baseUrl, version) {
  if (/\/companion\/v[12]$/i.test(baseUrl)) return baseUrl.replace(/\/companion\/v[12]$/i, `/companion/${version}`);
  return `${baseUrl.replace(/\/+$/, "")}/companion/${version}`;
}

async function api(path, init = {}, version = "v1", goalId = undefined) {
  const config = await getConfig();
  const headers = new Headers(init.headers || {});
  headers.set("x-companion-token", config.token);
  if (config.instanceId) headers.set("x-companion-instance", config.instanceId);
  const selectedGoal = goalId === undefined ? config.goalId : goalId;
  if (selectedGoal) headers.set("x-relay-goal-id", selectedGoal);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${versionedBase(config.baseUrl, version)}${path}`, { ...init, headers, signal });
  let body = null;
  try { body = await response.json(); } catch (error) {
    if (signal.aborted) throw error;
  }
  if (!response.ok) throw new Error(body?.error || `Companion HTTP ${response.status}`);
  if (selectedGoal && ((body?.goal_id && body.goal_id !== selectedGoal) ||
      (body?.command && body.command.goal_id !== selectedGoal))) throw new Error("COMPANION_GOAL_SCOPE_MISMATCH");
  return body;
}

async function getBindings() {
  return storageGet(chrome.storage.local, BINDINGS_KEY, {});
}

async function getTargets() {
  return storageGet(chrome.storage.local, TARGETS_KEY, {});
}

async function getWorkerBindings() {
  return storageGet(chrome.storage.local, WORKER_BINDINGS_KEY, {});
}

async function getProvisionTransactions() {
  return storageGet(chrome.storage.local, PROVISION_TRANSACTIONS_KEY, {});
}

async function getProvisionCreationBudget() {
  return storageGet(chrome.storage.local, PROVISION_CREATION_BUDGET_KEY, { schema_version: 1, reservations: [] });
}

async function getIdentityRecovery(goalId) {
  const all = await storageGet(chrome.storage.local, IDENTITY_RECOVERY_KEY, {});
  return all?.[goalId] || null;
}

async function saveIdentityRecovery(goalId, value) {
  const all = await storageGet(chrome.storage.local, IDENTITY_RECOVERY_KEY, {});
  await chrome.storage.local.set({ [IDENTITY_RECOVERY_KEY]: { ...all, [goalId]: { ...value, goal_id: goalId } } });
}

async function getCompanionInstanceId() {
  const current = await storageGet(chrome.storage.local, COMPANION_INSTANCE_KEY, "");
  if (current) return current;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ [COMPANION_INSTANCE_KEY]: created });
  return created;
}

function trustedInputTarget(tabId) {
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("TRUSTED_INPUT_INVALID_TAB");
  return { tabId };
}

async function assertTrustedInputTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const url = new URL(String(tab?.url || ""));
  if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) {
    throw new Error("TRUSTED_INPUT_ORIGIN_REJECTED");
  }
}

async function withTrustedInputDebugger(tabId, operation) {
  const target = trustedInputTarget(tabId);
  await assertTrustedInputTab(tabId);
  await chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION);
  try {
    return await operation(target);
  } finally {
    await chrome.debugger.detach(target).catch(() => undefined);
  }
}

async function typeRequiredChatPlugin(tabId) {
  return withTrustedInputDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.insertText", { text: "chatgpt_web_harness" });
    return { typed: true };
  });
}

async function clickRequiredChatPlugin(tabId, point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) {
    throw new Error("TRUSTED_INPUT_INVALID_POINT");
  }
  return withTrustedInputDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", buttons: 0,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1,
    });
    return { clicked: true };
  });
}

function normalizeConversationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

async function resolveLane(tabId, telemetry) {
  const bindings = await getBindings();
  const direct = bindings[String(tabId)];
  if (direct?.goal_id && ["A", "B"].includes(direct.lane)) return direct;
  const currentUrl = normalizeConversationUrl(telemetry?.conversation_url);
  if (!currentUrl) return null;
  const targets = await getTargets();
  const matches = Object.values(targets).filter((target) => target?.goal_id &&
    ["A", "B"].includes(target.lane) && normalizeConversationUrl(target.url) === currentUrl);
  if (matches.length !== 1) return null;
  bindings[String(tabId)] = { lane: matches[0].lane, goal_id: matches[0].goal_id };
  await chrome.storage.local.set({ [BINDINGS_KEY]: bindings });
  return bindings[String(tabId)];
}

async function resolveWorkerBinding(tabId) {
  const bindings = await getWorkerBindings();
  const binding = bindings[String(tabId)];
  if (!binding || typeof binding !== "object") return null;
  if (!binding.goal_id || !binding.worker_id || !["A", "B"].includes(binding.lane) || !Number.isInteger(binding.generation) || !binding.provision_id) return null;
  return binding;
}

async function getTabInstanceId(tabId) {
  const key = `tab:${tabId}`;
  const current = await storageGet(chrome.storage.session, key, "");
  if (current) return current;
  const created = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: created });
  return created;
}

async function commandAmbiguous(tabId, commandId) {
  const all = await storageGet(chrome.storage.session, AMBIGUOUS_KEY, {});
  return Boolean(all[`${tabId}:${commandId}`]);
}

async function setCommandAmbiguous(tabId, commandId, value) {
  const all = await storageGet(chrome.storage.session, AMBIGUOUS_KEY, {});
  const key = `${tabId}:${commandId}`;
  if (value) all[key] = Date.now();
  else delete all[key];
  await chrome.storage.session.set({ [AMBIGUOUS_KEY]: all });
}

async function ackGlobalCommand(command, status, detail) {
  if (!command?.goal_id || !command.command_id) throw new Error("COMPANION_COMMAND_GOAL_REQUIRED");
  const commandId = command.command_id;
  const companionInstanceId = await getCompanionInstanceId();
  await api(`/commands/${encodeURIComponent(commandId)}/ack`, {
    method: "POST",
    body: JSON.stringify({
      companion_instance_id: companionInstanceId,
      goal_id: command.goal_id,
      status,
      ...(detail ? { detail: String(detail).slice(0, 1000) } : {}),
    }),
  }, "v2", command.goal_id);
}

function sameProvisionAttempt(transaction, command) {
  if (!transaction || typeof transaction !== "object" || !command?.goal_id || transaction.goal_id !== command.goal_id) return false;
  if (transaction.provision_id === command.provision_id) return true;
  if (command.provision_attempt_id && transaction.provision_attempt_id === command.provision_attempt_id) return true;
  return transaction.worker_id === command.worker_id &&
    transaction.lane === command.lane &&
    transaction.generation === command.generation;
}

function findProvisionTransaction(transactions, command) {
  const direct = transactions[command.provision_id];
  if (sameProvisionAttempt(direct, command)) return direct;
  return Object.values(transactions).find((transaction) => sameProvisionAttempt(transaction, command)) || null;
}

function planProvisionCreationBudget(current, command, nowMs = Date.now()) {
  const rawReservations = Array.isArray(current?.reservations) ? current.reservations : [];
  const reservations = rawReservations.filter((reservation) => {
    const reservedAt = Date.parse(String(reservation?.reserved_at || ""));
    return Number.isFinite(reservedAt) && nowMs - reservedAt < PROVISION_CREATION_WINDOW_MS;
  });
  const existing = reservations.find((reservation) => sameProvisionAttempt(reservation, command));
  if (existing) {
    return { allowed: true, already_reserved: true, budget: { schema_version: 1, reservations } };
  }
  if (reservations.length >= MAX_PROVISION_CREATIONS_PER_WINDOW) {
    return { allowed: false, already_reserved: false, budget: { schema_version: 1, reservations } };
  }
  reservations.push({
    goal_id: command.goal_id,
    worker_id: command.worker_id,
    lane: command.lane,
    generation: command.generation,
    provision_id: command.provision_id,
    provision_attempt_id: command.provision_attempt_id,
    reserved_at: new Date(nowMs).toISOString(),
  });
  return { allowed: true, already_reserved: false, budget: { schema_version: 1, reservations } };
}

async function countLiveManagedWorkerTabs() {
  const bindings = await getWorkerBindings();
  const seen = new Set();
  const byLane = { A: 0, B: 0 };
  let total = 0;
  for (const [tabIdText, binding] of Object.entries(bindings)) {
    if (!binding || typeof binding !== "object" || binding.retired === true || !["A", "B"].includes(binding.lane)) continue;
    const tabId = Number(tabIdText);
    if (!Number.isInteger(tabId) || seen.has(tabId)) continue;
    try {
      await chrome.tabs.get(tabId);
    } catch {
      continue;
    }
    seen.add(tabId);
    total += 1;
    byLane[binding.lane] += 1;
  }
  return { total, byLane };
}

async function provisionWorker(command) {
  if (!command?.goal_id || !command.command_id || !command.worker_id || !["A", "B"].includes(command.lane) ||
      !Number.isInteger(command.generation) || !command.provision_id || !command.provision_attempt_id) {
    throw new Error("Invalid provision_worker command");
  }
  const transactions = await getProvisionTransactions();
  const direct = transactions[command.provision_id];
  if (direct && !sameProvisionAttempt(direct, command)) {
    await ackGlobalCommand(command, "ambiguous", "Provision id collision; refusing tabs.create");
    return { ok: false, ambiguous: true, circuit_breaker: "provision_id_collision" };
  }
  const existing = findProvisionTransaction(transactions, command);
  if (existing) {
    if (existing.state === "tab_created" && Number.isInteger(existing.tab_id)) {
      try {
        await chrome.tabs.get(existing.tab_id);
        await ackGlobalCommand(command, "sent");
        return { ok: true, idempotent: true, tab_id: existing.tab_id };
      } catch {
        existing.state = "tab_missing";
        existing.updated_at = new Date().toISOString();
        transactions[command.provision_id] = existing;
        await chrome.storage.local.set({ [PROVISION_TRANSACTIONS_KEY]: transactions });
        await ackGlobalCommand(command, "ambiguous", "Previously created Worker tab is no longer observable; refusing duplicate tabs.create");
        return { ok: false, ambiguous: true };
      }
    }
    if (["creating", "ambiguous", "tab_missing", "blocked_by_tab_limit", "blocked_by_creation_budget"].includes(existing.state)) {
      existing.state = "ambiguous";
      existing.updated_at = new Date().toISOString();
      transactions[existing.provision_id] = existing;
      await chrome.storage.local.set({ [PROVISION_TRANSACTIONS_KEY]: transactions });
      await ackGlobalCommand(command, "ambiguous", "Provision transaction outcome is not provably absent; reconcile instead of recreating");
      return { ok: false, ambiguous: true };
    }
    await ackGlobalCommand(command, "ambiguous", "Existing provision transaction has an unknown state; refusing tabs.create");
    return { ok: false, ambiguous: true };
  }

  const liveTabs = await countLiveManagedWorkerTabs();
  if (liveTabs.total >= MAX_LIVE_MANAGED_WORKER_TABS ||
      liveTabs.byLane[command.lane] >= MAX_LIVE_MANAGED_WORKER_TABS_PER_LANE) {
    const now = new Date().toISOString();
    transactions[command.provision_id] = {
      command_id: command.command_id,
      goal_id: command.goal_id,
    worker_id: command.worker_id,
      lane: command.lane,
      generation: command.generation,
      provision_id: command.provision_id,
      provision_attempt_id: command.provision_attempt_id,
      registry_revision: command.registry_revision ?? null,
      state: "blocked_by_tab_limit",
      created_at: now,
      updated_at: now,
      tab_id: null,
    };
    await chrome.storage.local.set({ [PROVISION_TRANSACTIONS_KEY]: transactions });
    await ackGlobalCommand(command, "ambiguous",
      `Managed Worker tab limit reached (${liveTabs.total} total, ${liveTabs.byLane[command.lane]} in lane ${command.lane}); refusing tabs.create`);
    return { ok: false, ambiguous: true, circuit_breaker: "managed_tab_limit" };
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const budgetPlan = planProvisionCreationBudget(await getProvisionCreationBudget(), command, nowMs);
  if (!budgetPlan.allowed) {
    transactions[command.provision_id] = {
      command_id: command.command_id,
      goal_id: command.goal_id,
    worker_id: command.worker_id,
      lane: command.lane,
      generation: command.generation,
      provision_id: command.provision_id,
      provision_attempt_id: command.provision_attempt_id,
      registry_revision: command.registry_revision ?? null,
      state: "blocked_by_creation_budget",
      created_at: now,
      updated_at: now,
      tab_id: null,
    };
    await chrome.storage.local.set({
      [PROVISION_TRANSACTIONS_KEY]: transactions,
      [PROVISION_CREATION_BUDGET_KEY]: budgetPlan.budget,
    });
    await ackGlobalCommand(command, "ambiguous",
      `Worker creation budget exhausted (${MAX_PROVISION_CREATIONS_PER_WINDOW} tabs per ${PROVISION_CREATION_WINDOW_MS / 60_000} minutes); refusing tabs.create`);
    return { ok: false, ambiguous: true, circuit_breaker: "creation_budget" };
  }

  transactions[command.provision_id] = {
    command_id: command.command_id,
    goal_id: command.goal_id,
    worker_id: command.worker_id,
    lane: command.lane,
    generation: command.generation,
    provision_id: command.provision_id,
    provision_attempt_id: command.provision_attempt_id || null,
    registry_revision: command.registry_revision ?? null,
    state: "creating",
    created_at: now,
    updated_at: now,
    tab_id: null,
  };
  // Persist before the browser side effect. If the service worker dies after
  // tabs.create, the restart path sees "creating" and fails closed as ambiguous.
  await chrome.storage.local.set({
    [PROVISION_TRANSACTIONS_KEY]: transactions,
    [PROVISION_CREATION_BUDGET_KEY]: budgetPlan.budget,
  });

  try {
    const tab = await chrome.tabs.create({ url: NEW_CHAT_URL, active: false });
    if (!Number.isInteger(tab?.id)) throw new Error("tabs.create returned no tab id");
    const workerBindings = await getWorkerBindings();
    workerBindings[String(tab.id)] = {
      goal_id: command.goal_id,
    worker_id: command.worker_id,
      lane: command.lane,
      generation: command.generation,
      provision_id: command.provision_id,
      provision_attempt_id: command.provision_attempt_id || null,
      command_id: command.command_id,
      created_at: now,
      retired: false,
    };
    transactions[command.provision_id] = {
      ...transactions[command.provision_id],
      state: "tab_created",
      tab_id: tab.id,
      updated_at: new Date().toISOString(),
    };
    await chrome.storage.local.set({
      [WORKER_BINDINGS_KEY]: workerBindings,
      [PROVISION_TRANSACTIONS_KEY]: transactions,
    });
    await ackGlobalCommand(command, "sent");
    return { ok: true, tab_id: tab.id };
  } catch (error) {
    transactions[command.provision_id] = {
      ...transactions[command.provision_id],
      state: "ambiguous",
      updated_at: new Date().toISOString(),
      error: String(error?.message || error).slice(0, 500),
    };
    await chrome.storage.local.set({ [PROVISION_TRANSACTIONS_KEY]: transactions });
    await ackGlobalCommand(command, "ambiguous", `tabs.create outcome ambiguous: ${error?.message || error}`);
    return { ok: false, ambiguous: true };
  }
}

async function handleRetirementCommand(command, closeTab) {
  const bindings = await getWorkerBindings();
  const entry = Object.entries(bindings).find(([, binding]) => binding?.goal_id === command.goal_id && binding?.worker_id === command.worker_id);
  if (!entry) {
    await ackGlobalCommand(command, "sent");
    return { ok: true, already_absent: true };
  }
  const [tabIdText, binding] = entry;
  const tabId = Number(tabIdText);
  bindings[tabIdText] = { ...binding, retired: true, retired_at: new Date().toISOString() };
  await chrome.storage.local.set({ [WORKER_BINDINGS_KEY]: bindings });
  if (closeTab && Number.isInteger(tabId)) {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
  await ackGlobalCommand(command, "sent");
  return { ok: true };
}

async function handleGlobalCommand(command) {
  if (!command) return null;
  if (!command.goal_id) throw new Error("COMPANION_COMMAND_GOAL_REQUIRED");
  if (command.kind === "provision_worker") return provisionWorker(command);
  if (command.kind === "retire_worker") return handleRetirementCommand(command, false);
  if (command.kind === "close_retired_worker") return handleRetirementCommand(command, true);
  await ackGlobalCommand(command, "failed", `Unsupported global command kind ${command.kind}`);
  return { ok: false, unsupported: true };
}

function planIdentityRecovery(status, workerBindings, recovery, nowMs = Date.now()) {
  // Identity repair is automatic provisioning too, not an escape from a paused scheduler.
  // Missing legacy status must fail closed rather than create an unsolicited Worker.
  if (status?.automation_enabled !== true) return null;
  if (!status?.goal_id || status.goal_id !== status.driver?.goal_id) return null;
  if (Object.values(workerBindings || {}).some((binding) => binding && binding.retired !== true && !binding.goal_id)) return null;
  const hasLiveBinding = Object.values(workerBindings || {}).some((binding) =>
    binding && typeof binding === "object" && binding.retired !== true && binding.goal_id === status?.goal_id
  );
  if (hasLiveBinding || !status?.driver?.goal_id || status.driver.state === "RELEASED") return null;
  const control = status.control_plane || {};
  if (control.state === "IDLE" || !["A", "B"].includes(control.active_lane)) return null;
  const lane = ["A", "B"].includes(control.standby_lane)
    ? control.standby_lane
    : control.active_lane === "A" ? "B" : "A";
  const workerId = control.standby_worker_id ||
    status.manager?.lanes?.[lane]?.replacement_worker_id ||
    status.workers?.lanes?.[lane]?.standby_worker_id || null;
  const worker = workerId ? status.workers?.workers?.[workerId] : null;
  const recoverableStates = new Set([
    "REQUESTED", "PROVISIONING", "TAB_CREATED", "READY_BLANK",
    "ACTIVATING", "READY", "PROVISION_AMBIGUOUS",
  ]);
  if (worker && !recoverableStates.has(worker.state)) return null;
  const seenAt = worker?.last_browser_seen_at ? Date.parse(worker.last_browser_seen_at) : Number.NaN;
  if (Number.isFinite(seenAt) && nowMs - seenAt < IDENTITY_STALE_MS) return null;
  const signature = [status.driver.goal_id, lane, workerId || "absent", worker?.generation ?? "none"].join(":");
  const requestedAt = recovery?.requested_at ? Date.parse(recovery.requested_at) : Number.NaN;
  if (recovery?.signature === signature && Number.isFinite(requestedAt) && nowMs - requestedAt < IDENTITY_RETRY_MS) return null;
  return { goal_id: status.driver.goal_id, lane, signature, source_worker_id: workerId };
}

function workerBindingMatchesTab(binding, tab, status) {
  if (!binding || typeof binding !== "object" || binding.retired === true) return false;
  if (!binding.goal_id || !binding.worker_id || !["A", "B"].includes(binding.lane) ||
      !Number.isInteger(binding.generation) || !binding.provision_id) return false;
  const actualUrl = normalizeConversationUrl(tab?.url);
  if (!actualUrl) return false;
  const worker = status?.workers?.workers?.[binding.worker_id];
  if (!worker || worker.goal_id !== binding.goal_id || status?.goal_id !== binding.goal_id ||
      ["RETIRED", "DEAD", "FAILED", "FENCED"].includes(worker.state)) return false;
  if (worker.lane !== binding.lane || worker.generation !== binding.generation ||
      worker.provision_id !== binding.provision_id) return false;
  const expectedUrl = normalizeConversationUrl(worker.conversation_url);
  // The first Send navigates a provisioned blank tab before its next heartbeat
  // updates the registry. Do not erase the binding in that observation gap.
  // Once a formal URL is recorded, exact conversation matching remains required.
  if (["TAB_CREATED", "READY_BLANK", "ACTIVATING"].includes(worker.state) && expectedUrl) {
    const expected = new URL(expectedUrl);
    const actual = new URL(actualUrl);
    if (expected.pathname === "/" && actual.origin === expected.origin &&
        /^\/c\/[^/]+$/.test(actual.pathname)) return true;
  }
  return !expectedUrl || expectedUrl === actualUrl;
}

async function reconcileWorkerBindings(status) {
  const bindings = await getWorkerBindings();
  let changed = false;
  for (const [tabIdText, binding] of Object.entries(bindings)) {
    if (binding?.goal_id !== status?.goal_id) continue;
    const tabId = Number(tabIdText);
    let tab = null;
    if (Number.isInteger(tabId)) {
      try { tab = await chrome.tabs.get(tabId); } catch {}
    }
    if (!workerBindingMatchesTab(binding, tab, status)) {
      delete bindings[tabIdText];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [WORKER_BINDINGS_KEY]: bindings });
  return bindings;
}

async function recoverLostWorkerIdentity(goalId) {
  const nowMs = Date.now();
  if (!goalId || nowMs - (lastIdentityRecoveryChecks.get(goalId) || 0) < 15_000) return null;
  lastIdentityRecoveryChecks.set(goalId, nowMs);
  const [status, recovery] = await Promise.all([
    api("/status", {}, "v2", goalId),
    getIdentityRecovery(goalId),
  ]);
  // chrome.tabs.onRemoved is not guaranteed to run during a browser crash or
  // whole-browser shutdown. Verify durable tab-id bindings against observable
  // tabs and the server Worker registry before allowing them to suppress
  // upgrade/restart identity recovery.
  const workerBindings = await reconcileWorkerBindings(status);
  const plan = planIdentityRecovery(status, workerBindings, recovery, nowMs);
  if (!plan) return null;
  // Persist intent before POST. If the service worker dies after the server
  // creates a Worker but before this call returns, the same signature is
  // suppressed until the durable server command can be reclaimed.
  const pending = {
    schema_version: 1,
    signature: plan.signature,
    lane: plan.lane,
    source_worker_id: plan.source_worker_id,
    state: "requesting",
    requested_at: new Date(nowMs).toISOString(),
  };
  await saveIdentityRecovery(goalId, pending);
  try {
    const result = await api(`/lanes/${plan.lane}/replace`, {
      method: "POST",
      body: JSON.stringify({ reason: "companion_identity_storage_recovery" }),
    }, "v2", goalId);
    await saveIdentityRecovery(goalId, { ...pending, state: "requested",
      replacement_worker_id: result?.worker?.worker_id || null, updated_at: new Date().toISOString() });
    return result;
  } catch (error) {
    await saveIdentityRecovery(goalId, { ...pending, state: "failed",
      error: String(error?.message || error).slice(0, 500), updated_at: new Date().toISOString() });
    throw error;
  }
}

async function globalSync(force = false) {
  if (globalSyncRunning) return;
  if (!force && Date.now() - lastGlobalSyncAt < 1500) return;
  globalSyncRunning = true;
  lastGlobalSyncAt = Date.now();
  try {
    const companionInstanceId = await getCompanionInstanceId();
    const config = await getConfig();
    const bindings = await getWorkerBindings();
    const goalIds = new Set([config.goalId, ...Object.values(bindings)
      .filter((binding) => binding?.retired !== true).map((binding) => binding?.goal_id)].filter(Boolean));
    for (const goalId of goalIds) {
      try {
        const response = await api(`/sync?companion_instance_id=${encodeURIComponent(companionInstanceId)}`, {}, "v2", goalId);
        if (response?.command) await handleGlobalCommand(response.command);
        else await recoverLostWorkerIdentity(goalId);
      } catch {
        // A paused or unavailable Goal cannot suppress another Goal's sync.
      }
    }
  } catch {
    // Loopback may be offline during EXE restart. Durable Manager state remains
    // authoritative and the alarm/next heartbeat will retry the sync.
  } finally {
    globalSyncRunning = false;
  }
}

async function reconcileProvisionTransactions() {
  const transactions = await getProvisionTransactions();
  let changed = false;
  for (const [provisionId, tx] of Object.entries(transactions)) {
    if (tx?.state === "creating" && !Number.isInteger(tx.tab_id)) {
      transactions[provisionId] = { ...tx, state: "ambiguous", updated_at: new Date().toISOString() };
      changed = true;
    }
    if (tx?.state === "tab_created" && Number.isInteger(tx.tab_id)) {
      try { await chrome.tabs.get(tx.tab_id); } catch {
        transactions[provisionId] = { ...tx, state: "tab_missing", updated_at: new Date().toISOString() };
        changed = true;
      }
    }
  }
  if (changed) await chrome.storage.local.set({ [PROVISION_TRANSACTIONS_KEY]: transactions });
}

async function tick(sender, telemetry) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, reason: "missing_tab" };
  void globalSync(false);
  const tabInstanceId = await getTabInstanceId(tabId);
  const worker = await resolveWorkerBinding(tabId);
  if (worker && !worker.retired) {
    const companionInstanceId = await getCompanionInstanceId();
    await api(`/workers/${encodeURIComponent(worker.worker_id)}/heartbeat`, {
      method: "POST",
      body: JSON.stringify({
        ...telemetry,
        goal_id: worker.goal_id,
        lane: worker.lane,
        generation: worker.generation,
        provision_id: worker.provision_id,
        companion_instance_id: companionInstanceId,
        tab_instance_id: tabInstanceId,
      }),
    }, "v2", worker.goal_id);
    if (telemetry?.conversation_surface !== "CHAT") {
      return {
        ok: true,
        lane: worker.lane,
        worker_id: worker.worker_id,
        generation: worker.generation,
        tab_instance_id: tabInstanceId,
        command: null,
        reason: "chat_surface_required",
      };
    }
    const result = await api(`/workers/${encodeURIComponent(worker.worker_id)}/command?lane=${worker.lane}&tab_instance_id=${encodeURIComponent(tabInstanceId)}`, {}, "v2", worker.goal_id);
    const command = result?.command || null;
    return {
      ok: true,
      lane: worker.lane,
      worker_id: worker.worker_id,
      generation: worker.generation,
      tab_instance_id: tabInstanceId,
      command,
      do_not_activate: command ? await commandAmbiguous(tabId, command.command_id) : false,
    };
  }

  // v1 fixed-lane binding remains a compatibility/operator escape hatch.
  const binding = await resolveLane(tabId, telemetry);
  if (!binding) return { ok: false, reason: "unbound_goal_scope" };
  const { lane, goal_id: goalId } = binding;
  await api(`/lanes/${lane}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({ ...telemetry, goal_id: goalId, tab_instance_id: tabInstanceId }),
  }, "v1", goalId);
  if (telemetry?.conversation_surface !== "CHAT") {
    return { ok: true, lane, tab_instance_id: tabInstanceId, command: null, reason: "chat_surface_required" };
  }
  const result = await api(`/lanes/${lane}/command?tab_instance_id=${encodeURIComponent(tabInstanceId)}`, {}, "v1", goalId);
  const command = result?.command || null;
  return {
    ok: true,
    lane,
    tab_instance_id: tabInstanceId,
    command,
    do_not_activate: command ? await commandAmbiguous(tabId, command.command_id) : false,
  };
}

async function delivery(sender, payload) {
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, reason: "missing_tab" };
  const commandId = String(payload?.command_id || "");
  if (!commandId) return { ok: false, reason: "missing_command" };
  const binding = await resolveWorkerBinding(tabId) || (await getBindings())[String(tabId)];
  const goalId = binding?.goal_id;
  if (!goalId || (payload?.goal_id && payload.goal_id !== goalId)) return { ok: false, reason: "missing_or_mismatched_goal_scope" };
  const tabInstanceId = await getTabInstanceId(tabId);
  if (payload.status === "activation_ambiguous") {
    await setCommandAmbiguous(tabId, commandId, true);
    // Deliberately do not ACK the Manager here. The same claimed command is
    // retained while the content script waits for marker proof, preventing a
    // second send click after a lost browser acknowledgement.
    return { ok: true, retained_claim: true };
  }
  if (payload.status === "sent_proven") {
    await setCommandAmbiguous(tabId, commandId, false);
    await api(`/commands/${encodeURIComponent(commandId)}/ack`, {
      method: "POST",
      body: JSON.stringify({ goal_id: goalId, tab_instance_id: tabInstanceId, status: "sent" }),
    }, "v2", goalId);
    return { ok: true };
  }
  if (payload.status === "failed_before_activation") {
    await setCommandAmbiguous(tabId, commandId, false);
    await api(`/commands/${encodeURIComponent(commandId)}/ack`, {
      method: "POST",
      body: JSON.stringify({
        tab_instance_id: tabInstanceId,
        status: "failed",
        detail: String(payload.detail || "Browser adapter refused activation").slice(0, 1000),
      }),
    }, "v2", goalId);
    return { ok: true };
  }
  return { ok: false, reason: "unsupported_delivery_status" };
}

async function companionStatus() {
  try { return await api("/status", {}, "v2"); }
  catch { return api("/status", {}, "v1"); }
}

async function replaceLane(lane) {
  if (lane !== "A" && lane !== "B") throw new Error("lane must be A or B");
  return api(`/lanes/${lane}/replace`, {
    method: "POST",
    body: JSON.stringify({ reason: "operator_replace_from_companion" }),
  }, "v2");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const run = async () => {
    if (message?.type === "companion:tick") return tick(sender, message.telemetry || {});
    if (message?.type === "companion:delivery") return delivery(sender, message);
    if (message?.type === "companion:status") return { ok: true, status: await companionStatus() };
    if (message?.type === "companion:replace") return { ok: true, result: await replaceLane(message.lane) };
    if (message?.type === "companion:sync") { await globalSync(true); return { ok: true }; }
    if (message?.type === "companion:trusted-plugin-input") {
      const tabId = sender.tab?.id;
      return { ok: true, result: await typeRequiredChatPlugin(tabId) };
    }
    if (message?.type === "companion:trusted-plugin-click") {
      const tabId = sender.tab?.id;
      return { ok: true, result: await clickRequiredChatPlugin(tabId, message.point) };
    }
    return { ok: false, reason: "unknown_message" };
  };
  run().then(sendResponse).catch((error) => sendResponse({ ok: false, reason: error?.message || String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const bindings = await getBindings();
  const workerBindings = await getWorkerBindings();
  let changed = false;
  if (bindings[String(tabId)]) {
    delete bindings[String(tabId)];
    changed = true;
  }
  if (workerBindings[String(tabId)]) {
    delete workerBindings[String(tabId)];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [BINDINGS_KEY]: bindings, [WORKER_BINDINGS_KEY]: workerBindings });
  await chrome.storage.session.remove(`tab:${tabId}`);
});

async function initialize() {
  await getCompanionInstanceId();
  await reconcileProvisionTransactions();
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 });
  await globalSync(true);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void globalSync(true);
});
chrome.runtime.onInstalled.addListener(() => { void initialize(); });
chrome.runtime.onStartup.addListener(() => { void initialize(); });
void initialize();
