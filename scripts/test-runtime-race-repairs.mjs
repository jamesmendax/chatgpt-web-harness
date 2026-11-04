import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { execInShellSession, initShellSession } from "../src/lib/persistent-shell.ts";
import { indexedSkills, readIndexedSkillFile } from "../src/lib/skill-index.ts";

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "wh-runtime-races-"));
const previousHome = process.env.CODEX_HOME;
try {
  process.env.CODEX_HOME = path.join(temp, "home");
  initShellSession(temp);
  const original = fs.createWriteStream;
  try {
    fs.createWriteStream = () => new Writable({ write(_chunk, _enc, callback) {
      const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      setImmediate(() => callback(error));
    } });
    const command = process.platform === "win32" ? "Write-Output shell-ok; Start-Sleep -Milliseconds 100" : "echo shell-ok; sleep 0.1";
    const result = await execInShellSession(command, temp, 5000);
    assert.equal(result.exit_code, 0);
    assert.match(result.stdout, /shell-ok/);
    assert.equal(result.log_incomplete, true);
    assert.equal(result.log_error, "ENOSPC");
    fs.createWriteStream = () => new Writable({
      write(_chunk, _enc, callback) { callback(); },
      final(callback) { callback(Object.assign(new Error("final flush failed"), { code: "ENOSPC" })); },
    });
    const finalFailure = await execInShellSession(process.platform === "win32" ? "Write-Output final-ok" : "echo final-ok", temp, 5000);
    assert.equal(finalFailure.exit_code, 0);
    assert.equal(finalFailure.log_incomplete, true);
    assert.equal(finalFailure.log_error, "ENOSPC");
  } finally { fs.createWriteStream = original; }

  const root = path.join(temp, "skills"), dir = path.join(root, "first");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await fsp.writeFile(file, "old");
  const readFile = fsp.readFile;
  let readRace = 0;
  try {
    fsp.readFile = async (...args) => {
      const bytes = await readFile(...args);
      if (args[0] === file && readRace++ === 0) await fsp.writeFile(file, "fresh file content");
      return bytes;
    };
    assert.equal((await readIndexedSkillFile(file)).toString(), "fresh file content");
    assert.equal(readRace, 2);
  } finally { fsp.readFile = readFile; }
  await fsp.writeFile(file, "old");
  let loads = 0;
  const load = async () => {
    loads++;
    const content = (await readIndexedSkillFile(file)).toString();
    if (loads === 1) await fsp.writeFile(file, "new content");
    return [{ path: file, content }];
  };
  const result = await indexedSkills("changed-during-load", [root], load);
  assert.equal(result[0].content, "new content");
  assert.equal(loads, 2);
  assert.equal((await indexedSkills("changed-during-load", [root], load))[0].content, "new content");
  assert.equal(loads, 2);

  let discoverLoads = 0;
  const newFile = path.join(root, "second", "SKILL.md");
  const discover = async () => {
    discoverLoads++;
    if (discoverLoads === 1) {
      await fsp.mkdir(path.dirname(newFile), { recursive: true });
      await fsp.writeFile(newFile, "new skill");
      return [{ path: file }];
    }
    return [{ path: file }, { path: newFile }];
  };
  const discovered = await indexedSkills("new-path", [root], discover);
  assert.equal(discovered.length, 2);
  assert.equal(discoverLoads, 2);

  let unstableLoads = 0;
  await assert.rejects(indexedSkills("unstable", [root], async () => {
    await fsp.writeFile(file, `change ${++unstableLoads} ${"x".repeat(unstableLoads)}`);
    return [{ path: file }];
  }), /changed repeatedly/);
  assert.equal(unstableLoads, 3);
  console.log("PASS shell ENOSPC; stable skill snapshot, new discovery, bounded retry");
} finally {
  if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  await fsp.rm(temp, { recursive: true, force: true });
}
