#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wh-allowed-roots-v2-"));
const workspace = path.join(sandbox, "workspace");
const secondRoot = path.join(sandbox, "second-root");
const outside = path.join(sandbox, "outside");
await Promise.all([workspace, secondRoot, outside].map((dir) => fs.mkdir(dir, { recursive: true })));
await fs.writeFile(path.join(workspace, "inside.txt"), "inside");
await fs.writeFile(path.join(secondRoot, "second.txt"), "second");
await fs.writeFile(path.join(outside, "secret.txt"), "outside");

const {
  getAllowedRoots,
  getDefaultCwd,
  getFullDiskAccess,
  setAllowedRoots,
  setDefaultCwd,
  setFullDiskAccess,
  validatePath,
} = await import("../dist/lib/path-security.js");

const oldCwd = getDefaultCwd();
const oldRoots = getAllowedRoots();
const oldFullDisk = getFullDiskAccess();
try {
  setDefaultCwd(workspace);
  setAllowedRoots([workspace, secondRoot]);
  setFullDiskAccess(false);

  assert.equal(await validatePath("inside.txt"), path.resolve(workspace, "inside.txt"));
  assert.equal(await validatePath(path.join(workspace, "new", "future.txt")), path.resolve(workspace, "new", "future.txt"));
  assert.equal(await validatePath(path.join(secondRoot, "second.txt")), path.resolve(secondRoot, "second.txt"));
  await assert.rejects(() => validatePath(path.join(outside, "secret.txt")), /PATH_OUTSIDE_ALLOWED_ROOTS/);
  await assert.rejects(() => validatePath(path.join(outside, "future.txt")), /PATH_OUTSIDE_ALLOWED_ROOTS/);

  const alias = path.join(workspace, "outside-alias");
  await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => validatePath(path.join(alias, "secret.txt")), /PATH_OUTSIDE_ALLOWED_ROOTS/, "existing symlink/junction escape must be blocked");
  await assert.rejects(() => validatePath(path.join(alias, "new", "future.txt")), /PATH_OUTSIDE_ALLOWED_ROOTS/, "nonexistent target under symlink/junction escape must be blocked");

  setFullDiskAccess(true);
  assert.equal(await validatePath(path.join(outside, "secret.txt")), path.resolve(outside, "secret.txt"), "default full-machine contract must remain available when enabled");

  setFullDiskAccess(false);
  setAllowedRoots([]);
  assert.deepEqual(getAllowedRoots(), [path.resolve(workspace)], "empty strict roots reset to workspace rather than all-disk access");
  await assert.rejects(() => validatePath(path.join(secondRoot, "second.txt")), /PATH_OUTSIDE_ALLOWED_ROOTS/);

  console.log("allowed-roots-v2 PASS: configurable multi-root boundary, nonexistent target protection, symlink escape rejection, full-disk compatibility");
} finally {
  setDefaultCwd(oldCwd);
  setAllowedRoots(oldRoots);
  setFullDiskAccess(oldFullDisk);
  await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
