# Plan 0001: Implement write tools

Implementation roadmap for [ADR 0001](../adr/0001-add-write-tools.md). Each PR below is meant to land independently; PRs 1–2 are mechanical plumbing with no user-visible change, PRs 3–5 each ship one new tool, PRs 6–7 are docs/tooling.

Branch all PRs off `master`. Stack them in order — each builds on the previous.

## Pre-work (no PR)

- Confirm a dedicated **YNAB test budget** exists in the YNAB account whose tokens we'll use for smoke testing. Pick a non-production budget with a handful of categories and at least one credit-card account so splits/transfers can be exercised. Note its `budget_id` somewhere local; do not check it in.
- Verify `.dev.vars.tokens` is gitignored and current. Re-issue a token if `read-only` is currently saved (see PR 1).

---

## PR 1 — OAuth scope migration plumbing

**Goal:** drop the `read-only` scope and add the `canWrite` Props field. No new tools yet. Invisible to existing users until they reconnect.

**Files:**

- `src/ynab-auth.ts`
  - Remove `scope: "read-only"` from the call to `ynabAuthorizeUrl` (~line 149).
  - Add `canWrite: boolean` to the `Props` interface (~line 22).
  - Set `canWrite: true` on the props object constructed at the end of the callback handler (~line 201).
- `src/index.ts`
  - Remove `"read-only"` from `scopesSupported` (~line 99).
- `src/ynab.ts`
  - `ynabAuthorizeUrl` already accepts an optional `scope`; no change needed.
- `README.md`
  - Update the "Read-only" section to say "read+write" and explain the `canWrite` migration.
- `CLAUDE.md`
  - Update the "Read-only" section accordingly. Note that `YnabClient` no longer has the "no write methods" invariant (PR 2 lifts it).

**Tests:**

- No code tests change in this PR. Behavior change is at the OAuth boundary.
- Manual: `npm run dev`, hit `/authorize` from a fresh client, confirm the YNAB consent screen no longer says "read-only access" and that the resulting token has full scope (use `scripts/ynab.sh` against a write endpoint as a follow-up — but only after PR 6 lands the helper). For PR 1 alone, just confirm the flow completes and a token is issued.

**Acceptance:** `npm run type-check && npm test` clean. Existing reads still work for previously-issued tokens (sanity check via Claude.ai's already-connected session).

---

## PR 2 — `YnabClient` write methods

**Goal:** add the wire-level methods on `YnabClient`. No tool wiring yet, no MCP changes. Lets us write narrow unit tests against the client without touching the tool layer.

**Files:**

- `src/ynab.ts`
  - Make `request<T>` accept a body. Current signature is `private async request<T>(method, path)`; change to `(method, path, body?)`. When `body` is set, JSON-stringify it and add `Content-Type: application/json`.
  - Add `Payee` interface and `listPayees(budgetId)` method.
  - Add `updateCategoryMonth(budgetId, month, categoryId, body: { budgeted: number })` → returns the updated `Category`.
  - Add `updateTransaction(budgetId, transactionId, body: TransactionUpdate)` → returns the updated `Transaction`.
  - Add `updateTransactionsBulk(budgetId, body: { transactions: TransactionBulkUpdate[] })` → returns `{ transactions, transaction_ids }`.
  - Define `TransactionUpdate` and `TransactionBulkUpdate` interfaces locally — keep them narrow (no `amount`, no `date`, no `account_id` at top level; allow `subtransactions[]` with `amount`, `category_id`, `memo`, `payee_name`, `payee_id`).
- `src/ynab.test.ts` (new)
  - Mock `fetch`. Assert each new method sends the right method/path/body/headers, parses success, and surfaces `YnabError` on 4xx/5xx.

**Tests:**

- Add `src/ynab.test.ts` with one test per new method covering body shape, success, and 401-with-refresh.

**Acceptance:** `npm test` covers the new client methods. No tool surface change. `npm run type-check` clean.

---

## PR 3 — `search_payees` (read tool)

**Goal:** simplest of the new tools, doesn't touch `canWrite`. Lets us validate the new-tool pattern before touching writes.

**Files:**

- `src/tools/search-payees.ts` (new)
  - Define `SearchPayeesResult` (the test surface): `{ matches: { id, name, transfer_account_id }[], truncatedFrom?: number }`.
  - `computeSearchPayees(payees: Payee[], query: string, limit = 20)`: lower-case the query, filter by substring on `name`, exclude `deleted`, sort by `name.length` then alpha (favors tighter matches), cap to `limit`. Record `truncatedFrom` when capping.
  - `renderSearchPayees(result)`: line per match, `<name> — id <uuid>`. Existing helpers in `src/format.ts` for line/section formatting.
  - `registerSearchPayees(s, getClient)`: tool name `search_payees`. Inputs: `budget_id: string`, `query: string`, optional `limit: number` (default 20, max 50). Wire: fetch via `client.listPayees(budgetId)`, compute, render, error-wrap with `handleError`.
  - Annotations: `{ readOnlyHint: true, openWorldHint: true, title: "Search Payees" }`.
- `src/tools/search-payees.test.ts` (new)
  - Pure compute tests on a fixture of ~6 payees: substring match, case-insensitive, deleted exclusion, ordering, cap + `truncatedFrom`.
  - One render test asserting the `— id <uuid>` suffix is present.
- `src/index.ts`
  - Import and call `registerSearchPayees(s, getClient)` from `YnabMcp.init()`.

**Tests:**

- Vitest. No mock-client needed in the tool test (compute is pure on the payee fixtures).

**Acceptance:** new tool is callable via MCP; reads only; doesn't gate on `canWrite`.

---

## PR 4 — `assign_to_categories` (write tool)

**Goal:** ship the budget-reassignment surface.

**Files:**

- `src/tools/assign-to-categories.ts` (new)
  - Input shape: `{ budget_id: string, moves: { month: string, category_id: string, set_budgeted_milliunits: number }[] }`. Per-item validation: `month` must match `YYYY-MM-01` or `current`.
  - `computeAssignToCategoriesInput(moves)`: returns the list of `{ index, body }` to send. Pure; covers nothing fancy in v1, but matches the build-body pattern from the ADR's compute/render split for writes.
  - Handler: gate on `props.canWrite` first; if false, return the scope-denial tool execution error (see `src/format.ts` change in PR 5 or inline a helper). For each move, call `client.updateCategoryMonth(budget_id, move.month, move.category_id, { budgeted: move.set_budgeted_milliunits })` in sequence; capture `{ ok: true, before, after }` or `{ ok: false, error }` per item. Best-effort — never short-circuit.
  - `renderAssignToCategoriesResult`: one line per item. Success: `[ok] <month> <category-name>: $X → $Y`. Failure: `[error] <month> <category-id>: <reason>`. Use `fmtMoney`. Include a header summarizing the count.
  - Response: `text(summary, structuredContent: { results: [...] })` where `results` carries the updated YNAB category per success.
  - Annotations: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true, title: "Assign to Categories" }`.
- `src/format.ts`
  - Add a `scopeDeniedError()` helper that returns the standard tool execution error shape `{ content: [text(...)], isError: true }` with the canonical message from ADR §D5.
  - Extend `text()` (or add a sibling helper) to accept optional `structuredContent`.
- `src/tools/assign-to-categories.test.ts` (new)
  - Mock `YnabClient` via a `vi.fn()` factory. Cases:
    - `canWrite: false` → returns scope-denial error, no client calls made.
    - 3 successful moves → one line per move, all calls in order.
    - mid-batch failure → others still run, per-item shape correct.
    - empty `moves: []` → reject at schema or no-op (decide and test).
  - Assert request body shape for one call (`{ budgeted: 450000 }`).

**Tests:**

- All tool tests above. No live integration in this PR.

**Acceptance:** `npm test && npm run type-check` clean. Smoke via PR 6 once that lands; for now, manual verification via `wrangler dev` + a real Claude.ai session against the test budget.

---

## PR 5 — `update_transactions` (write tool)

**Goal:** ship the inbox-edit surface, including splits.

**Files:**

- `src/tools/update-transactions.ts` (new)
  - Input shape: `{ budget_id: string, updates: TransactionUpdateItem[] }`. Each item:
    ```ts
    {
      transaction_id: string;
      category_id?: string | null;
      payee_name?: string;
      payee_id?: string;
      memo?: string | null;
      approved?: boolean;
      cleared?: "cleared" | "uncleared" | "reconciled";
      flag_color?: "red" | "orange" | "yellow" | "green" | "blue" | "purple" | null;
      subtransactions?: Array<{
        amount_milliunits: number;
        category_id?: string | null;
        memo?: string | null;
        payee_name?: string;
        payee_id?: string;
      }>;
    }
    ```
    Validation: if `subtransactions` is present, `category_id` must be absent (or explicitly null). Each subtransaction must have `amount_milliunits` (required by YNAB's `SaveSubTransaction` schema); per-sub `approved`/`cleared`/`flag_color` are NOT exposed (YNAB scopes those to parents only). Sub-amounts are NOT validated client-side to match parent — let YNAB enforce.
  - Build a single bulk `PATCH /budgets/{id}/transactions` body for the whole batch. YNAB's bulk endpoint accepts every field our tool exposes — including `subtransactions` per row — and treats omitted fields as unchanged (verified against `SaveTransactionWithIdOrImportId` schema). Each row carries `id` (our tool always has the transaction id from a prior read) plus the fields the caller wants changed.
  - Handler: gate on `props.canWrite`; either send one bulk PATCH or loop per-item PUT. Capture per-item success/failure.
  - Render: one line per item. Show the diffs that landed using before/after where the YNAB response gives us them: `[ok] tx-abc...: category Dining → Groceries, approved=true`. Failure: `[error] tx-abc...: <reason>`.
  - Response: `text + structuredContent: { results: [...] }` where each result has the updated YNAB transaction.
  - Annotations: `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true, title: "Update Transactions" }`.
- `src/tools/update-transactions.test.ts` (new)
  - Mock-client cases:
    - `canWrite: false` → scope-denial.
    - approve-only batch (`{ id, approved: true }` × 5).
    - mixed batch: 1 split (with `subtransactions`), 2 category changes, 1 memo edit.
    - split with `category_id` set → schema rejection.
    - payee_name only, payee_id only, both (assert payee_id wins).
    - bulk PATCH body shape: each row carries `id` plus only the caller-set fields (omitted fields not sent).

**Tests:**

- All tool tests above.

**Acceptance:** `npm test && npm run type-check` clean. Manual smoke once PR 6 lands.

---

## PR 6 — `scripts/ynab.sh` write modes + smoke recipe

**Goal:** make the manual smoke pass executable.

**Files:**

- `scripts/ynab.sh`
  - In `cmd_url`, drop `&scope=read-only` from the authorize URL string. Re-issuing tokens via this script now yields a write-capable token.
  - Add `cmd_patch` accepting `PATH [BODY]` — POSTs `PATCH` with a JSON body from the second arg or stdin; reuses the auto-refresh path.
  - Add `cmd_put` and `cmd_post` symmetrically.
  - Document in the script header.
- `scripts/smoke-writes.sh` (new) — opt-in recipe that:
  1. Reads `YNAB_TEST_BUDGET_ID` from `.dev.vars.tokens` (or a sibling `.dev.vars.smoke`).
  2. Fetches the current month and picks an arbitrary category.
  3. Records its current `budgeted`.
  4. Patches `budgeted` to `current + 1000` (one dollar in milliunits).
  5. Reads it back; asserts it matches.
  6. Patches it back to the original.
  7. For transactions: picks an unapproved txn, sets `approved: true`, reads back, then sets `approved: false` to leave state clean.
  Outputs PASS/FAIL per step. Fails fast.
- `.gitignore` — add `.dev.vars.smoke` if used.

**Tests:**

- No automated tests. The script *is* the test.

**Acceptance:** run `scripts/smoke-writes.sh` against the test budget; every step PASS.

---

## PR 7 — Docs sweep

**Goal:** reflect the new read+write nature in the user-facing and agent-facing docs.

**Files:**

- `README.md`
  - Update the title/blurb to "read+write."
  - Replace the "Read-only" section with a "Permissions" section covering: what writes are exposed, the `canWrite` migration story, how to reconnect.
- `CLAUDE.md`
  - Remove or rewrite the "Read-only" section. Document: writes are gated on `props.canWrite`; the three new tools and where their conventions live (point at the ADR); the auto-`import_id` decision is N/A because no creates.
  - Update the file-level architecture description to mention the new tool files.
  - Update the "Local dev / e2e testing" section to mention `scripts/smoke-writes.sh`.
- `CONTEXT.md`
  - Add domain language for any new concept introduced (probably none — `subtransaction`, `cleared`, `flag_color` are already YNAB primitives). Skip if no new vocabulary.
- `docs/agents/issue-tracker.md` / `docs/agents/triage-labels.md` — review for staleness; update only if writes change the triage label conventions.

**Tests:**

- None.

**Acceptance:** docs are coherent; a fresh reader of `README` + `CLAUDE.md` understands the connector is now read+write and where to find the details.

---

## Order of operations

```
PR1 (scope plumbing)        ←  invisible
  ↓
PR2 (YnabClient writes)     ←  invisible
  ↓
PR3 (search_payees)         ←  new read tool, no canWrite gate
  ↓
PR4 (assign_to_categories)  ←  first write tool
  ↓
PR5 (update_transactions)   ←  second write tool, includes splits
  ↓
PR6 (scripts/ynab.sh)       ←  test/smoke ergonomics
  ↓
PR7 (docs sweep)            ←  finalize
```

Total estimated PR count: 7 small/medium PRs. Each is independently reviewable and revertible.

## Cross-cutting reminders

- Every new tool: append `— id <uuid>` to each item line (CLAUDE.md convention).
- Every write tool: gate on `props.canWrite` BEFORE any YNAB call.
- Every write tool: return both `text` and `structuredContent`.
- All amounts are milliunits at the tool boundary. Never convert before passing to YNAB. Use `fmtMoney` only in the render layer.
- Use `interpretGoal` / `GoalView` if a write tool ever surfaces goal info (likely not in v1, but be aware).
- Filter through `src/predicates.ts` rather than inlining boolean expressions on YNAB shapes.

## Open follow-ups (not blocking v1)

- Live integration tests in CI against the test budget.
- `outputSchema` declarations on structured content (once a client begins enforcing).
- `search_payees` fuzzy matching beyond substring.
- A `merge_payees` / `rename_payee` tool if proliferation becomes a real problem.
- Revisit `create_transactions` only if a real use case appears.
