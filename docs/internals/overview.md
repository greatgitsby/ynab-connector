# Architecture

The connector holds no per-user state. Everything it needs for a request arrives inside the bearer
token Claude.ai presents, and every request builds its own MCP server.

## Two OAuth flows, one handshake

Claude.ai authenticates to the connector with OAuth 2.1 (dynamic registration or a Client ID
Metadata Document, S256 PKCE). The connector is the authorization server, via
`@cloudflare/workers-oauth-provider`. Its `/authorize` sends the user on to YNAB, and `/callback`
exchanges the YNAB code ([`ynab-auth.ts`](../../src/ynab-auth.ts)). `completeAuthorization` then
encrypts the YNAB access and refresh tokens into the grant's `props`. The provider decrypts them on
each request and hands them to `buildServer(props)`.

`OAUTH_KV` holds only provider state (clients, auth codes, hashed token secrets) and the
short-lived state that bridges `/authorize` to `/callback`. Losing it signs users out; it never held
YNAB credentials.

The token audience is bound to `MCP_RESOURCE`, which must stay `https://ynab.mcp.moen.ai/mcp`
in production because existing grants carry it. `wrangler dev` overrides it through `.dev.vars`.

## Token rotation lives in one place

YNAB refresh tokens rotate, so two concurrent refreshes spend the same token and one loses. The
connector refreshes only inside the provider's `tokenExchangeCallback`
([`token-refresh.ts`](../../src/token-refresh.ts)), which Claude.ai's own refresh serializes.

- At code exchange, Claude's access-token TTL is set to end five minutes before the YNAB token
  inside it. Claude refreshes first, and we refresh YNAB then (unless more than ten minutes remain)
  and store the new pair as the grant's props.
- A YNAB 400/401 on refresh throws `invalid_grant`. The provider revokes the grant and Claude.ai
  re-authorizes instead of retrying a dead grant forever. Other failures are
  `temporarily_unavailable`.
- `YnabClient` never refreshes. A YNAB 401 inside a tool is an ordinary tool error.
- Older grants can still carry an expired YNAB token. The API handler answers those with 401
  `invalid_token` so the client refreshes immediately.

An earlier design refreshed inside tool calls and kept the result in Durable Object memory. Once the
object was evicted, the grant held a spent refresh token. That is why the server is now stateless:
the `YnabMcp` Durable Object was deleted with migration `v2`, and the tools never needed session
state.

`src/index.ts` and `src/token-refresh.ts` import `cloudflare:workers`, so the plain-Node vitest
suite cannot load them. Probe the OAuth endpoints under `wrangler dev` when changing them.

## Tool shape

Each tool is one file under `src/tools/`. A pure `computeX` turns YNAB data into a typed result; a
pure `renderX` turns the result into text. The handler only fetches, computes, renders, and wraps
errors with `handleError`, which returns an `isError: true` tool execution error. The typed result
is the test surface and, via [structured output](./structured-output.md), the wire contract.

Domain filtering goes through named predicates in [`predicates.ts`](../../src/predicates.ts) and
goal interpretation through `interpretGoal`, so YNAB's `hidden`/`deleted`/`internal` flags and the
`goal_*` matrix are read in exactly one place each.

Write tools split compute further into a pure `buildBody` / `interpretResponse` pair plus an
effectful `apply*` orchestrator, and take a `getProps()` closure for the
[write gate](./write-tools.md#write-access).

Every plan-scoped tool takes `plan_id` from [`schemas.ts`](../../src/schemas.ts), defaulting to
YNAB's `last-used` alias so single-plan users skip a `list_plans` round trip.
