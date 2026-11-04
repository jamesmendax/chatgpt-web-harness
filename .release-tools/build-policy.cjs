"use strict";
// Deliberate retirement boundary shared by staging and candidate verification.
// All other emitted files are required; this is not a missing-file allowlist.
const retiredDist = new Set(["admin/companion.js", "admin/companion.d.ts"]);
function includeDist(relative) { return !retiredDist.has(String(relative).replaceAll("\\", "/")); }
function includeDesktop(relative) { return !/^src\/companion-[^/]+\.js$/i.test(String(relative).replaceAll("\\", "/")); }
function includeProfile(relative) {
  const rel = String(relative).replaceAll("\\", "/");
  if (!rel) return true;
  const top = rel.split("/")[0].toLowerCase();
  return !(top === "local-skills" || /^plugins\.json(?:\.|$)/i.test(top) || /^mcp-upstream\.json(?:\.|$)/i.test(top) || top === ".seed-manifest.json" || (!rel.includes("/") && /\.ya?ml$/i.test(rel)));
}
function transformDist(relative, bytes) {
  if (!relative.endsWith(".js")) return bytes;
  return Buffer.from(bytes.toString("utf8").replaceAll("@modelcontextprotocol/sdk", "mcp-sdk").replaceAll('"playwright-core"', '"pw"').replaceAll("'playwright-core'", "'pw'"));
}
function assertDistMatches(sourceRoot, packagedRoot, { packaged = true } = {}) {
  const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), crypto = require("node:crypto");
  const list = root => {
    const out=[];
    function walk(dir) { for (const e of fs.readdirSync(dir,{withFileTypes:true})) {
      const f=path.join(dir,e.name);
      if(e.isSymbolicLink()) throw new Error(`Linked build output: ${f}`);
      if(e.isDirectory()) walk(f); else if(e.isFile()) out.push(path.relative(root,f).replaceAll("\\", "/")); else throw new Error(`Unsupported build output: ${f}`);
    }} walk(root); return out.sort();
  };
  const expected=list(sourceRoot).filter(name => !packaged || includeDist(name));
  const actual=list(packagedRoot).filter(name=>name !== "build-manifest.json");
  assert.deepEqual(actual,expected,"Packaged dist inventory differs from fresh compilation or includes retired files");
  for (const rel of expected) {
    const digest = x => crypto.createHash("sha256").update(x).digest("hex");
    const source = fs.readFileSync(path.join(sourceRoot,rel));
    assert.equal(digest(fs.readFileSync(path.join(packagedRoot,rel))),digest(packaged ? transformDist(rel,source) : source),`Build dist is stale: ${rel}`);
  }
}
function readAsarFile(archive, relative) {
  const path = require("node:path");
  // @electron/asar traverses directory components using the native separator.
  const native = String(relative).replaceAll("\\", "/").split("/").join(path.sep);
  return require("../desktop/node_modules/@electron/asar").extractFile(archive, native);
}
module.exports = { retiredDist, includeDist, includeDesktop, includeProfile, transformDist, assertDistMatches, readAsarFile };
