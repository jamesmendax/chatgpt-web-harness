"use strict";
// Native Windows parsing/response test; inspect and stop only our disposable child.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const status = require("../src/status");
if (process.platform !== "win32") {
  console.log("SKIP native status probe: Windows-only");
  process.exit(0);
}
const marker = "clc-status-native-fixture";
const code = "// " + marker + "\n" +
  "const net=require('node:net');const s=net.createServer(c=>c.end());" +
  "s.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port,pid:process.pid})));" +
  "setTimeout(()=>process.exit(0),45000).unref();";
const child = spawn(process.execPath, ["-e", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const exited = once(child, "exit");
let deadline;
const ready = new Promise((resolve, reject) => {
  let output = "";
  deadline = setTimeout(() => reject(new Error("fixture startup timeout")), 10000);
  child.once("error", reject);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (part) => {
    output += part;
    if (output.includes("\n")) {
      clearTimeout(deadline);
      try { resolve(JSON.parse(output.trim())); } catch (error) { reject(error); }
    }
  });
});
let heartbeat;
(async () => {
  try {
    const fixture = await ready;
    assert.equal(fixture.pid, child.pid);
    let ticks = 0;
    heartbeat = setInterval(() => ticks++, 5);
    const start = performance.now();
    const [owner, listeners] = await Promise.all([
      status.classifyPortOwner(fixture.port, new RegExp(marker), { fresh: true }),
      status.listeningPids(fixture.port),
    ]);
    assert.ok(listeners.includes(child.pid));
    assert.equal(owner.pid, child.pid);
    assert.equal(owner.recognized, true);
    assert.equal(owner.error, null);
    assert.ok(owner.creationDate);
    const identity = await status.processInfo(child.pid, { fresh: true });
    assert.equal(identity.ProcessId, child.pid);
    assert.equal(identity.CreationDate, owner.creationDate);
    assert.ok(identity.CommandLine.includes(marker));
    clearInterval(heartbeat);
    assert.ok(ticks > 0, "native queries must not block the Node/Electron main loop");
    console.log(JSON.stringify({ passed: true, nativeQueryMs: Math.round(performance.now() - start), heartbeatTicks: ticks,
      listenerMatched: true, creationDateMatched: true, target: "owned-disposable-child-only" }));
  } finally {
    clearTimeout(deadline);
    clearInterval(heartbeat);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
