"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harness-computer-use-account-"));
  const userData = path.join(tmp, "user-data");
  const sourceRoot = path.resolve(__dirname, "..", "..");
  const skillPath = path.join(sourceRoot, "bundled-plugins", "computer-use", "skills", "computer-use", "SKILL.md");
  const browserSkillPath = path.join(sourceRoot, "bundled-plugins", "browser-use", "skills", "browser-use", "SKILL.md");
  fs.mkdirSync(userData, { recursive: true });

  const previousEnv = { CODEX_HOME: process.env.CODEX_HOME };
  process.env.CODEX_HOME = path.join(tmp, "must-not-own-provider-skills");

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "electron") {
      return { app: { isPackaged: false, getPath: () => userData } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const accountContext = require("../src/account-context");
    const skills = require("../src/skills");
    Module._load = originalLoad;

    const a = { id: "a".repeat(32), dataDir: path.join(tmp, "account-a") };
    const b = { id: "b".repeat(32), dataDir: path.join(tmp, "account-b") };
    const workspace = path.join(tmp, "workspace");
    fs.mkdirSync(workspace, { recursive: true });

    await accountContext.run(a, async () => {
      assert.equal((await skills.setComputerUseEnabled(true)).enabled, true);
      assert.equal((await skills.setBrowserUseEnabled(true)).enabled, true);
      const catalog = await skills.catalog(workspace);
      assert.equal(catalog.computerUse.available, true);
      assert.equal(catalog.computerUse.enabled, true);
      assert.equal(path.resolve(catalog.computerUse.path), path.resolve(skillPath));
      assert.equal(catalog.browserUse.available, true);
      assert.equal(catalog.browserUse.enabled, true);
      assert.equal(path.resolve(catalog.browserUse.path), path.resolve(browserSkillPath));
      assert.ok(catalog.configPath.startsWith(path.join(a.dataDir, "runtime")));
    });
    await accountContext.run(b, async () => {
      assert.equal((await skills.setComputerUseEnabled(false)).enabled, false);
      assert.equal((await skills.setBrowserUseEnabled(false)).enabled, false);
      const catalog = await skills.catalog(workspace);
      assert.equal(catalog.computerUse.available, true, "bundled provider must remain discoverable for another isolated account");
      assert.equal(catalog.computerUse.enabled, false);
      assert.equal(catalog.browserUse.available, true);
      assert.equal(catalog.browserUse.enabled, false);
      assert.ok(catalog.configPath.startsWith(path.join(b.dataDir, "runtime")));
    });

    const configA = path.join(a.dataDir, "runtime", "profiles", "plugins.json");
    const configB = path.join(b.dataDir, "runtime", "profiles", "plugins.json");
    assert.equal(JSON.parse(fs.readFileSync(configA, "utf8")).computer_use.enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(configB, "utf8")).computer_use.enabled, false);
    assert.equal(JSON.parse(fs.readFileSync(configA, "utf8")).browser_use.enabled, true);
    assert.equal(JSON.parse(fs.readFileSync(configB, "utf8")).browser_use.enabled, false);
    assert.notEqual(path.resolve(configA), path.resolve(configB));

    await accountContext.run(a, async () => {
      assert.equal((await skills.setComputerUseEnabled(false)).enabled, false);
      assert.equal((await skills.catalog(workspace)).computerUse.enabled, false);
      assert.equal((await skills.setComputerUseEnabled(true)).enabled, true);
      assert.equal((await skills.catalog(workspace)).computerUse.enabled, true);
      assert.equal((await skills.setBrowserUseEnabled(false)).enabled, false);
      assert.equal((await skills.setBrowserUseEnabled(true)).enabled, true);
      assert.equal((await skills.catalog(workspace)).browserUse.enabled, true);
    });
    assert.equal(JSON.parse(fs.readFileSync(configB, "utf8")).computer_use.enabled, false, "account A toggle must not modify account B");
    assert.equal(JSON.parse(fs.readFileSync(configB, "utf8")).browser_use.enabled, false, "account A Browser toggle must not modify account B");
    console.log("COMPUTER_AND_BROWSER_USE_ACCOUNT_ISOLATION_PASS");
  } finally {
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
