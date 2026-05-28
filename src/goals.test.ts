import { describe, test, expect } from "vitest";
import type { Category } from "./ynab";
import { interpretGoal, fmtGoalSuffix } from "./goals";

const cat = (overrides: Partial<Category>): Category => ({
  id: "cat-1",
  category_group_id: "grp-1",
  name: "Groceries",
  hidden: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

describe("interpretGoal", () => {
  test("returns null when there is no goal_type", () => {
    expect(interpretGoal(cat({}), "2026-05-01")).toBeNull();
  });

  test("returns null when goal_target is missing", () => {
    expect(
      interpretGoal(
        cat({ goal_type: "MF", goal_target: null }),
        "2026-05-01",
      ),
    ).toBeNull();
  });

  test("MF (monthly funding) is always labelled /month regardless of cadence", () => {
    const view = interpretGoal(
      cat({
        goal_type: "MF",
        goal_target: 500_000,
        goal_cadence: 2,
        goal_cadence_frequency: 1,
      }),
      "2026-05-01",
    );
    expect(view?.cadenceLabel).toBe("/month");
    expect(view?.label.startsWith("$500.00/month")).toBe(true);
    expect(view?.targetAmount).toBe(500_000);
  });

  test("weekly cadence with frequency 1 renders as /week", () => {
    const view = interpretGoal(
      cat({
        goal_type: "NEED",
        goal_target: 67_000,
        goal_cadence: 2,
        goal_cadence_frequency: 1,
      }),
      "2026-05-01",
    );
    expect(view?.cadenceLabel).toBe("/week");
  });

  test("multi-month cadence renders as 'every N months'", () => {
    const view = interpretGoal(
      cat({
        goal_type: "NEED",
        goal_target: 100_000,
        goal_cadence: 4,
      }),
      "2026-05-01",
    );
    expect(view?.cadenceLabel).toBe(" every 3 months");
  });

  test("single-target goal has empty cadence", () => {
    const view = interpretGoal(
      cat({ goal_type: "TB", goal_target: 1_000_000, goal_cadence: 0 }),
      "2026-05-01",
    );
    expect(view?.cadenceLabel).toBe("");
    expect(view?.isRecurring).toBe(false);
  });

  test("non-recurring goal returns goal_target_date verbatim", () => {
    const view = interpretGoal(
      cat({
        goal_type: "TBD",
        goal_target: 5_000_000,
        goal_cadence: 0,
        goal_target_date: "2026-12-01",
      }),
      "2026-05-01",
    );
    expect(view?.nextDueDate).toBe("2026-12-01");
  });

  test("recurring goal projects forward using goal_months_to_budget", () => {
    const view = interpretGoal(
      cat({
        goal_type: "NEED",
        goal_target: 300_000,
        goal_cadence: 1,
        goal_cadence_frequency: 1,
        goal_months_to_budget: 3,
        goal_target_date: "2020-01-15",
      }),
      "2026-05-01",
    );
    // refMonth=2026-05, m2b=3 → projects to 2026-07-15 (already future).
    expect(view?.nextDueDate).toBe("2026-07-15");
    expect(view?.isRecurring).toBe(true);
  });

  test("underfunded amount surfaces in the label", () => {
    const view = interpretGoal(
      cat({
        goal_type: "MF",
        goal_target: 500_000,
        goal_under_funded: 200_000,
      }),
      "2026-05-01",
    );
    expect(view?.underfundedThisMonth).toBe(200_000);
    expect(view?.label).toContain("needs $200.00 more this month");
  });

  test("zero underfunded is suppressed from the label", () => {
    const view = interpretGoal(
      cat({ goal_type: "MF", goal_target: 500_000, goal_under_funded: 0 }),
      "2026-05-01",
    );
    expect(view?.underfundedThisMonth).toBe(0);
    expect(view?.label).not.toContain("needs");
  });
});

describe("fmtGoalSuffix", () => {
  test("returns empty string when no goal", () => {
    expect(fmtGoalSuffix(cat({}), "2026-05-01")).toBe("");
  });

  test("prefixes ' — goal: ' to the label", () => {
    const out = fmtGoalSuffix(
      cat({ goal_type: "MF", goal_target: 250_000 }),
      "2026-05-01",
    );
    expect(out).toBe(" — goal: $250.00/month");
  });
});
