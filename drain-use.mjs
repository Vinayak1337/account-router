import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { availableReset } from "./account-benefits.mjs";

// One selected account owns a reset cycle. Fallback traffic never waits for it.
export class DrainUse {
  constructor({
    root,
    accounts,
    selected,
    intent,
    policy,
    write,
    changed,
    fallback,
    restore,
    record,
  }) {
    Object.assign(this, {
      accounts,
      selected,
      intent,
      policy,
      write,
      changed,
      fallback,
      restore,
      record,
    });
    this.path = resolve(root, ".runtime/drain-state.json");
    this.states = Object.create(null);
    this.job = null;
    this.stopping = false;
    this.waiters = new Set();
    this.writes = Promise.resolve();
    this.ready = this.load();
  }
  async load() {
    try {
      const saved = JSON.parse(await readFile(this.path, "utf8"));
      if (!saved || typeof saved !== "object" || Array.isArray(saved))
        throw new Error();
      this.states = Object.assign(Object.create(null), saved);
      for (const state of Object.values(saved)) {
        if (!state || typeof state !== "object") throw new Error();
        if (["waiting", "resetting", "checking"].includes(state.phase)) {
          state.phase = "paused";
          state.message =
            "Interrupted reset cycle. Check saved resets before re-enabling Drain.";
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        this.loadError =
          "Drain history could not be read. Restore it before enabling Drain.";
    }
  }
  persist() {
    const data = structuredClone(this.states);
    const work = this.writes.then(() => this.write(this.path, data));
    this.writes = work.catch(() => {});
    return work;
  }
  view(account) {
    const state = this.states[account.name];
    if (account.enabled === false) return { phase: "disabled" };
    if (!account.drainEnabled) return { phase: "off" };
    if (this.loadError) return { phase: "paused", message: this.loadError };
    if (state?.identity && state.identity !== account.accountIdentity)
      return {
        phase: "paused",
        message: "Drain history belongs to another sign-in.",
      };
    if (state) return { phase: state.phase, message: state.message || null };
    return {
      phase: this.selected() === account.name && !this.job ? "active" : "armed",
    };
  }
  owner() {
    if (this.stopping || this.job || this.loadError) return null;
    const account = this.accounts.find((a) => a.name === this.selected());
    if (
      !account?.drainEnabled ||
      account.enabled === false ||
      account.signedIn === false ||
      ["identity-changed", "sign-in-required"].includes(account.reason)
    )
      return null;
    return this.view(account).phase === "active" ? account : null;
  }
  unavailable(account) {
    return this.job?.account === account;
  }
  pulse() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  manualSelection() {
    if (this.job) this.job.cancelled = true;
    this.pulse();
  }
  suspend(account) {
    if (this.job?.account === account) {
      this.job.cancelled = true;
      this.pulse();
    }
  }
  async configure(account, enabled) {
    if (this.loadError && enabled) throw new Error(this.loadError);
    if (this.job?.account === account) this.job.cancelled = true;
    delete this.states[account.name];
    await this.persist();
    this.pulse();
  }
  inspect() {
    // A naturally restored allowance makes a depleted account usable again.
    for (const account of this.accounts) {
      const state = this.states[account.name];
      if (
        state?.phase === "depleted" &&
        state.identity === account.accountIdentity &&
        !account.usageError &&
        this.policy(account).remainingPercent > 0
      ) {
        delete this.states[account.name];
        this.persist().catch(() => {
          this.states[account.name] = state;
        });
      }
    }
    const account = this.owner();
    if (
      !account ||
      (this.policy(account).remainingPercent !== 0 &&
        account.reason !== "allowance-exhausted")
    )
      return;
    const job = {
      account,
      identity: account.accountIdentity,
      intent: this.intent(),
      cancelled: false,
    };
    this.job = job;
    this.states[account.name] = { identity: job.identity, phase: "waiting" };
    this.changed();
    // Assign the promise before any callback can reconcile selection again.
    job.work = Promise.resolve()
      .then(() => this.run(job))
      .catch(() => {
        this.states[account.name] = {
          identity: job.identity,
          phase: "paused",
          message:
            "Drain paused. Check the saved reset result before re-enabling.",
        };
        return this.persist().catch(() => {});
      })
      .finally(() => {
        if (this.job === job) this.job = null;
        this.changed();
        if (!this.stopping) this.fallback().catch(() => {});
      });
    this.fallback().catch(() => {});
  }
  valid(job) {
    return (
      !this.stopping &&
      !job.cancelled &&
      job.account.enabled !== false &&
      job.account.drainEnabled &&
      job.intent === this.intent() &&
      job.identity === job.account.accountIdentity
    );
  }
  async state(job, phase, message = null) {
    this.states[job.account.name] = { identity: job.identity, phase, message };
    await this.persist();
    this.changed();
  }
  async run(job) {
    const a = job.account;
    await this.persist(); // Durable intent before spending anything.
    while (a.activeRequests && this.valid(job))
      await new Promise((resolve) => this.waiters.add(resolve));
    if (!this.valid(job))
      return this.state(
        job,
        "paused",
        "Automatic return cancelled. Toggle Drain to re-arm.",
      );
    await this.state(job, "checking");
    a.usageRevision++;
    await a.usageRefreshing;
    if (!(await a.refreshUsage()) || a.usageError)
      throw new Error("Usage could not be confirmed");
    if (!this.valid(job))
      return this.state(
        job,
        "paused",
        "Automatic return cancelled. Toggle Drain to re-arm.",
      );
    if (this.policy(a).remainingPercent === 0) {
      if (a.benefits.view().pendingCreditId)
        return this.state(
          job,
          "paused",
          "A reset is unconfirmed. Use Retry reset in Details before re-enabling Drain.",
        );
      if (!(await a.benefits.refresh()))
        throw new Error("Reset details unavailable");
      const credit = a.benefits.details.credits
        .filter(
          (c) =>
            availableReset(c) &&
            !a.benefits.journal.attempts.some(
              (attempt) => attempt.creditId === c.id,
            ),
        )
        .sort(
          (a, b) => (a.expiresAt || Infinity) - (b.expiresAt || Infinity),
        )[0];
      if (!credit)
        return this.state(
          job,
          "depleted",
          "No usable saved resets. Normal routing is active.",
        );
      if (!this.valid(job))
        return this.state(
          job,
          "paused",
          "Automatic return cancelled. Toggle Drain to re-arm.",
        );
      await this.state(job, "resetting");
      const result = await a.benefits.consume(credit.id, {
        guard: () => this.valid(job),
      });
      this.record(a, "Drain reset finished: " + result.outcome + ".");
      if (
        !result.usageRefreshed ||
        !["reset", "already_redeemed", "nothing_to_reset"].includes(
          result.outcome,
        )
      )
        return this.state(
          job,
          "paused",
          "Reset did not confirm restored usage. Check Details before re-enabling Drain.",
        );
    }
    if (
      !Number.isFinite(this.policy(a).remainingPercent) ||
      this.policy(a).remainingPercent <= 0 ||
      a.usageError ||
      a.blockedUntil > Date.now()
    )
      return this.state(
        job,
        "paused",
        "Allowance has not recovered. No further reset will be spent automatically.",
      );
    if (!this.valid(job))
      return this.state(
        job,
        "paused",
        "Reset finished. Automatic return was cancelled.",
      );
    delete this.states[a.name];
    await this.persist();
    // Recheck after durable writes: a newer manual selection always wins.
    if (this.valid(job)) {
      this.job = null;
      this.restore(a);
      this.record(a, "Drain restored the previous account for new requests.");
    }
  }
  async stop() {
    this.stopping = true;
    this.pulse();
    await this.job?.work;
    await this.writes;
  }
}
