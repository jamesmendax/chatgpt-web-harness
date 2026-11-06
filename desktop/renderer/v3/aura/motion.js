/* Aura ultra choreography: one bounded state, no timers, trails or GPU allocation. */
(function (global) {
  "use strict";
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const LIMIT = 128;
  function create() {
    const seen = new Map();
    const values = new Float32Array([0, 1, 1, 0]);
    const orbit = new Float32Array([0, 0, 9, 0]);
    const result = { values, orbit, moving: false, phase: "idle" };
    let account = null, running = 0, last = null, energy = 0, phase = 0, flow = 9;
    let startAt = -Infinity, endAt = -Infinity, outcome = 0, ended = false;
    function reset(id = account) {
      account = id; running = 0; last = null; energy = 0; startAt = endAt = -Infinity;
      outcome = 0; seen.clear(); values.set([0, 1, 1, 0]); orbit.set([phase, 0, flow, 0]);
      result.moving = false; result.phase = "idle";
    }
    function sync(records, id) {
      if (ended) return;
      if (id !== account) reset(id);
      let count = 0;
      if (Array.isArray(records)) for (const row of records) {
        if (row && row.phase === "running") count++;
      }
      running = Math.min(64, count);
    }
    function event(kind, record, now) {
      if (ended || !Number.isFinite(now) || (kind !== "start" && kind !== "end")) return false;
      const id = record && (record.invocationId || record.callId || record.id);
      const key = id ? kind + ":" + String(id).slice(0, 240) : null;
      if (key && seen.has(key)) return false;
      if (key) {
        seen.set(key, now);
        if (seen.size > LIMIT) seen.delete(seen.keys().next().value);
      }
      if (kind === "start") {
        // Batches share one gathering gesture rather than spawning rings.
        if (now - startAt > 320) startAt = now;
      } else {
        const p = record && record.phase;
        const fail = p === "failed" || p === "error" || record?.ok === false;
        const unknown = p === "unknown" || record?.outcomeKind === "unknown";
        const done = p === "done" || p === "completed" || p === "success" || record?.ok === true;
        // Uncertain outcomes never masquerade as success.
        outcome = fail ? -1 : unknown || !done ? .5 : 1;
        endAt = now;
        if (!Number.isFinite(startAt)) startAt = now - 240;
      }
      return true;
    }
    function sample(now, enabled = true) {
      if (ended) return result;
      const n = Number.isFinite(now) ? now : (last ?? 0);
      const dt = last === null ? 0 : clamp((n - last) / 1000, 0, .1);
      last = n;
      const target = enabled && running ? 1 : 0;
      energy += (target - energy) * (1 - Math.exp(-dt / (target ? .24 : .65)));
      if (Math.abs(target - energy) < .0001) energy = target;
      const start = clamp((n - startAt) / 720, 0, 1);
      const finish = clamp((n - endAt) / 1850, 0, 1);
      // Integrate velocity, never multiply an absolute clock by a new speed.
      // A call can accelerate and decelerate without making the texture jump.
      if (enabled) {
        phase = (phase + dt * (.16 + energy * .92 + Math.min(running, 4) * .04)) % (Math.PI * 2);
        flow += dt * (1 + energy * .85);
      }
      values[0] = enabled ? energy : 0;
      values[1] = enabled ? start : 1;
      values[2] = enabled ? finish : 1;
      values[3] = enabled && finish < 1 ? outcome : 0;
      orbit[0] = phase;
      orbit[1] = Math.min(1, Math.max(0, running - 1) / 3);
      orbit[2] = flow;
      orbit[3] = enabled ? 1 : 0;
      result.moving = enabled && (running > 0 || start < 1 || finish < 1 || energy > .002);
      result.phase = !enabled ? "still" : running ? (start < 1 ? "gather" : "working")
        : finish < 1 ? outcome < 0 ? "failed" : outcome === 1 ? "complete" : "uncertain" : "idle";
      return result;
    }
    // The material clock is float32 on the GPU, so it steps visibly after
    // days. Restart it only where the caller knows the jump cannot be seen.
    function rebase(limit = 0) {
      if (ended || !(flow > limit)) return false;
      flow = 9; orbit[2] = flow;
      return true;
    }
    function status() { return { account, running, seen: seen.size, energy, phase: result.phase, flow, destroyed: ended }; }
    function destroy() { reset(); ended = true; result.phase = "disposed"; }
    return Object.freeze({ sync, event, sample, reset, rebase, status, destroy });
  }
  global.AuraMotion = Object.freeze({ create });
  if (typeof module !== "undefined" && module.exports) module.exports = global.AuraMotion;
})(typeof window === "undefined" ? globalThis : window);
