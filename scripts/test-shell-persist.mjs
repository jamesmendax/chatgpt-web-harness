/**
 * Global shell cwd persists across bootstrap (simulates ChatGPT new MCP sessions).
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  bootstrapShellSession,
  execInShellSession,
  getShellStatus,
} from "../dist/lib/persistent-shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const stateDir = path.join(root, ".tool-test-tmp", "shell-persist");

process.env.MCP_SHELL_STATE_DIR = stateDir;

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e && e.stack || e}`); failed++; }

try {
  await fs.rm(stateDir, { recursive: true, force: true });
  await bootstrapShellSession(root);
  await execInShellSession(process.platform === "win32" ? "cd src" : "cd src", root, 5000);

  const cwd1 = getShellStatus().cwd;
  if (!cwd1.replace(/\\/g, "/").endsWith("/src")) {
    throw new Error(`expected cwd in src, got ${cwd1}`);
  }
  ok(`cwd after cd: ${cwd1}`);

  await bootstrapShellSession(root);
  const cwd2 = getShellStatus().cwd;
  if (cwd2 !== cwd1) throw new Error(`persist failed: ${cwd1} -> ${cwd2}`);
  ok("cwd restored after re-bootstrap");

  const oneOff = await execInShellSession(
    `node -e "console.log(process.cwd())"`,
    root,
    5000,
    root
  );
    const expectedRoot = path.resolve(root).split(path.sep).join("/");
  if (!oneOff.stdout.replace(/\\/g, "/").endsWith(expectedRoot)) {
    throw new Error(`working_directory did not apply: ${oneOff.stdout}`);
  }
  if (getShellStatus().cwd !== cwd1) throw new Error("working_directory unexpectedly changed persistent cwd");
  ok("working_directory is a one-off override");

  const compound = await execInShellSession(
    `node -e "process.exit(7)" && node -e "console.log('should-not-run')"`,
    root,
    5000,
    root
  );
  if (compound.exit_code === 0) throw new Error("failed compound command reported exit 0");
  if (compound.stdout.includes("should-not-run")) throw new Error("&& executed command after failure");
  if (!compound.full_output_path) throw new Error("command did not persist full output log");
  await fs.stat(compound.full_output_path);
  if (typeof compound.duration_ms !== "number") throw new Error("command duration missing");
  ok(`compound failure preserved as exit ${compound.exit_code}`);

  const timedOut = await execInShellSession(
    `node -e "setTimeout(()=>{},5000)"`,
    root,
    200,
    root
  );
  if (!timedOut.timed_out || timedOut.exit_code !== null) throw new Error("timeout did not return structured failure");
  if (!timedOut.stderr.includes("timed out")) throw new Error("timeout diagnostic missing");
  await fs.stat(timedOut.full_output_path);
  ok("timeout returns structured evidence and a full log");
} catch (e) {
  fail("shell persist", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);