import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const beforeMode = process.argv.includes("--before");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sourceArg = process.argv.indexOf("--source-root");
const sourceRoot = sourceArg >= 0 ? path.resolve(process.argv[sourceArg + 1]) : repoRoot;
if (beforeMode && sourceRoot === repoRoot) throw new Error("--before requires an explicit different --source-root; never label fixed code as baseline evidence");
const runRoot = path.join(repoRoot, ".tool-test-tmp", "svg-review-coverage", beforeMode ? "before" : "after");
const fixtureRoot = path.join(runRoot, "fixtures");
const outputRoot = path.join(runRoot, "renders");
process.env.CHATGPT_TOOL_PROFILE = "slim";
process.env.CODEX_HOME = path.join(runRoot, "codex-home");

const allowedTestRoot = path.resolve(repoRoot, ".tool-test-tmp", "svg-review-coverage");
const relativeRun = path.relative(allowedTestRoot, path.resolve(runRoot));
assert.ok(relativeRun && !relativeRun.startsWith("..") && !path.isAbsolute(relativeRun), "refuse cleanup outside the test subtree");
await fs.rm(runRoot, { recursive: true, force: true });
await fs.mkdir(fixtureRoot, { recursive: true });
await fs.mkdir(outputRoot, { recursive: true });

const horizontalSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 600" width="1600" height="600">
  <rect width="1600" height="600" fill="#f8fafc"/>
  <rect id="top-left" x="0" y="0" width="140" height="140" fill="#e11d48"/>
  <rect id="top-right" x="1460" y="0" width="140" height="140" fill="#2563eb"/>
  <rect id="bottom-left" x="0" y="460" width="140" height="140" fill="#16a34a"/>
  <rect id="bottom-right" x="1460" y="460" width="140" height="140" fill="#f59e0b"/>
  <rect id="focus-horizontal" x="680" y="190" width="180" height="180" fill="#111827"/>
  <circle id="focus-horizontal-pair" cx="1100" cy="280" r="70" fill="#7c3aed"/>
</svg>`;

// No viewBox: the implementation must derive the effective canvas from the
// width/height attributes and install a DOM-only synthetic viewBox.
const verticalSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1600">
  <rect width="600" height="1600" fill="#f8fafc"/>
  <rect id="top-left" x="0" y="0" width="140" height="140" fill="#e11d48"/>
  <rect id="top-right" x="460" y="0" width="140" height="140" fill="#2563eb"/>
  <rect id="bottom-left" x="0" y="1460" width="140" height="140" fill="#16a34a"/>
  <rect id="bottom-right" x="460" y="1460" width="140" height="140" fill="#f59e0b"/>
  <rect id="focus-vertical" x="220" y="720" width="160" height="160" fill="#111827"/>
  <circle id="focus-vertical-pair" cx="300" cy="1120" r="70" fill="#7c3aed"/>
</svg>`;

// No reliable canvas dimensions: a browser fallback viewport must not be
// silently relabelled as a complete SVG render.
const incompleteSvg = `<svg xmlns="http://www.w3.org/2000/svg"><rect width="0" height="0"/></svg>`;

const fixtures = [
  {
    name: "horizontal-viewbox",
    source: horizontalSvg,
    hasViewBox: true,
    sourceWidth: 1600,
    sourceHeight: 600,
    focus: [{ label: "horizontal focus", selector: "#focus-horizontal", pair_selector: "#focus-horizontal-pair" }],
    expectComplete: true,
  },
  {
    name: "vertical-no-viewbox",
    source: verticalSvg,
    hasViewBox: false,
    sourceWidth: 600,
    sourceHeight: 1600,
    focus: [{ label: "vertical focus", selector: "#focus-vertical", pair_selector: "#focus-vertical-pair" }],
    expectComplete: true,
  },
  {
    name: "incomplete-no-canvas",
    source: incompleteSvg,
    hasViewBox: false,
    sourceWidth: undefined,
    sourceHeight: undefined,
    focus: [],
    expectComplete: false,
  },
];

for (const fixture of fixtures) {
  await fs.writeFile(path.join(fixtureRoot, `${fixture.name}.svg`), fixture.source, "utf8");
}

const { createMcpServer } = await import(pathToFileURL(path.join(sourceRoot, "dist/server-factory.js")).href);
const server = createMcpServer(runRoot, 30_000, [runRoot], true);
const client = new Client({ name: "svg-review-coverage-test", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated SVG/HTML visual coverage fixtures",
  scope: ["temporary visual-review fixtures and render outputs under runRoot"],
  out_of_scope: [], deliverables: ["render coverage and authored-geometry assertions"],
  success_criteria: ["visual review preserves source bytes and returns bounded complete diagnostics where possible"],
  constraints: [], protected_resources: [], known_facts: ["all review state/output is confined to the test runRoot"],
  assumptions: [], delegated_decisions: [], remaining_nonblocking_uncertainties: [],
  closure_items: [], ambiguities: [], clarification_round: 0, questions_in_round: 0,
  resolution_mode: "none",
});

const callVisualReview = (arguments_) => client.callTool({
  name: "visual_review",
  arguments: { ...arguments_, _intent: TEST_INTENT },
});

function resultData(result) {
  if (!result?.structuredContent?.ok) throw new Error(JSON.stringify(result?.structuredContent || result));
  return result.structuredContent.data;
}

function imageBlocks(result) {
  return (result.content || []).filter((block) => block.type === "image");
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function decodePng(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(buffer.subarray(0, 8), signature, "returned image is not a PNG");
  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  assert.equal(bitDepth, 8, "coverage probe expects 8-bit PNG output");
  assert.ok(colorType === 2 || colorType === 6, "coverage probe expects RGB/RGBA PNG output");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowBytes = width * bytesPerPixel;
  const rows = Buffer.alloc(width * height * bytesPerPixel);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawOffset++];
    const row = raw.subarray(rawOffset, rawOffset + rowBytes);
    rawOffset += rowBytes;
    const outputOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const left = x >= bytesPerPixel ? rows[outputOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? rows[outputOffset - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= bytesPerPixel ? rows[outputOffset - rowBytes + x - bytesPerPixel] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) {
        throw new Error(`unsupported PNG filter ${filter}`);
      }
      rows[outputOffset + x] = value & 0xff;
    }
  }
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < width * height; index++) {
    pixels[index * 4] = rows[index * bytesPerPixel];
    pixels[index * 4 + 1] = rows[index * bytesPerPixel + 1];
    pixels[index * 4 + 2] = rows[index * bytesPerPixel + 2];
    pixels[index * 4 + 3] = colorType === 6 ? rows[index * bytesPerPixel + 3] : 255;
  }
  return { width, height, pixels };
}

function countColor(decoded, color) {
  let count = 0;
  for (let index = 0; index < decoded.pixels.length; index += 4) {
    if (decoded.pixels[index] === color[0] && decoded.pixels[index + 1] === color[1] && decoded.pixels[index + 2] === color[2] && decoded.pixels[index + 3] > 0) count++;
  }
  return count;
}

async function inspectFixture(fixture) {
  const sourcePath = path.join(fixtureRoot, `${fixture.name}.svg`);
  const outputDir = path.join(outputRoot, fixture.name);
  const sourceBefore = await fs.readFile(sourcePath);
  const sourceHashBefore = sha256(sourceBefore);
  const result = await callVisualReview({
      target: sourcePath,
      kind: "svg",
      width: 800,
      height: 600,
      output_dir: outputDir,
      focus: fixture.focus,
      max_images: 4,
  });
  const data = resultData(result);
  const blocks = imageBlocks(result);
  assert.ok(blocks.length >= 1, `${fixture.name}: visual_review did not return an image content block`);
  const returnedOverview = Buffer.from(blocks[0].data, "base64");
  const returnedPath = path.join(outputDir, "returned-overview.png");
  await fs.writeFile(returnedPath, returnedOverview);
  const decoded = decodePng(returnedOverview);
  const sourceHashAfter = sha256(await fs.readFile(sourcePath));
  assert.equal(sourceHashAfter, sourceHashBefore, `${fixture.name}: source SVG bytes changed`);
  const canvas = data.diagnostics?.svg_canvas || {};
  const counts = {
    top_left: countColor(decoded, [225, 29, 72]),
    top_right: countColor(decoded, [37, 99, 235]),
    bottom_left: countColor(decoded, [22, 163, 74]),
    bottom_right: countColor(decoded, [245, 158, 11]),
  };
  const focusDetails = Array.isArray(data.diagnostics?.focus) ? data.diagnostics.focus : [];
  const summary = {
    name: fixture.name,
    mode: beforeMode ? "before" : "after",
    source_path: sourcePath,
    overview_path: data.overview_path,
    returned_overview_path: returnedPath,
    png: { width: decoded.width, height: decoded.height },
    corner_color_counts: counts,
    image_blocks: blocks.length,
    source_sha256_unchanged: sourceHashAfter === sourceHashBefore,
    svg_canvas: canvas,
    focus_details: focusDetails,
    machine_blocking_issues: data.machine_blocking_issues,
    render_status: data.render_status,
  };

  if (!beforeMode && fixture.expectComplete) {
    assert.equal(decoded.width, 800, `${fixture.name}: output width changed unexpectedly`);
    assert.equal(decoded.height, 600, `${fixture.name}: output height changed unexpectedly`);
    assert.equal(canvas.full_canvas_captured, true, `${fixture.name}: SVG canvas was not marked complete`);
    assert.equal(canvas.has_view_box, fixture.hasViewBox, `${fixture.name}: viewBox detection mismatch`);
    assert.equal(canvas.source_width, fixture.sourceWidth, `${fixture.name}: source width mismatch`);
    assert.equal(canvas.source_height, fixture.sourceHeight, `${fixture.name}: source height mismatch`);
    for (const [name, count] of Object.entries(counts)) {
      assert.ok(count > 100, `${fixture.name}: ${name} corner color missing from returned pixels (count=${count})`);
    }
    assert.equal(focusDetails[0]?.found, true, `${fixture.name}: selector focus was not found`);
    assert.ok(focusDetails[0]?.crop_path, `${fixture.name}: selector focus crop was not returned`);
    assert.equal(data.machine_blocking_issues?.length, 0, `${fixture.name}: complete SVG had machine blocking issues`);
  }

  if (!beforeMode && !fixture.expectComplete) {
    assert.equal(canvas.full_canvas_captured, false, `${fixture.name}: unresolvable canvas was marked complete`);
    assert.ok(data.machine_blocking_issues?.some((issue) => /SVG canvas|incomplete|dimension/i.test(issue)), `${fixture.name}: incomplete SVG did not report a blocking issue`);
    assert.equal(data.render_status, "blocked", `${fixture.name}: incomplete SVG was not marked blocked`);
  }
  return summary;
}

async function inspectGeneralViewport() {
  const html = path.join(fixtureRoot, "responsive.html");
  await fs.writeFile(html, '<!doctype html><style>html,body{margin:0;width:100%;height:100%;background:rgb(37,99,235)}@media(max-width:500px){html,body{background:rgb(22,163,74)}}</style>');
  const results = [];
  for (const [width, height, color] of [[390, 844, [22, 163, 74]], [1440, 900, [37, 99, 235]]]) {
    const result = await callVisualReview({ target: html, kind: "html", width, height, full_page: false, output_dir: path.join(outputRoot, `responsive-${width}`) });
    const decoded = decodePng(Buffer.from(imageBlocks(result)[0].data, "base64"));
    const exactColorPixels = countColor(decoded, color);
    results.push({ requested: { width, height }, actual: { width: decoded.width, height: decoded.height }, exact_color_pixels: exactColorPixels });
    if (!beforeMode) {
      assert.equal(decoded.width, width, "HTML viewport width must be actual pixels, not just request metadata");
      assert.equal(decoded.height, height, "HTML viewport height must be actual pixels");
      assert.ok(exactColorPixels > width * height * 0.95, "CSS media query must use the requested viewport");
    }
  }
  return { name: "html-responsive-viewports", results };
}

async function inspectAuthoredGeometry() {
  // The viewBox is square but the authored canvas is 2:1. 'none' must stay
  // stretched; changing it to 'meet' would silently review different artwork.
  const svg = path.join(fixtureRoot, "authored-none.svg");
  await fs.writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="#e11d48"/></svg>');
  const original = sha256(await fs.readFile(svg));
  const result = await callVisualReview({ target: svg, width: 800, height: 600, output_dir: path.join(outputRoot, "authored-none") });
  const decoded = decodePng(Buffer.from(imageBlocks(result)[0].data, "base64"));
  const redPixels = countColor(decoded, [225, 29, 72]);
  if (!beforeMode) {
    assert.equal(redPixels, 800 * 400, "authored preserveAspectRatio and outer canvas dimensions must be retained");
    assert.equal(sha256(await fs.readFile(svg)), original, "review must not rewrite SVG source bytes");
  }
  return { name: "authored-svg-mapping", red_pixels: redPixels, expected_red_pixels: 800 * 400 };
}

async function inspectBoundedDocument() {
  const html = path.join(fixtureRoot, "long-document.html");
  await fs.writeFile(html, '<!doctype html><style>body{margin:0;height:20000px;background:#f8fafc}</style><h1>Full document requested</h1><p style="position:absolute;top:19000px">Required content outside the returned viewport</p>');
  const result = await callVisualReview({ target: html, width: 800, height: 600, full_page: true, output_dir: path.join(outputRoot, "long-document") });
  const data = resultData(result);
  if (!beforeMode) {
    assert.equal(data.diagnostics.full_page_captured, false);
    assert.equal(data.render_status, "blocked", "a cropped full-document request must not pass machine verification");
    assert.ok(data.machine_blocking_issues.some(issue => /full-page.*incomplete/.test(issue)));
    assert.equal(data.delivery_ready, false);
  }
  return { name: "bounded-full-document", captured: data.diagnostics.full_page_captured, render_status: data.render_status, machine_blocking_issues: data.machine_blocking_issues };
}

try {
  const summaries = [];
  for (const fixture of fixtures) summaries.push(await inspectFixture(fixture));
  summaries.push(await inspectGeneralViewport(), await inspectAuthoredGeometry(), await inspectBoundedDocument());
  const summary = { mode: beforeMode ? "before" : "after", source_root: sourceRoot, run_root: runRoot, summaries };
  await fs.writeFile(path.join(runRoot, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await client.close();
  await server.close();
}
