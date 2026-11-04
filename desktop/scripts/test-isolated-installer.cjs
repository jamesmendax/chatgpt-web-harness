"use strict";
// Pure Node regression: NSIS instructions are interpreted in memory. This file
// never invokes makensis, an installer/uninstaller, a shell, a process query,
// RMDir or any filesystem mutation. Unknown instructions fail the test closed.
// Run: node --test desktop/scripts/test-isolated-installer.cjs
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const desktop = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(desktop, "build/installer.nsh"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(desktop, "package.json"), "utf8"));
const builderConfig = fs.readFileSync(path.join(desktop, "electron-builder.yml"), "utf8");
const product = "ChatGPT Web Harness Isolated";
const packageName = "chatgpt-web-harness-isolated";
const symbol = (name) => "$" + "{" + name + "}";
const defaultDefines = {
  BUILD_UNINSTALLER: "1", APP_ID: "com.chatgpt-web-harness.isolated",
  APP_FILENAME: product, APP_PACKAGE_NAME: packageName,
  APP_EXECUTABLE_FILENAME: product + ".exe",
};
const installDir = "C:\\Fixture Apps\\Isolated";
const appData = "C:\\Fixture User\\AppData\\Roaming";
const payloadPath = path.win32.join(installDir, "resources", "harness");
const legacyData = ["ChatGPT Web Harness", "chatgpt-web-harness-desktop"].map((name) => path.win32.join(appData, name));
const codeLines = (text) => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith(";"));
const expandDefines = (text, defines) => text.replace(/\$\{([^}]+)\}/g, (match, name) =>
  Object.hasOwn(defines, name) ? String(defines[name]) : match);

function precondition(line, defines, macros) {
  let match = /^!if(n?)def (\S+)$/.exec(line);
  if (match) return match[1] ? !Object.hasOwn(defines, match[2]) : Object.hasOwn(defines, match[2]);
  match = /^!ifmacro(n?)def (\S+)$/.exec(line);
  if (match) return match[1] ? !Object.hasOwn(macros, match[2]) : Object.hasOwn(macros, match[2]);
  match = /^!if "([^"]*)" (==|!=) "([^"]*)"$/.exec(expandDefines(line, defines));
  assert.ok(match, "Unsupported compile condition: " + line);
  return match[2] === "==" ? match[1] === match[3] : match[1] !== match[3];
}

function conditions() {
  const stack = [];
  let active = true;
  return {
    get active() { return active; },
    handle(line, evaluate) {
      if (/^!if(?:n?def|macro(?:n)?def)?\b/.test(line)) {
        const value = active && evaluate(line);
        stack.push({ parent: active, value, alternate: false });
        active = value;
        return true;
      }
      if (line === "!else") {
        const last = stack.at(-1);
        assert.ok(last && !last.alternate, "Unbalanced !else");
        last.alternate = true;
        active = last.parent && !last.value;
        return true;
      }
      if (line === "!endif") {
        assert.ok(stack.length, "Unbalanced !endif");
        active = stack.pop().parent;
        return true;
      }
      return false;
    },
    finish() { assert.equal(stack.length, 0, "Unclosed compile condition"); },
  };
}

function macrosFrom(text, defines = defaultDefines) {
  const macros = Object.create(null);
  const lines = codeLines(text);
  const control = conditions();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^!macro (\w+)$/.exec(line);
    if (match) {
      const end = lines.indexOf("!macroend", i + 1);
      assert.ok(end > i, "Unclosed macro " + match[1]);
      if (control.active) {
        assert.ok(!Object.hasOwn(macros, match[1]), "Duplicate macro " + match[1]);
        // Macro-body preprocessor instructions execute when inserted, not here.
        macros[match[1]] = lines.slice(i + 1, end);
      }
      i = end;
    } else if (!control.handle(line, (item) => precondition(item, defines, macros))) {
      assert.fail("Unexpected top-level hook instruction: " + line);
    }
  }
  control.finish();
  return macros;
}

function compile(name, defines = defaultDefines, macros = macrosFrom(source, defines), depth = 0) {
  assert.ok(depth < 12, "Recursive macro expansion");
  assert.ok(Object.hasOwn(macros, name), "Unknown macro: " + name);
  const output = [], control = conditions();
  for (const line of macros[name]) {
    if (control.handle(line, (item) => precondition(item, defines, macros)) || !control.active) continue;
    if (line.startsWith("!error ")) throw new Error("NSIS compile guard: " + line);
    const insert = /^!insertmacro (\w+)$/.exec(line);
    if (insert) output.push(...compile(insert[1], defines, macros, depth + 1));
    else {
      assert.ok(!line.startsWith("!"), "Unsupported preprocessor instruction: " + line);
      output.push(expandDefines(line, defines));
    }
  }
  control.finish();
  return output;
}

const normalized = (value) => path.win32.normalize(value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "")).toLowerCase();
function run(lines, options = {}) {
  const state = {
    silent: false, updated: false, yes: false, processResult: 603,
    ...options,
    vars: { INSTDIR: options.installDir || installDir, APPDATA: appData, R0: "saved-r0", R1: "saved-r1" },
    stack: [], removals: [], messages: [], queries: [], quit: false, errorLevel: 0,
    files: new Set(options.files || []),
  };
  const labels = new Map(lines.flatMap((line, i) => /^\w+:$/.test(line) ? [[line.slice(0, -1), i]] : []));
  const value = (token) => token.replace(/^"|"$/g, "").replace(/\$(INSTDIR|APPDATA|R[01])\b/g, (match, name) => state.vars[name]);
  const jump = (label) => { assert.ok(labels.has(label), "Unknown label " + label); return labels.get(label); };
  const evaluate = (expression) => {
    if (expression === symbol("Silent")) return state.silent;
    if (expression === symbol("isUpdated")) return state.updated;
    const match = /^("[^"]*"|\S+) (==|!=) ("[^"]*"|\S+)$/.exec(expression);
    assert.ok(match, "Unsupported runtime condition: " + expression);
    return match[2] === "==" ? value(match[1]) === value(match[3]) : value(match[1]) !== value(match[3]);
  };
  const branches = [];
  let active = true, steps = 0;
  for (let pc = 0; pc < lines.length; pc++) {
    assert.ok(++steps < 500, "Unbounded hook control flow");
    const line = lines[pc];
    let match = /^\$\{If(Not)?\} (.+)$/.exec(line);
    if (match) {
      const pass = active && (match[1] ? !evaluate(match[2]) : evaluate(match[2]));
      branches.push(active); active = pass; continue;
    }
    if (line === symbol("EndIf")) { assert.ok(branches.length); active = branches.pop(); continue; }
    if (!active || /^\w+:$/.test(line)) continue;
    if ((match = /^IfSilent (\w+)$/.exec(line))) { if (state.silent) pc = jump(match[1]); }
    else if ((match = /^Goto (\w+)$/.exec(line))) pc = jump(match[1]);
    else if ((match = /^Push \$(R[01])$/.exec(line))) state.stack.push(state.vars[match[1]]);
    else if ((match = /^Pop \$(R[01])$/.exec(line))) { assert.ok(state.stack.length); state.vars[match[1]] = state.stack.pop(); }
    else if ((match = /^StrCpy \$(R[01]) ("[^"]*"|\S+)(?: (\d+) (\d+))?$/.exec(line))) {
      const text = value(match[2]);
      state.vars[match[1]] = match[3] ? text.slice(Number(match[4]), Number(match[4]) + Number(match[3])) : text;
    } else if ((match = /^RMDir \/r ("[^"]*")$/.exec(line))) {
      const directory = value(match[1]);
      state.removals.push(directory);
      for (const file of state.files) {
        const relative = path.win32.relative(normalized(directory), normalized(file));
        if (relative === "" || (relative !== ".." && !relative.startsWith("..\\") && !path.win32.isAbsolute(relative))) state.files.delete(file);
      }
    } else if ((match = /^MessageBox (\S+) "([^"]*)"(?: IDYES (\w+))?$/.exec(line))) {
      state.messages.push({ flags: match[1], text: match[2] });
      if (state.yes && match[3]) pc = jump(match[3]);
    } else if ((match = /^\$\{nsProcess::FindProcess\} ("[^"]*") \$(R[01])$/.exec(line))) {
      state.queries.push(value(match[1]));
      state.vars[match[2]] = String(state.processResult);
    } else if ((match = /^SetErrorLevel (\d+)$/.exec(line))) state.errorLevel = Number(match[1]);
    else if (line === "Quit") { state.quit = true; break; }
    else assert.fail("Unexpected or unsafe runtime instruction: " + line);
  }
  assert.equal(state.stack.length, 0, "Hook must preserve the NSIS stack");
  assert.equal(state.vars.R0, "saved-r0");
  assert.equal(state.vars.R1, "saved-r1");
  return state;
}

function executeUninstall(options = {}, defines = defaultDefines) {
  // Same order as the locked template: running check precedes customUnInstall.
  return run([...compile("customCheckAppRunning", defines), ...compile("customUnInstall", defines)], options);
}
function yamlScalar(key) {
  const match = new RegExp("^" + key + ":\\s*(.*?)\\s*$", "m").exec(builderConfig);
  assert.ok(match, "Missing builder setting: " + key);
  return match[1].replace(/^['"]|['"]$/g, "");
}
function nsisScalar(key) {
  const section = builderConfig.split(/^nsis:\s*$/m)[1]?.split(/^\S/m)[0];
  assert.ok(section, "Missing nsis configuration");
  const match = new RegExp("^  " + key + ":\\s*(.*?)\\s*$", "m").exec(section);
  assert.ok(match, "Missing nsis setting: " + key);
  return match[1];
}

// Contract checks inspect source as well as executing the narrow model so an
// added unknown command cannot hide behind a branch that fixtures never take.
test("hook has no shell execution, global image kill or process termination API", () => {
  const code = codeLines(source).join("\n");
  assert.doesNotMatch(code, /\btaskkill\b|\/IM\b|\b(?:Exec|ExecWait|ExecShell)\b|nsExec::|\bStop-Process\b|\b(?:Kill|Close|Terminate)Process\b|System::Call/i);
  assert.ok(macrosFrom(source).customCheckAppRunning);
});

test("runtime model rejects forbidden side effects rather than silently ignoring them", () => {
  assert.throws(() => run(['ExecWait "taskkill /IM tunnel-client.exe"']), /unsafe runtime instruction/);
});

test("builder metadata names only the isolated app, product and package", () => {
  assert.equal(pkg.harnessVariant, "isolated");
  assert.equal(pkg.name, packageName);
  assert.equal(yamlScalar("appId"), defaultDefines.APP_ID);
  assert.equal(yamlScalar("productName"), product);
  assert.equal(nsisScalar("oneClick"), "false");
  assert.equal(nsisScalar("perMachine"), "false");
  assert.equal(nsisScalar("deleteAppDataOnUninstall"), "false");
});

test("data prompt explicitly names only the isolated edition and defaults to Keep", () => {
  const state = executeUninstall();
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0].text, /只会删除当前用户的 ChatGPT Web Harness Isolated（隔离版）数据/);
  assert.match(state.messages[0].text, /原版数据不会删除/);
  assert.match(state.messages[0].flags, /MB_DEFBUTTON2/);
  assert.ok(state.messages[0].text.includes("$\\r$\\n"), "Use NSIS newline escapes");
  assert.deepEqual(state.removals.map(normalized), [normalized(payloadPath)]);
});

for (const silent of [false, true]) {
  test("running or unqueryable isolated processes abort without deletion; silent=" + silent, () => {
    for (const processResult of [0, 601, 602, 604, 611, -1, "unexpected-error"]) {
      const state = executeUninstall({ silent, processResult, yes: true });
      assert.equal(state.quit, true);
      assert.equal(state.errorLevel, 2);
      assert.deepEqual(state.removals, []);
      assert.deepEqual(state.queries, [product + ".exe"]);
      assert.equal(state.messages.length, silent ? 0 : 1);
      if (!silent) assert.match(state.messages[0].text, /先退出.*隔离版.*不会终止任何进程/);
    }
  });
}

test("no running process permits uninstall without attempting to terminate a process", () => {
  const state = executeUninstall({ processResult: 603 });
  assert.equal(state.quit, false);
  assert.equal(state.errorLevel, 0);
  assert.deepEqual(state.queries, [product + ".exe"]);
});

for (const updated of [false, true]) {
  test("standard silent uninstall always keeps data and never prompts; updated=" + updated, () => {
    for (const yes of [false, true]) {
      const state = executeUninstall({ silent: true, updated, yes });
      assert.deepEqual(state.messages, []);
      assert.deepEqual(state.removals.map(normalized), updated ? [] : [normalized(payloadPath)]);
    }
  });
}

test("interactive consent deletes only the isolated AppData basenames", () => {
  for (const filename of [product, packageName]) {
    const defines = { ...defaultDefines, APP_FILENAME: filename, APP_PRODUCT_FILENAME: product };
    const state = executeUninstall({ yes: true }, defines);
    const expectedData = [product, packageName].map((name) => normalized(path.win32.join(appData, name)));
    assert.deepEqual([...new Set(state.removals.map(normalized))].sort(), [...expectedData, normalized(payloadPath)].sort());
    assert.ok(state.removals.every((dir) => !legacyData.map(normalized).includes(normalized(dir))));
  }
});

test("optional builder names may be absent without deleting a fallback or original directory", () => {
  const defines = { ...defaultDefines };
  delete defines.APP_PACKAGE_NAME;
  const state = executeUninstall({ yes: true }, defines);
  assert.deepEqual(state.removals.map(normalized), [normalized(path.win32.join(appData, product)), normalized(payloadPath)]);
});

for (const field of ["APP_FILENAME", "APP_PRODUCT_FILENAME", "APP_PACKAGE_NAME"]) {
  test("compile guards reject old, empty and traversal data names in " + field, () => {
    for (const name of ["ChatGPT Web Harness", "chatgpt-web-harness-desktop", "", "..", "..\\ChatGPT Web Harness", product + "\\..", "C:\\outside"]) {
      assert.throws(() => compile("customUnInstall", { ...defaultDefines, [field]: name }), /NSIS compile guard/, name);
    }
  });
}

test("missing required name, original app ID or original executable fail the build closed", () => {
  const missing = { ...defaultDefines };
  delete missing.APP_FILENAME;
  assert.throws(() => compile("customUnInstall", missing), /NSIS compile guard/);
  assert.throws(() => compile("customUnInstall", { ...defaultDefines, APP_ID: "com.chatgpt-web-harness.desktop" }), /NSIS compile guard/);
  for (const name of ["ChatGPT Web Harness.exe", "tunnel-client.exe", ""]) {
    assert.throws(() => compile("customCheckAppRunning", { ...defaultDefines, APP_EXECUTABLE_FILENAME: name }), /NSIS compile guard/);
  }
});

test("uninstall-only process override does not alter the installer or standalone payload helper", () => {
  const macros = macrosFrom(source, {});
  assert.equal(Object.hasOwn(macros, "customCheckAppRunning"), false);
  const payload = run(compile("harnessRemoveLongPathPayload", {}, macros));
  assert.deepEqual(payload.removals.map(normalized), [normalized(payloadPath)]);
});

test("long-path cleanup targets only INSTDIR/resources/harness across supported path forms", () => {
  for (const directory of [
    "C:\\Fixture Apps\\Isolated", "D:\\Fixture $TEMP\\Isolated",
    "\\\\server\\share\\Isolated", "\\\\?\\C:\\Fixture Apps\\Isolated",
    "\\\\?\\UNC\\server\\share\\Isolated",
  ]) {
    const state = run(compile("harnessRemoveLongPathPayload"), { installDir: directory });
    const expected = directory + "\\resources\\harness";
    assert.deepEqual(state.removals, [directory[1] === ":" ? "\\\\?\\" + expected : expected]);
  }
});

test("payload cleanup preserves install siblings, profiles and original-product sentinel files", () => {
  const deep = path.win32.join(payloadPath, ...Array.from({ length: 9 }, () => "dependency-" + "x".repeat(24)), "fixture.js");
  const keep = [
    path.win32.join(installDir, "keep.txt"), path.win32.join(installDir, "resources", "other", "keep.txt"),
    path.win32.join(appData, packageName, "keep.json"), ...legacyData.map((dir) => path.win32.join(dir, "keep.json")),
    path.win32.join(installDir + "-neighbor", "resources", "harness", "keep.js"),
  ];
  assert.ok(deep.length > 300);
  const state = executeUninstall({ silent: true, files: [deep, ...keep] });
  assert.equal(state.files.has(deep), false);
  assert.deepEqual([...state.files].sort(), keep.sort());
});

test("updated uninstall skips payload cleanup and leaves builder atomic move/restore ownership unchanged", () => {
  const state = executeUninstall({ updated: true, yes: false });
  assert.deepEqual(state.removals, []);
  assert.equal(Object.hasOwn(macrosFrom(source), "customRemoveFiles"), false);
});

const builderLib = path.join(desktop, "node_modules/app-builder-lib");
const templates = path.join(builderLib, "templates/nsis");
const installed = fs.existsSync(path.join(templates, "uninstaller.nsh"));
test("locked builder definitions and hook dispatch cannot reach its image-name kill fallback", { skip: !installed }, () => {
  const installedPkg = JSON.parse(fs.readFileSync(path.join(builderLib, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(desktop, "package-lock.json"), "utf8"));
  assert.equal(installedPkg.version, lock.packages["node_modules/app-builder-lib"].version);
  assert.equal(installedPkg.version, "26.15.3", "Re-audit NSIS flow when changing the locked builder version");
  const helperSource = fs.readFileSync(path.join(builderLib, "out/targets/targetUtil.js"), "utf8");
  const actual = (name) => {
    const match = new RegExp("^function " + name + "\\([^)]*\\) \\{[\\s\\S]*?^\\}", "m").exec(helperSource);
    assert.ok(match, "Missing locked builder helper: " + name);
    return vm.runInNewContext("(" + match[0] + ")");
  };
  assert.equal(actual("getWindowsInstallationDirName")({ productFilename: product, sanitizedName: pkg.name }, true), defaultDefines.APP_FILENAME);
  assert.equal(actual("getWindowsInstallationAppPackageName")(pkg.name), defaultDefines.APP_PACKAGE_NAME);
  const target = fs.readFileSync(path.join(builderLib, "out/targets/nsis/NsisTarget.js"), "utf8");
  assert.match(target, /APP_FILENAME:.*getWindowsInstallationDirName/);
  assert.match(target, /APP_PACKAGE_NAME:.*getWindowsInstallationAppPackageName/);
  assert.match(target, /if \(defines\.APP_FILENAME !== appInfo\.productFilename\)\s*\{\s*defines\.APP_PRODUCT_FILENAME = appInfo\.productFilename;/);
  const common = fs.readFileSync(path.join(templates, "common.nsh"), "utf8");
  assert.ok(common.includes('!define APP_EXECUTABLE_FILENAME "' + symbol("PRODUCT_FILENAME") + '.exe"'));
  const util = fs.readFileSync(path.join(templates, "include/allowOnlyOneInstallerInstance.nsh"), "utf8");
  const wrapper = /^!macro CHECK_APP_RUNNING\r?\n([\s\S]*?)^!macroend/m.exec(util);
  assert.ok(wrapper);
  const macros = macrosFrom(source);
  macros.CHECK_APP_RUNNING = codeLines(wrapper[1]);
  // Do not evaluate the real fallback. Any attempt to select it is a failure.
  const expanded = compile("CHECK_APP_RUNNING", defaultDefines, macros).join("\n");
  assert.ok(expanded.includes(symbol("nsProcess::FindProcess")));
  assert.doesNotMatch(expanded, /taskkill|Stop-Process|KILL_PROCESS|nsExec::/i);
  const uninstaller = fs.readFileSync(path.join(templates, "uninstaller.nsh"), "utf8");
  assert.ok(uninstaller.indexOf("call un.checkAppRunning") < uninstaller.indexOf("!insertmacro customUnInstall"));
  assert.match(uninstaller, /StrCpy \$isDeleteAppData "0"/);
  assert.match(uninstaller, /GetOptions\} \$R0 "--delete-app-data" \$R1/);
  assert.match(uninstaller, /!ifdef DELETE_APP_DATA_ON_UNINSTALL/);
});
