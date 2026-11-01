# Privacy policy: YNAB Connector

Last updated: 2026-11-01

This policy describes how the YNAB Connector (the "Connector") handles data
it accesses through the YNAB API. The Connector is a personal-use OAuth
application. It lets the AI assistant you connect it to (your "MCP client",
such as Claude) read and edit your YNAB data on your behalf.

## What the Connector accesses

When you authorize the Connector against your YNAB account, it requests full
read and write access. That gives the Connector access to:

- Your plans (names, IDs, currency): read
- Accounts and balances: read
- Categories, category groups, and goal data: read
- Transactions and split transactions: read and edit (categorize, approve,
  memo, flag, mark cleared or reconciled, set payee, split across categories)
- Monthly summaries: read
- Each category's budgeted amount per month: read and edit (move money
  between categories, fund from Ready to Assign)
- Your YNAB user ID, used as an internal identifier (see below)

The Connector does not create new transactions, delete anything, manage
scheduled transactions, or rename or merge payees or categories. YNAB's
OAuth grants full access or none. If you want read-only access, don't
authorize the Connector, or revoke its access in YNAB at any time (see
"Revoking access and deleting data" below). Connections authorized before
write support shipped stay read-only on the Connector's side: write tools
refuse to act on those tokens and ask you to reconnect to grant write
access.

## How data is handled

### No stored financial data

The Connector keeps no database of your transactions, balances, or any
other YNAB data. Each request from your MCP client makes a live call to the
YNAB API. The Connector returns the response to the client and then
discards it. Nothing is cached on the server.

### OAuth tokens

The Connector encrypts your YNAB access token and refresh token into the
bearer token it issues to your MCP client. It does not store your YNAB
tokens in plaintext at rest. They exist only inside the encrypted bearer,
which the Connector decrypts in memory for each request from your MCP
client. During authorization, the Connector keeps a short-lived OAuth state
record (10 minutes at most) in Cloudflare Workers KV. That record contains
no YNAB data and is deleted automatically when authorization completes or
expires.

### Logs

The Connector runs on Cloudflare Workers with Cloudflare's default
observability (request logs and error traces). These logs do not record YNAB
response bodies. They may record request paths, HTTP status codes, and error
messages. Cloudflare's own privacy policy governs how Cloudflare handles
this data.

### Security

The Connector accepts HTTPS traffic only. Your YNAB tokens are encrypted
inside the OAuth bearer with the standard encryption scheme of the
`@cloudflare/workers-oauth-provider` library.

### Retention

The Connector stores no YNAB data, so there is nothing to retain or delete on
the data side. The encrypted OAuth bearer lives only with your MCP client.
Revoking the Connector in YNAB or disconnecting it in your MCP client ends
all access immediately.

## Third parties

The Connector does not share, sell, or otherwise pass YNAB data to any third
party. YNAB data moves only between:

1. YNAB's API, over the OAuth connection you authorized.
2. The Connector, running on Cloudflare Workers. Cloudflare provides the
   hosting infrastructure only and does not receive YNAB data as a
   recipient.
3. The MCP client you connected (for example, Anthropic's Claude), acting on
   your behalf. That provider's own privacy policy governs how it handles
   the data it receives.

The Connector uses no analytics services, advertising networks, or tracking
pixels.

## Revoking access and deleting data

You can revoke the Connector's access to your YNAB account at any time:

1. In YNAB, go to **Account Settings → Developer Settings → OAuth
   Applications**, find the Connector, and revoke access.
2. In your MCP client, remove the connector. In Claude.ai, it's under
   **Settings → Connectors**.

The Connector stores no YNAB data, so you don't need to request deletion
from the Connector. For any question about your data, contact
trey@moen.ai.

## Changes to this policy

If the Connector starts accessing data types beyond those listed above, this
policy will be updated, and you will be asked to consent again before the
Connector accesses any new data.

## Disclaimer

We are not affiliated, associated, or in any way officially connected with
YNAB or any of its subsidiaries or affiliates. The official YNAB website is
<https://www.ynab.com>. The names YNAB and You Need A Budget, as well as
related names, tradenames, marks, trademarks, emblems, and images are
registered trademarks of YNAB.
