"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { auraUrl, isTrustedIpcSource, installNavigationGuard } = require("../src/ipc-source");
const expected = auraUrl(require("node:path").resolve("fixture", "index.html"));
function fixture() {
  const mainFrame = { url: expected };
  const contents = new EventEmitter();
  Object.assign(contents, { mainFrame, getURL: () => expected, isDestroyed: () => false });
  const window = { webContents: contents, isDestroyed: () => false };
  return { window, contents, event: { sender: contents, senderFrame: mainFrame } };
}
test("only the main frame of the expected window and exact Aura URL is accepted", () => {
  const f = fixture();
  assert.equal(isTrustedIpcSource(f.event, f.window, expected), true);
  assert.equal(isTrustedIpcSource({ ...f.event, sender: {} }, f.window, expected), false);
  assert.equal(isTrustedIpcSource({ ...f.event, senderFrame: { url: expected } }, f.window, expected), false);
  f.event.senderFrame.url = "https://example.org/";
  assert.equal(isTrustedIpcSource(f.event, f.window, expected), false);
  f.event.senderFrame.url = expected;
  for (const view of ["workspace", "skills", "logs", "settings"]) {
    f.event.senderFrame.url = `${expected}&sheet=${view}`;
    f.contents.getURL = () => f.event.senderFrame.url;
    assert.equal(isTrustedIpcSource(f.event, f.window, expected), true);
  }
  f.event.senderFrame.url = `${expected}&sheet=other`;
  assert.equal(isTrustedIpcSource(f.event, f.window, expected), false);
  f.event.senderFrame.url = expected;
  f.contents.getURL = () => expected + "#unexpected";
  assert.equal(isTrustedIpcSource(f.event, f.window, expected), false);
  f.window.isDestroyed = () => true;
  assert.equal(isTrustedIpcSource(f.event, f.window, expected), false);
});
test("all unexpected main-frame, frame and redirect navigation is blocked", () => {
  const f = fixture(); installNavigationGuard(f.contents, expected);
  for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
    for (const [url, blocked] of [[expected, false], [expected + "#unexpected", true], ["https://example.org/", true]]) {
      let prevented = false;
      f.contents.emit(name, { url, preventDefault() { prevented = true; } }, url);
      assert.equal(prevented, blocked);
    }
  }
});
