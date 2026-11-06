"use strict";
// Launch an Electron integration fixture even when the parent MCP itself is
// running under ELECTRON_RUN_AS_NODE. This is also friendlier to CI harnesses.
const { spawn } = require("node:child_process");
const fs = require("node:fs"), path = require("node:path");
const { artifactRoot, privatePorts, componentElectronTests } = require("./lib/test-isolation.cjs");
const { createCompletionObserver } = require("./lib/electron-test-completion.cjs");
const electronPath = require("electron");
const args = process.argv.slice(2);
if (!args.length) {
  console.error("usage: node scripts/run-electron.cjs <script> [args...]");
  process.exit(2);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
async function main() {
const entry = path.resolve(args[0]);
const isTest = path.dirname(entry) === __dirname && componentElectronTests.includes(path.basename(entry));
let launchArgs = args;
let observer;
if (isTest) {
  const scope = artifactRoot("electron-" + path.basename(entry).replace(/\.(cjs|js)$/, ""));
  const temp = path.join(scope, "temp"); fs.mkdirSync(temp);
  Object.assign(env, { HARNESS_ELECTRON_TEST_SCOPE: scope, HARNESS_TEST_OUTPUT_ROOT: scope,
    HARNESS_TEST_INITIAL_PORTS: JSON.stringify(await privatePorts(3)), TEMP: temp, TMP: temp,
    APPDATA: path.join(scope, "appdata"), LOCALAPPDATA: path.join(scope, "localappdata") });
  fs.mkdirSync(env.APPDATA); fs.mkdirSync(env.LOCALAPPDATA);
  launchArgs = [path.join(__dirname, "electron-test-bootstrap.cjs"), entry, ...args.slice(1)];
  observer = createCompletionObserver({ target: path.basename(entry), args: args.slice(1), scope });
}
const child = spawn(electronPath, launchArgs, { cwd: process.cwd(), env, stdio: observer ? ["inherit", "pipe", "pipe"] : "inherit", windowsHide: true });
if (observer) {
  for (const [name, destination] of [["stdout", process.stdout], ["stderr", process.stderr]]) {
    child[name].on("data", chunk => observer.write(name, chunk));
    child[name].pipe(destination, { end: false });
  }
}
const result = await new Promise(resolve => {
  child.once("error", error => resolve({ error }));
  child.once("close", (status, signal) => resolve({ status, signal }));
});
if (result.error) {
  console.error(result.error.stack || result.error);
  process.exitCode = 1; return;
}
if (result.signal) {
  console.error(`Electron fixture terminated by ${result.signal}`);
  process.exitCode = 1; return;
}
if (observer) {
  const completion = observer.finish({ exitCode: result.status, signal: result.signal ?? null });
  console.log("DESKTOP_COMPONENT_COMPLETE " + JSON.stringify(completion));
}
// Natural exit lets forwarded stdout/stderr finish draining into the parent log.
process.exitCode = result.status == null ? 1 : result.status;
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
