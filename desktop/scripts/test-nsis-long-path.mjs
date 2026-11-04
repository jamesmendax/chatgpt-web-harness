import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiler = process.env.HARNESS_MAKENSIS;
assert.equal(process.platform, "win32", "NSIS regression requires Windows");
assert.ok(compiler && fs.statSync(compiler).isFile(), "Set HARNESS_MAKENSIS to the build's makensis.exe");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-nsis-path-"));
const quote = (value) => value.replaceAll("$", () => "$$").replaceAll('"', '$\\"');
try {
  const install = path.join(root, "install $TEMP with spaces");
  const runtime = path.join(install, "resources", "harness");
  const deepFile = path.join(runtime, ...Array.from({ length: 8 }, (_, i) => `dependency-${i}-${"x".repeat(24)}`), "fixture.js");
  assert.ok(deepFile.length > 300);
  fs.mkdirSync(path.dirname(deepFile), { recursive: true });
  fs.writeFileSync(deepFile, "module.exports = 1;");
  const keepFile = path.join(install, "keep-unrelated.txt");
  const dataFile = path.join(root, "user-data.txt");
  fs.writeFileSync(keepFile, "keep sibling");
  fs.writeFileSync(dataFile, "keep user data");
  const executable = path.join(root, "remove-runtime.exe");
  const script = path.join(root, "probe.nsi");
  fs.writeFileSync(script, [
    "Unicode true", "RequestExecutionLevel user", "SilentInstall silent",
    '!include "LogicLib.nsh"',
    `!include "${quote(path.join(desktopRoot, "build", "installer.nsh"))}"`,
    `OutFile "${quote(executable)}"`,
    "Section", `StrCpy $INSTDIR "${quote(install)}"`,
    'StrCpy $R0 "register-zero"', 'StrCpy $R1 "register-one"',
    "!insertmacro harnessRemoveLongPathPayload",
    '${If} $R0 != "register-zero"', "SetErrorLevel 3", "${EndIf}",
    '${If} $R1 != "register-one"', "SetErrorLevel 4", "${EndIf}",
    "SectionEnd", "",
  ].join("\n"));
  execFileSync(compiler, ["/V2", script], { windowsHide: true, timeout: 30_000, stdio: "pipe" });
  execFileSync(executable, ["/S"], { cwd: root, windowsHide: true, timeout: 30_000, stdio: "pipe" });
  assert.equal(fs.existsSync(runtime), false, "installer must remove deep runtime files itself");
  assert.equal(fs.readFileSync(keepFile, "utf8"), "keep sibling");
  assert.equal(fs.readFileSync(dataFile, "utf8"), "keep user data");
  console.log(`PASS native NSIS removes ${deepFile.length}-character runtime path and preserves sibling/user data`);
} finally {
  assert.ok(path.basename(root).startsWith("harness-nsis-path-") && path.dirname(root) === path.resolve(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
