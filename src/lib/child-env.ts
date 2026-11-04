/** Environment for commands launched through MCP tools.
 *
 * The harness intentionally grants broad filesystem access, but transport and
 * Admin bearer tokens must not be inherited by arbitrary Skill commands.
 */
export function childProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ADMIN_TOKEN;
  delete env.HARNESS_COMPANION_TOKEN;
  delete env.HARNESS_COMPANION_INSTANCE_ID;
  delete env.HARNESS_COMPANION_TOKEN_EXPIRES_AT;
  delete env.HARNESS_COMPANION_CAPABILITY_FILE;
  delete env.MCP_TOKEN;
  delete env.MCP_API_KEY;
  delete env.RUNTIME_API_KEY;
  delete env.OPENAI_TUNNEL_API_KEY;
  delete env.CONTROL_PLANE_API_KEY;
  // Bundled provider locations and capabilities are launcher-internal. Skills
  // and arbitrary shell children must never inherit them.
  delete env.HARNESS_COMPUTER_USE_CODEX_HOME;
  delete env.HARNESS_COMPUTER_USE_RUNTIME_ROOT;
  delete env.HARNESS_COMPUTER_USE_HELPER;
  delete env.HARNESS_COMPUTER_USE_HELPER_SHA256;
  delete env.HARNESS_COMPUTER_USE_CAPABILITY_FILE;
  delete env.HARNESS_COMPUTER_USE_TOKEN;
  delete env.HARNESS_COMPUTER_USE_INSTANCE_ID;
  delete env.HARNESS_COMPUTER_USE_EXPIRES_AT;
  delete env.HARNESS_COMPUTER_USE_AUDIT_LOG;
  delete env.HARNESS_BROWSER_USE_RUNTIME_ROOT;
  delete env.HARNESS_BROWSER_USE_RUNTIME_LOCK;
  delete env.HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256;
  delete env.HARNESS_BROWSER_USE_DATA_DIR;
  delete env.HARNESS_BROWSER_USE_AUDIT_LOG;
  delete env.HARNESS_BROWSER_USE_HEADLESS;
  return { ...env, ...overrides };
}
