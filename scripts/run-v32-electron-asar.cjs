"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const repo = path.resolve(__dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
const desktopVersion = JSON.parse(fs.readFileSync(path.join(repo, "desktop", "package.json"), "utf8")).version;
assert.equal(typeof version, "string");
assert.equal(desktopVersion, version, "Root and desktop versions differ");
// Check before creating files, directories, or launching any child.
assert.equal(process.platform, "win32");
assert.equal(process.versions.electron, undefined, "This runner must use standard Node");
assert.match(path.basename(process.execPath), /^node(?:\.exe)?$/i, "Parent must be the standard Node executable");
const [exportArg, unpackedArg, expectedReportHash, expectedExeHash, ...extra] = process.argv.slice(2);
assert.ok(exportArg && unpackedArg && /^[a-f0-9]{64}$/i.test(expectedReportHash || "") && /^[a-f0-9]{64}$/i.test(expectedExeHash || "") && extra.length === 0,
  "Usage: node scripts/run-v32-electron-asar.cjs <verified-export-dir> <win-unpacked-dir> <trusted-verification-sha256> <independently-verified-unpacked-exe-sha256>");
const exportDir = path.resolve(exportArg), unpacked = path.resolve(unpackedArg);
const executable = path.join(unpacked, "ChatGPT Web Harness Isolated.exe");
const resources = path.join(unpacked, "resources"), archive = path.join(resources, "app.asar");
const harness = path.join(resources, "harness");
const reportFile = path.join(exportDir, "VERIFICATION.json");
const manifestFile = path.join(exportDir, "RUNTIME_MANIFEST.json");
const formalTest = path.join(repo, "scripts", "test-v32-electron-asar.cjs");
function hash(file) {
  const digest = crypto.createHash("sha256"), block = Buffer.allocUnsafe(1024 * 1024), fd = fs.openSync(file, "r");
  try { for (let n; (n = fs.readSync(fd, block, 0, block.length, null)) > 0;) digest.update(block.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return digest.digest("hex");
}
const sameHash = (actual, expected, label) => assert.equal(actual.toLowerCase(), String(expected).toLowerCase(), label);
function safeRowFile(root, row) {
  assert.equal(typeof row.path, "string");
  assert.ok(row.path && !path.isAbsolute(row.path) && !row.path.includes("\\") &&
    row.path.split("/").every(x => x && x !== "." && x !== ".."), "Unsafe runtime manifest path");
  const file = path.resolve(root, ...row.path.split("/"));
  const realRoot = fs.realpathSync(root).toLowerCase() + path.sep;
  assert.ok(fs.realpathSync(file).toLowerCase().startsWith(realRoot), "Runtime file escapes candidate");
  assert.ok(fs.lstatSync(file).isFile(), "Runtime manifest entry is not a regular file");
  return file;
}
async function main() {
  sameHash(hash(reportFile), expectedReportHash, "Verification report differs from trusted digest");
  const verification = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(verification.schema, 2);
  assert.equal(verification.complete, true);
  assert.equal(verification.passed, true);
  assert.equal(verification.version, version);
  assert.equal(verification.claims?.packaged_runtime_hashes, true);
  assert.equal(verification.claims?.packaged_app_source_hashes, true);
  assert.ok(Array.isArray(verification.artifacts) && Array.isArray(verification.exe_extraction));
  const sourceManifestPath = path.join(exportDir, "SOURCE_MANIFEST.json");
  const sourceArtifacts = verification.artifacts.filter(x => x.name === "SOURCE_MANIFEST.json");
  assert.equal(sourceArtifacts.length, 1, "Expected one source manifest artifact");
  assert.equal(fs.statSync(sourceManifestPath).size, sourceArtifacts[0].bytes, "Source manifest size differs");
  sameHash(hash(sourceManifestPath), sourceArtifacts[0].sha256, "Source manifest is not bound to verification");
  const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
  assert.ok(Array.isArray(sourceManifest));
  function bindSource(relative, file) {
    const rows = sourceManifest.filter(x => x.path === relative);
    assert.equal(rows.length, 1, "Expected exactly one source manifest entry: " + relative);
    assert.equal(fs.statSync(file).size, rows[0].bytes, "Source size differs: " + relative);
    sameHash(hash(file), rows[0].sha256, "Source hash differs: " + relative);
    return rows[0];
  }
  const formalRow = bindSource("scripts/test-v32-electron-asar.cjs", formalTest);
  const runnerRow = bindSource("scripts/run-v32-electron-asar.cjs", __filename);
  const manifestRows = verification.artifacts.filter(x => x.name === "RUNTIME_MANIFEST.json");
  assert.equal(manifestRows.length, 1);
  assert.equal(fs.statSync(manifestFile).size, manifestRows[0].bytes);
  sameHash(hash(manifestFile), manifestRows[0].sha256, "Runtime manifest is not bound to verification");
  const portable = verification.exe_extraction.filter(x => typeof x.name === "string" && x.name.endsWith("-portable.exe"));
  assert.equal(portable.length, 1, "Expected one verified Portable extraction");
  const artifact = verification.artifacts.filter(x => x.name === portable[0].name);
  assert.equal(artifact.length, 1);
  assert.equal(path.basename(portable[0].name), portable[0].name);
  const portableFile = path.join(exportDir, portable[0].name);
  assert.equal(fs.statSync(portableFile).size, artifact[0].bytes);
  sameHash(hash(portableFile), artifact[0].sha256, "Portable artifact changed");
  sameHash(artifact[0].sha256, portable[0].sha256, "Extraction receipt is not bound to Portable");
  assert.ok(fs.lstatSync(executable).isFile() && fs.lstatSync(archive).isFile());
  const exeHash = hash(executable), asarHash = hash(archive);
  sameHash(exeHash, expectedExeHash, "Unpacked executable does not match independently verified extraction hash");
  sameHash(asarHash, portable[0].app_asar_sha256, "ASAR differs from verified extracted Portable");
  const runtime = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.ok(Number.isSafeInteger(verification.runtime_files) && verification.runtime_files > 0, "Invalid reported runtime count");
  assert.ok(Array.isArray(runtime) && runtime.length === verification.runtime_files, "Runtime file count differs from report");
  assert.equal(portable[0].payload_files, verification.runtime_files, "Portable extraction payload count differs");
  const seen = new Set();
  for (const row of runtime) {
    assert.ok(!seen.has(row.path), "Duplicate runtime entry"); seen.add(row.path);
    const file = safeRowFile(harness, row);
    assert.equal(fs.statSync(file).size, row.bytes, "Runtime file size mismatch: " + row.path);
    sameHash(hash(file), row.sha256, "Runtime file hash mismatch: " + row.path);
  }
  // Reject unlisted files and links as well as missing or changed entries.
  function walkRuntime(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const info = fs.lstatSync(file);
      assert.ok(!info.isSymbolicLink(), "Runtime contains a reparse point: " + file);
      if (info.isDirectory()) walkRuntime(file);
      else {
        assert.ok(info.isFile(), "Runtime contains a non-file entry: " + file);
        const relative = path.relative(harness, file).split(path.sep).join("/");
        assert.ok(seen.has(relative), "Runtime contains an unlisted file: " + relative);
      }
    }
  }
  walkRuntime(harness);
  for (const required of ["dist/lib/physical-fs.js", "dist/lib/path-security.js", "dist/lib/checkpoint.js", "dist/tools/filesystem.js"])
    assert.ok(seen.has(required), "Required packaged module missing: " + required);
  const asar = require(path.join(repo, "desktop", "node_modules", "@electron", "asar"));
  const appPackage = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  assert.equal(appPackage.version, version, "ASAR version differs from current package");
  // The fuse is checked without running the binary. If RunAsNode is disabled,
  // ELECTRON_RUN_AS_NODE cannot be trusted to prevent a GUI launch.
  const { getCurrentFuseWire, FuseV1Options } = require(path.join(repo, "desktop", "node_modules", "@electron", "fuses"));
  const fuse = await getCurrentFuseWire(executable);
  assert.equal(fuse.version, "1", "Unrecognized Electron fuse wire");
  assert.equal(fuse[FuseV1Options.RunAsNode], 49, "Candidate RunAsNode fuse is not explicitly enabled");
  const evidenceBase = path.join(repo, ".validation");
  fs.mkdirSync(evidenceBase, { recursive: true });
  const evidence = fs.mkdtempSync(path.join(evidenceBase, "v32-electron-asar-"));
  const privateRoot = path.join(evidence, "private");
  for (const sub of ["tmp", "profile", "appdata", "localappdata", "runtime", "workspace"])
    fs.mkdirSync(path.join(privateRoot, sub), { recursive: true });
  const nonce = crypto.randomBytes(32).toString("hex");
  const expectedProof = crypto.createHash("sha256").update(nonce).digest("hex");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const env = {
    SystemRoot: systemRoot, WINDIR: systemRoot, PATH: path.join(systemRoot, "System32"),
    TEMP: path.join(privateRoot, "tmp"), TMP: path.join(privateRoot, "tmp"),
    USERPROFILE: path.join(privateRoot, "profile"), HOME: path.join(privateRoot, "profile"),
    APPDATA: path.join(privateRoot, "appdata"), LOCALAPPDATA: path.join(privateRoot, "localappdata"),
    CLC_RUNTIME_DIR: path.join(privateRoot, "runtime"),
    CODEX_HOME: path.join(privateRoot, "runtime", "codex"),
    MCP_SHELL_STATE_DIR: path.join(privateRoot, "runtime", "shell"),
    AUDIT_LOG_PATH: path.join(privateRoot, "runtime", "audit.log"),
    CHECKPOINT_PATH: path.join(privateRoot, "runtime", "checkpoints"),
    WORKSPACE_PATH: path.join(privateRoot, "workspace"),
    ELECTRON_RUN_AS_NODE: "1",
    HARNESS_V32_ASAR_PARENT_NONCE: nonce,
    HARNESS_V32_ASAR_TMP_ROOT: path.join(privateRoot, "tmp"),
  };
  const logPath = path.join(evidence, "test.log"), reportPath = path.join(evidence, "result.json");
  const log = fs.createWriteStream(logPath, { flags: "wx" });
  const info = { schema: 1, complete: false, passed: false, version: verification.version,
    verification: reportFile, verification_sha256: hash(reportFile), portable: portableFile,
    portable_sha256: hash(portableFile), runtime_manifest_sha256: hash(manifestFile), runtime_files: runtime.length,
    executable, executable_sha256: exeHash, executable_expected_sha256: expectedExeHash.toLowerCase(),
    executable_binding: "caller-supplied independently verified extraction sha256",
    app_asar: archive, app_asar_sha256: asarHash, run_as_node_fuse: "enabled", log: logPath,
    acceptance_mode: "two-process-deferred-fixture-cleanup", source_manifest: sourceManifestPath,
    source_manifest_sha256: sourceArtifacts[0].sha256, formal_test: formalTest, formal_test_sha256: formalRow.sha256,
    runner: __filename, runner_sha256: runnerRow.sha256,
    started_at: new Date().toISOString() };
  console.log("ASAR_EVIDENCE " + evidence);
  sameHash(hash(formalTest), formalRow.sha256, "Formal test changed before launch");
  sameHash(hash(__filename), runnerRow.sha256, "Runner changed before launch");
  const child = spawn(executable, [formalTest, resources], { cwd: repo, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", data => { log.write(data); stdout += data; });
  child.stderr.on("data", data => { log.write(data); stderr += data; });
  let childError = null;
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (!child.kill()) childError ||= "Timed out and termination was not confirmed"; }
    catch (error) { childError ||= String(error); }
  }, 600000);
  // Error can also follow a failed kill; it does not prove the process exited.
  // Wait for close in every case before authorizing fixture cleanup.
  const outcome = await new Promise(resolve => {
    child.on("error", error => { childError ||= String(error); });
    child.once("close", (code, signal) => resolve({ code, signal, error: childError }));
  });
  clearTimeout(timer);
  await new Promise(resolve => log.end(resolve));
  let parsed;
  for (const line of stdout.split(/\r?\n/)) {
    try { const x = JSON.parse(line); if (x.ok === true && x.copy_delete_checkpoint_restore === true) parsed = x; } catch {}
  }
  // A single post-test receipt names an owned direct child of the fresh TMP.
  // Validate every existing path component and descendant before removing it.
  const marker = "V32_FIXTURE_CLEANUP_DEFERRED ";
  const receipts = stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  let cleanup = { attempted: false, passed: false, error: null, fixture: null };
  try {
    assert.equal(receipts.length, 1, "Exactly one cleanup receipt required");
    const receipt = JSON.parse(receipts[0].slice(marker.length));
    assert.equal(typeof receipt.tmp, "string");
    assert.equal(receipt.proof, expectedProof, "Cleanup receipt does not match this run");
    const tmpRoot = path.resolve(privateRoot, "tmp"), fixture = path.resolve(receipt.tmp);
    assert.equal(path.dirname(fixture).toLowerCase(), tmpRoot.toLowerCase(), "Fixture must be a direct TMP child");
    assert.match(path.basename(fixture), /^wh-v32-electron-[A-Za-z0-9]+$/, "Unexpected fixture name");
    for (const dir of [evidence, privateRoot, tmpRoot, fixture]) {
      const st = fs.lstatSync(dir);
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), "Directory is missing or a reparse point: " + dir);
      assert.equal(fs.realpathSync(dir).toLowerCase(), path.resolve(dir).toLowerCase(), "Directory traverses a reparse point: " + dir);
    }
    function assertSafeTree(dir) {
      for (const name of fs.readdirSync(dir)) {
        const childPath = path.join(dir, name), st = fs.lstatSync(childPath);
        assert.ok(!st.isSymbolicLink(), "Fixture contains a reparse point: " + childPath);
        assert.ok(fs.realpathSync(childPath).toLowerCase().startsWith(fixture.toLowerCase() + path.sep), "Fixture entry escaped scope");
        if (st.isDirectory()) assertSafeTree(childPath);
        else assert.ok(st.isFile(), "Fixture contains a non-file entry");
      }
    }
    assertSafeTree(fixture);
    cleanup = { attempted: true, passed: false, error: null, fixture };
    fs.rmSync(fixture, { recursive: true, force: false, maxRetries: 10, retryDelay: 100 });
    assert.equal(fs.existsSync(fixture), false, "Fixture remains after cleanup");
    cleanup.passed = true;
  } catch (error) { cleanup.error = String(error); }
  let bindingError = null;
  try {
    sameHash(hash(formalTest), formalRow.sha256, "Formal test changed during acceptance");
    sameHash(hash(__filename), runnerRow.sha256, "Runner changed during acceptance");
    sameHash(hash(executable), exeHash, "Candidate executable changed during acceptance");
    sameHash(hash(archive), asarHash, "Candidate ASAR changed during acceptance");
    sameHash(hash(reportFile), expectedReportHash, "Verification changed during acceptance");
  } catch (error) { bindingError = String(error); }
  const passed = outcome.code === 0 && !outcome.error && !timedOut && parsed &&
    typeof parsed.electron === "string" && parsed.electron.length > 0 &&
    path.resolve(String(parsed.archive || "")).toLowerCase() === path.resolve(archive).toLowerCase() &&
    cleanup.passed && !bindingError;
  Object.assign(info, { complete: true, passed: Boolean(passed), ...outcome, timed_out: timedOut,
    electron: parsed?.electron ?? null, test_receipt: parsed ?? null, cleanup, binding_error: bindingError,
    log_sha256: hash(logPath), completed_at: new Date().toISOString() });
  fs.writeFileSync(reportPath, JSON.stringify(info, null, 2) + "\n", { flag: "wx" });
  console.log("ASAR_RESULT " + JSON.stringify({ report: reportPath, ...info }));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
