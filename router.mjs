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
const identityHash = (id) => createHash("sha256").update(id).digest("hex");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const threshold = account.switchAtRemainingPercent ?? 1;
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
  let obj;
  try {
    obj = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return null;
  }
  const e = obj?.error || obj?.response?.error;
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
    this.reason = null;
    this.refreshing = null;
    this.usage = {};
    this.accountId = null;
    this.accountIdentity = spec.accountIdentity || null;
    this.label = spec.label || spec.name;
    this.switchAtRemainingPercent = spec.switchAtRemainingPercent ?? 1;
    if (
      spec.recurringUse !== undefined &&
      typeof spec.recurringUse !== "boolean"
    )
      throw new Error("Recurring use must be true or false.");
    this.recurringUse = spec.recurringUse === true;
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
    let data;
    try {
      data = JSON.parse(
        (await readFile(this.path, "utf8")).replace(/^\uFEFF/, ""),
      );
    } catch {
      throw new Error("Sign in to this router account first.");
    }
    const t = data.tokens;
    if (
      ![t?.access_token, t?.account_id, t?.refresh_token].every(
        (value) => typeof value === "string" && value.length > 0,
      )
    ) {
      throw new Error("A ChatGPT login with refresh credentials is required.");
    }
    const claimedId = claims(t.access_token)["https://api.openai.com/auth"]
      ?.chatgpt_account_id;
    if (claimedId && claimedId !== t.account_id)
      throw new Error("Token identity did not match this account.");
    const fingerprint = identityHash(t.account_id);
    if (this.accountIdentity && this.accountIdentity !== fingerprint) {
      this.reason = "identity-changed";
      throw new Error(
        "Account identity changed. Restore the original sign-in for this account slot.",
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
    this.refreshing = this.refresh(data).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  async refresh(data) {
    const r = await this.fetcher(TOKEN_ENDPOINT, {
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
    if (!r.ok) {
      await r.body?.cancel();
      throw new Error("Account sign-in needs renewal.");
    }
    const updated = await r.json();
    if (typeof updated.access_token !== "string" || !updated.access_token)
      throw new Error("Token refresh did not return an access token.");
    const authClaims = claims(updated.access_token)[
      "https://api.openai.com/auth"
    ];
    if (
      authClaims?.chatgpt_account_id &&
      authClaims.chatgpt_account_id !== data.tokens.account_id
    ) {
      throw new Error("Refreshed account identity did not match.");
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
          this.block(new Headers(), {
            resets_at: Math.max(
              0,
              ...Object.values(usage)
                .filter((w) => w.usedPercent >= 100)
                .map((w) => w.resetsAt || 0),
            ),
          });
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
      this.usageError = error.message.startsWith("Usage ")
        ? error.message
        : "Could not refresh usage. Check the account sign-in or connection.";
      return false;
    }
  }
  block(headers, quota) {
    this.blockedUntil = resetTime(headers, quota);
    this.reason = "allowance-exhausted";
    this.onUsageChange?.();
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
      selectionSource = ["manual", "recurring"].includes(saved.selectionSource)
        ? saved.selectionSource
        : "automatic";
      savedRecurring = saved.recurringUse || null;
      for (const a of accounts) {
        const old = saved.accounts?.find((x) => x.name === a.name);
        if (old) {
          a.accountIdentity = a.accountIdentity || old.accountIdentity || null;
          a.blockedUntil = old.blockedUntil || 0;
          a.reason = old.reason;
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
    } catch {
      account.signedIn = false;
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
      account.signedIn !== false &&
      account.blockedUntil <= Date.now() &&
      !["sign-in-required", "identity-changed"].includes(account.reason) &&
      !accountPolicy(account).atThreshold &&
      !needsResetReading(account)
    );
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
    account.onUsageChange = () => recurring.changedAccount(account);
    return account;
  }
  accounts.forEach(watchAccount);
  if (!accounts.some((a) => a.name === selectedAccount))
    selectedAccount = routingOrder().find(eligible)?.name || null;
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
    if (!persist || account.signedIn === false) return;
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
    if (
      choice.version !== selectionVersion ||
      choice.orderVersion !== orderVersion ||
      choice.routingVersion !== routingVersion ||
      !eligible(choice.account)
    )
      return false;
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
    const intent = ++selectionIntent;
    await account.load();
    account.signedIn = true;
    if (intent !== selectionIntent) return;
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
      freeSol: freeSol.view(),
      events: [...events],
      inFlight: accounts.reduce((sum, a) => sum + a.activeRequests, 0),
      accounts: accounts.map((a) => ({
        name: a.name,
        label: a.label,
        profile: a.profile,
        blockedUntil: a.blockedUntil,
        reason: a.reason,
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
    setRecurringUse,
    setFreeSolRouting,
    reconcileSelection,
    loginRunner,
    wireRunner,
    connectionRunner,
  });
  const server = http.createServer(async (req, res) => {
    const abort = new AbortController();
    let idleTimer;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
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
      serving = account;
      if (serving) {
        serving.activeRequests++;
        if (model) serving.activeModels.set(requestIdentity, model);
      }
    }
    res.on("close", () => {
      if (!res.writableEnded) abort.abort();
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
            } catch {
              a.signedIn = false;
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
      const triedIdentities = new Set();
      const excluded = new Set();
      let forceUsual = false;
      for (;;) {
        if (abort.signal.aborted) throw new Error("Request cancelled.");
        let choice;
        if (pinned && freeSol.matches(payload.model)) {
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
        } else
          choice = await findRequestSelection(
            payload,
            excluded,
            abort.signal,
            forceUsual,
          );
        const account = choice.account;
        if (!account) {
          for (const a of accounts) {
            const p = accountPolicy(a);
            if (a.blockedUntil > Date.now())
              earliest = Math.min(earliest, a.blockedUntil);
            if (p.atThreshold) earliest = Math.min(earliest, p.eligibleAfter);
            if (needsResetReading(a))
              earliest = Math.min(earliest, Date.now() + 60_000);
          }
          break;
        }
        if (abort.signal.aborted) throw new Error("Request cancelled.");
        let tokens;
        try {
          tokens = await account.token();
        } catch {
          if (account.reason !== "identity-changed")
            account.reason = "sign-in-required";
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
        // Never carry the desktop account's cookies, actor authorization, workspace routing,
        // or account identifiers into a different signed-in account.
        for (const name of [
          "openai-beta",
          "version",
          "session_id",
          "conversation_id",
        ]) {
          if (req.headers[name]) headers.set(name, req.headers[name]);
        }
        const target = upstream + url.pathname.slice(3) + url.search;
        const routedBody = modelRoute.fallback
          ? Buffer.from(
              JSON.stringify({ ...payload, model: modelRoute.effective }),
            )
          : body;
        const send = () =>
          fetcher(target, {
            method: req.method,
            headers,
            body: routedBody.length ? routedBody : undefined,
            redirect: "error",
            signal: abort.signal,
          });
        let response = await send();
        if (response.status === 401) {
          await response.body?.cancel();
          try {
            tokens = await account.token(true, tokens.access_token);
          } catch {
            account.reason = "sign-in-required";
            excluded.add(account);
            track(null);
            if (pinned) break;
            continue;
          }
          // A transport error on the renewed request must never replay it on another account.
          headers.set("authorization", `Bearer ${tokens.access_token}`);
          response = await send();
        }
        account.observe(response.headers);
        if (!response.ok) {
          // Only explicit quota rejection or a Free Sol model-access rejection
          // permits transparent fallback. Other failures pass through.
          let text = "",
            size = 0;
          const errorDecoder = new TextDecoder();
          if (response.body)
            for await (const chunk of response.body) {
              touch();
              size += chunk.byteLength;
              if (size > 1024 * 1024)
                throw new Error("Upstream error is too large.");
              text += errorDecoder.decode(chunk, { stream: true });
            }
          text += errorDecoder.decode();
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
            continue;
          }
          const quota = response.status === 429 ? classify(text) : null;
          if (quota) {
            account.block(response.headers, quota);
            for (const other of accounts) {
              if (other.accountId === account.accountId) {
                other.blockedUntil = account.blockedUntil;
                other.reason = account.reason;
              }
            }
            earliest = Math.min(earliest, account.blockedUntil);
            save();
            record(
              account,
              "Allowance exhausted; trying the next eligible account.",
            );
            if (!pinned) {
              excluded.add(account);
              track(null);
              continue;
            }
          }
          if (response.status === 401) account.reason = "sign-in-required";
          res.writeHead(response.status, {
            "content-type":
              response.headers.get("content-type") || "application/json",
            "cache-control": "no-store",
            ...(response.headers.has("retry-after")
              ? { "retry-after": response.headers.get("retry-after") }
              : {}),
          });
          return res.end(text);
        }
        if (
          choice.route !== "free-sol" &&
          choice.version === selectionVersion &&
          config.strategy === "round-robin" &&
          !["manual", "recurring"].includes(selectionSource)
        ) {
          active = accounts.indexOf(account);
          active = (active + 1) % accounts.length;
          setSelection(accounts[active], "automatic");
        }
        account.reason = null;
        if (selectedAccount === account.name && !eligible(account))
          reconcileSelection().catch(() => {});
        save();
        record(
          account,
          modelRoute.fallback
            ? `Serving ${modelRoute.effective}; desktop requested ${modelRoute.requested}.`
            : choice.route === "free-sol"
              ? "Serving Sol through Free-account priority."
              : "Serving a request on the selected account.",
        );
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
        // The app's own usage display belongs to its login; don't replace it with another account's usage.
        res.writeHead(response.status, replyHeaders);
        const isSse =
          replyHeaders["content-type"].includes("text/event-stream");
        let buffer = "",
          eventData = [],
          terminal = null;
        const decoder = new TextDecoder();
        function flushEvent() {
          if (!eventData.length) return;
          try {
            const event = JSON.parse(eventData.join("\n"));
            remember(event.response?.id, account);
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
            }
            const quota = classify(event);
            if (quota) {
              account.block(response.headers, quota);
              save();
            }
          } catch {
          } finally {
            eventData = [];
          }
        }
        function lineEvent(line) {
          line = line.replace(/\r$/, "");
          if (!line) flushEvent();
          else if (line.startsWith("data:"))
            eventData.push(line.slice(5).trimStart());
        }
        if (response.body)
          for await (const chunk of response.body) {
            touch();
            if (isSse) {
              buffer += decoder.decode(chunk, { stream: true });
              let newline;
              while ((newline = buffer.indexOf("\n")) >= 0) {
                lineEvent(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
              }
              if (
                buffer.length + eventData.reduce((n, s) => n + s.length, 0) >
                MAX_BODY
              )
                throw new Error("Upstream SSE event is too large.");
            }
            if (!res.write(chunk))
              await once(res, "drain", { signal: abort.signal });
          }
        if (isSse) {
          buffer += decoder.decode();
          if (buffer) lineEvent(buffer);
          flushEvent();
        }
        record(
          account,
          terminal === "response.failed"
            ? "Response failed; it was not replayed."
            : terminal === "response.incomplete"
              ? "Response ended incomplete."
              : isSse && !terminal
                ? "Stream ended without a completion event."
                : "Response stream finished.",
        );
        save();
        return res.end();
      }
      save();
      if (earliest !== Infinity) {
        res.setHeader(
          "retry-after",
          String(Math.max(1, Math.ceil((earliest - Date.now()) / 1000))),
        );
        return json(
          res,
          429,
          errorBody(
            "all_accounts_unavailable",
            "All eligible accounts are unavailable. The router will retry accounts after their reset time.",
          ),
        );
      }
      return json(
        res,
        503,
        errorBody(
          "accounts_need_login",
          signedIn
            ? "No account can serve this request."
            : "Sign in to the router accounts using Add-Account.ps1.",
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
  });
  // SSE is selected explicitly in the custom provider configuration.
  server.on("upgrade", (_req, socket) =>
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n"),
  );
  function drain() {
    if (drainPromise) return drainPromise;
    draining = true;
    const stopRecurring = recurring.stop();
    drainPromise = new Promise((resolveDrain) =>
      server.close(async () => {
        await stopRecurring;
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
  recurring.kick();
  return {
    server,
    accounts,
    snapshot,
    drain,
    recurring,
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
