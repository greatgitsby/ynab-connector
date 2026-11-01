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
- **`GET /plans/{id}` omits group names.** Categories, top-level or under `months[].categories[]`,
  have no `category_group_name`, and `category_groups[].categories` is `null`. Build an id-to-name
  map from `plan.category_groups[]` and resolve through `category_group_id`, as
  `reflect_income_expense` does.
- **Ignore `*_formatted` / `*_currency` siblings** (v1.82). Structured output stays in milliunits.
- **Tokens.** Access tokens last two hours; refresh tokens are long-lived and rotate. See
  [token rotation](./overview.md#token-rotation-lives-in-one-place).
- **Restricted Mode.** New OAuth apps cap at 25 tokens until YNAB reviews them. Submit the review
  form before sharing a self-hosted connector widely.
