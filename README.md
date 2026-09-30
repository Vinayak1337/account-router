# Account Router

A local Windows account switcher for **Codex**. Minimal dashboard, usage meters, account priority, recurring use, and manual saved resets.

![Dashboard](docs/dashboard.jpg)

## Setup

1. Install and open [Codex for Windows](https://openai.com/codex/).
2. Download and run [Account Router Setup.exe](https://github.com/Vinayak1337/account-router/releases/latest).
3. Open **Account Router**. Choose **Add account** and complete OpenAI sign-in. Repeat for your other accounts.
4. Choose **Connect to Codex**, reopen Codex, then start a new chat.

Keep Account Router running while using Codex. Closing its window leaves it in the system tray; **Quit** waits for active requests. **Disconnect Codex** restores your previous default provider. Existing chats retain their saved provider.

## Controls

| Control | Effect |
| --- | --- |
| Use account | Changes new requests; active requests finish where they started. |
| Drag / arrows | Sets fallback priority, independent of your current selection. |
| Recurring | Highest-priority ready recurring account takes over new requests. |
| Refresh | Reads usage, plan information, and saved resets. |
| Details → Use reset | Selects the earliest supported, unexpired reset first. Confirmation required. |

Unknown or exhausted accounts cannot be selected. Default cutoff: **1% remaining**. No reset is spent automatically. Plan expiry appears when OpenAI reports it. Model access depends on the account; experimental Sol-on-Free routing is **off** in new installs.

## Local data

Sign-ins and settings stay in `%LOCALAPPDATA%\Account Router`. Windows access is restricted to your user and SYSTEM. The proxy binds to `127.0.0.1`; the dashboard never receives tokens. No cloud dashboard, analytics, or prompt logging.

This is an unofficial Codex utility. It does not modify the ChatGPT website or turn subscriptions into API credits. OpenAI sign-in and service endpoints are required and may change. The installer is unsigned; Windows may show a publisher warning.

## Build

Windows x64 · Node 22+

```powershell
npm ci
npm test
npm start
npm run build:win
```

Installer: `dist/Account-Router-1.0.0-Setup.exe`. `npm run preview` opens an isolated fixture at `http://127.0.0.1:18892/dashboard`; it uses synthetic accounts and never calls OpenAI.

To reuse an existing router directory, launch `"Account Router.exe" --data-dir "C:\path\to\router"`. Run only one router per account store. Never commit `accounts`, `.runtime`, or `router.config.json`.

## Structure

`router.mjs` handles requests; routing, recurring selection, saved resets, dashboard API, desktop integration, and frontend components live in separate modules. See [design notes](docs/design.md) and [security](SECURITY.md).
