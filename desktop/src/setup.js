"use strict";
// Initialization owns a short-lived local MCP lease; doctor never starts a Tunnel.
function redactSetupText(value, secrets = []) {
  let text = String(value ?? "");
  for (const secret of secrets) if (typeof secret === "string" && secret) text = text.split(secret).join("<REDACTED>");
  return text.replace(/(Bearer\s+)[^\s"']+/gi, "$1<REDACTED>")
    .replace(/(["'][\w-]*(?:key|token|secret|password)[\w-]*["']\s*:\s*["'])[^"']*/gi, "$1<REDACTED>")
    .replace(/\b((?:[\w-]*(?:key|token|secret|password)[\w-]*)\s*[=:]\s*)[^\s;,"']+/gi, "$1<REDACTED>")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "<REDACTED>");
}
function parseDoctorChecks(output) {
  const checks = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = /^\s*CHECK\s+([\w.-]+)\s+(PASS|FAIL|SKIP)\b\s*(.*)$/.exec(line);
    if (!match) continue;
    const previous = checks.get(match[1]);
    checks.set(match[1], { name: match[1], status: match[2], message: match[3] || previous?.message || "" });
  }
  return [...checks.values()];
}
function diagnoseSetupFailure({ output = "", error, stage = "doctor", secrets = [] } = {}) {
  const details = redactSetupText([output, error?.message].filter(Boolean).join("\n"), secrets);
  const checks = parseDoctorChecks(details), failed = checks.filter(check => check.status === "FAIL");
  const names = new Set(failed.map(check => check.name));
  let code, title, message, nextAction;
  if (names.has("mcp_server_reachable") || /ECONNREFUSED|actively refused|connection refused|目标计算机积极拒绝/i.test(details)) {
    code = "LOCAL_MCP_UNREACHABLE"; title = "本机 MCP 未就绪";
    message = "初始化校验无法连接本机 MCP 服务；尚不能据此判断云端凭据是否有效。";
    nextAction = "查看 MCP 启动日志，确认本账户端口可用后重试初始化。";
  } else if (names.has("oauth_metadata") && !failed.some(c => c.name !== "oauth_metadata" && /\b(?:401|403)\b|unauthorized|forbidden/i.test(c.message))) {
    code = "OAUTH_METADATA_FAILED"; title = "本机 OAuth 元数据校验失败";
    message = "本机服务的 OAuth 发现或元数据响应未通过校验。";
    nextAction = "查看本机 MCP 元数据与就绪状态，不要仅据此更换云端密钥。";
  } else if (/\b(?:401|403)\b|unauthorized|forbidden/i.test(failed.map(c => c.message).join("\n") || details)) {
    code = "AUTH_REJECTED"; title = "认证被拒绝";
    message = "服务明确返回 401/403，认证或访问权限未通过。";
    nextAction = "核对 Tunnel ID 与 Runtime API Key 及其权限后重试。";
  } else if (failed.some(c => /^(config_source|profile_load|tunnel_id|control_plane_api_key|mcp_target)$/.test(c.name))) {
    code = "MISSING_CONFIG"; title = "初始化配置不完整"; message = "必要配置缺失或无法读取。";
    nextAction = "核对工作区、端口、Tunnel ID 和 Runtime API Key。";
  } else if (stage === "config") {
    code = "CONFIG_SAVE_FAILED"; title = "配置保存失败";
    message = "账户配置未能保存，初始化状态未提交。" + (error?.message ? "原因：" + redactSetupText(error.message, secrets) : "");
    nextAction = "检查账户配置目录的写入权限与可用空间后重试。";
  } else if (stage === "local-mcp") {
    code = /端口|port|外部|external/i.test(details) ? "LOCAL_MCP_PORT_CONFLICT" : "LOCAL_MCP_START_FAILED";
    title = "本机 MCP 启动失败"; message = error?.message ? redactSetupText(error.message, secrets) : "初始化所需的本机服务未能安全启动。";
    nextAction = code === "LOCAL_MCP_PORT_CONFLICT" ? "在设置中为 MCP 和 Admin 选择未占用的端口，再重试初始化。" : "查看 MCP 启动日志，修正上述问题后重试。";
  } else {
    code = /ENOTFOUND|ETIMEDOUT|network|timeout|timed out|网络|超时/i.test(details) ? "NETWORK_FAILED" : "DOCTOR_FAILED";
    title = "初始化检查未通过"; message = "检查进程或网络请求失败，尚未完成初始化。";
    nextAction = "查看下方失败检查与诊断后重试。";
  }
  return { stage, code, title, message, nextAction, checks, details };
}
async function initializeAccount({ cfg, skipDoctor = false, services, saveConfig, decryptKey, publicView, progress = () => {} }) {
  const previousDone = cfg.setupDone;
  let apiKey = "", stage = "config", doctor = { ok: true, output: "（已跳过初始化检查）" };
  try {
    if (!cfg.tunnelId || !cfg.apiKeyEnc || !cfg.workspacePath) {
      return { ok: false, doctor: "", ...diagnoseSetupFailure({ output: "CHECK config_source FAIL missing required configuration", stage }) };
    }
    await saveConfig(cfg); // setupDone retains its prior value until the entire lease is cleaned up.
    if (!skipDoctor) {
      apiKey = decryptKey(cfg);
      stage = "local-mcp";
      progress(stage, "临时启动本账户 MCP，等待本机服务就绪 ...");
      doctor = await services.withSetupMcp(async () => {
        stage = "doctor";
        progress(stage, "运行本机 MCP 与 Tunnel 配置检查 ...");
        return services.runDoctor(cfg, apiKey, line => progress("doctor-line", redactSetupText(line, [apiKey])));
      });
      doctor = { ...doctor, output: redactSetupText(doctor.output, [apiKey]) };
      if (!doctor.ok || parseDoctorChecks(doctor.output).some(c => c.status === "FAIL")) {
        return { ok: false, doctor: doctor.output, ...diagnoseSetupFailure({ output: doctor.output, stage, secrets: [apiKey] }) };
      }
    }
    stage = "config";
    cfg.setupDone = true;
    await saveConfig(cfg);
    return { ok: true, doctor: doctor.output, config: publicView(cfg) };
  } catch (error) {
    cfg.setupDone = previousDone;
    return { ok: false, doctor: redactSetupText(doctor.output, [apiKey]), ...diagnoseSetupFailure({ output: doctor.output, error, stage, secrets: [apiKey] }) };
  }
}
module.exports = { initializeAccount, parseDoctorChecks, diagnoseSetupFailure, redactSetupText };
