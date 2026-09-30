import { accountCards } from "./cards.js";
import { elem, reconcileChildren, keepViewport } from "./dom.js";
import { icon, iconLabel } from "./icons.js";
const $ = (id) => document.getElementById(id);
const themeKey = "account-router-theme";
function applyTheme(theme) {
  const dark = theme !== "light";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  iconLabel($("theme-toggle"), "theme");
  $("theme-toggle").setAttribute(
    "aria-label",
    `Switch to ${dark ? "light" : "dark"} mode`,
  );
}
let savedTheme = "dark";
try {
  savedTheme = localStorage.getItem(themeKey) || "dark";
} catch {}
applyTheme(savedTheme);
$("theme-toggle").addEventListener("click", () => {
  const theme =
    document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(theme);
  try {
    localStorage.setItem(themeKey, theme);
  } catch {}
});
window.addEventListener("storage", (event) => {
  if (event.key === themeKey) applyTheme(event.newValue || "dark");
});
$("local-address").textContent = location.host;
iconLabel($("refresh"), "refresh");
iconLabel($("add"), "plus", "Add account");
iconLabel($("close-dialog"), "close");
iconLabel($("close-reset"), "close");
let state = null,
  busy = false,
  lastSuccess = 0,
  addWasSubmitted = false;
let draggedName = null,
  ordering = false;
let sessionRenewal = null,
  connectionLost = false,
  statusRequest = null,
  cancelDrag = null;
let resetAccount = null,
  resetBusy = false,
  resetCredits = [],
  resetOpenVersion = 0;
let selectingName = null,
  selectionClick = 0;
let switchChoiceTouched = false;
const recurringSaving = new Set();
let freeSolSaving = false,
  wireBusy = false,
  wireDesired = null;
const date = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not reported";
const fullDate = (seconds) =>
  seconds
    ? new Date(seconds * 1000).toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "Not reported";
const usableReset = (c) =>
  c.status === "available" &&
  c.supported &&
  c.expiryKnown &&
  (!c.expiresAt || c.expiresAt * 1000 > Date.now());
const canChoose = (a) =>
  !!a?.signedIn &&
  Number.isFinite(a.policy?.remainingPercent) &&
  a.policy.remainingPercent > a.policy.switchAtRemainingPercent &&
  !a.needsResetReading &&
  a.blockedUntil <= Date.now() &&
  !["sign-in-required", "identity-changed"].includes(a.reason);
function ago(ms) {
  if (!ms) return "Not yet reported";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  return s < 10
    ? "Just now"
    : s < 60
      ? `${s}s ago`
      : s < 3600
        ? `${Math.floor(s / 60)}m ago`
        : `${Math.floor(s / 3600)}h ago`;
}
function name(account) {
  return (
    account?.profile?.name ||
    account?.profile?.email ||
    account?.label ||
    "No eligible account"
  );
}
function planBadge(account) {
  const plan = String(account?.profile?.plan || "").toLowerCase();
  const labels = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
    go: "Go",
  };
  const badge = elem(
    "span",
    "plan-badge" +
      (["free", "plus", "pro"].includes(plan) ? " plan-" + plan : ""),
    labels[plan] ||
      (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Plan unknown"),
  );
  badge.title = plan
    ? "Subscription reported for this signed-in account"
    : "Subscription has not been reported";
  return badge;
}
async function moveAccount(from, to, focusDirection) {
  if (ordering || !state?.canReorder || from === to) return;
  const names = state.accounts.map((a) => a.name);
  const source = names.indexOf(from),
    target = names.indexOf(to);
  if (source < 0 || target < 0) return;
  names.splice(source, 1);
  names.splice(target, 0, from);
  draggedName = null;
  ordering = true;
  notice("");
  $("order-message").textContent = "Saving account order…";
  try {
    const data = await api("accounts/order", { names });
    ordering = false;
    render(data);
    $("order-message").textContent =
      "Priority saved. Used by recurring accounts, model routing, and automatic fallback.";
    if (focusDirection) {
      const button = document.getElementById(`move-${focusDirection}-${from}`);
      (button?.disabled
        ? document.getElementById(
            `move-${focusDirection === "up" ? "down" : "up"}-${from}`,
          )
        : button
      )?.focus({ preventScroll: true });
    }
  } catch (error) {
    ordering = false;
    notice(error.message);
    $("order-message").textContent = "Order was not saved.";
    await update();
  }
}
async function api(path, body) {
  const options =
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dashboard-request": "1",
          },
          body: JSON.stringify(body),
        };
  const send = () =>
    fetch("/dashboard/api/" + path, {
      ...options,
      signal: AbortSignal.timeout(
        path.startsWith("accounts/") && path.includes("reset")
          ? 180000
          : path === "refresh" ||
              [
                "accounts/select",
                "accounts/recurring",
                "accounts/order",
              ].includes(path)
            ? 120000
            : path === "codex/wire"
              ? 45000
              : 12000,
      ),
    });
  let response = await send();
  // A proxy restart expires dashboard sessions. Renew locally before retrying the rejected action.
  if (response.status === 401) {
    if (!sessionRenewal)
      sessionRenewal = fetch("/dashboard", {
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      })
        .then((r) => {
          if (!r.ok) throw new Error("Could not reconnect to the dashboard.");
        })
        .finally(() => {
          sessionRenewal = null;
        });
    await sessionRenewal;
    response = await send();
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function notice(text) {
  $("notice").textContent = text;
  $("notice").hidden = !text;
}
async function selectForNewRequests(accountName) {
  if (
    !state?.canSelect ||
    !canChoose(state.accounts.find((a) => a.name === accountName))
  )
    return;
  const click = ++selectionClick;
  selectingName = accountName;
  switchChoiceTouched = false;
  notice("");
  if (state) render(state);
  try {
    const data = await api("accounts/select", { name: accountName });
    if (click !== selectionClick) return;
    selectingName = null;
    render(data);
    const selected = data.accounts.find((a) => a.name === data.selectedAccount);
    notice(
      data.selectedAccount === accountName
        ? `${name(selected)} selected.`
        : data.selectionSource === "recurring"
          ? `Recurring use keeps ${name(selected)} selected. Turn it off or change priority to choose another account.`
          : `That account is currently unavailable. ${selected ? "Selected " + name(selected) + " by fallback priority." : "Waiting for an eligible account."}`,
    );
  } catch (error) {
    if (click === selectionClick) {
      selectingName = null;
      notice(error.message);
      await update();
    }
  }
}
async function toggleRecurring(accountName) {
  const account = state?.accounts.find((a) => a.name === accountName);
  if (!account || !state.canSelect || recurringSaving.has(accountName)) return;
  const enabled = !account.recurringUse;
  recurringSaving.add(accountName);
  render(state);
  notice("");
  try {
    const data = await api("accounts/recurring", {
      name: accountName,
      enabled,
    });
    recurringSaving.delete(accountName);
    render(data);
    notice(
      enabled
        ? `Recurring use on for ${name(account)}.`
        : `Recurring use off for ${name(account)}.`,
    );
  } catch (error) {
    recurringSaving.delete(accountName);
    notice(error.message);
    await update();
  }
}
async function toggleFreeSol() {
  if (!state?.canSelect || freeSolSaving) return;
  const enabled = !state.freeSol?.enabled;
  freeSolSaving = true;
  render(state);
  notice("");
  try {
    const data = await api("settings/free-sol", { enabled });
    freeSolSaving = false;
    render(data);
    notice(
      enabled
        ? "Sol now tries ready Free accounts by priority, then falls back to the selected account."
        : "Sol now follows the selected account.",
    );
  } catch (error) {
    freeSolSaving = false;
    notice(error.message);
    await update();
  }
}
async function wireToCodex() {
  if (
    !state?.canSelect ||
    wireBusy ||
    typeof state.codexConnection?.wired !== "boolean"
  )
    return;
  const enabled = !state.codexConnection.wired;
  wireDesired = enabled;
  wireBusy = true;
  render(state);
  notice("");
  try {
    const data = await api("codex/wire", { enabled });
    wireBusy = false;
    wireDesired = null;
    render(data);
    notice(
      data.connectionChange?.message ||
        "Codex connection updated. Reopen Codex if needed and start a new chat.",
    );
  } catch (error) {
    wireBusy = false;
    wireDesired = null;
    notice(error.message);
    await update();
  }
}
function windowLabel(w, side) {
  const m = w?.windowMinutes;
  if (m === 10080) return "7 days";
  if (m === 300) return "5 hours";
  if (m && m % 1440 === 0) return `${m / 1440}-day limit`;
  if (m && m % 60 === 0) return `${m / 60}-hour limit`;
  if (m) return `${m}-minute limit`;
  return w ? "Usage · window not reported" : "Usage limits";
}
function usageWindow(side, w) {
  const row = elem("div", "usage-window");
  row.dataset.key = "usage-" + side;
  const top = elem("div", "window-top");
  top.append(elem("span", "", windowLabel(w, side)));
  const known = w && typeof w.usedPercent === "number";
  const remaining = known
    ? Math.max(0, Math.min(100, 100 - w.usedPercent))
    : null;
  const number = elem(
    "strong",
    "",
    known ? `${Number(remaining.toFixed(1))}%` : "—",
  );
  number.append(elem("small", "", known ? "left" : "unknown"));
  top.append(number);
  row.append(top);
  const bar = elem("div", known ? "bar" : "bar empty-bar");
  if (known) {
    const fill = elem("div", "bar-fill");
    fill.style.width = remaining + "%";
    bar.append(fill);
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(remaining));
    bar.setAttribute("aria-label", windowLabel(w, side) + " remaining");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    if (remaining <= 10) row.classList.add("low");
  }
  row.append(bar);
  const passed = w?.resetsAt && w.resetsAt * 1000 < Date.now();
  row.append(
    elem(
      "div",
      "window-reset" + (passed ? " stale" : ""),
      passed
        ? "Refresh needed"
        : w?.resetsAt
          ? `Resets ${date(w.resetsAt)}`
          : "Reset unknown",
    ),
  );
  return row;
}
function render(data) {
  keepViewport(() => renderState(data));
}
function renderState(data) {
  if (draggedName || ordering) return;
  if (state?.startedAt > data.startedAt) return;
  if (
    state?.startedAt === data.startedAt &&
    (state.snapshotVersion > data.snapshotVersion ||
      state.serverTime > data.serverTime)
  )
    return;
  const wasReady = state?.canReorder;
  state = data;
  lastSuccess = Date.now();
  $("connection").textContent = "Online";
  $("connection").className = "pill online";
  if (connectionLost) {
    notice("");
    connectionLost = false;
  }
  $("connection").textContent = data.draining ? "Finishing requests" : "Online";
  if (data.stateSaveError) notice(data.stateSaveError);
  $("add").disabled = !!data.draining;
  const wired = data.codexConnection?.wired,
    connectionKnown = typeof wired === "boolean";
  $("wire-codex").disabled =
    !!data.draining || wireBusy || data.wiring || !connectionKnown;
  $("wire-codex").textContent = wireBusy
    ? wireDesired
      ? "Connecting Codex…"
      : "Disconnecting Codex…"
    : data.wiring
      ? "Updating connection…"
      : !connectionKnown
        ? "Checking Codex…"
        : wired
          ? "Disconnect Codex"
          : "Connect to Codex";
  $("codex-connection").textContent = !connectionKnown
    ? data.codexConnection?.message || "Checking Codex’s default connection…"
    : wired
      ? "Codex default: Account Router. Disconnect restores the previous provider for new chats. Reopen Codex if needed; existing chats keep their saved provider."
      : "Codex default: " +
        (data.codexConnection.provider === "openai"
          ? "OpenAI (direct)"
          : data.codexConnection.provider || "previous provider") +
        ". Connect to use Account Router for new chats. Reopen Codex if needed; existing chats keep their saved provider.";
  $("wire-codex").setAttribute("aria-pressed", String(!!wired));
  $("wire-codex").title = $("codex-connection").textContent;
  $("codex-connection").hidden = connectionKnown;
  const sol = data.freeSol,
    solAccount = data.accounts.find((a) => a.name === sol?.account);
  const solRoutes = sol?.routes || [];
  const solSplit =
    solRoutes.length === 2 && solRoutes[0].account !== solRoutes[1].account;
  $("free-sol-routing").disabled = !!data.draining || freeSolSaving || !sol;
  $("free-sol-routing").setAttribute("aria-pressed", String(!!sol?.enabled));
  $("free-sol-detail").textContent = freeSolSaving
    ? "Saving…"
    : !sol?.enabled
      ? "Off · all models follow the selected account."
      : solAccount
        ? `On · tries ${name(solAccount)} first · ${sol.ready} Free account${sol.ready === 1 ? "" : "s"} ready. Fallback: selected account.`
        : `On · ${sol?.total || 0} Free accounts added. Checks limits before Sol requests; falls back to the selected account if none are ready.`;
  if (sol?.enabled && solSplit)
    $("free-sol-detail").textContent =
      "On · " +
      solRoutes
        .map(
          (r) =>
            `${r.model === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6.1 Sol"}: ${r.account ? name(data.accounts.find((a) => a.name === r.account)) : "selected account"}`,
        )
        .join(" · ");
  if (sol?.enabled && sol.unavailable?.length)
    $("free-sol-detail").textContent +=
      " Unsupported account/model pairs are skipped for 5 minutes.";
  if (!data.canReorder)
    $("order-message").textContent =
      "Waiting for the proxy update before enabling account order controls.";
  else if (!wasReady)
    $("order-message").textContent =
      "Drag the dotted handle or use the arrows to set priority. The highest-priority ready recurring account takes over new requests.";
  const active = data.accounts.filter((a) => a.activeRequests > 0);
  const next = data.accounts.find(
    (a) => a.name === (data.selectedAccount ?? data.nextAccount),
  );
  const last = data.accounts.find((a) => a.name === data.lastAccount);
  $("routing-label").textContent = "New requests";
  $("routing-name").textContent = name(next);
  $("routing-plan").replaceChildren(...(next ? [planBadge(next)] : []));
  $("routing-detail").textContent =
    next?.profile?.email || "Waiting for an eligible account.";
  const picker = $("switch-account-select");
  const choices = data.accounts.filter(canChoose);
  const optionsKey = JSON.stringify(
    choices.map((a) => [
      a.name,
      name(a),
      a.profile?.email,
      a.profile?.plan,
      data.accounts.indexOf(a),
    ]),
  );
  if (picker.dataset.optionsKey !== optionsKey) {
    const prior = picker.value;
    picker.replaceChildren();
    for (const a of choices) {
      const plan = a.profile?.plan;
      const planLabel = plan
        ? plan.charAt(0).toUpperCase() + plan.slice(1)
        : "Plan unknown";
      const option = elem("option", "", `${name(a)} · ${planLabel}`);
      option.value = a.name;
      picker.append(option);
    }
    if (!choices.length) {
      const option = elem("option", "", "No account with available limits");
      option.value = "";
      picker.append(option);
    }
    picker.dataset.optionsKey = optionsKey;
    if (choices.some((a) => a.name === prior)) picker.value = prior;
    else switchChoiceTouched = false;
  }
  if (!switchChoiceTouched)
    picker.value =
      choices.find(
        (a) =>
          a.name ===
          (selectingName || data.selectedAccount || data.nextAccount),
      )?.name ||
      choices[0]?.name ||
      "";
  picker.disabled = !data.canSelect || !choices.length;
  $("switch-account").disabled =
    !data.canSelect ||
    !picker.value ||
    picker.value === data.selectedAccount ||
    picker.value === selectingName;
  $("switch-account").textContent = selectingName
    ? "Switching…"
    : picker.value === data.selectedAccount
      ? "Selected"
      : "Use account";
  $("next-detail").textContent = data.selectionNeedsFallback
    ? "Checking availability. The next ready account is chosen from Priority 1."
    : next
      ? `${sol?.enabled ? "Sol first tries ready Free accounts; other models use this account." : "New requests use this account."}`
      : "No ready account — waiting for refreshed limits or another sign-in.";
  $("live-status").textContent = active.length
    ? active.map((a) => `${name(a)} · ${a.activeRequests} active`).join(" / ")
    : "Ready for new requests";
  $("last-used").textContent = last
    ? `Last used: ${name(last)} · ${last.profile?.email || last.name}`
    : "No account used in this proxy session yet.";
  $("mode").textContent =
    data.selectionSource === "manual"
      ? "Manual"
      : data.selectionSource === "recurring"
        ? next?.recurringUse
          ? "Recurring"
          : "Selected"
        : "Automatic";
  const ready = choices.length;
  $("ready").textContent = ready;
  $("account-count").textContent =
    `of ${data.accounts.length} added · usage confirmed`;
  $("inflight").textContent = data.inFlight;
  $("count").textContent = data.accounts.length;
  const grid = $("account-grid"),
    cards = [];
  cards.push(
    ...accountCards(data, {
      get state() {
        return state;
      },
      get ordering() {
        return ordering;
      },
      get draggedName() {
        return draggedName;
      },
      set draggedName(v) {
        draggedName = v;
      },
      get cancelDrag() {
        return cancelDrag;
      },
      set cancelDrag(v) {
        cancelDrag = v;
      },
      name,
      planBadge,
      fullDate,
      ago,
      usageWindow,
      canChoose,
      usableReset,
      moveAccount,
      selectForNewRequests,
      toggleRecurring,
      openReset,
      selectingName,
      recurringSaving,
      $,
    }),
  );
  if (!data.accounts.length)
    cards.push(elem("div", "empty", "Add your first account to begin."));
  reconcileChildren(grid, cards);
  const events = $("events"),
    rows = [];
  for (const item of data.events.slice(0, 8)) {
    const row = elem("div", "event");
    row.dataset.key = [item.time, item.account, item.message].join(":");
    const account = data.accounts.find((a) => a.name === item.account);
    const accountLabel = elem(
      "span",
      "event-account",
      account ? name(account) : item.account || "Router",
    );
    if (account) accountLabel.title = account.profile?.email || account.name;
    row.append(
      elem(
        "time",
        "",
        new Date(item.time).toLocaleTimeString(undefined, {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
      accountLabel,
      elem("span", "message", item.message),
    );
    rows.push(row);
  }
  if (!data.events.length)
    rows.push(elem("div", "empty", "No routing activity in this session yet."));
  reconcileChildren(events, rows);
  const wait = Math.max(
    0,
    Math.ceil((data.refreshAvailableAt - Date.now()) / 1000),
  );
  $("refresh").disabled = busy || data.refreshing || wait > 0;
  $("refresh").textContent =
    data.refreshing || busy
      ? "Refreshing…"
      : wait > 0
        ? `Refresh available in ${wait}s`
        : "Refresh limits";
  const refreshLabel = $("refresh").textContent;
  $("refresh").title = refreshLabel;
  iconLabel($("refresh"), "refresh");
  $("refresh").setAttribute("aria-label", refreshLabel);
  if (addWasSubmitted || data.login.state === "waiting")
    renderLogin(data.login);
}
$("switch-account-select").addEventListener("change", () => {
  switchChoiceTouched = true;
  $("switch-account").disabled =
    !state?.canSelect ||
    !canChoose(
      state.accounts.find((a) => a.name === $("switch-account-select").value),
    ) ||
    $("switch-account-select").value === state?.selectedAccount;
  $("switch-account").textContent =
    $("switch-account-select").value === state?.selectedAccount
      ? "Selected"
      : "Use account";
});
$("switch-account").addEventListener("click", () =>
  selectForNewRequests($("switch-account-select").value),
);
$("free-sol-routing").addEventListener("click", toggleFreeSol);
$("wire-codex").addEventListener("click", wireToCodex);
function describeReset() {
  const credit = resetCredits.find((c) => c.id === $("reset-credit").value);
  $("reset-description").textContent = credit
    ? `${credit.description || "Refreshes the eligible usage windows for this account."} ${credit.expiresAt ? "Use by " + fullDate(credit.expiresAt) + "." : "No reset expiry date reported."}`
    : "";
  $("confirm-reset").disabled = resetBusy || !credit;
}
async function openReset(accountName) {
  if (resetBusy) return;
  resetAccount = accountName;
  const version = ++resetOpenVersion;
  const account = state.accounts.find((a) => a.name === accountName);
  $("reset-account").textContent =
    `${name(account)} · ${account.profile?.email || account.name}`;
  $("reset-credit").replaceChildren();
  resetCredits = [];
  $("reset-description").textContent = "";
  $("reset-message").textContent = "Checking saved resets…";
  $("confirm-reset").disabled = true;
  $("confirm-reset").textContent = "Confirm · Use this reset";
  $("cancel-reset").textContent = "Cancel";
  $("reset-dialog").showModal();
  try {
    const data = await api("accounts/reset-details", { name: accountName });
    render(data);
    if (version !== resetOpenVersion || !$("reset-dialog").open) return;
    const fresh = data.accounts.find((a) => a.name === accountName),
      pending = fresh.resets?.pendingCreditId;
    resetCredits = (fresh.resets?.credits || [])
      .filter((c) => (pending ? c.id === pending : usableReset(c)))
      .sort((x, y) => (x.expiresAt || Infinity) - (y.expiresAt || Infinity));
    if (pending && !resetCredits.length)
      resetCredits = [
        {
          id: pending,
          title: "Previous reset attempt",
          description:
            "Retries the same saved attempt to check whether it completed.",
        },
      ];
    for (const credit of resetCredits) {
      const option = elem(
        "option",
        "",
        `${credit.title}${credit.expiresAt ? " · use by " + fullDate(credit.expiresAt) : ""}`,
      );
      option.value = credit.id;
      $("reset-credit").append(option);
    }
    $("reset-message").textContent = pending
      ? "The previous result is unconfirmed. Retry checks that same reset."
      : resetCredits.length
        ? "Confirm to use one reset on the account shown above."
        : "No supported, unexpired saved reset is available for this account.";
    $("confirm-reset").textContent = pending
      ? "Confirm · Retry same reset"
      : "Confirm · Use this reset";
    describeReset();
  } catch (error) {
    if (version === resetOpenVersion)
      $("reset-message").textContent = error.message;
  }
}
function closeReset() {
  if (!resetBusy) {
    resetOpenVersion++;
    keepViewport(() => $("reset-dialog").close());
    document
      .getElementById(`reset-${resetAccount}`)
      ?.focus({ preventScroll: true });
  }
}
$("close-reset").addEventListener("click", closeReset);
$("cancel-reset").addEventListener("click", closeReset);
$("reset-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  closeReset();
});
$("reset-credit").addEventListener("change", describeReset);
$("confirm-reset").addEventListener("click", async () => {
  if (resetBusy || !$("reset-credit").value) return;
  resetBusy = true;
  $("confirm-reset").disabled = true;
  $("close-reset").disabled = true;
  $("cancel-reset").disabled = true;
  $("reset-credit").disabled = true;
  $("reset-message").textContent =
    "Applying the saved reset and refreshing usage…";
  try {
    const data = await api("accounts/use-reset", {
      name: resetAccount,
      creditId: $("reset-credit").value,
      confirmed: true,
    });
    render(data);
    const result = data.resetResult;
    const messages = {
      reset: "Saved reset applied.",
      already_redeemed: "This reset was already applied.",
      nothing_to_reset:
        "No eligible window needed a reset. Your saved reset was not used.",
      no_credit: "No saved reset was available. Refresh the account details.",
    };
    $("reset-message").textContent =
      (messages[result.outcome] || "Reset result unavailable.") +
      (result.usageRefreshed
        ? " Usage limits refreshed."
        : " Usage could not be refreshed yet; use Refresh limits for an updated reading.");
    resetCredits = [];
    $("confirm-reset").textContent = "Finished";
    $("cancel-reset").textContent = "Done";
  } catch (error) {
    $("reset-message").textContent =
      error.message + " Close and reopen reset details to retry safely.";
  } finally {
    resetBusy = false;
    $("close-reset").disabled = false;
    $("cancel-reset").disabled = false;
    $("reset-credit").disabled = false;
    await update();
  }
});
function renderLogin(login) {
  if (login.state === "idle") return;
  $("add-form").hidden = true;
  $("login-progress").hidden = false;
  $("login-title").textContent =
    login.state === "waiting"
      ? "Finish signing in"
      : login.state === "success"
        ? "Account connected"
        : "Sign-in needs attention";
  $("login-message").textContent =
    login.message || "Opening the official sign-in page…";
  $("login-link").hidden = login.state !== "waiting" || !login.url;
  if (login.url) $("login-link").href = login.url;
  $("cancel-login").hidden = login.state !== "waiting";
  $("try-again").hidden = login.state === "waiting";
  $("try-again").textContent = login.state === "success" ? "Done" : "Try again";
}
async function update() {
  if (draggedName || ordering) return;
  if (statusRequest) return statusRequest;
  const started = Date.now();
  statusRequest = (async () => {
    try {
      render(await api("status"));
    } catch (error) {
      if (lastSuccess > started) return;
      connectionLost = true;
      document
        .querySelectorAll(
          "#switch-account-select,#switch-account,#wire-codex,#free-sol-routing,.select-account,.recurring-button,.move-button,.reset-button",
        )
        .forEach((button) => {
          button.disabled = true;
        });
      $("connection").textContent = "Offline";
      $("connection").className = "pill offline";
      $("routing-label").textContent = "LAST KNOWN SELECTION";
      $("live-status").textContent =
        "Active requests unknown — router unavailable.";
      $("inflight").textContent = "—";
      $("ready").textContent = "—";
      document
        .querySelectorAll(".account-badges")
        .forEach((el) =>
          el.replaceChildren(elem("span", "badge", "Status unavailable")),
        );
      notice(
        error.message +
          " Open Account Router from your desktop to start the service. Last update: " +
          ago(lastSuccess),
      );
    } finally {
      statusRequest = null;
    }
  })();
  return statusRequest;
}
$("refresh").addEventListener("click", async () => {
  busy = true;
  $("refresh").disabled = true;
  notice("");
  try {
    render(await api("refresh", {}));
  } catch (error) {
    notice(error.message);
  } finally {
    busy = false;
    await update();
  }
});
$("add").addEventListener("click", () => {
  addWasSubmitted = false;
  $("account-label").value = "";
  $("add-form").hidden = false;
  $("login-progress").hidden = true;
  if (state?.login.state === "waiting") renderLogin(state.login);
  $("add-dialog").showModal();
});
$("close-dialog").addEventListener("click", () => $("add-dialog").close());
$("add-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("start-login").disabled = true;
  try {
    const label = $("account-label").value.trim();
    const data = await api("accounts", label ? { label } : {});
    addWasSubmitted = true;
    render(data);
  } catch (error) {
    notice(error.message);
    $("add-dialog").close();
  } finally {
    $("start-login").disabled = false;
  }
});
$("cancel-login").addEventListener("click", async () => {
  try {
    render(await api("login/cancel", {}));
  } catch (error) {
    notice(error.message);
  }
});
$("try-again").addEventListener("click", () => {
  if (state?.login.state === "success") $("add-dialog").close();
  else {
    $("add-form").hidden = false;
    $("login-progress").hidden = true;
    addWasSubmitted = false;
  }
});
window.addEventListener("blur", () => cancelDrag?.());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") cancelDrag?.();
});
update();
setInterval(() => {
  if (!document.hidden) update();
}, 3000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) cancelDrag?.();
  else update();
});
