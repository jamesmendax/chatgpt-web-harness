"use strict";
// Original Web Harness glass chime. No sampled recording or external dependency.
// Reproducible 44.1 kHz / mono / 16-bit PCM, A5-C#6-E6 with a soft glass overtone.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const SAMPLE_RATE = 44100;
const DURATION_SECONDS = 1.15;
function makeChime() {
  const count = Math.round(SAMPLE_RATE * DURATION_SECONDS);
  const samples = new Float64Array(count);
  const notes = [[0.025, 880], [0.185, 1108.7305239074883], [0.355, 1318.5102276514797]];
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const t = i / SAMPLE_RATE;
    let value = 0;
    for (const [start, hz] of notes) {
      const age = t - start;
      if (age < 0) continue;
      const attack = Math.min(1, age / 0.004);
      value += attack * (
        Math.sin(2 * Math.PI * hz * age) * Math.exp(-age / 0.175) +
        0.21 * Math.sin(2 * Math.PI * hz * 2.756 * age) * Math.exp(-age / 0.073) +
        0.035 * Math.sin(2 * Math.PI * hz * 4 * age) * Math.exp(-age / 0.038)
      );
    }
    const endFade = Math.min(1, (count - 1 - i) / (SAMPLE_RATE * 0.035));
    samples[i] = value * Math.max(0, endFade);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  const dataBytes = count * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write("WAVE", 8);
  wav.write("fmt ", 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(samples[i] / peak * 0.55 * 32767), 44 + i * 2);
  return wav;
}
if (require.main === module) {
  const target = path.resolve(__dirname, "../src/assets/web-harness-chime.wav");
  const wav = makeChime();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(wav)) throw new Error("Existing sound differs; refusing to overwrite it automatically");
  } else fs.writeFileSync(target, wav, { flag: "wx" });
  console.log(JSON.stringify({ path: target, bytes: wav.length, seconds: DURATION_SECONDS,
    sha256: crypto.createHash("sha256").update(wav).digest("hex") }));
}
module.exports = { makeChime, SAMPLE_RATE, DURATION_SECONDS };
