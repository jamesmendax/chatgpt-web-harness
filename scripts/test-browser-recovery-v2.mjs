#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { beginBrowserTurnFence, observeBrowserTurnFence } from "../dist/lib/browser-turn-fence.js";
import { browserCheckpointPath, loadBrowserTurnCheckpoint, saveBrowserTurnCheckpoint } from "../dist/lib/browser-turn-checkpoint.js";
import { browserPageTargetId, rebindBrowserPageToTarget } from "../dist/lib/browser-session-rebind.js";
import { findBrowserExecutable } from "../dist/lib/browser-runtime.js";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-browser-recovery-v2-"));
const oldCodeHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(sandbox, "codex-home");
let browser;
try {
  const executablePath = findBrowserExecutable();
  assert.ok(executablePath, "No Chromium/Edge/Chrome executable available for same-tab rebind test");
  browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu", "--no-first-run", "--disable-extensions"] });
  const context = await browser.newContext();
  const original = await context.newPage();
  const other = await context.newPage();
  await original.setContent("<main id='original'>original</main>");
  await other.setContent("<main id='other'>other</main>");
  const originalTarget = await browserPageTargetId(context, original);
  const otherTarget = await browserPageTargetId(context, other);
  assert.notEqual(originalTarget, otherTarget);
  const beforePages = context.pages().length;

  const rebound = await rebindBrowserPageToTarget(context, other, originalTarget);
  assert.equal(rebound.page, original, "rebind must return the exact original target page");
  assert.equal(rebound.rebound, true);
  assert.equal(context.pages().length, beforePages, "same-tab rebind must never create a new page");
  const missing = await rebindBrowserPageToTarget(context, other, "definitely-missing-target");
  assert.equal(missing.page, null);
  assert.equal(context.pages().length, beforePages);

  const baseline = {
    tab_id: originalTarget,
    observed_at_ms: 1000,
    user_turn_count: 1,
    assistant_turn_count: 1,
    generation_active: false,
    tool_inflight_count: 0,
    activity_revision: 0,
    visible_text_hash: "baseline",
  };
  let fence = beginBrowserTurnFence("browser-session-test", baseline, { ambiguity_ms: 5000, stable_ms: 500 });
  const wrongTab = observeBrowserTurnFence(fence, { ...baseline, tab_id: otherTarget, observed_at_ms: 1100 });
  assert.equal(wrongTab.next_action, "rebind_same_tab");
  assert.equal(wrongTab.resubmit_allowed, false, "wrong-tab recovery must never permit blind replay");

  let checkpointPath = await saveBrowserTurnCheckpoint({
    version: 1,
    session_id: fence.session_id,
    target_id: originalTarget,
    phase: "send_activated",
    fence,
    updated_at: new Date().toISOString(),
    terminal: false,
  });
  assert.equal(checkpointPath, browserCheckpointPath(fence.session_id));

  const accepted = observeBrowserTurnFence(fence, {
    ...baseline,
    observed_at_ms: 1200,
    user_turn_count: 2,
    generation_active: true,
    visible_text_hash: "accepted",
  });
  assert.equal(accepted.resubmit_allowed, false);
  assert.equal(accepted.state.accepted, true);
  fence = accepted.state;

  const toolRunning = observeBrowserTurnFence(fence, {
    ...baseline,
    observed_at_ms: 1300,
    user_turn_count: 2,
    generation_active: false,
    tool_inflight_count: 1,
    activity_revision: 1,
    visible_text_hash: "tool-running",
  });
  assert.equal(toolRunning.phase, "running");
  fence = toolRunning.state;

  const candidate = observeBrowserTurnFence(fence, {
    ...baseline,
    observed_at_ms: 1500,
    user_turn_count: 2,
    assistant_turn_count: 2,
    generation_active: false,
    tool_inflight_count: 0,
    activity_revision: 1,
    visible_text_hash: "post-tool-answer",
  });
  assert.equal(candidate.phase, "candidate_complete");
  assert.equal(candidate.resubmit_allowed, false);
  fence = candidate.state;

  const complete = observeBrowserTurnFence(fence, {
    ...baseline,
    observed_at_ms: 2100,
    user_turn_count: 2,
    assistant_turn_count: 2,
    generation_active: false,
    tool_inflight_count: 0,
    activity_revision: 1,
    visible_text_hash: "post-tool-answer",
  });
  assert.equal(complete.phase, "complete");
  assert.equal(complete.state.completed, true);
  assert.equal(complete.resubmit_allowed, false);
  fence = complete.state;

  checkpointPath = await saveBrowserTurnCheckpoint({
    version: 1,
    session_id: fence.session_id,
    target_id: originalTarget,
    phase: "complete",
    fence,
    updated_at: new Date().toISOString(),
    terminal: true,
  });
  const restored = await loadBrowserTurnCheckpoint(fence.session_id);
  assert.equal(restored?.target_id, originalTarget);
  assert.equal(restored?.phase, "complete");
  assert.equal(restored?.terminal, true);
  assert.equal(restored?.fence.completed, true);
  assert.equal(restored?.fence.options.stable_ms, 500);

  const failed = observeBrowserTurnFence(fence, {
    ...baseline, observed_at_ms: 2200, user_turn_count: 2, assistant_turn_count: 2,
    activity_revision: 1, visible_text_hash: "stream-recovery-error", failure_visible: true,
  });
  assert.equal(failed.phase, "delivery_failed");
  await saveBrowserTurnCheckpoint({
    ...restored, fence: failed.state, phase: failed.phase, terminal: false, updated_at: new Date().toISOString(),
  });
  const failedRestore = await loadBrowserTurnCheckpoint(fence.session_id);
  assert.equal(failedRestore?.terminal, false);
  assert.equal(failedRestore?.fence.delivery_failure.failure_visible, true);
  const clearedAfterRestore = observeBrowserTurnFence(failedRestore.fence, {
    ...baseline, observed_at_ms: 2400, user_turn_count: 2, assistant_turn_count: 2,
    activity_revision: 1, visible_text_hash: "banner-disappeared", failure_visible: false,
  });
  assert.equal(clearedAfterRestore.phase, "delivery_failed", "failure latch must survive durable checkpoint restore");
  assert.equal(clearedAfterRestore.state.completed, false);

  const legacyFence = { ...restored.fence };
  delete legacyFence.delivery_failure;
  await saveBrowserTurnCheckpoint({ ...restored, fence: legacyFence });
  const legacyRestore = await loadBrowserTurnCheckpoint(fence.session_id);
  const legacyRead = observeBrowserTurnFence(legacyRestore.fence, {
    ...baseline, observed_at_ms: 2500, user_turn_count: 2, assistant_turn_count: 2,
    activity_revision: 1, visible_text_hash: "post-tool-answer",
  });
  assert.equal(legacyRead.phase, "complete", "old checkpoints remain readable without the optional failure latch");

  await context.close();
  console.log("browser-recovery-v2 PASS: exact target rebind/no replay, completion and failure-latch checkpoint restore, legacy compatibility");
} finally {
  await browser?.close().catch(() => {});
  if (oldCodeHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodeHome;
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
