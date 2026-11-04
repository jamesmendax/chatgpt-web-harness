"use strict";
// One-shot Electron child process: decrypt old profile material inside a private
// cloned userData context. Protocol uses fd3/fd4 anonymous local pipes only.
const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");
function run() {
  const dir = process.env.WH_IMPORT_CONTEXT_DIR || "";
  const nonce = process.env.WH_IMPORT_NONCE || "";
  if (!path.isAbsolute(dir) || !/^[a-f0-9]{48}$/.test(nonce) || !fs.existsSync(path.join(dir, "Local State"))) {
    app.exit(2);
    return;
  }
  app.setPath("userData", dir);
  const input = fs.createReadStream(null, { fd: 3, autoClose: false });
  let raw = "", finished = false;
  const fail = () => { if (!finished) { finished = true; app.exit(2); } };
  const timer = setTimeout(fail, 25000);
  input.on("data", chunk => {
    raw += chunk.toString("utf8");
    if (raw.length > 350000) fail();
  });
  input.once("error", fail);
  input.once("end", () => {
    app.whenReady().then(() => {
      if (finished) return;
      try {
        if (!safeStorage.isEncryptionAvailable()) throw Error("UNAVAILABLE");
        const req = JSON.parse(raw);
        if (req.nonce !== nonce || !req.apiKeyEnc || typeof req.apiKeyEnc !== "string" ||
            typeof req.adminTokenEnc !== "string") throw Error("INVALID_REQUEST");
        const decrypt = value => {
          if (!value) return "";
          if (value.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error("INVALID_CIPHER");
          return safeStorage.decryptString(Buffer.from(value,"base64"));
        };
        const apiKey = decrypt(req.apiKeyEnc);
        const adminToken = decrypt(req.adminTokenEnc);
        if (!apiKey.trim()) throw Error("EMPTY_KEY");
        // fd4 is a private anonymous pipe, not process stdout/stderr.
        const reply = Buffer.from(JSON.stringify({ nonce, apiKey, adminToken }), "utf8");
        fs.writeSync(4, reply);
        reply.fill(0);
        finished = true;
        clearTimeout(timer);
        app.exit(0);
      } catch { fail(); }
    }).catch(fail);
  });
}
module.exports = { run };
