import { describe, test, expect } from "vitest";
import type { Category, MonthDetail } from "../ynab";
import {
  CategoryReportSchema,
  computeCategoryReport,
  renderCategoryReport,
} from "./get-category";

const cat = (overrides: Partial<Category> = {}): Category => ({
  id: "travel",
  category_group_id: "grp",
  category_group_name: "Savings",
  name: "Travel",
  hidden: false,
  internal: false,
  deleted: false,
  budgeted: 200_000,
  activity: 0,
  balance: 1_000_000,
  goal_type: "MF",
  goal_target: 200_000,
  goal_under_funded: 0,
  ...overrides,
});

const month = (m: string, categories: Category[]): MonthDetail => ({
  month: m,
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 0,
  age_of_money: null,
  deleted: false,
  categories,
});

// Plan export rows: no goal_target_date and no group name, as YNAB sends them.
const planMonths = [
  month("2026-02-01", [cat({ budgeted: 200_000, category_group_name: undefined })]),
  month("2026-03-01", [cat({ budgeted: 0, goal_under_funded: 200_000 })]),
  month("2026-04-01", [cat({ budgeted: 400_000 })]),
  month("2026-05-01", [cat({ goal_type: null, goal_target: null })]),
];

describe("computeCategoryReport", () => {
  test("reports each month's own funding state", () => {
    const r = computeCategoryReport(cat(), planMonths, {
      month: "2026-05-01",
      since: "2026-02-01",
      iso: "USD",
    });
    expect(r.history.map((h) => [h.month, h.budgeted, h.goal_met])).toEqual([
      ["2026-02-01", 200_000, true],
      ["2026-03-01", 0, false],
      ["2026-04-01", 400_000, true],
      ["2026-05-01", 200_000, null],
    ]);
    expect(r.history[1].goal_under_funded).toBe(200_000);
    expect(() => CategoryReportSchema.parse(r)).not.toThrow();
  });

  test("skips history without since_month and notes missing months", () => {
    expect(
      computeCategoryReport(cat(), planMonths, {
        month: "2026-05-01",
        since: null,
        iso: "USD",
      }).history,
    ).toEqual([]);
    const r = computeCategoryReport(cat(), planMonths, {
      month: "2026-05-01",
      since: "2025-12-01",
      iso: "USD",
    });
    expect(r.truncation_note).toContain("4 of 6");
  });

  test("renders the funded-month count", () => {
    const r = computeCategoryReport(cat(), planMonths, {
      month: "2026-05-01",
      since: "2026-02-01",
      iso: "USD",
    });
    expect(renderCategoryReport(r, { includeIds: false })).toContain(
      "Goal fully funded in 2 of 3 months.",
    );
  });
});
