# Account Router

A local account switcher for **Codex** on Windows and macOS. Two-column account grid, usage meters, account priority, recurring use, and saved resets. When an account's limit runs out, new requests move to the next ready account without an error in Codex.

![Dashboard](docs/dashboard.jpg)

## Setup (Windows)

1. Install and open [Codex for Windows](https://openai.com/codex/).
2. Download and run [Account Router Setup.exe](https://github.com/Vinayak1337/account-router/releases/latest).
3. Open **Account Router**. Choose **Add account** and complete OpenAI sign-in. Repeat for your other accounts.
4. Choose **Connect to Codex**, reopen Codex, then start a new chat.

## Setup (macOS)

macOS uses a background service and your browser instead of a desktop window. Requires Node 22+ and the ChatGPT app with Codex.

```sh
git clone https://github.com/Vinayak1337/account-router.git
cd account-router && npm ci --omit=dev --ignore-scripts
node bin/account-router.mjs start     # launchd agent: starts at login, restarts after a crash
node bin/account-router.mjs open      # dashboard → Add account → complete OpenAI sign-in
node bin/account-router.mjs connect   # then quit and reopen the ChatGPT app
```

`npm link` makes this an `account-router` command. Other commands: `status`, `doctor`, `logs`, `stop`, `restart`, `disconnect`, `uninstall`. The service runs from this folder, so run `start` again if you move it.

Keep Account Router running while using Codex. On Windows, closing its window leaves it in the system tray; **Quit** waits for active requests. **Disconnect Codex** restores your previous default provider. Existing chats retain their saved provider.

## Controls

| Control                | Effect                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account toggle         | Turns an account off for new requests and all automatic routing. Active requests finish; priority and settings are retained.                                            |
| Use account            | Changes new requests; active requests finish where they started.                                                                                                        |
| Drag / arrows          | Sets fallback priority, independent of your current selection.                                                                                                          |
| Drain                  | When selected: use to 0%, switch away, use a saved reset, then return.                                                                                                  |
| Recurring              | Highest-priority ready recurring account takes over new requests.                                                                                                       |
| Refresh                | Reads usage, plan information, and saved resets.                                                                                                                        |
| Details → Use reset    | Selects the earliest supported, unexpired reset first. Confirmation required.                                                                                           |
| Credits as last resort | After every account's plan allowance is used, accounts with credits keep serving by priority. On by default (Codex's own behavior); turn off to stop at the plan limit. |

Unknown or exhausted accounts cannot be selected. Default cutoff: **1% remaining**. **Drain is off by default.** Enabling it authorizes automatic saved resets for that account. Plan expiry appears when OpenAI reports it. Model access depends on the account; experimental Sol-on-Free routing is **off** in new installs.

### Drain

Enable **Drain** on an account, then select it (or let normal routing select it). It takes precedence over recurring and model routing without changing priority.

**0% → next ready account → earliest-expiring reset → return after confirmed recovery.** Repeat until no usable resets remain, then continue normal routing. Active streams finish on their original account before its reset. New requests use fallback accounts immediately; if none are ready, they receive an unavailable response and can retry.

A newer manual selection or disabling Drain cancels the automatic return. An already-submitted reset can still complete. Failed, unconfirmed, or interrupted reset cycles pause Drain instead of spending another credit; check **Details**, retry the same pending reset if needed, then toggle Drain off/on to re-arm. Existing response IDs remain tied to their original account.

## Codex CLI only (macOS)

`node bin/account-router.mjs connect --cli` writes `~/.codex/account-router.config.toml`, a Codex profile used only by `codex -p account-router`. The ChatGPT app keeps its own sign-in.

## pi: native account pool

`pi/codex-accounts` is a [pi](https://github.com/badlogic/pi-mono) extension that switches ChatGPT accounts inside pi itself, without the router.

```sh
ln -s "$PWD/pi/codex-accounts" ~/.pi/agent/extensions/codex-accounts
pi   # then /login codex-1, /login codex-2, … (pi's own ChatGPT sign-in, one per account)
pi --provider codex-pool --model gpt-6-luna
```

- Requests go to the first ready account. A limited account is paused until its exact reset (from the limit error, response headers or the usage endpoint) and the same request moves on; nothing switches once output has started.
- After the reset the account is confirmed with a usage check and returns to rotation; if another window is still exhausted it stays paused until that later reset. Accounts switch at 1% remaining by default (`/codex-accounts cutoff <percent>`).
- A model missing from one account's plan is tried on the others. Brief 429/5xx failures are retried.
- `/codex-accounts` lists accounts, usage and reset times; `/codex-accounts refresh` reads usage now. State: `~/.pi/agent/codex-accounts.json`.

Tests: `node --test pi/codex-accounts/test.mjs` (runs the real `pi -p` against a local stand-in backend).

## Claude Code: pi subagents

`claude/pi-subagents` is a Claude Code mod that gives Claude a `codex_subagent` tool: each call runs a pi subagent on `codex-pool` (parallel calls run in parallel), read-only by default or with edit access, and can continue an earlier subagent by `session_id`. Load it for every session by setting `CLAUDE_CODE_PLUGIN_DIRS` to that folder in `~/.claude/settings.json` (`env`).

## Reliability

Nothing is shown to Codex until the router has a working reply:

- **Limits:** a usage-limit rejection moves the request to the next ready account. When every account is exhausted, Codex shows its usage-limit message with the earliest reset.
- **Brief failures:** OpenAI 5xx, throttles and dropped connections are retried on the same account, then on the next. A failure right after a response starts (before any output) is moved the same way.
- **Interrupted streams:** a stream that breaks after output began ends with a retryable failure event instead of a cut connection, so Codex retries the turn instead of showing "error decoding response body".
- **Sign-in:** only an explicit rejection (expired, reused or revoked refresh token) asks you to sign in again. Network or sign-in-service outages pause an account for 15 seconds; a still-valid token keeps working.
- **Codex settings:** Codex's own retries stay on. Older installs that disabled them are upgraded in place when the router starts.

No limit is placed on parallel requests per account. Codex sends several at once (subagents, compaction, titles).

Each account needs its own sign-in through **Add account**. Never copy an `auth.json` between Codex and the router: two programs refreshing the same sign-in can make OpenAI revoke it.

## Local data

Sign-ins and settings stay in `%USERPROFILE%\.account-router` (macOS: `~/.account-router`, owner-only permissions; service log in `.runtime/router.log`). On upgrade, the app copies data from `%USERPROFILE%\AppData\Local\Account Router` once. Windows access is restricted to your user and SYSTEM. The proxy binds to `127.0.0.1`; the dashboard never receives tokens. No cloud dashboard, analytics, or prompt logging.

This is an unofficial Codex utility. It does not modify the ChatGPT website or turn subscriptions into API credits. OpenAI sign-in and service endpoints are required and may change. The installer is unsigned; Windows may show a publisher warning.

## Build

Tests run on any platform: `npm ci --ignore-scripts && npm test`.

Windows x64 · Node 22+

```powershell
npm ci
npm test
npm start
npm run build:win
```

Installer: `dist/Account-Router-1.2.5-Setup.exe`. `npm run preview` opens an isolated fixture at `http://127.0.0.1:18892/dashboard`; it uses synthetic accounts and never calls OpenAI.

To preview frontend edits against the running app without restarting it, run `npm run preview:live` and open `http://127.0.0.1:18893/dashboard`. This browser view uses your real accounts and controls; keep the app running.

To reuse an existing router directory, launch `"Account Router.exe" --data-dir "C:\path\to\router"`. Run only one router per account store. Never commit `accounts`, `.runtime`, or `router.config.json`.

## Structure

`router.mjs` handles requests; routing, recurring selection, saved resets, dashboard API, desktop integration, and frontend components live in separate modules. See [design notes](docs/design.md) and [security](SECURITY.md).
