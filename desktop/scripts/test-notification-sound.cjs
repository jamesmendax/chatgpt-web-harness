"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { createNotificationSound, validateWav, WAV_PATH, PLAY_SCRIPT } = require("../src/notification-sound");
const { makeChime, SAMPLE_RATE, DURATION_SECONDS } = require("./generate-notification-chime.cjs");
const { createIdleNotifier } = require("../src/idle-notification");
const { IdleWatch, reminderMinutes, IDLE_REMINDER_CHOICES } = require("../src/idle-watch");
const wav = makeChime();

function nativeFixture(error = null, output = "WH_CHIME_PLAYED") {
  const calls = [];
  let callback, killed = 0;
  const player = createNotificationSound({ platform: "win32", readFile: async () => wav,
    execute(exe, args, options, cb) {
      callback = cb;
      const stdin = new PassThrough(); const buffers = [];
      stdin.on("data", b => buffers.push(b));
      const call = { exe, args, options, bytes: () => Buffer.concat(buffers) }; calls.push(call);
      return { stdin, kill() { killed++; setImmediate(() => callback(new Error("cancelled"))); } };
    },
  });
  return { player, calls, finish: () => callback(error, output), killed: () => killed };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("bundled original chime is deterministic non-clipping 1.15-second PCM and included by src/**", () => {
  assert.deepEqual(validateWav(fs.readFileSync(WAV_PATH)), wav);
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
  assert.equal(wav.readUInt32LE(40) / 2 / SAMPLE_RATE, DURATION_SECONDS);
  let peak = 0;
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)));
  assert.ok(peak > 15000 && peak < 20000);
  assert.equal(wav.readInt16LE(44), 0); assert.equal(wav.readInt16LE(wav.length - 2), 0);
  assert.match(fs.readFileSync(require("node:path").join(__dirname, "../electron-builder.yml"), "utf8"), /- src\/\*\*/);
});

test("native player streams exact WAV bytes without dynamic command paths; simultaneous reminders coalesce", async () => {
  const f = nativeFixture();
  const first = f.player.play(), second = f.player.play();
  assert.strictEqual(first, second);
  await flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].bytes(), wav);
  assert.equal(f.calls[0].options.windowsHide, true);
  assert.equal(f.calls[0].options.timeout, 8000);
  assert.equal(Buffer.from(f.calls[0].args.at(-1), "base64").toString("utf16le"), PLAY_SCRIPT);
  assert.doesNotMatch(PLAY_SCRIPT, /SystemSounds|Beep|ExecutionPolicy|SetVolume/);
  f.finish(); assert.equal(await first, true);
  const next = f.player.play(); await flush(); assert.equal(f.calls.length, 2); f.finish(); await next;
});

test("invalid or missing WAV never launches a native playback process", async () => {
  let calls = 0;
  for (const readFile of [async () => Buffer.from("bad"), async () => { throw new Error("missing asset"); }]) {
    const player = createNotificationSound({ platform: "win32", readFile, execute() { calls++; } });
    await assert.rejects(player.play(), /Invalid|missing/);
  }
  assert.equal(calls, 0);
  const bad = Buffer.from(wav); bad.writeUInt32LE(0, 40);
  assert.throws(() => validateWav(bad), /Invalid/);
});

test("native timeout, process failure and absent completion marker are not reported as played", async () => {
  for (const [error, output] of [[new Error("timeout"), ""], [null, ""]]) {
    const f = nativeFixture(error, output), result = f.player.play();
    const rejected = assert.rejects(result, /timeout|acknowledged/);
    await flush(); f.finish(); await rejected;
  }
});

test("dispose cancels only its own player, closes admission and suppresses a pending read", async () => {
  const f = nativeFixture(), result = f.player.play(); const rejected = assert.rejects(result, /cancelled/);
  await flush(); f.player.dispose(); await rejected;
  assert.equal(f.killed(), 1); assert.equal(await f.player.play(), false);
  const g = nativeFixture(), pending = g.player.play(); g.player.dispose();
  assert.equal(await pending, false); assert.equal(g.calls.length, 0);
});

test("non-Windows never attempts to launch Windows PowerShell", async () => {
  const player = createNotificationSound({ platform: "linux", execute() { throw new Error("must not launch"); } });
  assert.equal(await player.play(), false);
});

test("an asynchronous sound failure keeps the visible notification; retries remain silent", async () => {
  const logs = [], notices = []; let sounds = 0;
  class Notice extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; notices.push(this); }
    show() { this.emit("show"); }
  }
  const notifier = createIdleNotifier({ Notification: Notice, platform: "win32",
    playReminderSound() { sounds++; return Promise.reject(new Error("audio blocked")); },
    log: (event, detail) => logs.push({ event, detail }),
  });
  assert.equal(await notifier.show({ title: "t", body: "b" }), true);
  await flush();
  assert.equal(sounds, 1); assert.ok(logs.some(x => x.event === "sound-failed"));
  assert.ok(!logs.some(x => x.event === "sound-played"));
  assert.equal(notices[0].options.silent, true);
  assert.equal(await notifier.show({ title: "retry", body: "b", playSound: false }), true);
  assert.equal(sounds, 1); notifier.dispose();
});

test("10-minute setting triggers only at 600 seconds, once per idle gap, and retains old choices", () => {
  assert.deepEqual(IDLE_REMINDER_CHOICES, [0, 5, 10, 15]);
  for (const value of IDLE_REMINDER_CHOICES) assert.equal(reminderMinutes({ idleReminderMinutes: value }), value);
  assert.equal(reminderMinutes({ idleReminderMinutes: "10" }), 10);
  assert.equal(reminderMinutes({ idleReminderMinutes: 7 }), 5);
  let now = new Date(2026, 10, 3, 14, 0, 0).getTime(); const start = now;
  const watch = new IdleWatch({ now: () => now, minutesFor: () => 10, onRemind: () => true });
  const line = "14:00:00   [MCP] [ok] tools/call grep 12ms session=test conv=1234abcd";
  assert.equal(watch.observe("account", "mcp", line), true);
  now = start + 600000 - 1; assert.deepEqual(watch.tick(), []);
  now++; const fired = watch.tick(); assert.equal(fired.length, 1); assert.equal(fired[0].idleMinutes, 10);
  now += 60000; assert.deepEqual(watch.tick(), []);
});
