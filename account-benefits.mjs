import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const outcomes = new Set([
  "reset",
  "already_redeemed",
  "nothing_to_reset",
  "no_credit",
]);
const success = (code) => code === "reset" || code === "already_redeemed";
export function timestamp(value) {
  const ms =
    typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : null;
}
export function subscriptionFromClaims(auth = {}) {
  return {
    plan: auth.chatgpt_plan_type || null,
    activeUntil: timestamp(auth.chatgpt_subscription_active_until),
    checkedAt: timestamp(auth.chatgpt_subscription_last_checked),
  };
}
export function availableReset(credit, now = Date.now()) {
  return (
    credit.status === "available" &&
    credit.supported &&
    credit.expiryKnown &&
    (!credit.expiresAt || credit.expiresAt * 1000 > now)
  );
}
function normalize(data) {
  if (
    !Array.isArray(data?.credits) ||
    !Number.isInteger(data.available_count) ||
    data.available_count < 0
  )
    throw new Error("Invalid reset details.");
  return {
    availableCount: data.available_count,
    credits: data.credits
      .filter(
        (c) =>
          typeof c.id === "string" && c.id.length > 0 && c.id.length <= 256,
      )
      .map((c) => ({
        id: c.id,
        resetType: c.reset_type,
        status: c.status,
        supported:
          c.reset_type === "codex_rate_limits" &&
          c.is_supported_by_plan !== false,
        expiresAt: timestamp(c.expires_at),
        expiryKnown: c.expires_at === null || timestamp(c.expires_at) !== null,
        title:
          typeof c.title === "string"
            ? c.title.slice(0, 200)
            : "Full usage reset",
        description:
          typeof c.description === "string"
            ? c.description.slice(0, 1000)
            : null,
      })),
  };
}

// Resets require explicit manual confirmation. The durable journal preserves
// the same credit and idempotency key for an unconfirmed attempt across restarts.
export class AccountBenefits {
  constructor(account, root, writeJson) {
    this.account = account;
    this.writeJson = writeJson;
    this.path = resolve(
      root,
      ".runtime",
      "reset-attempts",
      account.name + ".json",
    );
    this.details = {
      availableCount: null,
      credits: null,
      updatedAt: null,
      error: null,
    };
    this.journal = { attempts: [] };
    this.refreshing = null;
    this.consuming = null;
    this.loadError = null;
    this.ready = this.loadJournal();
  }
  async loadJournal() {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !Array.isArray(data.attempts) ||
        data.attempts.some((a) => !a.creditId || !a.key || !a.identity)
      )
        throw new Error("Invalid journal");
      this.journal = data;
    } catch (error) {
      if (error.code !== "ENOENT")
        this.loadError =
          "Saved reset history could not be read. Restore it before redeeming another reset.";
    }
  }
  view() {
    return {
      ...this.details,
      busy: !!this.consuming,
      error: this.loadError || this.details.error,
      pendingCreditId:
        this.journal.attempts.find((a) => !a.outcome)?.creditId || null,
    };
  }
  async request(body) {
    let tokens = await this.account.token();
    const send = () =>
      this.account.fetcher(BASE + (body ? "/consume" : ""), {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "ChatGPT-Account-Id": tokens.account_id,
          "user-agent": "local-codex-account-router/0.3",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    let response = await send();
    if (response.status === 401) {
      await response.body?.cancel();
      tokens = await this.account.token(true, tokens.access_token);
      response = await send();
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Reset service returned HTTP ${response.status}.`);
    }
    const data = await response.json();
    if (data.account_id && data.account_id !== tokens.account_id)
      throw new Error("Reset identity did not match.");
    return data;
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const data = normalize(await this.request());
        this.details = { ...data, updatedAt: Date.now(), error: null };
        return true;
      } catch {
        this.details.error =
          "Could not refresh saved reset details. Try again or check the account sign-in.";
        return false;
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  consume(creditId) {
    if (
      typeof creditId !== "string" ||
      !creditId.trim() ||
      creditId.length > 256
    )
      return Promise.reject(new Error("Choose a saved reset first."));
    if (this.consuming) {
      if (this.consuming.creditId !== creditId)
        return Promise.reject(
          new Error(
            "Another reset is already being processed for this account.",
          ),
        );
      return this.consuming.promise;
    }
    const promise = this.redeem(creditId).finally(() => {
      this.consuming = null;
    });
    this.consuming = { creditId, promise };
    return promise;
  }
  async redeem(creditId) {
    await this.ready;
    if (this.loadError) throw new Error(this.loadError);
    await this.account.load();
    const identity = this.account.accountIdentity;
    if (this.journal.attempts.some((a) => a.identity !== identity))
      throw new Error("Reset history belongs to a different sign-in.");
    let attempt = this.journal.attempts.findLast(
      (a) => a.creditId === creditId,
    );
    if (attempt && success(attempt.outcome))
      return {
        outcome: attempt.outcome,
        usageRefreshed: await this.refreshAfterReset(),
      };
    if (
      this.journal.attempts.some((a) => !a.outcome && a.creditId !== creditId)
    )
      throw new Error("Retry the pending reset before choosing another.");
    if (!attempt || attempt.outcome) {
      if (!(await this.refresh())) throw new Error(this.details.error);
      const credit = this.details.credits.find((c) => c.id === creditId);
      if (!credit || !availableReset(credit))
        throw new Error(
          "This reset is expired, unavailable, or unsupported. Refresh the reset list.",
        );
      attempt = {
        creditId,
        key: randomUUID(),
        identity,
        outcome: null,
        startedAt: Date.now(),
      };
      this.journal.attempts.push(attempt);
    }
    return this.executeAttempt(attempt);
  }
  async executeAttempt(attempt) {
    // Persist before sending, including retries after a failed write. Unknown outcomes keep the same key across restarts.
    await this.writeJson(this.path, this.journal);
    let outcome;
    try {
      const data = await this.request({
        redeem_request_id: attempt.key,
        credit_id: attempt.creditId,
      });
      if (!outcomes.has(data.code)) throw new Error("Unknown reset outcome");
      outcome = data.code;
    } catch {
      throw new Error(
        "Reset outcome is unconfirmed. Retry this same reset to check it safely.",
      );
    }
    const completed = { ...attempt, outcome, completedAt: Date.now() };
    const journal = {
      attempts: this.journal.attempts.map((a) =>
        a === attempt ? completed : a,
      ),
    };
    await this.writeJson(this.path, journal);
    this.journal = journal;
    return { outcome, usageRefreshed: await this.refreshAfterReset() };
  }
  async refreshAfterReset() {
    // Discard a usage fetch started before redemption; fetch fresh windows rather than inventing them.
    this.account.usageRevision++;
    await this.account.usageRefreshing;
    const refreshed = await this.account.refreshUsage();
    await this.refreshing;
    await this.refresh();
    return refreshed;
  }
}
