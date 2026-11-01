import { describe, test, expect } from "vitest";
import type { Account, Transaction } from "../ynab";
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
  transfer_payee_id: null,
  deleted: false,
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
  deleted: false,
  ...overrides,
});

const opts = (since: string, until = "2026-05-01") => ({
  since,
  until,
  iso: "USD",
});

describe("computeNetWorth", () => {
  test("current snapshot is sum of open account balances", () => {
    const accounts = [
      account({ id: "checking", balance: 5_000_000 }),
      account({ id: "savings", balance: 10_000_000 }),
      account({ id: "credit", balance: -2_000_000 }),
      account({ id: "closed", balance: 999_999, closed: true }),
    ];
    const r = computeNetWorth(accounts, [], opts("2026-05-01"));
    expect(r.current).toEqual({
      net: 13_000_000,
      assets: 15_000_000,
      liabilities: -2_000_000,
    });
  });

  test("walks balances back through later transactions", () => {
    // $100 left checking on 2026-05-10, so April ended $100 higher.
    const accounts = [account({ id: "checking", balance: 1_000_000 })];
    const txs = [
      tx({ id: "t1", account_id: "checking", date: "2026-05-10", amount: -100_000 }),
      // A transfer between two accounts cancels out.
      tx({ id: "t2", account_id: "checking", date: "2026-05-12", amount: -50_000 }),
      tx({ id: "t3", account_id: "savings", date: "2026-05-12", amount: 50_000 }),
    ];
    const r = computeNetWorth(
      [...accounts, account({ id: "savings", balance: 50_000 })],
      txs,
      opts("2026-04-01"),
    );
    expect(r.history.map((h) => [h.month, h.net, h.change])).toEqual([
      ["2026-04-01", 1_150_000, null],
      ["2026-05-01", 1_050_000, -100_000],
    ]);
    expect(() => NetWorthReportSchema.parse(r)).not.toThrow();
  });

  test("open_accounts sorts by balance desc", () => {
    const accounts = [
      account({ id: "a", name: "Small", balance: 100_000 }),
      account({ id: "b", name: "Big", balance: 9_000_000 }),
      account({ id: "c", name: "Mid", balance: 1_000_000 }),
    ];
    const r = computeNetWorth(accounts, [], opts("2026-05-01"));
    expect(r.open_accounts.map((a) => a.name)).toEqual(["Big", "Mid", "Small"]);
  });
});

describe("renderNetWorth", () => {
  test("renders the snapshot, history, range change, and accounts", () => {
    const r = computeNetWorth(
      [account({ id: "checking", name: "Checking", balance: 1_000_000 })],
      [tx({ account_id: "checking", date: "2026-05-10", amount: -100_000 })],
      opts("2026-04-01"),
    );
    const out = renderNetWorth(r, { includeIds: false });
    expect(out).toContain("Net worth: $1,000.00");
    expect(out).toContain("## End of month");
    expect(out).toContain("Range change: -$100.00");
    expect(out).toContain("- Checking [checking]: $1,000.00");
  });
});
