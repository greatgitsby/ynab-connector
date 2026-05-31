import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { Account, BudgetDetail, Transaction } from "../ynab";
import {
  computeNetWorth,
  renderNetWorth,
  NetWorthReportSchema,
} from "./reflect-net-worth";

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

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "t-x",
  date: "2026-05-01",
  amount: 0,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-x",
  account_name: "Account",
  payee_id: null,
  payee_name: null,
  category_id: null,
  category_name: null,
  flag_color: null,
  transfer_account_id: null,
  ...overrides,
});

const budget = (overrides: Partial<BudgetDetail> = {}): BudgetDetail => ({
  id: "b-1",
  name: "Test Plan",
  last_modified_on: "2026-05-20",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  currency_format: { iso_code: "USD", decimal_digits: 2 },
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-20T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("computeNetWorth", () => {
  test("current snapshot is sum of open account balances", () => {
    const b = budget({
      accounts: [
        account({ id: "checking", balance: 5_000_000 }),
        account({ id: "savings", balance: 10_000_000 }),
        account({ id: "credit", balance: -2_000_000 }),
        account({ id: "closed", balance: 999_999, closed: true }),
      ],
    });
    const r = computeNetWorth(b, [], { monthsBack: 1 });
    expect(r.current.assets).toBe(15_000_000);
    expect(r.current.liabilities).toBe(-2_000_000);
    expect(r.current.net).toBe(13_000_000);
  });

  test("historical reconstruction walks balances back through later transactions", () => {
    // Current balance: 1,000,000 in checking. A $100,000 outflow happened on
    // 2026-05-10. So end of April balance = 1,000,000 + 100,000 = 1,100,000.
    const b = budget({
      accounts: [account({ id: "checking", balance: 1_000_000 })],
    });
    const txs = [
      tx({
        id: "t1",
        account_id: "checking",
        date: "2026-05-10",
        amount: -100_000,
      }),
    ];
    const r = computeNetWorth(b, txs, { monthsBack: 2 });
    expect(r.history[0].month).toBe("2026-04-01");
    expect(r.history[0].snapshot?.net).toBe(1_100_000);
    expect(r.history[1].month).toBe("2026-05-01");
    expect(r.history[1].snapshot?.net).toBe(1_000_000);
  });

  test("history.delta is null on the first row, then row.net - prev.net", () => {
    const b = budget({
      accounts: [account({ id: "checking", balance: 1_000_000 })],
    });
    const txs = [
      tx({ account_id: "checking", date: "2026-05-10", amount: -100_000 }),
    ];
    const r = computeNetWorth(b, txs, { monthsBack: 2 });
    expect(r.history[0].delta).toBeNull();
    expect(r.history[1].delta).toBe(-100_000);
  });

  test("rangeChange is null for < 2 months", () => {
    const r = computeNetWorth(budget({ accounts: [] }), [], { monthsBack: 1 });
    expect(r.rangeChange).toBeNull();
  });

  test("rangeChange surfaces last - first when both snapshots exist", () => {
    const b = budget({
      accounts: [account({ id: "checking", balance: 1_000_000 })],
    });
    const txs = [
      tx({ account_id: "checking", date: "2026-05-10", amount: -100_000 }),
    ];
    const r = computeNetWorth(b, txs, { monthsBack: 2 });
    expect(r.rangeChange?.delta).toBe(-100_000);
    expect(r.rangeChange?.firstNet).toBe(1_100_000);
  });

  test("openAccounts sorts by balance desc", () => {
    const b = budget({
      accounts: [
        account({ id: "a", name: "Small", balance: 100_000 }),
        account({ id: "b", name: "Big", balance: 9_000_000 }),
        account({ id: "c", name: "Mid", balance: 1_000_000 }),
      ],
    });
    const r = computeNetWorth(b, [], { monthsBack: 1 });
    expect(r.openAccounts.map((a) => a.name)).toEqual(["Big", "Mid", "Small"]);
  });

  test("compute output conforms to the declared outputSchema", () => {
    const b = budget({
      accounts: [account({ id: "checking", balance: 1_000_000 })],
    });
    const txs = [
      tx({ account_id: "checking", date: "2026-05-10", amount: -100_000 }),
    ];
    const r = computeNetWorth(b, txs, { monthsBack: 2 });
    expect(() => NetWorthReportSchema.parse(r)).not.toThrow();
  });
});

describe("renderNetWorth", () => {
  test("renders title, current snapshot, history header, and per-account list", () => {
    const b = budget({
      accounts: [account({ id: "checking", balance: 1_000_000 })],
    });
    const report = computeNetWorth(b, [], { monthsBack: 2 });
    const out = renderNetWorth(report, { includeIds: false });
    expect(out).toContain("Net Worth: Test Plan");
    expect(out).toContain("## Current snapshot");
    expect(out).toContain("## Historical net worth");
    expect(out).toContain("## By account (current)");
  });
});
