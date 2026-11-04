import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGoalRun as newRun, advanceGoalRun } from "../src/lib/goal-run-state.ts";
import { createGoalRun, readGoalRun, replaceGoalRun } from "../src/lib/goal-run-store.ts";

if (process.argv[2] === "child") {
  const workspace = process.argv[3], id = process.argv[4];
  const snapshot = await readGoalRun(workspace);
  const candidate = advanceGoalRun(snapshot.run, { type: "record_evidence", evidence: { id, kind: "runtime", summary: id, source: "race fixture" } }, { expectedRevision: 1, now: "2026-11-04T00:00:01.000Z" }).run;
  process.send({ type: "ready" });
  await new Promise(resolve => process.once("message", resolve));
  try {
    await replaceGoalRun(workspace, candidate, { expectedRevision: 1, beforeCommit: () => new Promise(resolve => setTimeout(resolve, 200)) });
    process.send({ type: "result", result: "success" });
  } catch (error) { process.send({ type: "result", result: error.code || error.message }); }
  process.disconnect();
} else {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "wh-goalrun-race-"));
  const oldHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(temp, "home");
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    await createGoalRun(workspace, newRun({ runId: "race", objective: "preserve evidence", criteria: [{ id: "verify", description: "verify" }], currentPhase: "test", nextAction: "test", resumeCursor: "test", now: "2026-11-04T00:00:00.000Z" }));
    const script = fileURLToPath(import.meta.url);
    const children = ["left", "right"].map(id => fork(script, ["child", workspace, id], { execArgv: ["--import", "tsx"], env: { ...process.env }, stdio: ["ignore", "inherit", "inherit", "ipc"] }));
    const next = child => new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", code => { if (code) reject(new Error(`child exit ${code}`)); }); });
    await Promise.all(children.map(next));
    const results = children.map(next);
    children.forEach(child => child.send("go"));
    const outcomes = (await Promise.all(results)).map(x => x.result).sort();
    assert.deepEqual(outcomes, ["CAS_CONFLICT", "success"]);
    const persisted = await readGoalRun(workspace);
    assert.equal(persisted.run.revision, 2);
    assert.equal(persisted.run.typedEvidence.length, 1);
    assert.ok(["left", "right"].includes(persisted.run.typedEvidence[0].id));
    console.log("PASS two independent processes: one evidence commit, one CAS conflict");
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    await fs.rm(temp, { recursive: true, force: true });
  }
}
