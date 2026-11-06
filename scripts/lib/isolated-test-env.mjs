import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const systemKey = /^(SystemRoot|windir|ComSpec|PATH|PATHEXT|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|OS|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|ALLUSERSPROFILE|PROGRAMDATA|UV_PYTHON_INSTALL_DIR)$/i;

/** Default direct-test environment; explicit feature overrides cannot replace private paths. */
export async function createIsolatedTestEnv(label, overrides = {}, baseEnv = process.env) {
  const parent = path.join(repo, ".tool-test-tmp", "isolated-direct");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, `${String(label).replace(/[^a-z0-9_-]/gi, "-").slice(0, 60)}-`));
  const home = path.join(root, "home"), temp = path.join(root, "temp"), runtime = path.join(root, "runtime"), profiles = path.join(runtime, "profiles");
  const workspace = path.join(root, "workspace"), codex = path.join(home, ".codex");
  for (const directory of [home, temp, runtime, profiles, workspace, codex, path.join(home, "appdata"), path.join(home, "localappdata")]) await fs.mkdir(directory, { recursive: true });
  const pluginPath = path.join(profiles, "plugins.json"), upstreamPath = path.join(profiles, "mcp-upstream.json"), dotenvPath = path.join(root, "empty.env");
  await fs.writeFile(pluginPath, JSON.stringify({ schema_version: 2, computer_use: { enabled: false }, browser_use: { enabled: false }, skills: [] }));
  await fs.writeFile(upstreamPath, JSON.stringify({ version: 1, servers: [] }));
  await fs.writeFile(dotenvPath, "# Isolated direct test; no production environment\n");
  await fs.writeFile(path.join(codex, "config.toml"), "[apps._default]\nenabled = false\n[plugins]\n");
  const env = {};
  // Inspect key names first; never read inherited secret values.
  for (const key of Object.keys(baseEnv)) if (systemKey.test(key)) env[key] = baseEnv[key];
  Object.assign(env, overrides, {
    HOME: home, USERPROFILE: home, HOMEDRIVE: path.parse(home).root.replace(/[\\/]$/, ""), HOMEPATH: home.slice(path.parse(home).root.length - 1),
    TEMP: temp, TMP: temp, APPDATA: path.join(home, "appdata"), LOCALAPPDATA: path.join(home, "localappdata"),
    CODEX_HOME: codex, CLC_RUNTIME_DIR: runtime, MCP_SHELL_STATE_DIR: path.join(runtime, "mcp-state"),
    AUDIT_LOG_PATH: path.join(root, "audit.log"), CHECKPOINT_PATH: path.join(root, "checkpoints"),
    CHATGPT_PLUGINS_CONFIG: pluginPath, MCP_UPSTREAM_CONFIG: upstreamPath,
    DOTENV_CONFIG_PATH: dotenvPath, DOTENV_CONFIG_OVERRIDE: "false", MCP_TOKEN: "", ADMIN_TOKEN: "",
    HOST: "127.0.0.1", WORKSPACE_PATH: workspace, FULL_DISK_ACCESS: "false", CHATGPT_TOOL_PROFILE: "slim",
    HARNESS_RELAY_ENABLED: "false", HARNESS_RELAY_AUTOMATION_ENABLED: "false", HARNESS_COMPANION_ENABLED: "false",
    SMOKE_TUNNEL_DOCTOR: "0", npm_config_audit: "false", npm_config_fund: "false",
  });
  return { root, env };
}

/** Use before importing production modules; changes only this test process. */
export async function bootstrapIsolatedTestEnv(label) {
  const fixture = await createIsolatedTestEnv(label);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, fixture.env);
  return fixture;
}

export async function assertAuditFixture(fixture, auditModule, label) {
  assert.equal(path.resolve(auditModule.getAuditPath()), fixture.env.AUDIT_LOG_PATH, "Production audit module was imported before test-path isolation");
  const marker = `${label}:${path.basename(fixture.root)}`;
  await auditModule.audit({ tool: "isolated_direct_test", action: marker, status: "ok" });
  const text = await fs.readFile(fixture.env.AUDIT_LOG_PATH, "utf8");
  assert.ok(text.split("\n").filter(Boolean).some(line => JSON.parse(line).action === marker));
  const receipt = { test: label, fixture: fixture.root, audit_path: fixture.env.AUDIT_LOG_PATH, marker, production_audit_written: true };
  await fs.writeFile(path.join(fixture.root, "isolation.json"), JSON.stringify(receipt, null, 2));
  console.log(`DIRECT_TEST_ISOLATION ${JSON.stringify(receipt)}`);
  return receipt;
}
