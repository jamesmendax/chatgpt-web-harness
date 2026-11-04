"use strict";
// Loopback Admin API client.  The token is accepted only as an in-memory
// argument and is never included in URLs, logs, or error messages.
const http = require("http");

const MAX_RESPONSE_BYTES = 2_000_000;

function getJson(port, pathname, token, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "GET",
      timeout: timeoutMs,
      headers: token ? { "x-admin-token": token } : {},
    }, (res) => {
      let body = "";
      let overflow = false;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length >= MAX_RESPONSE_BYTES) {
          overflow = true;
          return;
        }
        body += chunk;
        if (body.length > MAX_RESPONSE_BYTES) {
          body = body.slice(0, MAX_RESPONSE_BYTES);
          overflow = true;
        }
      });
      res.on("end", () => {
        if (overflow || res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });
}

module.exports = { getJson };
