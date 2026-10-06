import http from "node:http";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { once } from "node:events";
import { createDashboard } from "./dashboard-api.mjs";
import {
  AccountBenefits,
  subscriptionFromClaims,
} from "./account-benefits.mjs";
import { effectiveModel } from "./model-routing.mjs";
import { DrainUse } from "./drain-use.mjs";
import { RecurringUse } from "./recurring-use.mjs";
import { FreeSolRouting, modelUnavailable } from "./free-sol-routing.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UPSTREAM = "https://chatgpt.com/backend-api/codex";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const MAX_BODY = 32 * 1024 * 1024;
const QUOTA_CODES = new Set([
  "usage_limit_reached",
  "usage_not_included",
  "insufficient_quota",
]);
// Upstream failures Codex itself would retry. Nothing has reached Codex yet when
// these are handled, so the router retries them on the same account and then on
// the next eligible one.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RETRYABLE_STREAM_CODES = new Set([
  "server_error",
  "server_is_overloaded",
  "rate_limit_exceeded",
  "slow_down",
  "internal_error",
]);
const ATTEMPTS_PER_ACCOUNT = 3;
// A short, known pause (a transient sign-in failure, a throttle) is waited out
// inside the router instead of failing the request.
const SHORT_WAIT_MS = 20_000;
const TRANSIENT_PAUSE_MS = 15_000;
// Events that carry no model output. They are held back so that a failure right
// after them can still move the request to another account.
const PREAMBLE_EVENTS = new Set([
  "response.created",
  "response.in_progress",
  "response.queued",
]);
const PREAMBLE_HOLD_MS = 30_000;
// Request headers Codex uses for routing, features and telemetry. Identity and
// authorization headers are never forwarded.
const FORWARDED_REQUEST_HEADERS = new Set([
  "openai-beta",
  "version",
  "session_id",
  "conversation_id",
  "x-client-request-id",
]);
const BLOCKED_REQUEST_HEADERS = new Set([
  "x-openai-actor-authorization",
  "x-codex-turn-state",
]);
const FORWARDED_RESPONSE_HEADERS = [
  "x-codex-turn-state",
  "x-reasoning-included",
  "openai-model",
  "x-request-id",
  "x-oai-request-id",
  "x-models-etag",
  "x-codex-safety-buffering-enabled",
  "x-codex-safety-buffering-faster-model",
];
const CREDIT_POLICIES = new Set(["last-resort", "never"]);
const identityHash = (id) => createHash("sha256").update(id).digest("hex");
const pause = (ms, signal) =>
  new Promise((accept, reject) => {
    if (signal?.aborted) return reject(new Error("Request cancelled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      accept();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(new Error("Request cancelled."));
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
// `permanent` failures need a new sign-in; anything else is retried later.
export class AuthError extends Error {
  constructor(message, permanent) {
    super(message);
    this.permanent = permanent;
  }
}
const TRANSIENT_FILE_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "EMFILE"]);
async function readCredentials(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse((await readFile(path, "utf8")).replace(/^﻿/, ""));
    } catch (error) {
      // Windows can briefly lock a file that was just replaced or scanned.
      const transient =
        TRANSIENT_FILE_ERRORS.has(error.code) || error instanceof SyntaxError;
      if (transient && attempt < 4) {
        await pause(25 * 2 ** attempt);
        continue;
      }
      throw new AuthError(
        "Sign in to this router account first.",
        !TRANSIENT_FILE_ERRORS.has(error.code),
      );
    }
  }
}
function upstreamError(text) {
  try {
    const body = typeof text === "string" ? JSON.parse(text) : text;
    return body?.error || body?.response?.error || null;
  } catch {
    return null;
  }
}
export function encryptedContentRejected(status, text) {
  if (status !== 400) return false;
  const error = upstreamError(text);
  const detail = `${error?.code || ""} ${error?.param || ""} ${error?.message || ""}`;
  return /encrypted_content|encrypted content/i.test(detail);
}
// Drop reasoning carried over from another account. Reasoning is optional
// context; everything the user and tools said is kept.
export function withoutReasoning(payload) {
  if (!Array.isArray(payload.input)) return null;
  const input = payload.input.filter((item) => item?.type !== "reasoning");
  if (input.length === payload.input.length) return null;
  return { ...payload, input };
}
function retryDelay(failure, attempt, base = 250) {
  const after = failure?.headers?.get?.("retry-after");
  if (after && /^\d+(\.\d+)?$/.test(after))
    return Math.min(10_000, Number(after) * 1000);
  return base * 3 ** attempt;
}
function describeFailure(failure) {
  if (!failure || failure.transport) return "OpenAI could not be reached";
  if (failure.status === 200) return "The response failed before any output";
  if (failure.status === 429) return "OpenAI throttled the request";
  return `OpenAI returned HTTP ${failure.status}`;
}

export function accountPolicy(account, now = Date.now()) {
  const windows = Object.values(account.usage || {}).filter(
    (w) =>
      w &&
      Number.isFinite(w.usedPercent) &&
      w.usedPercent >= 0 &&
      (!w.resetsAt || w.resetsAt * 1000 > now),
  );
  const remaining = windows.length
    ? Math.max(0, Math.min(...windows.map((w) => 100 - w.usedPercent)))
    : null;
  const threshold = account.drainEnabled
    ? 0
    : (account.switchAtRemainingPercent ?? 1);
  const atThreshold = remaining !== null && remaining <= threshold;
  const resets = windows
    .filter((w) => 100 - w.usedPercent <= threshold)
    .map((w) => w.resetsAt * 1000)
    .filter((x) => x > now);
  return {
    remainingPercent: remaining,
    switchAtRemainingPercent: threshold,
    atThreshold,
    eligibleAfter: atThreshold
      ? resets.length
        ? Math.max(...resets)
        : now + 300_000
      : null,
  };
}
export function needsResetReading(account, now = Date.now()) {
  return Object.values(account.usage || {}).some(
    (w) =>
      w?.resetsAt &&
      w.resetsAt * 1000 <= now &&
      Number.isFinite(w.usedPercent) &&
      100 - w.usedPercent <= (account.switchAtRemainingPercent ?? 1),
  );
}

export async function atomicJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
      mode: 0o600,
    });
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, path);
        break;
      } catch (error) {
        if (attempt >= 3 || !["EPERM", "EACCES", "EBUSY"].includes(error.code))
          throw error;
        await pause(50 * (attempt + 1));
      }
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export function claims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
}
function errorBody(code, message) {
  return { error: { type: "router_error", code, message } };
}
function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function safeEqual(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return left.length === right.length && timingSafeEqual(left, right);
}
function classify(body) {
  const e = upstreamError(body);
  return e && QUOTA_CODES.has(e.code || e.type) ? e : null;
}
function resetTime(headers, quota) {
  const now = Date.now();
  const times = [];
  for (const side of ["primary", "secondary"]) {
    const used = Number(headers.get(`x-codex-${side}-used-percent`));
    const reset = Number(headers.get(`x-codex-${side}-reset-at`)) * 1000;
    if (used >= 100 && reset > now) times.push(reset);
  }
  const reset = Number(quota?.resets_at) * 1000;
  if (reset > now) times.push(reset);
  const seconds = Number(quota?.resets_in_seconds);
  if (seconds > 0) times.push(now + seconds * 1000);
  const retry = headers.get("retry-after");
  if (retry) {
    const until = /^\d+$/.test(retry)
      ? now + Number(retry) * 1000
      : Date.parse(retry);
    if (until > now) times.push(until);
  }
  return times.length ? Math.max(...times) : now + 5 * 60_000;
}

export class Account {
  constructor(spec, root, fetcher = fetch) {
    if (
      typeof spec.home !== "string" ||
      isAbsolute(spec.home) ||
      !relative(resolve(root), resolve(root, spec.home)) ||
      relative(resolve(root), resolve(root, spec.home)).startsWith("..")
    )
      throw new Error("Account home must stay inside the router folder.");
    if (
      spec.switchAtRemainingPercent !== undefined &&
      (!Number.isFinite(spec.switchAtRemainingPercent) ||
        spec.switchAtRemainingPercent < 0 ||
        spec.switchAtRemainingPercent > 100)
    )
      throw new Error("Account cutoff must be between 0 and 100.");
    this.name = spec.name;
    this.path = resolve(root, spec.home, "auth.json");
    this.fetcher = fetcher;
    this.blockedUntil = 0;
    // "usage" blocks come from a usage reading; credits may still serve them.
    // "response" blocks come from an actual upstream rejection.
    this.blockSource = null;
    this.transientUntil = 0;
    this.credits = null;
    this.reason = null;
    this.refreshing = null;
    this.credentialWrites = Promise.resolve();
    this.authRevision = 0;
    this.usage = {};
    this.accountId = null;
    this.accountIdentity = spec.accountIdentity || null;
    this.label = spec.label || spec.name;
    if (spec.enabled !== undefined && typeof spec.enabled !== "boolean")
      throw new Error("Account enabled must be true or false.");
    this.enabled = spec.enabled !== false;
    this.switchAtRemainingPercent = spec.switchAtRemainingPercent ?? 1;
    if (
      spec.recurringUse !== undefined &&
      typeof spec.recurringUse !== "boolean"
    )
      throw new Error("Recurring use must be true or false.");
    this.recurringUse = spec.recurringUse === true;
    if (
      spec.drainEnabled !== undefined &&
      typeof spec.drainEnabled !== "boolean"
    )
      throw new Error("Drain must be true or false.");
    this.drainEnabled = spec.drainEnabled === true;
    this.profile = {};
    this.usageUpdatedAt = null;
    this.usageSource = null;
    this.usageError = null;
    this.activeRequests = 0;
    this.activeModels = new Map();
    this.lastModelUse = null;
    this.lastUsedAt = null;
    this.usageRevision = 0;
    this.usageRefreshing = null;
    this.benefits = new AccountBenefits(this, root, atomicJson);
  }
  async load() {
    const data = await readCredentials(this.path);
    const t = data.tokens;
    if (
      ![t?.access_token, t?.account_id, t?.refresh_token].every(
        (value) => typeof value === "string" && value.length > 0,
      )
    ) {
      throw new AuthError(
        "A ChatGPT login with refresh credentials is required.",
        true,
      );
    }
    const claimedId = claims(t.access_token)["https://api.openai.com/auth"]
      ?.chatgpt_account_id;
    if (claimedId && claimedId !== t.account_id)
      throw new AuthError("Token identity did not match this account.", true);
    const fingerprint = identityHash(t.account_id);
    if (this.accountIdentity && this.accountIdentity !== fingerprint) {
      this.reason = "identity-changed";
      throw new AuthError(
        "Account identity changed. Restore the original sign-in for this account slot.",
        true,
      );
    }
    this.accountIdentity = fingerprint;
    this.accountId = t.account_id;
    const identity = claims(t.id_token || "");
    this.profile = {
      email: identity.email || null,
      name: identity.name || null,
      plan:
        this.profile.plan ||
        identity["https://api.openai.com/auth"]?.chatgpt_plan_type ||
        null,
    };
    this.subscription = subscriptionFromClaims(
      identity["https://api.openai.com/auth"],
    );
    return data;
  }
  async token(force = false, rejectedToken = null) {
    if (this.refreshing) return this.refreshing;
    const data = await this.load();
    if (this.refreshing) return this.refreshing;
    const expiry = Number(claims(data.tokens.access_token).exp) * 1000;
    if (rejectedToken && data.tokens.access_token !== rejectedToken)
      return data.tokens;
    if (!force && (!expiry || expiry > Date.now() + 60_000)) return data.tokens;
    this.refreshing = this.refresh(data)
      .catch((error) => {
        // A temporary refresh failure must not stop a token that still works.
        if (!force && !error.permanent && expiry && expiry > Date.now() + 5_000)
          return data.tokens;
        throw error;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }
  writeCredentials(work) {
    const pending = this.credentialWrites.then(work);
    this.credentialWrites = pending.catch(() => {});
    return pending;
  }
  replaceCredentials(data) {
    return this.writeCredentials(async () => {
      const t = data?.tokens;
      const claimedId = claims(t?.access_token || "")[
        "https://api.openai.com/auth"
      ]?.chatgpt_account_id;
      if (
        ![t?.access_token, t?.refresh_token, t?.account_id].every(
          (v) => typeof v === "string" && v.length > 0,
        ) ||
        (claimedId && claimedId !== t.account_id) ||
        !this.accountIdentity ||
        identityHash(t.account_id) !== this.accountIdentity
      )
        throw new Error(
          "Sign in with the same account to replace this session.",
        );
      await atomicJson(this.path, data);
      this.authRevision++;
      this.usageRevision++;
      this.profile = {};
      await this.load();
      this.signedIn = true;
      if (["sign-in-required", "identity-changed"].includes(this.reason))
        this.reason = null;
      this.usageError = null;
    });
  }
  refresh(data) {
    return this.writeCredentials(async () => {
      const current = await this.load();
      // A completed re-sign-in wins over an older token refresh.
      if (
        current.tokens.access_token !== data.tokens.access_token ||
        current.tokens.refresh_token !== data.tokens.refresh_token
      )
        return current.tokens;
      return this.refreshCredentials(data);
    });
  }
  async refreshCredentials(data) {
    let r;
    try {
      r = await this.fetcher(TOKEN_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: data.tokens.refresh_token,
        }),
      });
    } catch {
      throw new AuthError("Sign-in service could not be reached.", false);
    }
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      // Same rule as Codex: only an explicit rejection means signing in again.
      const error = upstreamError(text);
      const code = String(
        (typeof error === "string" ? error : error?.code) || "",
      ).toLowerCase();
      const permanent =
        r.status === 401 ||
        (r.status === 400 && code === "invalid_grant") ||
        [
          "refresh_token_expired",
          "refresh_token_reused",
          "refresh_token_invalidated",
        ].includes(code);
      throw new AuthError(
        permanent
          ? "Account sign-in needs renewal."
          : `Sign-in service returned HTTP ${r.status}.`,
        permanent,
      );
    }
    const updated = await r.json().catch(() => null);
    if (typeof updated?.access_token !== "string" || !updated.access_token)
      throw new AuthError(
        "Token refresh did not return an access token.",
        false,
      );
    const authClaims = claims(updated.access_token)[
      "https://api.openai.com/auth"
    ];
    if (
      authClaims?.chatgpt_account_id &&
      authClaims.chatgpt_account_id !== data.tokens.account_id
    ) {
      throw new AuthError("Refreshed account identity did not match.", true);
    }
    data.tokens.access_token = updated.access_token;
    if (updated.refresh_token)
      data.tokens.refresh_token = updated.refresh_token;
    if (updated.id_token) data.tokens.id_token = updated.id_token;
    data.last_refresh = new Date().toISOString();
    await atomicJson(this.path, data);
    await this.load();
    return data.tokens;
  }
  observe(headers) {
    let changed = false;
    const hasCredits = headers.get("x-codex-credits-has-credits");
    if (hasCredits !== null) {
      const balance = headers.get("x-codex-credits-balance");
      this.credits = {
        ...this.credits,
        hasCredits: /^true$/i.test(hasCredits),
        unlimited: /^true$/i.test(
          headers.get("x-codex-credits-unlimited") || "",
        ),
        balance: balance === null ? (this.credits?.balance ?? null) : balance,
      };
    }
    for (const side of ["primary", "secondary"]) {
      const value = headers.get(`x-codex-${side}-used-percent`);
      if (
        value !== null &&
        value.trim() !== "" &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0
      ) {
        const old = this.usage[side],
          rawWindow = headers.get(`x-codex-${side}-window-minutes`),
          rawReset = headers.get(`x-codex-${side}-reset-at`);
        const positive = (value) =>
          Number.isFinite(Number(value)) && Number(value) > 0
            ? Number(value)
            : null;
        const windowMinutes =
          rawWindow === null ? old?.windowMinutes || null : positive(rawWindow);
        const sameWindow =
          !old?.windowMinutes || windowMinutes === old.windowMinutes;
        const resetsAt =
          rawReset === null
            ? sameWindow && old?.resetsAt * 1000 > Date.now()
              ? old.resetsAt
              : null
            : positive(rawReset);
        // The backend can send an unused secondary slot as 0 with no duration/reset.
        // That is not evidence of an additional 100% allowance.
        if (Number(value) === 0 && !windowMinutes && !resetsAt)
          delete this.usage[side];
        else
          this.usage[side] = {
            usedPercent: Number(value),
            resetsAt,
            windowMinutes,
          };
        changed = true;
      }
    }
    if (changed) {
      this.usageRevision++;
      this.usageUpdatedAt = Date.now();
      this.usageSource = "Response headers";
      this.usageError = null;
      this.onUsageChange?.();
    }
  }
  refreshUsage() {
    if (this.usageRefreshing) return this.usageRefreshing;
    this.lastUsageAttempt = Date.now();
    this.usageRefreshing = this.fetchUsage().finally(() => {
      this.usageRefreshing = null;
      this.onUsageChange?.();
    });
    return this.usageRefreshing;
  }
  async fetchUsage() {
    const revision = this.usageRevision;
    const authRevision = this.authRevision;
    try {
      let tokens = await this.token();
      const send = () =>
        this.fetcher("https://chatgpt.com/backend-api/wham/usage", {
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            "ChatGPT-Account-Id": tokens.account_id,
            "user-agent": "local-codex-account-router/0.2",
          },
          redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
      let response = await send();
      if (response.status === 401) {
        await response.body?.cancel();
        tokens = await this.token(true, tokens.access_token);
        response = await send();
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Usage endpoint returned HTTP ${response.status}.`);
      }
      const data = await response.json();
      if (authRevision !== this.authRevision) return false;
      if (
        !data ||
        typeof data !== "object" ||
        !Object.hasOwn(data, "rate_limit")
      )
        throw new Error(
          "Usage response did not contain allowance information.",
        );
      if (data.account_id && data.account_id !== tokens.account_id)
        throw new Error("Usage identity did not match this account.");
      const usage = {};
      for (const side of ["primary", "secondary"]) {
        const w = data.rate_limit?.[`${side}_window`];
        if (
          w !== undefined &&
          w !== null &&
          (!Number.isFinite(w.used_percent) || w.used_percent < 0)
        )
          throw new Error("Usage window was invalid.");
        if (w && Number.isFinite(w.used_percent) && w.used_percent >= 0)
          usage[side] = {
            usedPercent: w.used_percent,
            resetsAt: typeof w.reset_at === "number" ? w.reset_at : null,
            windowMinutes:
              typeof w.limit_window_seconds === "number"
                ? w.limit_window_seconds / 60
                : null,
          };
      }
      this.profile.plan = data.plan_type || this.profile.plan;
      this.credits = data.credits
        ? {
            balance: data.credits.balance ?? null,
            unlimited: data.credits.unlimited === true,
            hasCredits: data.credits.has_credits === true,
            overageLimitReached: data.credits.overage_limit_reached === true,
            spendControlReached: data.spend_control?.reached === true,
          }
        : null;
      this.resetsAvailable =
        data.rate_limit_reset_credits?.available_count ?? null;
      if (revision === this.usageRevision) {
        this.usage = usage;
        this.usageRevision++;
        this.usageUpdatedAt = Date.now();
        this.usageSource = "Account usage";
        if (data.rate_limit?.limit_reached === true)
          this.block(
            new Headers(),
            {
              resets_at: Math.max(
                0,
                ...Object.values(usage)
                  .filter((w) => w.usedPercent >= 100)
                  .map((w) => w.resetsAt || 0),
              ),
            },
            this.blockSource === "response" && this.blockedUntil > Date.now()
              ? "response"
              : "usage",
          );
        else if (
          data.rate_limit?.allowed === true &&
          !accountPolicy(this).atThreshold &&
          this.reason === "allowance-exhausted"
        ) {
          this.blockedUntil = 0;
          this.reason = null;
        }
      }
      if (["sign-in-required", "identity-changed"].includes(this.reason))
        this.reason = null;
      this.usageError = null;
      this.onUsageChange?.();
      return true;
    } catch (error) {
      if (authRevision !== this.authRevision) return false;
      this.usageError = error.message.startsWith("Usage ")
        ? error.message
        : "Could not refresh usage. Check the account sign-in or connection.";
      return false;
    }
  }
  block(headers, quota, source = "response") {
    this.blockedUntil = resetTime(headers, quota);
    this.blockSource = source;
    this.reason = "allowance-exhausted";
    this.onUsageChange?.();
  }
  // A temporary failure (network, sign-in service, locked file) pauses the
  // account briefly instead of asking for a new sign-in.
  pauseTransient(ms = TRANSIENT_PAUSE_MS) {
    this.transientUntil = Date.now() + ms;
    this.onUsageChange?.();
  }
  // Credits keep serving an account after its plan allowance is used, until
  // OpenAI rejects a request or reports the overage limit.
  creditsUsable(now = Date.now()) {
    const c = this.credits;
    return (
      !!c &&
      (c.unlimited || c.hasCredits) &&
      !c.overageLimitReached &&
      !c.spendControlReached &&
      (this.blockedUntil <= now || this.blockSource === "usage")
    );
  }
}

export async function createRouter(
  config,
  {
    root = ROOT,
    fetcher = fetch,
    upstream = UPSTREAM,
    key,
    persist = true,
    loginRunner,
    wireRunner,
    connectionRunner,
    idleTimeoutMs = 300_000,
    recurringPollMs,
    retryBaseMs = 250,
    preambleHoldMs = PREAMBLE_HOLD_MS,
    transientPauseMs = TRANSIENT_PAUSE_MS,
  } = {},
) {
  if (!key || key.length < 24)
    throw new Error("A local router key is required.");
  if (!["exhaust-first", "round-robin"].includes(config.strategy))
    throw new Error("Unknown routing strategy.");
  if (
    config.freeSolRouting !== undefined &&
    typeof config.freeSolRouting !== "boolean"
  )
    throw new Error("Free Sol routing must be true or false.");
  config.freeSolRouting ??= true;
  if (
    config.creditFallback !== undefined &&
    !CREDIT_POLICIES.has(config.creditFallback)
  )
    throw new Error('Credit fallback must be "last-resort" or "never".');
  // Matches Codex without a router: credits serve once plan allowance is used.
  config.creditFallback ??= "last-resort";
  if (!Array.isArray(config.accounts) || config.accounts.length > 20)
    throw new Error("Configure up to 20 accounts.");
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) ||
      config.port < 1024 ||
      config.port > 65535)
  )
    throw new Error("Use a port between 1024 and 65535.");
  const names = new Set();
  const homes = new Set();
  const accounts = config.accounts.map((spec) => {
    if (
      !spec ||
      typeof spec.name !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(spec.name) ||
      names.has(spec.name.toLowerCase())
    )
      throw new Error("Account labels must be unique.");
    const account = new Account(spec, root, fetcher);
    const home = account.path.toLowerCase();
    if (homes.has(home))
      throw new Error("Each account needs a separate credential folder.");
    homes.add(home);
    names.add(spec.name.toLowerCase());
    return account;
  });
  const statePath = resolve(root, ".runtime/state.json");
  let active = 0;
  let orderVersion = 0;
  let routingVersion = 0;
  let selectedAccount = null,
    selectionSource = "automatic",
    selectionVersion = 0,
    selectionIntent = 0,
    selectionChecks = 0;
  const selectionWork = new Set();
  let configWrites = Promise.resolve();
  let lastAccount = null;
  const events = [];
  const startedAt = Date.now();
  let snapshotVersion = 0;
  function record(account, message) {
    events.unshift({
      time: Date.now(),
      account: account?.name || null,
      message,
    });
    events.length = Math.min(events.length, 40);
  }
  const refs = new Map();
  let saveChain = Promise.resolve();
  let stateSaveError = null,
    draining = false,
    drainPromise = null;
  let drainUse = null;
  let recurring = null,
    savedRecurring = null;
  if (persist) {
    try {
      const saved = JSON.parse(
        (await readFile(statePath, "utf8")).replace(/^\uFEFF/, ""),
      );
      if (
        !saved ||
        !Array.isArray(saved.accounts) ||
        (saved.responseOrigins !== undefined &&
          !Array.isArray(saved.responseOrigins))
      )
        throw new Error("Invalid saved state.");
      active = Math.max(
        0,
        accounts.findIndex((a) => a.name === saved.active),
      );
      selectedAccount =
        saved.selectedAccount ?? saved.nextAccount ?? saved.active ?? null;
      selectionSource = ["manual", "recurring", "drain"].includes(
        saved.selectionSource,
      )
        ? saved.selectionSource
        : "automatic";
      savedRecurring = saved.recurringUse || null;
      for (const a of accounts) {
        const old = saved.accounts?.find((x) => x.name === a.name);
        if (old) {
          a.accountIdentity = a.accountIdentity || old.accountIdentity || null;
          a.blockedUntil = old.blockedUntil || 0;
          a.blockSource = old.blockSource || "response";
          // Sign-in state is re-verified on first use; a temporary failure
          // before a restart must not keep an account out of routing.
          a.reason = old.reason === "sign-in-required" ? null : old.reason;
          a.usage = old.usage || {};
          a.usageUpdatedAt = old.usageUpdatedAt || null;
          a.usage = Object.fromEntries(
            Object.entries(a.usage).filter(
              ([, w]) =>
                w && (w.usedPercent !== 0 || w.resetsAt || w.windowMinutes),
            ),
          );
          if (typeof old.profile?.plan === "string")
            a.profile.plan = old.profile.plan;
          a.usageSource = old.usageSource || "Saved reading";
          a.lastUsedAt = old.lastUsedAt || null;
          a.credits = old.credits || null;
          a.transientUntil = 0;
          a.resetsAvailable = old.resetsAvailable ?? null;
          if (Array.isArray(old.resets?.credits))
            a.benefits.details = {
              availableCount: old.resets.availableCount,
              credits: old.resets.credits,
              updatedAt: old.resets.updatedAt,
              error: null,
            };
        }
      }
      lastAccount = saved.lastAccount || null;
      for (const ref of saved.responseOrigins || []) {
        const account = accounts.find(
          (a) =>
            a.name === ref.account &&
            a.accountIdentity &&
            a.accountIdentity === ref.identity,
        );
        if (account && typeof ref.id === "string") refs.set(ref.id, account);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw Object.assign(
          new Error(
            "Saved router state could not be read. Restore .runtime/state.json from a backup; the original was preserved.",
          ),
          { code: "INVALID_SAVED_STATE" },
        );
    }
  }
  // Pin identities before the first request, including when a login file is replaced while idle.
  const connectedIds = new Set();
  for (const account of accounts) {
    await account.benefits.ready;
    try {
      await account.load();
      account.signedIn = true;
    } catch (error) {
      if (error.permanent !== false) account.signedIn = false;
      continue;
    }
    if (connectedIds.has(account.accountId))
      throw new Error("The same OpenAI account appears in more than one slot.");
    connectedIds.add(account.accountId);
  }
  function routingOrder() {
    return config.strategy === "round-robin"
      ? accounts.map((_, i) => accounts[(active + i) % accounts.length])
      : [...accounts];
  }
  function eligible(account) {
    return (
      account &&
      account.enabled &&
      !drainUse?.unavailable(account) &&
      account.signedIn !== false &&
      account.blockedUntil <= Date.now() &&
      account.transientUntil <= Date.now() &&
      !["sign-in-required", "identity-changed"].includes(account.reason) &&
      !accountPolicy(account).atThreshold &&
      !needsResetReading(account)
    );
  }
  // Last resort once no account has plan allowance left: an account whose
  // credits OpenAI still accepts, in priority order.
  function creditEligible(account) {
    return (
      config.creditFallback === "last-resort" &&
      account &&
      account.enabled &&
      !drainUse?.unavailable(account) &&
      account.signedIn !== false &&
      account.transientUntil <= Date.now() &&
      !["sign-in-required", "identity-changed"].includes(account.reason) &&
      account.creditsUsable()
    );
  }
  function creditCandidate(excluded) {
    const order = routingOrder().filter((a) => !excluded.has(a));
    if (order.some(eligible)) return null;
    return order.find(creditEligible) || null;
  }
  recurring = new RecurringUse({
    accounts,
    saved: savedRecurring,
    policy: accountPolicy,
    needsReading: needsResetReading,
    eligible,
    reconcile: () => reconcileSelection(),
    changed: () => save(),
    pollMs: recurringPollMs,
  });
  const freeSol = new FreeSolRouting({
    accounts,
    config,
    eligible,
    policy: accountPolicy,
    refresh: refreshForRouting,
  });
  function watchAccount(account) {
    account.onUsageChange = () => {
      recurring.changedAccount(account);
      drainUse?.inspect();
    };
    return account;
  }
  accounts.forEach(watchAccount);
  if (!accounts.some((a) => a.name === selectedAccount))
    selectedAccount = routingOrder().find(eligible)?.name || null;
  drainUse = new DrainUse({
    root,
    accounts,
    selected: () => selectedAccount,
    intent: () => selectionIntent,
    policy: accountPolicy,
    write: atomicJson,
    changed: () => save(),
    fallback: () => reconcileSelection(),
    restore: (account) => setSelection(account, "drain"),
    record,
  });
  await drainUse.ready;
  function setSelection(account, source) {
    const name = account?.name || null;
    if (selectedAccount === name && selectionSource === source) return;
    selectedAccount = name;
    selectionSource = source;
    selectionVersion++;
    record(
      account,
      name
        ? source === "manual"
          ? "Selected for new requests. Active requests keep their account."
          : source === "recurring"
            ? "Ready recurring account selected by priority for new requests."
            : "Automatically selected by fallback priority."
        : "No eligible account is currently available.",
    );
    save();
  }
  async function refreshForRouting(account) {
    if (!persist || !account.enabled || account.signedIn === false) return;
    const now = Date.now();
    const crossedReset = Object.values(account.usage || {}).some(
      (w) =>
        w?.resetsAt &&
        w.resetsAt * 1000 <= now &&
        w.resetsAt * 1000 > (account.lastUsageAttempt || 0),
    );
    const stale =
      !account.usageUpdatedAt ||
      now - account.usageUpdatedAt > 60_000 ||
      needsResetReading(account);
    if (
      (stale || crossedReset) &&
      (account.usageRefreshing ||
        crossedReset ||
        !account.lastUsageAttempt ||
        now - account.lastUsageAttempt > 60_000)
    ) {
      await account.refreshUsage();
      save();
    }
  }
  async function findSelection(excluded, signal) {
    for (;;) {
      if (signal?.aborted) throw new Error("Request cancelled.");
      const version = selectionVersion,
        priorityVersion = orderVersion;
      drainUse.inspect();
      const drainOwner = drainUse.owner();
      if (drainOwner && !excluded.has(drainOwner)) {
        await refreshForRouting(drainOwner);
        drainUse.inspect();
        if (version !== selectionVersion || priorityVersion !== orderVersion)
          continue;
        if (drainUse.owner() === drainOwner && eligible(drainOwner))
          return { account: drainOwner, version };
      }
      await recurring.refreshDue();
      if (version !== selectionVersion || priorityVersion !== orderVersion)
        continue;
      const recovered = recurring.take(excluded);
      if (recovered) {
        setSelection(recovered, "recurring");
        return { account: recovered, version: selectionVersion };
      }
      const current = accounts.find((a) => a.name === selectedAccount);
      if (current && !excluded.has(current)) {
        await refreshForRouting(current);
        if (version !== selectionVersion || priorityVersion !== orderVersion)
          continue;
        const recovered = recurring.take(excluded);
        if (recovered) {
          setSelection(recovered, "recurring");
          return { account: recovered, version: selectionVersion };
        }
        if (eligible(current)) return { account: current, version };
      }
      // A fallback always starts at the top of the complete priority list. Read stale
      // quotas even for blocked accounts, including a 5-hour reset inside a weekly window.
      const order = routingOrder().filter((a) => !excluded.has(a));
      await Promise.all(order.map(refreshForRouting));
      if (version !== selectionVersion || priorityVersion !== orderVersion)
        continue;
      const recoveredFallback = recurring.take(excluded);
      if (recoveredFallback) {
        setSelection(recoveredFallback, "recurring");
        return { account: recoveredFallback, version: selectionVersion };
      }
      const chosen = order.find(eligible) || null;
      setSelection(chosen, "automatic");
      return { account: chosen, version: selectionVersion };
    }
  }
  function reconcileSelection(excluded = new Set(), signal) {
    selectionChecks++;
    const work = findSelection(excluded, signal).finally(() => {
      selectionChecks--;
      selectionWork.delete(work);
    });
    selectionWork.add(work);
    return work;
  }
  async function findRequestSelection(
    payload,
    excluded,
    signal,
    forceUsual = false,
  ) {
    for (;;) {
      if (signal?.aborted) throw new Error("Request cancelled.");
      drainUse.inspect();
      const owner = drainUse.owner();
      if (owner && !excluded.has(owner)) {
        const selection = await reconcileSelection(excluded, signal);
        if (
          selection.account === drainUse.owner() &&
          eligible(selection.account)
        )
          return { ...selection, orderVersion, routingVersion, route: "drain" };
      }
      const routeVersion = routingVersion,
        priorityVersion = orderVersion,
        version = selectionVersion;
      excluded = new Set([
        ...excluded,
        ...accounts.filter((a) => freeSol.denied(a, payload.model)),
      ]);
      const preferFree = freeSol.matches(payload.model) && !forceUsual;
      if (preferFree) {
        await freeSol.refreshDue();
        if (
          routeVersion !== routingVersion ||
          priorityVersion !== orderVersion ||
          version !== selectionVersion
        )
          continue;
        const account = freeSol.candidate(excluded, payload.model);
        if (account)
          return {
            account,
            version,
            orderVersion: priorityVersion,
            routingVersion: routeVersion,
            route: "free-sol",
          };
      }
      const choice = await reconcileSelection(excluded, signal);
      if (routeVersion !== routingVersion || priorityVersion !== orderVersion)
        continue;
      if (preferFree && freeSol.candidate(excluded, payload.model)) continue;
      return {
        ...choice,
        orderVersion: priorityVersion,
        routingVersion: routeVersion,
        route: freeSol.matches(payload.model) ? "usual-fallback" : "usual",
      };
    }
  }
  function currentChoice(choice, payload, excluded, forceUsual) {
    if (choice.route === "retry")
      return (
        choice.orderVersion === orderVersion &&
        choice.routingVersion === routingVersion &&
        eligible(choice.account)
      );
    if (choice.route === "credits")
      return (
        choice.orderVersion === orderVersion &&
        choice.routingVersion === routingVersion &&
        creditCandidate(excluded) === choice.account
      );
    if (
      choice.version !== selectionVersion ||
      choice.orderVersion !== orderVersion ||
      choice.routingVersion !== routingVersion ||
      !eligible(choice.account)
    )
      return false;
    drainUse.inspect();
    const owner = drainUse.owner();
    if (owner && !excluded.has(owner))
      return owner === choice.account && eligible(owner);
    if (choice.route === "drain") return false;
    if (freeSol.denied(choice.account, payload.model)) return false;
    const preferredFree =
      freeSol.matches(payload.model) && !forceUsual
        ? freeSol.candidate(excluded, payload.model)
        : null;
    if (choice.route === "free-sol") return preferredFree === choice.account;
    if (preferredFree) return false;
    const preferredRecurring = recurring.take(
      new Set([
        ...excluded,
        ...accounts.filter((a) => freeSol.denied(a, payload.model)),
      ]),
    );
    return !preferredRecurring || preferredRecurring === choice.account;
  }
  async function selectAccount(name) {
    const account = accounts.find((a) => a.name === name);
    if (!account) throw new Error("Account not found. Refresh the dashboard.");
    if (!account.enabled)
      throw new Error("Turn this account on before selecting it.");
    const intent = ++selectionIntent;
    drainUse.manualSelection();
    await account.load();
    account.signedIn = true;
    if (intent !== selectionIntent) return;
    if (!account.enabled)
      throw new Error(
        "This account was turned off. Choose an enabled account.",
      );
    setSelection(account, "manual");
    await reconcileSelection();
    await saveChain;
  }
  // Serialize account addition and reordering so neither can overwrite the other's saved configuration.
  function commitAccounts(edit) {
    const write = configWrites.then(async () => {
      const change = edit();
      await atomicJson(resolve(root, "router.config.json"), {
        ...config,
        ...change.settings,
        accounts: change.specs,
      });
      if (change.settings) {
        Object.assign(config, change.settings);
        routingVersion++;
      }
      config.accounts = change.specs;
      accounts.splice(0, accounts.length, ...change.items);
      change.apply?.();
      if (change.restartOrder) {
        active = Math.max(
          0,
          accounts.findIndex((a) => a.name === selectedAccount),
        );
        orderVersion++;
      }
      save();
    });
    configWrites = write.catch(() => {});
    return write;
  }
  async function reorderAccounts(names) {
    await commitAccounts(() => {
      if (
        !Array.isArray(names) ||
        names.length !== accounts.length ||
        new Set(names).size !== accounts.length ||
        names.some((name) => !accounts.some((a) => a.name === name))
      ) {
        throw new Error(
          "Include every connected account exactly once. Refresh and try again.",
        );
      }
      return {
        specs: names.map((name) =>
          config.accounts.find((a) => a.name === name),
        ),
        items: names.map((name) => accounts.find((a) => a.name === name)),
        restartOrder: true,
      };
    });
    recurring.kick();
    record(
      null,
      "Account priority saved. Ready recurring accounts and Free Sol routing follow this order.",
    );
  }
  async function setRecurringUse(name, enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Recurring use must be true or false.");
    await commitAccounts(() => {
      const account = accounts.find((a) => a.name === name);
      if (!account)
        throw new Error("Account not found. Refresh the dashboard.");
      return {
        specs: config.accounts.map((a) =>
          a.name === name ? { ...a, recurringUse: enabled } : a,
        ),
        items: [...accounts],
        apply: () => {
          account.recurringUse = enabled;
          routingVersion++;
        },
      };
    });
    record(
      accounts.find((a) => a.name === name),
      enabled
        ? "Recurring use enabled. Ready accounts receive new requests by priority."
        : "Recurring use disabled.",
    );
    await reconcileSelection();
    recurring.kick();
    await save();
  }
  async function setAccountEnabled(name, enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Account enabled must be true or false.");
    await commitAccounts(() => {
      const account = accounts.find((a) => a.name === name);
      if (!account)
        throw new Error("Account not found. Refresh the dashboard.");
      return {
        specs: config.accounts.map((a) =>
          a.name === name ? { ...a, enabled } : a,
        ),
        items: [...accounts],
        apply: () => {
          account.enabled = enabled;
          routingVersion++;
          if (!enabled) drainUse.suspend(account);
        },
      };
    });
    record(
      accounts.find((a) => a.name === name),
      enabled
        ? "Account enabled for new requests. Saved priority and settings retained."
        : "Account turned off. Active requests finish; new requests use enabled accounts.",
    );
    await reconcileSelection();
    recurring.kick();
    await save();
  }
  async function setDrainUse(name, enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Drain must be true or false.");
    const account = accounts.find((a) => a.name === name);
    if (!account) throw new Error("Account not found. Refresh the dashboard.");
    if (enabled && drainUse.loadError) throw new Error(drainUse.loadError);
    await commitAccounts(() => ({
      specs: config.accounts.map((a) =>
        a.name === name ? { ...a, drainEnabled: enabled } : a,
      ),
      items: [...accounts],
      apply: () => {
        account.drainEnabled = enabled;
        routingVersion++;
      },
    }));
    await drainUse.configure(account, enabled);
    record(
      account,
      enabled
        ? "Drain armed. While selected, use to zero, reset and return."
        : "Drain disabled.",
    );
    drainUse.inspect();
    await save();
  }
  async function setFreeSolRouting(enabled) {
    if (typeof enabled !== "boolean")
      throw new Error("Free Sol routing must be true or false.");
    await commitAccounts(() => ({
      specs: [...config.accounts],
      items: [...accounts],
      settings: { freeSolRouting: enabled },
    }));
    record(
      null,
      enabled
        ? "Sol routing enabled: Free accounts by priority, then the selected account."
        : "Sol routing disabled: all models follow the selected account.",
    );
    await save();
  }
  async function setCreditFallback(policy) {
    if (!CREDIT_POLICIES.has(policy))
      throw new Error('Credit fallback must be "last-resort" or "never".');
    await commitAccounts(() => ({
      specs: [...config.accounts],
      items: [...accounts],
      settings: { creditFallback: policy },
    }));
    record(
      null,
      policy === "last-resort"
        ? "Credits enabled as a last resort after every account's plan allowance is used."
        : "Credits disabled: requests stop when every plan allowance is used.",
    );
    await save();
  }
  function snapshot() {
    const selected = accounts.find((a) => a.name === selectedAccount);
    return {
      active: selectedAccount,
      selectedAccount,
      selectionSource,
      selectionVersion,
      snapshotVersion: ++snapshotVersion,
      selectionChecking: selectionChecks > 0,
      selectionNeedsFallback: !eligible(selected),
      nextAccount: eligible(selected) ? selectedAccount : null,
      lastAccount,
      strategy: config.strategy,
      canReorder: !draining,
      canSelect: !draining,
      startedAt,
      serverTime: Date.now(),
      draining,
      stateSaveError,
      drainCycle:
        drainUse?.job && !drainUse.job.cancelled
          ? {
              account: drainUse.job.account.name,
              ...drainUse.view(drainUse.job.account),
            }
          : null,
      freeSol: freeSol.view(),
      creditFallback: config.creditFallback,
      events: [...events],
      inFlight: accounts.reduce((sum, a) => sum + a.activeRequests, 0),
      accounts: accounts.map((a) => ({
        name: a.name,
        enabled: a.enabled,
        label: a.label,
        profile: a.profile,
        blockedUntil: a.blockedUntil,
        blockSource: a.blockSource,
        transientUntil: a.transientUntil,
        creditsUsable: creditEligible(a),
        reason: a.reason,
        drainEnabled: a.drainEnabled,
        drainStatus: drainUse?.view(a) || { phase: "off" },
        recurringUse: a.recurringUse,
        recurringStatus: recurring?.view(a) || "off",
        usage: a.usage,
        usageUpdatedAt: a.usageUpdatedAt,
        usageSource: a.usageSource,
        usageError: a.usageError,
        activeRequests: a.activeRequests,
        lastUsedAt: a.lastUsedAt,
        credits: a.credits || null,
        resetsAvailable: a.resetsAvailable ?? null,
        subscription: a.subscription || null,
        resets: a.benefits.view(),
        needsResetReading: needsResetReading(a),
        policy: accountPolicy(a),
        activeModels: [...a.activeModels.values()],
        lastModelUse: a.lastModelUse,
      })),
    };
  }
  function save() {
    if (persist)
      saveChain = saveChain
        .then(async () => {
          const data = snapshot();
          data.accounts.forEach((a, i) => {
            a.accountIdentity = accounts[i].accountIdentity;
          });
          data.recurringUse = recurring?.snapshot() || {};
          data.responseOrigins = [...refs].map(([id, a]) => ({
            id,
            account: a.name,
            identity: a.accountIdentity,
          }));
          await atomicJson(statePath, data);
          stateSaveError = null;
        })
        .catch(() => {
          stateSaveError =
            "Could not save router state. Check available disk space and folder permissions.";
        });
    return saveChain;
  }
  function remember(id, account) {
    if (!id) return;
    refs.set(id, account);
    if (refs.size > 10_000) refs.delete(refs.keys().next().value);
  }
  const turnStates = new Map();
  function rememberTurnState(value, account) {
    turnStates.delete(value);
    turnStates.set(value, account);
    if (turnStates.size > 5_000)
      turnStates.delete(turnStates.keys().next().value);
  }
  function noteAuthFailure(account, error, authRevision) {
    if (
      authRevision !== account.authRevision ||
      account.reason === "identity-changed"
    )
      return;
    if (error?.permanent) {
      account.reason = "sign-in-required";
      record(account, "Sign-in expired or was revoked. Sign in again.");
    } else {
      account.pauseTransient(transientPauseMs);
      record(
        account,
        "Sign-in check failed temporarily; this account is retried shortly.",
      );
    }
    save();
  }
  function blockForQuota(account, headers, quota) {
    account.block(headers, quota);
    for (const other of accounts) {
      if (other.accountId === account.accountId) {
        other.blockedUntil = account.blockedUntil;
        other.blockSource = account.blockSource;
        other.reason = account.reason;
      }
    }
    save();
    record(account, "Allowance exhausted; trying the next eligible account.");
  }
  function served(account, choice, modelRoute) {
    if (
      !["free-sol", "drain", "credits"].includes(choice.route) &&
      choice.version === selectionVersion &&
      config.strategy === "round-robin" &&
      !["manual", "recurring"].includes(selectionSource)
    ) {
      active = accounts.indexOf(account);
      active = (active + 1) % accounts.length;
      setSelection(accounts[active], "automatic");
    }
    if (choice.route !== "credits") account.reason = null;
    account.transientUntil = 0;
    if (selectedAccount === account.name && !eligible(account))
      reconcileSelection().catch(() => {});
    save();
    record(
      account,
      modelRoute.fallback
        ? `Serving ${modelRoute.effective}; desktop requested ${modelRoute.requested}.`
        : choice.route === "free-sol"
          ? "Serving Sol through Free-account priority."
          : choice.route === "credits"
            ? "Serving on credits; every account's plan allowance is used."
            : "Serving a request on the selected account.",
    );
  }
  const dashboard = createDashboard({
    root,
    assetsRoot: resolve(ROOT, "dashboard"),
    config,
    accounts,
    snapshot,
    save,
    record,
    key,
    makeAccount: (spec) => watchAccount(new Account(spec, root, fetcher)),
    commitAccounts,
    reorderAccounts,
    selectAccount,
    setAccountEnabled,
    setRecurringUse,
    setDrainUse,
    resetBusy: (account) => drainUse.unavailable(account),
    setFreeSolRouting,
    setCreditFallback,
    reconcileSelection,
    loginRunner,
    wireRunner,
    connectionRunner,
  });
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    let idleTimer,
      idled = false,
      clientGone = false;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idled = true;
        abort.abort();
        if (!req.complete) req.destroy();
      }, idleTimeoutMs);
      idleTimer.unref();
    };
    let serving = null;
    const requestIdentity = Symbol();
    function track(account, model) {
      if (serving) {
        serving.activeRequests--;
        serving.activeModels.delete(requestIdentity);
      }
      drainUse.pulse();
      serving = account;
      if (serving) {
        serving.activeRequests++;
        if (model) serving.activeModels.set(requestIdentity, model);
      }
    }
    res.on("close", () => {
      if (!res.writableEnded) {
        clientGone = true;
        abort.abort();
      }
    });
    try {
      const port = server.address().port;
      if (req.headers.host !== `127.0.0.1:${port}`)
        return json(
          res,
          403,
          errorBody("local_access_denied", "Localhost access required."),
        );
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (await dashboard.handle(req, res, url)) return;
      if (
        req.headers.origin ||
        !safeEqual(req.headers["x-local-router-key"], key)
      ) {
        return json(
          res,
          403,
          errorBody(
            "local_access_denied",
            "Local router authentication required.",
          ),
        );
      }
      if (url.pathname === "/health" && req.method === "GET")
        return json(res, 200, { ok: true, pid: process.pid, root, draining });
      if (url.pathname === "/admin/shutdown" && req.method === "POST") {
        if (dashboard.loginPending())
          return json(
            res,
            409,
            errorBody(
              "login_in_progress",
              "Finish or cancel the open sign-in before stopping.",
            ),
          );
        draining = true;
        res.once("finish", () => drain());
        return json(res, 202, { draining: true });
      }
      if (url.pathname === "/status" && req.method === "GET") {
        await Promise.all(
          accounts.map(async (a) => {
            try {
              await a.load();
              a.signedIn = true;
            } catch (error) {
              // A briefly locked file is not a signed-out account.
              if (error.permanent !== false) a.signedIn = false;
            }
          }),
        );
        const status = snapshot();
        status.accounts.forEach((a, i) => {
          a.signedIn = accounts[i].signedIn;
        });
        return json(res, 200, status);
      }
      if (draining)
        return json(
          res,
          503,
          errorBody(
            "router_stopping",
            "The router is finishing active requests before stopping.",
          ),
        );
      const allowed =
        (req.method === "POST" &&
          ["/v1/responses", "/v1/responses/compact"].includes(url.pathname)) ||
        (req.method === "GET" && url.pathname === "/v1/models");
      if (!allowed)
        return json(
          res,
          404,
          errorBody(
            "unsupported_route",
            "This proxy supports Codex Responses, compaction and model listing.",
          ),
        );
      touch();
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        touch();
        bytes += chunk.length;
        if (bytes > MAX_BODY)
          return json(
            res,
            413,
            errorBody("request_too_large", "Request exceeds 32 MiB."),
          );
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      let payload = {};
      if (body.length) {
        try {
          payload = JSON.parse(body);
          if (!payload || typeof payload !== "object" || Array.isArray(payload))
            throw new Error();
        } catch {
          return json(
            res,
            400,
            errorBody("invalid_json", "Expected a JSON object."),
          );
        }
      }
      const pinned = payload.previous_response_id
        ? refs.get(payload.previous_response_id)
        : null;
      if (payload.previous_response_id && !pinned) {
        return json(
          res,
          409,
          errorBody(
            "context_requires_full_input",
            "The previous response belongs to an unknown session. Send full conversation input or start a new task.",
          ),
        );
      }
      let earliest = Infinity;
      let signedIn = 0;
      let waits = 0;
      let quotaOnly = true;
      // The most recent retryable upstream failure. If no account succeeds it is
      // returned as-is so Codex can apply its own retry policy.
      let lastFailure = null;
      let reasoningStripped = false;
      let triedIdentities = new Set();
      let excluded = new Set();
      // Accounts that failed temporarily for this request only. Unlike
      // `excluded`, they never change the selection other requests use.
      const skipped = new Set();
      let forceUsual = false;
      routing: for (;;) {
        if (abort.signal.aborted) throw new Error("Request cancelled.");
        if (pinned && !pinned.enabled)
          return json(
            res,
            409,
            errorBody(
              "context_requires_full_input",
              "The previous response belongs to an account that is turned off. Send full conversation input to use another account, or enable the original account.",
            ),
          );
        let choice;
        if (
          pinned &&
          (freeSol.matches(payload.model) || drainUse.owner() || drainUse.job)
        ) {
          choice = await findRequestSelection(
            payload,
            excluded,
            abort.signal,
            forceUsual,
          );
          if (choice.account !== pinned)
            return json(
              res,
              409,
              errorBody(
                "context_requires_full_input",
                "The model route now selects another account. Send full conversation input; previous responses remain tied to their original account.",
              ),
            );
        } else if (pinned) {
          if (freeSol.denied(pinned, payload.model))
            return json(
              res,
              409,
              errorBody(
                "context_requires_full_input",
                "This model is unavailable on the previous response account. Send full conversation input to use another account.",
              ),
            );
          await recurring.refreshDue();
          const preferred = recurring.take();
          if (preferred) setSelection(preferred, "recurring");
          const pinnedVersion = selectionVersion;
          const pinnedRouteVersion = routingVersion,
            pinnedOrderVersion = orderVersion;
          if (selectedAccount && pinned.name !== selectedAccount)
            return json(
              res,
              409,
              errorBody(
                "context_requires_full_input",
                "The selected account changed. Send full conversation input to use it; the previous response remains tied to its original account.",
              ),
            );
          await refreshForRouting(pinned);
          if (
            pinnedVersion !== selectionVersion ||
            pinnedRouteVersion !== routingVersion ||
            pinnedOrderVersion !== orderVersion
          )
            continue;
          if (!eligible(pinned))
            return json(
              res,
              429,
              errorBody(
                "pinned_account_at_threshold",
                "This response belongs to an unavailable account. Send full conversation input to use another account.",
              ),
            );
          choice = {
            account: pinned,
            version: selectionVersion,
            routingVersion,
            orderVersion,
            route: "usual",
          };
        } else {
          choice = await findRequestSelection(
            payload,
            excluded,
            abort.signal,
            forceUsual,
          );
          if (choice.account && skipped.has(choice.account))
            choice = {
              account:
                routingOrder().find(
                  (a) =>
                    !excluded.has(a) &&
                    !skipped.has(a) &&
                    eligible(a) &&
                    !freeSol.denied(a, payload.model),
                ) || null,
              version: selectionVersion,
              orderVersion,
              routingVersion,
              route: "retry",
            };
        }
        if (!choice.account && !pinned) {
          const credit = creditCandidate(new Set([...excluded, ...skipped]));
          if (credit)
            choice = {
              account: credit,
              version: selectionVersion,
              orderVersion,
              routingVersion,
              route: "credits",
            };
        }
        const account = choice.account;
        if (!account) {
          earliest = Infinity;
          quotaOnly = true;
          const now = Date.now();
          for (const a of accounts) {
            if (!a.enabled) continue;
            const p = accountPolicy(a);
            if (a.blockedUntil > now)
              earliest = Math.min(earliest, a.blockedUntil);
            if (p.atThreshold) earliest = Math.min(earliest, p.eligibleAfter);
            if (needsResetReading(a))
              earliest = Math.min(earliest, now + 60_000);
            if (a.transientUntil > now) {
              earliest = Math.min(earliest, a.transientUntil);
              quotaOnly = false;
            }
          }
          // A short pause (a temporary sign-in or network failure, a window
          // about to reset) is waited out instead of failing the request.
          const wait = earliest - now;
          if (
            !pinned &&
            !lastFailure &&
            waits < 2 &&
            wait > 0 &&
            wait <= SHORT_WAIT_MS
          ) {
            waits++;
            await pause(wait + 50, abort.signal);
            excluded = new Set();
            triedIdentities = new Set();
            continue;
          }
          break;
        }
        if (abort.signal.aborted) throw new Error("Request cancelled.");
        let tokens;
        let authRevision = account.authRevision;
        try {
          tokens = await account.token();
        } catch (error) {
          noteAuthFailure(account, error, authRevision);
          excluded.add(account);
          if (pinned) break;
          continue;
        }
        if (abort.signal.aborted) throw new Error("Request cancelled.");
        const modelRoute = {
          ...(await effectiveModel(account, payload, req.headers.version)),
          route: choice.route,
        };
        if (abort.signal.aborted) throw new Error("Request cancelled.");
        // Selection can change during a quota/token read. Nothing has been sent yet.
        if (!currentChoice(choice, payload, excluded, forceUsual)) continue;
        // Multiple labels signed in to the same underlying account do not create new quota.
        if (triedIdentities.has(tokens.account_id)) {
          excluded.add(account);
          if (pinned) break;
          continue;
        }
        triedIdentities.add(tokens.account_id);
        signedIn++;
        track(account, modelRoute);
        account.lastUsedAt = Date.now();
        lastAccount = account.name;
        save();
        if (modelRoute.requested)
          account.lastModelUse = { ...modelRoute, at: Date.now() };
        const headers = new Headers({
          "content-type": "application/json",
          accept: req.headers.accept || "text/event-stream",
          authorization: `Bearer ${tokens.access_token}`,
          "ChatGPT-Account-Id": tokens.account_id,
          originator: req.headers.originator || "codex_cli_rs",
          "user-agent":
            req.headers["user-agent"] || "local-codex-account-router/0.1",
        });
        // Forward Codex's routing, feature and telemetry headers. Never carry the
        // desktop account's cookies, actor authorization or account identifiers
        // into a different signed-in account.
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value !== "string" || BLOCKED_REQUEST_HEADERS.has(name))
            continue;
          if (
            FORWARDED_REQUEST_HEADERS.has(name) ||
            name.startsWith("x-codex-") ||
            name.startsWith("x-openai-")
          )
            headers.set(name, value);
        }
        // Sticky-routing state is only valid on the account that issued it.
        const turnState = req.headers["x-codex-turn-state"];
        if (
          typeof turnState === "string" &&
          turnStates.get(turnState) === account
        )
          headers.set("x-codex-turn-state", turnState);
        const target = upstream + url.pathname.slice(3) + url.search;
        const outgoing = () => {
          let next = modelRoute.fallback
            ? { ...payload, model: modelRoute.effective }
            : null;
          if (reasoningStripped)
            next = withoutReasoning(next || payload) || next;
          return next ? Buffer.from(JSON.stringify(next)) : body;
        };
        const send = () => {
          const data = outgoing();
          return fetcher(target, {
            method: req.method,
            headers,
            body: data.length ? data : undefined,
            redirect: "error",
            signal: abort.signal,
          });
        };
        let renewed = false;
        for (let attempt = 0; ;) {
          let response = null,
            failure = null;
          try {
            response = await send();
          } catch (error) {
            if (abort.signal.aborted) throw error;
            failure = { transport: true };
          }
          if (response?.status === 401 && !renewed) {
            renewed = true;
            await response.body?.cancel().catch(() => {});
            try {
              authRevision = account.authRevision;
              tokens = await account.token(true, tokens.access_token);
            } catch (error) {
              noteAuthFailure(account, error, authRevision);
              excluded.add(account);
              track(null);
              if (pinned) break routing;
              continue routing;
            }
            headers.set("authorization", `Bearer ${tokens.access_token}`);
            continue;
          }
          if (response?.ok) {
            account.observe(response.headers);
            const outcome = await deliver(
              response,
              account,
              choice,
              modelRoute,
              payload,
            );
            if (outcome.done) return;
            if (outcome.quota) {
              blockForQuota(account, response.headers, outcome.quota);
              track(null);
              if (pinned)
                return json(
                  res,
                  429,
                  errorBody(
                    "pinned_account_at_threshold",
                    "This response belongs to an unavailable account. Send full conversation input to use another account.",
                  ),
                );
              excluded.add(account);
              continue routing;
            }
            failure = outcome.failure;
          } else if (response) {
            account.observe(response.headers);
            let text;
            try {
              text = await errorText(response);
            } catch (error) {
              if (abort.signal.aborted) throw error;
              failure = { transport: true };
            }
            if (!failure) {
              if (
                choice.route === "free-sol" &&
                modelUnavailable(text, response.status)
              ) {
                freeSol.unavailable(account, payload.model);
                excluded.add(account);
                forceUsual = true;
                record(
                  account,
                  `${payload.model} unavailable on this Free account. Falling back to the selected account; this account/model is skipped for five minutes.`,
                );
                save();
                track(null);
                if (pinned)
                  return json(
                    res,
                    409,
                    errorBody(
                      "context_requires_full_input",
                      "This model is unavailable on the previous response account. Send full conversation input to use usual routing.",
                    ),
                  );
                continue routing;
              }
              const quota = response.status === 429 ? classify(text) : null;
              if (quota) {
                blockForQuota(account, response.headers, quota);
                if (!pinned) {
                  excluded.add(account);
                  track(null);
                  continue routing;
                }
              }
              if (
                !reasoningStripped &&
                encryptedContentRejected(response.status, text) &&
                withoutReasoning(payload)
              ) {
                reasoningStripped = true;
                record(
                  account,
                  "Earlier reasoning from another account was rejected; resending the conversation without it.",
                );
                continue;
              }
              if (
                response.status === 401 &&
                authRevision === account.authRevision
              )
                account.reason = "sign-in-required";
              failure = {
                status: response.status,
                headers: response.headers,
                text,
              };
              const retryable =
                !quota &&
                (RETRYABLE_STATUS.has(response.status) ||
                  response.status === 429);
              if (!retryable) return replyFailure(failure);
            }
          }
          // A retryable failure before anything reached Codex: retry this
          // account, then move to the next eligible one.
          lastFailure = failure;
          if (++attempt < ATTEMPTS_PER_ACCOUNT) {
            await pause(
              retryDelay(failure, attempt - 1, retryBaseMs),
              abort.signal,
            );
            continue;
          }
          record(
            account,
            `${describeFailure(failure)} after ${ATTEMPTS_PER_ACCOUNT} attempts; trying the next eligible account.`,
          );
          skipped.add(account);
          track(null);
          if (pinned) break routing;
          continue routing;
        }
      }
      save();
      if (lastFailure) return replyFailure(lastFailure);
      if (earliest !== Infinity) {
        res.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil((earliest - Date.now()) / 1000))),
        );
        if (quotaOnly)
          // Codex understands this shape and shows the reset time.
          return json(res, 429, {
            error: {
              type: "usage_limit_reached",
              code: "all_accounts_exhausted",
              message:
                config.creditFallback === "never"
                  ? "Every router account has reached its usage limit, and credits are turned off in Account Router."
                  : "Every router account has reached its usage limit.",
              resets_at: Math.ceil(earliest / 1000),
            },
          });
        return json(
          res,
          503,
          errorBody(
            "accounts_temporarily_unavailable",
            "Router accounts are temporarily unavailable. Retry shortly.",
          ),
        );
      }
      if (accounts.length && accounts.every((a) => !a.enabled))
        return json(
          res,
          503,
          errorBody(
            "accounts_disabled",
            "All accounts are turned off. Enable an account to resume requests.",
          ),
        );
      return json(
        res,
        503,
        errorBody(
          "accounts_need_login",
          signedIn
            ? "No account can serve this request."
            : "Sign in to a router account from the Account Router dashboard.",
        ),
      );
    } catch {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed)
        json(
          res,
          502,
          errorBody(
            "upstream_failed",
            "The upstream request failed. It was not replayed on another account.",
          ),
        );
    } finally {
      clearTimeout(idleTimer);
      track(null);
    }
    async function errorText(response) {
      let text = "",
        size = 0;
      const decoder = new TextDecoder();
      if (response.body)
        for await (const chunk of response.body) {
          touch();
          size += chunk.byteLength;
          if (size > 1024 * 1024)
            throw new Error("Upstream error is too large.");
          text += decoder.decode(chunk, { stream: true });
        }
      return text + decoder.decode();
    }
    function replyFailure(failure) {
      if (failure.transport)
        return json(
          res,
          502,
          errorBody(
            "upstream_unreachable",
            "OpenAI could not be reached from any eligible account. Codex will retry.",
          ),
        );
      res.writeHead(failure.status, {
        "content-type":
          failure.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
        ...(failure.headers.has("retry-after")
          ? { "retry-after": failure.headers.get("retry-after") }
          : {}),
      });
      return res.end(failure.text);
    }
    // Streams the upstream reply. Returns { done } once Codex has the reply, or
    // { failure | quota } when it failed before any model output was sent, so the
    // request can still be retried or moved to another account.
    async function deliver(response, account, choice, modelRoute, payload) {
      const replyHeaders = {
        "content-type":
          response.headers.get("content-type") || "application/json",
        "cache-control": "no-store",
        "x-local-router-account": account.name,
        "x-local-router-route": choice.route,
        ...(modelRoute.effective
          ? { "x-local-router-model": modelRoute.effective }
          : {}),
      };
      // Usage headers stay private: the app's own usage display belongs to its login.
      for (const name of FORWARDED_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) replyHeaders[name] = value;
      }
      const issuedTurnState = response.headers.get("x-codex-turn-state");
      if (issuedTurnState) rememberTurnState(issuedTurnState, account);
      let committed = false;
      const commit = () => {
        if (committed) return;
        committed = true;
        served(account, choice, modelRoute);
        res.writeHead(response.status, replyHeaders);
      };
      if (!replyHeaders["content-type"].includes("text/event-stream")) {
        // JSON replies are small; reading them fully keeps a dropped
        // connection retryable.
        const chunks = [];
        let size = 0;
        try {
          if (response.body)
            for await (const chunk of response.body) {
              touch();
              size += chunk.byteLength;
              if (size > MAX_BODY)
                throw new Error("Upstream reply is too large.");
              chunks.push(chunk);
            }
        } catch (error) {
          if (clientGone) throw error;
          return { failure: { transport: true } };
        }
        commit();
        res.end(Buffer.concat(chunks));
        record(account, "Response finished.");
        save();
        return { done: true };
      }
      const decoder = new TextDecoder();
      let pending = "",
        held = "",
        terminal = null,
        responseId = null,
        stop = null;
      const flush = () => {
        commit();
        if (held) res.write(held);
        held = "";
      };
      // Don't keep Codex waiting for headers if the model is slow to start.
      const holdTimer = setTimeout(() => {
        if (!res.destroyed) flush();
      }, preambleHoldMs);
      holdTimer.unref();
      const inspect = (block) => {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        let event;
        try {
          event = data.length ? JSON.parse(data.join("\n")) : null;
        } catch {
          event = null;
        }
        if (!event || typeof event !== "object") return "preamble";
        if (event.response?.id) {
          responseId = event.response.id;
          remember(responseId, account);
        }
        if (
          [
            "response.completed",
            "response.failed",
            "response.incomplete",
          ].includes(event.type)
        )
          terminal = event.type;
        // An already-started stream is never replayed. Remember explicit
        // access failures so the next full-input request can use usual routing.
        if (
          choice.route === "free-sol" &&
          modelUnavailable(event, response.status)
        ) {
          freeSol.unavailable(account, payload.model);
          record(
            account,
            `${payload.model} unavailable on this Free account. Future requests skip this account/model for five minutes; the current stream was not replayed.`,
          );
          save();
          return "output";
        }
        const quota = classify(event);
        if (event.type === "response.failed" && !committed) {
          const code = event.response?.error?.code;
          if (quota) return { quota };
          if (!code || RETRYABLE_STREAM_CODES.has(code))
            return { failure: block };
          return "output";
        }
        if (quota) {
          account.block(response.headers, quota);
          save();
        }
        return PREAMBLE_EVENTS.has(event.type) ? "preamble" : "output";
      };
      // Forward whole events only, so an interruption never leaves Codex with
      // half an event.
      const take = () => {
        let out = "";
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(pending);
          if (!boundary) return out;
          const block = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const verdict = inspect(block);
          if (typeof verdict === "object") {
            stop = verdict;
            return out;
          }
          out += block + "\n\n";
          if (verdict === "output" && !committed) {
            held += out;
            out = "";
            flush();
          }
        }
      };
      try {
        if (response.body)
          for await (const chunk of response.body) {
            touch();
            pending += decoder.decode(chunk, { stream: true });
            if (pending.length > MAX_BODY)
              throw new Error("Upstream SSE event is too large.");
            const out = take();
            if (committed) {
              if (out && !res.write(out))
                await once(res, "drain", { signal: abort.signal });
            } else held += out;
            if (stop) break;
          }
        if (!stop) {
          pending += decoder.decode();
          if (pending.trim()) {
            pending += "\n\n";
            const out = take();
            if (committed) res.write(out);
            else held += out;
          }
        }
      } catch (error) {
        clearTimeout(holdTimer);
        if (clientGone) throw error;
        if (!committed && !idled) return { failure: { transport: true } };
        // Already streaming: end with a retryable failure event instead of
        // cutting the connection, so Codex retries the turn cleanly.
        if (!committed) flush();
        endWithFailure(
          idled
            ? "The upstream stream stopped sending data. Codex will retry this turn."
            : "The upstream stream was interrupted. Codex will retry this turn.",
        );
        record(
          account,
          "Upstream stream was interrupted; ended it cleanly so Codex retries.",
        );
        save();
        return { done: true };
      }
      clearTimeout(holdTimer);
      if (stop?.quota) return { quota: stop.quota, failure: null };
      if (stop?.failure)
        return {
          failure: {
            status: response.status,
            headers: response.headers,
            text: held + stop.failure + "\n\n",
          },
        };
      // Nothing but the response preamble arrived before the stream ended.
      if (!committed) return { failure: { transport: true } };
      record(
        account,
        terminal === "response.failed"
          ? "Response failed; it was not replayed."
          : terminal === "response.incomplete"
            ? "Response ended incomplete."
            : !terminal
              ? "Stream ended without a completion event."
              : "Response stream finished.",
      );
      save();
      res.end();
      return { done: true };
      function endWithFailure(message) {
        if (res.destroyed || res.writableEnded) return;
        res.end(
          `event: response.failed\ndata: ${JSON.stringify({
            type: "response.failed",
            response: {
              id: responseId,
              status: "failed",
              error: { code: "router_upstream_interrupted", message },
            },
          })}\n\n`,
        );
      }
    }
  });
  // Codex keeps idle connections for about 90 seconds. Node's 5-second default
  // closes them first, so a reused connection fails before it reaches the router.
  server.keepAliveTimeout = 125_000;
  server.headersTimeout = 130_000;
  // SSE is selected explicitly in the custom provider configuration.
  server.on("upgrade", (_req, socket) =>
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"),
  );
  function drain() {
    if (drainPromise) return drainPromise;
    draining = true;
    const stopDrain = drainUse.stop();
    const stopRecurring = recurring.stop();
    // Long keep-alive connections must not hold shutdown open.
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    sweep.unref();
    server.closeIdleConnections();
    drainPromise = new Promise((resolveDrain) =>
      server.close(async () => {
        clearInterval(sweep);
        await stopRecurring;
        await stopDrain;
        await dashboard.settled();
        await Promise.allSettled([...selectionWork]);
        await configWrites;
        save();
        await saveChain;
        resolveDrain();
      }),
    );
    return drainPromise;
  }
  drainUse.inspect();
  recurring.kick();
  return {
    server,
    accounts,
    snapshot,
    drain,
    recurring,
    drainUse,
    flushed: async () => {
      await configWrites;
      await saveChain;
    },
  };
}

export async function localKey(root = ROOT) {
  const path = resolve(root, ".runtime/local-key");
  await mkdir(dirname(path), { recursive: true });
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const key = randomBytes(32).toString("hex");
    try {
      await writeFile(path, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch (e) {
      if (e.code === "EEXIST") return (await readFile(path, "utf8")).trim();
      throw e;
    }
  }
}
async function main() {
  const config = JSON.parse(
    (await readFile(resolve(ROOT, "router.config.json"), "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  const key = await localKey();
  // A process lock prevents two routers racing the same rotating refresh token.
  const lockPath = resolve(ROOT, ".runtime/router.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch {
    let old;
    try {
      old = Number(await readFile(lockPath, "utf8"));
    } catch {}
    let alive = false;
    if (old) {
      try {
        process.kill(old, 0);
        alive = true;
      } catch {}
    }
    if (alive) throw new Error("Another router is already running.");
    await unlink(lockPath).catch(() => {});
    lock = await open(lockPath, "wx");
  }
  await lock.writeFile(String(process.pid));
  await lock.close();
  const cleanup = async () => {
    try {
      if ((await readFile(lockPath, "utf8")).trim() === String(process.pid))
        await unlink(lockPath);
    } catch {}
  };
  const router = await createRouter(config, { key });
  router.server.once("close", async () => {
    await router.drain();
    await cleanup();
  });
  router.server.on("error", async () => {
    await cleanup();
    console.error("Router could not start; check its port and configuration.");
    process.exit(1);
  });
  router.server.listen(config.port, "127.0.0.1", () =>
    console.log(`Local Codex router listening on 127.0.0.1:${config.port}`),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await router.drain();
      await cleanup();
      process.exit(0);
    });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error.code === "INVALID_SAVED_STATE"
        ? error.message
        : "Router setup failed. Check configuration, login files, and Node version.",
    );
    process.exitCode = 1;
  });
}
