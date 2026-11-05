import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  completeDurableTask,
  checkpointDurableTask,
  createDurableTask,
  durableTaskDir,
  getActiveTaskId,
  getDurableTask,
  listDurableTasks,
  recordToolObservation,
  resolveDurableTask,
  taskHandoff,
  updateDurableTask,
} from "../dist/lib/durable-tasks.js";
const { createRuntimeScope, getRuntimeScope, runWithRuntimeScope } = await import("../dist/lib/runtime-scope.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpHome = path.join(root, ".task-test-home");
const workspace = path.join(root, ".task-test-workspace");
const ownedWorkspace = path.join(root, ".task-test-owned-workspace");

process.env.CODEX_HOME = tmpHome;
await fs.rm(tmpHome, { recursive: true, force: true });
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(ownedWorkspace, { recursive: true });

try {
  const created = await createDurableTask(workspace, {
    goal: "Verify durable task lifecycle",
    current_step: "Run blocking check",
    blocking_checks: [{ name: "tests pass", passed: false }],
    advisory_checks: [{ name: "optional polish", passed: false }],
    artifacts: ["artifact.txt"],
  });
  if (!created.id || created.status !== "active") throw new Error("task_create state invalid");
  if ((await resolveDurableTask(workspace)).id !== created.id) throw new Error("active task pointer missing");

  const checkpointed = await checkpointDurableTask(workspace, created.id, {
    current_step: "Patch implementation",
    done: ["Inspected the failing module"],
    decisions: ["Keep the public API stable"],
    blockers: ["Tests still fail"],
    next_actions: ["Apply focused patch", "Run tests"],
  });
  if (checkpointed.checkpoint_no !== 1 || !checkpointed.done.length) throw new Error("compact checkpoint failed");

  await recordToolObservation(
    workspace,
    "apply_patch",
    { path: path.join(workspace, "src", "app.ts") },
    { structuredContent: { ok: true, summary: "patched app.ts", data: { path: path.join(workspace, "src", "app.ts") } } }
  );
  await recordToolObservation(
    workspace,
    "run_command",
    { command: "npm test" },
    { structuredContent: { ok: false, summary: "exit 1 in fixture", data: { command: "npm test", exit_code: 1 } } }
  );
  const observed = await getDurableTask(workspace, created.id);
  const handoff = taskHandoff(observed);
  if (!handoff.changed_files.some((file) => file.endsWith(path.join("src", "app.ts")))) throw new Error("changed file was not auto-recorded");
  if (handoff.last_failure?.tool !== "run_command") throw new Error("last failure was not auto-recorded");
  if (!handoff.observed_checks.some((check) => check.name === "tests" && !check.passed)) throw new Error("test observation missing");

  const restored = await getDurableTask(workspace, created.id);
  if (restored.goal !== created.goal) throw new Error("task did not persist");

  const updated = await updateDurableTask(workspace, created.id, {
    current_step: "Ready to deliver",
  });
  if (updated.blocking_checks[0]?.passed) throw new Error("failed check changed without evidence");

  const completed = await completeDurableTask(workspace, created.id, "Delivered");
  if (completed.status !== "completed" || !completed.completed_at) throw new Error("task did not complete");
  if (completed.completion_basis?.verification !== "model_declared" || completed.completion_basis.unmet_checks[0]?.passed !== false || completed.blocking_checks[0]?.passed !== false) throw new Error("declaration must preserve the unmet check");
  if (completed.advisory_checks[0]?.passed) throw new Error("advisory check unexpectedly changed");

  const listed = await listDurableTasks(workspace, { status: "completed" });
  if (!listed.some((task) => task.id === created.id)) throw new Error("completed task missing from list");

  // Compatibility regression: controlled resolution may provide the exact
  // owner session outside RuntimeScope, while ambient/default tool paths stay
  // fail-closed for foreign or missing sessions.
  const ownerSession = "explicit-owner-session";
  const ownerScope = createRuntimeScope(
    { workspaceRoot: ownedWorkspace, projectRoots: [ownedWorkspace] },
    { sessionId: ownerSession }
  );
  const owned = await runWithRuntimeScope(ownerScope, () => createDurableTask(ownedWorkspace, {
    goal: "Verify explicit-session durable task resolution",
    current_step: "Resolve without ambient RuntimeScope",
  }));
  if (getRuntimeScope() !== undefined || owned.owner_session !== ownerSession) {
    throw new Error("owned task fixture leaked RuntimeScope or missed owner_session");
  }
  if ((await resolveDurableTask(ownedWorkspace, owned.id, ownerSession)).id !== owned.id) {
    throw new Error("matching explicit session could not resolve an owned task by id");
  }
  if ((await resolveDurableTask(ownedWorkspace, undefined, ownerSession)).id !== owned.id) {
    throw new Error("matching explicit session could not resolve its active owned task");
  }
  const explicitlyListed = await listDurableTasks(ownedWorkspace, { sessionId: ownerSession });
  if (!explicitlyListed.some((task) => task.id === owned.id)) {
    throw new Error("matching explicit session could not list its owned task");
  }

  let foreignRejected = false;
  try {
    await resolveDurableTask(ownedWorkspace, owned.id, "foreign-session");
  } catch (error) {
    foreignRejected = String(error).includes("different ChatGPT window");
  }
  if (!foreignRejected) throw new Error("foreign explicit session resolved an owned task");

  let undefinedRejected = false;
  try {
    await resolveDurableTask(ownedWorkspace, owned.id);
  } catch (error) {
    undefinedRejected = String(error).includes("no current MCP session");
  }
  if (!undefinedRejected) throw new Error("undefined ambient session resolved an owned task");
  if ((await listDurableTasks(ownedWorkspace, { sessionId: "foreign-session" })).some((task) => task.id === owned.id)) {
    throw new Error("foreign explicit session listed an owned task");
  }
  if ((await listDurableTasks(ownedWorkspace)).some((task) => task.id === owned.id)) {
    throw new Error("undefined ambient session listed an owned task");
  }

  const staleWorkspace = path.join(root, ".task-test-stale-workspace");
  const staleDir = durableTaskDir(staleWorkspace);
  await fs.mkdir(staleDir, { recursive: true });
  await fs.writeFile(
    path.join(staleDir, "active-task.json"),
    JSON.stringify({ task_id: "11111111-1111-4111-8111-111111111111", updated_at: "2000-01-01T00:00:00.000Z" }),
    "utf-8"
  );
  if ((await getActiveTaskId(staleWorkspace)) !== null) throw new Error("stale active task pointer was not expired");
  let stalePointerExists = true;
  try {
    await fs.access(path.join(staleDir, "active-task.json"));
  } catch {
    stalePointerExists = false;
  }
  if (stalePointerExists) throw new Error("expired active task pointer file was not removed");

  // Deterministic regression: pause completion on its initial task read, then
  // let a concurrent checkpoint add a failed blocker before completion writes.
  const raceTask = await createDurableTask(workspace, {
    goal: "Verify completion preflight is atomic",
    current_step: "Prepare race",
    blocking_checks: [{ name: "initial check", passed: true }],
  });
  const originalReadFile = fs.readFile;
  let signalReadStarted;
  let releaseRead;
  const readStarted = new Promise((resolve) => { signalReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let intercepted = false;
  fs.readFile = async function (filePath, ...args) {
    if (!intercepted && String(filePath).endsWith(`${raceTask.id}.json`)) {
      intercepted = true;
      const staleContents = await originalReadFile.call(this, filePath, ...args);
      signalReadStarted();
      await readGate;
      return staleContents;
    }
    return originalReadFile.call(this, filePath, ...args);
  };
  try {
    const completing = completeDurableTask(workspace, raceTask.id, "Race completion");
    await Promise.race([
      readStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error("completion task-read barrier timed out")), 2000)),
    ]);
    if (!intercepted) throw new Error("completion task-read barrier was not reached");
    const checkpointing = checkpointDurableTask(workspace, raceTask.id, {
      current_step: "Concurrent checkpoint",
      blocking_checks: [{ name: "concurrent blocker", passed: false, detail: "must prevent completion" }],
    }).then(() => ({ rejected: false }), (error) => ({ rejected: true, error: String(error) }));
    releaseRead();
    await completing;
    const checkpointResult = await checkpointing;
    const raced = await getDurableTask(workspace, raceTask.id);
    const hasConcurrentBlocker = raced.blocking_checks.some((check) => check.name === "concurrent blocker" && !check.passed);
    if (raced.status !== "completed") throw new Error("completion declaration was lost");
    if (checkpointResult.rejected && hasConcurrentBlocker) throw new Error("rejected checkpoint changed the task");
    if (!checkpointResult.rejected && (!hasConcurrentBlocker || !raced.completion_basis.unmet_checks.some(check => check.name === "concurrent blocker"))) throw new Error("accepted concurrent checkpoint was omitted from completion basis");
    console.log("OK durable task completion/checkpoint race is linearizable");
  } finally {
    releaseRead();
    fs.readFile = originalReadFile;
  }

  console.log(`OK durable task ${created.id} lifecycle, explicit-session resolution, ownership isolation, and stale pointer expiry`);
} finally {
  await fs.rm(tmpHome, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(ownedWorkspace, { recursive: true, force: true });
}
