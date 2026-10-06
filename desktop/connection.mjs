import { parse } from "smol-toml";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  stat,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
export const PROVIDER = "local_paid_accounts";
const read = async (path) =>
  readFile(path).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
const decode = (bytes) => bytes?.toString("utf8").replace(/^\uFEFF/, "") || "";
function withDefault(text, value) {
  const lines = text.split(/(?<=\n)/);
  const line = `model_provider = ${JSON.stringify(value)}\n`;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      lines.splice(i, 0, line + "\n");
      return lines.join("");
    }
    if (/^\s*model_provider\s*=/.test(lines[i])) {
      lines[i] = line;
      return lines.join("");
    }
  }
  return line + text;
}
// Codex's own retry defaults stay on: they recover dropped connections and
// brief upstream failures that the router reports as retryable.
export function descriptor(port, key) {
  return {
    name: "Account Router",
    base_url: `http://127.0.0.1:${port}/v1`,
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
    http_headers: { "X-Local-Router-Key": key },
  };
}
// The same URL and local key identify this installation, including blocks
// written by older versions with different settings.
function owned(existing, target) {
  return (
    !!existing &&
    !!target &&
    existing.base_url === target.base_url &&
    existing.http_headers?.["X-Local-Router-Key"] ===
      target.http_headers?.["X-Local-Router-Key"]
  );
}
function providerSnippet(target) {
  return `\n[model_providers.${PROVIDER}]\nname = "Account Router"\nbase_url = ${JSON.stringify(target.base_url)}\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nhttp_headers = { "X-Local-Router-Key" = ${JSON.stringify(target.http_headers["X-Local-Router-Key"])} }\n`;
}
// Removes this router's provider table and its sub-tables; other text is kept.
function withoutProvider(text) {
  const lines = text.split(/(?<=\n)/);
  const header = new RegExp(
    `^\\s*\\[\\s*model_providers\\.${PROVIDER}\\s*(\\]|\\.)`,
  );
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) skipping = header.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("");
}
function matches(a, b) {
  if (!a || !b) return false;
  const x = { ...a, name: "Account Router" },
    y = { ...b, name: "Account Router" };
  const normalize = (o) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(o).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  return normalize(x) === normalize(y);
}
async function expected(root) {
  const cfg = JSON.parse(decode(await read(join(root, "router.config.json"))));
  const key = decode(await read(join(root, ".runtime/local-key"))).trim();
  if (!key || !Number.isInteger(cfg.port))
    throw new Error("Start the router first.");
  return { cfg, key, provider: descriptor(cfg.port, key) };
}
export async function configure(
  root,
  action,
  {
    codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
    beforeCommit,
  } = {},
) {
  const configPath = join(codexHome, "config.toml"),
    originalBytes = await read(configPath),
    original = decode(originalBytes);
  let parsed;
  try {
    parsed = parse(original);
  } catch {
    throw new Error(
      "Codex settings contain invalid TOML. The original was preserved.",
    );
  }
  const provider = parsed.model_provider || "openai",
    runtime = join(root, ".runtime");
  if (action === "status") {
    const target = await expected(root)
      .then((x) => x.provider)
      .catch(() => null);
    const existing = parsed.model_providers?.[PROVIDER];
    const own = owned(existing, target);
    const wired = provider === PROVIDER && own;
    return {
      outdated: own && !matches(existing, target),
      state: wired
        ? "connected"
        : provider === PROVIDER
          ? "other-router"
          : "disconnected",
      wired,
      provider,
      message:
        provider === PROVIDER && !own
          ? "Codex uses another router installation. Disconnect it there before connecting this one."
          : wired
            ? "Codex is connected."
            : "Codex is disconnected.",
    };
  }
  if (!["wire", "unwire", "repair"].includes(action))
    throw new Error("Unknown connection action.");
  let updated = original,
    nextProvider = provider,
    expectedProvider = null;
  await mkdir(runtime, { recursive: true });
  if (action === "unwire") {
    if (provider !== PROVIDER)
      return {
        state: "disabled",
        wired: false,
        provider,
        message: "Codex is disconnected.",
      };
    const own = await expected(root);
    if (!owned(parsed.model_providers?.[PROVIDER], own.provider))
      throw new Error(
        "Codex uses another router installation. Disconnect it from that installation.",
      );
    const integration = await read(join(runtime, "integration.json"));
    const previous = integration
      ? JSON.parse(decode(integration)).previous_provider
      : "openai";
    if (typeof previous !== "string" || previous === PROVIDER)
      throw new Error(
        "The previous provider could not be verified. Settings were preserved.",
      );
    updated = withDefault(original, previous);
    nextProvider = previous;
  } else if (action === "repair") {
    // Upgrade this router's provider block in place (for example, older
    // versions disabled Codex retries). The default provider is unchanged.
    const { provider: target } = await expected(root);
    const existing = parsed.model_providers?.[PROVIDER];
    if (!owned(existing, target) || matches(existing, target))
      return {
        state: "unchanged",
        wired: provider === PROVIDER && owned(existing, target),
        provider,
      };
    expectedProvider = target;
    updated =
      withoutProvider(original).trimEnd() + "\n" + providerSnippet(target);
  } else {
    const { cfg, key, provider: target } = await expected(root);
    expectedProvider = target;
    const health = await fetch(`http://127.0.0.1:${cfg.port}/health`, {
      headers: { "X-Local-Router-Key": key },
      signal: AbortSignal.timeout(3000),
    }).then((r) => {
      if (!r.ok) throw new Error("Start the router first.");
      return r.json();
    });
    if (
      !health.ok ||
      health.draining ||
      resolve(health.root).toLowerCase() !== resolve(root).toLowerCase()
    )
      throw new Error(
        "A different router owns this port. Settings were preserved.",
      );
    const identities = new Set();
    for (const account of cfg.accounts) {
      const data = JSON.parse(
        decode(await read(resolve(root, account.home, "auth.json"))),
      );
      const id = data.tokens?.account_id;
      if (!id || identities.has(id))
        throw new Error("Add distinct signed-in accounts before connecting.");
      identities.add(id);
    }
    if (!identities.size)
      throw new Error("Add an account before connecting to Codex.");
    const existing = parsed.model_providers?.[PROVIDER];
    if (existing && !owned(existing, target))
      throw new Error(
        "Another router provider already exists. Settings were preserved.",
      );
    const current = matches(existing, target);
    if (provider === PROVIDER && current)
      return {
        state: "already-configured",
        wired: true,
        provider: PROVIDER,
        message: "Codex is already connected.",
      };
    if (!current)
      updated =
        withoutProvider(updated).trimEnd() + "\n" + providerSnippet(target);
    // Reconnecting an outdated block keeps the provider to restore on disconnect.
    if (provider !== PROVIDER)
      await writeFile(
        join(runtime, "integration.json"),
        JSON.stringify({ previous_provider: provider }),
        { mode: 0o600 },
      );
    updated = withDefault(updated, PROVIDER);
    nextProvider = PROVIDER;
  }
  parse(updated);
  await mkdir(codexHome, { recursive: true });
  if (originalBytes)
    await writeFile(
      join(runtime, `codex-config-backup-${Date.now()}-${randomUUID()}.toml`),
      originalBytes,
      { mode: 0o600 },
    );
  const temp = configPath + ".router-" + randomUUID() + ".tmp";
  try {
    await writeFile(temp, updated, { mode: 0o600, flag: "wx" });
    await beforeCommit?.();
    const current = await read(configPath);
    if (
      (current === null) !== (originalBytes === null) ||
      (current && !current.equals(originalBytes))
    )
      throw new Error(
        "Codex settings changed during setup. Try again; your changes were preserved.",
      );
    await rename(temp, configPath);
  } finally {
    await unlink(temp).catch(() => {});
  }
  const verified = parse(decode(await read(configPath)));
  if (
    verified.model_provider !== nextProvider ||
    (expectedProvider &&
      !matches(verified.model_providers?.[PROVIDER], expectedProvider))
  )
    throw new Error(
      "Connection changed after setup. A local backup was retained.",
    );
  if (action === "repair")
    return {
      state: "repaired",
      wired: nextProvider === PROVIDER,
      provider: nextProvider,
      restartMayBeNeeded: true,
      message:
        "Codex connection settings updated. Reopen Codex to apply them to new chats.",
    };
  return {
    state: action === "wire" ? "configured" : "disabled",
    wired: action === "wire",
    provider: nextProvider,
    restartMayBeNeeded: true,
    message:
      "Connection updated. Reopen Codex and start a new chat; existing chats retain their saved provider.",
  };
}
