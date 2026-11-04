"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { createIdleNotifier } = require("../src/idle-notification");

function fixture(options = {}) {
  const notices = [], logs = [], tasks = new Map();
  let serial = 0, beeps = 0, opened = 0;
  class Notice extends EventEmitter {
    static isSupported() { return options.supported !== false; }
    constructor(value) { super(); if (options.constructorThrows) throw Error("native constructor failed"); this.options = value; notices.push(this); }
    show() { if (options.showThrows) throw Error("native show failed"); }
    close() { this.emit("close"); }
  }
  const tray = new EventEmitter();
  tray.isDestroyed = () => options.destroyedTray === true;
  tray.displayBalloon = value => { tray.last = value; if (options.balloonThrows) throw Error("balloon failed"); };
  const notifier = createIdleNotifier({
    Notification: Notice, playReminderSound() { beeps++; if (options.beepThrows) throw Error("audio failed"); return true; },
    getTray: () => options.noTray ? null : tray, iconPath: () => "fixture.ico", showWindow: () => opened++,
    log: (event, detail) => logs.push({ event, detail }), platform: options.platform || "win32",
    setTimeout: fn => { const id = ++serial; tasks.set(id, fn); return id; }, clearTimeout: id => tasks.delete(id),
  });
  const expire = () => { const current = [...tasks.values()]; tasks.clear(); for (const fn of current) fn(); };
  return { notifier, notices, tray, logs, tasks, expire, beeps: () => beeps, opened: () => opened };
}

test("requests one explicit Windows sound and waits for actual native show before acknowledging", async () => {
  const f = fixture(); let settled = false;
  const result = f.notifier.show({ title: "Five minutes", body: "No new tool calls" }).then(v => { settled = true; return v; });
  assert.equal(f.beeps(), 1); assert.equal(f.notices[0].options.silent, true);
  await Promise.resolve(); assert.equal(settled, false);
  f.notices[0].emit("show"); assert.equal(await result, true); assert.equal(f.tasks.size, 0);
  assert.ok(f.logs.some(row => row.event === "native-shown"));
  f.notices[0].emit("click"); assert.equal(f.opened(), 1);
  assert.equal(f.notices[0].listenerCount("close"), 0);
});

test("a retry can request visible delivery without replaying the first alert sound", async () => {
  const f = fixture();
  const result = f.notifier.show({ title: "Retry", body: "Retry delivery only", playSound: false });
  assert.equal(f.beeps(), 0); assert.equal(f.notices[0].options.silent, true);
  f.notices[0].emit("show"); assert.equal(await result, true);
  f.notices[0].emit("close");
});

test("native failure records the reason and only acknowledges a confirmed balloon", async () => {
  const f = fixture(); let settled = false;
  const result = f.notifier.show({ title: "Five minutes", body: "No tools" }).then(v => { settled = true; return v; });
  f.notices[0].emit("failed", {}, "toast identity unavailable");
  assert.equal(f.beeps(), 1); assert.equal(f.tray.last.noSound, true);
  await Promise.resolve(); assert.equal(settled, false);
  assert.ok(f.logs.some(row => row.event === "native-failed" && row.detail.includes("identity unavailable")));
  f.tray.emit("balloon-show"); assert.equal(await result, true);
  assert.equal(f.tray.listenerCount("balloon-show"), 0); assert.equal(f.tasks.size, 0);
});

test("a failed constructor or synchronous show exception uses the same guarded fallback", async () => {
  for (const option of [{ constructorThrows: true }, { showThrows: true }]) {
    const f = fixture(option), result = f.notifier.show({ title: "t", body: "b" });
    assert.ok(f.tray.last); f.tray.emit("balloon-show"); assert.equal(await result, true); assert.equal(f.beeps(), 1);
  }
});

test("unsupported native notifications with no tray fail rather than claiming delivery", async () => {
  const f = fixture({ supported: false, noTray: true });
  assert.equal(await f.notifier.show({ title: "t", body: "b" }), false);
  assert.equal(f.beeps(), 1); assert.equal(f.tasks.size, 0);
  assert.ok(f.logs.some(row => row.event === "delivery-failed"));
});

test("missing native and balloon show events have bounded failure and cleaned listeners", async () => {
  const f = fixture(), result = f.notifier.show({ title: "t", body: "b" });
  f.expire(); assert.ok(f.tray.last); f.expire(); assert.equal(await result, false);
  assert.equal(f.tasks.size, 0); assert.equal(f.notices[0].listenerCount("failed"), 0);
  assert.equal(f.tray.listenerCount("balloon-show"), 0);
});

test("a closed-before-show notification and a throwing fallback fail without hanging", async () => {
  const f = fixture({ balloonThrows: true }), result = f.notifier.show({ title: "t", body: "b" });
  f.notices[0].emit("close"); assert.equal(await result, false); assert.equal(f.tasks.size, 0);
});

test("audio errors do not suppress native delivery and duplicate events do not replay sound", async () => {
  const f = fixture({ beepThrows: true }), result = f.notifier.show({ title: "t", body: "b" });
  f.notices[0].emit("show"); f.notices[0].emit("show"); assert.equal(await result, true);
  assert.equal(f.beeps(), 1); assert.ok(f.logs.some(row => row.event === "sound-failed"));
  f.notices[0].emit("close"); assert.equal(f.tasks.size, 0);
});

test("non-Windows keeps system notification audio without invoking Windows beep", async () => {
  const f = fixture({ platform: "linux" }), result = f.notifier.show({ title: "t", body: "b" });
  assert.equal(f.beeps(), 0); assert.notEqual(f.notices[0].options.silent, true);
  f.notices[0].emit("show"); assert.equal(await result, true); f.notices[0].emit("close");
});

test("dispose settles pending deliveries and releases native and tray listeners", async () => {
  const f = fixture(), native = f.notifier.show({ title: "t", body: "b" });
  f.notifier.dispose(); assert.equal(await native, false); assert.equal(f.tasks.size, 0);
  assert.equal(f.notices[0].listenerCount("failed"), 0);
  const g = fixture({ supported: false }), balloon = g.notifier.show({ title: "t", body: "b" });
  g.notifier.dispose(); assert.equal(await balloon, false); assert.equal(g.tray.listenerCount("balloon-show"), 0);
});

test("concurrent fallback reminders require a separate shown event for each conversation", async () => {
  const f = fixture({ supported: false }); let secondDone = false;
  const first = f.notifier.show({ title: "First conversation", body: "b" });
  const second = f.notifier.show({ title: "Second conversation", body: "b" }).then(value => { secondDone = true; return value; });
  assert.equal(f.tray.last.title, "First conversation");
  f.tray.emit("balloon-show"); assert.equal(await first, true);
  await Promise.resolve(); assert.equal(secondDone, false);
  assert.equal(f.tray.last.title, "Second conversation");
  f.tray.emit("balloon-show"); assert.equal(await second, true);
  assert.equal(f.beeps(), 2); assert.equal(f.tasks.size, 0);
});

test("per-reminder logger preserves account attribution through asynchronous delivery", async () => {
  const f = fixture(), scoped = [];
  const result = f.notifier.show({ title: "t", body: "b", log: (event, detail) => scoped.push({ event, detail }) });
  f.notices[0].emit("show"); assert.equal(await result, true);
  assert.ok(scoped.some(row => row.event === "native-shown")); assert.equal(f.logs.length, 0);
  f.notices[0].emit("close");
});


test("queued balloons receive a full timeout only after reaching display", async () => {
  const f = fixture({ supported: false });
  const first = f.notifier.show({ title: "First", body: "b" });
  let secondDone = false;
  const second = f.notifier.show({ title: "Second", body: "b" }).then(v => { secondDone = true; return v; });
  assert.equal(f.tasks.size, 1);
  f.expire();
  assert.equal(await first, false);
  await Promise.resolve();
  assert.equal(secondDone, false);
  assert.equal(f.tray.last.title, "Second");
  assert.equal(f.tasks.size, 1);
  f.tray.emit("balloon-show");
  assert.equal(await second, true);
  assert.equal(f.tasks.size, 0);
});

test("synchronous balloon acknowledgement clears its timer", async () => {
  const f = fixture({ supported: false });
  f.tray.displayBalloon = () => f.tray.emit("balloon-show");
  assert.equal(await f.notifier.show({ title: "sync", body: "b" }), true);
  assert.equal(f.tasks.size, 0);
});


test("dispose cancels the displayed and queued balloons without starting the queued timer", async () => {
  const f = fixture({ supported: false });
  const first = f.notifier.show({ title: "First", body: "b" });
  const second = f.notifier.show({ title: "Second", body: "b" });
  assert.equal(f.tasks.size, 1);
  f.notifier.dispose();
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(f.tasks.size, 0);
  assert.equal(f.tray.last.title, "First");
});
