// Serve edited dashboard assets against an already-running local router.
// This never opens the account store or starts another routing engine.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const assets = new Map([
  ["/dashboard", "index.html"],
  ["/dashboard/", "index.html"],
  ...[
    "app.js",
    "cards.js",
    "details.js",
    "dom.js",
    "icons.js",
    "style.css",
    "mark.svg",
  ].map((file) => ["/dashboard/" + file, file]),
]);
const actions = new Set(
  [
    "refresh",
    "settings/free-sol",
    "codex/wire",
    "accounts/select",
    "accounts/drain",
    "accounts/recurring",
    "accounts/reset-details",
    "accounts/use-reset",
    "accounts/order",
    "accounts",
    "login/cancel",
  ].map((path) => "/dashboard/api/" + path),
);
const security = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function createLivePreview({
  upstreamPort = 18891,
  assetsRoot = fileURLToPath(new URL("../dashboard/", import.meta.url)),
} = {}) {
  if (
    !Number.isInteger(upstreamPort) ||
    upstreamPort < 1 ||
    upstreamPort > 65535
  )
    throw new Error("Invalid local router port.");
  const upstream = `http://127.0.0.1:${upstreamPort}`;
  const server = createServer(async (req, res) => {
    const send = (status, message) => {
      res.writeHead(status, {
        ...security,
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: message }));
    };
    const host = `127.0.0.1:${server.address().port}`;
    const origin = `http://${host}`;
    // Validate the browser's authority before rewriting anything for upstream.
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      send(403, "Open this preview on its local address.");
      return;
    }
    const path = req.url;
    const file = req.method === "GET" && assets.get(path);
    const isStatus = req.method === "GET" && path === "/dashboard/api/status";
    const isAction = req.method === "POST" && actions.has(path);
    if (!file && !isStatus && !isAction) {
      send(404, "Unknown dashboard route.");
      return;
    }
    if (
      isAction &&
      (req.headers.origin !== origin ||
        req.headers["x-dashboard-request"] !== "1")
    ) {
      send(403, "A same-origin dashboard action is required.");
      return;
    }
    try {
      const headers = { ...security };
      let payload;
      if (file) {
        payload = await readFile(resolve(assetsRoot, file));
        headers["content-type"] = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html";
      }
      // The real router owns session creation and authentication. No keys are copied.
      if (!file || file === "index.html") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) {
            send(413, "Request too large.");
            return;
          }
          chunks.push(chunk);
        }
        const response = await fetch(upstream + (file ? "/dashboard" : path), {
          method: req.method,
          headers: {
            ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
            ...(isAction
              ? {
                  origin: upstream,
                  "x-dashboard-request": "1",
                  "content-type": "application/json",
                }
              : {}),
          },
          ...(isAction ? { body: Buffer.concat(chunks) } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(120_000),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          send(502, "Unexpected router redirect.");
          return;
        }
        if (file) {
          await response.body?.cancel();
          if (!response.ok) {
            send(502, "Router session unavailable.");
            return;
          }
          const cookie = response.headers.getSetCookie();
          if (cookie.length) headers["set-cookie"] = cookie;
        } else {
          headers["content-type"] = "application/json";
          res.writeHead(response.status, headers);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
      }
      res.writeHead(200, headers);
      res.end(payload);
    } catch {
      if (!res.headersSent)
        send(
          502,
          "The running router is unavailable. Open Account Router and reload.",
        );
      else res.destroy();
    }
  });
  server.requestTimeout = 15_000;
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  createLivePreview().listen(18893, "127.0.0.1", () => {
    console.log("Live dashboard: http://127.0.0.1:18893/dashboard");
  });
}
