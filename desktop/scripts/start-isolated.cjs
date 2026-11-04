"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { isolatedEnvironment } = require("../src/isolated-runtime");

function launchSpec(root = path.resolve(__dirname, "../.."), inheritedEnv = process.env) {
  root = path.resolve(root);
  const desktop = path.join(root, "desktop");
  const userData = path.join(desktop, ".isolated", "chatgpt-web-harness-isolated");
  const env = isolatedEnvironment(inheritedEnv, path.join(userData, "runtime"));
  return {
    executable: path.join(desktop, "node_modules", "electron", "dist", "electron.exe"),
    args: [desktop, `--user-data-dir=${userData}`],
    cwd: desktop, userData, env,
  };
}

if (require.main === module) {
  const spec = launchSpec();
  if (!fs.existsSync(spec.executable)) {
    console.error("隔离版 Electron 依赖不存在，请先在 desktop 中安装锁定的依赖。");
    process.exitCode = 1;
  } else {
    fs.mkdirSync(spec.userData, { recursive: true });
    const child = spawn(spec.executable, spec.args, {
      cwd: spec.cwd, env: spec.env, windowsHide: true, detached: true, stdio: "ignore",
    });
    child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
    child.unref();
  }
}

module.exports = { launchSpec };
