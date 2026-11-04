import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRuntimeScope } from "./runtime-scope.js";
import { getGoal } from "./goal-state-store.js";
import { writeTextFileCas } from "./safe-text-write.js";

interface RelayScope { readonly workspace: string; readonly goalId: string }
const scopes = new AsyncLocalStorage<RelayScope>();
const migrationChains = new Map<string, Promise<void>>();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const workspaceKey = (root: string) => path.resolve(root).toLowerCase();

function validGoalId(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) {
    throw new Error("RELAY_GOAL_SCOPE_INVALID: a nonempty durable Goal identity is required");
  }
  return value.trim();
}

export function withRelayGoal<T>(workspaceRoot: string, goalId: string, operation: () => T): T {
  const next = { workspace: workspaceKey(workspaceRoot), goalId: validGoalId(goalId) };
  const current = scopes.getStore();
  if (current && (current.workspace !== next.workspace || current.goalId !== next.goalId)) {
    throw new Error("RELAY_GOAL_SCOPE_MISMATCH: cannot change Goal inside a Relay transaction");
  }
  return scopes.run(Object.freeze(next), operation);
}

export function currentRelayGoal(workspaceRoot: string): string | undefined {
  const current = scopes.getStore();
  if (current && current.workspace !== workspaceKey(workspaceRoot)) {
    throw new Error("RELAY_GOAL_SCOPE_MISMATCH: Relay scope belongs to another workspace");
  }
  return current?.goalId;
}

/** Trusted lifecycle boundary only: caller must first validate the old/new Goal journal or exact transition. */
export function withRelayGoalTransition<T>(workspaceRoot: string, expectedFromGoalId: string | undefined, toGoalId: string, operation: () => T): T {
  const actual = currentRelayGoal(workspaceRoot);
  const expected = expectedFromGoalId === undefined ? undefined : validGoalId(expectedFromGoalId);
  if (actual !== expected) throw new Error("RELAY_GOAL_SCOPE_MISMATCH: lifecycle transition source changed");
  return scopes.run(Object.freeze({ workspace: workspaceKey(workspaceRoot), goalId: validGoalId(toGoalId) }), operation);
}

export function requireRelayGoal(workspaceRoot: string, explicitGoalId?: string): string {
  const current = currentRelayGoal(workspaceRoot);
  const explicit = explicitGoalId === undefined ? undefined : validGoalId(explicitGoalId);
  if (current && explicit && current !== explicit) throw new Error("RELAY_GOAL_SCOPE_MISMATCH: conflicting Goal identities");
  const selected = explicit ?? current;
  if (!selected) throw new Error("RELAY_GOAL_SCOPE_REQUIRED: resolve a trusted Goal/session or exact transition before Relay access");
  return selected;
}

export function legacyRelayRoot(workspaceRoot: string): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "projects", digest(workspaceKey(workspaceRoot)).slice(0, 12), "relay");
}

export function relayGoalDirectory(workspaceRoot: string, goalId?: string): string {
  return path.join(legacyRelayRoot(workspaceRoot), "goals", digest(requireRelayGoal(workspaceRoot, goalId)));
}

// Discovery may inspect other identities while a caller remains in its own immutable scope.
// This private path helper never enters a scope and is not used by authority mutators.
function discoveryGoalDirectory(workspaceRoot: string, goalId: string): string {
  return path.join(legacyRelayRoot(workspaceRoot), "goals", digest(validGoalId(goalId)));
}

export function relayGoalPath(workspaceRoot: string, relativePath: string, goalId?: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === "..")) {
    throw new Error("RELAY_PATH_INVALID");
  }
  return path.join(relayGoalDirectory(workspaceRoot, goalId), relativePath);
}

export function relayScopeKey(workspaceRoot: string, goalId?: string): string {
  return relayGoalDirectory(workspaceRoot, goalId).toLowerCase();
}

async function readOptional(file: string): Promise<string | null> {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function parse(raw: string, file: string): Record<string, any> {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  throw new Error(`RELAY_STATE_UNREADABLE: ${file}`);
}
async function publishSame(file: string, raw: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await writeTextFileCas(file, raw, { createOnly: true }); }
  catch (error) { if (await readOptional(file) !== raw) throw error; }
}

export async function listRelayGoalIds(workspaceRoot: string): Promise<string[]> {
  const base = path.join(legacyRelayRoot(workspaceRoot), "goals");
  let names: string[];
  try { names = await fs.readdir(base); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (names.length > 2048) throw new Error("RELAY_DISCOVERY_LIMIT: Goal scope discovery exceeds its bound");
  const ids: string[] = [];
  for (const name of names.sort()) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const marker = await readOptional(path.join(base, name, "scope.json"));
    if (!marker) continue;
    const state = parse(marker, "scope.json");
    if (typeof state.goal_id !== "string" || digest(state.goal_id) !== name) throw new Error("RELAY_GOAL_SCOPE_CORRUPT");
    ids.push(state.goal_id);
  }
  return ids;
}

/** Discovery returns identity only. It never grants authority or migrates files. */
export async function resolveRelayGoalForSession(workspaceRoot: string, sessionId: string): Promise<string | null> {
  if (!sessionId.trim()) return null;
  const owned = await getGoal(workspaceRoot, sessionId);
  if (owned?.owner_session === sessionId) return owned.id;
  const matches = new Set<string>();
  for (const goalId of await listRelayGoalIds(workspaceRoot)) {
    const discoveryRoot = discoveryGoalDirectory(workspaceRoot, goalId);
    const leaseRaw = await readOptional(path.join(discoveryRoot, "driver-lease.json"));
    if (leaseRaw) {
      const lease = parse(leaseRaw, "driver-lease.json");
      if (lease.goal_id !== goalId) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
      if (lease.owner_session_id === sessionId || lease.authority_transition?.source_session_id === sessionId) matches.add(goalId);
    }
    const workersRaw = await readOptional(path.join(discoveryRoot, "workers.json"));
    if (workersRaw && Object.values(parse(workersRaw, "workers.json").workers || {}).some((worker: any) => worker?.goal_id === goalId && worker?.bound_session_id === sessionId)) matches.add(goalId);
    const handoffRoot = path.join(discoveryRoot, "handoffs");
    let snapshots: string[] = [];
    try { snapshots = await fs.readdir(handoffRoot); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (snapshots.length > 4096) throw new Error("RELAY_DISCOVERY_LIMIT: handoff identity history exceeds its bound");
    for (const name of snapshots.filter((entry) => entry.endsWith(".json"))) {
      const raw = await readOptional(path.join(handoffRoot, name));
      if (!raw) continue;
      const snapshot = parse(raw, name);
      if (snapshot.goal_id !== goalId) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
      if (snapshot.source_session_id === sessionId ||
          (snapshot.state === "COMMITTED" && snapshot.target_session_id === sessionId)) matches.add(goalId);
    }
  }
  const legacy = await readOptional(path.join(legacyRelayRoot(workspaceRoot), "driver-lease.json"));
  if (legacy) {
    const lease = parse(legacy, "legacy driver-lease.json");
    if (lease.owner_session_id === sessionId && typeof lease.goal_id === "string") matches.add(lease.goal_id);
  }
  if (matches.size > 1) throw new Error("RELAY_GOAL_SCOPE_AMBIGUOUS: session matches multiple Relay Goals");
  return [...matches][0] ?? null;
}

export async function resolveRelayGoalForTransition(workspaceRoot: string, transitionId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(transitionId)) throw new Error("RELAY_TRANSITION_ID_INVALID");
  const matches = new Set<string>();
  const roots: Array<{ root: string; goalId?: string }> = [{ root: legacyRelayRoot(workspaceRoot) }];
  for (const goalId of await listRelayGoalIds(workspaceRoot)) roots.push({ root: discoveryGoalDirectory(workspaceRoot, goalId), goalId });
  for (const candidate of roots) {
    const snapshot = await readOptional(path.join(candidate.root, "handoffs", transitionId + ".json"));
    if (snapshot) {
      const value = parse(snapshot, "handoff");
      if (!value.goal_id || (candidate.goalId && candidate.goalId !== value.goal_id)) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
      matches.add(value.goal_id);
    }
    const manager = await readOptional(path.join(candidate.root, "manager.json"));
    if (manager) {
      for (const command of parse(manager, "manager.json").commands || []) {
        if (![command.command_id, command.handoff_id, command.probe_id].includes(transitionId)) continue;
        if (!command.goal_id || (candidate.goalId && candidate.goalId !== command.goal_id)) throw new Error("RELAY_GOAL_SCOPE_UNKNOWN: transition has no verified Goal");
        matches.add(command.goal_id);
      }
    }
  }
  if (matches.size > 1) throw new Error("RELAY_GOAL_SCOPE_AMBIGUOUS: transition matches multiple Goals");
  return [...matches][0] ?? null;
}

export async function withResolvedRelayGoal<T>(workspaceRoot: string, goalId: string | undefined, operation: () => Promise<T>): Promise<T> {
  const selected = goalId ?? currentRelayGoal(workspaceRoot) ??
    (getRuntimeScope()?.mcpSessionId ? await resolveRelayGoalForSession(workspaceRoot, getRuntimeScope()!.mcpSessionId!) : null);
  if (!selected) throw new Error("RELAY_GOAL_SCOPE_REQUIRED: an explicit Goal or trusted session binding is required");
  return withRelayGoal(workspaceRoot, selected, operation);
}

const terminalWorkers = new Set(["RETIRED", "DEAD", "FAILED"]);
const terminalCommands = new Set(["ACKED", "FAILED", "EXPIRED"]);
async function legacyMigrationFiles(workspaceRoot: string, goalId: string): Promise<Map<string, string>> {
  const root = legacyRelayRoot(workspaceRoot);
  const files = new Map<string, string>();
  const leaseRaw = await readOptional(path.join(root, "driver-lease.json"));
  if (!leaseRaw) {
    if (await readOptional(path.join(root, "manager.json")) || await readOptional(path.join(root, "workers.json"))) {
      throw new Error("RELAY_LEGACY_GOAL_UNKNOWN: legacy management state has no authoritative Goal lease");
    }
    return files;
  }
  const lease = parse(leaseRaw, "legacy driver-lease.json");
  if (typeof lease.goal_id !== "string" || !lease.goal_id) throw new Error("RELAY_LEGACY_GOAL_UNKNOWN: legacy lease has no Goal");
  if (lease.goal_id !== goalId) return files; // Preserve the other Goal verbatim.
  files.set("driver-lease.json", leaseRaw);
  for (const name of ["workers.json", "manager.json"]) {
    const raw = await readOptional(path.join(root, name));
    if (!raw) continue;
    const value = parse(raw, name);
    if (value.goal_id && value.goal_id !== goalId) throw new Error("RELAY_LEGACY_GOAL_MISMATCH");
    if (name === "workers.json") {
      for (const worker of Object.values(value.workers || {}) as any[]) {
        if (worker.goal_id !== goalId && (!terminalWorkers.has(worker.state) || worker.goal_id)) {
          throw new Error("RELAY_LEGACY_GOAL_UNKNOWN: active/uncertain Worker must have an explicit matching Goal");
        }
      }
    } else {
      for (const command of value.commands || []) {
        if (command.goal_id !== goalId && (!terminalCommands.has(command.state) || command.goal_id)) {
          throw new Error("RELAY_LEGACY_GOAL_UNKNOWN: active/uncertain command must have an explicit matching Goal");
        }
      }
      if (!value.goal_id && Object.values(value.lanes || {}).some((lane: any) => lane?.observation || lane?.tab_instance_id)) {
        const workersRaw = await readOptional(path.join(root, "workers.json"));
        const workers = workersRaw ? Object.values(parse(workersRaw, "workers.json").workers || {}) as any[] : [];
        if (workers.length === 0 || workers.some((worker) => worker.goal_id !== goalId)) {
          throw new Error("RELAY_LEGACY_GOAL_UNKNOWN: lane observations cannot establish Goal authority");
        }
      }
    }
    files.set(name, JSON.stringify({ ...value, goal_id: goalId }, null, 2) + "\n");
  }
  for (const directory of ["handoffs", "resume-bundles"]) {
    let names: string[];
    try { names = await fs.readdir(path.join(root, directory)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const name of names.filter((item) => /^[A-Za-z0-9_.:-]+\.json$/.test(item)).sort()) {
      const raw = (await readOptional(path.join(root, directory, name)))!;
      if (parse(raw, name).goal_id === goalId) files.set(path.join(directory, name), raw);
    }
  }
  const transitions = await readOptional(path.join(root, "transitions.ndjson"));
  // Preserve the full legacy audit bytes separately. Unscoped historical events
  // cannot be promoted into authoritative Goal transitions by Worker id alone.
  if (transitions !== null) {
    files.set("legacy-transitions.ndjson", transitions);
    const matching = transitions.split(/\r?\n/).filter((line) => line.trim()).filter((line) =>
      parse(line, "legacy transitions.ndjson").goal_id === goalId);
    if (matching.length) files.set("transitions.ndjson", matching.join("\n") + "\n");
  }
  return files;
}

/** Read-only compatibility: no directory creation, no migration, no global Goal inference. */
export async function readRelayStateText(workspaceRoot: string, relativePath: string): Promise<string | null> {
  const goalId = requireRelayGoal(workspaceRoot);
  const marker = await readOptional(relayGoalPath(workspaceRoot, "scope.json"));
  if (marker) {
    if (parse(marker, "scope.json").goal_id !== goalId) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
    return readOptional(relayGoalPath(workspaceRoot, relativePath));
  }
  const files = await legacyMigrationFiles(workspaceRoot, goalId);
  return files.get(relativePath) ?? null;
}

/** A short shared legacy lock protects migration only; ordinary authority locks are Goal-scoped. */
export async function ensureRelayGoalStorage(workspaceRoot: string): Promise<void> {
  const goalId = requireRelayGoal(workspaceRoot);
  const marker = relayGoalPath(workspaceRoot, "scope.json");
  const existing = await readOptional(marker);
  if (existing) {
    if (parse(existing, marker).goal_id !== goalId) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
    return;
  }
  const key = legacyRelayRoot(workspaceRoot).toLowerCase();
  const previous = migrationChains.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const chain = previous.catch(() => undefined).then(() => gate);
  migrationChains.set(key, chain);
  await previous.catch(() => undefined);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  const lockPath = path.join(legacyRelayRoot(workspaceRoot), "legacy-migration.lock");
  const token = randomUUID();
  try {
    const alreadyPublished = await readOptional(marker);
    if (alreadyPublished) {
      if (parse(alreadyPublished, marker).goal_id !== goalId) throw new Error("RELAY_GOAL_SCOPE_MISMATCH");
      return;
    }
    await legacyMigrationFiles(workspaceRoot, goalId); // Reject ambiguity before writes.
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { handle = await fs.open(lockPath, "wx"); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const raw = await readOptional(lockPath);
        if (raw) {
          const owner = parse(raw, lockPath);
          if (Number.isInteger(owner.pid) && owner.pid > 0) {
            let dead = false;
            try { process.kill(owner.pid, 0); } catch (probe) { dead = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
            if (dead && await readOptional(lockPath) === raw) { await fs.unlink(lockPath); continue; }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!handle) throw new Error("RELAY_MIGRATION_BUSY: another migration owns the legacy snapshot");
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, goal_id: goalId }));
    const files = await legacyMigrationFiles(workspaceRoot, goalId);
    for (const [name, raw] of files) await publishSame(relayGoalPath(workspaceRoot, name), raw);
    await publishSame(marker, JSON.stringify({ version: 1, goal_id: goalId, migrated_files: [...files.keys()] }, null, 2) + "\n");
  } finally {
    if (handle) {
      await handle.close();
      const raw = await readOptional(lockPath);
      if (raw && parse(raw, lockPath).token === token) await fs.unlink(lockPath);
    }
    release();
    if (migrationChains.get(key) === chain) migrationChains.delete(key);
  }
}
