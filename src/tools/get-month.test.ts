import { describe, test, expect } from "vitest";
import type { Category, CategoryGroup, MonthDetail } from "../ynab";
import {
  computeMonthReport,
  renderMonthReport,
  MonthReportSchema,
} from "./get-month";

const cat = (
  id: string,
  group: string,
  overrides: Partial<Category> = {},
): Category => ({
  id,
  category_group_id: group,
  category_group_name: group,
  name: id,
  hidden: false,
  internal: false,
  deleted: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const group = (
  id: string,
  categories: Category[],
  overrides: Partial<CategoryGroup> = {},
): CategoryGroup => ({
  id,
  name: id,
  hidden: false,
  internal: false,
  deleted: false,
  categories,
  ...overrides,
});

const monthDetail = (categories: Category[]): MonthDetail => ({
  month: "2026-05-01",
  income: 5_000_000,
  budgeted: 3_000_000,
  activity: -2_500_000,
  to_be_budgeted: 500_000,
  age_of_money: 12,
  deleted: false,
  categories,
});

// GET /months/{month} order is arbitrary; the Plan's order comes from groups.
const month = monthDetail([
  cat("games", "Fun"),
  cat("rta", "Internal", { internal: true }),
  cat("old", "Bills", { hidden: true }),
  cat("power", "Bills"),
  cat("rent", "Bills", { budgeted: 2_000_000 }),
  cat("h", "Old Stuff"),
]);
const groups = [
  group("Bills", [cat("rent", "Bills"), cat("power", "Bills"), cat("old", "Bills")]),
  group("Fun", [cat("games", "Fun")]),
  group("Old Stuff", [cat("h", "Old Stuff")], { hidden: true }),
];

const ids = (r: ReturnType<typeof computeMonthReport>) =>
  r.groups.map((g) => [g.name, g.categories.map((c) => c.id)]);

describe("computeMonthReport", () => {
  test("orders groups and categories as the Plan does, dropping hidden and internal", () => {
    const r = computeMonthReport(month, groups, { includeHidden: false, iso: "USD" });
    expect(ids(r)).toEqual([
      ["Bills", ["rent", "power"]],
      ["Fun", ["games"]],
    ]);
    expect(r.to_be_budgeted).toBe(500_000);
    expect(() => MonthReportSchema.parse(r)).not.toThrow();
  });

  test("includes hidden groups and categories when asked", () => {
    const r = computeMonthReport(month, groups, { includeHidden: true, iso: "USD" });
    expect(ids(r)).toEqual([
      ["Bills", ["rent", "power", "old"]],
      ["Fun", ["games"]],
      ["Old Stuff", ["h"]],
    ]);
  });

  test("still groups every category when GET /categories comes back empty", () => {
    const empty = [group("Bills", [], { internal: true })];
    const r = computeMonthReport(month, empty, { includeHidden: false, iso: "USD" });
    expect(r.groups.flatMap((g) => g.categories.map((c) => c.id)).sort()).toEqual([
      "games",
      "h",
      "power",
      "rent",
    ]);
  });
});

describe("renderMonthReport", () => {
  test("renders month totals and one ## section per group", () => {
    const report = computeMonthReport(month, groups, { includeHidden: false, iso: "USD" });
    const out = renderMonthReport(report, { includeIds: false });
    expect(out).toContain("Month: 2026-05-01");
    expect(out).toContain("Income:          $5,000.00");
    expect(out).toContain("Age of money:    12 days");
    expect(out).toContain("## Bills");
    expect(out).toContain("- rent: budgeted $2,000.00");
  });

  test("omits Age of money when null", () => {
    const m: MonthDetail = { ...monthDetail([]), age_of_money: null };
    const report = computeMonthReport(m, [], { includeHidden: false, iso: "USD" });
    expect(renderMonthReport(report, { includeIds: false })).not.toContain("Age of money");
  });
});
