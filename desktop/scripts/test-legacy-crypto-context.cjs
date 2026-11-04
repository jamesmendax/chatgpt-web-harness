"use strict";
// Synthetic-only Electron OSCrypt profile-context probe. Never reads a user profile.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
if (process.argv[2] === "__child") {
  const { app, safeStorage } = require("electron");
  const [mode, profilePath, cipherFile] = process.argv.slice(3);
  fs.mkdirSync(profilePath, { recursive: true });
  app.setPath("userData", profilePath);
  const finish = (code, label) => { console.log(label); setTimeout(() => app.exit(code), 500); };
  app.whenReady().then(() => {
    assert.ok(safeStorage.isEncryptionAvailable(), "Native encryption unavailable");
    if (mode === "encrypt") {
      fs.writeFileSync(cipherFile, safeStorage.encryptString("synthetic-key-nonsecret").toString("base64"));
      finish(0, "PASS fixture encrypted");
    } else {
      const data = Buffer.from(fs.readFileSync(cipherFile, "utf8"), "base64");
      let matched = false;
      try { matched = safeStorage.decryptString(data) === "synthetic-key-nonsecret"; } catch { /* normal wrong context */ }
      if (mode === "probe") finish(0, "PROBE " + (matched ? "MATCH" : "REJECT"));
      else finish(matched ? 0 : 3, matched ? "PASS decryption matched" : "FAIL expected matching key");
    }
  }).catch(e => { console.error(e.message); app.exit(1); });
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wh-synthetic-crypto-"));
  const source = path.join(root,"source"), target = path.join(root,"target");
  const copied = path.join(root,"source-context-copy"), cipher = path.join(root,"cipher.txt");
  const electronPath = require("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const run = (mode, dir) => {
    const child = spawnSync(electronPath, [__filename, "__child", mode, dir, cipher], {
      cwd: path.dirname(__filename), env, encoding: "utf8", windowsHide: true, timeout: 45000
    });
    assert.equal(child.status, 0, mode+" failed: "+String(child.stderr || child.stdout).slice(0,800));
    return String(child.stdout || "");
  };
  try {
    run("encrypt", source);
    const cross = run("probe",target).includes("PROBE MATCH");
    const hasLocalState = fs.existsSync(path.join(source,"Local State"));
    let cloneWorks = null;
    if (hasLocalState) {
      fs.mkdirSync(copied,{recursive:true});
      fs.copyFileSync(path.join(source,"Local State"),path.join(copied,"Local State"));
      cloneWorks = run("probe",copied).includes("PROBE MATCH");
    }
    assert.ok(run("probe",source).includes("PROBE MATCH"), "original profile did not decrypt its fixture");
    console.log(JSON.stringify({test:"synthetic safeStorage context",crossProfileCanDecrypt:cross,localStatePresent:hasLocalState,clonedLocalStateCanDecrypt:cloneWorks}));
  } finally {
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:300});
  }
}
