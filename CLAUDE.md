# CLAUDE.md

Operational guide for Claude Code working in this repo. For overlapping info, follow the pointer:

- **What this project is, how auth works, deployment** → `README.md`
- **Domain vocabulary (Budget, Category, Goal, GoalView, Milliunit, Reflect, Month Window), Compute/Render split, domain predicates** → `CONTEXT.md`
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
`npx wrangler secret put <NAME>`. For `wrangler dev`, mirror them in `.dev.vars`.

The `OAUTH_KV` namespace must exist (`npx wrangler kv namespace create OAUTH_KV`)
and its id pasted into `wrangler.jsonc`.

## File-level architecture

The Worker entry, OAuth handler, and YNAB REST client are three files. Every
MCP tool is its own file under `src/tools/`. Cross-cutting concerns live in
flat modules at `src/`.

### Worker entry & auth

- `src/index.ts` — Worker entry. Defines `YnabMcp` (a typed
  `McpAgent<Env, Record<string, never>, Props>` Durable Object) whose
  `init()` calls each tool's `register*(server, getClient)` in order. The
  default export is `new OAuthProvider({ apiHandler: YnabMcp.serve("/mcp"), defaultHandler: ynabAuthHandler, ... })`.

- `src/ynab.ts` — `YnabClient` wraps the YNAB REST API at
  `https://api.ynab.com/v1`. The constructor takes an access token and an
  optional refresh callback; on a 401 the client invokes the callback for a
  fresh token and retries once. Also exports `ynabAuthorizeUrl`,
  `exchangeYnabCode`, and `refreshYnabToken` used by the auth handler.
  Errors throw `YnabError(status, body)`. `fromMilli()` converts milliunits
  for display (see CONTEXT.md for what a milliunit is).

- `src/ynab-auth.ts` — exports `ynabAuthHandler`, the OAuthProvider's
  `defaultHandler`. Owns `GET /authorize` (parses Claude.ai's authorize
  request, stashes it in KV under a random state token, redirects to YNAB)
  and `GET /callback` (validates state via session-bound cookie, exchanges
  the YNAB code for tokens, fetches the YNAB user id, calls
  `env.OAUTH_PROVIDER.completeAuthorization` with the YNAB tokens as `props`).
  Also defines the `Props` type that flows into `YnabMcp.props`.

### Shared modules (`src/`)

- `format.ts` — text/handleError MCP helpers, fmtMoney/padMoney/fmtPercent/pushSection,
  and the line formatters (fmtCategoryLine, fmtTxLine, fmtActivityLine).
- `goals.ts` — `interpretGoal(c, refMonth) → GoalView`. (Concept: CONTEXT.md.)
- `predicates.ts` — domain predicates. (Concept: CONTEXT.md.)
- `month-window.ts` — `resolveMonthWindow(budget, monthsBack) → MonthWindow`;
  also exports `resolveMonthSpec` / `monthEndDate` / `daysInMonth`.
  (Concept: CONTEXT.md.)

### Tools (`src/tools/`)

One file per tool, following the Compute/Render split (defined in CONTEXT.md).
Tool-local helpers (like `expandForCategory` in `get-category-details.ts`,
`historicalNetWorth` in `reflect-net-worth.ts`) live inside the tool file,
not in `src/`.

### Secrets and tokens

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

When adding a new read tool, create `src/tools/<tool-name>.ts`:

- Define the typed result interface first; that's the test surface.
- Compute and render are pure functions. Handler wires them: fetch, compute,
  render, error-wrap with `handleError(e)`.
- Use the passed `getClient()` closure to get a `YnabClient` for the current
  user's token — it carries the refresh-on-401 callback automatically.
- Return text via the `text()` helper: `{ content: [{ type: "text", text: ... }] }`.
- Format money with `fmtMoney(milliunits)`. Always pass the raw milliunit value
  from the API, not pre-converted dollars.
- For categories that carry goals, append `fmtGoalSuffix(c, refMonth)` to the
  line — or read `interpretGoal(c, refMonth)` if you need the structured
  GoalView for custom formatting.
- Append `— id <uuid>` to each line so Claude can reference items in follow-up
  tool calls.
- Wire the tool by adding `registerYourTool(s, getClient)` to `YnabMcp.init()`.
- Write a `.test.ts` alongside it. Compute is pure — fixtures + assertions on
  the result type. Render tests can be sparser (assert on key substrings).
- Filter through the predicates in `src/predicates.ts` rather than inlining
  boolean expressions on the YNAB shape.

See `src/tools/reflect-income-expense.ts` for the canonical example.

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
./scripts/ynab.sh api /budgets
./scripts/ynab.sh api /budgets/$BUDGET_ID | jq '.data.budget.category_groups | length'
./scripts/ynab.sh api "/budgets/$BUDGET_ID/transactions?since_date=2026-01-01"
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

## Read-only

The connector is intentionally read-only right now. The YNAB client has no
write methods, and `NewTransaction` / `toMilli()` were deliberately removed.
YNAB OAuth scope is `read-only` to match. Re-adding mutation needs an
explicit ask — don't sneak it in alongside a read-tool change, and the
scope on the YNAB authorize URL would need to change too.

## YNAB API gotchas

Domain-level YNAB vocabulary (Budget vs Plan, milliunits, Goal matrix,
to_be_budgeted vs Ready to Assign, the two meanings of "Uncategorized")
is in `CONTEXT.md`. The gotchas below are wire-level only.

- `month` parameters accept either `YYYY-MM-01` or the literal string `current`.
- `goal_type` codes (`TB`, `TBD`, `MF`, `NEED`, `DEBT`) are mapped in
  `GOAL_LABEL` — but call sites should go through `interpretGoal` /
  `GoalView` rather than reading `goal_type` directly. See CONTEXT.md.
- YNAB OAuth access tokens expire after 2 hours; refresh tokens are
  long-lived. The `YnabClient` refresh-on-401 handles rotation transparently.
- New YNAB OAuth apps start in "Restricted Mode" with a 25-token cap; submit
  the YNAB review form to lift it before sharing the connector widely.
- `GET /budgets/{id}` does **not** populate `category_group_name` on
  Category rows (top-level or nested under `months[].categories[]`), and
  `category_groups[].categories` comes back as `null`. To get a category's
  group name, build an id→name lookup from `budget.category_groups[]` and
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
