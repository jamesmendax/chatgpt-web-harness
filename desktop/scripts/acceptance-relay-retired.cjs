"use strict";
// Offline package acceptance only. Never execute either EXE or touch user data.
process.noAsar = true;
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const asar = require("@electron/asar");
const desktop = path.resolve(__dirname, "..");
const repo = path.resolve(desktop, "..");
const version = require("../package.json").version;
const release = path.resolve(process.argv[2] || process.env.HARNESS_RELEASE_ROOT ||
  path.join(desktop, "release-" + version));
const executable = "ChatGPT Web Harness Isolated-" + version;
function read(file) { assert.ok(fs.existsSync(file), "Missing: " + file); return fs.readFileSync(file); }
async function pe(name) {
  const file = path.join(release, name);
  const stat = fs.statSync(file);
  assert.ok(stat.isFile() && stat.size > 5 * 1024 * 1024, "Invalid Windows executable: " + file);
  const fd = fs.openSync(file, "r");
  const mz = Buffer.alloc(2);
  try { assert.equal(fs.readSync(fd, mz, 0, 2, 0), 2); }
  finally { fs.closeSync(fd); }
  assert.equal(mz.toString("ascii"), "MZ", "Missing PE header");
  const hash = await new Promise((resolve, reject) => {
    const digest = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", chunk => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
  return { name, size: stat.size, sha256: hash };
}
(async () => {
  assert.equal(JSON.parse(read(path.join(repo, "package.json"))).version, version);
  const unpacked = path.join(release, "win-unpacked", "resources");
  const harness = path.join(unpacked, "harness");
  const dist = path.join(harness, "dist");
  const archive = path.join(unpacked, "app.asar");
  const files = asar.listPackage(archive).map(s => s.replaceAll("\\", "/"));
  assert.ok(!files.some(s => /\/src\/companion-[^/]+\.js$/.test(s)),
    "Obsolete Companion JS must not ship in desktop asar");
  assert.equal(fs.existsSync(path.join(unpacked, "browser-companion")), false,
    "Obsolete extension files must not ship");
  assert.equal(fs.existsSync(path.join(dist, "admin", "companion.js")), false,
    "Obsolete Companion HTTP router must not ship");
  for (const rel of ["index.js","lib/skill-routing.js","lib/skills-loader.js",
      "tools/context.js","lib/driver-lease.js","tools/goal.js"]) {
    assert.ok(fs.statSync(path.join(dist, ...rel.split("/"))).isFile(), "Required runtime missing: " + rel);
  }
  const gateway = read(path.join(dist, "tools", "context.js")).toString("utf8");
  assert.ok(gateway.includes("route_skills"), "Task-driven Skill tool absent in real candidate");
  const index = read(path.join(dist, "index.js")).toString("utf8");
  assert.ok(!index.includes("startRelayAutomation"), "Relay automation still starts");
  const admin = read(path.join(dist, "admin", "server.js")).toString("utf8");
  assert.ok(!admin.includes('app.use("/companion/v'), "Companion HTTP still mounted");
  const renderer = asar.extractFile(archive, path.join("renderer", "v3", "aura", "app.js")).toString("utf8");
  assert.ok(!renderer.includes('chapter("relay"'), "Retired UI section present");
  for (const rel of ["bundled-plugins/browser-use/manifest.json",
    "bundled-plugins/computer-use/manifest.json",
    "skills/anthropic-official-skills/SKILL.md"]) {
    assert.ok(fs.existsSync(path.join(harness, ...rel.split("/"))), "Required provider/Skill missing: " + rel);
  }
  const registry = JSON.parse(read(path.join(harness, "profiles", "plugins.json")));
  assert.deepEqual(registry.skills, [], "Private installed Skills were staged");
  const mcp = JSON.parse(read(path.join(harness, "profiles", "mcp-upstream.json")));
  assert.deepEqual(mcp.servers, [], "Private MCP servers were staged");
  const harnessVersion = JSON.parse(read(path.join(harness, "harness-version.json")));
  assert.equal(harnessVersion.harness_version, version);
  assert.equal(asar.extractFile(archive,"package.json").length > 0, true);
  const setup = await pe(executable + "-setup.exe");
  const portable = await pe(executable + "-portable.exe");
  console.log(JSON.stringify({
    result: "OFFLINE_RELAY_RETIRED_PACKAGE_PASS", version, release,
    setup, portable, browserCompanionPackaged: false, routeSkillsPackaged: true,
    providersPreserved: true, personalProfilesPackaged: false,
    installerLaunched: false, realWebSkillTrials: false, userAccountsTouched: false,
  }, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
