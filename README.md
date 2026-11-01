# YNAB Connector

A remote MCP server on Cloudflare Workers that lets your AI assistant read
and edit your YNAB (You Need A Budget) data. It works with any MCP client
that supports remote servers with OAuth, and it serves many users.

Both sides use OAuth. Your MCP client signs in to the connector with OAuth 2.1
(dynamic client registration and PKCE), and you authorize the connector
against YNAB with the OAuth 2.0 authorization code grant. The connector
encrypts your YNAB access and refresh tokens into the bearer token it issues
to your client, so it keeps no long-lived state for any user.

> [!NOTE]
> Project page: [greatgitsby.github.io/ynab-connector](https://greatgitsby.github.io/ynab-connector/)

## Install

> [!TIP]
> Add `https://ynab.mcp.moen.ai/mcp` as a remote MCP server in your MCP
> client. Some clients call this a custom connector. The client finds the
> OAuth endpoints on its own and walks you through authorizing the connector
> against your YNAB account.
>
> On Claude.ai, you can [add it in one click](https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=YNAB&connectorUrl=https%3A%2F%2Fynab.mcp.moen.ai%2Fmcp)

To host your own copy, see [One-time setup](#one-time-setup).

## Tools

Read tools:

| Tool | What it does |
| --- | --- |
| `list_plans` | All plans visible to the connected YNAB account, archived ones included |
| `list_accounts` | Accounts with balances, bank-link health, and last reconciliation |
| `list_months` | Income, assigned, activity, Ready to Assign, and age of money for each month in a range |
| `get_month` | One month's categories, grouped by category group; defaults to the current month |
| `get_category` | One category in one month, optionally with its month-by-month history and whether its goal was funded each month |
| `list_transactions` | Transactions for the plan or one account, category, payee, or month over any date range, with totals by month |
| `list_scheduled_transactions` | Upcoming scheduled bills, paychecks, and transfers that aren't in balances yet |
| `list_money_movements` | Assignments and moves between categories, with each category's net flow and moves out of savings goals flagged |
| `list_payees` | Payees, optionally filtered by part of their name |
| `triage_inbox` | Uncategorized and unapproved transactions, overspent categories, and underfunded goals in one call |
| `reflect_income_expense` | Income by payee against expense by category for each month in a range (default 3 months), with Average and Total columns |
| `reflect_net_worth` | Current net worth, month-end history rebuilt from transactions, and each account's balance |

Write tools need write access (see [Permissions](#permissions)):

| Tool | What it does |
| --- | --- |
| `assign_to_categories` | Set a month's `budgeted` amount on one or more categories, as absolute milliunits. Moves money between categories or funds them from Ready to Assign. |
| `update_transactions` | Edit existing transactions in bulk: category, approval, memo, flag, cleared status, payee, or splits. |
| `reconcile_account` | Reconcile an account against a bank statement balance. Locks cleared transactions only when every transaction is approved and categorized and the balances match. |

The connector deliberately leaves out creating manual transactions, deleting anything, creating or editing scheduled transactions, renaming or merging payees, renaming or moving categories, and editing goals. [Write tools](docs/internals/write-tools.md) explains why.

## How auth works

Connecting runs two OAuth flows in one browser session.

1. MCP client to connector. The client finds the connector's authorization
   endpoints through RFC 9728 protected-resource metadata and registers
   itself, either with dynamic registration (RFC 7591) or a Client ID
   Metadata Document. It then starts an OAuth 2.1 authorization code flow
   with S256 PKCE. The connector is the authorization server, built on
   `@cloudflare/workers-oauth-provider`.
2. Connector to YNAB. The connector's `/authorize` endpoint sends you to
   `https://app.ynab.com/oauth/authorize`. Once you grant access, YNAB
   redirects to `/callback`. The connector exchanges the code for
   `{ access_token, refresh_token }` and reads your YNAB user id from
   `GET /v1/user`.

`completeAuthorization` then encrypts the YNAB tokens into the client's
bearer token through the OAuth provider's `props`. On each MCP request the
provider decrypts them and passes them to a new, stateless MCP server built
for that request, so every tool call runs with the right user's YNAB
credentials. The client's access token expires just before the YNAB token
inside it. When the client refreshes, the connector refreshes the YNAB token
and stores the new pair in the grant.

## One-time setup

### 1. Register a YNAB OAuth application

At <https://app.ynab.com/settings/developer>, click **New Application** under
OAuth Applications. Set the redirect URI to your worker's `/callback` path,
for example `https://ynab-connector.<your-account>.workers.dev/callback`.
Copy the client ID and client secret.

New YNAB OAuth apps start in Restricted Mode, which caps them at 25 access
tokens. YNAB lifts the cap after a review that takes 2 to 4 weeks. For
personal use, the cap doesn't matter.

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

Wrangler prints the deployed URL, something like
`https://ynab-connector.<your-account>.workers.dev`.

## Connect a client

Add `https://ynab-connector.<your-account>.workers.dev/mcp` as a remote MCP
server in your client. It needs no secret path suffix, because OAuth does
that job. The client finds the OAuth endpoints and walks you through
authorizing against YNAB.

For Claude.ai, you can share a one-click install link in the same format as
the hosted one above, with your worker's URL in place of ours:

```
https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=YOUR_NAME&connectorUrl=https%3A%2F%2Fynab-connector.YOUR_ACCOUNT.workers.dev%2Fmcp
```

Other users only repeat this step. Each one authorizes their own YNAB account
when they add the connector.

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

Connect to `http://localhost:8787/mcp` with the Streamable HTTP transport.
The inspector sees that OAuth is required, sends you through YNAB, and comes
back signed in.

## Notes

- YNAB stores money in milliunits (1 USD = 1000). Text output shows normal
  currency.
- For `get_month`, pass `month` as `YYYY-MM-01` or `current`.

## Permissions

The connector asks YNAB for full read and write access. Reads work on any
connection. Write tools also check that the token came from the current,
write-capable sign-in flow.

Connections made before write support shipped are read-only in practice.
Their tokens predate the write scope, so write tools answer with an error
asking you to reconnect. To turn on writes, disconnect the connector in your
MCP client and add it again. The YNAB authorization page will ask for the
broader scope.

YNAB has no separate read and write grants; a connection has full access or
none. To stay read-only, don't reconnect. Your existing read-only token keeps
working.

## Disclaimer

We are not affiliated, associated, or in any way officially connected with
YNAB or any of its subsidiaries or affiliates. The official YNAB website is
<https://www.ynab.com>. The names YNAB and You Need A
Budget, as well as related names, tradenames, marks, trademarks, emblems,
and images are registered trademarks of YNAB.
