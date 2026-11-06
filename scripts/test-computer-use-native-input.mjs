import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import isolation from "../desktop/scripts/lib/test-isolation.cjs";

// Separate acceptance: moves the system pointer, focuses a visible owned window
// and sends native keyboard input. Only run on an authorized dedicated desktop/VM.
if (!process.argv.includes("--native-input") || process.env.HARNESS_NATIVE_INPUT_ACCEPTANCE !== "dedicated-desktop") {
  throw new Error("Native input acceptance requires --native-input and HARNESS_NATIVE_INPUT_ACCEPTANCE=dedicated-desktop; it is excluded from default regressions.");
}
if (process.platform !== "win32") {
  throw new Error("Native Computer Use input acceptance requires Windows");
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.HARNESS_TEST_RUNTIME_ROOT
  ? path.resolve(process.env.HARNESS_TEST_RUNTIME_ROOT)
  : sourceRoot;
const distRoot = process.env.HARNESS_TEST_DIST_ROOT
  ? path.resolve(process.env.HARNESS_TEST_DIST_ROOT)
  : path.join(sourceRoot, "dist");
const tmp = isolation.artifactRoot("computer-use-native-input");
const helper = path.join(runtimeRoot, "bundled-plugins", "computer-use", "windows-action.ps1");
const capabilityFile = path.join(tmp, "account", "capability.json");
const auditLog = path.join(tmp, "account", "computer-use.audit.jsonl");
const stateFile = path.join(tmp, "fixture-result.txt");
const fixtureScript = path.join(tmp, "fixture.ps1");
const geometryFile = path.join(tmp, "fixture-geometry.json");
const marker = `native-input-${Date.now()}`;
const accountId = "a".repeat(32);
const token = crypto.randomBytes(32).toString("base64url");
const instanceId = `cui_${crypto.randomBytes(16).toString("hex")}`;
const helperSha256 = crypto.createHash("sha256").update(await fs.readFile(helper)).digest("hex");

function record(expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()) {
  return {
    schema_version: 1,
    provider: "computer-use",
    account_id: accountId,
    instance_id: instanceId,
    token,
    issued_at: new Date().toISOString(),
    expires_at: expiresAt,
    helper_sha256: helperSha256,
  };
}

await fs.mkdir(path.dirname(capabilityFile), { recursive: true });
await fs.writeFile(capabilityFile, `${JSON.stringify(record(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await fs.writeFile(fixtureScript, `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FixtureCoordinates {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
}
'@
[FixtureCoordinates]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = [Windows.Forms.Form]::new()
$form.Text = 'Harness Computer Use Smoke ${process.pid}'
$form.StartPosition = 'Manual'
$form.Location = [Drawing.Point]::new(40, 40)
$form.ClientSize = [Drawing.Size]::new(390, 145)
$form.TopMost = $true
$box = [Windows.Forms.TextBox]::new()
$box.Location = [Drawing.Point]::new(20, 20)
$box.Size = [Drawing.Size]::new(330, 28)
$button = [Windows.Forms.Button]::new()
$button.Text = 'Commit'
$button.Location = [Drawing.Point]::new(20, 72)
$button.Size = [Drawing.Size]::new(120, 32)
$button.Add_Click({ [IO.File]::WriteAllText(${JSON.stringify(stateFile)}, $box.Text, [Text.UTF8Encoding]::new($false)) })
$form.Controls.Add($box)
$form.Controls.Add($button)
$form.Add_Shown({
  $rect = [FixtureCoordinates+RECT]::new()
  if (-not [FixtureCoordinates]::GetWindowRect($form.Handle, [ref]$rect)) { throw 'Fixture bounds unavailable' }
  $textPoint = $box.PointToScreen([Drawing.Point]::new([int]($box.Width / 2), [int]($box.Height / 2)))
  $buttonPoint = $button.PointToScreen([Drawing.Point]::new([int]($button.Width / 2), [int]($button.Height / 2)))
  $geometry = @{ hwnd=$form.Handle.ToInt64().ToString(); text_x=$textPoint.X-$rect.Left; text_y=$textPoint.Y-$rect.Top; button_x=$buttonPoint.X-$rect.Left; button_y=$buttonPoint.Y-$rect.Top }
  [IO.File]::WriteAllText(${JSON.stringify(geometryFile)}, ($geometry | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  $box.Focus()
})
[void]$form.ShowDialog()
`, "utf8");

const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const fixture = spawn(powershell, ["-NoLogo", "-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", fixtureScript], {
  windowsHide: false,
  stdio: ["ignore", "pipe", "pipe"],
});
assert.ok(fixture.pid);
let fixtureError = "";
fixture.stderr?.on("data", (chunk) => { fixtureError += String(chunk); });

const envNames = [
  "HARNESS_COMPUTER_USE_CAPABILITY_FILE", "HARNESS_COMPUTER_USE_HELPER",
  "HARNESS_COMPUTER_USE_HELPER_SHA256", "HARNESS_COMPUTER_USE_TOKEN",
  "HARNESS_COMPUTER_USE_INSTANCE_ID", "HARNESS_COMPUTER_USE_AUDIT_LOG", "HARNESS_ACCOUNT_ID",
  "CODEX_HOME", "AUDIT_LOG_PATH", "MCP_SHELL_STATE_DIR", "MCP_UPSTREAM_CONFIG",
  "CHATGPT_PLUGINS_CONFIG", "CHATGPT_TOOL_PROFILE", "HARNESS_RELAY_ENABLED",
  "HARNESS_RELAY_AUTOMATION_ENABLED", "HARNESS_COMPANION_ENABLED", "GOAL_WATCHDOG_ENABLED",
];
const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
Object.assign(process.env, {
  HARNESS_COMPUTER_USE_CAPABILITY_FILE: capabilityFile,
  HARNESS_COMPUTER_USE_HELPER: helper,
  HARNESS_COMPUTER_USE_HELPER_SHA256: helperSha256,
  HARNESS_COMPUTER_USE_TOKEN: token,
  HARNESS_COMPUTER_USE_INSTANCE_ID: instanceId,
  HARNESS_COMPUTER_USE_AUDIT_LOG: auditLog,
  HARNESS_ACCOUNT_ID: accountId,
  CODEX_HOME: path.join(tmp, "runtime"),
  AUDIT_LOG_PATH: path.join(tmp, "harness.audit.jsonl"),
  MCP_SHELL_STATE_DIR: path.join(tmp, "shell"),
  MCP_UPSTREAM_CONFIG: path.join(tmp, "upstream.json"),
  CHATGPT_PLUGINS_CONFIG: path.join(tmp, "plugins.json"),
  CHATGPT_TOOL_PROFILE: "full",
  HARNESS_RELAY_ENABLED: "false",
  HARNESS_RELAY_AUTOMATION_ENABLED: "false",
  HARNESS_COMPANION_ENABLED: "false",
  GOAL_WATCHDOG_ENABLED: "false",
});
await fs.writeFile(process.env.CHATGPT_PLUGINS_CONFIG, JSON.stringify({
  schema_version: 2, computer_use: { enabled: true }, browser_use: { enabled: false }, skills: [],
}));

const fixtureIntent = JSON.stringify({
  intent_revision: 1,
  objective: "Verify Computer Use through fresh MCP registrations against an owned Windows fixture",
  scope: [tmp, "Read and type only into the explicitly selected fixture process"],
  out_of_scope: ["Live Harness services", "User applications", "Credentials"],
  deliverables: ["Native provider and cross-invocation assertions"],
  success_criteria: ["The same trusted conversation retains explicit target across fresh transports", "Native input reaches only the owned fixture"],
  constraints: ["Only terminate the fixture process created by this script", "No user messages or service lifecycle changes"],
  protected_resources: ["All unrelated applications and live MCP/Tunnel processes"],
  known_facts: ["The fixture process and capability are owned by this test"],
  assumptions: [], delegated_decisions: ["Isolated fixture implementation"],
  remaining_nonblocking_uncertainties: [], closure_items: [], ambiguities: [],
  clarification_round: 0, questions_in_round: 0, resolution_mode: "none",
});

async function waitForWindow(provider) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) throw new Error(`Computer Use fixture exited ${fixture.exitCode}: ${fixtureError.slice(-2000)}`);
    const listed = await provider.execute({ action: "list_windows" });
    const windows = Array.isArray(listed.data.windows) ? listed.data.windows : [];
    const found = windows.find((item) => item.pid === fixture.pid && item.title === `Harness Computer Use Smoke ${process.pid}`);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Computer Use fixture window did not become visible: ${fixtureError.slice(-2000)}`);
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(file, "utf8"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

try {
  const { createMcpServer } = await import(pathToFileURL(path.join(distRoot, "server-factory.js")).href);
  const conversation = "owned-native-computer-use-" + crypto.randomUUID();
  const transportIds = new Set();
  const provider = {
    async execute(request) {
      // Match ChatGPT's per-invocation transport pattern, including server teardown.
      const server = createMcpServer(tmp, 30_000, [tmp], false);
      const client = new Client({ name: "owned-native-computer-use", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      serverTransport.sessionId = crypto.randomUUID();
      transportIds.add(serverTransport.sessionId);
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: "computer_use", arguments: { ...request, _intent: fixtureIntent },
          _meta: { "openai/session": conversation },
        });
        if (result.isError || result.structuredContent?.ok !== true) {
          throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "Computer Use failed");
        }
        const picture = result.content?.find(item => item.type === "image");
        return { data: result.structuredContent.data, ...(picture ? { image: Buffer.from(picture.data, "base64") } : {}) };
      } finally {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
      }
    },
  };
  const status = await provider.execute({ action: "status" });
  assert.equal(status.data.provider, "harness-windows-native");
  assert.equal(status.data.protocol_version, 1);
  assert.ok(status.data.provider_instance_id);
  await assert.rejects(() => provider.execute({ action: "screenshot" }), /select_target/);

  const target = await waitForWindow(provider);
  const geometry = JSON.parse(await waitForFile(geometryFile));
  assert.equal(geometry.hwnd, String(target.hwnd), "coordinates must belong to the selected owned fixture");
  await provider.execute({ action: "select_target", target: "window", hwnd: String(target.hwnd) });
  const screenshot = await provider.execute({ action: "screenshot" });
  assert.ok(screenshot.image?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  const retained = await provider.execute({ action: "status" });
  assert.equal(retained.data.provider_instance_id, status.data.provider_instance_id);
  assert.equal(retained.data.selected_target.hwnd, String(target.hwnd));

  await provider.execute({ action: "click", x: geometry.text_x, y: geometry.text_y, button: "left" });
  const typed = await provider.execute({ action: "type", text: marker, replace_existing: true });
  assert.equal(typed.data.replaced_existing, true);
  await provider.execute({ action: "click", x: geometry.button_x, y: geometry.button_y, button: "left" });
  assert.equal(await waitForFile(stateFile), marker, "native click/type sequence did not reach the owned fixture window");

  await provider.execute({ action: "keypress", keys: ["ALT", "F4"] });
  await new Promise((resolve, reject) => {
    if (fixture.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("direct ALT+F4 did not close the owned fixture")), 5_000);
    fixture.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await provider.execute({ action: "close" });
  await assert.rejects(() => provider.execute({ action: "screenshot" }), /select_target/);

  const audit = await fs.readFile(auditLog, "utf8");
  assert.doesNotMatch(audit, new RegExp(marker), "Computer Use audit leaked typed text");
  assert.match(audit, /"redacted":true/);

  await fs.writeFile(capabilityFile, `${JSON.stringify(record(new Date(Date.now() - 1000).toISOString()), null, 2)}\n`, "utf8");
  await assert.rejects(() => provider.execute({ action: "status" }), /expired/);
  await fs.writeFile(capabilityFile, `${JSON.stringify(record(), null, 2)}\n`, "utf8");

  process.env.HARNESS_COMPUTER_USE_TOKEN = crypto.randomBytes(32).toString("base64url");
  await assert.rejects(() => provider.execute({ action: "status" }), /token mismatch/);
  process.env.HARNESS_COMPUTER_USE_TOKEN = token;
  process.env.HARNESS_ACCOUNT_ID = "b".repeat(32);
  await assert.rejects(() => provider.execute({ action: "status" }), /account mismatch/);
  process.env.HARNESS_ACCOUNT_ID = accountId;
  process.env.HARNESS_COMPUTER_USE_HELPER_SHA256 = "0".repeat(64);
  await assert.rejects(() => provider.execute({ action: "status" }), /integrity check/);

  assert.ok(transportIds.size >= 15, "native test did not cross independent MCP registrations");
  console.log("computer-use-native-input: fresh MCP transports retain owned-window screenshot/click/type; direct keypress, capability, close and redacted audit PASS");
} finally {
  try { fixture.kill("SIGKILL"); } catch {}
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
}
