# Glossary

Terms whose meaning matters across the connector. YNAB's own vocabulary comes first; this
project's terms follow.

## YNAB

| Term | Meaning |
| --- | --- |
| Plan | The top-level YNAB container for accounts, categories, months, and transactions, formerly "budget". Always say Plan, except when quoting wire fields that still say "budget" (`budgeted`, `to_be_budgeted`, `on_budget`, `goal_months_to_budget`) or the on-budget/off-budget account distinction. |
| Account | A bank account, credit card, loan, or tracking line in a Plan. On-budget accounts feed Ready to Assign; off-budget accounts are tracked only. |
| Category Group | A named cluster of Categories, with its own `hidden`/`deleted` flags. |
| Category | A budgeting bucket with per-month `budgeted`, `activity`, and `balance`, and optionally a Goal. `internal` categories (such as "Inflow: Ready to Assign" and "Uncategorized") are synthetic and stay out of spending views. |
| Goal | A target on a Category, encoded as a matrix of `goal_*` fields. Read it only through GoalView. |
| Transaction | A signed row on an account (negative is outflow). A transfer has `transfer_account_id` set and no category by design. |
| Subtransaction | One part of a split. Its parent's `category_id` is null; per-category sums count the subs and skip the parent. |
| Milliunit | YNAB's amount encoding: integer thousandths of a currency unit. $1.00 is 1000. |
| Ready to Assign | Unassigned cash, read from `month.to_be_budgeted`. Never read it from the "Inflow: Ready to Assign" category's `balance`, which is a lifetime cumulative figure. Render it as "Ready to Assign". |
| Scheduled Transaction | A future or repeating transaction YNAB enters on `date_next`. Not in balances or activity until then. |
| Money Movement | One assignment or move of money between categories in a month. A null category is Ready to Assign. |
| Reflect | YNAB's analytics tabs. The connector keeps a `reflect_*` tool only where the API has no direct answer: income v expense and net worth. |

## Connector

| Term | Meaning |
| --- | --- |
| Triage Inbox | Uncategorized transactions, unapproved imports, overspent categories, and underfunded goals in one call. Mirrors YNAB's review workflow, not any single YNAB screen. Tracking-account transactions are left out because they never take a category. |
| Month Window | The consecutive months a Reflect tool covers: the requested range intersected with the months the Plan has data for, plus a truncation note when they differ. |
| GoalView | The interpreted form of a Goal, from `interpretGoal`. Hides the `goal_*` matrix. A goal snoozed in the reference month is flagged, but `goal_under_funded` passes through unchanged because YNAB does not document how snoozing affects it. |
| Compute / Render | The split every tool follows: pure `compute*` to a typed result, pure `render*` to text. |
| Domain predicate | A named one-expression filter in `src/predicates.ts`, such as `isSpendingCategory` or `isTransferTx`. |

## Ambiguities

**"Uncategorized"** means two things: a Transaction with no `category_id`, which is inbox-worthy
unless it sits in a tracking (off-budget) account, where YNAB never assigns a category, and
the synthetic internal Category named "Uncategorized", which YNAB hoists out of its group and the
connector renders as a standalone row above the grouped expenses.

**Refunds** are positive activity on a spending Category. Reflect tools report them as positive
inflows, not negative spending.
