# ADR 0003: Stateless MCP server, OAuth-layer token rotation, and Plan vocabulary

- **Status:** Accepted (2026-11-01)
- **Supersedes:** the `McpAgent` / Durable Object wiring described in earlier
  `CLAUDE.md` revisions; the "Budget" glossary entry in `CONTEXT.md`
- **Related:** ADR 0001 (write tools, `canWrite`), ADR 0002 (structured output),
  `src/index.ts`, `src/server.ts`, `src/token-refresh.ts`, `src/ynab.ts`

## Context

Five months after the last change, every layer of the stack had moved:

- **Cloudflare Agents SDK (0.9 → 0.32).** `McpAgent` (one Durable Object per
  MCP session, built on MCP SDK v1) is deprecated. The supported path is
  `createMcpHandler` from `agents/mcp/server` with an MCP SDK v2 server
  (`@modelcontextprotocol/server`): stateless, a fresh server per request,
  serving both the draft 2026-07-28 protocol and 2025-era clients.
- **workers-oauth-provider (0.7 → 1.2).** `resourceMetadata.resource` is now
  required and every token's audience is bound to it exactly; the implicit
  grant and plain PKCE are gone; `tokenExchangeCallback` can revoke a grant by
  throwing `invalid_grant`; Client ID Metadata Documents (CIMD) are supported.
- **YNAB API (→ v1.88).** v1.79 renamed budgets to **plans** (`/plans/{plan_id}`,
  response keys `plans` / `plan` / `default_plan`); the old paths still answer
  but are undocumented. v1.85 made transaction listings default `since_date` to
  **one year ago**, which silently truncated `triage_inbox` (all
  uncategorized/unapproved) and `reconcile_account` (all unreconciled). v1.76
  added `goal_snoozed_at`; v1.85 added `until_date`.
- **Token refresh was latently broken.** The 401-retry refreshed the YNAB token
  inside a tool call and wrote the result only to Durable Object memory. YNAB
  refresh tokens rotate, so once that object was evicted, the grant still held
  a spent refresh token and the connection failed until the user reconnected.

## Decisions

### D1. Stateless MCP server via `createMcpHandler` + MCP SDK v2

`src/index.ts` builds a fresh server per request with `buildServer(props)`
(`src/server.ts`) inside the OAuthProvider's `apiHandler`. The `YnabMcp` Durable
Object is deleted with migration `v2` (`deleted_classes`). The tools held no
session state, so nothing is lost. Tool files changed only their `McpServer`
import, because SDK v2's `registerTool` still accepts raw zod shapes.

### D2. YNAB tokens rotate only in `tokenExchangeCallback`

At code exchange, Claude.ai's access-token TTL is set to end 5 minutes before
the YNAB access token it carries. When Claude.ai refreshes,
`ynabTokenExchange` refreshes the YNAB token (unless it still has more than 10
minutes left) and stores the new pair as the grant's props. Results:

- Claude.ai's refresh is the single, serialized place where rotation happens.
  Concurrent tool calls never race to spend the same refresh token.
- YNAB 400/401 on refresh throws `invalid_grant`. The provider revokes the
  grant and Claude.ai re-authorizes, instead of retrying a dead grant forever.
  Other failures throw `temporarily_unavailable` (503, retryable).
- `YnabClient` no longer refreshes. A YNAB 401 is an ordinary tool error.
- Transitional: tokens issued before this change have a 1-hour TTL and may
  carry an already-expired YNAB token. The API handler answers those with
  401 `invalid_token`, so the client refreshes right away rather than serving
  YNAB 401s.

### D3. The canonical resource matches existing grants

`MCP_RESOURCE` = `https://claude-for-ynab.moen.ai/mcp`, which is the value the
0.x deployment advertised at `/.well-known/oauth-protected-resource/mcp` and so
the value existing grants carry. Any other value signs every user out.
`wrangler dev` overrides it to `http://localhost:8787/mcp` through `.dev.vars`.

### D4. CIMD enabled

`clientIdMetadataDocumentEnabled: true` plus the `global_fetch_strictly_public`
compat flag. Dynamic registration keeps working.

### D5. "Plan" everywhere

Following YNAB, the codebase says **Plan**:

- tool names: `list_plans`, `get_plan_summary`
- the `plan_id` parameter
- types and client methods: `Plan`, `PlanDetail`, `listPlans`, `getPlan`,
  `getPlanSettings`
- structured-output keys and rendered text.

YNAB wire fields that still say "budget" stay verbatim: `budgeted`,
`to_be_budgeted`, `on_budget`, `goal_months_to_budget`. So does the
on-budget/off-budget Account distinction. `reconcile_account`'s proposal object
was renamed from `plan` to `reconciliation` to avoid a second meaning.
`src/server.test.ts` guards the tool surface against regressions.

This **renames user-visible tools and parameters**. MCP clients rediscover
tools on connect, so the cost is limited to old conversations that referenced
the previous names.

### D6. `plan_id` defaults to `"last-used"`

Every plan-scoped tool takes `plan_id: planIdParam` (`src/schemas.ts`),
optional with a default of YNAB's `last-used` alias. Single-plan users no
longer need a `list_plans` round-trip.

### D7. Explicit `since_date` on every transaction listing

`YnabClient` always sends `since_date` (`ALL_TIME` = `1900-01-01` unless the
caller passes one), which restores the pre-v1.85 semantics. `list_transactions`
gains `until_date` and validates both dates as `YYYY-MM-DD`.

### D8. Tool failures are `isError: true`

`handleError` now flags failures as MCP tool execution errors, consistent with
`scopeDeniedError`. They still carry no `structuredContent` (ADR 0002 D6).

### D9. Snoozed goals are flagged, not reinterpreted

`GoalView.snoozed` is true when `goal_snoozed_at` falls in the reference month,
and the label appends "snoozed this month". YNAB's `goal_under_funded` passes
through unchanged, because the API doesn't document how snoozing affects it.

## Consequences

- No Durable Object cost or session state. Every request is independent.
- Users with pre-change grants refresh or re-authorize once at most. Grants
  whose YNAB refresh token was already spent by the old in-memory refresh
  re-authorize. Everyone else continues silently.
- Users must refer to the new tool names. The smoke script still accepts the
  old `YNAB_TEST_BUDGET_ID` variable, with a warning.

### Deferred

- A read tool over YNAB's money-movement endpoints (v1.78), e.g. "where did
  money assigned to Groceries come from".
- Moving the vitest suite into workerd (`@cloudflare/vitest-plugin`) so
  `src/index.ts` / `src/token-refresh.ts` can be unit-tested. They import
  `cloudflare:workers`, so plain Node can't load them. Today they're covered by
  a local `wrangler dev` probe of the OAuth endpoints.
