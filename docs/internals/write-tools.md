# Write tools

The connector writes only to close the triage loop: the model finds problems with `triage_inbox`,
proposes fixes in chat, the user approves each call in their MCP client, and the fixes land in YNAB. It
stays in the "review and clean up" lane, not manual data entry.

## Scope

Supported: setting a category's monthly `budgeted` (`assign_to_categories`); editing existing
transactions, including categorize, approve, memo, flag, `cleared`, payee, and splits
(`update_transactions`); locking cleared transactions as reconciled (`reconcile_account`); and
payee cleanup, renaming payees (`rename_payees`) and consolidating duplicates (`merge_payees`).
`list_payees` and `review_payees` are the read companions for canonicalizing payees.

Excluded: creating manual transactions, deletes (payees included), scheduled transaction edits other
than a merge re-pointing their payee, category rename/move, and goal edits. Adding any of these is a scope decision for the maintainer,
not an implementation detail. Mistakes are fixed by another write, never by deleting.

## Shape

- **Batched per resource.** One `update_transactions` call and one `assign_to_categories` call cover
  a typical triage pass. Per-operation tools would mean a click-through per transaction in the client's
  approval UI.
- **Absolute values, not deltas.** `assign_to_categories` takes the new `budgeted`, so a retry
  lands on the same state and the chat shows "was $400, now $450". There is no balance
  validation: drawing from Ready to Assign or overspending on purpose is legitimate.
- **Existing transactions only.** `date`, top-level `amount`, and `account_id` are excluded from
  `update_transactions` to keep the model out of data correction. Splits replace the subtransaction
  array wholesale, and a split parent carries no `category_id`.
- **Payees.** `payee_id` wins over `payee_name`. A `payee_name` YNAB cannot match silently creates a
  new payee, which is why `list_payees` exists.
- **Best-effort batches.** YNAB has no bulk endpoint for month categories, so
  `assign_to_categories` loops. Every item is tried, each gets its own result, and nothing rolls
  back. The model reads the per-item results and recovers.
- **Return shape.** Text for the model to quote, plus `structuredContent` with YNAB's post-write
  state, so the model needn't re-fetch. Writes declare no `outputSchema` yet.
- **Annotations.** Writes are `destructiveHint: true` (they overwrite prior values) and
  `idempotentHint: true`.
- **No connector-side safety layer** beyond the write gate, with one exception. The client's per-call
  approval is the human in the loop, and it works because the arguments show the change. A client
  that auto-approves tool calls removes it. `merge_payees` is the exception: its arguments are two
  payee ids that can stand for hundreds of transactions, so it previews unless called with
  `apply: true`, and the approval of the apply call follows a preview the user has seen.

## Payee merges

YNAB's API has no merge, combine, or delete for payees, so `merge_payees` re-points transactions
with a bulk PATCH and scheduled transactions with one PUT each, and leaves the source payees in
place. It cannot move YNAB's renaming rules, so later imports can still land on a source payee; the
user retires sources in YNAB's Manage Payees. What the API can't edit stays on the source and is
reported: parts of an existing split, and split scheduled transactions (see
[YNAB API](./ynab-api.md)). A re-run moves whatever is left, so a partial merge is fixed by
running it again.

`rename_payees` refuses a name another live payee already has: two payees with one name can't be
told apart, and the user meant a merge.

## Write access

YNAB has no separate write scope; omitting `scope` from the authorize URL grants read and write.
New grants carry `canWrite: true` in their props. Grants from before write support have no field,
which reads as `false`. Every write handler checks it before any YNAB call and returns
`scopeDeniedError()`, telling the user to disconnect and reconnect the connector. Never pass
YNAB's raw 403 through. Re-authorization is lazy: reads keep working, and users reconnect only when
they first try a write.

## Reconciliation

`reconcile_account` sets `cleared: "reconciled"` on cleared transactions, so it adds no new kind of
mutation. It writes nothing unless every active transaction is approved and categorized, and the
supplied statement balance equals the account's `cleared_balance`. Otherwise it reports what is
wrong. It never creates YNAB's balance-adjustment transaction, since that needs manual-transaction
creation; the user adjusts in YNAB and re-runs.

YNAB's API does not expose a linked account's bank-reported balance, only `balance`,
`cleared_balance`, `uncleared_balance`, and the `direct_import_*` / `last_reconciled_at` health
fields. The caller must supply the statement balance.

## Testing

Unit tests mock `YnabClient` and cover request bodies, response interpretation, per-item errors,
and the write gate. There is no live test; try write changes by hand against a test plan.
