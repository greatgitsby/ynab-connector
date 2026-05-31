# Plan 0002: Snooze-targets awareness (read-side)

Implementation roadmap for surfacing YNAB's **snoozed target** state in the
connector. Branch: `claude/snooze-targets-feature-6v3z8`.

## Background / why this shape

The original ask was to let Claude **snooze a target for a month**, mirroring
the YNAB app/website button.

**The YNAB public API cannot do this.** Verified against the OpenAPI spec
(`open_api_spec.yaml`, pulled from the `ynab/ynab-sdk-ruby` mirror because
`api.ynab.com` is blocked by this environment's network policy):

- `goal_snoozed_at` exists on the **Category** schema but is **read-only**:
  _"The date/time the goal was snoozed. If the goal is not snoozed, this will
  be null."_
- The per-month category write body (`SaveMonthCategory`, the shape
  `assign_to_categories` PATCHes) accepts **only `budgeted`**.
- The category-edit body (`SaveCategory`) accepts only `name`, `note`,
  `category_group_id`, `goal_target`, `goal_target_date`,
  `goal_needs_whole_amount` — no snooze field, no snooze endpoint.
- A full-spec grep for `snooz` returns exactly two hits, both the read-only
  `goal_snoozed_at` field and its description.

So the app's snooze button hits a **private/internal endpoint** outside the
public API. There is also no write workaround: snoozing in YNAB purely
suppresses the underfunded ("yellow") alert for the month without changing
`budgeted`, so it can't be replicated via `assign_to_categories`. (Goal edits
are independently out of scope per ADR 0001 §D11 / Future Work, but the API
limitation is the hard blocker regardless.)

**What this plan delivers instead:** make the connector *respect* snooze state
on the read side. Today the connector doesn't even model `goal_snoozed_at`, so
a target the user snoozed in the YNAB app still nags as "underfunded" in
`triage_inbox` and in goal suffixes — a real divergence from what YNAB shows.
This plan closes that gap.

## Scope

In scope:
- Model `goal_snoozed_at` on `Category`.
- Make `interpretGoal` / `GoalView` snooze-aware (zero out the
  month's underfunded amount, expose `isSnoozed`, reflect it in the label).
- Exclude snoozed targets from `triage_inbox`'s "underfunded goals" section
  (via a new predicate).
- Render snooze state in `get_category_details` and any `fmtCategoryLine`
  output (free, once `interpretGoal` is snooze-aware).
- Tests + docs + a short ADR recording the API limitation.

Out of scope (no public-API support):
- Any *write* that snoozes/unsnoozes a target.
- A standalone "list snoozed targets" tool (the chosen scope is awareness, not
  a new tool surface; can be a fast follow if wanted).

---

## A key assumption to verify during smoke testing

`goal_snoozed_at` is a timestamp, but snooze is **per-month** in the UI. The
working assumption is that when we read a category from a **month-scoped**
endpoint (`GET /budgets/{id}/months/{month}` — what both `triage_inbox` and
`get_category_details` already use), `goal_snoozed_at` reflects whether the
goal is snoozed *for that month*. This is consistent with how the other
`goal_*` fields (e.g. `goal_under_funded`) are month-contextualized on that
endpoint.

Because `api.ynab.com` is unreachable from CI/this environment, this must be
confirmed manually before merge: snooze a real target for the current month in
the YNAB app, then run `./scripts/ynab.sh api "/budgets/$BUDGET_ID/months/current"`
and confirm the snoozed category carries a non-null `goal_snoozed_at` while
unsnoozed ones are null. (Add this to the smoke checklist below.) If the field
turns out to be global rather than month-scoped, the logic still degrades
gracefully — we'd just be hiding the underfunded nag whenever the goal is
snoozed for *any* month, which is acceptable and still better than today.

---

## PR 1 — Model the field + snooze-aware GoalView (core)

**Goal:** `interpretGoal` understands snooze; everything that reads GoalView
inherits correct behavior.

**Files:**

- `src/ynab.ts`
  - Add to the `Category` interface (next to the other `goal_*` fields):
    `goal_snoozed_at?: string | null;`
- `src/goals.ts`
  - Add `isSnoozed: boolean` to the `GoalView` interface (documented:
    "true when the goal is snoozed for the reference month — underfunded
    alerts are suppressed").
  - In `interpretGoal`:
    - Compute `const snoozed = !!c.goal_snoozed_at;`
    - When `snoozed`, force `underfunded = 0` (the whole point: YNAB suppresses
      the month's gap). Set `isSnoozed: snoozed`.
    - Adjust the `label` parts: when snoozed, append `"snoozed this month"`
      instead of the `"needs $X more this month"` clause. Keep the
      target/cadence/date parts unchanged so the goal is still legible.
  - `fmtGoalSuffix` needs no change — it renders `view.label`, which now
    reflects snooze automatically.

**Tests (`src/goals.test.ts`):**
- Snoozed goal (`goal_snoozed_at` set, `goal_under_funded > 0`) →
  `isSnoozed === true`, `underfundedThisMonth === 0`, label contains
  "snoozed", label does **not** contain "needs".
- Unsnoozed goal with the same numbers → `isSnoozed === false`,
  `underfundedThisMonth` unchanged, label contains "needs … more this month".
- `goal_snoozed_at: null` behaves identically to absent.

**Acceptance:** `npm run type-check && npm test` clean.

---

## PR 2 — Predicate + triage_inbox excludes snoozed targets

**Goal:** snoozed targets stop showing under "Underfunded goals (current
month)" in `triage_inbox`, matching the YNAB UI.

**Files:**

- `src/predicates.ts`
  - Add `isSnoozedGoal(c: Category): boolean => !!c.goal_snoozed_at;` with a
    comment explaining snooze suppresses the month's underfunded alert.
    (CLAUDE.md requires filtering through predicates rather than inlining the
    YNAB-shape boolean.)
- `src/tools/triage-inbox.ts`
  - Change the underfunded filter (line ~68-69) to also exclude snoozed:
    `.filter(cat => (cat.goal_under_funded ?? 0) > 0 && !isSnoozedGoal(cat))`
  - Import `isSnoozedGoal`.
  - (Overspent section already renders via `fmtCategoryLine`, which now picks
    up the snooze label from PR 1 — no change needed there, but assert it in a
    test.)

**Tests:**
- `src/predicates.test.ts`: `isSnoozedGoal` true/false/null/absent cases.
- `src/tools/triage-inbox.test.ts`: a category with `goal_under_funded > 0`
  **and** `goal_snoozed_at` set is **absent** from `inbox.underfunded`; an
  otherwise-identical unsnoozed category is present.

**Acceptance:** `npm run type-check && npm test` clean.

---

## PR 3 — get_category_details surfaces snooze

**Goal:** drilling into a snoozed category shows it's snoozed.

**Files:**

- `src/tools/get-category-details.ts`
  - `expandForCategory` already calls `interpretGoal`, so `goalView.isSnoozed`
    and the snooze-aware label flow through for free. Confirm the render path
    prints the goal label (it does via the GoalView). Add an explicit
    "snoozed" indicator to the rendered goal line if the current render only
    prints `goalView.label` partially.

**Tests (`src/tools/get-category-details.test.ts`):**
- Snoozed category → `result.goalView.isSnoozed === true`,
  `goalView.underfundedThisMonth === 0`; rendered text mentions "snoozed".

**Acceptance:** `npm run type-check && npm test` clean.

---

## PR 4 — Docs + ADR

**Files:**

- `docs/adr/0002-snooze-target-read-awareness.md` (new) — short ADR recording:
  the original write ask, the API-limitation finding (read-only
  `goal_snoozed_at`, no write field/endpoint), the decision to ship read-side
  awareness only, and the per-month-vs-timestamp assumption. This prevents the
  write request from being re-litigated and documents why there's no
  `snooze_target` tool.
- `CONTEXT.md`
  - Extend the **GoalView** definition to mention `isSnoozed` and that snooze
    zeroes the month's underfunded amount.
  - Add a short "Snoozed target" entry under YNAB primitives / Goal.
- `CLAUDE.md`
  - Add a YNAB-API-gotchas bullet: `goal_snoozed_at` is read-only; snooze
    cannot be set via the public API; the connector only reflects it. Note the
    predicate `isSnoozedGoal` and that `interpretGoal` handles the alert
    suppression centrally.
- `README.md`
  - One line under `triage_inbox` / goal handling noting snoozed targets are
    respected (no longer flagged as underfunded), matching YNAB.

**Acceptance:** docs build/lint as before; no code behavior change.

---

## Smoke checklist (manual, before merge)

Run against the dedicated test budget (see CLAUDE.md "Local dev / e2e"):

1. In the YNAB app, snooze a target on a category for the **current month**.
2. `./scripts/ynab.sh api "/budgets/$BUDGET_ID/months/current"` → confirm that
   category has non-null `goal_snoozed_at`; an unsnoozed one is null.
   **(Validates the per-month assumption above.)**
3. Via the deployed connector + a real client: `triage_inbox` no longer lists
   the snoozed category under "Underfunded goals"; `get_category_details` on it
   shows "snoozed".
4. Unsnooze in the app; re-run; the category reappears under underfunded.

## Notes

- No new YNAB scope, no new write surface, no `canWrite` interaction — this is
  purely interpreting an existing read field. `triage_inbox` stays
  `readOnlyHint: true`.
- PRs 1–3 are independently landable and each keep `npm test` green; PR 4 is
  docs-only.
