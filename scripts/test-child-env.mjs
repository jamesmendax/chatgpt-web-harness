import assert from "node:assert/strict";

const sensitive = [
  "ADMIN_TOKEN", "MCP_TOKEN", "MCP_API_KEY", "RUNTIME_API_KEY", "OPENAI_TUNNEL_API_KEY", "CONTROL_PLANE_API_KEY",
  "HARNESS_COMPANION_TOKEN", "HARNESS_COMPANION_INSTANCE_ID", "HARNESS_COMPANION_TOKEN_EXPIRES_AT", "HARNESS_COMPANION_CAPABILITY_FILE",
  "HARNESS_COMPUTER_USE_CODEX_HOME", "HARNESS_COMPUTER_USE_RUNTIME_ROOT", "HARNESS_COMPUTER_USE_HELPER",
  "HARNESS_COMPUTER_USE_HELPER_SHA256", "HARNESS_COMPUTER_USE_CAPABILITY_FILE", "HARNESS_COMPUTER_USE_TOKEN",
  "HARNESS_COMPUTER_USE_INSTANCE_ID", "HARNESS_COMPUTER_USE_EXPIRES_AT", "HARNESS_COMPUTER_USE_AUDIT_LOG",
  "HARNESS_BROWSER_USE_RUNTIME_ROOT", "HARNESS_BROWSER_USE_RUNTIME_LOCK", "HARNESS_BROWSER_USE_RUNTIME_LOCK_SHA256",
  "HARNESS_BROWSER_USE_DATA_DIR", "HARNESS_BROWSER_USE_AUDIT_LOG", "HARNESS_BROWSER_USE_HEADLESS",
];
const previous = {};
for (const key of sensitive) {
  previous[key] = process.env[key];
  process.env[key] = `fixture-${key.toLowerCase()}`;
}
try {
  const { childProcessEnv } = await import("../dist/lib/child-env.js");
  const env = childProcessEnv();
  for (const key of sensitive) {
    assert.equal(key in env, false, `arbitrary child env leaked ${key}`);
  }
  console.log("child-env: Admin/MCP/Tunnel credentials and bundled Computer/Browser capabilities stripped from arbitrary Skill command environment OK");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
