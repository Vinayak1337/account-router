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
export function descriptor(port, key) {
  return {
    name: "Account Router",
    base_url: `http://127.0.0.1:${port}/v1`,
    wire_api: "responses",
    requires_openai_auth: true,
    supports_websockets: false,
    request_max_retries: 0,
    stream_max_retries: 0,
    http_headers: { "X-Local-Router-Key": key },
  };
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
    const own = await expected(root)
      .then((x) => matches(parsed.model_providers?.[PROVIDER], x.provider))
      .catch(() => false);
    const wired = provider === PROVIDER && own;
    return {
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
  if (!["wire", "unwire"].includes(action))
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
    if (!matches(parsed.model_providers?.[PROVIDER], own.provider))
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
    if (!health.ok || health.draining || resolve(health.root).toLowerCase() !== resolve(root).toLowerCase())
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
    if (existing && !matches(existing, target))
      throw new Error(
        "Another router provider already exists. Settings were preserved.",
      );
    if (provider === PROVIDER)
      return {
        state: "already-configured",
        wired: true,
        provider: PROVIDER,
        message: "Codex is already connected.",
      };
    if (!existing) {
      const snippet = `\n[model_providers.${PROVIDER}]\nname = "Account Router"\nbase_url = ${JSON.stringify(target.base_url)}\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\nhttp_headers = { "X-Local-Router-Key" = ${JSON.stringify(key)} }\n`;
      updated = updated.trimEnd() + "\n" + snippet;
    }
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
  return {
    state: action === "wire" ? "configured" : "disabled",
    wired: action === "wire",
    provider: nextProvider,
    restartMayBeNeeded: true,
    message:
      "Connection updated. Reopen Codex and start a new chat; existing chats retain their saved provider.",
  };
}
