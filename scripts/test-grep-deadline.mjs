import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { RESPONSE_RESERVE_MS } from "../dist/lib/transport-resilience.js";
import { createRuntimeScope, runWithRuntimeScope } from "../dist/lib/runtime-scope.js";
import { grepSearchPage } from "../dist/lib/grep-search.js";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "grep-deadline-"));

function scopedSearch(workspaceRoot, options, { budgetMs = 2_000, signal } = {}) {
  const scope = createRuntimeScope(
    { workspaceRoot, projectRoots: [workspaceRoot], deadlineAt: Date.now() + RESPONSE_RESERVE_MS + budgetMs },
    { signal }
  );
  return runWithRuntimeScope(scope, () => grepSearchPage(options));
}

async function heartbeatFixture() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "grep-heartbeat-"));
  try {
    const target = path.join(fixture, "catastrophic.txt");
    await fs.writeFile(target, "a".repeat(40_000) + "!");
    let ticks = 0;
    const heartbeat = setInterval(() => { ticks += 1; }, 10);
    const started = performance.now();
    const result = await scopedSearch(fixture, {
      path: target,
      pattern: "^(a+)+$",
      headLimit: 1,
    }, { budgetMs: 350 });
    const elapsedMs = Math.round(performance.now() - started);
    clearInterval(heartbeat);
    process.stdout.write(JSON.stringify({
      elapsed_ms: elapsedMs,
      ticks,
      complete: result.complete,
      output: result.output,
      reasons: result.reasons,
    }) + "\n");
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

async function runHeartbeatChild() {
  await heartbeatFixture();
}

async function assertHeartbeatBoundary() {
  let child;
  try {
    child = await execFileAsync(process.execPath, [scriptPath, "--heartbeat-child"], {
      timeout: 3_000,
      windowsHide: true,
      maxBuffer: 1 << 20,
    });
  } catch (error) {
    const detail = error?.killed || error?.signal
      ? "child terminated (" + (error.signal ?? "timeout") + ")"
      : error?.message ?? String(error);
    throw new Error("catastrophic regex blocked the deadline fixture: " + detail);
  }
  const line = child.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, "heartbeat child emitted no JSON result");
  const observed = JSON.parse(line);
  assert.equal(observed.complete, false, "deadline fixture unexpectedly claimed a complete search");
  assert.ok(observed.reasons.includes("time budget"), "missing explicit time budget: " + JSON.stringify(observed));
  assert.ok(observed.ticks >= 3, "main event loop stopped during regex matching: " + JSON.stringify(observed));
  assert.ok(observed.elapsed_ms < 2_000, "deadline overran the bounded child window: " + JSON.stringify(observed));
}

async function assertCancellationIsolation() {
  const slow = path.join(root, "slow.txt");
  const fast = path.join(root, "fast.txt");
  await fs.writeFile(slow, "a".repeat(40_000) + "!");
  await fs.writeFile(fast, "ordinary line\n".repeat(2_000) + "needle\n");
  const controller = new AbortController();
  const cancelled = scopedSearch(root, {
    path: slow,
    pattern: "^(a+)+$",
    headLimit: 1,
  }, { budgetMs: 2_500, signal: controller.signal });
  const unaffected = scopedSearch(root, {
    path: fast,
    pattern: "needle",
    headLimit: 2,
  }, { budgetMs: 2_500 });
  setTimeout(() => controller.abort(), 30);
  const [cancelledResult, unaffectedResult] = await Promise.all([cancelled, unaffected]);
  assert.equal(cancelledResult.complete, false, "cancelled search claimed completion");
  assert.ok(cancelledResult.reasons.includes("cancelled"), "cancel reason missing: " + JSON.stringify(cancelledResult));
  assert.equal(unaffectedResult.complete, true, "a cancelled search poisoned an independent search");
  assert.match(unaffectedResult.output, /needle/, "unaffected search lost its result");
}

async function assertExpiredGrepQueueWorkDoesNotStart() {
  const slowA = path.join(root, "queue-slow-a.txt");
  const slowB = path.join(root, "queue-slow-b.txt");
  const ordinary = path.join(root, "queue-ordinary.txt");
  const catastrophic = "a".repeat(40_000) + "!";
  await fs.writeFile(slowA, catastrophic);
  await fs.writeFile(slowB, catastrophic);
  await fs.writeFile(ordinary, "needle\n");
  const controllerA = new AbortController();
  const controllerB = new AbortController();
  // grepSearchPage admits exactly two workers. Worker construction happens
  // synchronously in the Promise executor, so the third call below is queued
  // before its short deadline can elapse.
  const first = scopedSearch(root, {
    path: slowA, pattern: "^(a+)+$", headLimit: 1,
  }, { budgetMs: 2_500, signal: controllerA.signal });
  const second = scopedSearch(root, {
    path: slowB, pattern: "^(a+)+$", headLimit: 1,
  }, { budgetMs: 2_500, signal: controllerB.signal });
  const queuedInvalid = scopedSearch(root, {
    path: ordinary, pattern: "[", headLimit: 1,
  }, { budgetMs: 75 });
  const queuedResult = await queuedInvalid;
  assert.equal(queuedResult.complete, false, "expired queued grep claimed completion");
  assert.ok(queuedResult.reasons.includes("time budget"), "expired queued grep did not return an explicit time budget");
  assert.doesNotMatch(queuedResult.output, /SyntaxError|Invalid regular expression/, "queued invalid regex started instead of expiring before admission");
  controllerA.abort();
  controllerB.abort();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.ok(firstResult.reasons.includes("cancelled"), "first occupied worker did not observe cancellation");
  assert.ok(secondResult.reasons.includes("cancelled"), "second occupied worker did not observe cancellation");

  const recovered = await scopedSearch(root, {
    path: ordinary, pattern: "needle", headLimit: 2,
  }, { budgetMs: 2_500 });
  assert.equal(recovered.complete, true, "normal grep did not recover after cancelled workers drained");
  assert.match(recovered.output, /needle/, "recovered grep lost its match");
}

if (process.argv.includes("--heartbeat-child")) {
  await runHeartbeatChild();
} else {
  try {
    await assertHeartbeatBoundary();
    await assertCancellationIsolation();
    await assertExpiredGrepQueueWorkDoesNotStart();
    console.log("grep-deadline: heartbeat/deadline, cancellation isolation, and expired queue checks PASS");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
