# CLAUDE.md

Operational guide for Claude Code working in this repo. For overlapping info, follow the pointer:

- **What this project is, how auth works, deployment** → `README.md`
- **Domain vocabulary (Plan, Category, Goal, GoalView, Milliunit, Reflect, Month Window), Compute/Render split, domain predicates** → `CONTEXT.md`
- **Agent-skill wiring (issue tracker, triage labels, how to consume domain docs)** → `docs/agents/`

## Commands

```bash
npm run dev            # wrangler dev on localhost:8787
npm run type-check     # tsc --noEmit
npm test               # vitest, plain Node (no Workers pool)
npm run deploy         # wrangler deploy
npx wrangler tail      # stream live logs from the deployed Worker
npx wrangler types     # regenerate worker-configuration.d.ts after wrangler.jsonc changes
```

Secrets (`YNAB_CLIENT_ID`, `YNAB_CLIENT_SECRET`) are set with
`npx wrangler secret put <NAME>`. For `wrangler dev`, mirror them in `.dev.vars`
along with `MCP_RESOURCE=http://localhost:8787/mcp` (see `.dev.vars.example`) —
OAuth tokens are bound to that URL. `npm run dev` passes
`--local-upstream localhost:8787`; without it, wrangler rewrites the request
host to the custom-domain route and local OAuth discovery breaks.

npm 11 blocks dependency install scripts unless allowed: `package.json`
`allowScripts` approves `esbuild` and `workerd` (wrangler needs both).

The `OAUTH_KV` namespace must exist (`npx wrangler kv namespace create OAUTH_KV`)
and its id pasted into `wrangler.jsonc`.

## File-level architecture

The Worker entry, MCP server factory, token refresh, OAuth handler, and YNAB
REST client are separate files. Every MCP tool is its own file under
`src/tools/`. Cross-cutting concerns live in
flat modules at `src/`.

### Worker entry & auth

- `src/index.ts` — Worker entry. `createProvider(env)` builds the
  `OAuthProvider` (workers-oauth-provider 1.x) once per isolate; its
  `apiHandler` serves `/mcp` with `createMcpHandler` from `agents/mcp/server`,
  building a fresh MCP SDK v2 server per request from the token's `props`.
  The server is **stateless** — no Durable Object, no MCP session state.
  `resourceMetadata.resource` comes from the `MCP_RESOURCE` var; every token's
  audience is bound to it, so it must match what existing grants carry
  (`https://claude-for-ynab.moen.ai/mcp`). Changing it signs every user out.

- `src/server.ts` — `buildServer(props)` creates the `McpServer`
  (`@modelcontextprotocol/server`), sets serverInfo + instructions, and calls
  each tool's `register*(server, getClient[, getProps])`.

- `src/token-refresh.ts` — `ynabTokenExchange`, the provider's
  `tokenExchangeCallback`. Claude's access token TTL is pinned to end a few
  minutes before the YNAB token inside it; when Claude refreshes, this
  refreshes the YNAB token and stores the new pair as the grant's props.
  That's the **only** place YNAB tokens rotate (YNAB refresh tokens rotate, so
  refreshing inside concurrent tool calls would race). Dead YNAB refresh
  tokens throw `invalid_grant`, which revokes the grant and makes Claude
  re-authorize. `ynabTokenExpired` + `expiredTokenResponse` answer 401
  `invalid_token` for legacy tokens whose YNAB token already expired.

- `src/ynab.ts` — `YnabClient` wraps the YNAB REST API at
  `https://api.ynab.com/v1` (`/plans/...` paths). The constructor takes an
  access token; it doesn't refresh (see `token-refresh.ts`). Transaction
  listings always send `since_date` (default `ALL_TIME`) — see API gotchas.
  Also exports `ynabAuthorizeUrl`,
  `exchangeYnabCode`, and `refreshYnabToken` used by the auth handler.
  Errors throw `YnabError(status, body)`. `fromMilli()` converts milliunits
  for display (see CONTEXT.md for what a milliunit is).

- `src/ynab-auth.ts` — exports `ynabAuthHandler`, the OAuthProvider's
  `defaultHandler`. Owns `GET /authorize` (parses Claude.ai's authorize
  request, stashes it in KV under a random state token, redirects to YNAB)
  and `GET /callback` (validates state via session-bound cookie, exchanges
  the YNAB code for tokens, fetches the YNAB user id, calls
  `env.OAUTH_PROVIDER.completeAuthorization` with the YNAB tokens as `props`).
  Also defines the `Props` type that flows into `buildServer(props)`.

### Shared modules (`src/`)

- `format.ts` — text/handleError MCP helpers, `result(text, structured)` for
  write tools that return text + `structuredContent`, `scopeDeniedError()`
  for the canonical "this token doesn't have write scope" tool execution
  error, plus fmtMoney/padMoney/fmtPercent/pushSection and the line
  formatters (fmtCategoryLine, fmtTxLine, fmtActivityLine).
- `schemas.ts` — shared zod inputs. `planIdParam` is the `plan_id` every
  plan-scoped tool takes: optional, defaulting to YNAB's `"last-used"` alias.
- `goals.ts` — `interpretGoal(c, refMonth) → GoalView`. (Concept: CONTEXT.md.)
- `predicates.ts` — domain predicates. (Concept: CONTEXT.md.)
- `month-window.ts` — `resolveMonthWindow(plan, monthsBack) → MonthWindow`;
  also exports `resolveMonthSpec` / `monthEndDate` / `daysInMonth`.
  (Concept: CONTEXT.md.)

### Tools (`src/tools/`)

One file per tool, following the Compute/Render split (defined in CONTEXT.md).
Tool-local helpers (like `expandForCategory` in `get-category-details.ts`,
`historicalNetWorth` in `reflect-net-worth.ts`) live inside the tool file,
not in `src/`.

Write tools (`assign-to-categories.ts`, `update-transactions.ts`) follow the
same convention with two adaptations: (a) Compute splits into a pure
`buildBody`/`interpretResponse` pair plus an effectful `apply*` orchestrator,
and (b) the `register*` function takes a third `getProps()` closure so the
handler can check `props.canWrite` before any YNAB call.

### Secrets and tokens

- `YNAB_CLIENT_ID` / `YNAB_CLIENT_SECRET` — for the connector's OAuth client
  registration with YNAB. Held by the Worker only.

Per-user YNAB access + refresh tokens never live in our storage — they're
encrypted into the bearer token issued back to Claude.ai (the
`workers-oauth-provider` `props` mechanism) and surface on each request as
`ctx.props` in the API handler, which passes them to `buildServer`. The
`OAUTH_KV` namespace stores
provider-internal state (registered clients, auth codes, hashed token
secrets) and the short-lived state token used to bridge `/authorize` →
YNAB → `/callback`.

There is no Durable Object. The old `YnabMcp` (`McpAgent`, deprecated upstream)
was deleted with migration tag `v2` (`deleted_classes`) in `wrangler.jsonc`;
keep both migration entries — Cloudflare replays the history by tag. Rationale
for the stateless server, token rotation, and Plan vocabulary: ADR 0003.

## Tool conventions

When adding a new read tool, create `src/tools/<tool-name>.ts`:

- Define the typed result interface first; that's the test surface.
- Compute and render are pure functions. Handler wires them: fetch, compute,
  render, error-wrap with `handleError(e)`.
- Take `plan_id: planIdParam` (from `src/schemas.ts`) for plan-scoped tools.
- Use the passed `getClient()` closure to get a `YnabClient` for the current
  user's token.
- Return text via the `text()` helper: `{ content: [{ type: "text", text: ... }] }`.
- Format money with `fmtMoney(milliunits)`. Always pass the raw milliunit value
  from the API, not pre-converted dollars.
- For categories that carry goals, append `fmtGoalSuffix(c, refMonth)` to the
  line — or read `interpretGoal(c, refMonth)` if you need the structured
  GoalView for custom formatting.
- Append `— id <uuid>` to each line so Claude can reference items in follow-up
  tool calls.
- Wire the tool by adding `registerYourTool(server, getClient)` to
  `buildServer()` in `src/server.ts`, and add its name to `EXPECTED_TOOLS` in
  `src/server.test.ts` (which drives every tool through a real MCP client).
- Set MCP `annotations: { readOnlyHint: true, openWorldHint: true }` on read tools.
- Write a `.test.ts` alongside it. Compute is pure — fixtures + assertions on
  the result type. Render tests can be sparser (assert on key substrings).
- Filter through the predicates in `src/predicates.ts` rather than inlining
  boolean expressions on the YNAB shape.

See `src/tools/reflect-income-expense.ts` for the canonical read-tool
example, and `src/tools/assign-to-categories.ts` for the canonical write-tool
example (note the `getProps()` parameter, the `props.canWrite` gate at the
top of the handler, and the `result(text, structured)` return shape).

## Local dev / e2e testing

For ad-hoc API probing or verifying a tool's behaviour against raw YNAB data,
bypass the MCP layer and hit `api.ynab.com/v1` directly with a user OAuth
token. `scripts/ynab.sh` automates the dance.

### One-time setup

1. `cp .dev.vars.example .dev.vars` and fill in `YNAB_CLIENT_ID` /
   `YNAB_CLIENT_SECRET` (same values that are set as Worker secrets in prod).

### Get a YNAB user token

```bash
./scripts/ynab.sh url                 # print the authorize URL
# Visit it. The browser redirects to http://localhost:8787/callback?code=…
# which won't load — that's fine, just copy the `code` value out of the URL.
./scripts/ynab.sh exchange <CODE>     # saves tokens to .dev.vars.tokens
```

`.dev.vars.tokens` is gitignored. Access tokens last 2 hours; refresh
tokens are long-lived.

### Run API calls

```bash
./scripts/ynab.sh api /plans
./scripts/ynab.sh api /plans/$PLAN_ID | jq '.data.plan.category_groups | length'
./scripts/ynab.sh api "/plans/$PLAN_ID/transactions?since_date=2026-01-01"
```

The helper injects `Authorization: Bearer …`, auto-refreshes when the
saved expiry has passed, and retries once on a 401. Extra arguments after
the path are forwarded to `curl` verbatim.

### Local worker + MCP

`npm run dev` runs the Worker at `localhost:8787`. The OAuth flow above
uses `localhost:8787/callback` as its redirect URI even though the
helper-driven flow doesn't actually need the worker to be running — the
browser just lands on a connection-refused page where the `code` is still
in the URL.

Driving the MCP layer end-to-end locally is harder: it requires Claude.ai-side
OAuth 2.1 with PKCE (dynamic client registration), which is awkward to script.
For end-to-end MCP testing, prefer the deployed Worker plus a real client
(Claude.ai connector, Claude Code, MCP Inspector) — `npx wrangler tail`
streams the live request log so you can watch tool calls in real time.

### Smoke-testing write endpoints

`scripts/smoke-writes.sh` round-trips a budgeted-amount change and an
approval toggle against a dedicated YNAB test plan — exits non-zero on any
mismatch. Setup:

1. Create a "Claude Connector Test" plan in your YNAB account (separate
   from your real one) with a few categories and a few transactions.
2. Add `YNAB_TEST_PLAN_ID=<that-plan-id>` to `.dev.vars.smoke`
   (gitignored via `.dev.vars.*`).
3. Run the recipe:

   ```bash
   ./scripts/smoke-writes.sh
   ```

Run it before any deploy that touches the write tools.

## Writes

The connector supports a narrow set of write tools (categorize/approve/split
existing transactions, reassign category plans, reconcile an account against a
bank statement, search payees). Scope and rationale:
`docs/adr/0001-add-write-tools.md`. Implementation roadmap:
`docs/plans/0001-write-tools-implementation.md`.

`reconcile_account` composes the existing "set `cleared`" capability: it only
locks already-existing transactions as `reconciled` (no new write surface). It
refuses to write unless every active transaction is approved + categorized and
the supplied statement balance equals the account's `cleared_balance`. It
deliberately does **not** create the YNAB balance-adjustment transaction — that
needs manual-transaction creation, still excluded below.

Wire-level conventions for new write tools:

- The YNAB authorize URL no longer pins `scope=read-only`. Tokens issued under
  this flow carry full read+write access. Tokens issued before this change
  remain effectively read-only — `Props.canWrite` deserializes to `undefined`
  for them, which write tools must treat as `false`.
- Every write handler **MUST** check `getProps().canWrite` before any YNAB
  call. If false, return a tool execution error (`isError: true`) telling the
  user to disconnect and reconnect the connector in Claude.ai to grant write
  access. Don't propagate raw 403s from YNAB; we own the error message.
- v1 explicitly excludes: creating manual transactions, deletes, scheduled
  transactions, payee rename/merge, category rename/move, goal edits. Adding
  any of these requires an ADR update.

## YNAB API gotchas

Domain-level YNAB vocabulary (Plan, milliunits, Goal matrix,
to_be_budgeted vs Ready to Assign, the two meanings of "Uncategorized")
is in `CONTEXT.md`. The gotchas below are wire-level only.

- `month` parameters accept either `YYYY-MM-01` or the literal string `current`.
- `goal_type` codes (`TB`, `TBD`, `MF`, `NEED`, `DEBT`) are mapped in
  `GOAL_LABEL` — but call sites should go through `interpretGoal` /
  `GoalView` rather than reading `goal_type` directly. See CONTEXT.md.
- Resource paths are `/plans/{plan_id}/...` and response keys are `plans` /
  `plan` / `default_plan` (v1.79, 2026-03). The legacy `/budgets` paths still
  answer with the old keys but are undocumented — don't use them.
  `plan_id` also accepts `last-used` (and `default`, if the OAuth app enables
  default-plan selection).
- **Transaction listings default `since_date` to one year ago** when it's
  omitted (v1.85, 2026-05). `YnabClient` always sends an explicit
  `since_date` (`ALL_TIME` unless the caller passes one) so "all
  uncategorized" / "all unreconciled" queries aren't silently truncated.
  `until_date` is supported too.
- Amount fields now come with `*_formatted` / `*_currency` siblings (v1.82).
  We ignore them: structured output stays in milliunits (ADR 0002).
- YNAB OAuth access tokens expire after 2 hours; refresh tokens are
  long-lived and rotate. Rotation is handled by `src/token-refresh.ts` (see
  above), never inside a tool call.
- New YNAB OAuth apps start in "Restricted Mode" with a 25-token cap; submit
  the YNAB review form to lift it before sharing the connector widely.
- `GET /plans/{id}` does **not** populate `category_group_name` on
  Category rows (top-level or nested under `months[].categories[]`), and
  `category_groups[].categories` comes back as `null`. To get a category's
  group name, build an id→name lookup from `plan.category_groups[]` and
  resolve through each category's `category_group_id`. See the
  `reflect_income_expense` tool for the pattern.

## Agent skills

Issue tracker, triage labels, and how to consume `CONTEXT.md` + ADRs are
documented under `docs/agents/`:

- `docs/agents/issue-tracker.md` — issues live in GitHub Issues for
  `greatgitsby/ynab-connector` via the `gh` CLI.
- `docs/agents/triage-labels.md` — canonical label names.
- `docs/agents/domain.md` — single-context repo; read `CONTEXT.md` (and
  `docs/adr/` once it exists) before exploring.
