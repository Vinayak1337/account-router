import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configure, PROVIDER, descriptor } from "./connection.mjs";
import { createRouter, atomicJson } from "../router.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "account-router-connection-"));
  const home = join(root, "codex");
  await mkdir(home);
  await mkdir(join(root, ".runtime"));
  await writeFile(
    join(root, ".runtime/local-key"),
    "fixture-local-key-12345678901234567890",
  );
  await atomicJson(join(root, "router.config.json"), {
    port: 18898,
    accounts: [],
  });
  return { root, home, path: join(home, "config.toml") };
}
function providerText() {
  const p = descriptor(18898, "fixture-local-key-12345678901234567890");
  return `model_provider = "${PROVIDER}"\r\nmodel = "user-model"\r\n[model_providers.${PROVIDER}]\r\nname = "${p.name}"\r\nbase_url = "${p.base_url}"\r\nwire_api = "responses"\r\nrequires_openai_auth = true\r\nsupports_websockets = false\r\nrequest_max_retries = 0\r\nstream_max_retries = 0\r\nhttp_headers = { "X-Local-Router-Key" = "fixture-local-key-12345678901234567890" }\r\n`;
}
test("disconnect preserves CRLF, restores the previous provider, and returns no key", async () => {
  const f = await fixture();
  const initial = providerText();
  await writeFile(f.path, initial);
  await atomicJson(join(f.root, ".runtime/integration.json"), {
    previous_provider: "custom",
  });
  assert.equal(
    (await configure(f.root, "status", { codexHome: f.home })).wired,
    true,
  );
  const result = await configure(f.root, "unwire", { codexHome: f.home });
  assert.equal(result.wired, false);
  assert.equal(result.provider, "custom");
  assert.equal(JSON.stringify(result).includes("fixture-local-key"), false);
  const output = await readFile(f.path, "utf8");
  assert.equal(output.includes("\r\r\n"), false);
  assert.ok(output.includes('model = "user-model"'));
  const backup = (await readdir(join(f.root, ".runtime"))).find((n) =>
    n.startsWith("codex-config-backup"),
  );
  assert.equal(
    await readFile(join(f.root, ".runtime", backup), "utf8"),
    initial,
  );
});
test("a different router is never mistaken for this installation or disconnected", async () => {
  const f = await fixture();
  await writeFile(
    f.path,
    `model_provider = "${PROVIDER}"\n[model_providers.${PROVIDER}]\nbase_url = "http://127.0.0.1:12345/v1"\n`,
  );
  const before = await readFile(f.path);
  const status = await configure(f.root, "status", { codexHome: f.home });
  assert.equal(status.wired, false);
  assert.equal(status.state, "other-router");
  await assert.rejects(
    configure(f.root, "unwire", { codexHome: f.home }),
    /another router/,
  );
  assert.deepEqual(await readFile(f.path), before);
});
test("concurrent config edits are preserved", async () => {
  const f = await fixture();
  await writeFile(f.path, providerText());
  const changed = 'model_provider = "openai"\nmodel = "user-new-model"\n';
  await assert.rejects(
    configure(f.root, "unwire", {
      codexHome: f.home,
      beforeCommit: () => writeFile(f.path, changed),
    }),
    /changed during/,
  );
  assert.equal(await readFile(f.path, "utf8"), changed);
});
test("a fresh install accepts zero accounts and rejects unauthenticated proxy requests", async (t) => {
  const f = await fixture();
  const router = await createRouter(
    {
      port: 18898,
      strategy: "exhaust-first",
      freeSolRouting: false,
      accounts: [],
    },
    {
      root: f.root,
      key: "fixture-local-key-12345678901234567890",
      connectionRunner: async () => ({ wired: false, provider: "openai" }),
    },
  );
  router.server.listen(0, "127.0.0.1");
  await new Promise((r) => router.server.once("listening", r));
  t.after(() => router.drain());
  const url = `http://127.0.0.1:${router.server.address().port}`;
  assert.equal(router.snapshot().accounts.length, 0);
  assert.equal((await fetch(url + "/v1/models")).status, 403);
  const page = await fetch(url + "/dashboard");
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("Add account"));
});

import { createServer } from "node:http";
test("wire verifies ownership, preserves settings, is idempotent, and reconnects", async (t) => {
  const f = await fixture();
  await mkdir(join(f.root, "accounts/a"), { recursive: true });
  await atomicJson(join(f.root, "accounts/a/auth.json"), {
    tokens: { account_id: "synthetic-a" },
  });
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, root: f.root }));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  await atomicJson(join(f.root, "router.config.json"), {
    port: server.address().port,
    accounts: [{ home: "accounts/a" }],
  });
  await writeFile(
    f.path,
    'model = "original-model"\nservice_tier = "default"\n',
  );
  assert.equal(
    (await configure(f.root, "wire", { codexHome: f.home })).wired,
    true,
  );
  assert.equal(
    (await configure(f.root, "wire", { codexHome: f.home })).state,
    "already-configured",
  );
  assert.ok(
    (await readFile(f.path, "utf8")).includes('service_tier = "default"'),
  );
  assert.equal(
    (await configure(f.root, "unwire", { codexHome: f.home })).provider,
    "openai",
  );
  assert.equal(
    (await configure(f.root, "wire", { codexHome: f.home })).wired,
    true,
  );
});
test("repair removes the old zero-retry settings in place and keeps every other setting", async () => {
  const f = await fixture();
  const other = `\n[model_providers.explabs]\nname = "Other"\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\n\n[tui]\ntheme = "dark"\n`;
  await writeFile(f.path, providerText() + other);
  const before = await configure(f.root, "status", { codexHome: f.home });
  assert.equal(before.wired, true);
  assert.equal(before.outdated, true);
  const result = await configure(f.root, "repair", { codexHome: f.home });
  assert.equal(result.state, "repaired");
  assert.equal(result.wired, true);
  const output = await readFile(f.path, "utf8");
  assert.equal(/max_retries/.test(output), false);
  assert.ok(output.includes('model = "user-model"'));
  assert.ok(output.includes("[model_providers.explabs]"));
  assert.ok(output.includes('theme = "dark"'));
  assert.equal(
    output.match(/\[model_providers\.local_paid_accounts\]/g).length,
    1,
  );
  const after = await configure(f.root, "status", { codexHome: f.home });
  assert.equal(after.wired, true);
  assert.equal(after.outdated, false);
  assert.equal(
    (await configure(f.root, "repair", { codexHome: f.home })).state,
    "unchanged",
  );
  // A different router's block is never rewritten.
  await writeFile(
    f.path,
    `model_provider = "${PROVIDER}"\n[model_providers.${PROVIDER}]\nbase_url = "http://127.0.0.1:12345/v1"\nrequest_max_retries = 0\n`,
  );
  const foreign = await readFile(f.path);
  assert.equal(
    (await configure(f.root, "repair", { codexHome: f.home })).state,
    "unchanged",
  );
  assert.deepEqual(await readFile(f.path), foreign);
});
test("new connections leave Codex's retry defaults on", () => {
  const p = descriptor(18898, "fixture-local-key-12345678901234567890");
  assert.equal("request_max_retries" in p, false);
  assert.equal("stream_max_retries" in p, false);
});
test("the CLI profile routes only `codex -p account-router` and leaves config.toml untouched", async () => {
  const { configureProfile, profilePath } = await import("./connection.mjs");
  const f = await fixture();
  await writeFile(f.path, 'model = "user-model"\n');
  const before = await readFile(f.path);
  assert.equal(
    (await configureProfile(f.root, "status", { codexHome: f.home })).wired,
    false,
  );
  await configureProfile(f.root, "wire", { codexHome: f.home });
  const profile = await readFile(profilePath(f.home), "utf8");
  assert.match(profile, /model_provider = "local_paid_accounts"/);
  assert.equal(/max_retries/.test(profile), false);
  assert.deepEqual(await readFile(f.path), before);
  assert.equal(
    (await configureProfile(f.root, "status", { codexHome: f.home })).wired,
    true,
  );
  await configureProfile(f.root, "unwire", { codexHome: f.home });
  await assert.rejects(readFile(profilePath(f.home)));
  // A profile written by someone else is never replaced or removed.
  await writeFile(profilePath(f.home), 'model_provider = "other"\n');
  await assert.rejects(
    configureProfile(f.root, "wire", { codexHome: f.home }),
    /left unchanged/,
  );
  await assert.rejects(
    configureProfile(f.root, "unwire", { codexHome: f.home }),
    /left unchanged/,
  );
});
