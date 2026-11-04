#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve("src");
const toPosix = (value) => value.replaceAll("\\", "/");
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && full.endsWith(".ts")) out.push(path.resolve(full));
  }
  return out;
}
function resolveImport(file, spec) {
  if (!spec.startsWith(".")) return null;
  let target = path.resolve(path.dirname(file), spec);
  target = target.replace(/\.js$/i, ".ts");
  if (!path.extname(target)) target += ".ts";
  return target;
}

const files = walk(root);
const fileSet = new Set(files);
const graph = new Map();
const importsByFile = new Map();
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  // Type-only imports disappear from emitted JavaScript and therefore cannot
  // form runtime initialization cycles. The gate tracks runtime edges only.
  const runtimeSource = source.replace(/import\s+type\b[\s\S]*?\bfrom\s*["'][^"']+["']\s*;?/g, "");
  const specs = [
    ...runtimeSource.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...runtimeSource.matchAll(/\bimport\s*["']([^"']+)["']/g),
    ...runtimeSource.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]);
  importsByFile.set(file, specs);
  graph.set(file, specs.map((spec) => resolveImport(file, spec)).filter((value) => value && fileSet.has(value)));
}

const violations = [];
for (const [file, deps] of graph) {
  const rel = toPosix(path.relative(root, file));
  for (const dep of deps) {
    const depRel = toPosix(path.relative(root, dep));
    if (rel.startsWith("tools/") && depRel.startsWith("tools/")) {
      violations.push(`tool-to-tool dependency: ${rel} -> ${depRel}`);
    }
    if (rel.startsWith("lib/") && (depRel.startsWith("tools/") || depRel === "server-factory.ts" || depRel === "index.ts")) {
      violations.push(`lib depends upward: ${rel} -> ${depRel}`);
    }
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = [];
function dfs(file) {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.push([...stack.slice(start), file].map((item) => toPosix(path.relative(root, item))).join(" -> "));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const dep of graph.get(file) ?? []) dfs(dep);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
}
for (const file of files) dfs(file);
for (const cycle of [...new Set(cycles)]) violations.push(`import cycle: ${cycle}`);

const serverFactory = fs.readFileSync(path.join(root, "server-factory.ts"), "utf8");
assert.match(serverFactory, /setDefaultCwd\(workspaceRoot\)/, "composition root must configure default cwd");
assert.match(serverFactory, /setAllowedRoots\(/, "composition root must configure allowed roots");
assert.match(serverFactory, /setFullDiskAccess\(fullDiskAccess\)/, "composition root must configure disk access policy");

const browserTool = fs.readFileSync(path.join(root, "tools", "browser.ts"), "utf8");
assert.match(browserTool, /rebindBrowserPageToTarget/, "browser tool must use shared same-target rebind service");
assert.match(browserTool, /saveBrowserTurnCheckpoint/, "browser turn must persist rolling checkpoint");
assert.match(browserTool, /resubmit_allowed/, "browser tool must expose no-replay fence result");
const browserFence = fs.readFileSync(path.join(root, "lib", "browser-turn-fence.ts"), "utf8");
assert.match(browserFence, /resubmit_allowed:\s*false/, "browser fence must hard-code no blind replay");

const shellTool = fs.readFileSync(path.join(root, "tools", "shell.ts"), "utf8");
assert.match(shellTool, /process-control\.js/, "shell tool must use durable process-control service");
assert.match(shellTool, /"process_input"/, "shell surface must expose stdin via process_input");
const host = fs.readFileSync(path.join(root, "process-host.ts"), "utf8");
assert.doesNotMatch(host, /from\s+["']\.\/tools\//, "detached process host may depend only on shared services, not MCP tools");

const codeTool = fs.readFileSync(path.join(root, "tools", "code-intelligence.ts"), "utf8");
assert.match(codeTool, /lsp-adapter\.js/, "semantic tool must own optional LSP integration");
for (const file of files) {
  const rel = toPosix(path.relative(root, file));
  if (rel === "tools/code-intelligence.ts" || rel === "lib/lsp-adapter.ts") continue;
  const source = fs.readFileSync(file, "utf8");
  if (/lsp-adapter\.js/.test(source)) violations.push(`LSP leaked into unrelated subsystem: ${rel}`);
}
for (const forbidden of ["lib/goal-run-store.ts", "lib/goal-run-policy.ts", "lib/goal-run-state.ts", "lib/operation-journal.ts", "lib/mcp-session-manager.ts"]) {
  const full = path.join(root, forbidden);
  if (fs.existsSync(full)) assert.doesNotMatch(fs.readFileSync(full, "utf8"), /lsp-adapter|typescript-language-service/, `${forbidden} must not depend on semantic backend`);
}

const contextTool = fs.readFileSync(path.join(root, "tools", "context.ts"), "utf8");
assert.doesNotMatch(contextTool, /from\s+["']\.\/(browser|shell)\.js["']/, "context tool must not import sibling tool modules");
assert.match(contextTool, /runtime-status-registry\.js/, "context tool must use runtime status registry");

if (violations.length) {
  console.error("ARCHITECTURE VIOLATIONS");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

const edgeCount = [...graph.values()].reduce((sum, deps) => sum + deps.length, 0);
const modules = {
  entrypoints: files.filter((file) => ["index.ts", "server-factory.ts", "process-host.ts"].includes(path.basename(file))).length,
  tools: files.filter((file) => toPosix(path.relative(root, file)).startsWith("tools/")).length,
  lib: files.filter((file) => toPosix(path.relative(root, file)).startsWith("lib/")).length,
  admin: files.filter((file) => toPosix(path.relative(root, file)).startsWith("admin/")).length,
};
console.log(`architecture PASS: ${files.length} TS modules, ${edgeCount} internal edges, 0 cycles, 0 tool-to-tool imports`);
console.log(`layers: ${JSON.stringify(modules)}; policy in server-factory; durable process/browser state in lib; optional LSP isolated to semantic tool`);
