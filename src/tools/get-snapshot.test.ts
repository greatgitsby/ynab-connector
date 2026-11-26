import { describe, test, expect } from "bun:test";
import type { Account, Category, MonthDetail, Transaction } from "../ynab";
import { computeSnapshot, SnapshotSchema } from "./get-snapshot";

const account = (overrides: Partial<Account>): Account => ({
  id: "acc-x",
  name: "Account",
  type: "checking",
  on_budget: true,
  closed: false,
  transfer_payee_id: null,
  deleted: false,
  balance: 1_000_000,
  cleared_balance: 950_000,
  uncleared_balance: 50_000,
  ...overrides,
});

const cat = (overrides: Partial<Category>): Category => ({
  id: "cat-x",
  category_group_id: "grp-x",
  name: "Generic",
  hidden: false,
  internal: false,
  deleted: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "t-x",
  date: "2026-05-10",
  amount: -10_000,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "checking",
  account_name: "Checking",
  payee_id: null,
  payee_name: "Costco",
  category_id: null,
  category_name: null,
  flag_color: null,
  transfer_account_id: null,
  deleted: false,
  ...overrides,
});

const month: MonthDetail = {
  month: "2026-05-01",
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 1_500_000,
  age_of_money: 42,
  deleted: false,
  categories: [
    cat({ id: "over", name: "Dining", balance: -20_000 }),
    cat({
      id: "short",
      name: "Rent",
      goal_type: "MF",
      goal_target: 100_000,
      goal_under_funded: 60_000,
    }),
    cat({
      id: "snoozed",
      name: "Gifts",
      goal_type: "MF",
      goal_target: 50_000,
      goal_under_funded: 50_000,
      goal_snoozed_at: "2026-05-02T00:00:00Z",
    }),
  ],
};

describe("computeSnapshot", () => {
  const snapshot = () =>
    computeSnapshot(
      {
        uncategorized: [
          tx({ id: "u-bank" }),
          tx({ id: "u-401k", account_id: "401k" }),
        ],
        unapproved: [tx({ id: "a-1", category_id: "over", approved: false })],
        recent: [
          tx({ id: "r-new", date: "2026-05-12", import_id: "imp-1" }),
          tx({ id: "r-old", date: "2026-04-01", import_id: "imp-2" }),
          tx({ id: "r-manual", date: "2026-05-12" }),
        ],
        month,
        accounts: [
          account({ id: "401k", name: "401(k)", on_budget: false }),
          account({ id: "checking", name: "Checking" }),
          account({ id: "old", name: "Old", closed: true }),
        ],
      },
      { iso: "USD", maxRows: 10, recentSince: "2026-05-01" },
    );

  test("conforms to SnapshotSchema", () => {
    expect(() => SnapshotSchema.parse(snapshot())).not.toThrow();
  });

  test("applies the inbox rules and leaves out tracking-account rows", () => {
    const s = snapshot();
    expect(s.uncategorized.rows.map((r) => r.id)).toEqual(["u-bank"]);
    expect(s.unapproved.rows.map((r) => r.id)).toEqual(["a-1"]);
    expect(s.age_of_money).toBe(42);
  });

  test("totals overspent and underfunded, skipping snoozed goals", () => {
    const s = snapshot();
    expect(s.overspent).toEqual({
      count: 1,
      total: -20_000,
      categories: [{ id: "over", name: "Dining", amount: -20_000 }],
    });
    expect(s.underfunded.total).toBe(60_000);
    expect(s.underfunded.categories.map((c) => c.id)).toEqual(["short"]);
  });

  test("recent imports keep imported rows since the cutoff", () => {
    expect(snapshot().recent_imports.rows.map((r) => r.id)).toEqual(["r-new"]);
  });

  test("accounts drop closed ones and list on-budget first", () => {
    expect(snapshot().accounts.map((a) => a.id)).toEqual(["checking", "401k"]);
  });
});
