import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { setDefaultCwd } from "../src/lib/path-security.js";
import { resolveBrowserTarget } from "../src/lib/browser-target.js";
import { checkpointBeforeDetailed, listCheckpoints, restoreToCheckpoint } from "../src/lib/checkpoint.js";
import { execArgvInShellSession, execInShellSession } from "../src/lib/persistent-shell.js";
import { registerFilesystemTools } from "../src/tools/filesystem.js";
import { chromiumScreenshot } from "../src/tools/visual.js";
import { browserCandidates } from "../src/lib/browser-runtime.js";
import { toolFailureDiagnostic } from "../src/lib/tool-diagnostics.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "wh-v32-tools-"));
process.env.CHECKPOINT_PATH = path.join(root, "checkpoints");
process.env.CHECKPOINT_MAX_FILE_BYTES = "16";
process.env.CODEX_HOME = path.join(root, "codex");
setDefaultCwd(root);
try {
  const special = path.join(root, "中文 # 100%.html");
  await fs.writeFile(special, "<h1>ok</h1>");
  assert.equal((await resolveBrowserTarget(special)).target, pathToFileURL(special).href);
  assert.equal((await resolveBrowserTarget(pathToFileURL(special).href)).label, special);
  const dir = path.join(root, "tree"); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "small"), "before");
  await fs.writeFile(path.join(dir, "large"), "x".repeat(32));
  const cp = await checkpointBeforeDetailed("test", [dir]);
  assert(cp.id && !cp.complete && cp.skipped.some(item => item.path.endsWith("large")));
  assert.equal((await listCheckpoints())[0].complete, false);
  await fs.writeFile(path.join(dir, "small"), "after");
  const restored = await restoreToCheckpoint(cp.id);
  assert.equal(await fs.readFile(path.join(dir, "small"), "utf8"), "before");
  assert(restored.skipped.some(item => item.path.endsWith("large")));
  const legacyRoot = path.join(root, "legacy-store");
  const legacyId = "cp_legacy"; const legacyTarget = path.join(root, "legacy.txt");
  await fs.mkdir(path.join(legacyRoot, "data", legacyId), { recursive: true });
  const legacySummary = { id: legacyId, created_at: new Date().toISOString(), tool: "legacy", summary: "legacy", files: [legacyTarget], file_count: 1 };
  await fs.writeFile(path.join(legacyRoot, "index.json"), JSON.stringify({ version: 1, checkpoints: [legacySummary] }));
  await fs.writeFile(path.join(legacyRoot, "data", legacyId, "manifest.json"), JSON.stringify({ version: 1, ...legacySummary, files: [{ path: legacyTarget, existed: true, encoding: "utf-8", content: "old" }] }));
  process.env.CHECKPOINT_PATH = legacyRoot;
  await restoreToCheckpoint(legacyId); assert.equal(await fs.readFile(legacyTarget, "utf8"), "old");
  process.env.CHECKPOINT_PATH = path.join(root, "checkpoints");
  const overlap = await checkpointBeforeDetailed("overlap", [root]);
  assert.equal(overlap.id, null); assert.equal(overlap.complete, false);
  assert.match(overlap.error ?? "", /overlaps/);
  const concurrentPaths = await Promise.all(Array.from({length: 12}, async (_, i) => {
    const name = path.join(root, `concurrent-${i}.txt`); await fs.writeFile(name, `value-${i}`); return name;
  }));
  const concurrent = await Promise.all(concurrentPaths.map(name => checkpointBeforeDetailed("concurrent", [name])));
  assert(concurrent.every(result => result.id && result.complete));
  const ids = new Set((await listCheckpoints(100)).map(item => item.id));
  assert(concurrent.every(result => ids.has(result.id!)), "concurrent index updates must all survive");
  const argv = ["$foo", "a`b", 'a" b', "中文"];
  const run = await execArgvInShellSession(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...argv], root, 10000);
  assert.equal(run.execution_mode, "argv"); assert.equal(run.exit_code, 0); assert.deepEqual(JSON.parse(run.stdout), argv);
  const fail = await execArgvInShellSession(process.execPath, ["-e", "process.exit(1)"], root, 10000);
  assert.equal(fail.exit_code, 1); assert.equal(fail.timed_out, false);
  const gbk = await execArgvInShellSession(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"], root, 10000, undefined, "gbk");
  assert.equal(gbk.stdout, "中文");
  const cp936 = await execArgvInShellSession(process.execPath, ["-e", "process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))"], root, 10000, undefined, "cp936");
  assert.equal(cp936.stdout, "中文");
  const utf16 = await execArgvInShellSession(process.execPath, ["-e", "process.stdout.write(Buffer.from('中文','utf16le'))"], root, 10000, undefined, "utf-16le");
  assert.equal(utf16.stdout, "中文");
  if (process.platform === "win32") {
    const shell = await execInShellSession("[Console]::Write('中文')", root, 10000);
    assert.equal(shell.execution_mode, "shell"); assert.equal(shell.stdout, "中文");
  }
  const invalid = await execArgvInShellSession(process.execPath, ["-e", "process.stdout.write(Buffer.from([255]))"], root, 10000);
  assert.equal(invalid.decode_anomaly, true); assert(invalid.raw_stdout_path);
  const timed = await execArgvInShellSession(process.execPath, ["-e", "setTimeout(()=>{},5000)"], root, 150);
  assert.equal(timed.timed_out, true);
  const handlers = new Map<string, Function>();
  registerFilesystemTools({ registerTool: (name: string, _schema: unknown, handler: Function) => handlers.set(name, handler) } as any, root);
  const missing = await handlers.get("delete_file")!({ path: path.join(root, "absent") });
  const missingDiagnostic = toolFailureDiagnostic(missing);
  assert.equal(missingDiagnostic?.failure_phase, "validation");
  assert.equal(missingDiagnostic?.failure_step, "target_check");
  assert.equal(missingDiagnostic?.operation_started, false);
  assert.equal(missingDiagnostic?.may_have_partially_completed, false);
  const doomed = path.join(root, "delete-me"); await fs.writeFile(doomed, "delete");
  const checkpointRoot = process.env.CHECKPOINT_PATH!;
  process.env.CHECKPOINT_PATH = path.join(doomed, "cannot-create");
  const deleted = await handlers.get("delete_file")!({ path: doomed });
  assert.equal(deleted.structuredContent.data.deleted, true);
  assert.equal(deleted.structuredContent.data.checkpoint.complete, false);
  assert(deleted.structuredContent.data.checkpoint.error);
  process.env.CHECKPOINT_PATH = checkpointRoot;
  process.env.CHATGPT_BROWSER_PATH = path.join(root, "missing-browser.exe");
  await assert.rejects(() => chromiumScreenshot(pathToFileURL(special).href, path.join(root, "invalid.png"), 640, 480, 3000), /Explicit browser path is invalid/);
  delete process.env.CHATGPT_BROWSER_PATH;
  const fakeBrowser = path.join(root, "broken-browser.exe"); await fs.writeFile(fakeBrowser, "bad binary");
  const runtime = path.join(root, "runtime");
  const chrome = path.join(runtime, "chrome", "chrome-win64", "chrome.exe");
  await fs.mkdir(path.dirname(chrome), { recursive: true });
  await fs.mkdir(path.join(runtime, "python"), { recursive: true });
  await fs.mkdir(path.join(runtime, "site-packages"), { recursive: true });
  await fs.writeFile(chrome, "fixture chrome"); await fs.writeFile(path.join(runtime, "python", "python.exe"), "fixture");
  const lockPath = path.resolve("bundled-plugins/browser-use/runtime-lock.json");
  const lockText = await fs.readFile(lockPath, "utf8");
  const digest = (data: string) => createHash("sha256").update(data).digest("hex");
  await fs.writeFile(path.join(runtime, "provenance.json"), JSON.stringify({
    ...JSON.parse(lockText), telemetry_default: "disabled",
    critical_files: { "chrome/chrome-win64/chrome.exe": digest("fixture chrome") },
  }));
  process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT = runtime;
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK = lockPath;
  process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256 = digest(lockText);
  assert.equal(browserCandidates()[0], chrome);
  await fs.writeFile(chrome, "tampered");
  assert(!browserCandidates().includes(chrome), "tampered offline Chrome must not be selected");
  delete process.env.HARNESS_BROWSER_USE_RUNTIME_ROOT;
  delete process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK;
  delete process.env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256;
  process.env.CHATGPT_VERIFIED_OFFLINE_BROWSER_PATH = fakeBrowser;
  assert(!browserCandidates().includes(fakeBrowser));
  const shot = await chromiumScreenshot(pathToFileURL(special).href, path.join(root, "shot.png"), 640, 480, 30000);
  assert(shot.browser && shot.browser_version); assert.notEqual(shot.browser, fakeBrowser); assert((await fs.stat(path.join(root, "shot.png"))).size > 0);
  delete process.env.CHATGPT_VERIFIED_OFFLINE_BROWSER_PATH;
  await assert.rejects(
    () => chromiumScreenshot("http://127.0.0.1:1/", path.join(root, "failed.png"), 640, 480, 10000),
    error => /navigation/.test(String(error)) && /close context/.test(String(error)) && /close browser/.test(String(error)),
  );
  const server = http.createServer((request, response) => {
    if (request.url === "/stream") { response.writeHead(200, { "Content-Type": "text/event-stream" }); response.write("data: connected\n\n"); return; }
    response.writeHead(200, { "Content-Type": "text/html" }); response.end('<script>new EventSource("/stream")</script><h1>long connection</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const addr = server.address(); assert(addr && typeof addr !== "string");
    await chromiumScreenshot(`http://127.0.0.1:${addr.port}/`, path.join(root, "stream.png"), 640, 480, 10000);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  console.log("PASS v32 tooling: target URL, partial checkpoint restore, exact argv, nonzero, GBK, timeout, screenshot", JSON.stringify(shot));
} finally { await fs.rm(root, { recursive: true, force: true }); }
