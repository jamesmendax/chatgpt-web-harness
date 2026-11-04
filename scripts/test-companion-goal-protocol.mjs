import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "browser-companion", "service-worker.js"), "utf8");
function part(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "fixture function boundaries changed: " + start);
  return source.slice(from, to);
}
const bindings = {
  "11": { goal_id: "goal-a", worker_id: "A:g1", lane: "A", generation: 1, provision_id: "provision-a", retired: false },
  "22": { goal_id: "goal-b", worker_id: "A:g1", lane: "A", generation: 1, provision_id: "provision-b", retired: false },
};
const outgoing = [];
let releaseA;
const heldA = new Promise(resolve => { releaseA = resolve; });
const tickSandbox = {
  Number, String, Date,
  globalSync: async () => {},
  getTabInstanceId: async tab => "instance-" + tab,
  resolveWorkerBinding: async tab => bindings[String(tab)] || null,
  getCompanionInstanceId: async () => "companion",
  getBindings: async () => ({}),
  commandAmbiguous: async () => false,
  setCommandAmbiguous: async () => {},
  resolveLane: async () => null,
  api: async (url, init, version, goalId) => {
    outgoing.push({ url, init, version, goalId });
    assert.ok(["goal-a", "goal-b"].includes(goalId), "a Worker request lost its captured Goal");
    if (url.includes("/heartbeat") && goalId === "goal-a") await heldA;
    return url.includes("/command?") ? { command: { command_id: "command-" + goalId, goal_id: goalId } } : { ok: true };
  },
};
vm.createContext(tickSandbox);
vm.runInContext(part("async function tick(", "async function companionStatus("), tickSandbox);
const tickA = tickSandbox.tick({ tab: { id: 11 } }, { conversation_surface: "CHAT" });
await new Promise(resolve => setImmediate(resolve));
const tickB = await tickSandbox.tick({ tab: { id: 22 } }, { conversation_surface: "CHAT" });
assert.equal(tickB.command.goal_id, "goal-b", "A's pending heartbeat blocked B");
assert.ok(outgoing.some(call => call.goalId === "goal-b" && call.url.includes("/command?")));
releaseA();
assert.equal((await tickA).command.goal_id, "goal-a");
for (const goalId of ["goal-a", "goal-b"]) {
  const heartbeat = outgoing.find(call => call.goalId === goalId && call.url.includes("/heartbeat"));
  assert.equal(JSON.parse(heartbeat.init.body).goal_id, goalId);
}
await tickSandbox.delivery({ tab: { id: 11 } }, { command_id: "command-goal-a", status: "sent_proven" });
assert.equal(outgoing.at(-1).goalId, "goal-a", "delivery ACK used the other Goal's current configuration");
const count = outgoing.length;
const forgedDelivery = await tickSandbox.delivery({ tab: { id: 11 } }, {
  goal_id: "goal-b", command_id: "command-goal-b", status: "sent_proven",
});
assert.equal(forgedDelivery.ok, false);
assert.equal(outgoing.length, count, "a mismatched delivery attempted an ACK");

// Configuration is for a selected control panel; each already bound Worker
// supplies an explicit immutable Goal selector that takes precedence on the wire.
const requests = [];
let responseGoal = "goal-a";
const apiSandbox = {
  Headers, AbortSignal,
  REQUEST_TIMEOUT_MS: 10000,
  getConfig: async () => ({ baseUrl: "http://127.0.0.1:32001/companion/v2", token: "fixture", goalId: "goal-b" }),
  fetch: async (url, init) => {
    requests.push({ url, goalId: init.headers.get("x-relay-goal-id") });
    return { ok: true, json: async () => ({ goal_id: responseGoal, command: { goal_id: responseGoal } }) };
  },
};
vm.createContext(apiSandbox);
vm.runInContext(part("function versionedBase(", "async function getBindings("), apiSandbox);
await apiSandbox.api("/workers/A%3Ag1/command", {}, "v2", "goal-a");
assert.equal(requests.at(-1).goalId, "goal-a");
responseGoal = "goal-b";
await assert.rejects(apiSandbox.api("/workers/A%3Ag1/command", {}, "v2", "goal-a"), /GOAL_SCOPE_MISMATCH/);

// Sync visits explicit configured/bound identities. One Goal's failure must
// neither stop another Goal's polling nor silently choose a discovered Goal.
const synced = [], recovered = [];
const syncSandbox = {
  Date, Set, Object,
  getCompanionInstanceId: async () => "companion",
  getConfig: async () => ({ goalId: "goal-a" }),
  getWorkerBindings: async () => bindings,
  api: async (_url, _init, _version, goalId) => {
    synced.push(goalId);
    if (goalId === "goal-a") throw new Error("fixture A unavailable");
    return { command: null, goal_id: goalId };
  },
  handleGlobalCommand: async () => { throw new Error("unexpected command"); },
  recoverLostWorkerIdentity: async goalId => recovered.push(goalId),
};
vm.createContext(syncSandbox);
vm.runInContext("let globalSyncRunning = false; let lastGlobalSyncAt = 0;\n" +
  part("async function globalSync(", "async function reconcileProvisionTransactions("), syncSandbox);
await syncSandbox.globalSync(true);
assert.deepEqual(synced.sort(), ["goal-a", "goal-b"]);
assert.deepEqual(recovered, ["goal-b"]);

// A retirement command addresses Goal + Worker, even when both Goals use A:g1.
const retired = structuredClone(bindings);
const closedTabs = [], acknowledgments = [];
const retirementSandbox = {
  Object, Number, Date,
  WORKER_BINDINGS_KEY: "workerBindings",
  getWorkerBindings: async () => retired,
  ackGlobalCommand: async command => acknowledgments.push(command.goal_id),
  chrome: { tabs: { remove: async tab => closedTabs.push(tab) }, storage: { local: { set: async () => {} } } },
};
vm.createContext(retirementSandbox);
vm.runInContext(part("async function handleRetirementCommand(", "async function handleGlobalCommand("), retirementSandbox);
await retirementSandbox.handleRetirementCommand({ goal_id: "goal-a", worker_id: "A:g1", command_id: "retire-a" }, true);
assert.deepEqual(closedTabs, [11]);
assert.equal(retired["22"].retired, false, "A retirement changed B's binding");
assert.deepEqual(acknowledgments, ["goal-a"]);

// Status reconciliation from A leaves the live B binding intact.
const reconcileBindings = structuredClone(bindings);
const reconciliationSandbox = {
  Object, Number, URL,
  WORKER_BINDINGS_KEY: "workerBindings",
  getWorkerBindings: async () => reconcileBindings,
  chrome: { tabs: { get: async tab => ({ id: tab, url: "https://chatgpt.com/c/conversation-" + tab }) },
    storage: { local: { set: async () => {} } } },
};
vm.createContext(reconciliationSandbox);
vm.runInContext(part("function normalizeConversationUrl(", "async function resolveLane(") +
  part("function workerBindingMatchesTab(", "async function recoverLostWorkerIdentity("), reconciliationSandbox);
await reconciliationSandbox.reconcileWorkerBindings({
  goal_id: "goal-a",
  workers: { workers: { "A:g1": { ...bindings["11"], state: "READY", conversation_url: "https://chatgpt.com/c/conversation-11" } } },
});
assert.equal(reconcileBindings["22"].goal_id, "goal-b");
assert.equal(reconcileBindings["22"].retired, false);

assert.match(source, /const MAX_LIVE_MANAGED_WORKER_TABS = 2/);
assert.match(source, /const MAX_PROVISION_CREATIONS_PER_WINDOW = 2/);
console.log("PASS Companion Goal protocol: concurrent heartbeat/claim, captured wire Goal, ACK, sync errors, retirement and reconciliation isolation; shared budgets retained");
