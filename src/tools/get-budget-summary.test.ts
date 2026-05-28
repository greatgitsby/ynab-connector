import { describe, test, expect } from "vitest";
import type { Account, Budget, MonthDetail } from "../ynab";
import {
  computeBudgetSummary,
  renderBudgetSummary,
} from "./get-budget-summary";

const account = (overrides: Partial<Account>): Account => ({
  id: "acc-x",
  name: "Account",
  type: "checking",
  on_budget: true,
  closed: false,
  balance: 0,
  cleared_balance: 0,
  uncleared_balance: 0,
  ...overrides,
});

const monthDetail = (overrides: Partial<MonthDetail> = {}): MonthDetail => ({
  month: "2026-05-01",
  income: 5_000_000,
  budgeted: 3_000_000,
  activity: -2_500_000,
  to_be_budgeted: 750_000,
  age_of_money: 14,
  categories: [],
  ...overrides,
});

const budget = (overrides: Partial<Budget> = {}): Budget => ({
  id: "b-1",
  name: "Test Plan",
  last_modified_on: "2026-05-01",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  ...overrides,
});

describe("computeBudgetSummary", () => {
  test("counts open on-budget and off-budget accounts", () => {
    const accounts = [
      account({ id: "checking", on_budget: true }),
      account({ id: "savings", on_budget: true }),
      account({ id: "tracking", on_budget: false }),
      account({ id: "closed", on_budget: true, closed: true }),
    ];
    const r = computeBudgetSummary(budget(), accounts, monthDetail());
    expect(r.accountCounts.onBudget).toBe(2);
    expect(r.accountCounts.offBudget).toBe(1);
  });

  test("reads readyToAssign from current month's to_be_budgeted", () => {
    const r = computeBudgetSummary(
      budget(),
      [],
      monthDetail({ to_be_budgeted: 999 }),
    );
    expect(r.readyToAssign).toBe(999);
  });

  test("defaults iso to USD when currency_format is missing", () => {
    const r = computeBudgetSummary(
      budget({ currency_format: undefined }),
      [],
      monthDetail(),
    );
    expect(r.iso).toBe("USD");
  });
});

describe("renderBudgetSummary", () => {
  test("renders the headline block and current month sub-block", () => {
    const r = computeBudgetSummary(budget(), [], monthDetail());
    const out = renderBudgetSummary(r);
    expect(out).toContain("Budget: Test Plan");
    expect(out).toContain("Accounts: 0 on-budget, 0 off-budget");
    expect(out).toContain("Ready to assign: $750.00");
    expect(out).toContain("Current month (2026-05-01)");
    expect(out).toContain("Age of money: 14 days");
  });

  test("omits Age of money when null", () => {
    const r = computeBudgetSummary(
      budget(),
      [],
      monthDetail({ age_of_money: null }),
    );
    expect(renderBudgetSummary(r)).not.toContain("Age of money");
  });
});
