"use strict";

const CONFIG_KEY = "relayConfig";
const BINDINGS_KEY = "laneBindings";
const TARGETS_KEY = "laneTargets";
const WORKER_BINDINGS_KEY = "workerBindings";
const RUNTIME_BOOTSTRAP_URL = globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL("runtime-bootstrap.json") : "";

const $ = (id) => document.getElementById(id);

async function activeTab() {
  if (!globalThis.chrome?.tabs?.query) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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

function show(message, ok = true) {
  $("status").textContent = message;
  $("status").style.color = ok ? "#136f2d" : "#a11";
}

function validBaseUrl(value) {
  return /^http:\/\/127\.0\.0\.1:\d+\/companion\/v[12]$/i.test(value);
}

async function readDesktopBootstrap() {
  if (!RUNTIME_BOOTSTRAP_URL) return null;
  try {
    const response = await fetch(`${RUNTIME_BOOTSTRAP_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) return null;
    const value = await response.json();
    const baseUrl = String(value?.base_url || "").trim().replace(/\/+$/, "");
    if (Number(value?.schema_version) !== 1 || !validBaseUrl(baseUrl) || !String(value?.token || "").trim()) return null;
    return { baseUrl, accountId: value.account_id || null, appVersion: value.app_version || null };
  } catch {
    return null;
  }
}

async function saveConfig() {
  const baseUrl = $("baseUrl").value.trim().replace(/\/+$/, "");
  const token = $("token").value.trim();
  const goalId = $("goalId").value.trim();
  if (!goalId || goalId.length > 512 || /[\x00-\x1f]/.test(goalId)) throw new Error("请输入要连接的 Goal ID");
  if (!validBaseUrl(baseUrl)) throw new Error("Companion API 必须是 loopback http://127.0.0.1:<port>/companion/v1 或 /v2");
  if (!token && !await readDesktopBootstrap()) throw new Error("请输入 Companion Token");
  const previous = (await chrome.storage.local.get(CONFIG_KEY))[CONFIG_KEY] || {};
  await chrome.storage.local.set({ [CONFIG_KEY]: { baseUrl, token: token || previous.token || "", goalId } });
  await chrome.runtime.sendMessage({ type: "companion:sync" }).catch(() => null);
  show("配置已保存，正在同步 Worker 状态。");
}

function workerForLane(status, lane) {
  const registry = status?.workers;
  const laneState = registry?.lanes?.[lane];
  if (!registry || !laneState) return null;
  const id = laneState.active_worker_id || laneState.standby_worker_id;
  return id ? registry.workers?.[id] || null : null;
}

function renderLane(status, lane) {
  const worker = workerForLane(status, lane);
  const driver = status?.driver;
  const isDriverLane = status?.manager?.active_lane === lane;
  $(`worker${lane}`).textContent = worker?.worker_id || "未创建";
  $(`state${lane}`).textContent = worker ? `${worker.state}${isDriverLane && driver ? ` · epoch ${driver.epoch}` : ""}` : "EMPTY";
  $(`url${lane}`).textContent = worker?.conversation_url || (worker ? "等待 conversation URL / composer ready" : "等待 Auto-Provisioner 创建");
}

async function refreshStatus() {
  const response = await chrome.runtime.sendMessage({ type: "companion:status" });
  if (!response?.ok) throw new Error(response?.reason || "连接失败");
  const state = response.status;
  if (state?.discovery_only) {
    show(`请选择并保存 Goal ID。可用 Goal：\n${(state.goals || []).join("\n") || "尚无 Relay Goal"}`);
    return state;
  }
  renderLane(state, "A");
  renderLane(state, "B");
  show([
    `连接正常 · Goal ${state.goal_id}`,
    `自动 Worker: ${state.automation_enabled ? "已启用" : "未启用"}`,
    `当前 Driver: ${state.driver ? `${state.driver.state} / epoch ${state.driver.epoch}` : "尚未建立"}`,
    `Manager schema: v${state.manager?.schema_version ?? "?"}`,
    `Worker Registry rev: ${state.workers?.revision ?? 0}`,
  ].join("\n"));
  return state;
}

async function load() {
  if (!globalThis.chrome?.storage?.local || !globalThis.chrome?.runtime?.sendMessage) {
    show("扩展预览模式：安装到 Chrome 后将读取真实 Worker / Driver 状态。", true);
    return;
  }
  const tab = await activeTab();
  const data = await chrome.storage.local.get([CONFIG_KEY, BINDINGS_KEY, TARGETS_KEY]);
  const config = data[CONFIG_KEY] || {};
  const managed = await readDesktopBootstrap();
  const bindings = data[BINDINGS_KEY] || {};
  const targets = data[TARGETS_KEY] || {};
  $("baseUrl").value = managed?.baseUrl || config.baseUrl || "";
  $("goalId").value = config.goalId || "";
  $("token").value = managed ? "" : (config.token || "");
  if (managed) {
    $("token").placeholder = "由 Web Harness Desktop 自动注入（不会在此显示）";
    $("baseUrl").title = "Desktop 自动 bootstrap；无需手填端口";
  }
  const normalized = normalizeConversationUrl(tab?.url || "");
  const targetLane = normalized
    ? (["A", "B"].find((candidate) => normalizeConversationUrl(targets[`${config.goalId}:${candidate}`]?.url) === normalized) || "")
    : "";
  $("lane").value = tab?.id ? ((bindings[String(tab.id)]?.goal_id === config.goalId ? bindings[String(tab.id)].lane : "") || targetLane || "") : "";
  if (managed || config.token) await refreshStatus().catch((error) => show(error.message, false));
}

async function saveManualBinding() {
  await saveConfig();
  const tab = await activeTab();
  if (!tab?.id) throw new Error("无法识别当前标签页");
  if (!tab.url?.startsWith("https://chatgpt.com/") && !tab.url?.startsWith("https://chat.openai.com/")) {
    throw new Error("当前标签页不是 ChatGPT");
  }
  const lane = $("lane").value;
  const goalId = $("goalId").value.trim();
  if (lane !== "A" && lane !== "B") throw new Error("请选择 Chat A 或 Chat B");
  const normalizedUrl = normalizeConversationUrl(tab.url);
  if (!normalizedUrl) throw new Error("当前 ChatGPT URL 无法作为手动接力目标");
  const data = await chrome.storage.local.get([BINDINGS_KEY, TARGETS_KEY]);
  const bindings = data[BINDINGS_KEY] || {};
  const targets = data[TARGETS_KEY] || {};
  for (const [tabId, existingLane] of Object.entries(bindings)) {
    if (existingLane?.goal_id === goalId && existingLane.lane === lane && tabId !== String(tab.id)) delete bindings[tabId];
  }
  bindings[String(tab.id)] = { lane, goal_id: goalId };
  targets[`${goalId}:${lane}`] = { lane, goal_id: goalId, url: normalizedUrl };
  await chrome.storage.local.set({ [BINDINGS_KEY]: bindings, [TARGETS_KEY]: targets });
  show(`已将当前标签页作为兼容入口绑定到 Lane ${lane}。自动 Worker Registry 不会被覆盖。`);
}

async function unbindCurrent() {
  const tab = await activeTab();
  if (!tab?.id) throw new Error("无法识别当前标签页");
  const data = await chrome.storage.local.get([BINDINGS_KEY, TARGETS_KEY]);
  const bindings = data[BINDINGS_KEY] || {};
  const targets = data[TARGETS_KEY] || {};
  const binding = bindings[String(tab.id)];
  delete bindings[String(tab.id)];
  const key = binding?.goal_id ? `${binding.goal_id}:${binding.lane}` : "";
  if (key && normalizeConversationUrl(targets[key]?.url) === normalizeConversationUrl(tab.url)) delete targets[key];
  await chrome.storage.local.set({ [BINDINGS_KEY]: bindings, [TARGETS_KEY]: targets });
  $("lane").value = "";
  show("已解除当前标签页的手动兼容绑定；自动 Worker 不受影响。");
}

async function replaceLane(lane) {
  const response = await chrome.runtime.sendMessage({ type: "companion:replace", lane });
  if (!response?.ok) throw new Error(response?.reason || `替换 Lane ${lane} 失败`);
  const worker = response.result?.worker;
  show(`已请求替换 Lane ${lane}${worker?.worker_id ? ` → ${worker.worker_id}` : ""}。Auto-Provisioner 将按同一安全状态机创建新 Chat。`);
  await refreshStatus();
}

async function openLane(lane) {
  const status = await refreshStatus();
  const worker = workerForLane(status, lane);
  if (!worker) throw new Error(`Lane ${lane} 还没有 Worker`);
  const data = await chrome.storage.local.get(WORKER_BINDINGS_KEY);
  const bindings = data[WORKER_BINDINGS_KEY] || {};
  const local = Object.entries(bindings).find(([, binding]) => binding?.goal_id === worker.goal_id && binding?.worker_id === worker.worker_id);
  if (local) {
    const tabId = Number(local[0]);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
      return;
    } catch {}
  }
  const url = normalizeConversationUrl(worker.conversation_url);
  if (!url) throw new Error(`${worker.worker_id} 尚未形成可恢复的 conversation URL`);
  await chrome.tabs.create({ url, active: true });
}

$("saveConfig").addEventListener("click", () => saveConfig().catch((error) => show(error.message, false)));
$("save").addEventListener("click", () => saveManualBinding().catch((error) => show(error.message, false)));
$("unbind").addEventListener("click", () => unbindCurrent().catch((error) => show(error.message, false)));
$("test").addEventListener("click", () => refreshStatus().catch((error) => show(error.message, false)));
for (const lane of ["A", "B"]) {
  $(`replace${lane}`).addEventListener("click", () => replaceLane(lane).catch((error) => show(error.message, false)));
  $(`open${lane}`).addEventListener("click", () => openLane(lane).catch((error) => show(error.message, false)));
}
void load().catch((error) => show(error.message, false));
