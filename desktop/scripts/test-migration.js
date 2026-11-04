"use strict";
const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clc-migration-"));
app.setPath("userData", tmp);
process.env.CLC_RUNTIME_DIR = path.join(tmp, "runtime");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const paths = require("../src/paths");
  const runtime = paths.runtimeDir();
  const profiles = path.join(runtime, "profiles");
  const installed = path.join(profiles, "local-skills");
  const presentation = path.join(installed, "presentation");
  const external = path.join(tmp, "external", "SKILL.md");
  fs.mkdirSync(path.join(presentation), { recursive: true });
  write(path.join(presentation, "SKILL.md"), "---\nname: ppt-master\n---\n# presentation\n");
  write(external, "---\nname: outside\n---\n# external\n");

  // Reproduce a 0.1.0 seed without touching the real repository profile.
  const seed = path.join(installed, "archify");
  fs.mkdirSync(path.join(seed, ".git"), { recursive: true });
  write(path.join(seed, "archify.zip"), "seed");
  write(path.join(seed, "archify", "skill-release.json"), JSON.stringify({ skillId: "archify" }));
  write(path.join(profiles, "plugins.json"), JSON.stringify({
    computer_use: { enabled: false },
    browser_use: { enabled: false },
    skills: [
      { name: "archify-github", path: path.join(seed, "archify", "SKILL.md"), enabled: true },
      { name: "presentation", path: path.join(presentation, "SKILL.md"), enabled: false },
      { name: "missing", path: path.join(installed, "missing", "SKILL.md"), enabled: true },
      { name: "outside", path: external, enabled: true },
    ],
  }, null, 2));
  write(path.join(profiles, "mcp-upstream.json"), JSON.stringify({
    version: 1,
    servers: [
      { id: "ghidra-mcp", command: "node", cwd: "D:\\Coding\\private" },
      { id: "safe", command: "node", cwd: "relative" },
    ],
  }, null, 2));

  paths.ensureRuntimeDir();
  const migrated = readJson(path.join(profiles, "plugins.json"));
  if (migrated.schema_version !== 2) throw new Error("plugins registry did not migrate to v2");
  if (migrated.skills.some((row) => /archify/i.test(row.id || row.name))) throw new Error("archify registry row survived migration");
  if (migrated.skills.find((row) => row.id === "presentation")?.source !== "installed") throw new Error("installed row missing");
  if (migrated.skills.find((row) => row.id === "presentation")?.enabled !== false) throw new Error("enabled flag was not preserved");
  if (!migrated.skills.some((row) => row.source === "external" && row.id === "outside")) throw new Error("external row missing");
  if (migrated.skills.some((row) => row.id === "missing")) throw new Error("missing installed row should be dropped");
  if (!fs.existsSync(path.join(profiles, "plugins.json.v1.bak"))) throw new Error("v1 registry backup missing");
  if (fs.existsSync(seed)) throw new Error("recognized archify seed was not removed");
  const upstream = readJson(path.join(profiles, "mcp-upstream.json"));
  if (upstream.servers.some((row) => row.id === "ghidra-mcp")) throw new Error("path-bearing legacy upstream row survived");
  if (!upstream.servers.some((row) => row.id === "safe")) throw new Error("safe upstream row was removed");
  if (!fs.existsSync(path.join(profiles, ".seed-manifest.json"))) throw new Error("seed manifest missing");

  const configFile = path.join(tmp, "config.json");
  write(configFile, JSON.stringify({ tunnelId: "keep-me" }));
  const beforeSkill = fs.readFileSync(path.join(presentation, "SKILL.md"), "utf8");
  const reset = paths.resetRuntimeProfiles();
  if (readJson(reset.plugins).skills.length !== 0 || readJson(reset.upstream).servers.length !== 0) throw new Error("profile reset did not restore defaults");
  if (fs.readFileSync(path.join(presentation, "SKILL.md"), "utf8") !== beforeSkill) throw new Error("profile reset deleted installed Skill");
  if (!fs.readdirSync(profiles).some((name) => name.includes("reset-") && name.endsWith(".bak"))) throw new Error("profile reset backup missing");
  if (readJson(configFile).tunnelId !== "keep-me") throw new Error("profile reset touched config.json");

  console.log("migration: v1 registry/upstream migration, archify seed cleanup, manifest, reset backups and data boundaries OK");
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
}

app.whenReady().then(() => main().catch((error) => {
  console.error("migration FAIL", error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(1);
}));
