import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpRoot = path.join(root, ".tool-test-tmp", "repeat-guard");
process.env.CHATGPT_TOOL_PROFILE = "slim";

await fs.rm(tmpRoot, { recursive: true, force: true });
await fs.mkdir(tmpRoot, { recursive: true });

const {
  repeatGuardReminder,
  appendRepeatGuardReminderToResult,
  recordRepeatGuardFailure,
} = await import("../dist/lib/repeat-guard.js");

let scenario = 0;
function freshWorkspace() {
  scenario += 1;
  return path.join(tmpRoot, `ws-${scenario}`);
}

try {
  // A: reminders fire exactly at thresholds [3, 5, 8] for identical calls.
  const wsA = freshWorkspace();
  const fired = [];
  for (let index = 0; index < 8; index++) {
    const reminder = repeatGuardReminder(wsA, "read_text_file", { path: "src/app.ts", offset: 1 });
    if (reminder) fired.push({ call: index + 1, reminder });
  }
  assert.deepEqual(fired.map((item) => item.call), [3, 5, 8], "reminder thresholds must be exactly 3/5/8");
  assert.ok(fired[0].reminder.startsWith("GUARD: You are repeating the exact same tool call"), "threshold 3 must be the gentle reminder");
  assert.ok(fired[1].reminder.includes('"read_text_file"') && fired[1].reminder.includes("5 consecutive"), "threshold 5 must be detailed");

  // B: different arguments reset the chain; different tool resets too.
  const wsB = freshWorkspace();
  for (let index = 0; index < 2; index++) repeatGuardReminder(wsB, "grep", { pattern: "todo" });
  assert.equal(repeatGuardReminder(wsB, "grep", { pattern: "other" }), null, "different args must reset the chain");
  assert.equal(repeatGuardReminder(wsB, "grep", { pattern: "other" }), null, "count must restart at 1");
  assert.equal(repeatGuardReminder(wsB, "list_directory", { path: "." }), null, "different tool must reset the chain");

  // C: state tools are excluded — their args repeat legitimately.
  const wsC = freshWorkspace();
  for (let index = 0; index < 6; index++) {
    assert.equal(repeatGuardReminder(wsC, "goal", { action: "status" }), null, "goal must be excluded");
    assert.equal(repeatGuardReminder(wsC, "task_state", { action: "status" }), null, "task_state must be excluded");
  }

  // D: failed calls count — escalation continues across the failure path.
  const wsD = freshWorkspace();
  recordRepeatGuardFailure(wsD, "run_command", { command: "npm test" });
  recordRepeatGuardFailure(wsD, "run_command", { command: "npm test" });
  const atThree = repeatGuardReminder(wsD, "run_command", { command: "npm test" });
  assert.ok(atThree?.startsWith("GUARD: You are repeating"), "failed calls must count toward the threshold");
  assert.equal(repeatGuardReminder(wsD, "run_command", { command: "npm test" }), null, "count 4 stays silent");

  // E: the reminder is appended to a resolved result's content.
  const wsE = freshWorkspace();
  repeatGuardReminder(wsE, "run_command", { command: "flaky" });
  repeatGuardReminder(wsE, "run_command", { command: "flaky" });
  const base = { content: [{ type: "text", text: "base" }], structuredContent: { ok: true, data: {} } };
  const augmented = appendRepeatGuardReminderToResult(wsE, "run_command", { command: "flaky" }, base);
  assert.equal(augmented.content.length, 2, "reminder must append one content entry");
  assert.ok(augmented.content.at(-1).text.includes("GUARD"), "appended text must carry the guard marker");

  // F: oversized arguments hash to a stable key — identical big args still escalate.
  const wsF = freshWorkspace();
  const big = { command: `build ${"x".repeat(12000)}` };
  assert.equal(repeatGuardReminder(wsF, "run_command", big), null);
  assert.equal(repeatGuardReminder(wsF, "run_command", big), null);
  assert.ok(repeatGuardReminder(wsF, "run_command", big)?.startsWith("GUARD:"), "big identical args must escalate via stable key");

  console.log("repeat-guard: thresholds 3/5/8, arg-reset, excluded state tools, failure counting, result append, big-arg hashing OK");
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
