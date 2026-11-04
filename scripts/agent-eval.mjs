import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const manifestPath = path.join(repoRoot, "evals", "manifest.json");

function projectSlug(value) {
  return createHash("sha256").update(path.resolve(value)).digest("hex").slice(0, 12);
}

function defaultRunsRoot() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "projects", projectSlug(repoRoot), "eval-runs");
}

async function readManifest() {
  return JSON.parse(await fs.readFile(manifestPath, "utf-8"));
}

function parseArgs(argv) {
  const action = argv[0] || "list";
  const options = {};
  for (let index = 1; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index++;
    } else {
      options[key] = true;
    }
  }
  return { action, options };
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const filePath = path.join(root, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
  }
}

const fixtureBuilders = {
  async "code-fix"(root) {
    await writeFiles(root, {
      "package.json": `${JSON.stringify({ name: "eval-code-fix", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
      "src/pricing.mjs": `export function calculateInvoice(lines, discountPercent = 0, taxPercent = 0) {
  const subtotal = lines.reduce((sum, line) => sum + line.unit_cents * line.quantity, 0);
  const discount = Math.round(subtotal * discountPercent / 100);
  const tax = Math.round(subtotal * taxPercent / 100);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
`,
      "test/pricing.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { calculateInvoice } from "../src/pricing.mjs";

test("applies tax after discount using integer cents", () => {
  const lines = [{ unit_cents: 1000, quantity: 2 }, { unit_cents: 500, quantity: 1 }];
  assert.deepEqual(calculateInvoice(lines, 10, 8), {
    subtotal: 2500,
    discount: 250,
    tax: 180,
    total: 2430,
  });
});

test("does not mutate input", () => {
  const lines = [{ unit_cents: 199, quantity: 3 }];
  const before = structuredClone(lines);
  calculateInvoice(lines, 5, 7.5);
  assert.deepEqual(lines, before);
});

test("rejects invalid quantities and rates", () => {
  assert.throws(() => calculateInvoice([{ unit_cents: 100, quantity: 0 }]), RangeError);
  assert.throws(() => calculateInvoice([{ unit_cents: 100, quantity: 1.5 }]), RangeError);
  assert.throws(() => calculateInvoice([{ unit_cents: 100, quantity: 1 }], -1, 0), RangeError);
  assert.throws(() => calculateInvoice([{ unit_cents: 100, quantity: 1 }], 0, 101), RangeError);
});
`,
    });
  },

  async "cross-file-change"(root) {
    await writeFiles(root, {
      "package.json": `${JSON.stringify({ name: "eval-cross-file", private: true, type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
      "src/normalize-tag.mjs": `export function normalizeTag(value) {
  return String(value).trim();
}
`,
      "src/api.mjs": `export function createTagRecord(rawTag) {
  const tag = String(rawTag).trim().toLowerCase();
  return { tag, key: \`tag:\${tag}\` };
}
`,
      "src/cli.mjs": `export function tagFromCli(rawTag) {
  return String(rawTag).trim().replace(/\\s+/g, "-");
}
`,
      "README.md": `# Tag service

The API and CLI accept user supplied tags.
`,
      "test/tags.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTag } from "../src/normalize-tag.mjs";
import { createTagRecord } from "../src/api.mjs";
import { tagFromCli } from "../src/cli.mjs";

test("normalizes tags consistently", () => {
  assert.equal(normalizeTag("  Research   Notes "), "research-notes");
  assert.equal(createTagRecord("  Research   Notes ").tag, "research-notes");
  assert.equal(tagFromCli("  Research   Notes "), "research-notes");
});

test("rejects an empty normalized tag", () => {
  for (const fn of [normalizeTag, createTagRecord, tagFromCli]) {
    assert.throws(() => fn("   "), /empty/i);
  }
});
`,
    });
  },

  async "web-debug"(root) {
    await writeFiles(root, {
      "index.html": `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><title>Counter</title></head>
<body>
  <main>
    <h1>Counter</h1>
    <output id="count">0</output>
    <button id="add" type="button">Add</button>
    <button id="reset" type="button">Reset</button>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`,
      "app.js": `let count = "0";
const output = document.querySelector("#count");

document.querySelector("#add").addEventListener("click", () => {
  count += 1;
  output.textContent = count;
  console.error("counter-sync-failed");
});

document.querySelector("#reset").addEventListener("click", () => {
  count = 0;
});
`,
    });
  },

  async "docs-generation"(root) {
    await writeFiles(root, {
      "service.json": `${JSON.stringify({
        name: "harbor-worker",
        start_command: "node src/worker.mjs --config config/worker.json",
        health_command: "node scripts/healthcheck.mjs --once",
        log_path: "logs/harbor-worker.log",
        stop_command: "node scripts/stop-worker.mjs",
      }, null, 2)}\n`,
      "OPERATIONS_NOTES.md": `# Operations notes

- Run commands from the repository root.
- Recovery order: stop the worker, inspect the final 200 log lines, start the worker, then run the health command.
- Never paste tokens, API keys, or the contents of .env into tickets or chat.
- The worker is local-only. No public URL or cloud platform is defined here.
`,
      "src/worker.mjs": `console.log("worker fixture");\n`,
      "scripts/healthcheck.mjs": `console.log("healthy");\n`,
      "scripts/stop-worker.mjs": `console.log("stopped");\n`,
    });
  },

  async "visual-svg"(root) {
    await writeFiles(root, {
      "README.md": `Create the requested pure SVG in this directory.\n`,
    });
  },
};

function ignoredRelative(relative) {
  const normalized = relative.replace(/\\/g, "/");
  return (
    normalized === ".agent-eval.json" ||
    normalized === "eval-report.json" ||
    normalized === "eval-report.md" ||
    normalized.startsWith("artifacts/") ||
    normalized.startsWith("node_modules/") ||
    normalized.startsWith("coverage/") ||
    normalized.startsWith(".git/")
  );
}

async function snapshotFiles(root) {
  const output = {};
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, "/");
      if (ignoredRelative(relative)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const data = await fs.readFile(full);
        output[relative] = createHash("sha256").update(data).digest("hex");
      }
    }
  }
  await walk(root);
  return output;
}

function changedFiles(baseline, current) {
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])]
    .filter((name) => baseline[name] !== current[name])
    .sort();
}

async function prepareTask(task, options = {}) {
  const runsRoot = options.runsRoot || defaultRunsRoot();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `${task.id}-${timestamp}-${randomUUID().slice(0, 8)}`;
  const runDir = path.resolve(options.output || path.join(runsRoot, runId));

  try {
    const entries = await fs.readdir(runDir);
    if (entries.length && !options.force) throw new Error(`Output directory is not empty: ${runDir}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (options.force) await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(runDir, { recursive: true });
  await fixtureBuilders[task.id](runDir);
  await fs.writeFile(
    path.join(runDir, "TASK.md"),
    `# ${task.title}\n\n${task.prompt}\n\n## Run directory\n\n\`${runDir}\`\n`,
    "utf-8"
  );
  const baseline = await snapshotFiles(runDir);
  const metadata = {
    schema_version: 1,
    run_id: runId,
    task,
    created_at: new Date().toISOString(),
    baseline,
  };
  await fs.writeFile(path.join(runDir, ".agent-eval.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");
  return { runDir, metadata };
}

function runProcess(command, args, cwd, timeoutMs = 40_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, CI: "true", NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function check(id, label, points, passed, detail) {
  return { id, label, points, earned: passed ? points : 0, passed, detail: String(detail || "") };
}

function protectedUnchanged(metadata, current, files) {
  return files.every((file) => metadata.baseline[file] && metadata.baseline[file] === current[file]);
}

async function gradeCodeFix(runDir, metadata, current, changes) {
  const testRun = await runProcess(process.execPath, ["--test"], runDir);
  const implementation = await fs.readFile(path.join(runDir, "src", "pricing.mjs"), "utf-8").catch(() => "");
  const protectedOk = protectedUnchanged(metadata, current, ["test/pricing.test.mjs"]);
  return {
    checks: [
      check("tests-protected", "测试文件未被篡改", 20, protectedOk, protectedOk ? "unchanged" : "test/pricing.test.mjs changed"),
      check("tests-pass", "全部测试通过", 60, testRun.code === 0 && !testRun.timedOut, `${testRun.stdout}\n${testRun.stderr}`.trim().slice(-2000)),
      check("implementation", "实现被修复且未硬编码测试结果", 20, changes.includes("src/pricing.mjs") && !/2430|2500/.test(implementation), changes.join(", ")),
    ],
    artifacts: [],
  };
}

async function gradeCrossFile(runDir, metadata, current, changes) {
  const testRun = await runProcess(process.execPath, ["--test"], runDir);
  const api = await fs.readFile(path.join(runDir, "src", "api.mjs"), "utf-8").catch(() => "");
  const cli = await fs.readFile(path.join(runDir, "src", "cli.mjs"), "utf-8").catch(() => "");
  const readme = await fs.readFile(path.join(runDir, "README.md"), "utf-8").catch(() => "");
  const protectedOk = protectedUnchanged(metadata, current, ["test/tags.test.mjs"]);
  const shared = /normalizeTag/.test(api) && /normalizeTag/.test(cli) && /from\s+["']\.\/normalize-tag\.mjs["']/.test(api) && /from\s+["']\.\/normalize-tag\.mjs["']/.test(cli);
  const relevantChanges = changes.filter((file) => ["src/normalize-tag.mjs", "src/api.mjs", "src/cli.mjs", "README.md"].includes(file));
  return {
    checks: [
      check("tests-protected", "测试文件未被篡改", 15, protectedOk, protectedOk ? "unchanged" : "test/tags.test.mjs changed"),
      check("tests-pass", "全部测试通过", 45, testRun.code === 0 && !testRun.timedOut, `${testRun.stdout}\n${testRun.stderr}`.trim().slice(-2000)),
      check("shared-helper", "API 与 CLI 复用 normalizeTag", 20, shared, shared ? "shared import detected" : "duplicate or missing normalization path"),
      check("documentation", "README 说明规范化行为", 10, /lower|小写/i.test(readme) && /hyphen|连字符/i.test(readme) && /empty|空/i.test(readme), "README behavioral terms"),
      check("cross-file", "修改覆盖共享实现和两个调用方", 10, relevantChanges.filter((file) => file.startsWith("src/")).length >= 3, relevantChanges.join(", ")),
    ],
    artifacts: [],
  };
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : null,
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : null,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : null,
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("No Chromium/Edge executable found for web evaluation");
}

async function withBrowser(callback) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: await findBrowserExecutable(), headless: true });
  try {
    return await callback(browser);
  } finally {
    await browser.close();
  }
}

async function withStaticServer(root, callback) {
  const resolvedRoot = path.resolve(root);
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      const requested = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
      const filePath = path.resolve(resolvedRoot, `.${requested}`);
      const relative = path.relative(resolvedRoot, filePath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const data = await fs.readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();
      const contentType = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
      }[extension] || "application/octet-stream";
      response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      response.end(data);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Static eval server did not expose a TCP port");
    return await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function gradeWeb(runDir, metadata, current, changes) {
  const artifactsDir = path.join(runDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const screenshotPath = path.join(artifactsDir, "web-debug.png");
  let loaded = false;
  let addValue = "";
  let resetValue = "";
  let screenshotOk = false;
  const errors = [];
  let browserError = "";
  try {
    await withStaticServer(runDir, async (baseUrl) => {
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(`console: ${message.text()}`);
        });
        page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
        await page.goto(`${baseUrl}/index.html`, { waitUntil: "load" });
        loaded = await page.locator("#add").isVisible() && await page.locator("#reset").isVisible();
        await page.locator("#add").click();
        await page.locator("#add").click();
        addValue = (await page.locator("#count").textContent())?.trim() || "";
        await page.locator("#reset").click();
        resetValue = (await page.locator("#count").textContent())?.trim() || "";
        await page.screenshot({ path: screenshotPath, fullPage: true });
        screenshotOk = true;
        await page.close();
      });
    });
  } catch (error) {
    browserError = error instanceof Error ? error.message : String(error);
  }
  return {
    checks: [
      check("page-loads", "页面在真实浏览器中加载", 10, loaded, browserError || "controls visible"),
      check("increment", "Add 两次后为 2", 30, addValue === "2", `observed=${addValue || "<empty>"}`),
      check("reset", "Reset 恢复为 0", 20, resetValue === "0", `observed=${resetValue || "<empty>"}`),
      check("runtime-clean", "无 console error 或 page error", 25, loaded && errors.length === 0, errors.join(" | ") || browserError || "clean"),
      check("screenshot", "生成真实运行截图", 10, screenshotOk, screenshotOk ? screenshotPath : browserError),
      check("source-changed", "实际修复网页源文件", 5, changes.some((file) => file === "app.js" || file === "index.html"), changes.join(", ")),
    ],
    artifacts: screenshotOk ? [screenshotPath] : [],
  };
}

async function gradeDocs(runDir, metadata, current) {
  const runbookPath = path.join(runDir, "RUNBOOK.md");
  const runbook = await fs.readFile(runbookPath, "utf-8").catch(() => "");
  const headings = ["Overview", "Start", "Health Check", "Logs", "Recovery", "Safety"];
  const headingHits = headings.filter((heading) => new RegExp(`^#{1,6}\\s+${heading.replace(/ /g, "\\s+")}\\s*$`, "im").test(runbook));
  const exactFacts = [
    "node src/worker.mjs --config config/worker.json",
    "node scripts/healthcheck.mjs --once",
    "logs/harbor-worker.log",
  ];
  const recoveryFacts = ["node scripts/stop-worker.mjs", "200", "node scripts/healthcheck.mjs --once"];
  const forbidden = /kubernetes|aws|azure|gcp|https?:\/\/|99\.9%|24\/7|password\s*[:=]|api[_ -]?key\s*[:=]/i.test(runbook);
  const sourcesOk = protectedUnchanged(metadata, current, ["service.json", "OPERATIONS_NOTES.md"]);
  return {
    checks: [
      check("runbook", "创建 RUNBOOK.md", 10, Boolean(runbook.trim()), runbookPath),
      check("headings", "包含六个要求章节", 30, headingHits.length === headings.length, `${headingHits.length}/${headings.length}: ${headingHits.join(", ")}`),
      check("facts", "准确引用启动、健康检查和日志路径", 30, exactFacts.every((fact) => runbook.includes(fact)), exactFacts.filter((fact) => !runbook.includes(fact)).join(", ") || "all present"),
      check("recovery", "恢复顺序和安全要求来自来源文件", 20, recoveryFacts.every((fact) => runbook.includes(fact)) && /token|凭据|\.env/i.test(runbook), "stop/log/start/health and secret handling"),
      check("grounded", "来源未被修改且没有虚构外部环境", 10, sourcesOk && !forbidden, `${sourcesOk ? "sources unchanged" : "sources changed"}; ${forbidden ? "invented claim detected" : "grounded"}`),
    ],
    artifacts: runbook ? [runbookPath] : [],
  };
}

function parseSvgCircles(svg) {
  return [...svg.matchAll(/<circle\b([^>]*)>/gi)].map((match) => {
    const attrs = Object.fromEntries([...match[1].matchAll(/([:\w-]+)\s*=\s*["']([^"']+)["']/g)].map((entry) => [entry[1], entry[2]]));
    return { attrs, r: Number.parseFloat(attrs.r), cx: Number.parseFloat(attrs.cx), cy: Number.parseFloat(attrs.cy) };
  }).filter((circle) => Number.isFinite(circle.r));
}

async function gradeVisual(runDir) {
  const svgPath = path.join(runDir, "pelican-bicycle.svg");
  const svg = await fs.readFile(svgPath, "utf-8").catch(() => "");
  const artifactsDir = path.join(runDir, "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  const previewPath = path.join(artifactsDir, "pelican-bicycle.png");
  const circles = parseSvgCircles(svg).sort((left, right) => right.r - left.r);
  const wheelsEqual = circles.length >= 2 && Math.abs(circles[0].r - circles[1].r) <= Math.max(1, circles[0].r * 0.01) && Math.abs(circles[0].cx - circles[1].cx) > circles[0].r;
  const requiredIds = ["rear-wheel", "front-wheel", "rider-body", "left-foot", "right-foot", "handlebar"];
  const idsPresent = requiredIds.every((id) => new RegExp(`\\bid=["']${id}["']`, "i").test(svg));
  const pure = Boolean(svg) && !/<image\b|<foreignObject\b|data:image|(?:href|xlink:href|src)\s*=\s*["']https?:/i.test(svg);
  const hasViewBox = /<svg\b[^>]*\bviewBox\s*=\s*["'][^"']+["']/i.test(svg);
  let rendered = false;
  let withinViewBox = false;
  let renderError = "";
  if (svg) {
    try {
      await withBrowser(async (browser) => {
        const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
        await page.goto(pathToFileURL(svgPath).toString(), { waitUntil: "load" });
        const geometry = await page.evaluate(() => {
          const element = document.querySelector("svg");
          if (!element) return null;
          const viewBox = element.viewBox.baseVal;
          const box = element.getBBox();
          return {
            viewBox: { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height },
            box: { x: box.x, y: box.y, width: box.width, height: box.height },
          };
        });
        if (geometry?.viewBox?.width > 0 && geometry?.viewBox?.height > 0) {
          const tolerance = 2;
          withinViewBox = geometry.box.x >= geometry.viewBox.x - tolerance &&
            geometry.box.y >= geometry.viewBox.y - tolerance &&
            geometry.box.x + geometry.box.width <= geometry.viewBox.x + geometry.viewBox.width + tolerance &&
            geometry.box.y + geometry.box.height <= geometry.viewBox.y + geometry.viewBox.height + tolerance;
        }
        await page.locator("svg").screenshot({ path: previewPath });
        rendered = true;
        await page.close();
      });
    } catch (error) {
      renderError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    checks: [
      check("svg-exists", "创建目标 SVG", 5, Boolean(svg.trim()), svgPath),
      check("viewbox", "SVG 根元素和 viewBox 有效", 5, /<svg\b/i.test(svg) && hasViewBox, hasViewBox ? "viewBox present" : "missing viewBox"),
      check("pure-svg", "未嵌入栅格图像或 foreignObject", 10, pure, pure ? "pure vector markup" : "forbidden embed detected"),
      check("equal-wheels", "两个主要车轮大小一致且分离", 10, wheelsEqual, circles.slice(0, 2).map((circle) => `r=${circle.r},cx=${circle.cx}`).join(" | ")),
      check("semantic-ids", "关键骑行部件具有要求的 id", 10, idsPresent, requiredIds.filter((id) => !new RegExp(`\\bid=["']${id}["']`, "i").test(svg)).join(", ") || "all present"),
      check("render", "浏览器可真实渲染并输出 PNG", 15, rendered, rendered ? previewPath : renderError),
      check("bounds", "绘制内容位于 viewBox 内", 5, rendered && withinViewBox, rendered ? String(withinViewBox) : renderError),
    ],
    artifacts: rendered ? [previewPath, svgPath] : svg ? [svgPath] : [],
    manual_rubric: [
      { label: "整体视觉完成度", points: 10 },
      { label: "鹈鹕骑行动作与肢体关系", points: 10 },
      { label: "自行车几何与脚/踏板/车把关系", points: 10 },
      { label: "构图、配色与风格", points: 10 },
    ],
  };
}

const graders = {
  "code-fix": gradeCodeFix,
  "cross-file-change": gradeCrossFile,
  "web-debug": gradeWeb,
  "docs-generation": gradeDocs,
  "visual-svg": gradeVisual,
};

function reportMarkdown(report) {
  const lines = [
    `# Agent Eval Report: ${report.task.title}`,
    "",
    `- Run: \`${report.run_id}\``,
    `- Machine score: **${report.machine_score}/${report.machine_points}**`,
    `- Manual score: **${report.manual_score == null ? `pending/${report.manual_points}` : `${report.manual_score}/${report.manual_points}`}**`,
    `- Total: **${report.total_score == null ? "pending" : `${report.total_score}/${report.machine_points + report.manual_points}`}**`,
    "",
    "## Checks",
    "",
    "| Check | Score | Result | Detail |",
    "|---|---:|---|---|",
    ...report.checks.map((item) => `| ${item.label} | ${item.earned}/${item.points} | ${item.passed ? "PASS" : "FAIL"} | ${item.detail.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 500)} |`),
    "",
    "## Changed Files",
    "",
    ...(report.changed_files.length ? report.changed_files.map((file) => `- \`${file}\``) : ["- None"]),
  ];
  if (report.manual_rubric?.length) {
    lines.push("", "## User Visual Rubric", "", ...report.manual_rubric.map((item) => `- ${item.label}: ${item.points} points`));
  }
  if (report.artifacts.length) {
    lines.push("", "## Artifacts", "", ...report.artifacts.map((file) => `- \`${file}\``));
  }
  return `${lines.join("\n")}\n`;
}

async function gradeRun(runDir, options = {}) {
  const metadata = JSON.parse(await fs.readFile(path.join(runDir, ".agent-eval.json"), "utf-8"));
  const current = await snapshotFiles(runDir);
  const changes = changedFiles(metadata.baseline, current);
  const graded = await graders[metadata.task.id](runDir, metadata, current, changes);
  const machineScore = graded.checks.reduce((sum, item) => sum + item.earned, 0);
  const manualPoints = metadata.task.manual_points || 0;
  let manualScore = options.manualScore;
  if (manualScore != null) {
    manualScore = Number(manualScore);
    if (!Number.isFinite(manualScore) || manualScore < 0 || manualScore > manualPoints) {
      throw new Error(`manual-score must be between 0 and ${manualPoints}`);
    }
  }
  const totalScore = manualPoints === 0 ? machineScore : manualScore == null ? null : machineScore + manualScore;
  const report = {
    schema_version: 1,
    run_id: metadata.run_id,
    task: metadata.task,
    graded_at: new Date().toISOString(),
    machine_points: metadata.task.machine_points,
    machine_score: machineScore,
    manual_points: manualPoints,
    manual_score: manualScore ?? null,
    total_score: totalScore,
    checks: graded.checks,
    changed_files: changes,
    artifacts: graded.artifacts || [],
    manual_rubric: graded.manual_rubric || [],
  };
  if (options.write !== false) {
    await fs.writeFile(path.join(runDir, "eval-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
    await fs.writeFile(path.join(runDir, "eval-report.md"), reportMarkdown(report), "utf-8");
  }
  return report;
}

const referenceSolutions = {
  async "code-fix"(root) {
    await fs.writeFile(path.join(root, "src", "pricing.mjs"), `function validRate(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new RangeError(\`${"${name}"} must be between 0 and 100\`);
}

export function calculateInvoice(lines, discountPercent = 0, taxPercent = 0) {
  if (!Array.isArray(lines)) throw new TypeError("lines must be an array");
  validRate(discountPercent, "discountPercent");
  validRate(taxPercent, "taxPercent");
  const subtotal = lines.reduce((sum, line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new RangeError("quantity must be a positive integer");
    if (!Number.isInteger(line.unit_cents) || line.unit_cents < 0) throw new RangeError("unit_cents must be a non-negative integer");
    return sum + line.unit_cents * line.quantity;
  }, 0);
  const discount = Math.round(subtotal * discountPercent / 100);
  const taxable = subtotal - discount;
  const tax = Math.round(taxable * taxPercent / 100);
  return { subtotal, discount, tax, total: taxable + tax };
}
`, "utf-8");
  },

  async "cross-file-change"(root) {
    await fs.writeFile(path.join(root, "src", "normalize-tag.mjs"), `export function normalizeTag(value) {
  const normalized = String(value).trim().toLowerCase().replace(/\\s+/g, "-");
  if (!normalized) throw new Error("normalized tag is empty");
  return normalized;
}
`, "utf-8");
    await fs.writeFile(path.join(root, "src", "api.mjs"), `import { normalizeTag } from "./normalize-tag.mjs";

export function createTagRecord(rawTag) {
  const tag = normalizeTag(rawTag);
  return { tag, key: \`tag:\${tag}\` };
}
`, "utf-8");
    await fs.writeFile(path.join(root, "src", "cli.mjs"), `import { normalizeTag } from "./normalize-tag.mjs";

export function tagFromCli(rawTag) {
  return normalizeTag(rawTag);
}
`, "utf-8");
    await fs.writeFile(path.join(root, "README.md"), `# Tag service

API and CLI tags are trimmed, converted to lowercase, and consecutive whitespace becomes one hyphen. An empty normalized tag is rejected.
`, "utf-8");
  },

  async "web-debug"(root) {
    await fs.writeFile(path.join(root, "app.js"), `let count = 0;
const output = document.querySelector("#count");

function render() {
  output.textContent = String(count);
}

document.querySelector("#add").addEventListener("click", () => {
  count += 1;
  render();
});

document.querySelector("#reset").addEventListener("click", () => {
  count = 0;
  render();
});
`, "utf-8");
  },

  async "docs-generation"(root) {
    await fs.writeFile(path.join(root, "RUNBOOK.md"), `# Harbor Worker Runbook

## Overview

harbor-worker is a local-only worker. Run every command from the repository root.

## Start

\`node src/worker.mjs --config config/worker.json\`

## Health Check

\`node scripts/healthcheck.mjs --once\`

## Logs

Inspect \`logs/harbor-worker.log\`. During recovery, inspect the final 200 lines.

## Recovery

1. Run \`node scripts/stop-worker.mjs\`.
2. Inspect the final 200 lines of \`logs/harbor-worker.log\`.
3. Run \`node src/worker.mjs --config config/worker.json\`.
4. Run \`node scripts/healthcheck.mjs --once\`.

## Safety

Never paste tokens, API keys, credentials, or the contents of \`.env\` into tickets or chat.
`, "utf-8");
  },

  async "visual-svg"(root) {
    await fs.writeFile(path.join(root, "pelican-bicycle.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" width="1000" height="700">
  <rect width="1000" height="700" fill="#eef8fc"/>
  <g fill="none" stroke="#263238" stroke-width="18">
    <circle id="rear-wheel" cx="260" cy="520" r="135"/>
    <circle id="front-wheel" cx="760" cy="520" r="135"/>
  </g>
  <g fill="none" stroke="#d65a43" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">
    <path d="M260 520L455 350L590 520Z"/>
    <path d="M455 350L690 360L590 520M690 360L760 520"/>
  </g>
  <path id="handlebar" d="M690 360L725 295H810" fill="none" stroke="#263238" stroke-width="16" stroke-linecap="round"/>
  <path id="rider-body" d="M405 190C485 135 600 180 625 280C650 375 585 435 500 430C420 425 365 350 375 270C380 230 390 205 405 190Z" fill="#fffdf5" stroke="#263238" stroke-width="10"/>
  <path d="M500 215C555 120 650 95 705 145C745 183 720 235 670 260C630 280 612 305 598 332" fill="#fffdf5" stroke="#263238" stroke-width="10" stroke-linecap="round"/>
  <ellipse cx="700" cy="140" rx="58" ry="48" fill="#fffdf5" stroke="#263238" stroke-width="10"/>
  <path d="M748 140L910 165L750 190Z" fill="#efad43" stroke="#263238" stroke-width="9"/>
  <circle cx="715" cy="130" r="7" fill="#263238"/>
  <path d="M545 285C610 285 660 315 720 305" fill="none" stroke="#eee5d8" stroke-width="44" stroke-linecap="round"/>
  <path id="left-foot" d="M475 420L540 500L575 510" fill="none" stroke="#d99b3d" stroke-width="20" stroke-linecap="round"/>
  <path id="right-foot" d="M550 420L610 535L650 540" fill="none" stroke="#d99b3d" stroke-width="20" stroke-linecap="round"/>
  <circle cx="590" cy="520" r="28" fill="none" stroke="#263238" stroke-width="9"/>
</svg>
`, "utf-8");
  },
};

async function selfTest(tasks) {
  const root = path.join(os.tmpdir(), `local-coder-agent-eval-${randomUUID()}`);
  await fs.mkdir(root, { recursive: true });
  try {
    for (const task of tasks) {
      const runDir = path.join(root, task.id);
      await prepareTask(task, { output: runDir, force: true });
      const broken = await gradeRun(runDir, { write: false });
      if (broken.machine_score >= task.machine_points) {
        throw new Error(`${task.id}: broken fixture unexpectedly scored ${broken.machine_score}/${task.machine_points}`);
      }
      await referenceSolutions[task.id](runDir);
      const solved = await gradeRun(runDir, { write: false, manualScore: task.manual_points || undefined });
      if (solved.machine_score !== task.machine_points) {
        const failed = solved.checks.filter((item) => !item.passed).map((item) => `${item.id}: ${item.detail}`).join("; ");
        throw new Error(`${task.id}: reference solution scored ${solved.machine_score}/${task.machine_points}: ${failed}`);
      }
      console.log(`OK  ${task.id}: broken ${broken.machine_score}/${task.machine_points}, reference ${solved.machine_score}/${task.machine_points}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const { action, options } = parseArgs(process.argv.slice(2));
  const tasks = await readManifest();
  const task = options.task ? tasks.find((item) => item.id === options.task) : null;

  if (action === "list") {
    console.log("ID                   Machine  Manual  Title");
    for (const item of tasks) {
      console.log(`${item.id.padEnd(20)} ${String(item.machine_points).padStart(7)} ${String(item.manual_points).padStart(7)}  ${item.title}`);
    }
    return;
  }

  if (action === "prepare") {
    if (!task) throw new Error(`Unknown or missing --task. Available: ${tasks.map((item) => item.id).join(", ")}`);
    const prepared = await prepareTask(task, { output: options.output, force: Boolean(options.force) });
    console.log(`RUN_DIR=${prepared.runDir}`);
    console.log(`\n${task.prompt}\n`);
    return;
  }

  if (action === "grade") {
    if (!options.run) throw new Error("grade requires --run <directory>");
    const report = await gradeRun(path.resolve(options.run), { manualScore: options.manual_score });
    console.log(`Machine: ${report.machine_score}/${report.machine_points}`);
    console.log(`Manual: ${report.manual_score == null ? `pending/${report.manual_points}` : `${report.manual_score}/${report.manual_points}`}`);
    console.log(`Total: ${report.total_score == null ? "pending" : `${report.total_score}/${report.machine_points + report.manual_points}`}`);
    console.log(`Report: ${path.join(path.resolve(options.run), "eval-report.md")}`);
    return;
  }

  if (action === "selftest") {
    await selfTest(tasks);
    console.log("ALL EVAL GRADERS PASSED");
    return;
  }

  throw new Error(`Unknown action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});