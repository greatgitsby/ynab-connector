# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A remote MCP server, hosted on Cloudflare Workers, that exposes read-only YNAB
data as tools for a Claude.ai custom connector. Deployed at
`https://ynab-connector.moen-cca.workers.dev`.

## Commands

```bash
npm run dev            # wrangler dev on localhost:8787
npm run type-check     # tsc --noEmit
npm run deploy         # wrangler deploy
npx wrangler tail      # stream live logs from the deployed Worker
npx wrangler types     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
```

Secrets (`YNAB_API_TOKEN`, `CONNECTOR_AUTH_TOKEN`) are set with
`npx wrangler secret put <NAME>`. For `wrangler dev`, mirror them in `.dev.vars`.

There are no tests.

## Architecture

Two source files only:

- `src/ynab.ts` — `YnabClient` wraps the YNAB REST API at `https://api.ynab.com/v1`.
  Auth header is `Bearer <YNAB_API_TOKEN>`. Errors throw `YnabError(status, body)`.
  All amounts in YNAB are **milliunits** (1 USD = 1000); `fromMilli()` converts
  for display. The client is read-only by design — see "Read-only" below before
  adding mutating methods.
- `src/index.ts` — Worker entry. Defines `YnabMcp` (a `McpAgent` Durable Object)
  whose `init()` registers all tools on `this.server`. The default export's
  `fetch` handler routes `/mcp/<secret>/...` to `YnabMcp.serve(prefix)`.

Two persistent secrets, two different jobs:

- `YNAB_API_TOKEN` — server-side credential to call YNAB on the user's behalf.
- `CONNECTOR_AUTH_TOKEN` — embedded in the MCP endpoint path so only someone who
  knows the full URL can hit it. claude.ai's connector UI can't set custom
  headers, so the URL itself is the bearer. Compared with `timingSafeEqual`;
  wrong path returns 404 (no token-leaking error surface).

The Durable Object is declared with `new_sqlite_classes: ["YnabMcp"]` in
`wrangler.jsonc` — that's the storage backend `McpAgent` needs for MCP session
state. Don't rename the class without a new migration tag.

## Tool conventions

When adding a new read tool to `src/index.ts`:

- Wrap the handler body in `try`/`catch` and return `handleError(e)` — that
  surfaces `YnabError`s as readable text instead of crashing the session.
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
Re-adding mutation needs an explicit ask — don't sneak it in alongside a
read-tool change.

## YNAB API gotchas

- `month` parameters accept either `YYYY-MM-01` or the literal string `current`.
- `goal_type` codes mean: `TB`=target balance, `TBD`=target balance by date,
  `MF`=monthly funding (this is the "monthly target"), `NEED`=plan your
  spending, `DEBT`=debt payoff. Mapped in `GOAL_LABEL`.
- `/budgets` and `/plans` are both live aliases. The OpenAPI spec uses `/plans`
  but this client uses `/budgets` because that's what users still call them.
