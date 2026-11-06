"use strict";
const { spawn } = require("child_process");

// PowerShell accepts ‘ ’ ‚ ‛ (U+2018–U+201B) as single quotes too. Escaping only
// the ASCII ' let a file name such as skill’+$(…)+’.zip end the literal and run
// code; doubling each quote character keeps it literal.
function psQuote(value) {
  return String(value).replace(/['‘’‚‛]/g, "$&$&");
}

function runPowershell(command) {
  return new Promise((resolve, reject) => {
    // UTF-8 error text (the zip checks report in Chinese, GBK otherwise), and
    // wait for "close": "exit" can fire before stderr has been read to the end.
    const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); " + command;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const chunks = [];
    child.stderr.on("data", (chunk) => { chunks.push(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      const err = Buffer.concat(chunks).toString("utf8").trim();
      if (code === 0) resolve(); else reject(new Error(err || `powershell exit ${code}`));
    });
  });
}

module.exports = { psQuote, runPowershell };
