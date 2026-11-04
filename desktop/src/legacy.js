"use strict";
// 兼容旧脚本：读取 .secrets\*-runtime-key.xml（PowerShell Export-Clixml 的 SecureString，DPAPI 当前用户）。
// 通过 PowerShell 解密后返回明文，仅在用户主动点击“导入旧密钥”时调用，且明文只在主进程内存中短暂存在。
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

function legacyKeyFiles() {
  const root = paths.REPO_ROOT;
  const candidates = [
    { label: "Business", file: path.join(root, ".secrets", "business-runtime-key.xml") },
    { label: "Free", file: path.join(root, ".secrets", "free-runtime-key.xml") },
  ];
  return candidates.filter((c) => fs.existsSync(c.file));
}

function readLegacyKey(file) {
  return new Promise((resolve, reject) => {
    const script = [
      "$ErrorActionPreference='Stop'",
      `$s = Import-Clixml -LiteralPath '${String(file).replace(/'/g, "''")}'`,
      "if ($s -isnot [System.Security.SecureString]) { throw 'not a SecureString' }",
      "$p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)",
      "try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }",
    ].join("; ");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 || !out.trim()) {
        reject(new Error(`无法解密旧密钥文件（需要与保存时相同的 Windows 用户）: ${err.trim().slice(0, 200)}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

/** 读取仓库 .env 中的值（用于导入旧的 OPENAI_TUNNEL_ID / WORKSPACE_PATH）。 */
function readDotEnvValue(name) {
  try {
    const text = fs.readFileSync(path.join(paths.REPO_ROOT, ".env"), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx < 0) continue;
      if (line.slice(0, idx).trim() !== name) continue;
      return line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    }
  } catch {}
  return "";
}

/** 读取旧 profiles/*.yaml 中的 tunnel_id。 */
function readProfileTunnelId(profileName) {
  try {
    const text = fs.readFileSync(path.join(paths.REPO_ROOT, "profiles", profileName), "utf8");
    const match = text.match(/tunnel_id:\s*(tunnel_[0-9a-f]{32})/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

module.exports = { legacyKeyFiles, readLegacyKey, readDotEnvValue, readProfileTunnelId };
