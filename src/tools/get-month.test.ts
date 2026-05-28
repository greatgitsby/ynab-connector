import { describe, test, expect } from "vitest";
import type { Category, CategoryGroup, MonthDetail } from "../ynab";
import { computeMonthReport, renderMonthReport } from "./get-month";

const cat = (overrides: Partial<Category>): Category => ({
  id: "cat-x",
  category_group_id: "grp-x",
  name: "Generic",
  hidden: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const monthDetail = (categories: Category[]): MonthDetail => ({
  month: "2026-05-01",
  income: 5_000_000,
  budgeted: 3_000_000,
  activity: -2_500_000,
  to_be_budgeted: 500_000,
  age_of_money: 12,
  categories,
});

const group = (overrides: Partial<CategoryGroup> & { id: string; name: string }): CategoryGroup => ({
  hidden: false,
  categories: [],
  ...overrides,
});

describe("computeMonthReport", () => {
  test("groups categories in category_groups order, dropping hidden when not included", () => {
    const groups: CategoryGroup[] = [
      group({
        id: "grp-bills",
        name: "Monthly Bills",
        categories: [
          cat({ id: "rent" }),
          cat({ id: "old-sub", hidden: true }),
        ],
      }),
      group({
        id: "grp-hidden",
        name: "Hidden Group",
        hidden: true,
        categories: [cat({ id: "h" })],
      }),
    ];
    const m = monthDetail([
      cat({ id: "rent", name: "Rent", budgeted: 2_000_000 }),
      cat({ id: "old-sub", name: "Old", hidden: true }),
      cat({ id: "h", name: "Hidden", hidden: true }),
    ]);
    const r = computeMonthReport(m, groups, { includeHidden: false });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].name).toBe("Monthly Bills");
    expect(r.groups[0].categories.map((c) => c.id)).toEqual(["rent"]);
  });

  test("includes hidden groups and categories when includeHidden is true", () => {
    const groups: CategoryGroup[] = [
      group({
        id: "grp-hidden",
        name: "Hidden",
        hidden: true,
        categories: [cat({ id: "h", name: "Old", hidden: true })],
      }),
    ];
    const m = monthDetail([cat({ id: "h", name: "Old", hidden: true })]);
    const r = computeMonthReport(m, groups, { includeHidden: true });
    expect(r.groups).toHaveLength(1);
  });

  test("drops groups with zero matching categories", () => {
    const groups: CategoryGroup[] = [
      group({
        id: "grp-empty",
        name: "Empty",
        categories: [cat({ id: "g-only" })],
      }),
    ];
    // monthDetail has no matching cat for g-only.
    const r = computeMonthReport(monthDetail([]), groups, {
      includeHidden: false,
    });
    expect(r.groups).toHaveLength(0);
  });
});

describe("renderMonthReport", () => {
  test("renders month totals and one ## section per group", () => {
    const groups: CategoryGroup[] = [
      group({
        id: "grp-bills",
        name: "Monthly Bills",
        categories: [cat({ id: "rent" })],
      }),
    ];
    const m = monthDetail([
      cat({
        id: "rent",
        name: "Rent",
        budgeted: 2_000_000,
        activity: -2_000_000,
        balance: 0,
      }),
    ]);
    const report = computeMonthReport(m, groups, { includeHidden: false });
    const out = renderMonthReport(report, { includeIds: false });
    expect(out).toContain("Month: 2026-05-01");
    expect(out).toContain("Income:         $5,000.00");
    expect(out).toContain("Age of money:   12 days");
    expect(out).toContain("## Monthly Bills");
    expect(out).toContain("Rent: budgeted $2,000.00");
  });

  test("omits Age of money when null", () => {
    const m: MonthDetail = { ...monthDetail([]), age_of_money: null };
    const report = computeMonthReport(m, [], { includeHidden: false });
    expect(renderMonthReport(report, { includeIds: false })).not.toContain(
      "Age of money",
    );
  });
});
