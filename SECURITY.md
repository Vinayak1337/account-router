# Security

Do not publish account homes, auth files, runtime state, provider headers, reset journals, backups, or screenshots of real accounts. They are ignored by Git and excluded by the application build allowlist.

The server accepts loopback requests only, authenticates proxy requests with a locally generated key, and uses HttpOnly SameSite dashboard sessions plus same-origin action checks. Electron runs a sandboxed renderer without Node integration. Only official OpenAI sign-in links open externally.

Account identities are pinned. Refreshes are coalesced, active streams retain their account, generic throttles do not trigger replay, and streamed requests are not replayed. Reset redemption requires explicit confirmation and retains an idempotency journal. Unknown reset expiry or unsupported resets cannot be redeemed. No automatic reset jobs run.

Connection changes preserve unrelated TOML, keep private backups, verify router ownership, and reject concurrent settings edits. Storage remains after uninstall.

Dependencies are locked. Report vulnerabilities through GitHub private vulnerability reporting when enabled; do not post credentials in issues. These controls protect local application boundaries; they do not change OpenAI model access or service limits.
