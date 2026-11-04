"use strict";
// Launch an Electron integration fixture even when the parent MCP itself is
// running under ELECTRON_RUN_AS_NODE. This is also friendlier to CI harnesses.
const { spawnSync } = require("node:child_process");
const electronPath = require("electron");
const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node scripts/run-electron.cjs <script> [args...]");
  process.exit(2);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
const result = spawnSync(electronPath, args, { cwd: process.cwd(), env, stdio: "inherit", windowsHide: true });
if (result.error) {
  console.error(result.error.stack || result.error);
  process.exit(1);
}
if (result.signal) {
  console.error(`Electron fixture terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
