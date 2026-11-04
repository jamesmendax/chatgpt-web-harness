"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ensureNotificationShortcut } = require("../src/notification-identity");

function fixture(t) {
  const validation = path.resolve(__dirname, "../../.validation");
  fs.mkdirSync(validation, { recursive: true });
  const root = fs.mkdtempSync(path.join(validation, "notification-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDataDir = path.join(root, "appdata"), executable = path.join(root, "release", "Harness portable.exe");
  fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, "fixture executable");
  fs.mkdirSync(appDataDir);
  const links = new Map(), writes = [];
  const shell = {
    readShortcutLink(file) { if (!links.has(file)) throw Error("Unreadable fixture shortcut"); return { ...links.get(file) }; },
    writeShortcutLink(file, operation, details) {
      writes.push({ file, operation, details });
      links.set(file, operation === "update" ? { ...links.get(file), ...details } : { ...details });
      fs.writeFileSync(file, "fixture shortcut"); return true;
    },
  };
  const options = { shell, appDataDir, executable, appId: "com.chatgpt-web-harness.isolated.portable", displayName: "ChatGPT Web Harness Isolated", platform: "win32" };
  return { root, options, links, writes, shell, executable, appDataDir };
}

test("creates a per-user portable shortcut with the stable outer executable and matching AppID", t => {
  const f = fixture(t), result = ensureNotificationShortcut(f.options);
  assert.equal(result.created, true); assert.equal(result.updated, false);
  assert.equal(path.basename(result.path), "ChatGPT Web Harness Isolated Portable.lnk");
  assert.equal(result.path, path.join(f.appDataDir, "Microsoft", "Windows", "Start Menu", "Programs", "ChatGPT Web Harness Isolated Portable.lnk"));
  const link = f.links.get(result.path);
  assert.equal(link.target, f.executable); assert.equal(link.appUserModelId, f.options.appId);
  assert.equal(link.icon, f.executable); assert.equal(link.iconIndex, 0); assert.equal(link.cwd, path.dirname(f.executable));
  assert.equal(f.writes[0].operation, "create");
});

test("an already-correct shortcut is idempotent and does not rewrite user fields", t => {
  const f = fixture(t), result = ensureNotificationShortcut(f.options);
  f.links.get(result.path).description = "preserve this";
  const again = ensureNotificationShortcut(f.options);
  assert.equal(again.created, false); assert.equal(again.updated, false);
  assert.equal(f.writes.length, 1); assert.equal(f.links.get(result.path).description, "preserve this");
});

test("updates a same-AppID old-version target without replacing unrelated shortcut fields", t => {
  const f = fixture(t), result = ensureNotificationShortcut(f.options);
  const prior = { ...f.links.get(result.path), target: path.join(f.root, "old.exe"), description: "user description", args: "--preserved", toastActivatorClsid: "fixture-clsid" };
  f.links.set(result.path, prior);
  const updated = ensureNotificationShortcut(f.options);
  assert.equal(updated.updated, true); assert.equal(updated.created, false);
  assert.equal(f.writes.at(-1).operation, "update");
  const link = f.links.get(result.path);
  assert.equal(link.target, f.executable); assert.equal(link.description, prior.description);
  assert.equal(link.args, prior.args); assert.equal(link.toastActivatorClsid, prior.toastActivatorClsid);
});

test("installed and portable notification shortcuts have separate filenames and AppIDs", t => {
  const f = fixture(t), portable = ensureNotificationShortcut(f.options);
  const installed = ensureNotificationShortcut({ ...f.options, appId: "com.chatgpt-web-harness.isolated" });
  assert.notEqual(portable.path, installed.path);
  assert.equal(path.basename(installed.path), "ChatGPT Web Harness Isolated.lnk");
});

test("refuses to overwrite a colliding shortcut owned by a different AppID", t => {
  const f = fixture(t), first = ensureNotificationShortcut(f.options);
  f.links.get(first.path).appUserModelId = "another.application";
  assert.throws(() => ensureNotificationShortcut(f.options), /another|unrelated|different|belongs/i);
  assert.equal(f.writes.length, 1);
});

test("an unreadable existing shortcut is preserved", t => {
  const f = fixture(t), first = ensureNotificationShortcut(f.options);
  f.links.delete(first.path);
  assert.throws(() => ensureNotificationShortcut(f.options), /read|inspect/i);
  assert.equal(f.writes.length, 1);
});

test("write API failure and mismatched readback are surfaced instead of claiming registration", t => {
  const f = fixture(t);
  assert.throws(() => ensureNotificationShortcut({ ...f.options, shell: { ...f.shell, writeShortcutLink: () => false } }), /write|creat|register/i);
  const badShell = { ...f.shell, writeShortcutLink(file, op, details) { f.shell.writeShortcutLink(file, op, { ...details, appUserModelId: "wrong.id" }); return true; } };
  assert.throws(() => ensureNotificationShortcut({ ...f.options, shell: badShell }), /verify|readback|match/i);
});

test("rejects linked ancestors before writing a notification shortcut", t => {
  const f = fixture(t), outside = path.join(f.root, "physical"), linked = path.join(f.root, "linked-appdata");
  fs.mkdirSync(outside); fs.symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => ensureNotificationShortcut({ ...f.options, appDataDir: linked }), /link|junction/i);
  assert.equal(f.writes.length, 0);
});

test("invalid target, appdata, names and AppIDs fail before any Shell write", t => {
  const f = fixture(t);
  for (const overrides of [
    { executable: "relative.exe" }, { executable: path.join(f.root, "missing.exe") }, { executable: f.root },
    { appDataDir: "relative" }, { displayName: "../unrelated" }, { displayName: "bad:name" }, { displayName: "" },
    { appId: "bad/appid" }, { appId: "" },
  ]) assert.throws(() => ensureNotificationShortcut({ ...f.options, ...overrides }));
  assert.equal(f.writes.length, 0);
});

test("non-Windows calls skip registration without touching the filesystem or Shell", () => {
  const result = ensureNotificationShortcut({ platform: "linux", shell: { writeShortcutLink() { throw Error("Unexpected Windows Shell access"); } } });
  assert.equal(result.skipped, true); assert.equal(result.created, false); assert.equal(result.updated, false);
});
