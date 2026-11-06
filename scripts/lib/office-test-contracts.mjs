import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { officeFixtureZip, inspectOfficeFixture, pptxFixtureEntries, docxFixtureEntries } from "./office-test-fixtures.mjs";

export async function runOfficePowerShell(script, directory, name, timeoutMs = 30_000) {
  const scriptPath = path.join(directory, `${name}.ps1`);
  await fs.writeFile(scriptPath, script, "utf8");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (!timedOut && code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim(), scriptPath });
      else reject(new Error(`PowerShell ${timedOut ? "timed out" : `exit ${code}`}\n${stderr.trim()}\n${stdout.trim()}`));
    });
  });
}

export const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;

export async function runOfficeContracts(root, directory) {
  for (const entries of [pptxFixtureEntries, docxFixtureEntries]) {
    const bytes = officeFixtureZip(entries);
    assert.deepEqual(inspectOfficeFixture(bytes), entries);
    assert.deepEqual(bytes, officeFixtureZip(entries));
    const damaged = Buffer.from(bytes); damaged[30 + Buffer.byteLength(Object.keys(entries)[0]) + 8] ^= 1;
    assert.throws(() => inspectOfficeFixture(damaged), /checksum mismatch/);
    for (const [name, xml] of Object.entries(entries)) {
      if (!name.endsWith(".rels")) continue;
      const base = name === "_rels/.rels" ? "" : path.posix.dirname(name).replace(/\/_rels$/, "");
      for (const target of xml.matchAll(/Target="([^"]+)"/g)) {
        const resolved = path.posix.normalize(path.posix.join(base, target[1]));
        assert.ok(entries[resolved], `${name}: missing relationship target ${resolved}`);
      }
    }
  }
  if (process.platform !== "win32") return { fixture_contracts: "passed", process_contracts: "unavailable", native_rendering: "not_exercised" };

  const ts = (await import("typescript")).default;
  const source = await fs.readFile(path.join(root, "src/lib/visual-review-office.ts"), "utf8");
  const transpiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
  assert.equal(transpiled.diagnostics?.length || 0, 0);
  const compiledPath = path.join(directory, "visual-review-office.mjs");
  await fs.writeFile(compiledPath, transpiled.outputText);
  const { privateOfficeAutomationScript } = await import(pathToFileURL(compiledPath).href);
  const typeDefinition = privateOfficeAutomationScript.slice(privateOfficeAutomationScript.indexOf("Add-Type"), privateOfficeAutomationScript.indexOf("$exeName="));
  assert.ok(typeDefinition.length > 5000);

  const fakePath = path.join(directory, "office-test-host.exe");
  const xmlPath = path.join(directory, "fixture-xml.json");
  await fs.writeFile(xmlPath, JSON.stringify([...Object.values(pptxFixtureEntries), ...Object.values(docxFixtureEntries)]));
  const compile = await runOfficePowerShell(`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
${typeDefinition}
foreach($xml in (Get-Content -LiteralPath ${psQuote(xmlPath)} -Raw|ConvertFrom-Json)){[xml]$parsed=$xml;if(!$parsed.DocumentElement){throw 'Fixture XML has no root'}}
Add-Type -TypeDefinition 'using System; using System.Threading; public class OfficeTestHost { public static void Main(string[] args) { Thread.Sleep(60000); } }' -OutputAssembly ${psQuote(fakePath)} -OutputType ConsoleApplication
$owned=[PrivateOfficeProcess]::new(${psQuote(fakePath)},${psQuote(xmlPath)},${psQuote(directory)})
$process=[Diagnostics.Process]::GetProcessById($owned.ProcessId)
$handle=$process.Handle
try {
  if(!$owned.IsRunning){throw 'Explicitly launched process is not alive'}
  if($owned.FindNativeObject('pptx')){throw 'A process without Office windows was incorrectly bound'}
} finally {$owned.Dispose()}
if(!$process.WaitForExit(5000)){throw 'Owned job did not terminate its exact process'}
$process.Dispose()
Write-Output 'OK fixture XML, private desktop, NativeOM refusal, retained job disposal'
`, directory, "contracts-compile-and-dispose");

  // Both processes use the same EXE. One is a later unrelated launch; closing
  // the helper must kill its owned Job and leave the unrelated launch alive.
  const sentinel = spawn(fakePath, [], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve, reject) => { sentinel.once("spawn", resolve); sentinel.once("error", reject); });
  const abruptPath = path.join(directory, "contracts-abrupt.ps1");
  await fs.writeFile(abruptPath, `$ErrorActionPreference='Stop'\n${typeDefinition}\n$owned=[PrivateOfficeProcess]::new(${psQuote(fakePath)},${psQuote(xmlPath)},${psQuote(directory)})\nWrite-Output $owned.ProcessId\n[Console]::Out.Flush()\n[Threading.Thread]::Sleep(60000)\n`, "utf8");
  const helper = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-File", abruptPath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let ownedPid;
  let helperError = "";
  helper.stderr.on("data", chunk => { helperError += chunk.toString(); });
  try {
    ownedPid = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`Owned helper startup timeout: ${helperError}`)), 15_000);
      helper.stdout.on("data", chunk => {
        output += chunk.toString();
        const match = /(?:^|\n)(\d+)\r?\n/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
      helper.once("error", error => { clearTimeout(timer); reject(error); });
      helper.once("exit", code => { clearTimeout(timer); reject(new Error(`Owned helper exited ${code}: ${helperError}`)); });
    });
    assert.equal(sentinel.exitCode, null);
    helper.kill();
    await new Promise(resolve => helper.once("close", resolve));
    const inspection = await runOfficePowerShell(`
$ErrorActionPreference='Stop'
$owned=Get-Process -Id ${ownedPid} -ErrorAction SilentlyContinue
if($owned){throw 'Office Job survived abrupt helper termination'}
Write-Output 'OK abrupt helper termination closes exact owned Job'
`, directory, "contracts-after-abort", 10_000);
    assert.equal(sentinel.exitCode, null, "Unrelated later process with the same name was terminated");
    await fs.writeFile(path.join(directory, "contracts.json"), JSON.stringify({ fixture_contracts: "passed", process_contracts: "passed", owned_pid: ownedPid, unrelated_later_pid: sentinel.pid, compile: compile.stdout, abort: inspection.stdout, native_rendering: "not_exercised" }, null, 2));
  } finally {
    if (helper.exitCode === null) helper.kill();
    sentinel.kill();
    await new Promise(resolve => { if (sentinel.exitCode !== null) resolve(); else sentinel.once("close", resolve); });
  }
  return { fixture_contracts: "passed", process_contracts: "passed", native_rendering: "not_exercised" };
}
