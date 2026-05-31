import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { BudgetDetail, Category, MonthDetail } from "../ynab";
import {
  computeSpendingTrends,
  renderSpendingTrends,
  SpendingTrendsSchema,
} from "./reflect-spending-trends";

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

const month = (
  m: string,
  activity: number,
  categories: Category[],
): MonthDetail => ({
  month: m,
  income: 0,
  budgeted: 0,
  activity,
  to_be_budgeted: 0,
  age_of_money: null,
  categories,
});

const budget = (months: MonthDetail[]): BudgetDetail => ({
  id: "b-1",
  name: "Test Plan",
  last_modified_on: "2026-05-01",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  currency_format: { iso_code: "USD", decimal_digits: 2 },
  months,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-20T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("computeSpendingTrends", () => {
  test("monthlyNet is -month.activity per month", () => {
    const b = budget([
      month("2026-03-01", -1_000_000, []),
      month("2026-04-01", -1_500_000, []),
      month("2026-05-01", -2_000_000, []),
    ]);
    const r = computeSpendingTrends(b, { monthsBack: 3 });
    expect(r.monthlyNet.map((x) => x.value)).toEqual([
      1_000_000, 1_500_000, 2_000_000,
    ]);
    expect(r.avgNet).toBe(1_500_000);
  });

  test("compute output conforms to the declared outputSchema", () => {
    const groceries = (mag: number) =>
      cat({ id: "groceries", name: "Groceries", activity: -mag });
    const b = budget([
      month("2026-03-01", -300_000, [groceries(300_000)]),
      month("2026-04-01", 0, []),
      month("2026-05-01", -350_000, [groceries(350_000)]),
    ]);
    const r = computeSpendingTrends(b, { monthsBack: 3 });
    expect(() => SpendingTrendsSchema.parse(r)).not.toThrow();
  });

  test("ranks categories by total spending magnitude desc", () => {
    const groceries = (mag: number) =>
      cat({ id: "groceries", name: "Groceries", activity: -mag });
    const rent = (mag: number) =>
      cat({ id: "rent", name: "Rent", activity: -mag });
    const b = budget([
      month("2026-03-01", 0, [groceries(300_000), rent(2_000_000)]),
      month("2026-04-01", 0, [groceries(400_000), rent(2_000_000)]),
      month("2026-05-01", 0, [groceries(350_000), rent(2_000_000)]),
    ]);
    const r = computeSpendingTrends(b, { monthsBack: 3 });
    expect(r.ranked.map((c) => c.name)).toEqual(["Rent", "Groceries"]);
    expect(r.ranked[0].total).toBe(6_000_000);
  });

  test("stats are computed only over present months (months with outflow)", () => {
    // Groceries appears in 2 of 3 months.
    const b = budget([
      month("2026-03-01", 0, [
        cat({ id: "groceries", name: "Groceries", activity: -300_000 }),
      ]),
      month("2026-04-01", 0, [
        cat({ id: "groceries", name: "Groceries", activity: 0 }),
      ]),
      month("2026-05-01", 0, [
        cat({ id: "groceries", name: "Groceries", activity: -100_000 }),
      ]),
    ]);
    const r = computeSpendingTrends(b, { monthsBack: 3 });
    const g = r.ranked[0];
    expect(g.presentMonths).toHaveLength(2);
    expect(g.stats?.avg).toBe(200_000);
    expect(g.stats?.min.v).toBe(100_000);
    expect(g.stats?.max.v).toBe(300_000);
  });

  test("skips hidden / internal / deleted categories", () => {
    const b = budget([
      month("2026-05-01", 0, [
        cat({ id: "groceries", name: "Groceries", activity: -100_000 }),
        cat({
          id: "hidden",
          name: "Old",
          activity: -1_000_000,
          hidden: true,
        }),
        cat({
          id: "internal",
          name: "Inflow: Ready to Assign",
          activity: 500_000,
          internal: true,
        }),
      ]),
    ]);
    const r = computeSpendingTrends(b, { monthsBack: 1 });
    expect(r.ranked.map((c) => c.name)).toEqual(["Groceries"]);
  });
});

describe("renderSpendingTrends", () => {
  test("emits header, monthly table, and top-categories section", () => {
    const b = budget([
      month("2026-04-01", -500_000, [
        cat({ id: "groceries", name: "Groceries", activity: -500_000 }),
      ]),
      month("2026-05-01", -700_000, [
        cat({ id: "groceries", name: "Groceries", activity: -700_000 }),
      ]),
    ]);
    const trends = computeSpendingTrends(b, { monthsBack: 2 });
    const out = renderSpendingTrends(trends, { includeIds: false, topN: 5 });
    expect(out).toContain("Spending Trends: Test Plan");
    expect(out).toContain("## Monthly net activity");
    expect(out).toContain("## Top categories month-over-month");
    expect(out).toContain("Groceries");
  });

  test("notes ranked count when topN is smaller than ranked.length", () => {
    const cats = Array.from({ length: 8 }, (_, i) =>
      cat({ id: `c${i}`, name: `Cat${i}`, activity: -(100_000 - i * 1_000) }),
    );
    const b = budget([month("2026-05-01", 0, cats)]);
    const trends = computeSpendingTrends(b, { monthsBack: 1 });
    const out = renderSpendingTrends(trends, { includeIds: false, topN: 3 });
    expect(out).toContain("showing 3 of 8");
  });
});
