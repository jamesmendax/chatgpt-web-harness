"use strict";

/**
 * Electron renderer memory circuit breaker.
 *
 * app.getAppMetrics() reports memory sizes in KiB. Inspect the exact
 * webContents.getOSProcessId(), never a window title, a stale PID, another
 * browser, MCP, tunnel, or the aggregate Electron process tree.
 *
 * This module is intentionally independent of Electron/window lifecycle, so
 * the policy can be tested deterministically without launching any GUI.
 */
const DEFAULTS = Object.freeze({
  warningMiB: 768,
  criticalMiB: 1536,
  hardMiB: 2048,
  consecutive: 2,
});

function createRendererMemoryGuard(settings = {}) {
  const options = { ...DEFAULTS, ...settings };
  if (!(options.warningMiB > 0 && options.criticalMiB > options.warningMiB &&
      options.hardMiB > options.criticalMiB && Number.isInteger(options.consecutive) &&
      options.consecutive >= 1)) {
    throw new Error("Invalid renderer memory guard policy");
  }

  let lastPid = 0;
  let warnSamples = 0;
  let criticalSamples = 0;
  let warned = false;
  let criticalIssued = false;

  function reset() {
    lastPid = 0;
    warnSamples = 0;
    criticalSamples = 0;
    warned = false;
    criticalIssued = false;
  }

  function sample(pid, processMetrics) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Array.isArray(processMetrics)) return null;
    if (pid !== lastPid) {
      reset();
      lastPid = pid;
    }
    const metric = processMetrics.find(item => item && item.pid === pid);
    // Windows-specific privateBytes: don't substitute JS heap or unrelated PIDs.
    const privateKiB = metric && metric.memory && metric.memory.privateBytes;
    if (!Number.isFinite(privateKiB) || privateKiB < 0) return null;
    const privateMiB = privateKiB / 1024;
    const workingMiB = Number.isFinite(metric.memory.workingSetSize)
      ? metric.memory.workingSetSize / 1024 : null;

    warnSamples = privateMiB >= options.warningMiB ? warnSamples + 1 : 0;
    criticalSamples = privateMiB >= options.criticalMiB ? criticalSamples + 1 : 0;
    const observation = { pid, privateMiB, workingMiB, action: null };
    if (!criticalIssued &&
        (privateMiB >= options.hardMiB || criticalSamples >= options.consecutive)) {
      criticalIssued = true;
      warned = true;
      observation.action = "recycle-renderer";
    } else if (!warned && warnSamples >= options.consecutive) {
      warned = true;
      // Reduce pixel workload without sacrificing the original shader.
      observation.action = "reduce-gpu-load";
    }
    return observation;
  }

  return { sample, reset, policy: Object.freeze({ ...options }) };
}

module.exports = { createRendererMemoryGuard, DEFAULTS };
