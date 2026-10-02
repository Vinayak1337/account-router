import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Account, accountPolicy, atomicJson, createRouter } from "./router.mjs";
import {
  AccountBenefits,
  subscriptionFromClaims,
} from "./account-benefits.mjs";
import { isSol6, modelUnavailable } from "./free-sol-routing.mjs";

const KEY = "test-local-key-that-is-long-enough";
const jwt = (exp, account = "id-a") =>
  `h.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.s`;
async function fixture(
  t,
  handler,
  {
    expire = false,
    strategy = "exhaust-first",
    loginRunner,
    wireRunner,
    connectionRunner = async () => ({
      state: "connected",
      wired: true,
      provider: "local_paid_accounts",
    }),
    persist = false,
    idleTimeoutMs,
    accountNames = ["a", "b"],
    recurringPollMs,
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "codex-router-test-"));
  for (const name of accountNames) {
    await mkdir(join(root, name));
    await atomicJson(join(root, name, "auth.json"), {
      tokens: {
        account_id: `id-${name}`,
        access_token: jwt(
          Math.floor(Date.now() / 1000) + (expire ? -60 : 3600),
          `id-${name}`,
        ),
        refresh_token: `refresh-${name}`,
        id_token: "id-token",
      },
    });
  }
  const calls = [];
  const config = {
    strategy,
    accounts: accountNames.map((name) => ({
      name,
      home: name,
      ...(name === "account-4" ? { switchAtRemainingPercent: 0 } : {}),
    })),
  };
  const router = await createRouter(config, {
    root,
    key: KEY,
    persist,
    loginRunner,
    wireRunner,
    connectionRunner,
    idleTimeoutMs,
    recurringPollMs,
    fetcher: async (url, options) => {
      calls.push({
        url,
        options,
        account:
          options.headers instanceof Headers
            ? options.headers.get("ChatGPT-Account-Id")
            : null,
      });
      return handler(url, options, calls);
    },
  });
  router.server.listen(0, "127.0.0.1");
  await once(router.server, "listening");
  const base = `http://127.0.0.1:${router.server.address().port}`;
  const send = (
    body = { model: "test", input: [], stream: true },
    headers = {},
  ) =>
    fetch(base + "/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Local-Router-Key": KEY,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  t.after(async () => {
    await router.drainUse.stop();
    await router.recurring.stop();
    router.server.closeAllConnections();
    await new Promise((r) => router.server.close(r));
    await router.flushed();
    await rm(root, { recursive: true, force: true });
  });
  return { root, router, calls, send, base, config };
}
const ok = (id = "r1") =>
  new Response(
    `data: ${JSON.stringify({ type: "response.created", response: { id } })}\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"id":"${id}"}}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
const quota = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "usage_limit_reached",
        resets_at: Math.floor(Date.now() / 1000) + 100,
      },
    }),
    { status: 429, headers: { "content-type": "application/json" } },
  );
const resetDetails = (overrides = {}) => ({
  available_count: 1,
  credits: [
    {
      id: "credit-1",
      reset_type: "codex_rate_limits",
      is_supported_by_plan: true,
      status: "available",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      title: "Full reset",
      ...overrides,
    },
  ],
});
const usagePayload = () => ({
  plan_type: "plus",
  rate_limit: {
    allowed: true,
    primary_window: {
      used_percent: 0,
      reset_at: Math.floor(Date.now() / 1000) + 18000,
      limit_window_seconds: 18000,
    },
  },
  rate_limit_reset_credits: { available_count: 0 },
});

function observedUsage(a, used, reset = Date.now() / 1000 + 18000) {
  a.observe(
    new Headers({
      "x-codex-primary-used-percent": String(used),
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": String(reset),
    }),
  );
}

function setPlans(f, plans) {
  f.router.accounts.forEach((a, i) => {
    a.profile.plan = plans[i];
    observedUsage(a, 0);
  });
}

test("Free Sol matcher includes 6 and 6.1 Sol, and never routes Astra, Luna, Go aliases or another family", () => {
  for (const model of ["gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-sol-2026-09-29"])
    assert.equal(isSol6(model), true);
  for (const model of [
    "gpt-6-astra",
    "gpt-6.1-astra",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-60-sol",
    "gpt-6-sol-extra",
    "",
    null,
  ])
    assert.equal(isSol6(model), false);
});

test("explicit Sol model access rejection falls back to usual, preserving the model and skipping the rejected pair", async (t) => {
  const seen = [];
  let deny = true;
  const f = await fixture(t, (_url, o) => {
    const id = o.headers.get("ChatGPT-Account-Id"),
      model = JSON.parse(o.body).model;
    seen.push([id, model]);
    if (id === "id-b" && model === "gpt-6.1-sol" && deny)
      return Response.json(
        {
          error: {
            code: "model_not_found",
            message: "This model is not available for this account.",
          },
        },
        { status: 404 },
      );
    return ok(id);
  });
  setPlans(f, ["pro", "free"]);
  const first = await f.send({ model: "gpt-6.1-sol" });
  await first.text();
  assert.equal(first.headers.get("x-local-router-account"), "a");
  assert.equal(first.headers.get("x-local-router-route"), "usual-fallback");
  assert.deepEqual(seen, [
    ["id-b", "gpt-6.1-sol"],
    ["id-a", "gpt-6.1-sol"],
  ]);
  const again = await f.send({ model: "gpt-6.1-sol" });
  await again.text();
  assert.equal(again.headers.get("x-local-router-account"), "a");
  const supported = await f.send({ model: "gpt-6-sol" });
  await supported.text();
  assert.equal(supported.headers.get("x-local-router-account"), "b");
  assert.equal(f.router.snapshot().freeSol.unavailable.length, 1);
  deny = false; // A plan change invalidates the Free-only negative access reading.
  f.router.accounts[1].profile.plan = "plus";
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  const upgraded = await f.send({ model: "gpt-6.1-sol" });
  await upgraded.text();
  assert.equal(upgraded.headers.get("x-local-router-account"), "b");
});

test("model rejection detection is narrow; a Free account generic 403 is not replayed", async (t) => {
  for (const status of [400, 403, 404, 422])
    assert.equal(
      modelUnavailable(
        {
          error: {
            message: "The requested model is not supported with this plan.",
          },
        },
        status,
      ),
      true,
    );
  for (const status of [401, 429, 500, 503])
    assert.equal(
      modelUnavailable({ error: { code: "model_not_found" } }, status),
      false,
    );
  assert.equal(
    modelUnavailable(
      { error: { code: "access_denied", message: "Forbidden" } },
      403,
    ),
    false,
  );
  const f = await fixture(t, () =>
    Response.json(
      { error: { code: "access_denied", message: "Forbidden" } },
      { status: 403 },
    ),
  );
  setPlans(f, ["plus", "free"]);
  assert.equal((await f.send({ model: "gpt-6-sol" })).status, 403);
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b"],
  );
});

test("streamed Sol access failure is not replayed and subsequent requests fall back to usual", async (t) => {
  const f = await fixture(t, (_url, o) =>
    o.headers.get("ChatGPT-Account-Id") === "id-b"
      ? new Response(
          'data: {"type":"response.failed","response":{"id":"denied-sol","error":{"code":"model_not_supported"}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      : ok(),
  );
  setPlans(f, ["plus", "free"]);
  const failed = await f.send({ model: "gpt-6-sol" });
  assert.match(await failed.text(), /model_not_supported/);
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b"],
  );
  const fallback = await f.send({ model: "gpt-6-sol" });
  await fallback.text();
  assert.equal(fallback.headers.get("x-local-router-account"), "a");
  assert.equal(
    (await f.send({ model: "gpt-6-sol", previous_response_id: "denied-sol" }))
      .status,
    409,
  );
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b", "id-a"],
  );
});

test("Sol uses Free priority simultaneously with usual recurring traffic, without changing either in-flight account", async (t) => {
  let finish;
  const f = await fixture(
    t,
    (_url, o) => {
      const id = o.headers.get("ChatGPT-Account-Id");
      if (id === "id-a")
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.created","response":{"id":"usual-old"}}\n\n',
                ),
              );
              finish = () => {
                c.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.completed","response":{"id":"usual-old"}}\n\n',
                  ),
                );
                c.close();
              };
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return ok(id);
    },
    { accountNames: ["a", "b", "c", "d"] },
  );
  setPlans(f, ["pro", "go", "free", "free"]);
  const post = await dashboardPost(f);
  await post("accounts/recurring", { name: "a", enabled: true });
  const old = await f.send({ model: "gpt-6-astra", input: [], stream: true });
  try {
    assert.equal(f.router.snapshot().freeSol.enabled, true);
    const sol = await f.send({ model: "gpt-6-sol", input: [], stream: true });
    await sol.text();
    assert.equal(sol.headers.get("x-local-router-account"), "c");
    assert.equal(sol.headers.get("x-local-router-route"), "free-sol");
    assert.equal(f.router.accounts[0].activeRequests, 1);
    assert.equal(f.router.snapshot().selectedAccount, "a");
    await post("accounts/order", { names: ["a", "b", "d", "c"] });
    const next = await f.send({
      model: "gpt-6.1-sol",
      input: [],
      stream: true,
    });
    await next.text();
    assert.equal(next.headers.get("x-local-router-account"), "d");
    assert.equal(f.router.snapshot().selectedAccount, "a");
  } finally {
    finish();
    await old.text();
  }
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("Free Sol quota fallback exhausts Free priority then uses usual selection; generic throttles do not rotate", async (t) => {
  let throttle = false;
  const f = await fixture(
    t,
    (_url, o) => {
      const id = o.headers.get("ChatGPT-Account-Id");
      if (throttle)
        return new Response('{"error":{"code":"rate_limit_exceeded"}}', {
          status: 429,
        });
      return id === "id-a" ? ok() : quota();
    },
    { accountNames: ["a", "b", "c"] },
  );
  setPlans(f, ["plus", "free", "free"]);
  const first = await f.send({ model: "gpt-6-sol" });
  await first.text();
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b", "id-c", "id-a"],
  );
  assert.equal(first.headers.get("x-local-router-route"), "usual-fallback");
  const b = f.router.accounts[1];
  b.blockedUntil = 0;
  b.reason = null;
  observedUsage(b, 0);
  throttle = true;
  const count = f.calls.length;
  assert.equal((await f.send({ model: "gpt-6-sol" })).status, 429);
  assert.deepEqual(
    f.calls.slice(count).map((c) => c.account),
    ["id-b"],
  );
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("Free Sol excludes Go, unknown allowance, stale exhausted windows and errored reads, and obeys the toggle", async (t) => {
  const f = await fixture(t, () => ok(), {
    accountNames: ["a", "b", "c", "d", "e"],
  });
  setPlans(f, ["pro", "go", "free", "free", "free"]);
  const [, , c, d, e] = f.router.accounts;
  c.usage = {};
  d.usageError = "offline";
  observedUsage(e, 100, Date.now() / 1000 - 1);
  const fallback = await f.send({ model: "gpt-6.1-sol" });
  await fallback.text();
  assert.equal(fallback.headers.get("x-local-router-account"), "a");
  observedUsage(c, 10);
  const free = await f.send({ model: "gpt-6.1-sol" });
  await free.text();
  assert.equal(free.headers.get("x-local-router-account"), "c");
  const post = await dashboardPost(f);
  const results = await Promise.all([
    post("settings/free-sol", { enabled: false }),
    post("accounts/order", { names: ["e", "d", "c", "b", "a"] }),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  const config = JSON.parse(
    await readFile(join(f.root, "router.config.json"), "utf8"),
  );
  assert.equal(config.freeSolRouting, false);
  assert.deepEqual(
    config.accounts.map((a) => a.name),
    ["e", "d", "c", "b", "a"],
  );
  const usual = await f.send({ model: "gpt-6-sol" });
  await usual.text();
  assert.equal(usual.headers.get("x-local-router-account"), "a");
  assert.equal((await post("settings/free-sol", { enabled: 1 })).status, 400);
});

test("disabling Free Sol during credential preparation reselects before upstream dispatch", async (t) => {
  const f = await fixture(t, () => ok());
  setPlans(f, ["plus", "free"]);
  const b = f.router.accounts[1],
    original = b.token.bind(b);
  let release, entered;
  const held = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      entered = r;
    });
  b.token = async (...args) => {
    entered();
    await held;
    return original(...args);
  };
  const pending = f.send({ model: "gpt-6-sol" });
  await started;
  const post = await dashboardPost(f);
  await post("settings/free-sol", { enabled: false });
  release();
  const response = await pending;
  await response.text();
  assert.equal(response.headers.get("x-local-router-account"), "a");
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-a"],
  );
});

test("Free Sol contexts remain on their own account, and toggle changes require full context", async (t) => {
  const f = await fixture(t, (_url, o) =>
    ok("origin-" + o.headers.get("ChatGPT-Account-Id")),
  );
  setPlans(f, ["plus", "free"]);
  await (await f.send({ model: "gpt-6-sol" })).text();
  assert.equal(f.router.snapshot().selectedAccount, "a");
  const reuse = await f.send({
    model: "gpt-6-sol",
    previous_response_id: "origin-id-b",
  });
  await reuse.text();
  assert.equal(reuse.status, 200);
  assert.equal(reuse.headers.get("x-local-router-account"), "b");
  const compact = await fetch(f.base + "/v1/responses/compact", {
    method: "POST",
    headers: { "X-Local-Router-Key": KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", input: [] }),
  });
  await compact.text();
  assert.equal(compact.headers.get("x-local-router-account"), "b");
  const post = await dashboardPost(f);
  await post("settings/free-sol", { enabled: false });
  const before = f.calls.length;
  assert.equal(
    (await f.send({ model: "gpt-6-sol", previous_response_id: "origin-id-b" }))
      .status,
    409,
  );
  assert.equal(f.calls.length, before);
  const fresh = await f.send({ model: "gpt-6-sol" });
  await fresh.text();
  assert.equal(fresh.headers.get("x-local-router-account"), "a");
});

test("a late Free quota recovery wins over a usual fallback still preparing its credentials", async (t) => {
  const f = await fixture(t, () => ok());
  setPlans(f, ["plus", "free"]);
  const [a, b] = f.router.accounts;
  observedUsage(b, 100);
  let enter, release;
  const started = new Promise((r) => {
      enter = r;
    }),
    held = new Promise((r) => {
      release = r;
    }),
    token = a.token.bind(a);
  a.token = async (...args) => {
    enter();
    await held;
    return token(...args);
  };
  const pending = f.send({ model: "gpt-6-sol" });
  await started;
  observedUsage(b, 0);
  release();
  const result = await pending;
  await result.text();
  assert.equal(result.headers.get("x-local-router-account"), "b");
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b"],
  );
});

test("Wire to Codex is session-protected and coalesces concurrent clicks", async (t) => {
  let count = 0,
    release;
  const held = new Promise((r) => {
    release = r;
  });
  const f = await fixture(t, () => ok(), {
    wireRunner: async () => {
      count++;
      await held;
      return {
        state: "configured",
        message: "Configured",
        app: { found: true, running: true },
      };
    },
  });
  assert.equal(
    (
      await fetch(f.base + "/dashboard/api/codex/wire", {
        method: "POST",
        body: "{}",
      })
    ).status,
    401,
  );
  let arrived = 0;
  f.router.server.on("request", (req) => {
    if (req.url === "/dashboard/api/codex/wire")
      req.once("end", () => {
        arrived++;
      });
  });
  const post = await dashboardPost(f);
  const one = post("codex/wire", {}),
    two = post("codex/wire", {});
  await until(() => arrived === 2 && count === 1);
  release();
  const results = await Promise.all([one, two]);
  assert.equal(count, 1);
  assert.ok(results.every((r) => r.status === 200));
  const data = await results[0].json();
  assert.equal(data.codexConnection.wired, true);
  assert.equal(data.connectionChange.state, "configured");
  assert.equal(data.wiring, false);
});

test("one connection endpoint unwires and rewires, and status follows the actual default provider", async (t) => {
  let wired = true;
  const changes = [];
  const f = await fixture(t, () => ok(), {
    connectionRunner: async () => ({
      wired,
      provider: wired ? "local_paid_accounts" : "openai",
    }),
    wireRunner: async ({ enabled }) => {
      changes.push(enabled);
      wired = enabled;
      return { wired, state: enabled ? "configured" : "disabled" };
    },
  });
  const post = await dashboardPost(f);
  let r = await post("codex/wire", { enabled: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).codexConnection.wired, false);
  r = await post("codex/wire", { enabled: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).codexConnection.wired, true);
  assert.deepEqual(changes, [false, true]);
  assert.equal((await post("codex/wire", { enabled: "false" })).status, 400);
  assert.equal(f.calls.length, 0);
});

test("opposite connection action cannot race a pending change; unreadable state is reported honestly", async (t) => {
  let release, started;
  const held = new Promise((r) => {
      release = r;
    }),
    entered = new Promise((r) => {
      started = r;
    });
  const f = await fixture(t, () => ok(), {
    connectionRunner: async () => {
      throw new Error("Config cannot be read.");
    },
    wireRunner: async () => {
      started();
      await held;
      return { wired: false, state: "disabled" };
    },
  });
  const post = await dashboardPost(f),
    pending = post("codex/wire", { enabled: false });
  await entered;
  const conflict = await post("codex/wire", { enabled: true });
  assert.equal(conflict.status, 400);
  assert.match(await conflict.text(), /already running/);
  release();
  const data = await (await pending).json();
  assert.equal(data.codexConnection.wired, null);
  assert.equal(data.codexConnection.state, "unknown");
});

test("recurring use immediately promotes a ready account and persists with concurrent order edits", async (t) => {
  const f = await fixture(
    t,
    (url) => (url.endsWith("/usage") ? Response.json(usagePayload()) : ok()),
    { persist: true },
  );
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  await f.router.accounts[0].refreshUsage();
  assert.ok(f.router.accounts.every((a) => a.recurringUse === false));
  const results = await Promise.all([
    post("accounts/recurring", { name: "a", enabled: true }),
    post("accounts/order", { names: ["b", "a"] }),
  ]);
  assert.ok(results.every((r) => r.status === 200));
  await (await f.send()).text();
  assert.equal(f.router.snapshot().selectedAccount, "a");
  const config = JSON.parse(
    await readFile(join(f.root, "router.config.json"), "utf8"),
  );
  assert.deepEqual(
    config.accounts.map((a) => a.name),
    ["b", "a"],
  );
  assert.equal(config.accounts[1].recurringUse, true);
  await f.router.recurring.stop();
  await f.router.flushed();
  const restored = await createRouter(config, {
    root: f.root,
    key: KEY,
    persist: true,
    fetcher: async () => Response.json(usagePayload()),
  });
  t.after(async () => {
    await restored.recurring.stop();
    await restored.flushed();
  });
  assert.equal(restored.accounts[1].recurringUse, true);
  assert.equal(restored.snapshot().selectedAccount, "a");
  assert.equal(
    (await post("accounts/recurring", { name: "a", enabled: "yes" })).status,
    400,
  );
  assert.equal(
    (await post("accounts/recurring", { name: "absent", enabled: true }))
      .status,
    400,
  );
});

test("recurring recovery wakes at the reset with no browser polling and moves new requests while an old stream finishes", async (t) => {
  const resetAt = (Date.now() + 650) / 1000;
  let finish;
  const f = await fixture(
    t,
    (url, o) => {
      const id =
        o.headers instanceof Headers
          ? o.headers.get("ChatGPT-Account-Id")
          : o.headers["ChatGPT-Account-Id"];
      if (url.endsWith("/usage")) {
        const d = usagePayload();
        if (id === "id-a" && Date.now() < resetAt * 1000)
          d.rate_limit.primary_window.used_percent = 100;
        return Response.json(d);
      }
      if (id === "id-b")
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.created","response":{"id":"old-b"}}\n\n',
                ),
              );
              finish = () => {
                c.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.completed","response":{"id":"old-b"}}\n\n',
                  ),
                );
                c.close();
              };
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return ok("recovered-a");
    },
    { persist: true },
  );
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  observedUsage(f.router.accounts[0], 100, resetAt);
  await post("accounts/recurring", { name: "a", enabled: true });
  const old = await f.send();
  try {
    await until(() => f.router.snapshot().selectedAccount === "a");
    assert.equal(f.router.accounts[1].activeRequests, 1);
    assert.equal(f.router.snapshot().selectionSource, "recurring");
    const next = await f.send();
    await next.text();
    assert.equal(next.headers.get("x-local-router-account"), "a");
    assert.equal(f.router.snapshot().accounts[0].recurringStatus, "ready");
  } finally {
    finish();
    await old.text();
  }
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("recovering accounts wait for the same read batch, respect latest priority, and never bounce to the runner-up", async (t) => {
  let recovered = false,
    releaseB,
    enteredB;
  const held = new Promise((r) => {
      releaseB = r;
    }),
    started = new Promise((r) => {
      enteredB = r;
    });
  const f = await fixture(
    t,
    async (url, o) => {
      if (url.endsWith("/usage")) {
        const id = o.headers["ChatGPT-Account-Id"];
        if (recovered && id === "id-b") {
          enteredB();
          await held;
        }
        const d = usagePayload();
        d.rate_limit.primary_window.used_percent =
          id === "id-c" || recovered ? 0 : 100;
        return Response.json(d);
      }
      return ok();
    },
    { persist: true, accountNames: ["a", "b", "c"] },
  );
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "c" });
  for (const a of f.router.accounts.slice(0, 2)) {
    observedUsage(a, 100);
    await post("accounts/recurring", { name: a.name, enabled: true });
  }
  recovered = true;
  for (const a of f.router.accounts.slice(0, 2)) {
    a.lastUsageAttempt = 0;
    a.usageUpdatedAt = 0;
  }
  f.router.recurring.kick();
  await started;
  try {
    await post("accounts/order", { names: ["b", "a", "c"] });
    assert.equal(f.router.snapshot().selectedAccount, "c");
  } finally {
    releaseB();
  }
  await until(() => f.router.snapshot().selectedAccount === "b");
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      await (await f.send()).text();
    }),
  );
  assert.equal(f.router.snapshot().selectedAccount, "b");
  await post("accounts/select", { name: "c" });
  await (await f.send()).text();
  assert.equal(f.router.snapshot().selectedAccount, "b");
  await post("accounts/order", { names: ["a", "b", "c"] });
  await (await f.send()).text();
  assert.equal(f.router.snapshot().selectedAccount, "a");
  await post("accounts/recurring", { name: "a", enabled: false });
  assert.equal(f.router.snapshot().selectedAccount, "b");
  await post("accounts/recurring", { name: "b", enabled: false });
  await post("accounts/select", { name: "c" });
  assert.equal(f.router.snapshot().selectedAccount, "c");
});

test("failed, missing and expired readings do not count as recurring recovery; disabling cancels a pending recovery", async (t) => {
  let mode = "failure";
  const f = await fixture(t, (url) => {
    if (!url.endsWith("/usage")) return ok();
    if (mode === "failure") throw new Error("offline");
    const d = usagePayload();
    if (mode === "unknown") d.rate_limit.primary_window = null;
    if (mode === "expired") {
      d.rate_limit.primary_window.used_percent = 100;
      d.rate_limit.primary_window.reset_at = Date.now() / 1000 - 1;
    }
    return Response.json(d);
  });
  const [a, b] = f.router.accounts;
  observedUsage(a, 100);
  observedUsage(b, 0);
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  await post("accounts/recurring", { name: "a", enabled: true });
  for (mode of ["failure", "unknown", "expired"]) {
    await a.refreshUsage();
    await (await f.send()).text();
    assert.equal(f.router.snapshot().selectedAccount, "b");
  }
  assert.equal(
    (await post("accounts/recurring", { name: "a", enabled: false })).status,
    200,
  );
  mode = "ready";
  await a.refreshUsage();
  await (await f.send()).text();
  assert.equal(f.router.snapshot().selectedAccount, "b");
  assert.equal(f.router.recurring.timer, null);
});

test("waiting for recurring recovery survives restart, checks only opted-in accounts, and stops on shutdown", async (t) => {
  const f = await fixture(t, () => ok(), { persist: true });
  const [a, b] = f.router.accounts;
  observedUsage(a, 100);
  observedUsage(b, 0);
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  await post("accounts/recurring", { name: "a", enabled: true });
  await f.router.recurring.stop();
  await f.router.flushed();
  const saved = JSON.parse(
    await readFile(join(f.root, ".runtime/state.json"), "utf8"),
  );
  assert.equal(saved.accounts.find((a) => a.name === "a").recurringUse, true);
  assert.equal(
    saved.accounts.find((a) => a.name === "a").usage.primary.usedPercent,
    100,
  );
  const reads = [];
  const restored = await createRouter(f.config, {
    root: f.root,
    key: KEY,
    persist: true,
    recurringPollMs: 20,
    fetcher: async (_url, o) => {
      reads.push(o.headers["ChatGPT-Account-Id"]);
      return Response.json(usagePayload());
    },
  });
  t.after(async () => {
    await restored.recurring.stop();
    await restored.flushed();
  });
  await until(() => restored.snapshot().selectedAccount === "a");
  assert.ok(reads.length > 0);
  assert.ok(reads.every((id) => id === "id-a"));
  await restored.drain();
  const count = reads.length;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(reads.length, count);
});

test("recurring Golu returns after confirmed natural recovery without spending a saved reset", async (t) => {
  const f = await goluFixture(t),
    g = f.router.accounts[1];
  await f.post("accounts/recurring", { name: "account-4", enabled: true });
  f.exhaust();
  await (await f.send()).text();
  assert.equal(f.router.snapshot().selectedAccount, "a");
  assert.equal(f.redemptions.length, 0);
  f.recover();
  await g.refreshUsage();
  await until(() => f.router.snapshot().selectedAccount === "account-4");
  assert.equal(f.router.snapshot().selectionSource, "recurring");
  assert.equal(f.redemptions.length, 0);
});

test("subscription expiry uses the reported subscription field and preserves unknown dates", () => {
  assert.deepEqual(
    subscriptionFromClaims({
      chatgpt_plan_type: "plus",
      chatgpt_subscription_active_until: "2026-10-27T18:00:00Z",
      chatgpt_subscription_last_checked: "2026-09-29T10:00:00Z",
    }),
    { plan: "plus", activeUntil: 1793124000, checkedAt: 1790676000 },
  );
  assert.equal(
    subscriptionFromClaims({
      exp: 1793124000,
      chatgpt_subscription_active_until: "unknown",
    }).activeUntil,
    null,
  );
  assert.equal(subscriptionFromClaims().activeUntil, null);
});

test("saved reset stays on the chosen account, needs confirmation, and refreshes real usage", async (t) => {
  let consumed = 0;
  const f = await fixture(t, (url, o) => {
    assert.equal(o.headers["ChatGPT-Account-Id"], "id-b");
    if (url.endsWith("/consume")) {
      consumed++;
      assert.equal(JSON.parse(o.body).credit_id, "credit-1");
      return Response.json({ code: "reset" });
    }
    return Response.json(
      url.endsWith("/usage") ? usagePayload() : resetDetails(),
    );
  });
  const cookie = await dashboardSession(f.base),
    headers = { cookie, origin: f.base, "x-dashboard-request": "1" };
  const post = (path, body) =>
    fetch(f.base + "/dashboard/api/accounts/" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  assert.equal(
    (await post("use-reset", { name: "b", creditId: "credit-1" })).status,
    400,
  );
  assert.equal(f.calls.length, 0);
  assert.equal((await post("reset-details", { name: "b" })).status, 200);
  assert.equal(consumed, 0);
  f.router.accounts[1].usage = {
    primary: { usedPercent: 100, resetsAt: Date.now() / 1000 + 18000 },
  };
  f.router.accounts[1].blockedUntil = Date.now() + 18000000;
  f.router.accounts[1].reason = "allowance-exhausted";
  const result = await (
    await post("use-reset", {
      name: "b",
      creditId: "credit-1",
      confirmed: true,
    })
  ).json();
  assert.equal(result.resetResult.outcome, "reset");
  assert.equal(result.resetResult.usageRefreshed, true);
  assert.equal(result.accounts[1].usage.primary.usedPercent, 0);
  assert.equal(result.accounts[1].blockedUntil, 0);
  assert.equal(consumed, 1);
  await post("use-reset", { name: "b", creditId: "credit-1", confirmed: true });
  assert.equal(consumed, 1);
});

test("concurrent reset clicks coalesce, and an uncertain result reuses its persisted key after restart", async (t) => {
  let fail = true;
  const keys = [];
  const f = await fixture(t, async (url, o) => {
    if (url.endsWith("/consume")) {
      keys.push(JSON.parse(o.body).redeem_request_id);
      await new Promise((r) => setTimeout(r, 10));
      if (fail) throw new Error("Connection dropped after server accepted");
      return Response.json({ code: "already_redeemed" });
    }
    return Response.json(
      url.endsWith("/usage") ? usagePayload() : resetDetails(),
    );
  });
  const a = f.router.accounts[0];
  const first = a.benefits.consume("credit-1"),
    second = a.benefits.consume("credit-1");
  assert.equal(first, second);
  await assert.rejects(first, /unconfirmed/);
  assert.equal(keys.length, 1);
  const saved = JSON.parse(
    await readFile(join(f.root, ".runtime/reset-attempts/a.json"), "utf8"),
  );
  assert.equal(saved.attempts[0].key, keys[0]);
  a.benefits = new AccountBenefits(a, f.root, atomicJson);
  await a.benefits.ready;
  assert.equal(a.benefits.view().pendingCreditId, "credit-1");
  fail = false;
  assert.equal(
    (await a.benefits.consume("credit-1")).outcome,
    "already_redeemed",
  );
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.equal(a.benefits.view().pendingCreditId, null);
});

test("expired, unsupported, and malformed expiry resets cannot be redeemed", async (t) => {
  let fields = {};
  let posts = 0;
  const f = await fixture(t, (_url, o) => {
    if (o.method === "POST") posts++;
    return Response.json(resetDetails(fields));
  });
  for (const override of [
    { expires_at: new Date(Date.now() - 1000).toISOString() },
    { is_supported_by_plan: false },
    { expires_at: "bad-date" },
    { reset_type: "future-unknown-reset" },
  ]) {
    fields = override;
    await assert.rejects(
      f.router.accounts[0].benefits.consume("credit-1"),
      /expired, unavailable, or unsupported/,
    );
  }
  assert.equal(posts, 0);
});

test("nothing-to-reset remains unspent and a later user attempt gets a new idempotency key", async (t) => {
  const keys = [];
  const f = await fixture(t, (url, o) => {
    if (url.endsWith("/consume")) {
      keys.push(JSON.parse(o.body).redeem_request_id);
      return Response.json({ code: "nothing_to_reset" });
    }
    return Response.json(
      url.endsWith("/usage") ? usagePayload() : resetDetails(),
    );
  });
  const b = f.router.accounts[0].benefits;
  assert.equal((await b.consume("credit-1")).outcome, "nothing_to_reset");
  assert.equal(b.view().availableCount, 1);
  assert.equal((await b.consume("credit-1")).outcome, "nothing_to_reset");
  assert.notEqual(keys[0], keys[1]);
});

test("reset journal failure prevents redemption and never exposes a false success", async (t) => {
  let posts = 0;
  const f = await fixture(t, (_url, o) => {
    if (o.method === "POST") posts++;
    return Response.json(resetDetails());
  });
  const b = f.router.accounts[0].benefits;
  b.writeJson = async () => {
    throw new Error("disk unavailable");
  };
  await assert.rejects(b.consume("credit-1"), /disk unavailable/);
  assert.equal(posts, 0);
});

test("quota rejection switches to the next paid account and stays there", async (t) => {
  const f = await fixture(t, (_u, o) =>
    o.headers.get("ChatGPT-Account-Id") === "id-a" ? quota() : ok(),
  );
  const r = await f.send();
  assert.equal(r.status, 200);
  assert.match(await r.text(), /ok/);
  await (await f.send()).text();
  assert.deepEqual(
    f.calls.map((x) => x.account),
    ["id-a", "id-b", "id-b"],
  );
  assert.ok(f.router.accounts[0].blockedUntil > Date.now());
});
test("generic rate throttling does not rotate accounts", async (t) => {
  const f = await fixture(
    t,
    () =>
      new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }),
  );
  assert.equal((await f.send()).status, 429);
  assert.equal(f.calls.length, 1);
});
test("403 model denial passes through without selecting another account", async (t) => {
  const f = await fixture(t, () => new Response("denied", { status: 403 }));
  assert.equal((await f.send()).status, 403);
  assert.equal(f.calls.length, 1);
});
test("all exhausted accounts return a bounded retry and are not hammered", async (t) => {
  const f = await fixture(t, () => quota());
  const r = await f.send();
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) > 0);
  assert.equal((await f.send()).status, 429);
  assert.equal(f.calls.length, 2);
});
test("local authentication and origin checks reject browser and unauthenticated calls", async (t) => {
  const f = await fixture(t, () => ok());
  assert.equal((await fetch(f.base + "/status")).status, 403);
  assert.equal(
    (await f.send({}, { origin: "https://example.com" })).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});
test("desktop credentials and identity headers never leak into the selected account", async (t) => {
  const f = await fixture(t, (_u, o) => {
    assert.equal(o.headers.get("cookie"), null);
    assert.equal(o.headers.get("x-openai-actor-authorization"), null);
    assert.equal(o.headers.get("chatgpt-account-id"), "id-a");
    assert.notEqual(o.headers.get("authorization"), "Bearer desktop-token");
    assert.equal(o.headers.get("x-local-router-key"), null);
    return ok();
  });
  await (
    await f.send(
      {},
      {
        cookie: "session=private",
        authorization: "Bearer desktop-token",
        "chatgpt-account-id": "wrong",
        "x-openai-actor-authorization": "actor-secret",
      },
    )
  ).text();
});
test("previous response is pinned and never silently transferred across accounts", async (t) => {
  let requests = 0;
  const f = await fixture(t, () => (++requests === 1 ? ok("pinned") : quota()));
  await (await f.send()).text();
  assert.equal((await f.send({ previous_response_id: "pinned" })).status, 429);
  assert.deepEqual(
    f.calls.map((x) => x.account),
    ["id-a", "id-a"],
  );
  assert.equal((await f.send({ previous_response_id: "unknown" })).status, 409);
});
test("streamed failure is not replayed, subsequent full-input request can use next account", async (t) => {
  const f = await fixture(t, (_u, o) =>
    o.headers.get("ChatGPT-Account-Id") === "id-a"
      ? new Response(
          'data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached"}}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )
      : ok(),
  );
  assert.match(await (await f.send()).text(), /partial/);
  assert.equal(f.calls.length, 1);
  await (await f.send()).text();
  assert.deepEqual(
    f.calls.map((x) => x.account),
    ["id-a", "id-b"],
  );
});
test("concurrent token refresh happens once and saves rotated refresh token", async (t) => {
  const f = await fixture(t, () => ok(), { expire: true });
  let count = 0;
  const a = new Account({ name: "a", home: "a" }, f.root, async () => {
    count++;
    await new Promise((r) => setTimeout(r, 20));
    return Response.json({
      access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
      refresh_token: "rotated",
    });
  });
  const tokens = await Promise.all([a.token(), a.token(), a.token()]);
  assert.equal(count, 1);
  assert.ok(tokens.every((x) => x.refresh_token === "rotated"));
  assert.equal(
    JSON.parse(await readFile(join(f.root, "a", "auth.json"))).tokens
      .refresh_token,
    "rotated",
  );
});
test("refresh rejects a changed account identity", async (t) => {
  const f = await fixture(t, () => ok(), { expire: true });
  const a = new Account({ name: "a", home: "a" }, f.root, async () =>
    Response.json({
      access_token: jwt(
        Math.floor(Date.now() / 1000) + 3600,
        "another-account",
      ),
    }),
  );
  await assert.rejects(() => a.token(), /identity/);
});
test("transport failures are not replayed on another account", async (t) => {
  const f = await fixture(t, () => {
    throw new Error("network failed");
  });
  assert.equal((await f.send()).status, 502);
  assert.equal(f.calls.length, 1);
});
test("duplicate labels for one underlying account do not cause a second quota attempt", async (t) => {
  const f = await fixture(t, () => quota());
  await atomicJson(
    join(f.root, "b", "auth.json"),
    JSON.parse(await readFile(join(f.root, "a", "auth.json"))),
  );
  assert.equal((await f.send()).status, 429);
  assert.equal(f.calls.length, 1);
});
test("round robin spreads full-input requests when configured", async (t) => {
  const f = await fixture(t, () => ok(), { strategy: "round-robin" });
  for (let i = 0; i < 3; i++) await (await f.send()).text();
  assert.deepEqual(
    f.calls.map((x) => x.account),
    ["id-a", "id-b", "id-a"],
  );
});
test("unsupported paths cannot turn router into an arbitrary forward proxy", async (t) => {
  const f = await fixture(t, () => ok());
  const r = await fetch(f.base + "/v1/../../private", {
    headers: { "X-Local-Router-Key": KEY },
  });
  assert.equal(r.status, 404);
  assert.equal(f.calls.length, 0);
});
test("401 refreshes the same account once", async (t) => {
  let generationCalls = 0;
  const f = await fixture(t, (url) => {
    if (url.includes("/oauth/token"))
      return Response.json({
        access_token: jwt(Math.floor(Date.now() / 1000) + 7200),
        refresh_token: "renewed",
      });
    return ++generationCalls === 1 ? new Response("", { status: 401 }) : ok();
  });
  assert.equal((await f.send()).status, 200);
  assert.deepEqual(
    f.calls.map((x) => x.account),
    ["id-a", null, "id-a"],
  );
});

test("1% cutoff selects the next account before sending inference", async (t) => {
  const f = await fixture(t, () => ok());
  f.router.accounts[0].usage = {
    primary: { usedPercent: 99, resetsAt: Date.now() / 1000 + 3600 },
  };
  await (await f.send()).text();
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b"],
  );
});

test("Golu uses the last 1%, switches at 0%, and expired readings are unknown", async (t) => {
  const f = await fixture(t, () => ok());
  const golu = new Account(
    { name: "a", home: "a", label: "Golu", switchAtRemainingPercent: 0 },
    f.root,
  );
  assert.equal(golu.switchAtRemainingPercent, 0);
  f.router.accounts[0].switchAtRemainingPercent = golu.switchAtRemainingPercent;
  f.router.accounts[0].usage = {
    primary: { usedPercent: 99, resetsAt: Date.now() / 1000 + 3600 },
  };
  await (await f.send()).text();
  f.router.accounts[0].usage.primary.usedPercent = 100;
  await (await f.send()).text();
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-a", "id-b"],
  );
  golu.usage = {
    primary: { usedPercent: 100, resetsAt: Date.now() / 1000 - 1 },
  };
  assert.equal(accountPolicy(golu).remainingPercent, null);
  golu.usage = { primary: { usedPercent: 0 } };
  assert.equal(accountPolicy(golu).remainingPercent, 100);
});

test("usage parser preserves missing windows and rejects account mismatch", async (t) => {
  const f = await fixture(t, () => ok());
  let mismatch = false;
  const a = new Account({ name: "a", home: "a" }, f.root, async () =>
    Response.json({
      account_id: mismatch ? "id-b" : "id-a",
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 99,
          reset_at: 2000000000,
          limit_window_seconds: 18000,
        },
        secondary_window: null,
      },
      credits: { balance: "0", unlimited: false },
      rate_limit_reset_credits: { available_count: 1 },
    }),
  );
  assert.equal(await a.refreshUsage(), true);
  assert.equal(a.usage.primary.windowMinutes, 300);
  assert.equal(a.usage.secondary, undefined);
  assert.equal(accountPolicy(a).atThreshold, true);
  mismatch = true;
  assert.equal(await a.refreshUsage(), false);
  assert.match(a.usageError, /identity/);
  assert.equal(a.usage.primary.usedPercent, 99);
});

async function dashboardSession(base) {
  const response = await fetch(base + "/dashboard");
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}
test("dashboard isolates browser session from inference and rejects cross-site mutations", async (t) => {
  const f = await fixture(t, () => ok());
  assert.equal((await fetch(f.base + "/dashboard/api/status")).status, 401);
  const cookie = await dashboardSession(f.base);
  const status = await fetch(f.base + "/dashboard/api/status", {
    headers: { cookie },
  });
  const text = await status.text();
  assert.equal(status.status, 200);
  assert.doesNotMatch(text, /access_token|refresh_token|test-local-key/);
  assert.equal(
    (
      await fetch(f.base + "/v1/responses", {
        method: "POST",
        headers: { cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.base + "/dashboard/api/accounts", {
        method: "POST",
        headers: {
          cookie,
          origin: "https://example.com",
          "x-dashboard-request": "1",
        },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.base + "/dashboard/api/accounts", {
        method: "POST",
        headers: { cookie, origin: f.base },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});

test("new nicknames cannot inherit the existing Golu exception; duplicate identities are rejected", async (t) => {
  let duplicate = false;
  const f = await fixture(
    t,
    () =>
      Response.json({ rate_limit: { primary_window: { used_percent: 0 } } }),
    {
      loginRunner: ({ home, onUrl }) => {
        const accountId = duplicate ? "id-a" : "id-golu";
        onUrl("https://auth.openai.com/oauth/authorize?test=1");
        return {
          cancel() {},
          done: atomicJson(join(home, "auth.json"), {
            tokens: {
              account_id: accountId,
              access_token: jwt(Date.now() / 1000 + 3600, accountId),
              refresh_token: "fake-refresh",
            },
          }),
        };
      },
    },
  );
  const cookie = await dashboardSession(f.base);
  const post = (label) =>
    fetch(f.base + "/dashboard/api/accounts", {
      method: "POST",
      headers: {
        cookie,
        origin: f.base,
        "x-dashboard-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ label }),
    });
  const waitForLogin = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await (
        await fetch(f.base + "/dashboard/api/status", { headers: { cookie } })
      ).json();
      if (s.login.state !== "waiting") return s;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("Login did not finish");
  };
  assert.equal((await post("Golu")).status, 202);
  const added = await waitForLogin();
  assert.equal(added.login.state, "success");
  assert.equal(added.accounts.length, 3);
  assert.equal(added.accounts[2].policy.switchAtRemainingPercent, 1);
  const saved = JSON.parse(
    await readFile(join(f.root, "router.config.json"), "utf8"),
  );
  assert.equal(saved.accounts[2].switchAtRemainingPercent, 1);
  duplicate = true;
  assert.equal((await post("Duplicate")).status, 202);
  const denied = await waitForLogin();
  assert.equal(denied.login.state, "error");
  assert.match(denied.login.message, /already connected/);
  assert.equal(denied.accounts.length, 3);
});

test("saved fallback order preserves the current selection and account policies", async (t) => {
  const f = await fixture(t, () => ok());
  const cookie = await dashboardSession(f.base);
  const reorder = (names) =>
    fetch(f.base + "/dashboard/api/accounts/order", {
      method: "POST",
      headers: {
        cookie,
        origin: f.base,
        "x-dashboard-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ names }),
    });
  const original = f.router.accounts[0];
  original.switchAtRemainingPercent = 0;
  const response = await reorder(["b", "a"]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).nextAccount, "a");
  assert.equal(f.router.accounts[1], original);
  assert.equal(f.router.accounts[1].switchAtRemainingPercent, 0);
  await (await f.send()).text();
  assert.equal(f.calls.at(-1).account, "id-a");
  const saved = JSON.parse(
    await readFile(join(f.root, "router.config.json"), "utf8"),
  );
  assert.deepEqual(
    saved.accounts.map((a) => a.name),
    ["b", "a"],
  );
  const reloaded = await createRouter(saved, {
    root: f.root,
    key: KEY,
    persist: false,
  });
  assert.equal(reloaded.snapshot().nextAccount, "b");
  for (const bad of [["a", "a"], ["a"], ["b", "outsider"], null])
    assert.equal((await reorder(bad)).status, 400);
  assert.deepEqual(
    f.router.accounts.map((a) => a.name),
    ["b", "a"],
  );
  f.router.accounts[1].usage = { primary: { usedPercent: 100 } };
  await (await f.send()).text();
  assert.equal(f.calls.at(-1).account, "id-b");
});

test("reorder during an active response preserves its origin and selection", async (t) => {
  let release, started;
  const entered = new Promise((r) => {
    started = r;
  });
  const held = new Promise((r) => {
    release = r;
  });
  let count = 0;
  const f = await fixture(t, async () => {
    if (++count === 1) {
      started();
      await held;
    }
    return ok("origin-a");
  });
  const pending = f.send();
  await entered;
  const cookie = await dashboardSession(f.base);
  const response = await fetch(f.base + "/dashboard/api/accounts/order", {
    method: "POST",
    headers: { cookie, origin: f.base, "x-dashboard-request": "1" },
    body: JSON.stringify({ names: ["b", "a"] }),
  });
  assert.equal(response.status, 200);
  release();
  await (await pending).text();
  assert.equal(f.router.snapshot().nextAccount, "a");
  // A server-side response reference remains attached to the same Account object after reordering.
  await (await f.send({ previous_response_id: "origin-a" })).text();
  assert.equal(f.calls.at(-1).account, "id-a");
  await (await f.send()).text();
  assert.equal(f.calls.at(-1).account, "id-a");
});

async function dashboardPost(f) {
  const cookie = await dashboardSession(f.base);
  return (path, body) =>
    fetch(f.base + "/dashboard/api/" + path, {
      method: "POST",
      headers: {
        cookie,
        origin: f.base,
        "x-dashboard-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
}

test("latest manual selection routes new requests while A and B finish without reverting C", async (t) => {
  const entered = {},
    release = {},
    held = {};
  for (const id of ["id-a", "id-b"])
    held[id] = new Promise((r) => {
      release[id] = r;
    });
  const startedA = new Promise((r) => {
      entered["id-a"] = r;
    }),
    startedB = new Promise((r) => {
      entered["id-b"] = r;
    });
  const f = await fixture(
    t,
    async (_url, o) => {
      const id = o.headers.get("ChatGPT-Account-Id");
      entered[id]?.();
      if (held[id]) await held[id];
      return ok("origin-" + id);
    },
    { accountNames: ["a", "b", "c"] },
  );
  const post = await dashboardPost(f),
    requestA = f.send();
  await startedA;
  assert.equal((await post("accounts/select", { name: "b" })).status, 200);
  const requestB = f.send();
  await startedB;
  assert.equal((await post("accounts/select", { name: "c" })).status, 200);
  const requestC = await f.send();
  await requestC.text();
  assert.equal(requestC.headers.get("x-local-router-account"), "c");
  assert.equal(f.router.accounts[0].activeRequests, 1);
  assert.equal(f.router.accounts[1].activeRequests, 1);
  release["id-b"]();
  await (await requestB).text();
  release["id-a"]();
  await (await requestA).text();
  assert.equal(f.router.snapshot().selectedAccount, "c");
  assert.deepEqual(
    f.config.accounts.map((a) => a.name),
    ["a", "b", "c"],
  );
  const oldReference = await f.send({ previous_response_id: "origin-id-a" });
  assert.equal(oldReference.status, 409);
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-a", "id-b", "id-c"],
  );
});

test("a slow earlier selection cannot override the latest click or capture new requests", async (t) => {
  let releaseB, enterB;
  const heldB = new Promise((r) => {
      releaseB = r;
    }),
    startedB = new Promise((r) => {
      enterB = r;
    });
  const f = await fixture(
    t,
    async (url, o) => {
      if (url.endsWith("/usage")) {
        if (o.headers["ChatGPT-Account-Id"] === "id-b") {
          enterB();
          await heldB;
        }
        return Response.json(usagePayload());
      }
      return ok();
    },
    { persist: true, accountNames: ["a", "b", "c"] },
  );
  const post = await dashboardPost(f),
    first = post("accounts/select", { name: "b" });
  await startedB;
  await post("accounts/select", { name: "c" });
  await (await f.send()).text();
  assert.equal(
    f.calls.filter((c) => c.url.endsWith("/responses")).at(-1).account,
    "id-c",
  );
  releaseB();
  await first;
  assert.equal(f.router.snapshot().selectedAccount, "c");
});

test("selection during a pinned-context quota read never sends the new request to the old account", async (t) => {
  let hold = false,
    release,
    enter;
  const held = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      enter = r;
    });
  const f = await fixture(
    t,
    async (url, o) => {
      if (url.endsWith("/usage")) {
        if (hold && o.headers["ChatGPT-Account-Id"] === "id-a") {
          enter();
          await held;
        }
        return Response.json(usagePayload());
      }
      return ok("pinned-a");
    },
    { persist: true },
  );
  await (await f.send()).text();
  const a = f.router.accounts[0];
  a.usageUpdatedAt = 0;
  a.lastUsageAttempt = 0;
  hold = true;
  const pending = f.send({ previous_response_id: "pinned-a" });
  await started;
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  release();
  const rejected = await pending;
  assert.equal(rejected.status, 409);
  assert.match(await rejected.text(), /selected account changed/);
  assert.deepEqual(
    f.calls.filter((c) => c.url.endsWith("/responses")).map((c) => c.account),
    ["id-a"],
  );
  assert.equal(f.router.snapshot().selectedAccount, "b");
});

test("fallback rechecks an expired 5-hour window from priority one despite a saved weekly block", async (t) => {
  let cUsed = 0;
  const f = await fixture(
    t,
    (url, o) => {
      if (url.endsWith("/usage")) {
        const data = usagePayload();
        data.rate_limit.primary_window.used_percent =
          o.headers["ChatGPT-Account-Id"] === "id-c" ? cUsed : 10;
        data.rate_limit.secondary_window = {
          used_percent: 30,
          reset_at: Math.floor(Date.now() / 1000) + 604800,
          limit_window_seconds: 604800,
        };
        return Response.json(data);
      }
      return ok();
    },
    { persist: true, accountNames: ["a", "b", "c"] },
  );
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "c" });
  const a = f.router.accounts[0],
    c = f.router.accounts[2];
  a.usage = {
    primary: {
      usedPercent: 100,
      resetsAt: Date.now() / 1000 - 1,
      windowMinutes: 300,
    },
    secondary: {
      usedPercent: 30,
      resetsAt: Date.now() / 1000 + 604800,
      windowMinutes: 10080,
    },
  };
  a.blockedUntil = Date.now() + 604800000;
  a.reason = "allowance-exhausted";
  a.lastUsageAttempt = Date.now() - 2000;
  cUsed = 100;
  c.usage.primary.usedPercent = 100;
  c.usageUpdatedAt = Date.now();
  await (await f.send()).text();
  assert.equal(
    f.calls.filter((c) => c.url.endsWith("/responses")).at(-1).account,
    "id-a",
  );
  assert.equal(a.blockedUntil, 0);
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("recovered higher-priority allowance does not displace a usable manually selected account; selection survives restart", async (t) => {
  const f = await fixture(
    t,
    (url) => (url.endsWith("/usage") ? Response.json(usagePayload()) : ok()),
    { persist: true },
  );
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "b" });
  f.router.accounts[0].usage = {
    primary: { usedPercent: 0, resetsAt: Date.now() / 1000 + 18000 },
  };
  await post("accounts/order", { names: ["b", "a"] });
  await post("accounts/order", { names: ["a", "b"] });
  await (await f.send()).text();
  assert.equal(
    f.calls.filter((c) => c.url.endsWith("/responses")).at(-1).account,
    "id-b",
  );
  await f.router.flushed();
  const restored = await createRouter(f.config, {
    root: f.root,
    key: KEY,
    persist: true,
  });
  assert.equal(restored.snapshot().selectedAccount, "b");
  assert.equal(restored.snapshot().selectionSource, "manual");
});

test("Free/Go Astra fallback prefers listed 6.1 Sol and preserves every other desktop model choice", async (t) => {
  let catalog = ["gpt-6-sol", "gpt-6.1-sol"];
  const seen = [];
  const f = await fixture(t, (url, o) => {
    if (url.includes("/models?"))
      return Response.json({
        models: catalog.map((slug) => ({ slug, supported_in_api: true })),
      });
    seen.push(JSON.parse(o.body).model);
    return ok();
  });
  const a = f.router.accounts[0];
  a.profile.plan = "go";
  const r = await f.send({ model: "gpt-6-astra", input: [], stream: true });
  await r.text();
  assert.equal(r.headers.get("x-local-router-model"), "gpt-6.1-sol");
  catalog = ["gpt-6-sol"];
  a.modelCatalog = null;
  await (
    await f.send({ model: "gpt-6-astra", input: [], stream: true })
  ).text();
  await (await f.send({ model: "gpt-6-luna", input: [], stream: true })).text();
  a.profile.plan = "plus";
  await (
    await f.send({ model: "gpt-6-astra", input: [], stream: true })
  ).text();
  assert.deepEqual(seen, [
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6-astra",
  ]);
});

test("model fallback is recomputed from the desktop request after quota failover; access denials are not rotated", async (t) => {
  let deny = false;
  const seen = [];
  const f = await fixture(t, (url, o) => {
    if (url.includes("/models?")) return Response.json({ models: [] });
    seen.push([o.headers.get("ChatGPT-Account-Id"), JSON.parse(o.body).model]);
    if (deny)
      return new Response("Model unavailable for this plan", { status: 403 });
    return o.headers.get("ChatGPT-Account-Id") === "id-a" ? quota() : ok();
  });
  f.router.accounts[0].profile.plan = "free";
  f.router.accounts[1].profile.plan = "plus";
  await (
    await f.send({ model: "gpt-6-astra", input: [], stream: true })
  ).text();
  assert.deepEqual(seen, [
    ["id-a", "gpt-6-sol"],
    ["id-b", "gpt-6-astra"],
  ]);
  const a = f.router.accounts[0];
  a.blockedUntil = 0;
  a.reason = null;
  deny = true;
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "a" });
  assert.equal(
    (await f.send({ model: "gpt-6-astra", input: [], stream: true })).status,
    403,
  );
  assert.equal(seen.length, 3);
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("fresh reported plan takes precedence over older sign-in claims", async (t) => {
  const f = await fixture(t, () => ok());
  const path = join(f.root, "a", "auth.json");
  const data = JSON.parse(await readFile(path, "utf8"));
  data.tokens.id_token = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })).toString("base64url")}.s`;
  await atomicJson(path, data);
  const a = new Account({ name: "a", home: "a" }, f.root, async () =>
    Response.json({ plan_type: "pro", rate_limit: {} }),
  );
  await a.load();
  assert.equal(a.profile.plan, "plus");
  await a.refreshUsage();
  await a.load();
  assert.equal(a.profile.plan, "pro");
});

test("partial usage headers retain reset metadata and stale fetches cannot overwrite newer headers", async (t) => {
  const f = await fixture(t, () => ok());
  let finish,
    entered,
    calls = 0;
  const started = new Promise((r) => {
    entered = r;
  });
  const held = new Promise((r) => {
    finish = r;
  });
  const a = new Account({ name: "a", home: "a" }, f.root, async () => {
    calls++;
    entered();
    await held;
    return Response.json({
      rate_limit: { primary_window: { used_percent: 10 } },
    });
  });
  const reset = Math.floor(Date.now() / 1000) + 3600;
  a.usage = {
    primary: { usedPercent: 20, resetsAt: reset, windowMinutes: 300 },
  };
  const pending = a.refreshUsage();
  const coalesced = a.refreshUsage();
  await started;
  a.observe(new Headers({ "x-codex-primary-used-percent": "99" }));
  finish();
  assert.equal(await pending, true);
  await coalesced;
  assert.equal(calls, 1);
  assert.deepEqual(a.usage.primary, {
    usedPercent: 99,
    resetsAt: reset,
    windowMinutes: 300,
  });
  assert.equal(accountPolicy(a).atThreshold, true);
});

test("malformed usage leaves last reading intact; a confirmed reset clears a quota block", async (t) => {
  const f = await fixture(t, () => ok());
  let data = null;
  const a = new Account({ name: "a", home: "a" }, f.root, async () =>
    Response.json(data),
  );
  a.usage = { primary: { usedPercent: 99 } };
  assert.equal(await a.refreshUsage(), false);
  assert.equal(a.usage.primary.usedPercent, 99);
  data = { rate_limit: { primary_window: { used_percent: "not-a-number" } } };
  assert.equal(await a.refreshUsage(), false);
  assert.equal(a.usage.primary.usedPercent, 99);
  a.block(new Headers(), {});
  data = { rate_limit: { allowed: true, primary_window: { used_percent: 5 } } };
  assert.equal(await a.refreshUsage(), true);
  assert.equal(a.blockedUntil, 0);
  assert.equal(a.reason, null);
});

test("unused header windows never become a phantom 100% allowance; explicit absent windows clear old metadata", async (t) => {
  const f = await fixture(t, () => ok()),
    a = f.router.accounts[0];
  a.observe(
    new Headers({
      "x-codex-primary-used-percent": "59",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-secondary-used-percent": "0",
    }),
  );
  assert.equal(a.usage.secondary, undefined);
  assert.equal(a.usage.primary.windowMinutes, 10080);
  a.usage.secondary = {
    usedPercent: 30,
    windowMinutes: 300,
    resetsAt: Date.now() / 1000 + 3600,
  };
  a.observe(
    new Headers({
      "x-codex-secondary-used-percent": "0",
      "x-codex-secondary-window-minutes": "0",
      "x-codex-secondary-reset-at": "0",
    }),
  );
  assert.equal(a.usage.secondary, undefined);
  a.observe(new Headers({ "x-codex-secondary-used-percent": "99" }));
  assert.equal(a.usage.secondary.usedPercent, 99);
  assert.equal(accountPolicy(a).atThreshold, true);
});

test("restart preserves the latest reported plan and drops a saved unused header window", async (t) => {
  const f = await fixture(t, () => ok(), { persist: true });
  const a = f.router.accounts[0];
  a.profile.plan = "pro";
  a.usage = {
    primary: { usedPercent: 30, windowMinutes: 10080 },
    secondary: { usedPercent: 0, resetsAt: null, windowMinutes: null },
  };
  a.benefits.details = {
    availableCount: 1,
    credits: [{ id: "retained-reset", expiresAt: Date.now() / 1000 + 86400 }],
    updatedAt: Date.now(),
    error: null,
  };
  const post = await dashboardPost(f);
  await post("accounts/order", { names: ["b", "a"] });
  await f.router.flushed();
  const restored = await createRouter(f.config, {
    root: f.root,
    key: KEY,
    persist: true,
  });
  const loaded = restored.accounts.find((a) => a.name === "a");
  assert.equal(loaded.profile.plan, "pro");
  assert.equal(loaded.usage.secondary, undefined);
  assert.equal(loaded.benefits.view().credits[0].id, "retained-reset");
});

test("invalid saved state stops startup and preserves the original file", async (t) => {
  const f = await fixture(t, () => ok());
  const path = join(f.root, ".runtime/state.json");
  await atomicJson(path, { accounts: "broken" });
  const before = await readFile(path, "utf8");
  await assert.rejects(
    createRouter(f.config, { root: f.root, key: KEY, persist: true }),
    /Saved router state could not be read/,
  );
  assert.equal(await readFile(path, "utf8"), before);
});

test("network failure after a renewed 401 request never replays on another account", async (t) => {
  let attempts = 0;
  const f = await fixture(t, (url) => {
    if (url.includes("/oauth/token"))
      return Response.json({ access_token: jwt(Date.now() / 1000 + 7200) });
    if (++attempts === 1) return new Response("", { status: 401 });
    throw new Error("connection lost after send");
  });
  assert.equal((await f.send()).status, 502);
  assert.equal(attempts, 2);
  assert.ok(f.calls.every((call) => call.account !== "id-b"));
});

test("multiline and unterminated SSE events retain origin and quota failure", async (t) => {
  const f = await fixture(
    t,
    () =>
      new Response(
        'data: {"type":"response.failed",\ndata: "response":{"id":"final-ref","error":{"code":"usage_limit_reached"}}}',
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  await (await f.send()).text();
  assert.ok(f.router.accounts[0].blockedUntil > Date.now());
  assert.equal(
    (await f.send({ previous_response_id: "final-ref" })).status,
    429,
  );
  assert.equal(f.calls.length, 1);
  assert.match(f.router.snapshot().events[0].message, /failed/);
});

test("stream activity extends idle timeout; a stalled stream is aborted without replay", async (t) => {
  let stalled = false;
  const f = await fixture(
    t,
    (_url, options) =>
      new Response(
        new ReadableStream({
          start(controller) {
            let count = 0;
            const timer = setInterval(() => {
              if (stalled) return;
              if (++count === 7) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.completed"}\n\n',
                  ),
                );
                clearInterval(timer);
                controller.close();
              } else
                controller.enqueue(
                  new TextEncoder().encode(": still working\n\n"),
                );
            }, 40);
            options.signal.addEventListener(
              "abort",
              () => {
                clearInterval(timer);
                controller.error(new Error("idle"));
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    { idleTimeoutMs: 160 },
  );
  assert.match(await (await f.send()).text(), /response.completed/);
  stalled = true;
  await assert.rejects(async () => {
    await (await f.send()).text();
  });
  assert.equal(f.calls.length, 2);
});

test("shutdown waits for active responses and saves state before completing", async (t) => {
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const held = new Promise((r) => {
    release = r;
  });
  const f = await fixture(t, async () => {
    entered();
    await held;
    return ok("drained");
  });
  const pending = f.send();
  await started;
  assert.equal(
    (await fetch(f.base + "/admin/shutdown", { method: "POST" })).status,
    403,
  );
  const stop = await fetch(f.base + "/admin/shutdown", {
    method: "POST",
    headers: { "X-Local-Router-Key": KEY },
  });
  assert.equal(stop.status, 202);
  await stop.text();
  assert.equal(f.router.snapshot().draining, true);
  let stopped = false;
  const draining = f.router.drain().then(() => {
    stopped = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(stopped, false);
  release();
  assert.match(await (await pending).text(), /drained/);
  await draining;
  assert.equal(f.router.snapshot().inFlight, 0);
});

test("response origins and credential identities survive restart", async (t) => {
  const usage = () =>
    Response.json({
      rate_limit: { allowed: true, primary_window: { used_percent: 1 } },
    });
  const f = await fixture(
    t,
    (url) => (url.endsWith("/usage") ? usage() : ok("saved-ref")),
    { persist: true },
  );
  await (await f.send()).text();
  await f.router.drain();
  const calls = [];
  const resumed = await createRouter(f.config, {
    root: f.root,
    key: KEY,
    fetcher: async (url, options) => {
      calls.push(options.headers?.get?.("ChatGPT-Account-Id"));
      return url.endsWith("/usage") ? usage() : ok();
    },
  });
  resumed.server.listen(0, "127.0.0.1");
  await once(resumed.server, "listening");
  const base = `http://127.0.0.1:${resumed.server.address().port}`;
  try {
    const r = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "X-Local-Router-Key": KEY },
      body: JSON.stringify({ previous_response_id: "saved-ref" }),
    });
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(calls.at(-1), "id-a");
    await atomicJson(
      join(f.root, "a", "auth.json"),
      JSON.parse(await readFile(join(f.root, "b", "auth.json"))),
    );
    const refused = await fetch(base + "/v1/responses", {
      method: "POST",
      headers: { "X-Local-Router-Key": KEY },
      body: JSON.stringify({ previous_response_id: "saved-ref" }),
    });
    assert.equal(refused.status, 503);
    assert.equal(calls.length, 1);
    assert.equal(resumed.accounts[0].reason, "identity-changed");
  } finally {
    await resumed.drain();
  }
});

test("simultaneous add-account clicks launch only one sign-in; shutdown protects the pending login", async (t) => {
  let rejectLogin,
    count = 0;
  const f = await fixture(t, () => ok(), {
    loginRunner: () => {
      count++;
      return {
        done: new Promise((_r, reject) => {
          rejectLogin = reject;
        }),
        cancel() {
          rejectLogin(new Error("cancelled"));
        },
      };
    },
  });
  const cookie = await dashboardSession(f.base);
  const headers = { cookie, origin: f.base, "x-dashboard-request": "1" };
  const post = (path) =>
    fetch(f.base + "/dashboard/api/" + path, {
      method: "POST",
      headers,
      body: "{}",
    });
  const results = await Promise.all([post("accounts"), post("accounts")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 400]);
  assert.equal(count, 1);
  assert.equal(
    (
      await fetch(f.base + "/admin/shutdown", {
        method: "POST",
        headers: { "X-Local-Router-Key": KEY },
      })
    ).status,
    409,
  );
  await (await post("login/cancel")).text();
});

test("invalid configuration and non-object request bodies fail before upstream access", async (t) => {
  const f = await fixture(t, () => ok());
  for (const body of [null, [], 42, "text"])
    assert.equal((await f.send(body)).status, 400);
  assert.equal(f.calls.length, 0);
  for (const accounts of [
    [{ name: "a", home: "../escape" }],
    [
      { name: "a", home: "a" },
      { name: "b", home: "a" },
    ],
    [{ name: "a", home: "a", switchAtRemainingPercent: -1 }],
    [{ name: "a", home: "a", enabled: "false" }],
  ]) {
    await assert.rejects(() =>
      createRouter(
        { strategy: "exhaust-first", accounts },
        { key: KEY, root: f.root, persist: false },
      ),
    );
  }
});
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Expected router state was not reached");
}
async function goluFixture(
  t,
  { held = false, failFirst = false, credits = true } = {},
) {
  let percent = 20,
    finishStream,
    failed = false;
  const redeemed = new Set(),
    redemptions = [];
  const handler = async (url, o) => {
    const id =
      o.headers instanceof Headers
        ? o.headers.get("ChatGPT-Account-Id")
        : o.headers["ChatGPT-Account-Id"];
    if (url.endsWith("/usage")) {
      const d = usagePayload();
      d.rate_limit.primary_window.used_percent =
        id === "id-account-4" ? percent : 0;
      d.rate_limit.allowed = d.rate_limit.primary_window.used_percent < 100;
      d.rate_limit.limit_reached = !d.rate_limit.allowed;
      return Response.json(d);
    }
    if (url.endsWith("/consume")) {
      const body = JSON.parse(o.body);
      redemptions.push({ id, ...body });
      assert.equal(id, "id-account-4");
      percent = 0;
      redeemed.add(body.credit_id);
      if (failFirst && !failed) {
        failed = true;
        throw new Error("Connection lost after accepting reset");
      }
      return Response.json({ code: failFirst ? "already_redeemed" : "reset" });
    }
    if (url.includes("rate-limit-reset-credits"))
      return Response.json({
        available_count: credits ? 3 : 0,
        credits: credits
          ? [
              {
                id: "later",
                expires_at: new Date(Date.now() + 864000000).toISOString(),
              },
              { id: "never", expires_at: null },
              {
                id: "earliest",
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
              {
                id: "expired",
                expires_at: new Date(Date.now() - 86400000).toISOString(),
              },
              {
                id: "unsupported",
                expires_at: new Date(Date.now() + 1000).toISOString(),
                is_supported_by_plan: false,
              },
            ]
              .filter((c) => !redeemed.has(c.id))
              .map((c) => ({ ...resetDetails().credits[0], ...c }))
          : [],
      });
    if (held && id === "id-account-4") {
      percent = 100;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.created","response":{"id":"golu-held"}}\n\n',
              ),
            );
            finishStream = () => {
              c.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.completed","response":{"id":"golu-held"}}\n\n',
                ),
              );
              c.close();
            };
          },
        }),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": String(
              Math.floor(Date.now() / 1000) + 18000,
            ),
          },
        },
      );
    }
    return ok();
  };
  const f = await fixture(t, handler, {
    persist: true,
    accountNames: ["a", "account-4", "b"],
  });
  const post = await dashboardPost(f);
  await post("accounts/select", { name: "account-4" });
  return {
    ...f,
    post,
    handler,
    redemptions,
    finish: () => finishStream(),
    exhaust: () => {
      percent = 100;
      const a = f.router.accounts[1];
      a.usage.primary.usedPercent = 100;
      a.usageUpdatedAt = Date.now();
    },
    recover: () => {
      percent = 0;
    },
  };
}

test("Golu exhaustion switches to priority one without redeeming any reset, including after old streams finish", async (t) => {
  const f = await goluFixture(t, { held: true }),
    g = f.router.accounts[1];
  const old = await f.send();
  try {
    const newer = await f.send();
    await newer.text();
    assert.equal(newer.headers.get("x-local-router-account"), "a");
    assert.equal(g.activeRequests, 1);
    assert.equal(f.redemptions.length, 0);
    assert.equal(f.router.snapshot().selectedAccount, "a");
    assert.equal(
      f.router.snapshot().accounts.find((a) => a.name === "account-4")
        .automaticReset,
      undefined,
    );
  } finally {
    f.finish();
    await old.text();
  }
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      await (await f.send()).text();
    }),
  );
  assert.equal(f.redemptions.length, 0);
  assert.equal(g.usage.primary.usedPercent, 100);
  assert.deepEqual(
    f.config.accounts.map((a) => a.name),
    ["a", "account-4", "b"],
  );
  const unconfirmed = await f.post("accounts/use-reset", {
    name: "account-4",
    creditId: "earliest",
  });
  assert.equal(unconfirmed.status, 400);
  assert.equal(f.redemptions.length, 0);
  const manual = await f.post("accounts/use-reset", {
    name: "account-4",
    creditId: "earliest",
    confirmed: true,
  });
  assert.equal(manual.status, 200);
  assert.equal(f.redemptions.length, 1);
  assert.equal(f.redemptions[0].credit_id, "earliest");
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("legacy automatic jobs never resume; pending reset history is retained for explicit manual retry", async (t) => {
  const f = await goluFixture(t);
  f.exhaust();
  await (await f.send()).text();
  await f.router.drain();
  await f.router.flushed();
  const statePath = join(f.root, ".runtime/state.json"),
    saved = JSON.parse(await readFile(statePath, "utf8"));
  const identity = f.router.accounts[1].accountIdentity;
  saved.goluAutoReset = {
    identity,
    armed: false,
    waitingForReplacement: false,
    job: {
      id: "12345678-1234-1234-1234-123456789abc",
      createdAt: Date.now(),
      replacement: "a",
      attempts: 1,
      status: "retry",
    },
  };
  await atomicJson(statePath, saved);
  const pending = {
    creditId: "earliest",
    key: "retained-idempotency-key",
    identity,
    outcome: null,
    startedAt: Date.now(),
    operationId: saved.goluAutoReset.job.id,
    source: "golu-auto",
  };
  const journalPath = join(f.root, ".runtime/reset-attempts/account-4.json");
  await atomicJson(journalPath, { attempts: [pending] });
  const before = await readFile(journalPath, "utf8");
  const restored = await createRouter(f.config, {
    root: f.root,
    key: KEY,
    persist: true,
    fetcher: f.handler,
    connectionRunner: async () => ({
      wired: true,
      provider: "local_paid_accounts",
    }),
  });
  restored.server.listen(0, "127.0.0.1");
  await once(restored.server, "listening");
  try {
    assert.equal(restored.snapshot().goluAutoReset, undefined);
    assert.equal(f.redemptions.length, 0);
    assert.equal(
      restored.accounts[1].benefits.view().pendingCreditId,
      "earliest",
    );
    assert.equal(await readFile(journalPath, "utf8"), before);
    const base = `http://127.0.0.1:${restored.server.address().port}`,
      cookie = await dashboardSession(base);
    const response = await fetch(base + "/dashboard/api/accounts/use-reset", {
      method: "POST",
      headers: {
        cookie,
        origin: base,
        "x-dashboard-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "account-4",
        creditId: "earliest",
        confirmed: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(f.redemptions.length, 1);
    assert.equal(f.redemptions[0].redeem_request_id, pending.key);
    assert.equal(f.redemptions[0].credit_id, pending.creditId);
  } finally {
    await restored.drain();
    await restored.flushed();
  }
});

test("Drain routes fallback traffic immediately, waits for old streams, then restores ahead of recurring", async (t) => {
  const f = await goluFixture(t, { held: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  await f.post("accounts/recurring", { name: "a", enabled: true });
  assert.equal(f.router.snapshot().selectedAccount, "account-4");
  const stream = await f.send();
  await until(() => f.router.snapshot().selectedAccount === "a");
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "waiting");
  const fallback = await Promise.all(Array.from({ length: 5 }, () => f.send()));
  for (const response of fallback) {
    assert.equal(response.headers.get("x-local-router-account"), "a");
    await response.text();
  }
  assert.equal(f.redemptions.length, 0);
  const manual = await f.post("accounts/use-reset", {
    name: "account-4",
    creditId: "earliest",
    confirmed: true,
  });
  assert.notEqual(manual.status, 200);
  f.finish();
  assert.match(await stream.text(), /response.completed/);
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 1);
  assert.equal(f.redemptions[0].credit_id, "earliest");
  assert.equal(f.router.snapshot().selectedAccount, "account-4");
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "active");
});

test("Drain repeats earliest-expiry resets then resumes usual routing when depleted", async (t) => {
  const f = await goluFixture(t);
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  for (const credit of ["earliest", "later", "never"]) {
    f.exhaust();
    f.router.drainUse.inspect();
    await until(() => !f.router.drainUse.job);
    assert.equal(f.redemptions.at(-1).credit_id, credit);
    assert.equal(f.router.snapshot().selectedAccount, "account-4");
  }
  f.exhaust();
  f.router.drainUse.inspect();
  await until(
    () => !f.router.drainUse.job && f.router.snapshot().selectedAccount === "a",
  );
  assert.equal(f.redemptions.length, 3);
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "depleted");
  const saved = JSON.parse(
    await readFile(join(f.root, "router.config.json"), "utf8"),
  );
  assert.equal(saved.accounts[1].drainEnabled, true);
  assert.deepEqual(
    saved.accounts.map((a) => a.name),
    ["a", "account-4", "b"],
  );
});

test("Arming Drain never selects or consumes an unselected exhausted account", async (t) => {
  const f = await goluFixture(t);
  await f.post("accounts/select", { name: "b" });
  f.exhaust();
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  assert.equal(f.router.snapshot().selectedAccount, "b");
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "armed");
  assert.equal(f.redemptions.length, 0);
  assert.equal(
    (await f.post("accounts/drain", { name: "account-4", enabled: "true" }))
      .status,
    400,
  );
});

test("Manual selection cancels automatic return and an unsent Drain reset", async (t) => {
  const f = await goluFixture(t, { held: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  const response = await f.send();
  await until(() => !!f.router.drainUse.job);
  await f.post("accounts/select", { name: "b" });
  f.finish();
  await response.text();
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 0);
  assert.equal(f.router.snapshot().selectedAccount, "b");
});

test("Unconfirmed Drain reset pauses durably without spending another credit", async (t) => {
  const f = await goluFixture(t, { failFirst: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  f.exhaust();
  f.router.drainUse.inspect();
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 1);
  assert.equal(f.router.snapshot().selectedAccount, "a");
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "paused");
  await f.router.flushed();
  const restart = await createRouter(f.config, {
    root: f.root,
    key: KEY,
    fetcher: f.handler,
  });
  await restart.recurring.stop();
  restart.drainUse.inspect();
  assert.equal(restart.snapshot().accounts[1].drainStatus.phase, "paused");
  assert.equal(restart.accounts[1].benefits.view().pendingCreditId, "earliest");
  assert.equal(f.redemptions.length, 1);
  await restart.drainUse.stop();
  await restart.flushed();
});

test("Drain overrides the normal 1% cutoff only when enabled", async (t) => {
  const f = await goluFixture(t);
  const a = f.router.accounts[1];
  a.switchAtRemainingPercent = 1;
  a.usage.primary.usedPercent = 99.5;
  assert.equal(accountPolicy(a).atThreshold, true);
  await f.post("accounts/drain", { name: a.name, enabled: true });
  assert.equal(accountPolicy(a).atThreshold, false);
  assert.equal(f.router.snapshot().selectedAccount, a.name);
  assert.equal(f.redemptions.length, 0);
  await f.post("accounts/drain", { name: a.name, enabled: false });
  assert.equal(accountPolicy(a).atThreshold, true);
});

test("Turning Drain off during an active stream cancels its reset", async (t) => {
  const f = await goluFixture(t, { held: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  const response = await f.send();
  await until(() => !!f.router.drainUse.job);
  await f.post("accounts/drain", { name: "account-4", enabled: false });
  f.finish();
  await response.text();
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 0);
  assert.equal(f.router.snapshot().selectedAccount, "a");
});

test("Manual selection during a submitted reset keeps the newer account selected", async (t) => {
  const f = await goluFixture(t);
  const a = f.router.accounts[1],
    original = a.fetcher;
  let release,
    submitted = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  a.fetcher = async (url, options) => {
    if (url.endsWith("/consume")) {
      submitted = true;
      await gate;
    }
    return original(url, options);
  };
  await f.post("accounts/drain", { name: a.name, enabled: true });
  f.exhaust();
  f.router.drainUse.inspect();
  await until(() => submitted);
  await f.post("accounts/select", { name: "b" });
  release();
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 1);
  assert.equal(f.router.snapshot().selectedAccount, "b");
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "paused");
});

test("A reset that leaves zero usage never burns the next credit", async (t) => {
  const f = await goluFixture(t);
  const a = f.router.accounts[1],
    original = a.fetcher;
  a.fetcher = async (url, options) => {
    const response = await original(url, options);
    if (url.endsWith("/consume")) f.exhaust();
    return response;
  };
  await f.post("accounts/drain", { name: a.name, enabled: true });
  f.exhaust();
  f.router.drainUse.inspect();
  await until(() => !f.router.drainUse.job);
  for (let i = 0; i < 5; i++) f.router.drainUse.inspect();
  assert.equal(f.redemptions.length, 1);
  assert.equal(f.router.snapshot().selectedAccount, "a");
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "paused");
});

test("Drain takes precedence over Sol-on-Free routing without changing account priority", async (t) => {
  const f = await goluFixture(t);
  f.router.accounts[0].profile.plan = "free";
  await f.post("settings/free-sol", { enabled: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  const response = await f.send({
    model: "gpt-6-sol",
    input: [],
    stream: true,
  });
  assert.equal(response.headers.get("x-local-router-account"), "account-4");
  assert.equal(response.headers.get("x-local-router-route"), "drain");
  await response.text();
  assert.deepEqual(
    f.router.accounts.map((a) => a.name),
    ["a", "account-4", "b"],
  );
});

test("Drain can reset and return when no fallback account is ready", async (t) => {
  const f = await goluFixture(t, { held: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  for (const a of f.router.accounts.filter((a) => a.name !== "account-4")) {
    a.usage = {
      primary: {
        usedPercent: 100,
        resetsAt: Date.now() / 1000 + 18000,
        windowMinutes: 300,
      },
    };
    a.usageUpdatedAt = a.lastUsageAttempt = Date.now();
  }
  const stream = await f.send();
  await until(() => f.router.snapshot().selectedAccount === null);
  const unavailable = await f.send();
  assert.equal(unavailable.status, 429);
  await unavailable.text();
  f.finish();
  await stream.text();
  await until(() => !f.router.drainUse.job);
  assert.equal(f.router.snapshot().selectedAccount, "account-4");
  assert.equal(f.redemptions.length, 1);
});

test("Shutdown cancels a waiting Drain reset without interrupting its active stream", async (t) => {
  const f = await goluFixture(t, { held: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  const stream = await f.send();
  await until(() => !!f.router.drainUse.job);
  const stopped = f.router.drain();
  f.finish();
  assert.match(await stream.text(), /response.completed/);
  await stopped;
  assert.equal(f.redemptions.length, 0);
});

async function waitForSignIn(base, cookie) {
  for (let i = 0; i < 200; i++) {
    const status = await (
      await fetch(base + "/dashboard/api/status", { headers: { cookie } })
    ).json();
    if (!status.loginBusy && status.login.state !== "waiting") return status;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Sign-in did not settle");
}

test("account off persists through reordering and restart, and all-off requests explain how to resume", async (t) => {
  const f = await fixture(t, () => ok());
  const post = await dashboardPost(f);
  assert.equal(f.router.snapshot().accounts[0].enabled, true);
  for (const input of [
    { name: "a", enabled: "false" },
    { name: "missing", enabled: false },
  ])
    assert.equal((await post("accounts/enabled", input)).status, 400);
  const disabled = await post("accounts/enabled", {
    name: "a",
    enabled: false,
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).selectedAccount, "b");
  assert.equal((await post("accounts/select", { name: "a" })).status, 400);
  const routed = await f.send();
  assert.equal(routed.headers.get("x-local-router-account"), "b");
  await routed.text();
  await post("accounts/enabled", { name: "b", enabled: false });
  await post("accounts/order", { names: ["b", "a"] });
  const before = f.calls.length;
  const unavailable = await f.send();
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, "accounts_disabled");
  assert.equal(f.calls.length, before);
  const saved = JSON.parse(
    await readFile(join(f.root, "router.config.json"), "utf8"),
  );
  const restored = await createRouter(saved, {
    root: f.root,
    key: KEY,
    persist: false,
  });
  assert.deepEqual(
    restored.snapshot().accounts.map((a) => [a.name, a.enabled]),
    [
      ["b", false],
      ["a", false],
    ],
  );
  assert.equal(restored.snapshot().selectedAccount, null);
  await restored.recurring.stop();
  await restored.drainUse.stop();
  const resumed = await post("accounts/enabled", { name: "b", enabled: true });
  assert.equal((await resumed.json()).selectedAccount, "b");
  const response = await f.send();
  assert.equal(response.headers.get("x-local-router-account"), "b");
  await response.text();
});

test("turning off an active account preserves its stream and rejects new pinned context", async (t) => {
  let finish;
  const f = await fixture(t, (_url, options) => {
    if (options.headers.get("ChatGPT-Account-Id") !== "id-a")
      return ok("b-response");
    return new Response(
      new ReadableStream({
        start(controller) {
          const encode = (type) =>
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type, response: { id: "held-a" } })}\n\n`,
            );
          controller.enqueue(encode("response.created"));
          finish = () => {
            controller.enqueue(encode("response.completed"));
            controller.close();
          };
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  const stream = await f.send();
  const post = await dashboardPost(f);
  await post("accounts/enabled", { name: "a", enabled: false });
  assert.equal(f.router.accounts[0].activeRequests, 1);
  const newRequest = await f.send();
  assert.equal(newRequest.headers.get("x-local-router-account"), "b");
  await newRequest.text();
  const pinned = await f.send({
    model: "test",
    previous_response_id: "held-a",
  });
  assert.equal(pinned.status, 409);
  assert.equal((await pinned.json()).error.code, "context_requires_full_input");
  finish();
  assert.match(await stream.text(), /response.completed/);
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-a", "id-b"],
  );
});

test("disabling during credential preparation reselects before upstream dispatch", async (t) => {
  const f = await fixture(t, () => ok());
  let release, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const gate = new Promise((r) => {
    release = r;
  });
  const account = f.router.accounts[0],
    token = account.token.bind(account);
  account.token = async (...args) => {
    entered();
    await gate;
    return token(...args);
  };
  const pending = f.send();
  await started;
  const post = await dashboardPost(f);
  await post("accounts/enabled", { name: "a", enabled: false });
  release();
  const response = await pending;
  assert.equal(response.headers.get("x-local-router-account"), "b");
  await response.text();
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-b"],
  );
});

test("off accounts are excluded from recurring monitoring and Free model priority, retaining both settings", async (t) => {
  const f = await fixture(
    t,
    (url) => (url.endsWith("/usage") ? Response.json(usagePayload()) : ok()),
    { accountNames: ["a", "b", "c"] },
  );
  setPlans(f, ["free", "free", "plus"]);
  const post = await dashboardPost(f);
  await post("accounts/recurring", { name: "a", enabled: true });
  await post("accounts/recurring", { name: "b", enabled: true });
  await post("accounts/enabled", { name: "a", enabled: false });
  assert.equal(f.router.snapshot().selectedAccount, "b");
  const free = await f.send({ model: "gpt-6-sol" });
  assert.equal(free.headers.get("x-local-router-account"), "b");
  await free.text();
  await post("accounts/enabled", { name: "b", enabled: false });
  for (const account of f.router.accounts.slice(0, 2)) {
    account.usageUpdatedAt = account.lastUsageAttempt = 0;
    assert.equal(account.recurringUse, true);
  }
  f.calls.length = 0;
  await f.router.recurring.refreshDue();
  const fallback = await f.send({ model: "gpt-6-sol" });
  assert.equal(fallback.headers.get("x-local-router-account"), "c");
  await fallback.text();
  assert.deepEqual(
    f.calls.map((c) => c.account),
    ["id-c"],
  );
  await post("accounts/enabled", { name: "a", enabled: true });
  assert.equal(f.router.snapshot().selectedAccount, "a");
  assert.equal(f.router.snapshot().selectionSource, "recurring");
});

test("account off cancels an unsent Drain reset while its active stream finishes", async (t) => {
  const f = await goluFixture(t, { held: true });
  await f.post("accounts/drain", { name: "account-4", enabled: true });
  const stream = await f.send();
  await until(() => !!f.router.drainUse.job);
  await f.post("accounts/enabled", { name: "account-4", enabled: false });
  assert.equal(f.router.snapshot().selectedAccount, "a");
  f.finish();
  assert.match(await stream.text(), /response.completed/);
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 0);
  assert.equal(f.router.snapshot().accounts[1].drainEnabled, true);
  assert.equal(f.router.snapshot().accounts[1].drainStatus.phase, "disabled");
});

test("account off during a submitted Drain reset prevents automatic return", async (t) => {
  const f = await goluFixture(t);
  const account = f.router.accounts[1],
    original = account.fetcher;
  let release,
    submitted = false;
  const gate = new Promise((r) => {
    release = r;
  });
  account.fetcher = async (url, options) => {
    if (url.endsWith("/consume")) {
      submitted = true;
      await gate;
    }
    return original(url, options);
  };
  await f.post("accounts/drain", { name: account.name, enabled: true });
  f.exhaust();
  f.router.drainUse.inspect();
  await until(() => submitted);
  await f.post("accounts/enabled", { name: account.name, enabled: false });
  release();
  await until(() => !f.router.drainUse.job);
  assert.equal(f.redemptions.length, 1);
  assert.equal(f.router.snapshot().selectedAccount, "a");
  assert.equal(f.router.snapshot().accounts[1].enabled, false);
});

test("re-sign-in replaces credentials in place, preserves policy and rejects another identity", async (t) => {
  let identity = "id-a";
  let staging;
  const f = await fixture(
    t,
    () =>
      Response.json({
        rate_limit: {
          allowed: true,
          primary_window: { used_percent: 20, limit_window_seconds: 18000 },
        },
      }),
    {
      loginRunner: ({ home }) => {
        staging = home;
        return {
          cancel() {},
          done: atomicJson(join(home, "auth.json"), {
            tokens: {
              account_id: identity,
              access_token: jwt(Date.now() / 1000 + 7200, identity),
              refresh_token: "renewed-session",
            },
          }),
        };
      },
    },
  );
  const a = f.router.accounts[0];
  a.recurringUse = true;
  a.drainEnabled = true;
  a.switchAtRemainingPercent = 0;
  a.reason = "sign-in-required";
  const specs = JSON.stringify(f.config.accounts);
  const cookie = await dashboardSession(f.base);
  const post = (name) =>
    fetch(f.base + "/dashboard/api/accounts/reauth", {
      method: "POST",
      headers: {
        cookie,
        origin: f.base,
        "x-dashboard-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    });
  assert.equal((await post("missing")).status, 400);
  assert.equal((await post("a")).status, 202);
  await f.router.flushed();
  let status = await waitForSignIn(f.base, cookie);
  assert.equal(status.login.state, "success");
  assert.equal(status.login.replacing, true);
  assert.equal(f.router.accounts.length, 2);
  assert.equal(f.router.accounts[0], a);
  assert.equal(JSON.stringify(f.config.accounts), specs);
  assert.equal(a.recurringUse, true);
  assert.equal(a.drainEnabled, true);
  assert.equal(a.switchAtRemainingPercent, 0);
  assert.equal(a.reason, null);
  assert.equal((await a.load()).tokens.refresh_token, "renewed-session");
  await assert.rejects(readFile(join(staging, "auth.json")), {
    code: "ENOENT",
  });
  const before = await readFile(a.path, "utf8");
  identity = "id-b";
  assert.equal((await post("a")).status, 202);
  await f.router.flushed();
  status = await waitForSignIn(f.base, cookie);
  assert.equal(status.login.state, "error");
  assert.match(status.login.message, /same account/);
  assert.equal(await readFile(a.path, "utf8"), before);
  await assert.rejects(readFile(join(staging, "auth.json")), {
    code: "ENOENT",
  });
});

test("cancelled re-sign-in and overlapping login leave original credentials untouched", async (t) => {
  let finish;
  let staging;
  const f = await fixture(t, () => ok(), {
    loginRunner: ({ home }) => {
      staging = home;
      return {
        cancel() {
          finish();
        },
        done: new Promise((resolve) => {
          finish = resolve;
        }),
      };
    },
  });
  const before = await readFile(f.router.accounts[0].path, "utf8");
  const cookie = await dashboardSession(f.base);
  const post = (path, body = {}) =>
    fetch(f.base + "/dashboard/api/" + path, {
      method: "POST",
      headers: {
        cookie,
        origin: f.base,
        "x-dashboard-request": "1",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("accounts/reauth", { name: "a" })).status, 202);
  assert.equal((await post("accounts/reauth", { name: "b" })).status, 400);
  assert.equal((await post("accounts")).status, 400);
  await atomicJson(join(staging, "auth.json"), {
    tokens: {
      account_id: "id-a",
      access_token: jwt(Date.now() / 1000 + 7200),
      refresh_token: "cancelled",
    },
  });
  await post("login/cancel");
  await waitForSignIn(f.base, cookie);
  await f.router.flushed();
  assert.equal(await readFile(f.router.accounts[0].path, "utf8"), before);
  await assert.rejects(readFile(join(staging, "auth.json")), {
    code: "ENOENT",
  });
});

test("re-sign-in wins over both an in-flight and a stale queued token refresh", async (t) => {
  const f = await fixture(t, () => ok(), { expire: true });
  let finish, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const a = new Account({ name: "a", home: "a" }, f.root, async () => {
    entered();
    await new Promise((r) => {
      finish = r;
    });
    return Response.json({
      access_token: jwt(Date.now() / 1000 + 3600),
      refresh_token: "old-rotation",
    });
  });
  const stale = await a.load();
  const refreshing = a.token();
  await started;
  const replacing = a.replaceCredentials({
    tokens: {
      account_id: "id-a",
      access_token: jwt(Date.now() / 1000 + 7200),
      refresh_token: "new-login",
    },
  });
  finish();
  await Promise.all([refreshing, replacing]);
  assert.equal((await a.load()).tokens.refresh_token, "new-login");
  assert.equal((await a.refresh(stale)).refresh_token, "new-login");
  assert.equal((await a.load()).tokens.refresh_token, "new-login");
});
