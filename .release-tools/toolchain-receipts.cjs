"use strict";
const fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto"), assert=require("node:assert/strict"), {spawnSync}=require("node:child_process");
const sha=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function toolchain(repo,node) {
  const files=["node_modules/typescript/package.json","node_modules/typescript/lib/_tsc.js","desktop/node_modules/electron-builder/package.json","desktop/node_modules/electron-builder/out/cli/cli.js"];
  const version=spawnSync(node,["--version"],{encoding:"utf8",windowsHide:true});
  if(version.status!==0)throw new Error("Cannot identify Node toolchain");
  return {node_version:version.stdout.trim(), node_sha256:sha(node), files:files.map(file=>({path:file,sha256:sha(path.join(repo,file))}))};
}
function assertReceipts(report,repo,node,expectedMode) {
  assert.ok(["root", "desktop"].includes(report.mode), "Unrecognized verification mode");
  if (expectedMode) assert.equal(report.mode, expectedMode, "Verification report mode differs");
  assert.deepEqual(report.toolchain,toolchain(repo,node),"Regression toolchain differs from current build toolchain");
  for(const row of report.results || []) {
    assert.match(row.log_sha256 || "",/^[a-f0-9]{64}$/,`Missing test log hash: ${row.name}`);
    assert.equal(sha(row.log),row.log_sha256,`Test log changed: ${row.name}`);
  }
  if(report.mode === "root") {
    const root=(report.results||[]).find(row=>row.name==="root-all");
    assert.ok(Array.isArray(root?.tests) && root.tests.length>0 && root.tests.every(row=>row.exit_code===0),"Full per-test receipts are missing");
    const result=spawnSync(node,["--input-type=module","-e",'import {fullTests} from "./scripts/active-test-manifest.mjs"; console.log(JSON.stringify(fullTests));'],{cwd:repo,encoding:"utf8",windowsHide:true});
    if(result.status!==0) throw new Error(`Cannot read active test manifest: ${result.error || result.stderr}`);
    const expected=JSON.parse(result.stdout).map(test=>({test,exit_code:0}));
    const logged=fs.readFileSync(root.log,"utf8").split(/\r?\n/).filter(line=>line.startsWith("TEST_RECEIPT ")).map(line=>JSON.parse(line.slice("TEST_RECEIPT ".length)));
    assert.deepEqual(root.tests,expected,"Root report does not cover the complete active manifest");
    assert.deepEqual(logged,expected,"Root log does not cover the complete active manifest");
  }
}
module.exports={toolchain,assertReceipts};
