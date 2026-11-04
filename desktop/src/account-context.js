"use strict";
// Immutable per-operation identity. Never store the selected UI account in process.env
// or mutate Electron's global userData while another account is running.
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const storage = new AsyncLocalStorage();
const ID_RE = /^(?:default|[a-f0-9]{32})$/;

function current() { return storage.getStore() || null; }
function run(scope, fn) {
  if (!scope || !ID_RE.test(scope.id) || !path.isAbsolute(scope.dataDir)) {
    throw new Error("无效的账号运行上下文。");
  }
  return storage.run(Object.freeze({ ...scope }), fn);
}
function bind(scope, fn) {
  return function (...args) { return run(scope, () => fn.apply(this, args)); };
}
function assertUnlinked(target) {
  let cursor = path.resolve(target);
  for (;;) {
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("账号数据目录不能经过符号链接或 junction。");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return path.resolve(target);
}
function dataDir(fallback) {
  const scope = current();
  return scope ? assertUnlinked(scope.dataDir) : fallback;
}
module.exports = { current, run, bind, dataDir, assertUnlinked, ID_RE };
