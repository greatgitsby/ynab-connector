# YNAB Connector

A read-only MCP server that exposes YNAB budget data as tools for a Claude.ai custom connector. The domain blends YNAB's own vocabulary (Budget, Category, Goal, Reflect) with this project's tool surface.

## Language

### YNAB primitives

**Budget**:
A YNAB plan — the top-level container that owns accounts, categories, months, and transactions. YNAB's API uses `/budgets` and `/plans` interchangeably; this codebase always says **Budget**.
_Avoid_: Plan.

**Account**:
A bank account, credit card, loan, or tracking line attached to a Budget. Flagged **on-budget** (contributes to Ready to Assign) or **off-budget** (tracked but not budgeted).

**Category Group**:
A named cluster of **Categories** (e.g. "Monthly Bills", "Fun Money"). Has its own `id` and `hidden`/`deleted` flags. Categories carry a `category_group_id` back-reference.

**Category**:
A budgeting bucket inside a **Category Group**. Carries `budgeted`, `activity`, `balance` per month, plus optional **Goal** fields. May be `internal` (synthetic, e.g. "Inflow: Ready to Assign", "Uncategorized") — internal categories are hidden from spending views.

**Goal**:
A target attached to a Category. The encoding is a matrix of `goal_type`, `goal_cadence`, `goal_cadence_frequency`, `goal_target_date`, `goal_months_to_budget`, `goal_under_funded`. Always interpreted through the **GoalView** module — call sites never read the raw goal_* fields directly.

**Transaction**:
A row on an account. Carries `date`, `amount` (signed; negative = outflow), `payee_name`, `category_id`, `account_id`. A **Transfer** is a Transaction with `transfer_account_id` set — it has no category by design.

**Subtransaction**:
A split inside a parent Transaction. Each sub has its own `amount` and `category_id`; the parent's `category_id` is null. When summing per-category activity, sub-transactions count independently and the parent is skipped.

**Milliunit**:
YNAB's amount encoding — integer thousandths of a currency unit. $1.00 = 1000 milliunits. All API amounts are milliunits; `fromMilli()` converts for display.

**Ready to Assign**:
The unassigned cash pool YNAB shows at the top of the budget. Sourced from `month.to_be_budgeted` — the live figure the app displays. **Never** read this off the `Inflow: Ready to Assign` Category's `balance`; that's a lifetime-cumulative number, not a user-actionable one.
_Avoid_: To-be-budgeted (correct in API, but "Ready to Assign" is what users see).

### Reflect & Triage

**Reflect**:
YNAB's analytical tabs — Spending Breakdown, Spending Trends, Net Worth, Income v Expense, Age of Money. This connector exposes one MCP tool per Reflect tab. Tool names are prefixed `reflect_`.

**Triage Inbox**:
A day-to-day review surface unique to this connector — uncategorized transactions + auto-categorized awaiting approval + overspent categories + underfunded goals, in one call. Mirrors YNAB's review workflow without being a single YNAB screen.

**Month Window**:
A consecutive run of months a Reflect tool operates over. Resolved by `resolveMonthWindow(budget, monthsBack)` which intersects the requested window with the months the Budget actually has data for, and emits a pre-formatted truncation note when those differ.

**GoalView**:
The interpreted form of a Goal — `{ displayLabel, nextDueDate, underfundedThisMonth, isRecurring }`. Hides the YNAB goal_* matrix from callers.

### Module shapes

**Compute / Render split**:
Every tool over ~60 lines is split into a pure `computeX(budget, transactions, opts) → X` and a pure `renderX(result, opts) → string`. The handler does fetch · compute · render · error-wrap and nothing else. The typed `X` (e.g. `SpendingBreakdown`, `IncomeExpensePivot`) is the test surface.

**Domain predicate**:
A named one-expression predicate over a YNAB type that captures a project-wide filtering convention. Examples: `isSpendingCategory`, `isInflowRta`, `isUncategorizedInternal`, `isInboxableTx`, `isTransferTx`. Live in `src/predicates.ts`. Used everywhere `cat.hidden || cat.deleted || cat.internal` or `t.transfer_account_id != null` would otherwise be inlined.

## Example dialogue

> **Dev**: The Spending Breakdown tool isn't matching what YNAB shows for January — there's a $50 refund the tool is counting as spending.
>
> **You**: Refunds show as positive activity on the spending Category. The tool should be routing those through `positiveInflows`, not `spending`. Check `computeSpendingBreakdown` — the branch should split on `cat.activity` sign before applying `isSpendingCategory`.
>
> **Dev**: And the "Inflow: Ready to Assign" payments are still showing up as Categories with goals?
>
> **You**: That's an `internal` Category — `isSpendingCategory` should be filtering it out. If it's leaking through, the predicate is wrong, not the Reflect compute.

## Flagged ambiguities

**"to_be_budgeted" vs "Ready to Assign"**: Same number, two names. API field is `to_be_budgeted`. User-facing label is "Ready to Assign." Always render as "Ready to Assign" in tool output; keep `to_be_budgeted` only when quoting the API field.

**"Uncategorized"**: Two different things — (a) a Transaction with no `category_id`, surfaced via `?type=uncategorized` in the list endpoint; (b) a synthetic `internal` Category named "Uncategorized" that YNAB hoists out of its group in the UI. Compute modules treat (a) as inbox-worthy and (b) as a stand-alone row above the grouped expense rows.
