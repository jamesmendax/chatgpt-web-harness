import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fenceRetiredRelayIfPresent } from "../src/lib/retired-relay-compat.ts";
import { legacyRelayRoot, relayGoalDirectory, withRelayGoal } from "../src/lib/relay-scope.ts";
import { ensureDriverLease, readDriverLease, driverLeasePath } from "../src/lib/driver-lease.ts";
import { readRelayManagerState } from "../src/lib/relay-manager.ts";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-retired-relay-"));
const keys = ["CODEX_HOME", "HARNESS_RELAY_ENABLED"]; const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
try {
  process.env.CODEX_HOME = path.join(temp, "state"); process.env.HARNESS_RELAY_ENABLED = "true";
  const workspace = path.join(temp, "empty"); await fs.mkdir(workspace);
  assert.equal(await fenceRetiredRelayIfPresent(workspace, "none"), false);
  await assert.rejects(fs.stat(legacyRelayRoot(workspace)), {code:"ENOENT"});
  const make = goal => ensureDriverLease(workspace, { goalId:goal, ownerSessionId:`owner-${goal}`, executionContractHash:"a".repeat(64), intentRevision:1 });
  await make("old-a"); await make("other-b");
  const b = await fs.readFile(driverLeasePath(workspace,"other-b"), "utf8");
  assert.equal(await fenceRetiredRelayIfPresent(workspace, "old-a"), true);
  assert.equal((await readDriverLease(workspace,"old-a")).state, "RELEASED");
  assert.equal(await fs.readFile(driverLeasePath(workspace,"other-b"), "utf8"), b);
  // Simulate an actual pre-scope account with an attributable lease and
  // outstanding commands. Uncertain deliveries must never become replayable.
  const oldWorkspace = path.join(temp, "unscoped"); await fs.mkdir(oldWorkspace);
  const oldGoal = "legacy-goal";
  await ensureDriverLease(oldWorkspace, { goalId: oldGoal, ownerSessionId: "legacy-owner", executionContractHash: "c".repeat(64), intentRevision: 1 });
  const initial = await withRelayGoal(oldWorkspace, oldGoal, () => readRelayManagerState(oldWorkspace));
  const oldLeaseBytes = await fs.readFile(driverLeasePath(oldWorkspace, oldGoal), "utf8");
  const oldRoot = legacyRelayRoot(oldWorkspace);
  await fs.rm(relayGoalDirectory(oldWorkspace, oldGoal), { recursive: true });
  await fs.writeFile(path.join(oldRoot, "driver-lease.json"), oldLeaseBytes);
  await fs.writeFile(path.join(oldRoot, "manager.json"), JSON.stringify({ ...initial, commands: [
    { command_id: "pending", goal_id: oldGoal, state: "PENDING" },
    { command_id: "claimed", goal_id: oldGoal, state: "CLAIMED" },
    { command_id: "sent", goal_id: oldGoal, state: "SENT" },
  ] }));
  assert.equal(await fenceRetiredRelayIfPresent(oldWorkspace, oldGoal), true);
  assert.equal((await readDriverLease(oldWorkspace, oldGoal)).state, "RELEASED");
  const fenced = await withRelayGoal(oldWorkspace, oldGoal, () => readRelayManagerState(oldWorkspace));
  assert.ok(fenced.fenced_at);
  assert.deepEqual(fenced.commands.map(({ state }) => state), ["FAILED", "AMBIGUOUS", "AMBIGUOUS"]);
  assert.equal(await fs.readFile(path.join(oldRoot, "driver-lease.json"), "utf8"), oldLeaseBytes,
    "migration must preserve original legacy evidence");
  const ambiguous = path.join(temp, "ambiguous"); await fs.mkdir(ambiguous);
  const legacy = legacyRelayRoot(ambiguous); await fs.mkdir(legacy, {recursive:true});
  await fs.writeFile(path.join(legacy,"manager.json"), "{}");
  await assert.rejects(fenceRetiredRelayIfPresent(ambiguous,"unknown"), /RELAY_LEGACY_GOAL_UNKNOWN/);
  assert.equal(await fs.readFile(path.join(legacy,"manager.json"),"utf8"), "{}");
  console.log("PASS no-record bypass, old lease fenced, other Goal preserved, ambiguous legacy fails closed");
} finally {
  for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  await fs.rm(temp,{recursive:true,force:true});
}
