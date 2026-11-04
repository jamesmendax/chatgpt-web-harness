# Web Harness notification audio

`web-harness-chime.wav` is an original, generated three-note glass-style chime for Web Harness idle reminders. It uses no sampled recording, downloaded effect, or third-party font/music asset. It is covered by the project's MIT license.

- Duration: 1.15 seconds; 44,100 Hz; mono; 16-bit PCM WAV.
- Notes: A5, C#6, E6, with short softened attacks and rapidly decaying glass-like overtones.
- Peak: 55% of full scale; the sound respects Windows device volume and mute. The app never changes system volume.
- SHA-256: `c9db1f08021b564f2ca4a646cacee39cd2e61ea3eb00c0c9a3972f1495bac047`.
- Reproduce: `node desktop/scripts/generate-notification-chime.cjs` from the repository root. Existing differing audio is never overwritten automatically.
- It is included by the desktop builder's `src/**` rule. Electron reads the bytes from the bundle (including ASAR); a bounded native Windows helper receives only those WAV bytes on stdin.
- Concurrent due reminders coalesce into a single chime; notification-delivery retries do not replay it. The default OS notification sound is suppressed on Windows to avoid two overlapping sounds.
- Playback failures remain visible in diagnostic logs and do not suppress the notification itself.

Native Windows smoke test (audible, explicit opt-in): `node desktop/scripts/test-notification-sound-native.cjs --play`. Completion of the playback API is not proof that a muted speaker is audible or that the user approves the tone.
