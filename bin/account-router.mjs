#!/usr/bin/env node
// Account Router without the desktop window: the router runs as a background
// service (a launchd agent on macOS) and the dashboard opens in your browser.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  open,
  unlink,
  rm,
  access,
  stat,
} from "node:fs/promises";
import { createRouter, localKey, atomicJson } from "../router.mjs";
import { protectStorage, findCodexCli } from "../desktop/login.mjs";
import { configure } from "../desktop/connection.mjs";
import { wireCodex, detectCodex } from "../codex-integration.mjs";

const require = createRequire(import.meta.url);
const { dataRoot } = require("../desktop/data-root.cjs");
const run = promisify(execFile);
const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = fileURLToPath(import.meta.url);
const LABEL = "io.github.vinayak1337.account-router";
const PLIST = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const DEFAULT_CONFIG = {
  port: 18891,
  strategy: "exhaust-first",
  freeSolRouting: false,
  creditFallback: "last-resort",
  accounts: [],
};

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-")) || "help";
const root = dataRoot(args, homedir());
const mac = process.platform === "darwin";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function readConfig() {
  try {
    return JSON.parse(
      (await readFile(join(root, "router.config.json"), "utf8")).replace(
        /^﻿/,
        "",
      ),
    );
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Router configuration is invalid. The original file was preserved.",
      );
    return null;
  }
}
async function prepare() {
  await protectStorage(root);
  await protectStorage(join(root, ".runtime"));
  await protectStorage(join(root, "accounts"));
  let config = await readConfig();
  if (!config) {
    config = { ...DEFAULT_CONFIG };
    await atomicJson(join(root, "router.config.json"), config);
  }
  return { config, key: await localKey(root) };
}
async function health(port, key) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-Local-Router-Key": key },
      signal: AbortSignal.timeout(1500),
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
async function running() {
  const config = await readConfig();
  if (!config) return null;
  const key = await localKey(root);
  const h = await health(config.port, key);
  return h && resolve(h.root) === resolve(root) ? { config, key, h } : null;
}
const dashboardUrl = (port) => `http://127.0.0.1:${port}/dashboard`;

// Runs the router in the foreground. launchd uses this command.
async function serve() {
  const { config, key } = await prepare();
  const existing = await health(config.port, key);
  if (existing) {
    if (resolve(existing.root) === resolve(root) && !existing.draining) {
      console.log(`Account Router is already running on ${config.port}.`);
      return;
    }
    throw new Error(
      `Port ${config.port} is used by another router. Stop it first.`,
    );
  }
  const lockPath = join(root, ".runtime/router.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lockPath, "utf8").catch(() => 0));
    let alive = false;
    try {
      if (pid > 0) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch {}
    if (alive) throw new Error("This router is already starting.");
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
  const router = await createRouter(config, { root, key });
  await new Promise((accept, reject) => {
    router.server.once("error", reject);
    router.server.listen(config.port, "127.0.0.1", accept);
  }).catch(async (error) => {
    await cleanup();
    throw error.code === "EADDRINUSE"
      ? new Error(`Port ${config.port} is already in use.`)
      : error;
  });
  console.log(
    `${new Date().toISOString()} Account Router listening on 127.0.0.1:${config.port} (${root})`,
  );
  // Older versions wrote Codex settings that disabled its retries.
  configure(root, "repair")
    .then((r) => {
      if (r.state === "repaired") console.log(r.message);
    })
    .catch(() => {});
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${new Date().toISOString()} Finishing active requests…`);
    await router.drain();
    await cleanup();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  router.server.once("close", stop);
}

const xml = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
function plist() {
  const log = join(root, ".runtime/router.log");
  const programArgs = [process.execPath, SCRIPT, "serve", "--data-dir", root]
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(PROJECT)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}
const domain = () => `gui/${userInfo().uid}`;
async function agentLoaded() {
  return run("/bin/launchctl", ["print", `${domain()}/${LABEL}`]).then(
    () => true,
    () => false,
  );
}
async function waitForRouter(seconds = 15) {
  for (let i = 0; i < seconds * 4; i++) {
    const r = await running();
    if (r) return r;
    await pause(250);
  }
  return null;
}
async function start() {
  await prepare();
  if (mac) {
    await mkdir(dirname(PLIST), { recursive: true });
    await writeFile(PLIST, plist(), { mode: 0o644 });
    if (await agentLoaded())
      await run("/bin/launchctl", ["kickstart", `${domain()}/${LABEL}`]);
    else await run("/bin/launchctl", ["bootstrap", domain(), PLIST]);
  } else if (!(await running())) {
    const log = await open(join(root, ".runtime/router.log"), "a");
    spawn(process.execPath, [SCRIPT, "serve", "--data-dir", root], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    }).unref();
    await log.close();
  }
  const r = await waitForRouter();
  if (!r)
    throw new Error(
      `The router did not start. See ${join(root, ".runtime/router.log")}`,
    );
  console.log(`Account Router is running: ${dashboardUrl(r.config.port)}`);
  if (mac)
    console.log("It starts at login and restarts automatically if it stops.");
}
async function stop() {
  if (mac && (await agentLoaded())) {
    await run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]);
    console.log("Account Router stopped. It starts again at your next login.");
    return;
  }
  const r = await running();
  if (!r) return console.log("Account Router is not running.");
  await fetch(`http://127.0.0.1:${r.config.port}/admin/shutdown`, {
    method: "POST",
    headers: { "X-Local-Router-Key": r.key },
  });
  console.log("Account Router is finishing active requests and stopping.");
}
async function uninstall() {
  if (mac) {
    if (await agentLoaded())
      await run("/bin/launchctl", ["bootout", `${domain()}/${LABEL}`]);
    await rm(PLIST, { force: true });
  } else await stop();
  console.log(
    `Removed the background service. Accounts and settings remain in ${root}.`,
  );
}
async function openDashboard() {
  const r = await running();
  if (!r)
    throw new Error("Account Router is not running. Run: account-router start");
  const url = dashboardUrl(r.config.port);
  if (mac) await run("/usr/bin/open", [url]);
  else if (process.platform === "win32")
    spawn("cmd", ["/c", "start", "", url], { detached: true }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  console.log(url);
}
function remaining(a) {
  const p = a.policy?.remainingPercent;
  return Number.isFinite(p) ? `${Math.round(p)}% left` : "usage unknown";
}
function accountState(a, now) {
  if (!a.enabled) return "off";
  if (a.reason === "identity-changed") return "account changed";
  if (a.signedIn === false || a.reason === "sign-in-required")
    return "sign-in needed";
  if (a.transientUntil > now) return "retrying shortly";
  if (a.blockedUntil > now || a.policy?.atThreshold)
    return a.creditsUsable ? "plan used · credits available" : "exhausted";
  return "ready";
}
async function status() {
  const r = await running();
  if (!r) {
    console.log("Account Router is not running. Run: account-router start");
    process.exitCode = 1;
    return;
  }
  const data = await fetch(`http://127.0.0.1:${r.config.port}/status`, {
    headers: { "X-Local-Router-Key": r.key },
  }).then((x) => x.json());
  const connection = await configure(root, "status").catch(() => null);
  console.log(`Router     running · ${dashboardUrl(r.config.port)}`);
  console.log(
    `Codex      ${connection?.wired ? "connected" : "not connected (run: account-router connect)"}${connection?.outdated ? " · settings outdated, restart the router" : ""}`,
  );
  console.log(
    `Selected   ${data.selectedAccount || "none"} · credits ${data.creditFallback === "never" ? "off" : "last resort"} · ${data.inFlight} active request(s)`,
  );
  if (!data.accounts.length)
    console.log("Accounts   none yet. Add one from the dashboard.");
  const now = Date.now();
  for (const a of data.accounts)
    console.log(
      `  ${a.name === data.selectedAccount ? "▸" : " "} ${(a.label || a.name).padEnd(24)} ${remaining(a).padEnd(14)} ${accountState(a, now)}`,
    );
}
async function connect(enabled) {
  if (!(await running()))
    throw new Error("Start the router first: account-router start");
  const result = await wireCodex({ root, enabled });
  console.log(result.message);
}
async function logs() {
  const text = await readFile(join(root, ".runtime/router.log"), "utf8").catch(
    () => "",
  );
  console.log(text.split("\n").slice(-80).join("\n") || "No log yet.");
}
async function doctor() {
  const checks = [];
  const check = (ok, label, fix) => checks.push({ ok, label, fix });
  const major = Number(process.versions.node.split(".")[0]);
  check(
    major >= 22,
    `Node ${process.versions.node}`,
    "Install Node 22 or newer.",
  );
  const cli = await findCodexCli().catch(() => null);
  check(
    !!cli,
    `Codex CLI ${cli || "not found"}`,
    "Install the ChatGPT/Codex app.",
  );
  const app = await detectCodex().catch(() => ({ found: false }));
  check(
    app.found,
    `Codex app ${app.found ? `${app.path}${app.running ? " (running)" : ""}` : "not found"}`,
    "Install the ChatGPT app with Codex.",
  );
  const info = await stat(root).catch(() => null);
  check(
    !!info && (process.platform === "win32" || (info.mode & 0o077) === 0),
    `Data folder ${root}`,
    "Run: account-router start (it restricts the folder to your user).",
  );
  if (mac) {
    const installed = await access(PLIST).then(
      () => true,
      () => false,
    );
    let current = false;
    if (installed)
      current = (await readFile(PLIST, "utf8")).includes(xml(SCRIPT));
    check(
      installed && current,
      `Background service ${installed ? (current ? "installed" : "points to another copy") : "not installed"}`,
      "Run: account-router start",
    );
  }
  const r = await running();
  check(
    !!r,
    `Router ${r ? `running on ${r.config.port}` : "not running"}`,
    "Run: account-router start",
  );
  const connection = await configure(root, "status").catch(() => null);
  check(
    !!connection?.wired,
    `Codex ${connection?.wired ? "connected" : connection?.message || "not connected"}`,
    "Run: account-router connect, then reopen Codex.",
  );
  if (connection?.outdated)
    check(
      false,
      "Codex connection settings are outdated",
      "Restart the router: account-router restart",
    );
  for (const c of checks)
    console.log(
      `${c.ok ? "✓" : "✗"} ${c.label}${c.ok ? "" : `\n    → ${c.fix}`}`,
    );
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}
const help = `Account Router: switch Codex between your accounts automatically.

Usage: account-router <command> [--data-dir <folder>]

  start        Start in the background (macOS: launchd agent, starts at login)
  stop         Stop the background router
  restart      Stop, then start
  status       Router, Codex connection and per-account usage
  open         Open the dashboard in your browser (add accounts there)
  connect      Point Codex at the router (reopen Codex afterwards)
  disconnect   Restore Codex's previous provider
  doctor       Check the setup and explain any fixes
  logs         Show recent router log lines
  uninstall    Remove the background service (keeps accounts and settings)
  serve        Run in the foreground (used by the background service)

Data: ${root}`;

try {
  if (command === "serve") await serve();
  else if (command === "start" || command === "install") await start();
  else if (command === "stop") await stop();
  else if (command === "restart") {
    await stop();
    await pause(1000);
    await start();
  } else if (command === "status") await status();
  else if (command === "open") await openDashboard();
  else if (command === "connect") await connect(true);
  else if (command === "disconnect") await connect(false);
  else if (command === "doctor") await doctor();
  else if (command === "logs") await logs();
  else if (command === "uninstall") await uninstall();
  else console.log(help);
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
}
