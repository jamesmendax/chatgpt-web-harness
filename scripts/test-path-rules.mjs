import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPathRulesForFile } from "../dist/lib/path-rules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(path.resolve(__dirname, ".."), ".tool-test-tmp", "path-rules");
const target = path.join(root, "src", "components", "app.ts");

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.dirname(target), { recursive: true });
await fs.mkdir(path.join(root, ".claude", "rules"), { recursive: true });
await fs.writeFile(path.join(root, "AGENTS.md"), "# Root\nUse service boundaries.\n");
await fs.writeFile(path.join(root, "src", "AGENTS.md"), "# Source\nUse TypeScript strict mode.\n");
await fs.writeFile(target, "export const value = 1;\n");
await fs.writeFile(
  path.join(root, ".claude", "rules", "typescript.md"),
  "---\npaths:\n  - src/**/*.ts\n---\nRun the focused TypeScript test after edits.\n"
);

const rules = await loadPathRulesForFile(root, target);
assert.deepEqual(
  rules.filter((rule) => rule.kind === "directory_instruction").map((rule) => path.basename(path.dirname(rule.path))),
  ["path-rules", "src"]
);
assert.ok(rules.some((rule) => rule.kind === "path_rule" && rule.content.includes("focused TypeScript")));
assert.ok(rules.find((rule) => rule.path.endsWith(path.join("src", "AGENTS.md"))).depth > 0);

const unrelated = path.join(root, "docs", "guide.md");
await fs.mkdir(path.dirname(unrelated), { recursive: true });
await fs.writeFile(unrelated, "# Guide\n");
const unrelatedRules = await loadPathRulesForFile(root, unrelated);
assert.ok(!unrelatedRules.some((rule) => rule.kind === "path_rule"));

await fs.rm(root, { recursive: true, force: true });
console.log("path-rules: nested instruction precedence and relative glob matching OK");