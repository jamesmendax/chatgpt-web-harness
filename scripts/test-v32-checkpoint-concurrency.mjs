import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
const dist = path.resolve(process.argv[2] || "dist");
const checkpoint = await import(pathToFileURL(path.join(dist, "lib/checkpoint.js")).href);
if (process.argv[3] === "worker") {
  const result = await checkpoint.checkpointBeforeDetailed("worker", [process.argv[4]]);
  assert(result.id && result.complete, JSON.stringify(result));
  console.log(result.id);
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wh-cp-concurrency-"));
  const store = path.join(root, "store");
  try {
    const files = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const file = path.join(root, `f${i}`); await fs.writeFile(file, `v${i}`); return file;
    }));
    const ids = await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), dist, "worker", file], {
        env: { ...process.env, CHECKPOINT_PATH: store }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "", errors = "";
      child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => errors += chunk);
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(errors || `exit ${code}`)));
    })));
    process.env.CHECKPOINT_PATH = store;
    const listed = await checkpoint.listCheckpoints(100);
    assert.equal(new Set(ids).size, 10); assert(ids.every(id => listed.some(item => item.id === id)));
    console.log("PASS v32 checkpoint: ten independent processes retained every index entry");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}