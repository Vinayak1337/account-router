import { elem } from "./dom.js";
import { icon } from "./icons.js";

const shortDate = (seconds) =>
  new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(seconds * 1000));

export function accountDetails(
  a,
  data,
  { name, fullDate, ago, usableReset, openReset },
) {
  const details = elem("details", "account-details");
  details.dataset.key = "details";
  const summary = elem("summary", "", "Details");
  summary.append(icon("down"));
  details.append(summary);
  const content = elem("div", "detail-content");
  const facts = elem("dl", "detail-facts");
  const row = (key, label, value, title) => {
    const item = elem("div", "detail-row");
    item.dataset.key = key;
    const description = elem("dd", "", value);
    if (title) description.title = title;
    item.append(elem("dt", "", label), description);
    facts.append(item);
  };
  row("email", "Account", a.profile?.email || a.name);
  row(
    "cutoff",
    "Switch at",
    `${a.policy.switchAtRemainingPercent}% remaining`,
    a.drainEnabled
      ? "Drain uses this account down to 0%."
      : "New requests switch accounts at this allowance.",
  );
  const until =
    a.subscription?.plan === a.profile?.plan
      ? a.subscription.activeUntil
      : null;
  if (a.profile?.plan !== "free")
    row(
      "expiry",
      until && until * 1000 <= Date.now() ? "Reported plan end" : "Plan ends",
      until ? shortDate(until) : "Not reported",
      until
        ? `${fullDate(until)}. Renewal may extend this date.`
        : "OpenAI has not supplied a subscription end date.",
    );
  if (
    a.credits?.unlimited ||
    (a.credits?.balance !== null && a.credits?.balance !== undefined)
  )
    row(
      "credits",
      "Credits",
      a.credits.unlimited
        ? "Unlimited"
        : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
            a.credits.balance,
          ),
    );
  const models = [
    ...new Set(
      (a.activeModels || [])
        .filter((m) => m.requested)
        .map(
          (m) =>
            (m.fallback ? `${m.requested} → ${m.effective}` : m.effective) +
            (m.route === "free-sol" ? " · Free priority" : ""),
        ),
    ),
  ];
  if (models.length) row("model", "In use", models.join(" · "));
  else if (a.lastModelUse)
    row(
      "model",
      "Last model",
      `${a.lastModelUse.fallback ? a.lastModelUse.requested + " → " : ""}${a.lastModelUse.effective}`,
    );
  if (["free", "go"].includes(a.profile?.plan))
    row(
      "fallback",
      "Astra fallback",
      "6.1 Sol → 6 Sol",
      "GPT-6.1 Sol when listed, otherwise GPT-6 Sol. Availability depends on this account’s model access.",
    );
  content.append(facts);

  const resets = a.resets;
  const count = resets?.availableCount ?? a.resetsAvailable;
  const pending = resets?.pendingCreditId;
  const nearest = resets?.credits
    ?.filter(usableReset)
    .sort((x, y) => (x.expiresAt || Infinity) - (y.expiresAt || Infinity))[0];
  const panel = elem("div", "reset-panel");
  const summaryBlock = elem("div", "reset-summary");
  const heading = elem("div", "reset-heading");
  heading.append(
    icon("refresh"),
    elem(
      "strong",
      "",
      count === null || count === undefined
        ? "Saved resets"
        : `${count} saved reset${count === 1 ? "" : "s"}`,
    ),
  );
  const expiry = elem(
    "span",
    "reset-expiry",
    pending
      ? "Unconfirmed · retry safely"
      : nearest?.expiresAt
        ? `Next expires ${shortDate(nearest.expiresAt)}`
        : nearest
          ? "No expiry"
          : count === 0
            ? "None available"
            : "Refresh to check expiry",
  );
  expiry.title = nearest?.expiresAt
    ? fullDate(nearest.expiresAt)
    : "Only supported, unexpired resets can be used.";
  summaryBlock.append(heading, expiry);
  const button = elem(
    "button",
    "reset-button",
    pending ? "Retry reset" : "Use reset",
  );
  button.id = `reset-${a.name}`;
  button.type = "button";
  button.setAttribute(
    "aria-label",
    `${pending ? "Retry" : "Use"} saved reset for ${name(a)}`,
  );
  button.title = "Review the earliest-expiring reset before confirming.";
  button.disabled =
    !!data.draining ||
    !a.signedIn ||
    resets?.busy ||
    ["waiting", "checking", "resetting"].includes(a.drainStatus?.phase) ||
    (!pending && count === 0);
  button.addEventListener("click", () => openReset(a.name));
  panel.append(summaryBlock, button);
  content.append(panel);
  if (a.drainEnabled) {
    const note = elem(
      "p",
      "detail-note",
      a.drainStatus?.message || "Drain: switch away at 0%, reset, then return.",
    );
    note.dataset.key = "drain-note";
    note.prepend(icon("drain"));
    content.append(note);
  }
  for (const [key, message] of [
    ["reset-error", resets?.error],
    ["usage-error", a.usageError],
  ]) {
    if (!message) continue;
    const error = elem("p", "usage-error", message);
    error.dataset.key = key;
    content.append(error);
  }
  const updated = elem(
    "div",
    "detail-updated",
    a.usageUpdatedAt
      ? `Updated ${ago(a.usageUpdatedAt)}`
      : "Usage not checked yet",
  );
  updated.prepend(icon("clock"));
  updated.title = `${a.usageSource || "Awaiting a usage reading"}${a.usageUpdatedAt ? " · " + new Date(a.usageUpdatedAt).toLocaleString() : ""}`;
  content.append(updated);
  details.append(content);
  return details;
}
