import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve, relative, dirname } from "node:path";
const run = promisify(execFile);
const powershell = () =>
  join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
export async function protectStorage(path) {
  await mkdir(path, { recursive: true });
  if (process.platform !== "win32") return;
  const script = `$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name; & icacls.exe $env:ACCOUNT_ROUTER_STORAGE /inheritance:r /grant:r "\${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null; if($LASTEXITCODE -ne 0){throw 'Storage protection failed.'}`;
  await run(
    powershell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      env: { ...process.env, ACCOUNT_ROUTER_STORAGE: resolve(path) },
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8192,
    },
  );
}
export async function findCodexCli() {
  if (process.env.ACCOUNT_ROUTER_CODEX_CLI) {
    const path = resolve(process.env.ACCOUNT_ROUTER_CODEX_CLI);
    if (!path.toLowerCase().endsWith(".exe"))
      throw new Error("Use the official native codex.exe.");
    await access(path);
    return path;
  }
  const script = `$p=Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue | Select-Object -First 1; $cli=if($p){Join-Path $p.InstallLocation 'app\\resources\\codex.exe'}; if($cli -and (Test-Path -LiteralPath $cli)){[Console]::Write($cli)}else{$c=Get-Command codex.exe -ErrorAction SilentlyContinue; if($c){[Console]::Write($c.Source)}}`;
  const { stdout } = await run(
    powershell(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 15000, maxBuffer: 8192 },
  );
  const path = stdout.trim();
  if (!path)
    throw new Error(
      "Install or open the official Codex desktop app, then try again.",
    );
  await access(path);
  return path;
}
export function nativeLogin({ root, home, onUrl }) {
  const path = resolve(home),
    within = relative(resolve(root, "accounts"), path);
  if (!within || within.startsWith("..") || resolve(root, "accounts") === path)
    throw new Error("Invalid account folder.");
  let child,
    cancelled = false;
  const done = (async () => {
    const cli = await findCodexCli();
    if (cancelled) throw new Error("Sign-in cancelled.");
    await protectStorage(path);
    await writeFile(
      join(path, "config.toml"),
      'cli_auth_credentials_store = "file"\n',
      { mode: 0o600 },
    );
    if (cancelled) throw new Error("Sign-in cancelled.");
    await new Promise((accept, reject) => {
      child = spawn(cli, ["login"], {
        cwd: root,
        env: { ...process.env, CODEX_HOME: path },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      const output = (chunk) => {
        buffer = (buffer + chunk.toString()).slice(-32768);
        const match = buffer.match(
          /https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/,
        );
        if (match && !cancelled) onUrl(match[0]);
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      child.once("error", () =>
        reject(new Error("Could not start official sign-in.")),
      );
      child.once("exit", (code) =>
        code === 0 && !cancelled
          ? accept()
          : reject(
              new Error(
                cancelled
                  ? "Sign-in cancelled."
                  : "OpenAI sign-in did not finish.",
              ),
            ),
      );
    });
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      child?.kill();
    },
  };
}
