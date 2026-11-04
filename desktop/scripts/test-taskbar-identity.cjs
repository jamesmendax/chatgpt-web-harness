"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyTaskbarIdentity, resolveTaskbarAppId } = require("../src/taskbar-identity");
const fs = require("node:fs");
const path = require("node:path");
const { profile } = require("../src/app-profile");

test("portable Shell identity is distinct, stable across wrapper moves and idempotent", (t) => {
  const validation = path.resolve(__dirname, "../../.validation");
  fs.mkdirSync(validation, { recursive: true });
  const root = fs.mkdtempSync(path.join(validation, "taskbar-id-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrappers = ["Harness portable.exe", "renamed next release.exe"].map(name => path.join(root, name));
  for (const wrapper of wrappers) fs.writeFileSync(wrapper, "fixture");
  for (const portableExecutable of wrappers) {
    const id = resolveTaskbarAppId(profile.appId, { isPackaged: true, portableExecutable });
    assert.equal(id, `${profile.appId}.portable`);
    assert.equal(resolveTaskbarAppId(id, { isPackaged: true, portableExecutable }), id);
    assert.equal(resolveTaskbarAppId(profile.appId, { isPackaged: false, portableExecutable }), profile.appId);
  }
  for (const portableExecutable of ["", "relative.exe", path.join(root, "missing.exe"), root]) {
    assert.equal(resolveTaskbarAppId(profile.appId, { isPackaged: true, portableExecutable }), profile.appId);
  }
});

test("portable taskbar icon and relaunch use the stable wrapper, not extraction EXE", () => {
  let details;
  applyTaskbarIdentity({ setAppDetails(value) { details = value; } }, {
    appId: profile.appId,
    displayName: profile.displayName,
    platform: "win32",
    execPath: "D:\\fixture\\temporary\\ChatGPT Web Harness Isolated.exe",
    portableExecutable: "D:\\fixture\\便携 release\\Harness portable.exe",
  });
  assert.deepEqual(details, {
    appId: "com.chatgpt-web-harness.isolated",
    appIconPath: "D:\\fixture\\便携 release\\Harness portable.exe",
    appIconIndex: 0,
    relaunchCommand: '"D:\\fixture\\便携 release\\Harness portable.exe"',
    relaunchDisplayName: "ChatGPT Web Harness Isolated",
  });
});

test("installed taskbar identity uses its own executable and unchanged app ID", () => {
  let details;
  applyTaskbarIdentity({ setAppDetails(value) { details = value; } }, {
    appId: profile.appId,
    displayName: profile.displayName,
    platform: "win32",
    execPath: "D:\\fixture\\installed\\Harness.exe",
    portableExecutable: "",
  });
  assert.equal(details.appIconPath, "D:\\fixture\\installed\\Harness.exe");
  assert.equal(details.relaunchCommand, '"D:\\fixture\\installed\\Harness.exe"');
  assert.equal(details.appId, profile.appId);
  assert.equal(details.appIconIndex, 0);
  assert.equal(details.relaunchDisplayName, profile.displayName);
});

test("non-Windows platforms do not call the Windows-only Shell API", () => {
  applyTaskbarIdentity({ setAppDetails() { throw Error("Windows API called"); } }, {
    platform: "linux",
  });
});
