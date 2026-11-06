// Regressions for the 2026-11-06 takeover review: apply_patch correctness,
// encoding-preserving edits, shell hangs / cd parsing / exit codes, Windows
// argv launching, process control and process ownership after a Goal appears.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dist = path.resolve(process.argv[2] || "dist");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "wh-defect-repairs-"));
process.env.CODEX_HOME = path.join(root, "codex");
process.env.CHECKPOINT_PATH = path.join(root, "checkpoints");
process.env.MCP_SHELL_STATE_DIR = path.join(root, "shell-state");
process.env.AUDIT_LOG_PATH = path.join(root, "audit.log");
const load = file => import(pathToFileURL(path.join(dist, file)).href);
const { applyUnifiedPatchToText, applyMultiFilePatch, isMultiFilePatch, parseMultiFilePatch } = await load("lib/patch.js");
const { decodeText, encodeText, assertWritable } = await load("lib/text-codec.js");
const { applyCwdDirectives, execInShellSession, execArgvInShellSession, initShellSession, getShellStatus, wrapPowerShellCommand } = await load("lib/persistent-shell.js");
const { windowsLaunch, resolveWindowsExecutable } = await load("lib/windows-launch.js");
const { setDefaultCwd } = await load("lib/path-security.js");
const { registerShellTools } = await load("tools/shell.js");
const { registerFilesystemTools } = await load("tools/filesystem.js");
const { runWithRuntimeScope } = await load("lib/runtime-scope.js");
setDefaultCwd(root);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log("OK  " + name); }
  catch (error) { failures.push(name); console.error("FAIL " + name + "\n" + (error?.stack || error)); }
}
const windows = process.platform === "win32";

// ---------------------------------------------------------------- apply_patch
await test("numbered hunk with stale line numbers lands on its real context", () => {
  const file = "l1\nl2\nl3\nl4\nl5\ntarget\nl7\nl8\n";
  // Line numbers are off by three; the old code replaced lines 2-4 instead.
  const out = applyUnifiedPatchToText(file, "@@ -2,3 +2,3 @@\n l5\n-target\n+CHANGED\n l7\n");
  assert.equal(out, "l1\nl2\nl3\nl4\nl5\nCHANGED\nl7\nl8\n");
});
await test("a numbered hunk whose lines are nowhere in the file fails instead of corrupting it", () => {
  assert.throws(() => applyUnifiedPatchToText("a\nb\nc\n", "@@ -2,1 +2,1 @@\n-missing\n+x\n"), /Patch context not found/);
});
await test("zero-length old range inserts after the stated line", () => {
  assert.equal(applyUnifiedPatchToText("a\nb\nc\n", "@@ -2,0 +3,1 @@\n+inserted\n"), "a\nb\ninserted\nc\n");
  assert.equal(applyUnifiedPatchToText("a\nb\n", "@@ -0,0 +1,1 @@\n+first\n"), "first\na\nb\n");
});
await test("later numbered hunks follow the offset found for an earlier one", () => {
  const file = ["x", "x", "head", "one", "two", "mid", "three", "four", "tail"].join("\n") + "\n";
  const patch = "@@ -1,2 +1,2 @@\n head\n-one\n+ONE\n@@ -5,2 +5,2 @@\n mid\n-three\n+THREE\n";
  assert.equal(applyUnifiedPatchToText(file, patch), ["x", "x", "head", "ONE", "two", "mid", "THREE", "four", "tail"].join("\n") + "\n");
});
await test("@@ anchor selects the occurrence after that line", () => {
  const file = "def foo():\n    return 1\n\ndef bar():\n    return 1\n";
  assert.equal(applyUnifiedPatchToText(file, "@@ def bar():\n-    return 1\n+    return 2\n"), "def foo():\n    return 1\n\ndef bar():\n    return 2\n");
});
await test("a Codex chunk may omit its first @@", () => {
  const ops = parseMultiFilePatch("*** Begin Patch\n*** Update File: a.txt\n-old\n+new\n*** End Patch", root);
  assert.equal(applyUnifiedPatchToText("keep\nold\n", ops[0].patch), "keep\nnew\n");
});
await test("removing a SQL '-- comment' line is a single-file hunk, not a file header", () => {
  const patch = "@@\n SELECT 1;\n--- remove me\n SELECT 2;\n";
  assert.equal(isMultiFilePatch(patch), false);
  assert.equal(applyUnifiedPatchToText("SELECT 1;\n-- remove me\nSELECT 2;\n", patch), "SELECT 1;\nSELECT 2;\n");
});
await test("trailing-whitespace differences match, and context keeps the file's own text", () => {
  assert.equal(applyUnifiedPatchToText("a  \nb\nc\n", "@@\n a\n-b\n+B\n c\n"), "a  \nB\nc\n");
});
await test("a patch with no hunks is an error, never a silent success; a context-free addition appends", () => {
  assert.throws(() => applyUnifiedPatchToText("a\n", "not a patch at all"), /No valid patch hunks/);
  assert.throws(() => applyUnifiedPatchToText("a\n", "@@\n"), /No valid patch hunks/);
  // Codex: a first hunk without "@@" and without context adds at the end.
  assert.equal(applyUnifiedPatchToText("a\n", "+only line"), "a\nonly line\n");
});
await test("'$' sequences in added lines are literal", () => {
  assert.equal(applyUnifiedPatchToText("x\n", "@@\n-x\n+echo $'a' $$ $&\n"), "echo $'a' $$ $&\n");
});
await test("Codex Move to renames the file and Add File ends with a newline", async () => {
  const dir = await fs.mkdtemp(path.join(root, "move-"));
  await fs.writeFile(path.join(dir, "old.txt"), "one\ntwo\n");
  const results = await applyMultiFilePatch("*** Begin Patch\n*** Update File: old.txt\n*** Move to: sub/new.txt\n@@\n one\n-two\n+TWO\n*** Add File: added.txt\n+hello\n+world\n*** End Patch", { base_dir: dir });
  assert.ok(results.every(r => r.ok), JSON.stringify(results));
  assert.equal(await fs.readFile(path.join(dir, "sub", "new.txt"), "utf8"), "one\nTWO\n");
  await assert.rejects(fs.stat(path.join(dir, "old.txt")));
  assert.equal(await fs.readFile(path.join(dir, "added.txt"), "utf8"), "hello\nworld\n");
});
await test("unified multi-file diff: /dev/null creates and deletes, paths split only at header pairs", async () => {
  const dir = await fs.mkdtemp(path.join(root, "unified-"));
  await fs.writeFile(path.join(dir, "gone.txt"), "bye\n");
  await fs.writeFile(path.join(dir, "edit.sql"), "SELECT 1;\n-- drop\nSELECT 2;\n");
  const patch = [
    "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+first", "+second",
    "diff --git a/gone.txt b/gone.txt", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "--- a/edit.sql\t2026-11-06 10:00:00", "+++ b/edit.sql", "@@ -1,3 +1,2 @@", " SELECT 1;", "--- drop", " SELECT 2;", "",
  ].join("\n");
  const results = await applyMultiFilePatch(patch, { base_dir: dir });
  assert.deepEqual(results.map(r => [path.basename(r.path), r.operation, r.ok]), [["new.txt", "create", true], ["gone.txt", "delete", true], ["edit.sql", "update", true]]);
  assert.equal(await fs.readFile(path.join(dir, "new.txt"), "utf8"), "first\nsecond\n");
  await assert.rejects(fs.stat(path.join(dir, "gone.txt")));
  assert.equal(await fs.readFile(path.join(dir, "edit.sql"), "utf8"), "SELECT 1;\nSELECT 2;\n");
});

// ------------------------------------------------------------------- encoding
const gbkHello = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0xca, 0xc0, 0xbd, 0xe7, 0x0d, 0x0a]); // 你好,世界\r\n in GBK
await test("GBK text decodes, round-trips byte for byte and rejects characters GBK cannot store", () => {
  const decoded = decodeText(gbkHello);
  assert.deepEqual([decoded.text, decoded.encoding, decoded.lossy], ["你好,世界\r\n", "gbk", false]);
  assert.deepEqual(encodeText(decoded.text, "gbk"), gbkHello);
  assert.throws(() => encodeText("😀", "gbk"), /TEXT_ENCODING_UNREPRESENTABLE/);
});
await test("BOM files keep their BOM and UTF-16 stays UTF-16", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("中文\r\n", "utf16le")]);
  assert.deepEqual([decodeText(utf16).text, decodeText(utf16).encoding], ["中文\r\n", "utf-16le"]);
  assert.deepEqual(encodeText("中文\r\n", "utf-16le"), utf16);
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("x\n")]);
  assert.deepEqual([decodeText(bom).text, decodeText(bom).encoding], ["x\n", "utf-8-bom"]);
  assert.deepEqual(encodeText("x\n", "utf-8-bom"), bom);
  assert.equal(decodeText(Buffer.from("plain ascii")).encoding, "utf-8");
});
await test("bytes valid in no supported encoding are readable but never rewritten", () => {
  const decoded = decodeText(Buffer.from([0x61, 0xff, 0x20, 0x62]));
  assert.equal(decoded.lossy, true);
  assert.throws(() => assertWritable(decoded, "x.bin"), /TEXT_ENCODING_UNKNOWN/);
});

const fsHandlers = new Map();
registerFilesystemTools({ registerTool: (name, _schema, handler) => fsHandlers.set(name, handler) }, root);
const fsCall = (name, args) => fsHandlers.get(name)(args);
await test("read_text_file shows GBK text; edit_file and apply_patch write GBK back", async () => {
  const file = path.join(root, "legacy.bat");
  await fs.writeFile(file, Buffer.concat([Buffer.from("@echo off\r\nrem "), gbkHello]));
  const read = await fsCall("read_text_file", { path: file });
  assert.match(read.structuredContent.data.content, /你好,世界/);
  assert.equal(read.structuredContent.data.encoding, "gbk");
  await fsCall("edit_file", { path: file, old_text: "@echo off", new_text: "@echo on", replace_all: false, dry_run: false });
  await fsCall("apply_patch", { path: file, patch: "@@\n-rem 你好,世界\n+rem 你好,新世界\n", dry_run: false });
  const bytes = await fs.readFile(file);
  assert.equal(decodeText(bytes).encoding, "gbk");
  assert.equal(decodeText(bytes).text, "@echo on\r\nrem 你好,新世界\r\n");
  assert.equal(bytes.includes(Buffer.from([0xef, 0xbf, 0xbd])), false, "no U+FFFD bytes written");
});
await test("edit_file and multi_edit keep '$' replacement sequences literal", async () => {
  const file = path.join(root, "dollar.js");
  await fs.writeFile(file, "const a = X;\nconst b = Y;\n");
  await fsCall("edit_file", { path: file, old_text: "X", new_text: "`$${price}` + $'tail' + $&", replace_all: false, dry_run: false });
  await fsCall("multi_edit", { path: file, edits: [{ old_text: "Y", new_text: "$$", replace_all: false }], dry_run: false });
  assert.equal(await fs.readFile(file, "utf8"), "const a = `$${price}` + $'tail' + $&;\nconst b = $$;\n");
});
await test("a multi-file patch without path writes relative files into the workspace, not the process folder", async () => {
  const name = "wh-relative-" + Date.now() + ".txt";
  const result = await fsCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: " + name + "\n+inside\n*** End Patch", dry_run: false });
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
  assert.equal(await fs.readFile(path.join(root, name), "utf8"), "inside\n");
  if (path.resolve(process.cwd()) !== path.resolve(root)) await assert.rejects(fs.stat(path.join(process.cwd(), name)));
});
await test("a git-style diff addressed to one named file patches that file", async () => {
  const file = path.join(root, "named.txt");
  await fs.writeFile(file, "a\nb\n");
  const result = await fsCall("apply_patch", { path: file, patch: "--- a/some/other/prefix/named.txt\n+++ b/some/other/prefix/named.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n", dry_run: false });
  assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
  assert.equal(await fs.readFile(file, "utf8"), "a\nB\n");
});

// ---------------------------------------------------------------------- shell
await test("cd parsing: literal, quoted, ~, $env:, -Path and /d targets; dynamic ones run unchanged", () => {
  const base = windows ? "C:\\proj" : "/proj";
  const temp = process.env.TEMP || process.env.TMP || os.tmpdir();
  const q = applyCwdDirectives(base, windows ? 'cd "C:\\a;b"; dir' : 'cd "/a;b"; ls');
  assert.equal(q.cwd, path.resolve(windows ? "C:\\a;b" : "/a;b")); assert.equal(q.command, windows ? "dir" : "ls");
  if (windows) {
    assert.equal(applyCwdDirectives(base, "cd $env:TEMP; dir").cwd, path.resolve(temp));
    assert.equal(applyCwdDirectives(base, "cd ~\\Desktop").cwd, path.resolve(os.homedir(), "Desktop"));
    assert.deepEqual(applyCwdDirectives(base, "Set-Location -Path D:\\work; git status"), { cwd: "D:\\work", command: "git status" });
    assert.deepEqual(applyCwdDirectives(base, "cd /d D:\\w && npm test"), { cwd: "D:\\w", command: "npm test" });
  }
  for (const dynamic of ["cd (Get-Location).Path; dir", "cd $project; dir", "cd -", "cd src*; dir", "cdk deploy"]) {
    assert.deepEqual(applyCwdDirectives(base, dynamic), { cwd: base, command: dynamic }, dynamic);
  }
  assert.deepEqual(applyCwdDirectives(base, "cd .. && cd sub; ls"), { cwd: path.resolve(base, "..", "sub"), command: "ls" });
});
await test("a background descendant holding the pipes does not hold run_command", async () => {
  initShellSession(root);
  const script = "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{stdio:'inherit',detached:true}).unref();console.log('parent done')";
  const started = Date.now();
  const result = await execArgvInShellSession(process.execPath, ["-e", script], root, 30_000);
  const elapsed = Date.now() - started;
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /parent done/);
  assert.ok(elapsed < 6_000, "returned after " + elapsed + " ms");
  assert.equal(result.stdio_held_by_descendant, true);
  // The next command must not be queued behind the descendant.
  const next = await execArgvInShellSession(process.execPath, ["-e", "console.log('next')"], root, 30_000);
  assert.match(next.stdout, /next/);
});
if (windows) {
  await test("PowerShell reports the failing native exit code; success still follows the last statement", async () => {
    initShellSession(root);
    assert.equal((await execInShellSession("cmd /c exit 5", root, 30_000)).exit_code, 5);
    assert.equal((await execInShellSession("cmd /c exit 3; Write-Output after", root, 30_000)).exit_code, 0);
    assert.equal((await execInShellSession("Get-Item -LiteralPath 'C:\\definitely\\missing\\wh-nothing'", root, 30_000)).exit_code, 1);
    assert.equal((await execInShellSession("cmd /c exit 0 && cmd /c exit 7", root, 30_000)).exit_code, 7);
    assert.match(wrapPowerShellCommand("dir # comment", "gbk"), /GetEncoding\(936\)[\s\S]*# comment\nif \(-not \$\?\)/);
  });
  await test("output_encoding gbk is applied inside PowerShell, so GBK program output survives", async () => {
    const file = path.join(root, "gbk-out.txt");
    await fs.writeFile(file, gbkHello);
    const result = await execInShellSession(`cmd /c type "${file}"`, root, 30_000, undefined, "gbk");
    assert.match(result.stdout, /你好,世界/);
    assert.equal(result.decode_anomaly, false);
  });
  await test("a deleted saved working folder falls back to the workspace instead of ENOENT forever", async () => {
    const gone = await fs.mkdtemp(path.join(root, "gone-"));
    initShellSession(gone);
    await fs.rm(gone, { recursive: true, force: true });
    const result = await execInShellSession("Write-Output alive", root, 30_000);
    assert.equal(result.exit_code, 0); assert.match(result.stdout, /alive/);
    assert.match(result.stderr, /no longer exists/);
    assert.equal(path.resolve(getShellStatus().cwd), path.resolve(root));
  });
  await test("a cd into a missing folder runs nothing and names the folder, not PowerShell", async () => {
    initShellSession(root);
    const missing = path.join(root, "no-such-folder-wh");
    const result = await execInShellSession(`cd "${missing}"; Write-Output never`, root, 30_000);
    assert.equal(result.operation_started, false);
    assert.match(result.stderr, /does not exist; nothing ran/);
    assert.doesNotMatch(result.stdout, /never/);
    assert.equal(path.resolve(getShellStatus().cwd), path.resolve(root));
  });
  await test("argv mode resolves PATHEXT and runs .cmd shims with arguments intact", async () => {
    const bin = await fs.mkdtemp(path.join(root, "bin dir "));
    const body = `@"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" %*\r\n`;
    const shim = path.join(bin, "echoargs.cmd");
    await fs.writeFile(shim, body);
    // npm's cmd-shims re-parse %*, so their metacharacters are escaped twice.
    const npmShim = path.join(bin, "node_modules", ".bin", "metashim.cmd");
    await fs.mkdir(path.dirname(npmShim), { recursive: true });
    await fs.writeFile(npmShim, body);
    const env = { ...process.env, PATH: bin + ";" + path.dirname(npmShim) + ";" + (process.env.PATH || "") };
    assert.equal(resolveWindowsExecutable("echoargs", env, root)?.toLowerCase(), shim.toLowerCase());
    const { spawnSync } = await import("node:child_process");
    for (const [name, args] of [["echoargs", ["a b", "C:\\dir with space\\", "", "x=1,y=2"]], ["metashim", ["q\"uote", "100%", "&|<>^", "a b", "C:\\trailing\\"]]]) {
      const launch = windowsLaunch(name, args, env, root);
      assert.equal(launch.windowsVerbatimArguments, true);
      const run = spawnSync(launch.file, launch.args, { env, cwd: root, windowsVerbatimArguments: true, encoding: "utf8", windowsHide: true });
      assert.deepEqual(JSON.parse(run.stdout), args, name + ": " + run.stderr);
    }
    const npm = resolveWindowsExecutable("npm", process.env, root);
    if (npm) {
      const result = await execArgvInShellSession("npm", ["--version"], root, 60_000);
      assert.equal(result.exit_code, 0, result.stderr); assert.match(result.stdout, /^\d+\.\d+/);
    }
  });
}

// ------------------------------------------------- volumes, network, skills
await test("new files are created on volumes without hard links (FAT32/exFAT)", async () => {
  const { writeTextFileCas } = await load("lib/safe-text-write.js");
  const nodeFs = (await import("node:fs")).default;
  const link = nodeFs.promises.link;
  nodeFs.promises.link = async () => { throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }); };
  try {
    const target = path.join(root, "fat32-new.txt");
    const result = await writeTextFileCas(target, "hello");
    assert.equal(result.publish_strategy, "copy_create");
    assert.equal(await fs.readFile(target, "utf8"), "hello");
    await assert.rejects(writeTextFileCas(target, "again", { createOnly: true }), /WRITE_CONFLICT/);
    assert.equal(await fs.readFile(target, "utf8"), "hello", "no-clobber still holds");
  } finally { nodeFs.promises.link = link; }
});
await test("DNS-rebinding guard refuses foreign origins, never the tunnel client, extensions or proxied navigations", async () => {
  const { createBrowserRequestGuard } = await load("lib/browser-request-guard.js");
  const guard = createBrowserRequestGuard(origin => origin === "https://chatgpt.com", "test");
  const warn = console.warn; console.warn = () => {};
  const run = headers => {
    let status = 200, passed = false;
    guard({ headers }, { status(code) { status = code; return this; }, json() { return this; } }, () => { passed = true; });
    return passed ? "next" : status;
  };
  try {
    assert.equal(run({ host: "127.0.0.1:3000", "content-type": "application/json" }), "next", "tunnel client / local tools");
    assert.equal(run({ host: "attacker.example:3000", origin: "http://attacker.example:3000" }), 403, "rebound POST");
    assert.equal(run({ host: "attacker.example:3000", origin: "null" }), 403, "rebound POST under Referrer-Policy no-referrer");
    assert.equal(run({ host: "127.0.0.1:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" }), 403, "foreign origin");
    assert.equal(run({ host: "127.0.0.1:3001", origin: "http://127.0.0.1:3001", "sec-fetch-site": "same-origin" }), "next", "admin UI");
    assert.equal(run({ host: "[::1]:3000", origin: "http://[::1]:3000" }), "next", "IPv6 loopback");
    assert.equal(run({ host: "127.0.0.1:3001", origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "sec-fetch-site": "none" }), "next", "browser extension");
    assert.equal(run({ host: "127.0.0.1:3001", "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" }), "next", "OAuth redirect");
    assert.equal(run({ host: "abc.tunnel.example", origin: "https://chatgpt.com", "sec-fetch-site": "cross-site" }), "next", "allow-listed origin through a tunnel");
    assert.equal(run({ host: "abc.tunnel.example", "sec-fetch-site": "none", "sec-fetch-mode": "navigate" }), "next", "navigation through a tunnel");
    process.env.MCP_BROWSER_GUARD = "off";
    assert.equal(run({ host: "attacker.example", origin: "http://attacker.example" }), "next", "explicit opt-out");
  } finally { delete process.env.MCP_BROWSER_GUARD; console.warn = warn; }
});
await test("the real Admin server refuses a rebound page before any route and still serves its own UI origin", async () => {
  const { startAdminServer } = await load("admin/server.js");
  const http = await import("node:http");
  const savedToken = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = "defect-repairs-admin-token";
  const server = startAdminServer({ host: "127.0.0.1", port: 0, mcpPort: 0, pid: process.pid, workspaceRoot: root, sessionCount: () => 0, manager: { listStatuses: async () => [] } });
  const warn = console.warn, log = console.log; console.warn = () => {}; console.log = () => {};
  try {
    if (!server.listening) await new Promise(resolve => server.once("listening", resolve));
    const port = server.address().port;
    const get = headers => new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/health", headers: { "x-admin-token": process.env.ADMIN_TOKEN, ...headers } }, res => {
        let body = ""; res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject); req.end();
    });
    const ui = await get({ origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin" });
    assert.equal(ui.status, 200, ui.body);
    const rebound = await get({ host: `attacker.example:${port}`, origin: `http://attacker.example:${port}` });
    assert.equal(rebound.status, 403); assert.match(rebound.body, /BROWSER_REQUEST_REFUSED/);
    const proxied = await get({ host: "abc.tunnel.example", "sec-fetch-site": "none", "sec-fetch-mode": "navigate" });
    assert.equal(proxied.status, 200, proxied.body);
  } finally {
    console.warn = warn; console.log = log;
    if (savedToken === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = savedToken;
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(() => resolve()));
  }
});
await test("skill IDs fall back to SKILL.md's name for root-level zips and lowercase folder names", async () => {
  const { deriveSkillId } = await load("lib/skill-installer.js");
  const staging = path.join(root, ".staging-extract-0123456789abcdef");
  assert.equal(deriveSkillId(staging, staging, "---\nname: report-writer\ndescription: x\n---\n# Skill\n"), "report-writer");
  const caps = path.join(root, "MySkill");
  assert.equal(deriveSkillId(caps, caps, "---\ndescription: x\n---\n"), "myskill");
  const plain = path.join(root, "already-valid");
  assert.equal(deriveSkillId(plain, plain, "---\nname: other\n---\n"), "already-valid");
});

await test("a catastrophic regex fails its own call within its deadline instead of freezing the server", async () => {
  const { createLineMatcher, replaceWithDeadline } = await load("lib/regex-budget.js");
  const evil = "a".repeat(40) + "b";
  let started = Date.now();
  assert.throws(() => replaceWithDeadline(evil, /^(a+)+$/, "x", 300), /REGEX_TIMEOUT/);
  assert.ok(Date.now() - started < 3000, "replace interrupted after " + (Date.now() - started) + " ms");
  started = Date.now();
  assert.throws(() => createLineMatcher(/^(a+)+$/i)([evil], 300), /REGEX_TIMEOUT/);
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(createLineMatcher(/needle/i)(["hay", "a NEEDLE", "x"], 1000), [1]);
  assert.equal(replaceWithDeadline("foo boo", /o/g, "0", 1000), "f00 b00");
});
await test("expired SSE event-store files and finished process folders are pruned", async () => {
  const { PersistentMcpEventStore } = await load("lib/mcp-event-store.js");
  const { sweepFinishedProcessFolders, processControlPaths } = await load("lib/process-control.js");
  const { createHash } = await import("node:crypto");
  const old = new Date(Date.now() - 9 * 24 * 3600 * 1000);
  // SSE store: an untouched file older than the retention window is deleted by the next store.
  const workspace = await fs.mkdtemp(path.join(root, "sse-"));
  const storeRoot = path.join(process.env.CODEX_HOME, "chatgpt-local-coder", "mcp-sse-events", createHash("sha256").update(path.resolve(workspace)).digest("hex"));
  await fs.mkdir(storeRoot, { recursive: true });
  const stale = path.join(storeRoot, "a".repeat(64) + ".json");
  await fs.writeFile(stale, "{}"); await fs.utimes(stale, old, old);
  new PersistentMcpEventStore({ workspaceRoot: workspace, sessionId: "fresh-session" });
  for (let i = 0; i < 50 && await fs.stat(stale).then(() => true, () => false); i++) await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(fs.stat(stale), "expired event-store file removed");
  // Process folders: finished and old goes; running stays.
  const finished = processControlPaths(workspace, "old-finished"), running = processControlPaths(workspace, "still-running");
  for (const [paths, isRunning] of [[finished, false], [running, true]]) {
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(paths.state, JSON.stringify({ version: 1, id: path.basename(paths.root), running: isRunning }));
    await fs.utimes(paths.state, old, old);
  }
  assert.equal(await sweepFinishedProcessFolders(workspace), 1);
  await assert.rejects(fs.stat(finished.root));
  await fs.stat(running.root);
});

await test("oversized results spill to disk; spills older than a week or beyond the newest 40 are pruned", async () => {
  const { guardToolResult, resilienceDirectory } = await load("lib/transport-resilience.js");
  const workspace = await fs.mkdtemp(path.join(root, "spill-"));
  const dir = path.join(resilienceDirectory(workspace), "results");
  await fs.mkdir(dir, { recursive: true });
  const weekOld = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  for (let i = 0; i < 5; i++) { const file = path.join(dir, `old-${i}.json`); await fs.writeFile(file, "{}"); await fs.utimes(file, weekOld, weekOld); }
  for (let i = 0; i < 45; i++) { const file = path.join(dir, `recent-${i}.json`); const at = new Date(Date.now() - (60 - i) * 1000); await fs.writeFile(file, "{}"); await fs.utimes(file, at, at); }
  const context = { definition: { name: "fixture" }, scope: { invocationId: "spill-fixture", workspaceRoot: workspace } };
  const result = await guardToolResult(context, { content: [{ type: "text", text: "x".repeat(40 * 1024) }] }, { budget: 16 * 1024, stage: "handler" });
  const data = result.structuredContent.data;
  assert.equal(data.spill_saved, true, JSON.stringify(data));
  const names = await fs.readdir(dir);
  assert.equal(names.filter(name => name.startsWith("old-")).length, 0, "spills older than a week are deleted");
  assert.ok(names.length <= 40, "at most 40 spills remain, found " + names.length);
  assert.ok(names.includes(path.basename(data.full_output_path)), "the new spill is kept");
  assert.ok(names.includes("recent-44.json") && !names.includes("recent-0.json"), "the newest spills are the ones kept");
});
await test("the audit log rotates past 20 MiB instead of growing forever", async () => {
  const { audit } = await load("lib/audit.js");
  const file = process.env.AUDIT_LOG_PATH;
  await fs.writeFile(file, Buffer.alloc(21 * 1024 * 1024, 0x20));
  for (let i = 0; i < 64; i++) await audit({ tool: "fixture", action: "rotate", target: root, status: "ok" });
  assert.ok((await fs.stat(file + ".1")).size >= 21 * 1024 * 1024, "the full log moved to .1");
  assert.ok((await fs.stat(file)).size < 1024 * 1024, "a fresh log continues");
});
await test("ChatGPT file names cannot reach NTFS streams, devices or invalid names", async () => {
  const { fallbackFileName } = await load("tools/filesystem.js");
  assert.equal(fallbackFileName({ file_name: "report:v2.txt" }), "report_v2.txt");
  assert.equal(fallbackFileName({ name: 'a<b>c|d?e*"f.txt' }), "a_b_c_d_e__f.txt");
  assert.equal(fallbackFileName({ file_name: "CON.txt" }), "_CON.txt");
  assert.equal(fallbackFileName({ file_name: "notes. " }), "notes");
  assert.equal(fallbackFileName({ file_name: "dir/sub/plan.md" }), "plan.md");
  assert.equal(fallbackFileName({ file_name: "季度报告.xlsx" }), "季度报告.xlsx");
  assert.throws(() => fallbackFileName({ file_name: "::" }), /invalid file name/);
});

await test("a checkpoint of a huge tree stops at its budget and reports a bounded skip list", async () => {
  const { checkpointBeforeDetailed } = await load("lib/checkpoint.js");
  const tree = await fs.mkdtemp(path.join(root, "huge-tree-"));
  for (let i = 0; i < 260; i++) await fs.writeFile(path.join(tree, `f${String(i).padStart(3, "0")}.txt`), "x".repeat(100));
  process.env.CHECKPOINT_MAX_TOTAL_FILES = "40";
  try {
    const attempt = await checkpointBeforeDetailed("delete_directory", [tree]);
    assert.ok(attempt.id, JSON.stringify(attempt));
    assert.equal(attempt.complete, false);
    assert.ok(attempt.skipped.length <= 100);
    assert.match(attempt.skipped.at(-1).reason, /checkpoint budget reached/);
  } finally { delete process.env.CHECKPOINT_MAX_TOTAL_FILES; }
});

await test("browser targets keep file URL query/fragment and accept data:, about: and localhost:port", async () => {
  const { resolveBrowserTarget } = await load("lib/browser-target.js");
  const { pathToFileURL } = await import("node:url");
  const page = path.join(root, "spa.html"); await fs.writeFile(page, "<p>x</p>");
  await fs.writeFile(path.join(root, "index.html"), "<p>i</p>");
  assert.equal((await resolveBrowserTarget(pathToFileURL(page).href + "?debug=1#/settings")).target, pathToFileURL(page).href + "?debug=1#/settings");
  assert.equal((await resolveBrowserTarget("localhost:3000/app")).target, "http://localhost:3000/app");
  assert.equal((await resolveBrowserTarget("about:blank")).target, "about:blank");
  assert.equal((await resolveBrowserTarget("data:text/html,<b>x</b>")).target, "data:text/html,<b>x</b>");
  assert.equal((await resolveBrowserTarget("index.html")).target, pathToFileURL(path.join(root, "index.html")).href, "a bare file name stays a local file");
});

// ---------------------------------------------------------- operation journal
const { executeOperation, listUnresolvedOperationInspections } = await load("lib/operation-journal.js");
const { resilienceDirectory } = await load("lib/transport-resilience.js");
await test("the operation journal prunes old terminal receipts instead of refusing every write", async () => {
  const { createHash } = await import("node:crypto");
  const journalRoot = await fs.mkdtemp(path.join(root, "journal-"));
  const directory = path.join(resilienceDirectory(journalRoot), "operations");
  await fs.mkdir(directory, { recursive: true });
  const digest = value => createHash("sha256").update(value).digest("hex");
  const receipt = (operationId, state, date) => ({ version: 1, operation_id: operationId, identity_sha256: operationId, tool: "fixture",
    tool_sha256: digest("fixture-tool"), args_sha256: digest("fixture-args"), state, created_at: date, accepted_at: date,
    ...(state === "executing" ? { started_at: date, owner_pid: process.pid } : { finished_at: date }), result_redacted: false, result_available: false });
  const write = (id, state, date) => fs.writeFile(path.join(directory, `operation-${id}.json`), JSON.stringify(receipt(id, state, date)) + "\n");
  const unresolved = digest("old-unresolved");
  await write(unresolved, "executing", new Date(0).toISOString());
  const weekOld = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
  const hourOld = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const old = [], recent = [], young = [];
  for (let i = 0; i < 700; i++) { const id = digest("old-" + i); old.push(id); await write(id, "completed", weekOld); }
  for (let i = 0; i < 400; i++) { const id = digest("recent-" + i); recent.push(id); await write(id, i % 2 ? "failed" : "completed", hourOld); }
  for (let i = 0; i < 50; i++) { const id = digest("young-" + i); young.push(id); await write(id, "completed", fresh); }
  process.env.MCP_OPERATION_JOURNAL_MAX_ENTRIES = "1100"; // the old code refused here: 1151 receipts ≥ 1100
  try {
    const value = { content: [{ type: "text", text: "ran" }] };
    const result = await executeOperation({ workspaceRoot: journalRoot, identity: "new-write", tool: "fixture", args: {} }, async () => value);
    assert.deepEqual(result, value, JSON.stringify(result));
  } finally { delete process.env.MCP_OPERATION_JOURNAL_MAX_ENTRIES; }
  const names = new Set(await fs.readdir(directory));
  const has = id => names.has(`operation-${id}.json`);
  assert.ok(has(unresolved), "an unresolved receipt is never pruned");
  assert.ok(young.every(has), "receipts finished within the last hour are kept for retries");
  assert.equal(old.filter(has).length, 0, "receipts finished more than a week ago are pruned");
  const left = [...names].filter(name => /^operation-[0-9a-f]{64}\.json$/.test(name)).length;
  assert.ok(left <= 560, "directory pruned towards its target size, left " + left);
  assert.deepEqual((await listUnresolvedOperationInspections(journalRoot)).map(item => item.operation_id), [unresolved]);
});

// ------------------------------------------------------------ process control
const shellHandlers = new Map();
registerShellTools({ registerTool: (name, _schema, handler) => shellHandlers.set(name, handler) }, root, 20);
const scopeFor = (goalId) => ({ invocationId: "defect-repairs", workspaceRoot: root, projectRoots: [root], mcpSessionId: "same-conversation",
  ...(goalId ? { goalId, goalOwnerSessionId: "same-conversation" } : {}) });
const shellCall = (name, args, scope = scopeFor()) => runWithRuntimeScope(scope, () => shellHandlers.get(name)(args));
await test("start_process reports a launch that never happened as a definite failure", async () => {
  const started = Date.now();
  const result = await shellCall("start_process", { executable: path.join(root, "missing-program.exe"), args: [], output_encoding: "utf-8", working_directory: root });
  const data = result.structuredContent.data;
  assert.equal(result.structuredContent.ok, false);
  assert.equal(data.error_code, "PROCESS_SPAWN_FAILED");
  assert.equal(data.operation_started, false);
  assert.ok(Date.now() - started < 8_000, "took " + (Date.now() - started) + " ms");
});
await test("the conversation keeps control of its process after it creates a Goal; stop works without force", async () => {
  const started = await shellCall("start_process", { executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], output_encoding: "utf-8", working_directory: root });
  const id = started.structuredContent.data.id;
  assert.ok(id, JSON.stringify(started.structuredContent));
  const withGoal = scopeFor("goal-created-later");
  const status = await shellCall("process_status", { id }, withGoal);
  assert.equal(status.structuredContent.data.processes.length, 1, "process visible after a Goal appears");
  const stopped = await shellCall("stop_process", { id, force: false }, withGoal);
  assert.equal(stopped.structuredContent.ok, true, JSON.stringify(stopped.structuredContent));
  for (let i = 0; i < 60; i++) {
    const out = await shellCall("process_output", { id, tail_chars: 1000, output_mode: "full", view: "legacy", max_bytes: 1000 }, withGoal);
    if (!out.structuredContent.data.running) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("a non-forced stop must still stop a windowless process");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch(() => undefined);
process.exit(failures.length ? 1 : 0);
