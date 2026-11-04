import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const snapshotRoot = path.resolve(process.env.FIVE_REPO_SNAPSHOT_ROOT || "D:/web_harness_z8_business/five-repo-study-20260912");
const manifestPath = path.join(snapshotRoot, "PINNED_SNAPSHOTS_20260914.json");

const expected = new Map([
  ["coding-tools-mcp", ["https://github.com/xyTom/coding-tools-mcp.git", "bedb632e1afd2e9ec9b268a50fe0b04695c22c64"]],
  ["codexpro", ["https://github.com/rebel0789/codexpro.git", "587f7fd3a4644a847bba13aeb49336056052e1f6"]],
  ["serena", ["https://github.com/oraios/serena.git", "701e7c843f46c6a649203a488cece1bf19f1df90"]],
  ["DesktopCommanderMCP", ["https://github.com/wonderwhy-er/DesktopCommanderMCP.git", "a781f5a4b8cfebac6638bc6fcbd38fca6326be53"]],
  ["codex-chatgpt-web", ["https://github.com/miuuyy/codex-chatgpt-web.git", "e85e3693fdb4e3e033348c08df0298c20fcdb612"]],
]);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed in ${repo}: ${result.stderr}`);
  return result.stdout.trim();
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.schema_version, 1);
assert.equal(manifest.repos.length, expected.size);
for (const repo of manifest.repos) {
  const pinned = expected.get(repo.name);
  assert.ok(pinned, `unexpected repository ${repo.name}`);
  const checkout = path.join(snapshotRoot, "snapshots", repo.name);
  assert.equal(repo.origin, pinned[0]);
  assert.equal(repo.commit, pinned[1]);
  assert.equal(git(checkout, "remote", "get-url", "origin"), pinned[0]);
  assert.equal(git(checkout, "rev-parse", "HEAD"), pinned[1]);
  assert.equal(git(checkout, "rev-parse", "HEAD^{tree}"), repo.tree);
  assert.equal(git(checkout, "status", "--porcelain"), "", `${repo.name} reference checkout is dirty`);
  for (const item of repo.evidence_files) {
    const file = path.join(checkout, ...item.path.split("/"));
    assert.equal(fs.statSync(file).size, item.bytes, `${repo.name}/${item.path} size drift`);
    assert.equal(sha256(file), item.sha256, `${repo.name}/${item.path} hash drift`);
  }
}

const tests = [
  "scripts/test-process-recovery.mjs",
  "scripts/test-recovery-v2.mjs",
  "scripts/test-f0-characterization.mjs",
  "scripts/test-safe-text-write.mjs",
  "scripts/test-mcp-upstream.mjs",
  "scripts/test-goal-work-progress.mjs",
  "scripts/test-code-intelligence.mjs",
  "scripts/test-code-intelligence-cache-rename.mjs",
  "scripts/test-lsp-adapter.mjs",
  "scripts/test-process-interactive-v2.mjs",
  "scripts/test-process-recovery-control.mjs",
  "scripts/test-browser-turn-fence.mjs",
  "scripts/test-browser-recovery-v2.mjs",
  "scripts/test-relay-manager.mjs",
  "scripts/test-stream-survival.mjs",
];

for (const test of tests) {
  const result = spawnSync(process.execPath, [test], { cwd: root, stdio: "inherit", windowsHide: true });
  assert.equal(result.status, 0, `${test} failed with exit ${result.status}`);
}

console.log(`five-repo adoption: ${expected.size} pinned trees and ${tests.length} implementation gates passed`);
