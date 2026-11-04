import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { archiveBrowserRuntime } from "./lib/browser-runtime-archive.mjs";

const require = createRequire(import.meta.url);
const { MANIFEST_NAME, validatePayload } = require("../src/payload-manifest.js");
const root = path.resolve(process.env.HARNESS_TEST_TMP_ROOT || path.join(os.tmpdir(), "chatgpt-web-harness"), `.codex-tmp`, `payload-manifest-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
const harness = path.join(root, "harness");
const tunnelFixture = "MZ-test-tunnel-client\n";

const files = {
  "bin/tunnel-client.exe": tunnelFixture,
  "third-party/tunnel-client/PROVENANCE.json": JSON.stringify({
    derived_executable_size: Buffer.byteLength(tunnelFixture),
    derived_executable_sha256: crypto.createHash("sha256").update(tunnelFixture).digest("hex"),
  }) + "\n",
  "dist/index.js": "index\n",
  "dist/lib/plugin-config.js": "plugin\n",
  "dist/lib/skill-installer.js": "installer\n",
  "dist/lib/skill-resolver.js": "resolver\n",
  "dist/lib/computer-use-provider.js": "computer provider\n",
  "dist/lib/browser-use-provider.js": "browser provider\n",
  "bundled-plugins/computer-use/manifest.json": "{}\n",
  "bundled-plugins/computer-use/windows-action.ps1": "Write-Output ok\n",
  "bundled-plugins/browser-use/manifest.json": "{}\n",
  "bundled-plugins/browser-use/runtime-lock.json": "{}\n",
  "vendor/browser-use/python/python.exe": "MZ-python\n",
  "vendor/browser-use/site-packages/browser_use/__init__.py": "# browser use\n",
  "vendor/browser-use/site-packages/browser_harness/__init__.py": "# browser harness\n",
  "vendor/browser-use/chrome/chrome-win64/chrome.exe": "MZ-chrome\n",
  "vendor/browser-use/provenance.json": "{}\n",
  "vendor/browser-use/SBOM.spdx.json": "{}\n",
  "vendor/browser-use/licenses/Browser-Use-LICENSE.txt": "MIT\n",
  "vendor/browser-use/licenses/Browser-Harness-LICENSE.txt": "MIT\n",
  "vendor/browser-use/licenses/Python-LICENSE.txt": "Python\n",
  "vendor/browser-use/licenses/Chrome-for-Testing-NOTICE.txt": "Chrome\n",
  "node_modules/express/package.json": "{}\n",
  "package.json": "{\"type\":\"module\"}\n",
  "profiles/mcp-upstream.json": "{\"version\":1,\"servers\":[]}\n",
  "profiles/plugins.json": "{\"schema_version\":2,\"skills\":[]}\n",
};

async function writeManifest() {
  const entries = Object.entries(files).map(([file, content]) => ({
    path: file,
    bytes: Buffer.byteLength(content),
  })).sort((a, b) => a.path.localeCompare(b.path));
  await fs.writeFile(path.join(harness, MANIFEST_NAME), JSON.stringify({
    schema_version: 1,
    file_count: entries.length,
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    files: entries,
  }, null, 2) + "\n", "utf8");
}

try {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(harness, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
  await writeManifest();
  assert.deepEqual(validatePayload(harness), {
    file_count: Object.keys(files).length,
    total_bytes: Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content), 0),
  });
  const tunnelFile = path.join(harness, "bin", "tunnel-client.exe");
  await fs.writeFile(tunnelFile, "ZZ-test-tunnel-client\n", "utf8");
  assert.throws(() => validatePayload(harness), /Tunnel client integrity mismatch/);
  await fs.writeFile(tunnelFile, tunnelFixture, "utf8");
  await fs.rm(tunnelFile);
  assert.throws(() => validatePayload(harness), /缺少关键运行模块|解包不完整/);
  await fs.writeFile(tunnelFile, tunnelFixture, "utf8");
  await fs.rm(path.join(harness, "dist", "lib", "plugin-config.js"));
  assert.throws(() => validatePayload(harness), /解包不完整|缺少文件|关键运行模块/);
  console.log("PASS payload manifest rejects an incomplete extracted tree");
  await fs.writeFile(path.join(harness, "dist", "lib", "plugin-config.js"), files["dist/lib/plugin-config.js"]);
  const archived = archiveBrowserRuntime(harness, { desktopRoot: path.resolve(import.meta.dirname, "..") });
  for (const file of Object.keys(files)) if (file.startsWith("vendor/browser-use/")) delete files[file];
  const archivePath = "vendor/browser-use.runtime.zip", metadataPath = "vendor/browser-use.archive.json";
  files[archivePath] = await fs.readFile(path.join(harness, archivePath));
  files[metadataPath] = await fs.readFile(path.join(harness, metadataPath));
  await writeManifest();
  assert.equal(validatePayload(harness).file_count, Object.keys(files).length);
  const damaged = { ...archived, files: archived.files.filter(file => !file.path.toLowerCase().includes("licenses/python-license")) };
  damaged.file_count = damaged.files.length;
  damaged.total_bytes = damaged.files.reduce((sum, file) => sum + file.bytes, 0);
  files[metadataPath] = JSON.stringify(damaged);
  await fs.writeFile(path.join(harness, metadataPath), files[metadataPath]);
  await writeManifest();
  assert.throws(() => validatePayload(harness), /lacks critical file/);
  delete files[metadataPath];
  await fs.rm(path.join(harness, metadataPath));
  await writeManifest();
  assert.throws(() => validatePayload(harness), /requires both archive and metadata/);
  console.log("PASS deferred archive validates physical inventory and requires metadata plus license declarations; legacy expanded payload remains supported");
} finally {
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}
