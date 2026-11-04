"use strict";

// The packaged Web Harness prepends its own executable directory to PATH. On
// Windows, electron-builder's generated .cmd shim then resolves `node` to the
// running Harness EXE instead of the real Node runtime. Invoke the CLI through
// this script's known Node executable so release builds are deterministic even
// while production Harness is running.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkg = require.resolve("electron-builder/package.json");
const cli = path.join(path.dirname(pkg), "cli.js");
const args = process.argv.slice(2);
const configuredNode = process.env.CHATGPT_WEB_HARNESS_NODE_EXE;
const standardWindowsNode = "C:\\Program Files\\nodejs\\node.exe";
const currentLooksLikeNode = /^node(?:\.exe)?$/i.test(path.basename(process.execPath));
const nodeExe = configuredNode || (fs.existsSync(standardWindowsNode) ? standardWindowsNode : (currentLooksLikeNode ? process.execPath : null));
if (!nodeExe || !fs.existsSync(nodeExe)) {
  console.error("A real Node.js executable is required to run electron-builder. Set CHATGPT_WEB_HARNESS_NODE_EXE to node.exe.");
  process.exit(2);
}
const result = spawnSync(nodeExe, [cli, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) {
  console.error(result.error.stack || result.error);
  process.exit(1);
}
if (result.signal) {
  console.error(`electron-builder terminated by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
