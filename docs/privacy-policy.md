# Privacy Policy — Claude for YNAB

**Last Updated:** 2026-05-25

This privacy policy describes how the "Claude for YNAB" connector (the
"Connector") handles data accessed through the YNAB API. The Connector is a
personal-use OAuth application that lets the Claude.ai assistant
(<https://claude.ai>) read your YNAB data on your behalf.

## What the Connector accesses

When you authorize the Connector against your YNAB account, it requests the
`read-only` OAuth scope. This grants the Connector read access to:

- Your budgets (names, IDs, currency)
- Accounts and balances
- Categories, category groups, and goal data
- Transactions and split transactions
- Monthly summaries
- Your YNAB user ID (used as an internal identifier — see below)

The Connector never requests write scope and cannot create, modify, or
delete data in your YNAB account.

## How data is handled

**No persistent storage of your financial data.** The Connector does not
maintain a database of your transactions, balances, or any other YNAB data.
Every request from Claude.ai triggers a live call to the YNAB API; the
response is returned to Claude.ai and then discarded. Nothing is cached on
the server side.

**OAuth tokens.** Your YNAB access token and refresh token are encrypted
into the bearer token that the Connector issues back to Claude.ai. The
Connector itself does not store your YNAB tokens in plaintext at rest —
they exist only inside the encrypted bearer, which is decrypted in memory
per-request when Claude.ai calls the Connector. The Connector retains a
short-lived (≤10 minute) OAuth state record in Cloudflare Workers KV
during the authorization handshake; this record contains no YNAB data and
is deleted automatically once authorization completes or expires.

**Logs.** The Connector runs on Cloudflare Workers and uses Cloudflare's
default observability (request logs, error traces). These logs do not
record YNAB response bodies. They may record request paths, HTTP status
codes, and error messages. Cloudflare's data handling is governed by
Cloudflare's own privacy policy.

**Security.** All traffic to the Connector is HTTPS-only. Your YNAB tokens
are encrypted end-to-end inside the OAuth bearer using the
`@cloudflare/workers-oauth-provider` library's standard encryption scheme.

**Retention.** Because the Connector stores no YNAB data, there is nothing
to retain or delete on the data side. The encrypted OAuth bearer lives
only on the Claude.ai client side; revoking the Connector in YNAB or
disconnecting it in Claude.ai immediately ends all access.

## Third parties

The Connector does not share, sell, or otherwise pass YNAB data to any
third party. YNAB data flows only between:

1. YNAB's API (over the user-authorized OAuth connection)
2. The Connector (running on Cloudflare Workers — Cloudflare is the
   hosting infrastructure provider only and does not receive YNAB data as
   a recipient)
3. Anthropic's Claude.ai service (the requesting MCP client, acting on
   the authenticated user's behalf)

The Connector does not use analytics services, advertising networks, or
tracking pixels of any kind.

## Revoking access and deleting data

You may revoke the Connector's access to your YNAB account at any time:

1. In YNAB, go to **Account Settings → Developer Settings → OAuth
   Applications**, find "Claude for YNAB", and revoke access.
2. In Claude.ai, remove the connector under **Settings → Connectors**.

Because the Connector stores no YNAB data, no deletion request is
necessary on the Connector side. If you have any question about your
data, contact: **trey@moen.ai**

## Changes to this policy

If the Connector's behavior changes to access additional data types beyond
those listed above, this policy will be updated and you will be prompted
to re-consent before any new data is accessed.

## Disclaimer

We are not affiliated, associated, or in any way officially connected with
YNAB or any of its subsidiaries or affiliates. The official YNAB website
can be found at <https://www.ynab.com>. The names YNAB and You Need A
Budget, as well as related names, tradenames, marks, trademarks, emblems,
and images are registered trademarks of YNAB.
