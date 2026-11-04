import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = process.env.GOAL_SCRATCH || path.join(root, ".tool-test-tmp", "verification");

const child = spawn(process.execPath, [path.join(root, "scripts/capture-verification-evidence.mjs")], {
  cwd: root,
  env: { ...process.env, GOAL_SCRATCH: scratch },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));
