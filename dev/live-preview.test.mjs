import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createLivePreview } from "./live-preview.mjs";

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
};
const call = (port, path, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, text }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

test("live preview serves source assets and retains the router's authenticated boundary", async (t) => {
  const seen = [];
  const backend = createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    if (req.url === "/dashboard") {
      res.setHeader(
        "set-cookie",
        "router_dashboard=fixture; Path=/dashboard; HttpOnly; SameSite=Strict",
      );
      res.end("old installed UI");
    } else if (req.headers.cookie !== "router_dashboard=fixture") {
      res.writeHead(401);
      res.end("{}");
    } else res.end('{"fixture":true}');
  });
  const upstreamPort = await listen(backend);
  const preview = createLivePreview({ upstreamPort });
  const port = await listen(preview);
  t.after(() => {
    preview.close();
    backend.close();
  });
  const home = await call(port, "/dashboard");
  assert.equal(home.status, 200);
  assert.match(home.text, /Account priority/);
  assert.doesNotMatch(home.text, /old installed UI/);
  assert.match(home.headers["set-cookie"][0], /HttpOnly/);
  assert.equal((await call(port, "/dashboard/api/status")).status, 401);
  assert.equal(
    (
      await call(port, "/dashboard/api/status", {
        headers: { cookie: "router_dashboard=fixture" },
      })
    ).status,
    200,
  );
  const before = seen.length;
  for (const headers of [
    { host: "evil.test" },
    { origin: "https://evil.test" },
    { "sec-fetch-site": "cross-site" },
  ])
    assert.equal(
      (await call(port, "/dashboard/api/status", { headers })).status,
      403,
    );
  for (const path of [
    "/v1/responses",
    "/admin",
    "/dashboard/../router.mjs",
    "/dashboard/api/status?url=https://evil.test",
  ])
    assert.equal((await call(port, path)).status, 404);
  assert.equal(
    (await call(port, "/dashboard/api/accounts/select", { method: "POST" }))
      .status,
    403,
  );
  assert.equal(seen.length, before);
  const headers = {
    origin: `http://127.0.0.1:${port}`,
    "x-dashboard-request": "1",
    cookie: "router_dashboard=fixture",
  };
  assert.equal(
    (
      await call(port, "/dashboard/api/accounts/select", {
        method: "POST",
        headers,
        body: '{"name":"fixture"}',
      })
    ).status,
    200,
  );
  assert.equal(seen.at(-1).headers.origin, `http://127.0.0.1:${upstreamPort}`);
  const after = seen.length;
  assert.equal(
    (
      await call(port, "/dashboard/api/accounts/select", {
        method: "POST",
        headers,
        body: "x".repeat(4097),
      })
    ).status,
    413,
  );
  assert.equal(seen.length, after);
});
