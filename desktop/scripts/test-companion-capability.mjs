import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const capability = require("../src/companion-capability.js");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "web-harness-companion-capability-"));
const file = path.join(temp, "capability.json");
const start = Date.parse("2026-09-14T12:00:00.000Z");

try {
  const first = capability.issue("default", { now: start });
  const sameRun = capability.issue("default", { now: start + 60_000 });
  assert.equal(sameRun, first, "one Desktop run must share one capability until its refresh window");
  assert.match(first.token, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(first.instance_id, /^cpi_[a-f0-9]{32}$/);
  assert.equal(Date.parse(first.expires_at) - start, capability.DEFAULT_TTL_MS);
  capability.materialize(file, first);
  const disk = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(disk.token, first.token);
  assert.equal(disk.instance_id, first.instance_id);

  const rotated = capability.issue("default", {
    now: start + capability.DEFAULT_TTL_MS - capability.REFRESH_WINDOW_MS + 1,
    refreshIfExpiring: true,
  });
  assert.notEqual(rotated.token, first.token, "near-expiry refresh must mint fresh entropy");
  assert.notEqual(rotated.instance_id, first.instance_id);
  capability.materialize(file, rotated);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).token, rotated.token);

  capability.revoke("default", file);
  await assert.rejects(() => fs.readFile(file, "utf8"), { code: "ENOENT" });
  const afterRevoke = capability.issue("default", { now: start + capability.DEFAULT_TTL_MS });
  assert.notEqual(afterRevoke.token, rotated.token);

  console.log("companion capability: per-run entropy, expiry refresh, instance binding, atomic materialization, and revocation passed");
} finally {
  capability.revoke("default", file);
  await fs.rm(temp, { recursive: true, force: true });
}

