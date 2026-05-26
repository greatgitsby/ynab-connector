# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote MCP server, hosted on Cloudflare Workers, that exposes read-only YNAB
data as tools for a Claude.ai custom connector. Multi-user via dual OAuth:
Claude.ai authenticates to the connector via OAuth 2.1 (dynamic client
registration + PKCE); each user authorizes the connector against YNAB via
OAuth 2.0 Authorization Code Grant. Deployed at
`https://ynab-connector.moen-cca.workers.dev`.

## Commands

```bash
npm run dev            # wrangler dev on localhost:8787
npm run type-check     # tsc --noEmit
npm run deploy         # wrangler deploy
npx wrangler tail      # stream live logs from the deployed Worker
npx wrangler types     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
```

Secrets (`YNAB_CLIENT_ID`, `YNAB_CLIENT_SECRET`) are set with
`npx wrangler secret put <NAME>`. For `wrangler dev`, mirror them in `.dev.vars`.

The `OAUTH_KV` namespace must exist (`npx wrangler kv namespace create OAUTH_KV`)
and its id pasted into `wrangler.jsonc`.

There are no tests.

## Architecture

Three source files:

- `src/ynab.ts` — `YnabClient` wraps the YNAB REST API at
  `https://api.ynab.com/v1`. The constructor takes an access token and an
  optional refresh callback; on a 401 the client invokes the callback for a
  fresh token and retries once. Also exports `ynabAuthorizeUrl`,
  `exchangeYnabCode`, and `refreshYnabToken` used by the auth handler.
  Errors throw `YnabError(status, body)`. All amounts are **milliunits**
  (1 USD = 1000); `fromMilli()` converts for display.

- `src/ynab-auth.ts` — exports `ynabAuthHandler`, the OAuthProvider's
  `defaultHandler`. Owns `GET /authorize` (parses Claude.ai's authorize
  request, stashes it in KV under a random state token, redirects to YNAB)
  and `GET /callback` (validates state via session-bound cookie, exchanges
  the YNAB code for tokens, fetches the YNAB user id, calls
  `env.OAUTH_PROVIDER.completeAuthorization` with the YNAB tokens as `props`).
  Also defines the `Props` type that flows into `YnabMcp.props`.

- `src/index.ts` — Worker entry. Defines `YnabMcp` (a typed
  `McpAgent<Env, Record<string, never>, Props>` Durable Object) whose
  `init()` registers all tools on `this.server`. The default export is
  `new OAuthProvider({ apiHandler: YnabMcp.serve("/mcp"), defaultHandler: ynabAuthHandler, ... })`.

The two secrets:

- `YNAB_CLIENT_ID` / `YNAB_CLIENT_SECRET` — for the connector's OAuth client
  registration with YNAB. Held by the Worker only.

Per-user YNAB access + refresh tokens never live in our storage — they're
encrypted into the bearer token issued back to Claude.ai (the
`workers-oauth-provider` `props` mechanism) and surface on each request as
`this.props` inside `YnabMcp`. The `OAUTH_KV` namespace stores
provider-internal state (registered clients, auth codes, hashed token
secrets) and the short-lived state token used to bridge `/authorize` →
YNAB → `/callback`.

The Durable Object is declared with `new_sqlite_classes: ["YnabMcp"]` in
`wrangler.jsonc` — that's the storage backend `McpAgent` needs for MCP session
state. Don't rename the class without a new migration tag.

## Tool conventions

When adding a new read tool to `src/index.ts`:

- Wrap the handler body in `try`/`catch` and return `handleError(e)` — that
  surfaces `YnabError`s as readable text instead of crashing the session.
- Use `this.client()` to get a `YnabClient` bound to the current user's
  token; it carries the refresh-on-401 callback automatically.
- Return text via the `text()` helper: `{ content: [{ type: "text", text: ... }] }`.
- Format money with `fmtMoney(milliunits)`. Always pass the raw milliunit value
  from the API, not pre-converted dollars.
- For categories that carry goals, append `fmtGoal(c)` to the line so monthly
  targets / underfunded amounts surface alongside budgeted/activity.
- Append `— id <uuid>` to each line so Claude can reference items in follow-up
  tool calls.

## Read-only

The connector is intentionally read-only right now. The YNAB client has no
write methods, and `NewTransaction` / `toMilli()` were deliberately removed.
YNAB OAuth scope is `read-only` to match. Re-adding mutation needs an
explicit ask — don't sneak it in alongside a read-tool change, and the
scope on the YNAB authorize URL would need to change too.

## YNAB API gotchas

- `month` parameters accept either `YYYY-MM-01` or the literal string `current`.
- `goal_type` codes mean: `TB`=target balance, `TBD`=target balance by date,
  `MF`=monthly funding (this is the "monthly target"), `NEED`=plan your
  spending, `DEBT`=debt payoff. Mapped in `GOAL_LABEL`.
- `/budgets` and `/plans` are both live aliases. The OpenAPI spec uses `/plans`
  but this client uses `/budgets` because that's what users still call them.
- YNAB OAuth access tokens expire after 2 hours; refresh tokens are
  long-lived. The `YnabClient` refresh-on-401 handles rotation transparently.
- New YNAB OAuth apps start in "Restricted Mode" with a 25-token cap; submit
  the YNAB review form to lift it before sharing the connector widely.
