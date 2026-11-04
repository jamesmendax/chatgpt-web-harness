"use strict";
// Read-only verification of the two deliverable EXEs. No install or publishing.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const dir = path.resolve(process.argv[2] || path.join(desktop, "release-" + version));
const prefix = "ChatGPT Web Harness Isolated-" + version;
const expectedNames = new Set([prefix + "-setup.exe", prefix + "-portable.exe"]);
const checksumFile = path.join(dir, "SHA256SUMS.txt");
const lines = fs.readFileSync(checksumFile, "utf8").trim().split(/\r?\n/);
assert.equal(lines.length, 2, "Candidate must declare exactly two delivery EXEs");
async function sha256(file) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const input = fs.createReadStream(file);
    input.on("data", chunk => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
(async () => {
  const observed = new Set();
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+\.exe)$/i);
    assert.ok(match, "Invalid SHA256SUMS.txt line");
    const [, checksum, name] = match;
    assert.ok(expectedNames.has(name) && path.basename(name) === name, "Unrecognized package filename");
    assert.ok(!observed.has(name), "Duplicate checksum entry");
    observed.add(name);
    const file = path.join(dir, name);
    assert.ok(fs.statSync(file).isFile(), "Not an ordinary file");
    const actual = await sha256(file);
    assert.equal(actual, checksum.toLowerCase(), "Checksum mismatch for " + name);
    console.log("PASS " + name + " sha256=" + actual);
  }
  assert.deepEqual(observed, expectedNames, "Missing package checksum");
  console.log("CANDIDATE_SHA256_PASS version=" + version + " packages=2");
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
