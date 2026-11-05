/* Aura quality policy. One live scene, bounded buffers, no tier-owned loops. */
(function (global) {
  "use strict";
  const KEY = "wh.aura.quality";
  const CURTAIN_KEY = "wh.aura.curtain";
  const tiers = Object.freeze({
    ultra: Object.freeze({ label: "极致", activeFps: 60, idleFps: 24, dpr: 2, pixels: 8294400,
      edge: 1, halo: 1, ripple: 1, detail: 4, speed: 1, glass: 0, motion: 1 }),
    // High IS the original Aura material, not a weakened version of ultra.
    // Both share a hard pixel ceiling; ultra adds state-driven choreography,
    // using the selected opaque original, never the archived glass material.
    high: Object.freeze({ label: "高", activeFps: 60, idleFps: 12, dpr: 2, pixels: 8294400,
      edge: 1, halo: 1, ripple: 1, detail: 4, speed: 1, glass: 0 }),
    standard: Object.freeze({ label: "普通", activeFps: 30, idleFps: 8, dpr: 1, pixels: 2073600,
      edge: 0, halo: 0, ripple: 0, detail: 2, speed: .25, glass: 0 }),
    static: Object.freeze({ label: "节能", activeFps: 0, idleFps: 0, dpr: 0, pixels: 0,
      edge: 0, halo: 0, ripple: 0, detail: 0, speed: 0, glass: 0 }),
  });
  const normalize = value => Object.prototype.hasOwnProperty.call(tiers, value) ? value : "high";
  function read(storage) { try { return normalize(storage.getItem(KEY)); } catch (_) { return "high"; } }
  function save(storage, value) { try { storage.setItem(KEY, normalize(value)); return true; } catch (_) { return false; } }
  // A missing preference preserves the original High/Ultra curtain while
  // Standard starts quiet. Once the user chooses, the setting is independent
  // of all four quality tiers and survives renderer reloads.
  function readCurtain(storage) {
    try {
      const value = storage.getItem(CURTAIN_KEY);
      return value === "on" ? true : value === "off" ? false : null;
    } catch (_) { return null; }
  }
  function saveCurtain(storage, enabled) {
    try { storage.setItem(CURTAIN_KEY, enabled ? "on" : "off"); return true; } catch (_) { return false; }
  }
  function curtainEnabled(preference, tier) {
    return preference === null ? (tier === "high" || tier === "ultra") : preference === true;
  }

  // Keep dynamic-to-dynamic switches allocation-free. Static transitions
  // destroy the old context and replace only its canvas; never reuse a lost
  // context, keep an array of old canvases, or leave old loss callbacks alive.
  function createOwner({ canvas, create, replace }) {
    let current = null, closed = false, epoch = 0, created = 0, released = 0;
    function release(renew = true) {
      const old = current;
      current = null;
      epoch++;
      if (old) { try { old.dispose(); } finally { released++; } }
      if (old && renew) canvas = replace(canvas);
      return null;
    }
    function enable(enabled) {
      if (closed) return null;
      if (!enabled) return release();
      if (current) return current;
      const next = create(canvas);
      if (next) { current = next; created++; epoch++; }
      return current;
    }
    return Object.freeze({
      enable,
      current: () => current,
      status: () => ({ live: current ? 1 : 0, created, released, epoch, closed }),
      destroy() { if (closed) return; closed = true; release(false); },
    });
  }
  global.AuraQuality = Object.freeze({ KEY, CURTAIN_KEY, tiers, normalize, read, save,
    readCurtain, saveCurtain, curtainEnabled, createOwner });
})(typeof window === "undefined" ? globalThis : window);
