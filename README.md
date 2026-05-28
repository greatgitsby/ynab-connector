# YNAB Connector for Claude

A remote MCP server, hosted on Cloudflare Workers, that lets a Claude.ai connector
read your YNAB (You Need A Budget) data. Read-only. Multi-user, OAuth-protected
on both sides: Claude.ai authenticates via OAuth 2.1 (dynamic client
registration + PKCE), and each user authorizes the connector against YNAB via
OAuth 2.0 Authorization Code Grant. Per-user YNAB access + refresh tokens are
encrypted into the bearer token issued back to Claude.ai — the connector
itself holds no long-lived per-user state.

> [!NOTE]
> ### [→ Project page: greatgitsby.github.io/ynab-connector](https://greatgitsby.github.io/ynab-connector/)

## Install

> [!TIP]
> ### [→ Add Claude for YNAB to Claude.ai](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Claude%20for%20YNAB&connectorUrl=https%3A%2F%2Fclaude-for-ynab.moen.ai%2Fmcp)
>
> One click opens Claude.ai's "Add custom connector" dialog with the name and
> URL prefilled against the hosted deployment at `claude-for-ynab.moen.ai`.
> After you confirm, Claude walks you through authorizing the connector against
> your YNAB account.

Prefer to self-host instead? See [One-time setup](#one-time-setup) below.

## What Claude can do with it

Tools the connector exposes:

| Tool | What it does |
| --- | --- |
| `list_budgets` | List all budgets visible to the connected YNAB account |
| `get_budget_summary` | Snapshot: accounts + current-month totals |
| `list_accounts` | All accounts with balances |
| `get_month` | Full month breakdown grouped by category group; defaults to the current month |
| `list_transactions` | Transactions, optionally filtered to `uncategorized` / `unapproved` |
| `triage_inbox` | Uncategorized + unapproved txs, overspent categories, underfunded goals — one call |
| `reflect_spending_breakdown` | Spending over a date range (defaults to previous calendar month): total, average monthly & daily, most frequent category, largest outflow, per-category share, positive-inflow categories |
| `reflect_spending_trends` | Net activity over last N months (default 6) with deltas from window average, plus top categories month-over-month |
| `reflect_net_worth` | Current snapshot + historical month-by-month net worth (reconstructed from transactions), plus per-account balances |
| `reflect_income_expense` | Income (by payee) vs expense (by category, grouped) pivot over last N months (default 3), with Average and Total columns |
| `reflect_age_of_money` | Current age of money plus monthly history, average, and trend |
| `get_category_details` | Drilldown for one category: month aggregates + every transaction this month |

## How auth works

Two OAuth flows are bridged in a single browser handshake when a user
connects:

1. **Claude.ai → Connector** (inbound). Claude.ai discovers the connector's
   authorization endpoints via RFC 9728 protected-resource metadata, registers
   itself dynamically (RFC 7591), and starts an OAuth 2.1 authorization-code
   flow with PKCE. The connector acts as the Authorization Server using
   `@cloudflare/workers-oauth-provider`.
2. **Connector → YNAB** (outbound). The connector's `/authorize` endpoint
   redirects the user to `https://app.ynab.com/oauth/authorize`. After the
   user grants access, YNAB redirects back to `/callback`; the connector
   exchanges the code for `{ access_token, refresh_token }` and looks up the
   YNAB user id via `GET /v1/user`.

`completeAuthorization` then encrypts the YNAB tokens into Claude.ai's bearer
token via the OAuth provider's `props`. On every MCP request, the provider
decrypts and surfaces them as `this.props` inside the tool handlers — so each
tool call uses the right user's YNAB credentials. Access tokens are refreshed
lazily on 401 via the stored refresh token.

## One-time setup

### 1. Register a YNAB OAuth application

At <https://app.ynab.com/settings/developer>, click **New Application** under
the OAuth Applications section. Set the redirect URI to your deployed
worker's `/callback` path, e.g.
`https://ynab-connector.<your-account>.workers.dev/callback`. Copy the
client ID and client secret.

Note: new YNAB OAuth apps start in "Restricted Mode" with a cap of 25 access
tokens, removable after a 2–4 week review. Fine for personal use.

### 2. Create the OAuth KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` it prints into `wrangler.jsonc`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Set secrets

```bash
npm install
npx wrangler login                                 # if you haven't before
npx wrangler secret put YNAB_CLIENT_ID             # from step 1
npx wrangler secret put YNAB_CLIENT_SECRET         # from step 1
npx wrangler deploy
```

Wrangler will print the deployed URL — something like
`https://ynab-connector.<your-account>.workers.dev`.

## Wire it up in Claude

For your self-hosted deployment you can share a one-click install link with
the same format as the hosted one above — just swap in your worker's URL:

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=YOUR_NAME&connectorUrl=https%3A%2F%2Fynab-connector.YOUR_ACCOUNT.workers.dev%2Fmcp
```

Or manually:

1. Go to claude.ai → Settings → Connectors → **Add custom connector**.
2. Set the URL to `https://ynab-connector.<your-account>.workers.dev/mcp`
   (no secret path suffix — OAuth replaces it).
3. Save. Claude will discover the OAuth flow and walk you through
   authorizing against YNAB.
4. In a new chat the connector's tools appear under "Search and tools."

Subsequent users connect by repeating only the Claude.ai step: each one runs
their own YNAB OAuth handshake when they add the connector.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in YNAB_CLIENT_ID + YNAB_CLIENT_SECRET
npm run dev                       # starts wrangler dev on localhost:8787
```

For the local YNAB OAuth app, set the redirect URI to
`http://localhost:8787/callback` and add the client id/secret to `.dev.vars`.

Test it with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8787/mcp` using Streamable HTTP transport. The
inspector will detect the OAuth requirement, redirect you through YNAB, and
return authenticated.

## Notes

- YNAB stores money as **milliunits** (1 USD = 1000). The tools translate to
  normal currency in their output.
- For `get_month`, pass the calendar `month` as `YYYY-MM-01` or `current`.
- YNAB OAuth scope is `read-only`, matching the connector's read-only
  surface.

## Files

```
src/
  index.ts       # Worker entry: OAuthProvider + YnabMcp (McpAgent)
  ynab-auth.ts   # /authorize + /callback handlers (YNAB upstream OAuth)
  ynab.ts        # YNAB API client + OAuth helpers
wrangler.jsonc
```

## Disclaimer

We are not affiliated, associated, or in any way officially connected with
YNAB or any of its subsidiaries or affiliates. The official YNAB website
can be found at <https://www.ynab.com>. The names YNAB and You Need A
Budget, as well as related names, tradenames, marks, trademarks, emblems,
and images are registered trademarks of YNAB.
