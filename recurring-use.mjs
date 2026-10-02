// Ready recurring accounts continuously take precedence in saved priority order.
// Their monitor remains inside the router and stops with its graceful shutdown.
export class RecurringUse {
  constructor({
    accounts,
    policy,
    needsReading,
    eligible,
    reconcile,
    changed,
    pollMs = 60_000,
  }) {
    Object.assign(this, {
      accounts,
      policy,
      needsReading,
      eligible,
      reconcile,
      changed,
      pollMs,
    });
    this.timer = null;
    this.work = null;
    this.refreshWork = null;
    this.stopping = false;
  }
  exhausted(a) {
    return (
      this.policy(a).atThreshold ||
      this.needsReading(a) ||
      a.reason === "allowance-exhausted"
    );
  }
  ready(a) {
    const p = this.policy(a);
    return (
      a.recurringUse &&
      this.eligible(a) &&
      !a.usageError &&
      Number.isFinite(p.remainingPercent) &&
      p.remainingPercent > p.switchAtRemainingPercent &&
      a.usageUpdatedAt &&
      Date.now() - a.usageUpdatedAt <= this.pollMs
    );
  }
  take(excluded = new Set()) {
    // Compare priorities only after concurrent account refreshes settle.
    if (
      this.accounts.some(
        (a) => a.enabled !== false && a.recurringUse && a.usageRefreshing,
      )
    )
      return null;
    return this.accounts.find((a) => !excluded.has(a) && this.ready(a)) || null;
  }
  changedAccount() {
    this.kick();
  }
  snapshot() {
    return {};
  }
  view(a) {
    return a.enabled === false
      ? "disabled"
      : !a.recurringUse
        ? "off"
        : this.ready(a)
          ? "ready"
          : this.exhausted(a)
            ? "waiting"
            : "checking";
  }
  dueAt(a) {
    const checked = a.lastUsageAttempt || a.usageUpdatedAt || 0;
    let due = checked + this.pollMs;
    // Wake at the actual reported reset, even with the dashboard closed. Failed
    // reads retry at the normal interval instead of looping on a past deadline.
    if (this.exhausted(a))
      for (const w of Object.values(a.usage || {})) {
        const reset = w?.resetsAt * 1000;
        if (
          Number.isFinite(reset) &&
          reset > checked &&
          w.usedPercent >= 100 - (a.switchAtRemainingPercent ?? 1)
        )
          due = Math.min(due, reset + 100);
      }
    return due;
  }
  refreshDue() {
    if (this.stopping) return Promise.resolve();
    if (this.refreshWork) return this.refreshWork;
    const due = this.accounts.filter(
      (a) =>
        a.enabled !== false &&
        a.recurringUse &&
        a.signedIn !== false &&
        this.dueAt(a) <= Date.now(),
    );
    if (!due.length) return Promise.resolve();
    this.refreshWork = Promise.all(due.map((a) => a.refreshUsage()))
      .then(() => this.changed())
      .finally(() => {
        this.refreshWork = null;
      });
    return this.refreshWork;
  }
  kick() {
    if (!this.accounts.some((a) => a.enabled !== false && a.recurringUse)) {
      clearTimeout(this.timer);
      this.timer = null;
      return;
    }
    if (this.stopping || this.work) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, 0);
    this.timer.unref?.();
  }
  run() {
    if (this.stopping || this.work) return;
    this.work = (async () => {
      await this.refreshDue();
      if (!this.stopping) await this.reconcile();
    })()
      .catch(() => {})
      .finally(() => {
        this.work = null;
        this.schedule();
      });
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const monitored = this.accounts.filter(
      (a) => a.enabled !== false && a.recurringUse && a.signedIn !== false,
    );
    if (this.stopping || !monitored.length) return;
    const delay = Math.max(
      100,
      Math.min(...monitored.map((a) => this.dueAt(a))) - Date.now(),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, delay);
    this.timer.unref?.();
  }
  async stop() {
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = null;
    await this.work;
    await this.refreshWork;
  }
}
