"use strict";

// Keep attempted delivery separate from a Windows acknowledgement. The caller
// may re-arm a reminder when both native toast and tray fallback fail.
function createIdleNotifier({ Notification, playReminderSound, getTray, iconPath, showWindow,
  log = () => {}, platform = process.platform,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout,
  nativeTimeoutMs = 5000, balloonTimeoutMs = 3000 } = {}) {
  const active = new Set();
  const balloonQueue = [];
  let activeBalloon = null;
  let disposed = false;

  // A tray's events carry no notification ID. Serialize fallbacks so a single
  // balloon-show cannot acknowledge several conversations' reminders.
  function pumpBalloons() {
    if (activeBalloon || disposed) return;
    const request = balloonQueue.shift();
    if (!request) return;
    activeBalloon = request;
    request.start();
  }

  function show({ title, body, accountId, playSound = true, log: noticeLog = log }) {
    if (disposed) return Promise.resolve(false);
    const report = (event, detail = "") => {
      try { noticeLog(event, String(detail).slice(0, 400)); } catch {}
    };
    if (platform === "win32" && playSound) {
      try {
        if (typeof playReminderSound !== "function") throw new Error("Custom reminder sound is unavailable");
        const playback = playReminderSound(accountId);
        report("sound-requested");
        Promise.resolve(playback).then(
          played => report(played === false ? "sound-failed" : "sound-played", played === false ? "Playback unavailable or disposed" : ""),
          error => report("sound-failed", error?.message || error),
        );
      }
      catch (error) { report("sound-failed", error?.message || error); }
    }

    return new Promise(resolve => {
      let native = null, nativeTimer = null, fallbackTimer = null;
      let settled = false, nativeShown = false, fallbackStarted = false, balloonRequest = null;
      let nativeHandlers = null, tray = null, trayHandlers = null;
      const entry = { dispose: () => finish(false) };
      active.add(entry);

      function detachNative() {
        if (nativeTimer !== null) { cancel(nativeTimer); nativeTimer = null; }
        if (native && nativeHandlers) {
          for (const [name, handler] of Object.entries(nativeHandlers)) native.removeListener(name, handler);
        }
        nativeHandlers = null;
        native = null;
      }
      function detachBalloon() {
        if (fallbackTimer !== null) { cancel(fallbackTimer); fallbackTimer = null; }
        if (tray && trayHandlers) {
          for (const [name, handler] of Object.entries(trayHandlers)) tray.removeListener(name, handler);
        }
        trayHandlers = null; tray = null;
        if (balloonRequest) {
          const index = balloonQueue.indexOf(balloonRequest);
          if (index >= 0) balloonQueue.splice(index, 1);
          if (activeBalloon === balloonRequest) activeBalloon = null;
          balloonRequest = null;
        }
        pumpBalloons();
      }
      function finish(delivered) {
        if (!settled) {
          settled = true;
          if (!delivered) report("delivery-failed");
          resolve(delivered);
        }
        detachNative(); detachBalloon(); active.delete(entry);
      }
      function fallback(reason) {
        if (fallbackStarted) return;
        fallbackStarted = true;
        detachNative();
        report("native-failed", reason);
        try { tray = getTray?.(); }
        catch (error) { report("balloon-failed", error?.message || error); finish(false); return; }
        if (!tray || typeof tray.displayBalloon !== "function" || tray.isDestroyed?.()) { finish(false); return; }
        balloonRequest = {
          start() {
            if (settled) { detachBalloon(); return; }
            trayHandlers = {
              "balloon-show": () => { report("balloon-shown"); finish(true); },
              "balloon-closed": () => { report("balloon-failed", "closed before display acknowledgement"); finish(false); },
              "balloon-click": () => {
                report("balloon-shown");
                try { showWindow?.(); } catch {}
                finish(true);
              },
            };
            try {
              for (const [name, handler] of Object.entries(trayHandlers)) tray.on(name, handler);
              fallbackTimer = schedule(() => { report("balloon-failed", "display acknowledgement timed out"); finish(false); }, balloonTimeoutMs);
              tray.displayBalloon({ title, content: body, iconType: "info", ...(platform === "win32" ? { noSound: true } : {}) });
            } catch (error) { report("balloon-failed", error?.message || error); finish(false); }
          },
        };
        balloonQueue.push(balloonRequest);
        pumpBalloons();
      }

      try {
        if (!Notification?.isSupported()) { fallback("native notifications unsupported"); return; }
        native = new Notification({ title, body, icon: iconPath?.(), ...(platform === "win32" ? { silent: true } : {}) });
        nativeHandlers = {
          show: () => {
            if (nativeShown) return;
            nativeShown = true;
            if (nativeTimer !== null) { cancel(nativeTimer); nativeTimer = null; }
            report("native-shown");
            if (!settled) { settled = true; resolve(true); }
            // Retain the instance and activation handler until dismissed.
          },
          click: () => { try { showWindow?.(); } catch {} finish(nativeShown); },
          close: () => { if (nativeShown) finish(true); else fallback("closed before display acknowledgement"); },
          failed: (_event, error) => {
            if (nativeShown) { report("native-failed", error || "failed after display"); finish(true); }
            else fallback(error || "native notification failed");
          },
        };
        for (const [name, handler] of Object.entries(nativeHandlers)) native.on(name, handler);
        nativeTimer = schedule(() => fallback("display acknowledgement timed out"), nativeTimeoutMs);
        native.show();
      } catch (error) { fallback(error?.message || error); }
    });
  }

  function dispose() {
    disposed = true;
    for (const entry of [...active]) entry.dispose();
  }
  return { show, dispose };
}

module.exports = { createIdleNotifier };
