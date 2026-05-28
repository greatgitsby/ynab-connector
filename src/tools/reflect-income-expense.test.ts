import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type {
  BudgetDetail,
  Category,
  CategoryGroup,
  MonthDetail,
  Transaction,
} from "../ynab";
import {
  computeIncomeExpensePivot,
  renderIncomeExpensePivot,
} from "./reflect-income-expense";

// ---- Fixtures

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

const group = (
  overrides: Partial<CategoryGroup> & { id: string; name: string },
): CategoryGroup => ({
  hidden: false,
  categories: [],
  ...overrides,
});

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "t-x",
  date: "2026-03-15",
  amount: 0,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-1",
  account_name: "Checking",
  payee_id: null,
  payee_name: null,
  category_id: null,
  category_name: null,
  flag_color: null,
  transfer_account_id: null,
  ...overrides,
});

// A budget with three months (March/April/May 2026), two visible groups
// ("Monthly Bills" and "Fun"), one hidden group ("Old Stuff"), an Inflow:RTA
// category, and an Uncategorized internal category.
const fixtureBudget = (): BudgetDetail => ({
  id: "budget-1",
  name: "Test Plan",
  last_modified_on: "2026-05-01",
  first_month: "2025-01-01",
  last_month: "2026-05-01",
  currency_format: { iso_code: "USD", decimal_digits: 2 },
  category_groups: [
    group({ id: "grp-bills", name: "Monthly Bills" }),
    group({ id: "grp-fun", name: "Fun" }),
    group({ id: "grp-old", name: "Old Stuff", hidden: true }),
    group({ id: "grp-internal", name: "Internal" }),
  ],
  months: [
    month("2026-03-01", [
      cat({
        id: "rta",
        category_group_id: "grp-internal",
        name: "Inflow: Ready to Assign",
        internal: true,
        activity: 5_000_000,
      }),
      cat({
        id: "uncat",
        category_group_id: "grp-internal",
        name: "Uncategorized",
        internal: true,
        activity: -25_000,
      }),
      cat({
        id: "rent",
        category_group_id: "grp-bills",
        name: "Rent",
        activity: -2_000_000,
      }),
      cat({
        id: "groceries",
        category_group_id: "grp-bills",
        name: "Groceries",
        activity: -300_000,
      }),
      cat({
        id: "games",
        category_group_id: "grp-fun",
        name: "Games",
        activity: -50_000,
      }),
      cat({
        id: "hidden-bucket",
        category_group_id: "grp-old",
        name: "Old Subscriptions",
        activity: -10_000,
      }),
    ]),
    month("2026-04-01", [
      cat({
        id: "rta",
        category_group_id: "grp-internal",
        name: "Inflow: Ready to Assign",
        internal: true,
        activity: 5_000_000,
      }),
      cat({
        id: "uncat",
        category_group_id: "grp-internal",
        name: "Uncategorized",
        internal: true,
        activity: 0,
      }),
      cat({
        id: "rent",
        category_group_id: "grp-bills",
        name: "Rent",
        activity: -2_000_000,
      }),
      cat({
        id: "groceries",
        category_group_id: "grp-bills",
        name: "Groceries",
        activity: -400_000,
      }),
      cat({
        id: "games",
        category_group_id: "grp-fun",
        name: "Games",
        activity: -75_000,
      }),
    ]),
    month("2026-05-01", [
      cat({
        id: "rta",
        category_group_id: "grp-internal",
        name: "Inflow: Ready to Assign",
        internal: true,
        activity: 5_000_000,
      }),
      cat({
        id: "uncat",
        category_group_id: "grp-internal",
        name: "Uncategorized",
        internal: true,
        activity: 0,
      }),
      cat({
        id: "rent",
        category_group_id: "grp-bills",
        name: "Rent",
        activity: -2_000_000,
      }),
      cat({
        id: "groceries",
        category_group_id: "grp-bills",
        name: "Groceries",
        activity: -350_000,
      }),
      cat({
        id: "games",
        category_group_id: "grp-fun",
        name: "Games",
        activity: -100_000,
      }),
    ]),
  ],
});

// Transactions: two payees feeding Inflow:RTA over the window.
const fixtureTxs = (): Transaction[] => [
  tx({
    id: "t-1",
    date: "2026-03-15",
    payee_name: "Acme Corp",
    category_id: "rta",
    amount: 4_000_000,
  }),
  tx({
    id: "t-2",
    date: "2026-03-20",
    payee_name: "Side Gig LLC",
    category_id: "rta",
    amount: 1_000_000,
  }),
  tx({
    id: "t-3",
    date: "2026-04-15",
    payee_name: "Acme Corp",
    category_id: "rta",
    amount: 5_000_000,
  }),
  tx({
    id: "t-4",
    date: "2026-05-15",
    payee_name: "Acme Corp",
    category_id: "rta",
    amount: 5_000_000,
  }),
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-20T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("computeIncomeExpensePivot", () => {
  test("aggregates income by payee, sorted by total desc", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    expect(r.income.rows).toHaveLength(2);
    expect(r.income.rows[0].label).toBe("Acme Corp");
    expect(r.income.rows[0].monthly.get("2026-03-01")).toBe(4_000_000);
    expect(r.income.rows[0].monthly.get("2026-05-01")).toBe(5_000_000);
    expect(r.income.rows[1].label).toBe("Side Gig LLC");
    expect(r.income.rows[1].monthly.get("2026-03-01")).toBe(1_000_000);
  });

  test("monthly income totals sum across payees", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    expect(r.income.monthly.get("2026-03-01")).toBe(5_000_000);
    expect(r.income.monthly.get("2026-04-01")).toBe(5_000_000);
    expect(r.income.monthly.get("2026-05-01")).toBe(5_000_000);
  });

  test("hoists internal Uncategorized as a separate row, only when it has activity", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    expect(r.uncategorized).not.toBeNull();
    expect(r.uncategorized?.label).toBe("Uncategorized Transactions");
    expect(r.uncategorized?.monthly.get("2026-03-01")).toBe(-25_000);
    // April and May had zero Uncategorized activity in the fixture.
    expect(r.uncategorized?.monthly.get("2026-04-01")).toBe(0);
    expect(r.uncategorized?.monthly.get("2026-05-01")).toBe(0);
  });

  test("drops hidden groups", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    const names = r.groups.map((g) => g.name);
    expect(names).not.toContain("Old Stuff");
  });

  test("groups expense rows by category_group, in budget order, most-negative first", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    expect(r.groups.map((g) => g.name)).toEqual(["Monthly Bills", "Fun"]);
    const bills = r.groups[0];
    // Rent (-6M total) should sort before Groceries (-1.05M total).
    expect(bills.rows.map((r) => r.label)).toEqual(["Rent", "Groceries"]);
  });

  test("group monthly totals sum the rows", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    const bills = r.groups[0];
    expect(bills.monthly.get("2026-03-01")).toBe(-2_300_000);
    expect(bills.monthly.get("2026-04-01")).toBe(-2_400_000);
  });

  test("totals.expense includes Uncategorized + every group", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    // March expense = -2,000,000 (rent) - 300,000 (groceries) - 50,000 (games) - 25,000 (uncat) = -2,375,000.
    expect(r.totals.expense.get("2026-03-01")).toBe(-2_375_000);
  });

  test("totals.net is income + expense per month (expense already negative)", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    expect(r.totals.net.get("2026-03-01")).toBe(5_000_000 - 2_375_000);
    expect(r.totals.net.get("2026-04-01")).toBe(5_000_000 - 2_475_000);
  });

  test("excludes Inflow:RTA from expense rows", () => {
    const r = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    const allLabels = r.groups.flatMap((g) => g.rows.map((row) => row.label));
    expect(allLabels).not.toContain("Inflow: Ready to Assign");
  });

  test("emits a truncation note when the budget is younger than the window", () => {
    const b = fixtureBudget();
    b.first_month = "2026-03-01";
    const r = computeIncomeExpensePivot(b, fixtureTxs(), { monthsBack: 6 });
    expect(r.truncationNote).toBe(
      "(Budget starts 2026-03-01; window truncated to 3 of 6 requested months.)",
    );
  });

  test("splits sub-transaction income by sub payee when set", () => {
    const txs: Transaction[] = [
      tx({
        id: "split-1",
        date: "2026-03-10",
        payee_name: "Parent Payee",
        category_id: null,
        amount: 5_000_000,
        subtransactions: [
          {
            id: "sub-a",
            transaction_id: "split-1",
            amount: 3_000_000,
            memo: null,
            payee_id: null,
            payee_name: "Sub Payee A",
            category_id: "rta",
            category_name: null,
          },
          {
            id: "sub-b",
            transaction_id: "split-1",
            amount: 2_000_000,
            memo: null,
            payee_id: null,
            payee_name: null, // falls back to parent
            category_id: "rta",
            category_name: null,
          },
        ],
      }),
    ];
    const r = computeIncomeExpensePivot(fixtureBudget(), txs, {
      monthsBack: 3,
    });
    const labels = r.income.rows.map((row) => row.label);
    expect(labels).toContain("Sub Payee A");
    expect(labels).toContain("Parent Payee");
  });
});

describe("renderIncomeExpensePivot", () => {
  test("includes the budget name, range header, and net income row", () => {
    const pivot = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    const out = renderIncomeExpensePivot(pivot, { includeIds: false });
    expect(out).toContain("Income v Expense: Test Plan");
    expect(out).toContain("2026-03");
    expect(out).toContain("Net Income");
    expect(out).toContain("## Income (by payee)");
    expect(out).toContain("## Expense (by category, grouped)");
  });

  test("includes ids when includeIds is true", () => {
    const pivot = computeIncomeExpensePivot(fixtureBudget(), fixtureTxs(), {
      monthsBack: 3,
    });
    const out = renderIncomeExpensePivot(pivot, { includeIds: true });
    expect(out).toContain("— id rent");
    expect(out).toContain("— id games");
  });

  test("includes the truncation note in the rendered output", () => {
    const b = fixtureBudget();
    b.first_month = "2026-03-01";
    const pivot = computeIncomeExpensePivot(b, fixtureTxs(), { monthsBack: 6 });
    const out = renderIncomeExpensePivot(pivot, { includeIds: false });
    expect(out).toContain("window truncated to 3 of 6");
  });
});
