"use strict";
// Explicit audible smoke test; never play audio as a side effect of normal CI.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createNotificationSound, WAV_PATH } = require("../src/notification-sound");
if (process.platform !== "win32" || !process.argv.includes("--play")) {
  console.log("SKIP native audio: Windows and explicit --play are required");
} else {
  const player = createNotificationSound();
  (async () => {
    try {
      assert.equal(await player.play(), true);
      const report = { passed: true, at: new Date().toISOString(), native_playback_completed: true,
        playback: "Windows System.Media.SoundPlayer.PlaySync", asset: WAV_PATH,
        sha256: crypto.createHash("sha256").update(fs.readFileSync(WAV_PATH)).digest("hex"),
        seconds: 1.15, system_volume_changed: false, default_beep_used: false,
        listener_audibility_verified: false, user_timbre_approval: false,
        limits: "Native call completion does not attest speaker audibility, user volume, or subjective sound quality." };
      const file = path.resolve(__dirname, "../../.validation/notification-sound/native.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify({ ...report, report: file }, null, 2));
    } finally { player.dispose(); }
  })().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
