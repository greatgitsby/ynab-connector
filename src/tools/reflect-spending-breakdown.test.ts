import { describe, test, expect } from "vitest";
import type { Category, MonthDetail, Transaction } from "../ynab";
import {
  computeSpendingBreakdown,
  renderSpendingBreakdown,
} from "./reflect-spending-breakdown";

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

const month = (m: string, categories: Category[]): MonthDetail => ({
  month: m,
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 0,
  age_of_money: null,
  categories,
});

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "t-x",
  date: "2026-04-15",
  amount: -10_000,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-1",
  account_name: "Checking",
  payee_id: null,
  payee_name: "Costco",
  category_id: "cat-x",
  category_name: "Generic",
  flag_color: null,
  transfer_account_id: null,
  ...overrides,
});

describe("computeSpendingBreakdown", () => {
  const monthsInRange: MonthDetail[] = [
    month("2026-04-01", [
      cat({ id: "groceries", name: "Groceries", activity: -300_000 }),
      cat({ id: "rent", name: "Rent", activity: -2_000_000 }),
      cat({ id: "refunds", name: "Returns", activity: 50_000 }),
      cat({
        id: "hidden-x",
        name: "Old Subscriptions",
        activity: -10_000,
        hidden: true,
      }),
    ]),
  ];

  test("aggregates spending magnitude by category, sorted desc", () => {
    const r = computeSpendingBreakdown(monthsInRange, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.spending.map((row) => row.name)).toEqual(["Rent", "Groceries"]);
    expect(r.spending[0].magnitude).toBe(2_000_000);
  });

  test("excludes hidden categories", () => {
    const r = computeSpendingBreakdown(monthsInRange, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.spending.map((row) => row.name)).not.toContain("Old Subscriptions");
  });

  test("totals are spending magnitude / months / days", () => {
    const r = computeSpendingBreakdown(monthsInRange, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.totals.spending).toBe(2_300_000);
    expect(r.range.months).toBe(1);
    expect(r.range.days).toBe(30); // April
    expect(r.totals.monthlyAvg).toBe(2_300_000);
    expect(r.totals.dailyAvg).toBeCloseTo(2_300_000 / 30, 5);
  });

  test("collects positive categories into positiveInflows", () => {
    const r = computeSpendingBreakdown(monthsInRange, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.positiveInflows).toHaveLength(1);
    expect(r.positiveInflows[0].name).toBe("Returns");
    expect(r.positiveInflows[0].positive).toBe(50_000);
  });

  test("range label is the single month when start === end", () => {
    const r = computeSpendingBreakdown(monthsInRange, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.range.label).toBe("2026-04");
  });

  test("range label spans months when start < end", () => {
    const months = [
      month("2026-03-01", [cat({ id: "g", name: "Groceries", activity: -100_000 })]),
      month("2026-04-01", [cat({ id: "g", name: "Groceries", activity: -200_000 })]),
    ];
    const r = computeSpendingBreakdown(months, [], {
      start: "2026-03-01",
      end: "2026-04-01",
    });
    expect(r.range.label).toBe("2026-03 to 2026-04 (2 months)");
    expect(r.spending[0].magnitude).toBe(300_000);
  });

  test("largestOutflow finds the most-negative tx, skipping transfers", () => {
    const txs: Transaction[] = [
      tx({ id: "small", amount: -10_000, payee_name: "Coffee" }),
      tx({ id: "big", amount: -800_000, payee_name: "Apple" }),
      tx({
        id: "transfer",
        amount: -5_000_000,
        transfer_account_id: "acc-2",
      }),
    ];
    const r = computeSpendingBreakdown(monthsInRange, txs, {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.largestOutflow?.parent_id).toBe("big");
    expect(r.largestOutflow?.amount).toBe(-800_000);
  });

  test("largestOutflow drills into subtransactions", () => {
    const txs: Transaction[] = [
      tx({
        id: "split",
        amount: -500_000,
        payee_name: "Costco",
        subtransactions: [
          {
            id: "sub-a",
            transaction_id: "split",
            amount: -200_000,
            memo: null,
            payee_id: null,
            payee_name: null,
            category_id: "cat-x",
            category_name: "Generic",
          },
          {
            id: "sub-b",
            transaction_id: "split",
            amount: -300_000,
            memo: null,
            payee_id: null,
            payee_name: "Wholesale",
            category_id: "cat-x",
            category_name: "Generic",
          },
        ],
      }),
    ];
    const r = computeSpendingBreakdown(monthsInRange, txs, {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.largestOutflow?.sub_id).toBe("sub-b");
    expect(r.largestOutflow?.amount).toBe(-300_000);
    expect(r.largestOutflow?.payee_name).toBe("Wholesale");
  });

  test("mostFrequent counts category names, skipping Uncategorized and Inflow", () => {
    const txs: Transaction[] = [
      tx({ id: "1", category_name: "Groceries" }),
      tx({ id: "2", category_name: "Groceries" }),
      tx({ id: "3", category_name: "Groceries" }),
      tx({ id: "4", category_name: "Coffee" }),
      tx({ id: "5", category_name: "Uncategorized" }),
      tx({ id: "6", category_name: "Inflow: Ready to Assign" }),
    ];
    const r = computeSpendingBreakdown(monthsInRange, txs, {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(r.mostFrequent).toEqual({ categoryName: "Groceries", count: 3 });
  });
});

describe("renderSpendingBreakdown", () => {
  test("renders headline totals and category sections", () => {
    const months: MonthDetail[] = [
      month("2026-04-01", [
        cat({ id: "g", name: "Groceries", activity: -100_000 }),
        cat({ id: "r", name: "Rent", activity: -2_000_000 }),
      ]),
    ];
    const r = computeSpendingBreakdown(months, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    const out = renderSpendingBreakdown(r, { includeIds: false });
    expect(out).toContain("Spending Breakdown: 2026-04");
    expect(out).toContain("Total Spending: $2,100.00");
    expect(out).toContain("Rent: $2,000.00");
  });

  test("omits Average Monthly Spending in single-month range", () => {
    const months: MonthDetail[] = [
      month("2026-04-01", [
        cat({ id: "g", name: "Groceries", activity: -100_000 }),
      ]),
    ];
    const r = computeSpendingBreakdown(months, [], {
      start: "2026-04-01",
      end: "2026-04-01",
    });
    expect(renderSpendingBreakdown(r, { includeIds: false })).not.toContain(
      "Average Monthly Spending",
    );
  });
});
