import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { goalStateStore } from "./goal-state-store.js";
import { withCanonicalFileLock, writeTextFileCas } from "./safe-text-write.js";

type Kind = "effect" | "transition";
interface RecordV1 {
  version: 1; kind: Kind; token: string; goal: string; owner: string | null;
  pid: number; created_at: string; transaction: string | null; revision: number | null; endpoint: string | null;
  prepared_process?: PreparedProcessEffect;
  managed_process?: ManagedProcessEffect;
}
interface PreparedProcessEffect {
  version: 1; effect_token: string; process_id: string; launch_id: string;
  command_hash: string; receipt_key_hash: string;
}
interface ManagedProcessEffect extends PreparedProcessEffect {
  parent_effect_token: string; host_start_identity: string;
  child_pid: number | null; child_start_identity: string | null;
}
/** Internal launch capability. Never expose this value in tool results, logs or child environments. */
export interface ManagedProcessEffectLaunch extends PreparedProcessEffect {
  workspace_root: string; goal_id: string; owner_session_id: string | null;
  parent_effect_token: string; receipt_key: string;
}
export interface ProcessEffectReference {
  effect_token: string; parent_effect_token: string; launch_id: string;
}
interface TerminalReceipt {
  version: 1; kind: "managed_process_terminal"; goal_id: string; owner_session_id: string | null;
  effect_token: string; parent_effect_token: string; process_id: string; launch_id: string;
  command_hash: string; receipt_key: string; host_pid: number; host_start_identity: string;
  child_pid: number; child_start_identity: string | null;
  exit_code: number | null; signal: string | null; closed_at: string;
}
export interface GoalEffectLease {
  (outcome: GoalEffectReleaseOutcome): Promise<void>;
  prepareManagedProcess(processId: string, commandHash: string): Promise<ManagedProcessEffectLaunch>;
  confirmManagedProcess(launch: ManagedProcessEffectLaunch, hostPid: number): Promise<void>;
  managedProcessConfirmed(): boolean;
}
export interface ManagedProcessEffectLease {
  readonly reference: ProcessEffectReference;
  bindChild(pid: number, startIdentity: string | null): Promise<void>;
  complete(exitCode: number | null, signal: string | null, persistTerminal?: () => Promise<void>): Promise<void>;
  abandon(): Promise<void>;
}
export type GoalEffectReleaseOutcome = "settled" | "uncertain";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function location(workspace: string, goal: string): Promise<string> {
  if (!workspace || !goal || typeof goal !== "string") throw new Error("GOAL_ADMISSION_SCOPE_INVALID");
  // This is the actual project directory used by Goal storage, not a separately
  // normalized workspace key. Realpath unifies aliases of CODEX_HOME.
  const shard = goalStateStore.goalShardDir(workspace);
  await fs.mkdir(shard, { recursive: true });
  const actual = await fs.realpath(shard);
  return path.join(actual, "goal-effect-admission-v1", createHash("sha256").update(goal).digest("hex"));
}
async function readRecords(dir: string, goal: string): Promise<RecordV1[]> {
  let names: string[];
  try { names = await fs.readdir(dir); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const records: RecordV1[] = [];
  for (const name of names) {
    if (!/^((effect)|(transition))-[0-9a-f-]{36}\.json$/i.test(name)) throw new Error("GOAL_ADMISSION_CORRUPT: unexpected admission entry");
    const file = path.join(dir, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("GOAL_ADMISSION_CORRUPT: invalid admission entry");
    let item: RecordV1;
    try { item = JSON.parse(await fs.readFile(file, "utf8")) as RecordV1; }
    catch { throw new Error("GOAL_ADMISSION_CORRUPT: unreadable admission entry"); }
    if (item.version !== 1 || !["effect", "transition"].includes(item.kind) || !uuid.test(item.token) ||
      name !== `${item.kind}-${item.token}.json` || item.goal !== goal ||
      !(typeof item.owner === "string" || item.owner === null) || !Number.isSafeInteger(item.pid) || item.pid <= 0 ||
      typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at)) ||
      !(item.transaction === null || (typeof item.transaction === "string" && uuid.test(item.transaction))) ||
      !(item.revision === null || (Number.isSafeInteger(item.revision) && item.revision > 0)) ||
      (item.kind === "effect" && (item.transaction !== null || item.revision !== null || item.endpoint !== endpointFor(item.token))) ||
      (item.kind === "transition" && item.endpoint !== null) || !validProcessExtensions(item)) {
      throw new Error("GOAL_ADMISSION_CORRUPT: invalid admission record");
    }
    records.push(item);
  }
  if (records.filter(r => r.kind === "transition").length > 1) throw new Error("GOAL_ADMISSION_CORRUPT: multiple transitions");
  return records;
}
async function publish(dir: string, record: RecordV1): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const handle = await fs.open(path.join(dir, `${record.kind}-${record.token}.json`), "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
}
async function locked<T>(dir: string, action: () => Promise<T>): Promise<T> {
  // Lock file is outside the record directory; never hold it over handlers.
  return withCanonicalFileLock(`${dir}.mutex`, action);
}
function endpointFor(token: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\wh-effect-${token}` : path.join(os.tmpdir(), `wh-effect-${token}.sock`);
}
function record(kind: Kind, goal: string, owner: string | undefined, transaction: string | null, revision: number | null): RecordV1 {
  const token = randomUUID();
  return { version: 1, kind, token, goal, owner: owner ?? null, pid: process.pid,
    created_at: new Date().toISOString(), transaction, revision, endpoint: kind === "effect" ? endpointFor(token) : null };
}
// A PID alone cannot distinguish a restarted owner or PID reuse. A live effect
// must answer its random-token challenge; a vanished/unresponsive endpoint is
// uncertain and blocks all new effect dispatch on the same Goal.
async function servesEffect(item: RecordV1): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(item.endpoint!);
    let data = "", finished = false;
    const done = (answer: boolean) => { if (!finished) { finished = true; socket.destroy(); resolve(answer); } };
    socket.setTimeout(500, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write(item.token));
    socket.on("data", chunk => { data += chunk.toString(); if (data.length >= item.token.length) done(data === item.token); });
    socket.on("end", () => done(false));
  });
}
async function openEffectEndpoint(item: RecordV1): Promise<() => Promise<void>> {
  const server = net.createServer(socket => {
    socket.setTimeout(1000, () => socket.destroy());
    socket.once("error", () => socket.destroy());
    socket.once("data", value => { if (value.toString() === item.token) socket.end(item.token); else socket.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(item.endpoint!, () => { server.removeListener("error", reject); resolve(); }); });
  server.unref();
  return async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (process.platform !== "win32") await fs.unlink(item.endpoint!).catch(e => { if (e.code !== "ENOENT") throw e; }); };
}
async function remove(dir: string, item: RecordV1): Promise<void> {
  const all = await readRecords(dir, item.goal);
  const found = all.find(r => r.token === item.token && r.kind === item.kind);
  if (!found || JSON.stringify(found) !== JSON.stringify(item)) throw new Error("GOAL_ADMISSION_RELEASE_CONFLICT");
  await fs.unlink(path.join(dir, `${item.kind}-${item.token}.json`));
}
export async function inspectGoalAdmission(workspace: string, goal: string): Promise<ReadonlyArray<Readonly<RecordV1>>> {
  const dir = await location(workspace, goal);
  return locked(dir, () => readRecords(dir, goal));
}
export async function enterGoalEffect(workspace: string, goal: string, owner?: string): Promise<GoalEffectLease> {
  const dir = await location(workspace, goal);
  let item = record("effect", goal, owner, null, null);
  const closeEndpoint = await openEffectEndpoint(item);
  try {
    await locked(dir, async () => {
      await reconcileManagedRecordsLocked(dir, goal);
      const all = await readRecords(dir, goal);
      if (all.some(r => r.kind === "transition")) throw new Error("GOAL_CREATION_PENDING: Goal replacement is in progress.");
      for (const existing of all) if (!(await servesEffect(existing))) {
        throw new Error("GOAL_EFFECT_RECONCILIATION_REQUIRED: a prior effect is unresolved; do not replay it.");
      }
      await publish(dir, item);
    });
  } catch (error) { await closeEndpoint(); throw error; }
  let released = false, confirmed = false;
  const release = (async (outcome: GoalEffectReleaseOutcome) => {
    if (released) return;
    if (outcome === "settled") await locked(dir, () => remove(dir, item));
    await closeEndpoint();
    released = true;
  }) as GoalEffectLease;
  release.prepareManagedProcess = async (processId, commandHash) => {
    if (released || item.prepared_process || !validProcessId(processId) || !hex.test(commandHash)) {
      throw new Error("GOAL_PROCESS_EFFECT_PREPARE_CONFLICT");
    }
    const receiptKey = randomBytes(32).toString("hex");
    const prepared: PreparedProcessEffect = { version: 1, effect_token: randomUUID(), process_id: processId,
      launch_id: randomUUID(), command_hash: commandHash, receipt_key_hash: digest(receiptKey) };
    await locked(dir, async () => {
      if (released || item.prepared_process) throw new Error("GOAL_PROCESS_EFFECT_PREPARE_CONFLICT");
      const next = { ...item, prepared_process: prepared };
      await replaceRecord(dir, item, next);
      item = next; // Keep the original release closure's exact-CAS snapshot current.
    });
    return Object.freeze({ ...prepared, workspace_root: workspace, goal_id: goal,
      owner_session_id: owner ?? null, parent_effect_token: item.token, receipt_key: receiptKey });
  };
  release.confirmManagedProcess = async (launch, hostPid) => {
    if (released || !samePrepared(item.prepared_process, launch) || launch.parent_effect_token !== item.token ||
        launch.goal_id !== goal || launch.owner_session_id !== (owner ?? null) || !validPid(hostPid)) {
      throw new Error("GOAL_PROCESS_EFFECT_HANDOFF_MISMATCH");
    }
    await locked(dir, async () => {
      const all = await readRecords(dir, goal);
      const parent = all.find(r => r.token === item.token);
      if (!parent || JSON.stringify(parent) !== JSON.stringify(item)) throw new Error("GOAL_PROCESS_EFFECT_HANDOFF_MISMATCH");
      const child = all.find(r => r.token === launch.effect_token);
      if (child) {
        if (!managedMatchesLaunch(child, launch) || child.pid !== hostPid || !child.managed_process?.child_pid) {
          throw new Error("GOAL_PROCESS_EFFECT_HANDOFF_MISMATCH");
        }
        if (!(await servesEffect(child)) && !(await terminalForRecord(dir, child))) {
          throw new Error("GOAL_PROCESS_EFFECT_HANDOFF_UNCERTAIN");
        }
      } else {
        const receipt = await readTerminal(dir, launch.effect_token);
        if (!receiptMatchesLaunch(receipt, launch) || receipt!.host_pid !== hostPid) {
          throw new Error("GOAL_PROCESS_EFFECT_HANDOFF_UNCERTAIN");
        }
      }
      confirmed = true;
    });
  };
  release.managedProcessConfirmed = () => confirmed;
  return release;
}

const hex = /^[a-f0-9]{64}$/i;
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const validProcessId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9_-]{1,128}$/i.test(value);
const validIdentity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const nullableIdentity = (value: unknown): boolean => value === null || validIdentity(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function validPrepared(value: unknown): value is PreparedProcessEffect {
  const p = value as PreparedProcessEffect | undefined;
  return !!p && p.version === 1 && uuid.test(p.effect_token) && validProcessId(p.process_id) &&
    uuid.test(p.launch_id) && hex.test(p.command_hash) && hex.test(p.receipt_key_hash);
}
function validProcessExtensions(item: RecordV1): boolean {
  const p = item.prepared_process, m = item.managed_process;
  if (p === undefined && m === undefined) return true; // Legacy records retain their conservative behavior.
  if (item.kind !== "effect" || (p !== undefined && m !== undefined)) return false;
  if (p !== undefined) return validPrepared(p) && p.effect_token !== item.token;
  return validPrepared(m) && m.effect_token === item.token && uuid.test(m.parent_effect_token) &&
    m.parent_effect_token !== item.token && validIdentity(m.host_start_identity) &&
    (m.child_pid === null || validPid(m.child_pid)) && nullableIdentity(m.child_start_identity) &&
    (m.child_pid !== null || m.child_start_identity === null);
}
function samePrepared(a: PreparedProcessEffect | undefined, b: PreparedProcessEffect): boolean {
  return !!a && a.version === b.version && a.effect_token === b.effect_token && a.process_id === b.process_id &&
    a.launch_id === b.launch_id && a.command_hash === b.command_hash && a.receipt_key_hash === b.receipt_key_hash;
}
async function replaceRecord(dir: string, previous: RecordV1, next: RecordV1): Promise<void> {
  const file = path.join(dir, previous.kind + "-" + previous.token + ".json");
  const raw = await fs.readFile(file, "utf8");
  if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(previous)) throw new Error("GOAL_ADMISSION_RELEASE_CONFLICT");
  await writeTextFileCas(file, JSON.stringify(next) + "\n", { expectedSha256: digest(raw) });
}
function terminalDirectory(dir: string): string {
  return path.join(path.dirname(path.dirname(dir)), "goal-effect-terminals-v1", path.basename(dir));
}
async function terminalPath(dir: string, token: string, create: boolean): Promise<string> {
  if (!uuid.test(token)) throw new Error("GOAL_PROCESS_EFFECT_BINDING_INVALID");
  const directory = terminalDirectory(dir), root = path.dirname(directory);
  if (create) await fs.mkdir(directory, { recursive: true });
  for (const folder of [root, directory]) {
    const stat = await fs.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("GOAL_PROCESS_EFFECT_RECEIPT_INVALID");
  }
  return path.join(directory, token + ".json");
}
async function readTerminal(dir: string, token: string): Promise<TerminalReceipt | null> {
  try {
    const file = await terminalPath(dir, token, false);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) return null;
    const r = JSON.parse(await fs.readFile(file, "utf8")) as TerminalReceipt;
    if (r.version !== 1 || r.kind !== "managed_process_terminal" || r.effect_token !== token ||
        !uuid.test(r.parent_effect_token) || !uuid.test(r.launch_id) || !validProcessId(r.process_id) ||
        typeof r.goal_id !== "string" || !(r.owner_session_id === null || typeof r.owner_session_id === "string") ||
        !hex.test(r.command_hash) || !hex.test(r.receipt_key) || !validPid(r.host_pid) ||
        !validIdentity(r.host_start_identity) || !validPid(r.child_pid) || !nullableIdentity(r.child_start_identity) ||
        !(r.exit_code === null || Number.isSafeInteger(r.exit_code)) ||
        !(r.signal === null || (typeof r.signal === "string" && /^[A-Z0-9]+$/.test(r.signal))) ||
        (r.exit_code === null && !r.signal) || !Number.isFinite(Date.parse(r.closed_at))) return null;
    return r;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    if (error instanceof Error && error.message === "GOAL_PROCESS_EFFECT_RECEIPT_INVALID") return null;
    throw error;
  }
}
function receiptMatchesLaunch(r: TerminalReceipt | null, launch: Omit<ManagedProcessEffectLaunch, "receipt_key" | "workspace_root">): boolean {
  return !!r && r.goal_id === launch.goal_id && r.owner_session_id === launch.owner_session_id &&
    r.effect_token === launch.effect_token && r.parent_effect_token === launch.parent_effect_token &&
    r.process_id === launch.process_id && r.launch_id === launch.launch_id && r.command_hash === launch.command_hash &&
    digest(r.receipt_key) === launch.receipt_key_hash;
}
function managedMatchesLaunch(item: RecordV1, launch: ManagedProcessEffectLaunch): boolean {
  return item.kind === "effect" && item.goal === launch.goal_id && item.owner === launch.owner_session_id &&
    samePrepared(item.managed_process, launch) && item.managed_process?.parent_effect_token === launch.parent_effect_token;
}
async function terminalForRecord(dir: string, item: RecordV1): Promise<TerminalReceipt | null> {
  const m = item.managed_process;
  if (!m || !m.child_pid) return null; // A missing child binding is not proof that spawn never occurred.
  const r = await readTerminal(dir, item.token);
  if (!receiptMatchesLaunch(r, { ...m, goal_id: item.goal, owner_session_id: item.owner }) ||
      r!.host_pid !== item.pid || r!.host_start_identity !== m.host_start_identity ||
      r!.child_pid !== m.child_pid || r!.child_start_identity !== m.child_start_identity) return null;
  return r;
}
/** Caller holds admission mutex. Only this new native protocol is eligible for automatic settlement. */
async function reconcileManagedRecordsLocked(dir: string, goal: string, token?: string, owner?: string | null): Promise<void> {
  for (const item of await readRecords(dir, goal)) {
    if (item.managed_process && (!token || item.token === token) && (owner === undefined || item.owner === owner) &&
        await terminalForRecord(dir, item)) await remove(dir, item);
  }
}
export async function reconcileManagedProcessEffect(workspace: string, goal: string, owner: string | null, token: string): Promise<void> {
  const dir = await location(workspace, goal);
  await locked(dir, () => reconcileManagedRecordsLocked(dir, goal, token, owner));
}
/** Claim before spawning. The prepared parent and retained terminal receipt prevent duplicate launch. */
export async function claimManagedProcessEffect(launch: ManagedProcessEffectLaunch, hostIdentity: string): Promise<ManagedProcessEffectLease> {
  if (!validPrepared(launch) || !uuid.test(launch.parent_effect_token) || !hex.test(launch.receipt_key) ||
      digest(launch.receipt_key) !== launch.receipt_key_hash || !validIdentity(hostIdentity)) {
    throw new Error("GOAL_PROCESS_EFFECT_BINDING_INVALID");
  }
  const dir = await location(launch.workspace_root, launch.goal_id);
  let item: RecordV1 = { ...record("effect", launch.goal_id, launch.owner_session_id ?? undefined, null, null),
    token: launch.effect_token, endpoint: endpointFor(launch.effect_token),
    managed_process: { version: 1, effect_token: launch.effect_token, process_id: launch.process_id,
      launch_id: launch.launch_id, command_hash: launch.command_hash, receipt_key_hash: launch.receipt_key_hash,
      parent_effect_token: launch.parent_effect_token, host_start_identity: hostIdentity, child_pid: null, child_start_identity: null } };
  let closeEndpoint: (() => Promise<void>) | undefined;
  try {
    await locked(dir, async () => {
      const all = await readRecords(dir, launch.goal_id);
      const parent = all.find(r => r.token === launch.parent_effect_token && r.kind === "effect");
      if (!parent || parent.owner !== launch.owner_session_id || !samePrepared(parent.prepared_process, launch) ||
          all.some(r => r.kind === "transition" || r.token === launch.effect_token) || !(await servesEffect(parent))) {
        throw new Error("GOAL_PROCESS_EFFECT_CLAIM_CONFLICT");
      }
      // Even a malformed tombstone must block replay; only a never-used path may be claimed.
      try { await fs.lstat(await terminalPath(dir, launch.effect_token, false)); throw new Error("GOAL_PROCESS_EFFECT_ALREADY_FINISHED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // Never resurrect the challenge endpoint of an existing uncertain token,
      // even briefly while another admission is waiting for this mutex.
      closeEndpoint = await openEffectEndpoint(item);
      await publish(dir, item);
    });
  } catch (error) { await closeEndpoint?.(); throw error; }
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await closeEndpoint?.(); } };
  return {
    reference: Object.freeze({ effect_token: launch.effect_token, parent_effect_token: launch.parent_effect_token, launch_id: launch.launch_id }),
    async bindChild(pid, identity) {
      if (closed || !validPid(pid) || !nullableIdentity(identity) || item.managed_process!.child_pid !== null) {
        throw new Error("GOAL_PROCESS_EFFECT_CHILD_CONFLICT");
      }
      await locked(dir, async () => {
        if (closed || item.managed_process!.child_pid !== null) throw new Error("GOAL_PROCESS_EFFECT_CHILD_CONFLICT");
        const next = { ...item, managed_process: { ...item.managed_process!, child_pid: pid, child_start_identity: identity } };
        await replaceRecord(dir, item, next);
        item = next;
      });
    },
    async complete(exitCode, signal, persistTerminal) {
      const m = item.managed_process!;
      if (!m.child_pid || !(exitCode === null || Number.isSafeInteger(exitCode)) ||
          !(signal === null || /^[A-Z0-9]+$/.test(signal)) || (exitCode === null && !signal)) {
        throw new Error("GOAL_PROCESS_EFFECT_TERMINAL_UNCERTAIN");
      }
      const receipt: TerminalReceipt = { version: 1, kind: "managed_process_terminal", goal_id: item.goal,
        owner_session_id: item.owner, effect_token: item.token, parent_effect_token: m.parent_effect_token,
        process_id: m.process_id, launch_id: m.launch_id, command_hash: m.command_hash, receipt_key: launch.receipt_key,
        host_pid: item.pid, host_start_identity: m.host_start_identity, child_pid: m.child_pid,
        child_start_identity: m.child_start_identity, exit_code: exitCode, signal, closed_at: new Date().toISOString() };
      await locked(dir, async () => {
        const existing = await readTerminal(dir, item.token);
        if (!existing) {
          // Publish displayed terminal state inside the same short admission fence.
          // A status observer cannot race ahead of the authoritative receipt commit.
          await persistTerminal?.();
          await writeTextFileCas(await terminalPath(dir, item.token, true), JSON.stringify(receipt) + "\n", { createOnly: true });
        }
        const terminal = await terminalForRecord(dir, item);
        if (!terminal || terminal.exit_code !== exitCode || terminal.signal !== signal) throw new Error("GOAL_PROCESS_EFFECT_RECEIPT_CONFLICT");
        const found = (await readRecords(dir, item.goal)).find(r => r.token === item.token);
        if (found) await remove(dir, item);
        // Missing is idempotent only after the same exact-bound terminal proof was validated.
      });
      await close();
    },
    abandon: close,
  };
}

/** Caller holds the existing cross-process Goal definition fence. Recovery of a
 * journaled transition requires exact transaction identity; pre-journal recovery
 * additionally requires a fresh unchanged Goal snapshot and absent journal. */
export async function enterGoalReplacement(_workspace: string, _goal: string, _owner: string | undefined,
  _options: { transaction?: string; revision?: number; preJournalUnchanged?: boolean } = {}): Promise<() => Promise<void>> {
  // Preserve effect receipts for inspection; definition locking is independent.
  return async () => {};
}
