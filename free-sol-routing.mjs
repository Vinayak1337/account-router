export const isSol6 = (model) =>
  typeof model === "string" &&
  /^gpt-6(?:\.\d+)?-sol(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
export const isFree = (a) =>
  String(a?.profile?.plan || "").toLowerCase() === "free";
const MODEL_DENIALS = new Set([
  "model_not_found",
  "model_not_available",
  "model_not_supported",
  "unsupported_model",
  "invalid_model",
  "model_access_denied",
]);
export function modelUnavailable(body, status) {
  let data;
  try {
    data = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return false;
  }
  if (
    ![400, 403, 404, 422].includes(status) &&
    !(status === 200 && ["error", "response.failed"].includes(data?.type))
  )
    return false;
  const error =
    data?.error ||
    data?.response?.error ||
    (data?.type === "error" ? data : null);
  if (!error || typeof error !== "object") return false;
  if (MODEL_DENIALS.has(error.code) || MODEL_DENIALS.has(error.type))
    return true;
  const message = String(error.message || "");
  return (
    /\bmodel\b.{0,120}\b(?:not supported|not available|does not exist|not accessible|unavailable for|not enabled)\b/i.test(
      message,
    ) ||
    /\b(?:do not|don't|does not) have access to (?:this |the |that )?model\b/i.test(
      message,
    )
  );
}

// Request-specific routing shares account credentials and never changes the
// general selected account. No second process owns the same refresh credentials.
export class FreeSolRouting {
  constructor({ accounts, config, eligible, policy, refresh }) {
    Object.assign(this, { accounts, config, eligible, policy, refresh });
    this.work = null;
    this.denials = new Map();
  }
  matches(model) {
    return this.config.freeSolRouting && isSol6(model);
  }
  ready(a) {
    const p = this.policy(a);
    return (
      isFree(a) &&
      this.eligible(a) &&
      !a.usageError &&
      Number.isFinite(p.remainingPercent) &&
      p.remainingPercent > p.switchAtRemainingPercent &&
      a.usageUpdatedAt &&
      Date.now() - a.usageUpdatedAt <= 60_000
    );
  }
  denied(a, model) {
    const denial = this.denials.get(`${a.name}:${model}`);
    return (
      isFree(a) &&
      denial &&
      denial.identity === a.accountIdentity &&
      denial.until > Date.now()
    );
  }
  unavailable(a, model) {
    this.denials.set(`${a.name}:${model}`, {
      account: a.name,
      model,
      identity: a.accountIdentity,
      until: Date.now() + 300_000,
    });
    if (this.denials.size > 200)
      this.denials.delete(this.denials.keys().next().value);
  }
  candidate(excluded = new Set(), model = "gpt-6-sol") {
    return (
      this.accounts.find(
        (a) => !excluded.has(a) && !this.denied(a, model) && this.ready(a),
      ) || null
    );
  }
  refreshDue() {
    if (this.work) return this.work;
    const pool = this.accounts.filter(
      (a) => a.enabled !== false && (isFree(a) || !a.profile?.plan),
    );
    this.work = Promise.all(pool.map(this.refresh)).finally(() => {
      this.work = null;
    });
    return this.work;
  }
  view() {
    const ready = this.accounts.filter((a) => this.ready(a));
    return {
      enabled: this.config.freeSolRouting,
      account: this.candidate()?.name || null,
      ready: ready.length,
      total: this.accounts.filter(isFree).length,
      fallback: "usual",
      routes: ["gpt-6-sol", "gpt-6.1-sol"].map((model) => ({
        model,
        account: this.candidate(new Set(), model)?.name || null,
      })),
      unavailable: [...this.denials.values()]
        .filter((d) => d.until > Date.now())
        .map(({ account, model, until }) => ({
          account,
          model,
          retryAt: until,
        })),
    };
  }
}
