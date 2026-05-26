# YNAB Connector for Claude

A remote MCP server, hosted on Cloudflare Workers, that lets a Claude.ai connector
read your YNAB (You Need A Budget) data. Read-only.

## What Claude can do with it

Tools the connector exposes:

| Tool | What it does |
| --- | --- |
| `list_budgets` | List all budgets visible to the token |
| `get_budget_summary` | Snapshot: accounts + current-month totals |
| `list_accounts` | All accounts with balances |
| `list_categories` | Categories grouped, with budgeted / activity / balance |
| `get_month` | Full month breakdown for a specific (or current) month |
| `list_transactions` | Transactions, optionally filtered to `uncategorized` / `unapproved` |
| `list_payees` | List payees |

## How auth works

There are two distinct secrets:

- `YNAB_API_TOKEN` — your YNAB personal access token. The Worker uses it to call
  the YNAB API.
- `CONNECTOR_AUTH_TOKEN` — a long random string you generate. It's embedded in
  the MCP endpoint path, e.g. `https://ynab-connector.<account>.workers.dev/mcp/<CONNECTOR_AUTH_TOKEN>`.
  Treat the full URL as a secret. claude.ai's connector UI doesn't allow custom
  headers, so a secret URL is the practical alternative to running full OAuth.

## One-time deploy

```bash
npm install
npx wrangler login                                 # if you haven't before
npx wrangler secret put YNAB_API_TOKEN             # paste your YNAB PAT
npx wrangler secret put CONNECTOR_AUTH_TOKEN       # paste a long random string
npx wrangler deploy
```

Generate a token with e.g. `openssl rand -hex 32`.

Wrangler will print the deployed URL — something like
`https://ynab-connector.<your-account>.workers.dev`.

## Wire it up in Claude

1. Go to claude.ai → Settings → Connectors → **Add custom connector**.
2. Set the URL to `https://ynab-connector.<your-account>.workers.dev/mcp/<CONNECTOR_AUTH_TOKEN>`.
3. Save. In a new chat, the connector's tools should appear under "Search and tools."

If the URL is wrong or the secret is wrong, the path returns 404 — there's no
auth-error response surface to leak the token.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real values
npm run dev                       # starts wrangler dev on localhost:8787
```

Test it with the MCP inspector:

```bash
npx @modelcontextprotocol/inspector
```

Then connect to `http://localhost:8787/mcp/<CONNECTOR_AUTH_TOKEN>` using
Streamable HTTP transport.

## Notes

- YNAB stores money as **milliunits** (1 USD = 1000). The tools translate to
  normal currency in their output.
- For `get_month`, pass the calendar `month` as `YYYY-MM-01` or `current`.

## Files

```
src/
  index.ts   # Worker entry + MCP agent + tool registrations
  ynab.ts    # Thin YNAB API client and types
wrangler.jsonc
```

Get a YNAB PAT at <https://app.ynab.com/settings/developer>.
