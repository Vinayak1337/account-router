import { configure } from "./desktop/connection.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { stat, access } from "node:fs/promises";
import { findCodexCli } from "./desktop/login.mjs";
const run = promisify(execFile);
const connectionCache = new Map();

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
// macOS: Codex ships inside the ChatGPT app (or as the older Codex app).
async function detectMacCodex() {
  const bundles = [
    "/Applications/ChatGPT.app",
    join(homedir(), "Applications/ChatGPT.app"),
    "/Applications/Codex.app",
    join(homedir(), "Applications/Codex.app"),
  ];
  let path = null;
  for (const bundle of bundles)
    if (await exists(bundle)) {
      path = bundle;
      break;
    }
  const running = await run("/usr/bin/pgrep", ["-x", "ChatGPT|Codex"], {
    timeout: 5_000,
  }).then(
    ({ stdout }) => stdout.trim().length > 0,
    () => false,
  );
  if (!path) path = await findCodexCli().catch(() => null);
  return { found: !!path, running, path, name: "Codex" };
}
export async function detectCodex() {
  if (process.platform === "darwin") return detectMacCodex();
  if (process.platform !== "win32") {
    const path = await findCodexCli().catch(() => null);
    return { found: !!path, running: false, path, name: "Codex" };
  }
  const script = `$ErrorActionPreference='Stop'
$running=@(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object {$_.Path -and ($_.Path -match 'WindowsApps\\\\OpenAI\\.Codex_' -or $_.Path -match 'Codex\\\\app\\\\(Codex|ChatGPT)\\.exe$')})
$package=Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1
$appPath=if($running.Count){$running[0].Path}elseif($package){$package.InstallLocation}else{$null}
[pscustomobject]@{found=[bool]$appPath;running=($running.Count -gt 0);path=$appPath;name='Codex'} | ConvertTo-Json -Compress`;
  try {
    const { stdout } = await run(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 },
    );
    return JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      "Could not locate the Codex desktop app. Open Codex and try again.",
    );
  }
}

// Read again only when the user's configuration file changes. Never return TOML
// contents or credentials to the browser.
export async function readCodexConnection({ root }) {
  const configPath = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "config.toml",
  );
  const file = await stat(configPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const signature = file ? `${file.mtimeMs}:${file.size}` : "missing";
  const key = resolve(root) + "|" + configPath,
    cached = connectionCache.get(key);
  if (cached?.signature === signature) return cached.promise;
  const promise = configure(root, "status").then((result) => {
    if (typeof result.wired !== "boolean")
      throw new Error("Could not verify the Codex connection.");
    return { ...result, checkedAt: Date.now() };
  });
  const entry = { signature, promise };
  connectionCache.set(key, entry);
  promise.catch(() => {
    if (connectionCache.get(key) === entry) connectionCache.delete(key);
  });
  return promise;
}

export async function wireCodex({ root, enabled = true }) {
  let app;
  if (enabled) {
    app = await detectCodex();
    if (!app.found)
      throw new Error(
        "Codex desktop was not found. Open the installed Codex app and try again.",
      );
  }
  const result = await configure(root, enabled ? "wire" : "unwire");
  if (
    !["configured", "already-configured", "disabled"].includes(result.state) ||
    result.wired !== enabled
  )
    throw new Error("Codex connection change was not verified.");
  connectionCache.clear();
  const verified = await readCodexConnection({ root });
  if (verified.wired !== enabled)
    throw new Error(
      "The Codex connection changed again. Refresh the dashboard before trying again.",
    );
  return {
    ...verified,
    ...result,
    ...(app
      ? { app: { name: app.name, running: app.running, found: true } }
      : {}),
    checkedAt: Date.now(),
  };
}
