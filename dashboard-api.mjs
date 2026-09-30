import { nativeLogin as windowsLogin } from "./desktop/login.mjs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { wireCodex, readCodexConnection } from "./codex-integration.mjs";

const SECURITY = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function reply(res, status, data) {
  res.writeHead(status, { ...SECURITY, "content-type": "application/json" });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 4096) throw new Error("Request too large.");
  }
  const input = text ? JSON.parse(text) : {};
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected a JSON object.");
  return input;
}
export function createDashboard({
  root,
  assetsRoot,
  config,
  accounts,
  snapshot,
  save,
  record,
  key,
  makeAccount,
  commitAccounts,
  reorderAccounts,
  selectAccount,
  setRecurringUse,
  setFreeSolRouting,
  reconcileSelection,
  loginRunner = windowsLogin,
  wireRunner = wireCodex,
  connectionRunner = readCodexConnection,
}) {
  const sessions = new Map();
  let refreshPromise = null;
  let lastRefresh = 0;
  let wirePromise = null,
    wireEnabled = null,
    codexConnection = null;
  let login = { state: "idle" };
  let loginProcess = null;
  let starting = false,
    loginWork = null;
  async function status() {
    for (const account of accounts) {
      try {
        await account.load();
        account.signedIn = true;
      } catch {
        account.signedIn = false;
      }
    }
    try {
      codexConnection = await connectionRunner({ root });
    } catch (error) {
      codexConnection = {
        state: "unknown",
        wired: null,
        message: error.message,
      };
    }
    const data = snapshot();
    data.accounts.forEach((a, i) => {
      a.signedIn = accounts[i].signedIn;
    });
    return {
      ...data,
      login,
      codexConnection,
      wiring: !!wirePromise,
      refreshing: !!refreshPromise,
      lastRefresh,
      refreshAvailableAt: lastRefresh + 30_000,
    };
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (Date.now() - lastRefresh < 30_000) return;
    lastRefresh = Date.now();
    refreshPromise = Promise.all(
      accounts.map(async (a) => {
        const ok = await a.refreshUsage();
        await a.benefits.refresh();
        return ok;
      }),
    )
      .then(async (results) => {
        await reconcileSelection();
        save();
        record(
          null,
          results.every(Boolean)
            ? "Account limits and saved reset details refreshed."
            : `Limits refreshed for ${results.filter(Boolean).length} of ${results.length} accounts; see account errors.`,
        );
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }
  function session(req) {
    const cookies = (req.headers.cookie || "").split(";").map((x) => x.trim());
    const token = cookies
      .find((x) => x.startsWith("router_dashboard="))
      ?.slice(17);
    return token && sessions.get(token) > Date.now();
  }
  async function startLogin(label) {
    if (starting || login.state === "waiting")
      throw new Error("A browser sign-in is already waiting.");
    if (accounts.length >= 20)
      throw new Error("This local dashboard supports up to 20 accounts.");
    starting = true;
    try {
      let number = 1;
      while (
        accounts.some((a) => a.name === `account-${number}`) ||
        (await stat(resolve(root, `accounts/account-${number}`)).then(
          () => true,
          () => false,
        ))
      )
        number++;
      // Failed attempts keep their protected files. A retry always gets a fresh sign-in folder.
      const spec = {
        name: `account-${number}`,
        label: label || `Account ${number}`,
        home: `accounts/account-${number}`,
        switchAtRemainingPercent: 1,
      };
      login = {
        state: "waiting",
        name: spec.name,
        label: spec.label,
        startedAt: Date.now(),
        message: "Complete the official sign-in in your browser.",
      };
      let cancelled = false;
      let process;
      try {
        process = loginRunner({
          root,
          home: resolve(root, spec.home),
          onUrl: (url) => {
            if (!cancelled) login = { ...login, url };
          },
        });
      } catch {
        login = {
          state: "error",
          message:
            "Could not open sign-in. Check that the Codex CLI is installed.",
        };
        throw new Error(login.message);
      }
      const cancel = process.cancel;
      let committing = false;
      process.cancel = () => {
        if (!committing) {
          cancelled = true;
          cancel();
        }
      };
      loginProcess = process;
      const timer = setTimeout(() => {
        process.cancel();
      }, 10 * 60_000);
      timer.unref();
      loginWork = process.done
        .then(async () => {
          if (cancelled) throw new Error("Sign-in cancelled.");
          const account = makeAccount(spec);
          await account.load();
          if (!label) {
            spec.label =
              account.profile.name || account.profile.email || spec.name;
            account.label = spec.label;
            account.switchAtRemainingPercent = spec.switchAtRemainingPercent;
          }
          for (const existing of accounts) {
            try {
              await existing.load();
            } catch {}
            if (existing.accountId === account.accountId)
              throw new Error(
                "This account is already connected. Choose another account and try again.",
              );
          }
          if (cancelled) throw new Error("Sign-in cancelled.");
          spec.accountIdentity = account.accountIdentity;
          committing = true;
          await commitAccounts(() => {
            if (cancelled) throw new Error("Sign-in cancelled.");
            return {
              specs: [...config.accounts, spec],
              items: [...accounts, account],
            };
          });
          login = {
            state: "success",
            name: spec.name,
            message: "Account connected and available to the proxy.",
          };
          record(account, "Account connected.");
          save();
          await account.refreshUsage();
          save();
          await account.benefits.refresh();
          save();
        })
        .catch((error) => {
          login = {
            state: "error",
            name: spec.name,
            message: cancelled
              ? "Sign-in cancelled. You can start again."
              : error.message.includes("already connected")
                ? error.message
                : "Sign-in could not be completed. Try again and choose a different account if necessary.",
          };
        })
        .finally(() => {
          clearTimeout(timer);
          if (loginProcess === process) loginProcess = null;
        });
    } finally {
      starting = false;
    }
  }
  async function handle(req, res, url) {
    if (!url.pathname.startsWith("/dashboard")) return false;
    const origin = `http://${req.headers.host}`;
    const crossSite = req.headers["sec-fetch-site"] === "cross-site";
    if (
      (req.headers.origin && req.headers.origin !== origin) ||
      (crossSite &&
        url.pathname !== "/dashboard" &&
        url.pathname !== "/dashboard/")
    ) {
      reply(res, 403, {
        error: "This dashboard is available only from its local page.",
      });
      return true;
    }
    const assets = new Map([
      ["/dashboard", "index.html"],
      ["/dashboard/", "index.html"],
      ...[
        "app.js",
        "cards.js",
        "dom.js",
        "icons.js",
        "style.css",
        "mark.svg",
      ].map((file) => ["/dashboard/" + file, file]),
    ]);
    if (req.method === "GET" && assets.has(url.pathname)) {
      const file = assets.get(url.pathname);
      const headers = {
        ...SECURITY,
        "content-type": file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html",
      };
      if (file === "index.html") {
        for (const [token, expiry] of sessions)
          if (expiry < Date.now()) sessions.delete(token);
        if (sessions.size > 100) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString("hex");
        sessions.set(token, Date.now() + 24 * 60 * 60_000);
        headers["set-cookie"] =
          `router_dashboard=${token}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=86400`;
      }
      res.writeHead(200, headers);
      res.end(await readFile(resolve(assetsRoot, file)));
      return true;
    }
    if (!session(req)) {
      reply(res, 401, {
        error: "Open or reload the dashboard to start a local session.",
      });
      return true;
    }
    if (url.pathname === "/dashboard/api/status" && req.method === "GET") {
      reply(res, 200, await status());
      return true;
    }
    if (
      req.method !== "POST" ||
      req.headers.origin !== origin ||
      req.headers["x-dashboard-request"] !== "1"
    ) {
      reply(res, 403, { error: "A same-origin dashboard action is required." });
      return true;
    }
    try {
      const input = await body(req);
      if (snapshot().draining)
        throw new Error(
          "The router is stopping. Open it again after shutdown finishes.",
        );
      if (url.pathname === "/dashboard/api/refresh") {
        await refresh();
        reply(res, 200, await status());
      } else if (url.pathname === "/dashboard/api/settings/free-sol") {
        await setFreeSolRouting(input.enabled);
        reply(res, 200, await status());
      } else if (url.pathname === "/dashboard/api/codex/wire") {
        const enabled = input.enabled ?? true;
        if (typeof enabled !== "boolean")
          throw new Error("Choose whether to wire or unwire Codex.");
        if (wirePromise && wireEnabled !== enabled)
          throw new Error(
            "A Codex connection change is already running. Wait for it to finish.",
          );
        if (!wirePromise) {
          wireEnabled = enabled;
          wirePromise = wireRunner({ root, enabled })
            .then((result) => {
              record(
                null,
                enabled
                  ? "Codex provider connected or verified. Reopen Codex if needed for new chats."
                  : "Codex default provider disconnected from the router. Existing chats retain their saved provider.",
              );
              return result;
            })
            .finally(() => {
              wirePromise = null;
              wireEnabled = null;
            });
        }
        const result = await wirePromise;
        reply(res, 200, { ...(await status()), connectionChange: result });
      } else if (url.pathname === "/dashboard/api/accounts/select") {
        await selectAccount(input.name);
        reply(res, 200, { ...(await status()), requestedAccount: input.name });
      } else if (url.pathname === "/dashboard/api/accounts/recurring") {
        await setRecurringUse(input.name, input.enabled);
        reply(res, 200, await status());
      } else if (
        url.pathname === "/dashboard/api/accounts/reset-details" ||
        url.pathname === "/dashboard/api/accounts/use-reset"
      ) {
        const account = accounts.find((a) => a.name === input.name);
        if (!account)
          throw new Error("Account not found. Refresh the dashboard.");
        await account.load();
        if (url.pathname.endsWith("/reset-details")) {
          await account.benefits.ready;
          if (
            !(await account.benefits.refresh()) &&
            !account.benefits.view().pendingCreditId
          )
            throw new Error(account.benefits.view().error);
          reply(res, 200, await status());
        } else {
          if (input.confirmed !== true)
            throw new Error(
              "Confirm the selected account and saved reset first.",
            );
          const result = await account.benefits.consume(input.creditId);
          await reconcileSelection();
          record(
            account,
            {
              reset: "Saved reset applied.",
              already_redeemed: "Saved reset was already applied.",
              nothing_to_reset: "No eligible usage window needed a reset.",
              no_credit: "No saved reset was available.",
            }[result.outcome],
          );
          save();
          reply(res, 200, { ...(await status()), resetResult: result });
        }
      } else if (url.pathname === "/dashboard/api/accounts/order") {
        await reorderAccounts(input.names);
        reply(res, 200, await status());
      } else if (url.pathname === "/dashboard/api/accounts") {
        if (
          input.label !== undefined &&
          (typeof input.label !== "string" ||
            input.label.length > 40 ||
            !input.label.trim())
        )
          throw new Error("Use an account label between 1 and 40 characters.");
        await startLogin(input.label?.trim());
        reply(res, 202, await status());
      } else if (url.pathname === "/dashboard/api/login/cancel") {
        if (loginProcess && login.state === "waiting") {
          loginProcess.cancel();
          login = { ...login, message: "Cancelling sign-in…" };
        }
        reply(res, 200, await status());
      } else reply(res, 404, { error: "Unknown dashboard action." });
    } catch (error) {
      reply(res, 400, { error: error.message });
    }
    return true;
  }
  return {
    handle,
    loginPending: () => starting || login.state === "waiting",
    settled: async () => {
      await refreshPromise;
      await loginWork;
      await wirePromise?.catch(() => {});
      await Promise.allSettled(
        accounts.flatMap((a) => [
          a.benefits.refreshing,
          a.benefits.consuming?.promise,
        ]),
      );
    },
  };
}
