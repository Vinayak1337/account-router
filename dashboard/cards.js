import { elem } from "./dom.js";
import { icon } from "./icons.js";
export function accountCards(data, ctx) {
  const {
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
    toggleDrain,
    drainSaving,
    openReset,
    selectingName,
    recurringSaving,
    $,
  } = ctx;
  const sol = data.freeSol,
    solRoutes = data.accounts.some((a) => a.drainStatus?.phase === "active")
      ? []
      : sol?.routes || [],
    cards = [];
  for (const [index, a] of data.accounts.entries()) {
    const isNext = a.name === (data.selectedAccount ?? data.nextAccount);
    const card = elem("article", "account-card" + (isNext ? " next" : ""));
    const accountSolRoutes = sol?.enabled
        ? solRoutes.filter((r) => r.account === a.name)
        : [],
      hasSolRoute = accountSolRoutes.length > 0;
    card.draggable = false;
    if (data.canReorder) card.classList.add("can-drag");
    card.dataset.account = a.name;
    card.setAttribute("aria-label", `${index + 1}. ${name(a)}`);
    const controls = elem("div", "order-controls");
    const handle = elem("span", "drag-handle");
    handle.append(icon("grip"));
    handle.title = "Drag to change account order";
    handle.setAttribute("aria-hidden", "true");
    controls.append(handle, elem("span", "order-position", String(index + 1)));
    for (const [direction, offset, symbol] of [
      ["up", -1],
      ["down", 1],
    ]) {
      const button = elem("button", "move-button");
      button.append(icon(direction));
      button.type = "button";
      button.id = `move-${direction}-${a.name}`;
      button.setAttribute("aria-label", `Move ${name(a)} ${direction}`);
      button.title = `Move ${direction}`;
      button.disabled = !data.canReorder || !data.accounts[index + offset];
      button.addEventListener("click", () => {
        const position = ctx.state.accounts.findIndex(
          (item) => item.name === a.name,
        );
        moveAccount(
          a.name,
          ctx.state.accounts[position + offset]?.name,
          direction,
        );
      });
      controls.append(button);
    }
    card.append(controls);
    let pointer = null,
      moved = false,
      startX = 0,
      startY = 0,
      dragX = 0,
      dragY = 0,
      frame = 0;
    const clearDrag = () => {
      const oldPointer = pointer;
      pointer = null;
      ctx.draggedName = null;
      ctx.cancelDrag = null;
      cancelAnimationFrame(frame);
      if (oldPointer !== null && card.hasPointerCapture(oldPointer))
        card.releasePointerCapture(oldPointer);
      document
        .querySelectorAll(".dragging,.drop-target")
        .forEach((el) => el.classList.remove("dragging", "drop-target"));
    };
    const dragFrame = () => {
      if (pointer === null) return;
      if (moved) {
        if (dragY < 70) window.scrollBy(0, -12);
        else if (dragY > window.innerHeight - 70) window.scrollBy(0, 12);
        document
          .querySelectorAll(".drop-target")
          .forEach((el) => el.classList.remove("drop-target"));
        const target = document
          .elementFromPoint(dragX, dragY)
          ?.closest("[data-account]");
        if (target && target !== card) target.classList.add("drop-target");
      }
      frame = requestAnimationFrame(dragFrame);
    };
    card.addEventListener("pointerdown", (event) => {
      if (
        !ctx.state?.canReorder ||
        ctx.ordering ||
        event.button !== 0 ||
        !event.target.closest(".drag-handle")
      )
        return;
      ctx.cancelDrag?.();
      event.preventDefault();
      pointer = event.pointerId;
      dragX = startX = event.clientX;
      dragY = startY = event.clientY;
      moved = false;
      ctx.draggedName = a.name;
      ctx.cancelDrag = () => {
        clearDrag();
        $("order-message").textContent =
          "Move cancelled. Account order is unchanged.";
      };
      card.setPointerCapture(pointer);
      frame = requestAnimationFrame(dragFrame);
    });
    card.addEventListener("pointermove", (event) => {
      if (pointer !== event.pointerId) return;
      dragX = event.clientX;
      dragY = event.clientY;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > 5)
        moved = true;
      if (!moved) return;
      card.classList.add("dragging");
      document
        .querySelectorAll(".drop-target")
        .forEach((el) => el.classList.remove("drop-target"));
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-account]");
      if (target && target !== card) target.classList.add("drop-target");
      $("order-message").textContent =
        `Moving ${name(a)}. Release over another account to set its priority.`;
    });
    card.addEventListener("pointerup", (event) => {
      if (pointer !== event.pointerId) return;
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-account]")?.dataset.account;
      clearDrag();
      if (moved && target && target !== a.name) moveAccount(a.name, target);
      else
        $("order-message").textContent =
          "Drag the dotted handle or use the arrows to set account priority.";
    });
    card.addEventListener("pointercancel", () => {
      if (pointer !== null) ctx.cancelDrag?.();
    });
    card.addEventListener("lostpointercapture", () => {
      if (pointer !== null) ctx.cancelDrag?.();
    });
    const top = elem("div", "account-top");
    top.append(elem("div", "avatar", name(a).slice(0, 1).toUpperCase()));
    const identity = elem("div", "identity");
    identity.append(
      elem("h3", "", name(a)),
      elem("p", "", a.profile?.email || a.name),
    );
    top.append(identity);
    const badges = elem("div", "account-badges");
    if (a.activeRequests) {
      const servingCurrent =
        isNext ||
        hasSolRoute ||
        (sol?.enabled &&
          !sol.account &&
          a.activeModels?.some((m) => m.route === "free-sol"));
      const badge = elem(
        "span",
        "badge active",
        servingCurrent ? "Active" : "Finishing",
      );
      badge.title = `Serving ${a.activeRequests} request${a.activeRequests === 1 ? "" : "s"}`;
      badges.append(badge);
    }
    if (isNext) {
      const badge = elem("span", "badge selected-badge", "Selected");
      badge.title = "Selected for new requests, even when no request is active";
      badges.append(badge);
    }
    if (hasSolRoute)
      badges.append(
        elem(
          "span",
          "badge selected-badge",
          accountSolRoutes.length === 2
            ? "Sol route"
            : accountSolRoutes[0].model === "gpt-6-sol"
              ? "6 Sol route"
              : "6.1 Sol route",
        ),
      );
    if (!a.activeRequests && !isNext && !hasSolRoute)
      badges.append(
        elem(
          "span",
          "badge" + (a.policy.atThreshold ? " reserve" : ""),
          a.reason === "identity-changed"
            ? "Account changed"
            : !a.signedIn || a.reason === "sign-in-required"
              ? "Sign-in needed"
              : a.needsResetReading ||
                  !Number.isFinite(a.policy.remainingPercent)
                ? "Refresh limits"
                : a.policy.remainingPercent <= 0 || a.blockedUntil > Date.now()
                  ? "Exhausted"
                  : a.policy.atThreshold
                    ? "At switch limit"
                    : "Ready",
        ),
      );
    top.append(badges);
    card.append(top);
    const meta = elem("div", "account-meta");
    meta.append(
      planBadge(a),
      elem("span", "", `Switch at ${a.policy.switchAtRemainingPercent}%`),
    );
    identity.append(planBadge(a));
    identity.title = a.profile?.email || a.name;
    const subscription = a.subscription,
      until =
        subscription?.plan === a.profile?.plan
          ? subscription.activeUntil
          : null;
    const expiry = elem(
      "div",
      "plan-expiry",
      a.profile?.plan === "free"
        ? "Free plan"
        : until
          ? `${until * 1000 > Date.now() ? "Plan period ends" : "Reported plan end"} ${fullDate(until)}`
          : "Plan expiry not reported",
    );
    expiry.title = subscription?.checkedAt
      ? `OpenAI last checked this subscription ${fullDate(subscription.checkedAt)}. Renewal may extend the reported date.`
      : "OpenAI has not supplied a subscription end date.";
    const details = elem("details", "account-details");
    details.dataset.key = "details";
    details.append(elem("summary", "", "Details"));
    const detailContent = elem("div", "detail-content");
    details.append(detailContent);
    detailContent.append(
      elem("p", "account-email", a.profile?.email || a.name),
      meta,
      expiry,
    );
    const selectButton = elem(
      "button",
      isNext ? "select-account selected-account" : "select-account",
      selectingName === a.name
        ? "Switching…"
        : isNext
          ? "Selected"
          : "Use account",
    );
    selectButton.type = "button";
    selectButton.id = `select-${a.name}`;
    selectButton.setAttribute(
      "aria-label",
      `Use ${name(a)} (${a.profile?.email || a.name}) for new requests`,
    );
    selectButton.disabled =
      !data.canSelect || !canChoose(a) || isNext || selectingName === a.name;
    selectButton.addEventListener("click", () => selectForNewRequests(a.name)); // Actions are grouped below.
    selectButton.title = !a.signedIn
      ? "Renew this account sign-in first."
      : !canChoose(a)
        ? "Available usage has not been confirmed. Refresh limits after its reset."
        : isNext
          ? "Already selected for new requests."
          : "Select for new requests. Ready recurring accounts take precedence; Sol tries Free accounts first when enabled.";
    if (!canChoose(a) && !isNext && selectingName !== a.name)
      selectButton.textContent =
        a.reason === "identity-changed"
          ? "Account identity changed"
          : !a.signedIn || a.reason === "sign-in-required"
            ? "Sign-in needed"
            : a.needsResetReading || !Number.isFinite(a.policy.remainingPercent)
              ? "Refresh needed"
              : a.policy.remainingPercent <= 0 || a.blockedUntil > Date.now()
                ? "Exhausted"
                : a.policy.atThreshold
                  ? "At switch limit"
                  : "Refresh needed";
    selectButton.setAttribute(
      "aria-label",
      `${selectButton.textContent} · ${name(a)} (${a.profile?.email || a.name})`,
    );
    const recurringRow = elem("div", "recurring-row");
    recurringRow.dataset.key = "recurring";
    const recurringButton = elem(
      "button",
      "recurring-button",
      recurringSaving.has(a.name) ? "Saving…" : "Recurring",
    );
    recurringButton.type = "button";
    recurringButton.id = `recurring-${a.name}`;
    recurringButton.setAttribute("aria-pressed", String(!!a.recurringUse));
    recurringButton.setAttribute(
      "aria-label",
      `Recurring use for ${name(a)} (${a.profile?.email || a.name})`,
    );
    recurringButton.title =
      "Automatically receive new requests whenever ready. If several recurring accounts are ready, the highest priority wins. The Sol route takes priority when enabled.";
    recurringButton.disabled = !data.canSelect || recurringSaving.has(a.name);
    recurringButton.addEventListener("click", () => toggleRecurring(a.name));
    const recurringText = elem(
      "span",
      "recurring-status",
      !a.recurringUse
        ? "Off"
        : a.recurringStatus === "waiting"
          ? "On · waiting for usage to reset"
          : a.recurringStatus === "ready"
            ? "On · ready, uses account priority"
            : "On · refresh limits to confirm availability",
    );
    recurringText.id = `recurring-status-${a.name}`;
    recurringButton.setAttribute("aria-describedby", recurringText.id);
    recurringButton.prepend(icon("repeat"));
    recurringText.classList.add("sr-only");
    recurringRow.append(recurringButton, recurringText);
    const cardActions = elem("div", "card-actions");
    const drainButton = elem(
      "button",
      "drain-button",
      drainSaving.has(a.name) ? "Saving…" : "Drain",
    );
    drainButton.type = "button";
    drainButton.id = `drain-${a.name}`;
    drainButton.prepend(icon("drain"));
    drainButton.setAttribute("aria-pressed", String(!!a.drainEnabled));
    drainButton.setAttribute(
      "aria-label",
      `Drain for ${name(a)} (${a.profile?.email || a.name})`,
    );
    drainButton.title =
      "While selected: use to 0%, switch away, use the earliest-expiring saved reset, then return. Overrides recurring and model routing. Does not change priority.";
    drainButton.disabled = !data.canSelect || drainSaving.has(a.name);
    drainButton.addEventListener("click", () => toggleDrain(a.name));
    cardActions.append(selectButton, recurringRow, drainButton);
    card.append(cardActions);
    const modelUses = a.activeModels?.filter((m) => m.requested) || [];
    const modelLabels = [
      ...new Set(
        modelUses.map(
          (m) =>
            (m.fallback ? `${m.requested} → ${m.effective}` : m.effective) +
            (m.route === "free-sol" ? " · Free priority" : ""),
        ),
      ),
    ];
    if (modelLabels.length)
      detailContent.append(
        elem("p", "model-use", `In use: ${modelLabels.join("; ")}`),
      );
    else if (a.lastModelUse)
      detailContent.append(
        elem(
          "p",
          "model-use",
          `Last model: ${a.lastModelUse.fallback ? a.lastModelUse.requested + " → " : ""}${a.lastModelUse.effective}`,
        ),
      );
    if (["free", "go"].includes(a.profile?.plan))
      detailContent.append(
        elem(
          "p",
          "model-policy",
          "Astra fallback: GPT-6.1 Sol when listed, otherwise GPT-6 Sol. Availability depends on this account’s model access.",
        ),
      );
    const entries = Object.entries(a.usage).filter(
      ([, w]) => w && (w.usedPercent !== 0 || w.resetsAt || w.windowMinutes),
    );
    const usage = elem("div", "usage-grid");
    if (entries.length)
      for (const [side, w] of entries) usage.append(usageWindow(side, w));
    else usage.append(usageWindow("primary", null));
    card.append(usage);
    const drainState = a.drainStatus || { phase: "off" };
    if (a.drainEnabled) {
      const labels = {
        active: "Drain active",
        armed: "Drain armed",
        waiting: "Finishing requests · reset next",
        checking: "Checking reset",
        resetting: "Resetting · return next",
        paused: "Drain paused",
        depleted: "No resets · normal routing",
      };
      const status = elem(
        "div",
        "drain-status",
        labels[drainState.phase] || "Drain armed",
      );
      status.dataset.key = "drain-status";
      status.dataset.phase = drainState.phase;
      status.prepend(
        icon(
          ["waiting", "checking", "resetting"].includes(drainState.phase)
            ? "refresh"
            : "drain",
        ),
      );
      status.title = drainState.message || drainButton.title;
      card.append(status);
      detailContent.append(
        elem(
          "p",
          "drain-help",
          drainState.message ||
            "Drain uses saved resets automatically only while selected. At 0%, traffic switches away and returns after the reset. Priority stays unchanged.",
        ),
      );
    }
    if (a.credits?.balance !== null && a.credits?.balance !== undefined)
      detailContent.append(
        elem(
          "div",
          "credits",
          `Credit balance: ${a.credits.unlimited ? "Unlimited" : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(a.credits.balance)}`,
        ),
      );
    const resets = a.resets,
      resetCount = resets?.availableCount ?? a.resetsAvailable;
    const resetPanel = elem("div", "reset-panel"),
      resetSummary = elem("div", "reset-summary");
    resetSummary.title = resets?.updatedAt
      ? "Reset details checked " + new Date(resets.updatedAt).toLocaleString()
      : "Use Refresh limits for the latest saved reset details.";
    resetSummary.append(
      elem(
        "strong",
        "",
        resetCount === null || resetCount === undefined
          ? "Saved resets · not reported"
          : `${resetCount} saved reset${resetCount === 1 ? "" : "s"} available`,
      ),
    );
    const nearest = resets?.credits
      ?.filter(usableReset)
      .sort((x, y) => (x.expiresAt || Infinity) - (y.expiresAt || Infinity))[0];
    const pending = resets?.pendingCreditId;
    resetSummary.append(
      elem(
        "span",
        "",
        pending
          ? "Previous reset unconfirmed · retry safely"
          : nearest?.expiresAt
            ? `First expires ${fullDate(nearest.expiresAt)}`
            : nearest
              ? "Reset expiry not reported"
              : resetCount > 0
                ? "Open details to check expiry"
                : "Refresh limits to check availability",
      ),
    );
    const resetButton = elem(
      "button",
      "secondary reset-button",
      pending ? "Retry reset…" : "Use reset…",
    );
    resetButton.id = `reset-${a.name}`;
    resetButton.type = "button";
    resetButton.setAttribute(
      "aria-label",
      `${pending ? "Retry" : "Use"} saved reset for ${name(a)}`,
    );
    resetButton.disabled =
      !!data.draining ||
      !a.signedIn ||
      resets?.busy ||
      ["waiting", "checking", "resetting"].includes(a.drainStatus?.phase) ||
      (!pending && resetCount === 0);
    resetButton.addEventListener("click", () => openReset(a.name));
    resetPanel.append(resetSummary, resetButton);
    detailContent.append(resetPanel);
    if (resets?.error)
      detailContent.append(elem("p", "usage-error", resets.error));
    if (a.usageError)
      detailContent.append(elem("p", "usage-error", a.usageError));
    const bottom = elem("div", "card-bottom");
    bottom.append(
      elem("span", "", a.usageSource || "Awaiting a usage reading"),
      elem("span", "", ago(a.usageUpdatedAt)),
    );
    detailContent.append(bottom);
    card.append(details);
    cards.push(card);
  }
  return cards;
}
