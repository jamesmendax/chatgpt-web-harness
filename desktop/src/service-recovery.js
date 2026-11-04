"use strict";

// Recovery is driven by an actual exit of a process we own, NEVER by a failed
// HTTP health probe. In-flight tool calls are not replayed by this supervisor.
class OwnedServiceRecovery {
  constructor(options) {
    this.options = options;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.random = options.random || Math.random;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.maxDelayMs = options.maxDelayMs ?? 30000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.stableMs = options.stableMs ?? 60000;
    this.epoch = 0;
    this.wanted = false;
    this.attempts = 0;
    this.timer = null;
    this.inFlight = false;
    this.nextAt = null;
    this.state = "disabled";
    this.reason = null;
    this.run = (fn) => fn();
    this.valid = () => true;
  }

  arm({ run = (fn) => fn(), valid = () => true } = {}) {
    this.disarm();
    this.wanted = true;
    this.attempts = 0;
    this.state = "monitoring";
    this.reason = null;
    this.run = run;
    this.valid = valid;
    const epoch = this.epoch;
    this.guard = () => {
      if (!this.wanted || this.epoch !== epoch) return false;
      try { return Boolean(this.run(this.valid)); } catch { return false; }
    };
    return this.guard;
  }

  disarm(reason = "intentional_stop") {
    this.epoch++;
    this.wanted = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.nextAt = null;
    this.state = "disabled";
    this.reason = reason;
  }

  block(reason) {
    this.disarm(reason);
    this.state = "blocked";
    this.options.note?.(`${this.options.name}: automatic recovery blocked (${reason}); no process was taken over or tool call replayed.`);
  }

  onUnexpectedExit(event = {}) {
    if (!this.wanted || event.intentional) return;
    if (event.startedAt && this.now() - event.startedAt >= this.stableMs) this.attempts = 0;
    this.schedule();
  }

  schedule(delayOverride) {
    if (!this.wanted || this.timer !== null || this.inFlight || this.options.isAlive()) return;
    if (!this.guard()) { this.block("ownership_or_configuration_changed"); return; }
    if (this.run(() => this.options.isBlocked?.())) { this.block("authentication_or_shutdown"); return; }
    if (this.attempts >= this.maxAttempts) { this.block("retry_budget_exhausted"); return; }
    const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** this.attempts));
    const delay = delayOverride ?? Math.max(1, Math.round(exponential * (0.8 + 0.4 * this.random())));
    const epoch = this.epoch;
    const guard = this.guard;
    const run = this.run;
    this.state = "backoff";
    this.nextAt = this.now() + delay;
    this.timer = this.setTimer(async () => {
      this.timer = null;
      this.nextAt = null;
      if (this.epoch !== epoch || !this.wanted) return;
      if (!guard()) { this.block("ownership_or_configuration_changed"); return; }
      if (this.options.isAlive()) { this.state = "monitoring"; return; }
      if (this.run(() => this.options.isBlocked?.())) { this.block("authentication_or_shutdown"); return; }
      // User actions and service startup own the operation slot. Do not turn a
      // busy slot into a consumed retry or start a duplicate process.
      if (this.options.isBusy()) { this.schedule(this.baseDelayMs); return; }
      this.inFlight = true;
      this.state = "restarting";
      this.attempts++;
      this.options.note?.(`${this.options.name}: recovering owned process, attempt ${this.attempts}/${this.maxAttempts}.`);
      try {
        await run(() => this.options.restart(guard));
        if (this.epoch === epoch) this.state = "monitoring";
      } catch {
        // Error details belong to the underlying status/launcher log. Do not
        // echo credential-bearing exception text from spawn/configuration.
        if (this.epoch === epoch) this.reason = "restart_failed";
      } finally {
        this.inFlight = false;
        if (this.epoch === epoch && this.wanted && !this.options.isAlive()) this.schedule();
      }
    }, delay);
    this.timer?.unref?.();
  }

  snapshot() {
    return { enabled: this.wanted, state: this.state, attempts: this.attempts,
      maxAttempts: this.maxAttempts, nextAt: this.nextAt, reason: this.reason };
  }
}

module.exports = { OwnedServiceRecovery };
