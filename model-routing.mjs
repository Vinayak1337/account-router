// The desktop's choice stays intact unless it requests Astra on Free/Go.
// GPT-6 Sol is the user's explicitly selected fallback. Prefer 6.1 only when
// the selected account's catalog actually reports it; access errors pass through.
export async function effectiveModel(
  account,
  payload,
  clientVersion = "0.156.1",
) {
  const requested = typeof payload.model === "string" ? payload.model : null;
  if (
    !requested ||
    !["free", "go"].includes(String(account.profile.plan).toLowerCase()) ||
    !/^gpt-\d+(?:\.\d+)?-astra$/.test(requested)
  )
    return { requested, effective: requested, fallback: false };
  if (
    !account.modelCatalog ||
    Date.now() - account.modelCatalog.checkedAt > 300_000
  ) {
    if (!account.modelCatalogReading)
      account.modelCatalogReading = (async () => {
        let models = [];
        try {
          let tokens = await account.token();
          const version = /^\d+\.\d+\.\d+$/.test(clientVersion)
            ? clientVersion
            : "0.156.1";
          const send = () =>
            account.fetcher(
              `https://chatgpt.com/backend-api/codex/models?client_version=${version}`,
              {
                headers: {
                  authorization: `Bearer ${tokens.access_token}`,
                  "ChatGPT-Account-Id": tokens.account_id,
                  originator: "codex_cli_rs",
                },
                redirect: "error",
                signal: AbortSignal.timeout(8000),
              },
            );
          let response = await send();
          if (response.status === 401) {
            await response.body?.cancel();
            tokens = await account.token(true, tokens.access_token);
            response = await send();
          }
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error("Catalog unavailable");
          }
          const data = await response.json();
          if (data.account_id && data.account_id !== tokens.account_id)
            throw new Error("Catalog identity mismatch");
          const rows = data.models ?? data.data;
          if (!Array.isArray(rows)) throw new Error("Catalog unavailable");
          models = rows
            .filter((m) => m.supported_in_api !== false)
            .map((m) => m.slug ?? m.id)
            .filter((m) => typeof m === "string");
        } catch {
          /* A catalog failure does not change the user's chosen Sol fallback. */
        }
        account.modelCatalog = { models, checkedAt: Date.now() };
      })().finally(() => {
        account.modelCatalogReading = null;
      });
    await account.modelCatalogReading;
  }
  const effective = account.modelCatalog.models.includes("gpt-6.1-sol")
    ? "gpt-6.1-sol"
    : "gpt-6-sol";
  return {
    requested,
    effective,
    fallback: true,
    listed: account.modelCatalog.models.includes(effective),
  };
}
