# ADR 0001: Add write tools for triage and budget reassignment

- **Status:** Proposed (2026-05-27)
- **Supersedes:** —
- **Related:** `CONTEXT.md` (Reflect & Triage, Compute/Render split, GoalView), `CLAUDE.md` (Read-only section)

## Context

The connector is read-only today: `YnabClient` has no write methods, `toMilli()` was deliberately removed, and the YNAB OAuth scope is fixed to `read-only` (`src/ynab-auth.ts`, `src/index.ts`). This is sufficient for the Reflect tabs and triage *inspection*, but it makes the triage workflow asymmetric — Claude can identify problems in the budget but cannot help fix them.

The job to be done that motivates writes is the recurring "review the inbox" pass:

1. Claude calls `triage_inbox` and surfaces unapproved/uncategorized transactions, overspent categories, and underfunded goals.
2. Claude proposes a set of fixes in chat: approvals, categorizations, splits, and money moves between categories.
3. The user confirms in chat (and through Claude.ai's per-call approval UI).
4. The fixes land in YNAB.

Step 4 is the missing piece. Without it, the user has to retype Claude's proposal into the YNAB app by hand.

Two write surfaces cover the realistic end-to-end flow:

- **Reassign Category budgets** — set per-month `budgeted` so Claude can move money between categories ("pull $40 from Dining to cover Groceries underfunding").
- **Edit existing transactions** — categorize, approve, memo, flag, set cleared, split, and assign payee on bank-imported rows.

Out of scope for v1: creating manual transactions, deleting anything, scheduled transactions, payee rename/merge, category rename/move-group, goal edits. The connector stays in the "review and clean up" lane, not the "manual data entry" lane.

## Decisions

### D1. Three new tools, batched per resource

Add three tools under `src/tools/`:

| Tool | Kind | YNAB endpoint |
|---|---|---|
| `assign_to_categories` | write | `PATCH /budgets/{id}/months/{month}/categories/{cat}` (looped) |
| `update_transactions` | write | `PATCH /budgets/{id}/transactions` (bulk) and/or `PUT /budgets/{id}/transactions/{id}` |
| `search_payees` | read | `GET /budgets/{id}/payees` filtered client-side |

Each write tool accepts a batch in a single call. A typical triage session is one call to `update_transactions` (covering all approvals, categorizations, splits) plus one call to `assign_to_categories` (covering all money moves). This matches Anthropic's published guidance to "consolidate functionality, handling potentially multiple discrete operations under the hood" and is honest about the unit of consent in Claude.ai's per-call approval UI.

Rejected alternatives:

- **Atomic per-operation tools** (`approve_transaction`, `move_money`, ...) — too chatty; 5 click-throughs to approve 5 transactions; loses the batch-bulk efficiency YNAB's API already offers.
- **Intent-shaped tools** (`move_money(from, to, amount)`) — embeds business logic in the tool; harder to test; awkward when "from" is Ready to Assign.
- **Plan-and-apply** (single `apply_changes(plan)`) — over-engineered for v1; presumes a stable structured plan type the system doesn't have yet.

### D2. `assign_to_categories`: absolute set only, no balance validation

The tool accepts `{ month, category_id, set_budgeted_milliunits }` per item — the literal new value, not a delta. Reasoning:

- **Idempotent on retry.** Same args twice → same final state. Deltas double-apply on retry and the connector cannot reliably distinguish a retry from an intentional repeat.
- **Forces Claude to see current state.** Triage and `get_month` already give Claude the current `budgeted` values in context, so the arithmetic is free. Setting an absolute value also makes the change auditable in chat ("setting Groceries to $450, was $400") — clearer than "+$50."
- **Matches YNAB's wire shape.** No client-side read-then-write loop.

No balance validation. Non-zero-sum moves are legitimate (drawing from Ready to Assign, adding new income, deliberately overspending). The tool writes what it's told.

### D3. `update_transactions`: existing transactions only; splits folded in

The tool edits *already-imported* transactions. The schema exposes the minimal set:

- Per item: `transaction_id` (required); optional `category_id`, `payee_name`, `payee_id`, `memo`, `approved`, `cleared`, `flag_color`, `subtransactions`.
- `subtransactions[]`: `amount_milliunits`, `category_id?`, `memo?`, `payee_name?`, `payee_id?`. When provided, the parent's `category_id` must be null/absent.

Excluded from the schema (even though YNAB accepts them): `date`, `amount` at the top level, `account_id`. None of these make sense for bank-imported rows in the triage workflow; excluding them keeps Claude out of "data correction" territory.

Splits live inside `update_transactions` rather than as a separate `split_transaction(s)` tool because YNAB's API treats them as one endpoint, real triage flows mix splits with non-split updates, and one tool is easier to teach Claude. The cost is one validation rule (`subtransactions` excludes top-level `category_id`).

Splits replace the array wholesale on PUT — partial sub-edits aren't supported. The tool description must say so explicitly.

### D4. Payee input: name or id; new `search_payees` for canonicalization

Write tools accept `payee_name` (string) and/or `payee_id` (UUID). If both, `payee_id` wins. If only `payee_name`, YNAB performs its name-match-or-auto-create behavior.

To let Claude avoid payee proliferation when it matters (bulk receipt review, recurring vendor categorization), add a `search_payees(budget_id, query)` read tool. It fetches `GET /payees`, filters case-insensitively on the query, sorts, and caps at ~20 results.

### D5. Drop `read-only` scope; lazy re-auth via a `canWrite` Props field

YNAB's OAuth model has no separate write scope — omitting the `scope` parameter on the authorize URL yields full read+write. The change:

- Drop `scope: "read-only"` from `ynabAuthorizeUrl` in `src/ynab-auth.ts`.
- Remove `"read-only"` from `scopesSupported` in `src/index.ts`.
- Add `canWrite: boolean` to the `Props` interface in `src/ynab-auth.ts`. New tokens are issued with `canWrite: true`; tokens issued before this change deserialize with `props.canWrite === undefined`, which is treated as `false`.

Write tools gate on `canWrite` at the top of the handler — before any YNAB call. If `canWrite` is false, they return a **tool execution error** (MCP `isError: true`) with actionable text:

> Your YNAB connection was granted read-only access. To enable budget edits, disconnect and reconnect the YNAB connector in Claude.ai's settings — accept the broader permission scope on the YNAB authorization page.

Per the MCP spec (2025-11-25), tool execution errors are the right mechanism for situations the model can self-correct or paraphrase to the user; protocol errors are for things the model can't fix. Per Anthropic's tool-writing guidance, the message reads as a paraphrasable instruction.

Reads continue working unchanged for everyone. Re-auth happens lazily — only when a user first reaches for a write tool.

### D6. Idempotency

- `assign_to_categories` — naturally idempotent (absolute set).
- `update_transactions` — naturally idempotent (PUT/PATCH with the same fields → same end state).
- No `create_transactions` in v1, so no `import_id` machinery needed.

All three write tools advertise `idempotentHint: true` on their MCP annotations.

### D7. Batch failure model: best-effort, per-item result

YNAB has bulk endpoints for transactions (`PATCH /transactions`) but not for per-month category writes, so `assign_to_categories` must loop client-side. When some items succeed and some fail:

- Try every item. Do not stop on first error.
- Return a per-item result array: `[{ok}, {ok}, {error: "..."}, {ok}]`.
- Surface successes and failures in the human-readable text and the `structuredContent` block.

No rollback attempt. No fake atomicity. Claude reads the response and recovers ("3 of 5 moves landed; 2 failed because the category was deleted — want me to redirect those?").

### D8. Response shape: text plus `structuredContent`

Every write tool returns both:

- **Human-readable `text` content** — formatted summary using the existing `text()`/`pushSection()` helpers, in the same style as the read tools. One line per item: `[ok] Groceries: $400 → $450`, or `[error] tx-abc123: ...`.
- **`structuredContent`** carrying the YNAB-returned post-state per item (the updated category objects, the updated transaction objects).

The structured payload lets Claude keep working in-conversation without an extra `get_month`/`list_transactions` round trip after a write. MCP 2025-11-25 explicitly supports this dual-shape return and Claude's tool-use stack prefers structured content when present.

`outputSchema` declaration is deferred — we attach structured content without a schema in v1 and add schemas later if a client begins enforcing them.

### D9. Tool annotations on every tool

All tools (existing reads included) get an `annotations` block. Hints:

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| existing reads | true | — | — | true |
| `search_payees` | true | — | — | true |
| `assign_to_categories` | false | true | true | true |
| `update_transactions` | false | true | true | true |

`destructiveHint: true` on the writes is the MCP-correct read: both tools overwrite prior state (the previous `budgeted` value, the previous category assignment, the previous memo), even though the loss is logically reversible by another write. Clients use this for UI like "show a stronger warning."

### D10. Safety: rely on Claude.ai approval + chat consent

No connector-level safety layer beyond `canWrite`:

- No dry-run mode and no `preview_*` tools — Claude already explains intent in chat before acting, and dry-run creates an awkward "you previewed but didn't apply" state.
- No threshold-based `confirm: true` flags — paternalistic and arbitrary.
- No deletes at all in v1 — categorize/approve/memo/split covers the triage flow without needing destructive ops. Mistakes are fixed by re-categorizing, not by deleting.

The MCP spec's `"there SHOULD always be a human in the loop"` requirement is satisfied by Claude.ai's per-call approval UI; we don't try to re-implement it.

### D11. Testing: mock-`YnabClient` Vitest specs + manual smoke via `scripts/ynab.sh`

- Per-tool Vitest spec under `src/tools/` mocks `YnabClient` to capture the request body and return canned responses. Tests cover: body shape, response interpretation, per-item batch errors, and the `canWrite` gate.
- Extend `scripts/ynab.sh` with `patch` / `post` / `put` modes and a smoke recipe. The author runs the recipe against a dedicated YNAB test budget (separate from the main budget; created in the same YNAB account) before each deploy that touches writes.
- No automated live integration in CI: too much blast radius for a personal connector, and the dedicated test-budget cleanup is unautomated.

This keeps the Compute/Render split intact for writes: `compute*` becomes "build request body + interpret response," `render*` becomes the per-item summary, and the handler does the same fetch · compute · render · error-wrap dance as before.

## Consequences

### Positive

- **Triage closes the loop.** Claude can carry out the fixes it identifies without the user retyping into the YNAB app.
- **Tight tool surface.** Three tools — one batched call per resource — keep the prompt cost and Claude's planning load low.
- **Lazy re-auth.** Existing connections keep working for reads; users only re-authorize when they first try to write.
- **Idempotent by construction.** Absolute-set semantics and the no-creates decision mean every write tool is retry-safe.

### Negative / risks

- **Schema complexity in `update_transactions`.** The optional `subtransactions[]` shape with the "if present then `category_id` must be null" rule is one more thing to teach Claude (in the tool description) and one more validation path.
- **Partial-batch state.** A failed item in `assign_to_categories` leaves the budget half-moved. Mitigated by clear per-item error reporting and Claude's ability to read it and recover; not eliminated.
- **Payee proliferation.** If Claude passes `payee_name` for a vendor that YNAB doesn't match to an existing payee, YNAB silently creates a new one. `search_payees` exists to help Claude avoid this, but Claude has to choose to use it.
- **Scope-denial UX.** Existing users hit a tool execution error the first time they try a write and have to know to "disconnect and reconnect" in Claude.ai. The error text is the only mechanism guiding them.
- **No automated end-to-end coverage.** The mock-client tests catch wire-shape regressions but not actual YNAB-side validation drift. We're relying on the manual smoke pass.

### Future work explicitly deferred

- `create_transactions` (manual entries) — only revisit if the use case is real, not speculative.
- Deletes / `delete_transactions` — same.
- Goal edits, category rename/move, payee merge — all deferred.
- `outputSchema` declarations on the structured content.
- Automated integration tests in CI against the test budget.
- Real fuzzy matching in `search_payees` (v1 is substring).

## Addendum (2026-05-29): `reconcile_account`

Added a fourth tool, `reconcile_account`, that performs YNAB's account
reconciliation in "lock-only" form. It does **not** expand the write surface
established above — it composes the existing "set `cleared`" capability of
`update_transactions`:

- Inputs: `budget_id`, `account_id`, `statement_balance_milliunits`.
- It refuses to write (and reports what's wrong) unless **every** active
  transaction in the account is approved AND categorized — reconciliation should
  lock in verified reality, not paper over an un-triaged inbox.
- When verified and the statement balance equals the account's `cleared_balance`,
  it bulk-PATCHes every `cleared` (not-yet-`reconciled`) transaction to
  `cleared: "reconciled"`. When the balances differ, it writes nothing and
  reports the discrepancy plus the uncleared transactions.
- It deliberately does **not** create YNAB's "Reconciliation Balance Adjustment"
  transaction when balances differ — that requires manual-transaction creation,
  which remains out of scope (deferred above). The user makes the adjustment in
  the YNAB app, then re-runs.
- Why this needs no new ADR decision: the only YNAB mutation it performs is
  setting `cleared` on existing rows, already sanctioned by D3 and gated by the
  same `canWrite` check (D5), best-effort per-item result model (D7), and
  text+`structuredContent` return (D8).

Also noted during this work: YNAB's public API does **not** expose a linked
account's bank-reported balance (confirmed against the OpenAPI `Account` schema —
only `balance` / `cleared_balance` / `uncleared_balance`, plus the
`direct_import_linked` / `direct_import_in_error` / `last_reconciled_at` health
fields). So the in-app "your linked balance matches" indicator can't be
replicated; the statement balance must be supplied by the caller. The
link-health fields are now surfaced in `list_accounts` and `reconcile_account`
output.
