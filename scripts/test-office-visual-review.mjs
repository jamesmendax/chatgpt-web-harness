import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOfficeFixtures } from "./lib/office-test-fixtures.mjs";
import { runOfficeContracts, runOfficePowerShell } from "./lib/office-test-contracts.mjs";
import { officePixelWitness } from "./lib/office-test-pixels.mjs";

process.env.CHATGPT_TOOL_PROFILE = "slim";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceBase = process.env.OFFICE_TEST_EVIDENCE_DIR || path.join(root, ".tool-test-tmp");
await fs.mkdir(evidenceBase, { recursive: true });
const tmpRoot = await fs.mkdtemp(path.join(evidenceBase, "office-visual-review-"));
const workspace = path.join(tmpRoot, "workspace");
const processTemp = path.join(tmpRoot, "temp");
await fs.mkdir(processTemp);
process.env.TEMP = processTemp;
process.env.TMP = processTemp;
process.env.CODEX_HOME = path.join(tmpRoot, "codex-home");
const runtimeRoot = process.env.OFFICE_TEST_RUNTIME_ROOT || root;
const receipt = { test: "office-visual-review", evidence: tmpRoot, contracts: null, guards: {}, native: {}, native_complete: false, passed: false };

const TEST_INTENT = JSON.stringify({
  intent_revision: 1,
  objective: "Exercise isolated Office visual-review rendering fixtures",
  scope: ["unique temporary Office fixture files and explicitly owned private-desktop processes"],
  out_of_scope: ["user Office sessions", "global Office settings", "system input and clipboard"],
  deliverables: ["Office render pixels and process-lifetime safety assertions"],
  success_criteria: ["native rendering binds only an explicitly launched process and preserves other processes"],
  constraints: [], protected_resources: ["all processes outside the exact owned Office Job"],
  known_facts: ["fixture construction uses OOXML ZIP only"], assumptions: [], delegated_decisions: [],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [], clarification_round: 0,
  questions_in_round: 0, resolution_mode: "none",
});

async function inspectOfficeProcesses(name) {
  const result = await runOfficePowerShell(`$ErrorActionPreference='Stop'\n@((Get-Process ${name} -ErrorAction SilentlyContinue)|ForEach-Object{@{pid=$_.Id;started=$_.StartTime.ToUniversalTime().ToString('o')}})|ConvertTo-Json -Compress`, tmpRoot, `inspect-${name}-${Date.now()}`, 10_000);
  const parsed = result.stdout ? JSON.parse(result.stdout) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function reviewData(result) {
  if (!result?.structuredContent?.ok) throw new Error(JSON.stringify(result?.structuredContent || result));
  return result.structuredContent.data;
}

async function assertNativePixels(result, kind, sourcePath) {
  const data = reviewData(result);
  assert.equal(data.kind, kind);
  assert.equal(data.page_paths.length, 1);
  assert.equal(result.content[0]?.type, "image");
  const blocks = result.content.filter(block => block.type === "image");
  assert.ok(blocks.length >= 1);
  const bytes = await fs.readFile(data.page_paths[0]);
  assert.ok(bytes.length > 2000, "Native Office returned an empty/trivial image");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(bytes.readUInt32BE(16) >= 320 && bytes.readUInt32BE(20) >= 240);
  assert.ok(blocks.some(block => Buffer.from(block.data, "base64").equals(bytes)), "Returned pixels do not match the actual rendered page");
  const pixels = officePixelWitness(bytes, kind);
  assert.match(String(data.renderer), kind === "pptx" ? /powerpoint/i : /word/i);
  const ownershipPath = path.join(path.dirname(kind === "pptx" ? path.dirname(data.page_paths[0]) : data.diagnostics.exported_pdf), "office-process.json");
  const ownership = JSON.parse(await fs.readFile(ownershipPath, "utf8"));
  assert.equal(ownership.ownership, "explicit-process-private-desktop-job");
  assert.equal(ownership.binding, "exact-owned-window-and-input-copy");
  assert.equal(ownership.status, "closed");
  assert.equal(ownership.result, "rendered");
  const sourceBytes = await fs.readFile(sourcePath);
  return { status: "passed", renderer: data.renderer, page: data.page_paths[0], ownership, pixels, png_sha256: createHash("sha256").update(bytes).digest("hex"), source_sha256: createHash("sha256").update(sourceBytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let client, server;
try {
  const fixtures = await createOfficeFixtures(workspace);
  receipt.contracts = await runOfficeContracts(root, tmpRoot);
  console.log("OK deterministic OOXML fixtures and exact owned-process lifetime contracts");
  if (process.argv.includes("--contracts-only") || process.platform !== "win32") {
    receipt.native = { pptx: { status: "not_exercised" }, docx: { status: "not_exercised" } };
    receipt.passed = true;
  } else {
    const { createMcpServer } = await import(pathToFileURL(path.join(runtimeRoot, "dist/server-factory.js")).href);
    server = createMcpServer(workspace, 30_000, [workspace], true);
    client = new Client({ name: "office-visual-review-test", version: "2" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);

    const requestedKind = process.argv.find(value => value.startsWith("--kind="))?.slice(7);
    if (requestedKind && !["pptx", "docx"].includes(requestedKind)) throw new Error("--kind must be pptx or docx");
    for (const [kind, name, sourcePath, dimensions] of [
      ["pptx", "POWERPNT", fixtures.pptxPath, { width: 1200, height: 675 }],
      ["docx", "WINWORD", fixtures.docxPath, { width: 1000, height: 1000 }],
    ]) {
      if (requestedKind && requestedKind !== kind) { receipt.native[kind] = { status: "not_exercised" }; continue; }
      const guardDirectory = path.join(tmpRoot, `guard-${name}`);
      await fs.mkdir(guardDirectory);
      const guardExecutable = path.join(guardDirectory, `${name}.EXE`);
      await fs.copyFile(path.join(tmpRoot, "office-test-host.exe"), guardExecutable);
      const guardProcess = spawn(guardExecutable, [], { windowsHide: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { guardProcess.once("spawn", resolve); guardProcess.once("error", reject); });
      try {
        const guarded = await client.callTool({ name: "visual_review", arguments: { target: sourcePath, timeout_ms: 20_000, _intent: TEST_INTENT } });
        assert.equal(guarded.structuredContent?.ok, false);
        assert.ok(JSON.stringify(guarded).includes(`${name} is already running`));
        assert.equal(guardProcess.exitCode, null, "Renderer terminated the existing process used to exercise its safety guard");
        receipt.guards[kind] = { status: "passed", coverage: "real process guard with test-owned non-Office executable", process_pid: guardProcess.pid };
      } finally {
        guardProcess.kill();
        await new Promise(resolve => { if (guardProcess.exitCode !== null) resolve(); else guardProcess.once("close", resolve); });
      }
      if (process.argv.includes("--guards-only")) { receipt.native[kind] = { status: "not_exercised" }; continue; }
      const before = await inspectOfficeProcesses(name);
      if (before.length === 0) {
        const memory = await runOfficePowerShell("$ErrorActionPreference='Stop'\n(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory", tmpRoot, `memory-${kind}`, 10_000);
        const freeKiB = Number(memory.stdout);
        assert.ok(Number.isFinite(freeKiB) && freeKiB >= 2_621_440, `OFFICE_NATIVE_NOT_STARTED: ${kind} requires 2560 MiB free physical memory; observed ${freeKiB} KiB`);
      }
      const sourceHash = createHash("sha256").update(await fs.readFile(sourcePath)).digest("hex");
      const result = await client.callTool({ name: "visual_review", arguments: { target: sourcePath, pages: [1], ...dimensions, timeout_ms: 90_000, _intent: TEST_INTENT } });
      if (before.length > 0) {
        assert.equal(result.structuredContent?.ok, false);
        assert.ok(JSON.stringify(result).includes(`${name} is already running`), "Renderer did not protect an existing Office session");
        const after = await inspectOfficeProcesses(name);
        for (const previous of before) assert.ok(after.some(current => current.pid === previous.pid && current.started === previous.started), "Existing Office process identity was lost");
        receipt.native[kind] = { status: "protected_existing_session", native_rendering: "not_exercised" };
        console.log(`OK ${name} existing-session guard; native ${kind} coverage remains pending`);
      } else {
        receipt.native[kind] = await assertNativePixels(result, kind, sourcePath);
        assert.equal(createHash("sha256").update(await fs.readFile(sourcePath)).digest("hex"), sourceHash, "Office changed the source fixture");
        console.log(`OK ${kind} actual Office -> visual_review pixels`);
      }
    }
    receipt.native_complete = Object.values(receipt.native).every(value => value.status === "passed");
    receipt.passed = true;
  }
} catch (error) {
  receipt.error = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  await client?.close().catch(() => undefined); await server?.close().catch(() => undefined);
  await fs.writeFile(path.join(tmpRoot, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`OFFICE_TEST_RECEIPT ${JSON.stringify(receipt)}`);
}

console.log(receipt.native_complete ? "office-visual-review: native Office rendering and safety PASS" : "office-visual-review: safety contracts PASS; native Office acceptance not complete (see receipt)");
