import { afterEach, describe, expect, it, mock, vi } from "bun:test";
import type { TokenExchangeCallbackOptions } from "@cloudflare/workers-oauth-provider";
import type { RefreshEnv } from "./token-refresh";

// The provider imports a workerd-only module; bun can't resolve it.
void mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { GrantType } = await import("@cloudflare/workers-oauth-provider");
const { ynabTokenExchange } = await import("./token-refresh");

const exchange = (props: unknown) =>
  ynabTokenExchange({
    grantType: GrantType.REFRESH_TOKEN,
    clientId: "client-1",
    userId: "user-1",
    scope: [],
    requestedScope: [],
    props,
    env: { YNAB_CLIENT_ID: "id", YNAB_CLIENT_SECRET: "secret" },
  } as unknown as TokenExchangeCallbackOptions<RefreshEnv>);

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

describe("ynabTokenExchange", () => {
  it("revokes a grant whose props don't parse", async () => {
    await expect(exchange({ ynabUserId: "u" })).rejects.toMatchObject({
      code: "invalid_grant",
    });
  });

  it("stores nothing from a malformed YNAB refresh response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ access_token: "new" })),
    ) as unknown as typeof fetch;
    await expect(
      exchange({
        ynabUserId: "u",
        ynabAccessToken: "old",
        ynabRefreshToken: "refresh",
        ynabExpiresAt: 0,
      }),
    ).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});
