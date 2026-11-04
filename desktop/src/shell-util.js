"use strict";
const { spawn } = require("child_process");

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (chunk) => { err += chunk.toString(); });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err || `powershell exit ${code}`))));
    child.on("error", reject);
  });
}

module.exports = { psQuote, runPowershell };
