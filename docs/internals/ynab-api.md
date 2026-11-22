# YNAB API traps

Wire-level behavior of `https://api.ynab.com/v1` that the code depends on and the source cannot
explain. Domain meaning is in the [glossary](./glossary.md).

- **Use `/plans` paths.** Since v1.79 resources are `/plans/{plan_id}/...` with response keys
  `plans` / `plan` / `default_plan`. The old `/budgets` paths still answer but are undocumented.
  `plan_id` also accepts `last-used`, and `default` if the OAuth app enables default-plan selection.
- **Always send `since_date`.** Since v1.85, transaction listings without `since_date` silently
  return only the last year, which truncates "all uncategorized" and "all unreconciled" queries.
  `YnabClient` sends `ALL_TIME` unless the caller passes a date.
- **`month` accepts `YYYY-MM-01` or `current`.**
- **`GET /plans/{id}` omits fields the lighter endpoints send.** Categories, top-level or under
  `months[].categories[]`, have no `category_group_name` and no `goal_target_date` (only the
  deprecated `goal_target_month`), and `category_groups[].categories` is `null`. Resolve group names
  through `category_group_id`, as `reflect_income_expense` does; `interpretGoal` falls back to
  `goal_target_month`. Its per-month `goal_*` fields are that month's own funding state.
- **`GET /months/{month}` returns categories unordered.** Take group order from `GET /categories`.
- **Category and payee listings return hybrid rows.** By category, each split part is its own row
  (`type: "subtransaction"`, `parent_transaction_id`) carrying the part's payee, usually null, not
  the parent's. By payee, splits come back whole with `category_name: "Split"` and an empty `subtransactions`, so the parts are lost; `query_transactions` filters the plan listing by payee instead. No listing double
  counts, so totals are safe. Plan, account, and month listings nest `subtransactions` instead.
  Every listing leaves out pending bank transactions.
- **Some names are stored HTML-escaped.** Most payees come back as typed ("AT&T"), but some,
  likely from bank-import data, are stored as "Board &amp; Brew", often beside a clean twin. This
  is stored data, not output encoding, so don't decode responses: a rename's collision check and a
  merge's target name work on the stored name. `review_payees` flags them for renaming or merging.
- **Split parts of existing transactions are read-only.** Sending `subtransactions` for an existing
  split is a 400, even with identical parts, so a part's payee or category can't be changed through
  the API. A `category_id` sent for a split parent is dropped with a 200; the parent keeps YNAB's
  internal "Split" category. Splitting a plain transaction keeps its id, `import_id`, `cleared`, and
  `approved`, and setting a split parent's other fields works. Parts that don't sum to the amount
  are a 400, and any 400 row fails the whole bulk PATCH. Checked against v1.91 on a test plan.
- **Updating a scheduled transaction is a full `PUT`.** Omitted fields are cleared, `date` (the next
  occurrence) must be in the future per the spec, and the body has no `subtransactions`, so split
  scheduled transactions can't be written.
- **Categories can't be hidden or deleted through the API.** `PATCH /categories/{id}` drops `hidden`
  without an error (a body with only `hidden` is a 400, "param is missing"), and moving a category
  into the internal Hidden Categories group is refused. There is no `DELETE`. Checked against v1.91.
- **Category names needn't be unique.** `POST /categories` and a rename via `PATCH` accept a name
  another category already has.
- **A category group's `internal` flag doesn't mean YNAB owns it.** Groups made from YNAB's starter
  template, which users rename and fill, also read `internal: true`. YNAB itself refuses to put a
  category in Internal Master Category, Credit Card Payments, or Hidden Categories ("category group
  cannot be an internal category group"), so don't filter on the flag. Checked against v1.91.
- **Category goal `PATCH` traps** (v1.89, checked against a test plan):
  - `goal_target: null` removes the goal. The category then reads `goal_type: null`,
    `goal_target: 0`, not `null`.
  - `goal_target` alone keeps the goal's type, cadence, and date. On a category without a goal it
    creates a monthly NEED "set aside" goal.
  - `goal_frequency` replaces the goal with a NEED goal. It needs `goal_target`, and combining it
    with `goal_target_date` is a 400.
  - On a recurring goal, `goal_target_date` is the repeat's anchor, not a deadline.
    `goal_target_date: null` clears it.
  - YNAB stores `goal_needs_whole_amount` on a TB goal, or on a category with no goal, and stores a
    negative `goal_target`, all without an error.
  - No field creates a TB/TBD goal or sets an every-N-months cadence or `goal_day`, so the API can't rebuild
    those once they are removed or replaced.
- **Money movements include every assignment.** A null `from_category_id` is Ready to Assign, and a
  null `to_category_id` returns money to it, so a category's movements net to its `budgeted`. Never
  send `last_knowledge_of_server` here: the delta response carries deleted tombstones.
- **Ignore `*_formatted` / `*_currency` siblings** (v1.82). Structured output stays in milliunits.
- **Tokens.** Access tokens last two hours; refresh tokens are long-lived and rotate. See
  [token rotation](./overview.md#token-rotation-lives-in-one-place).
- **Restricted Mode.** New OAuth apps cap at 25 tokens until YNAB reviews them. Submit the review
  form before sharing a self-hosted connector widely.
