import { describe, test, expect } from "vitest";
import type { Transaction } from "../ynab";
import {
  computeTransactionList,
  renderTransactionList,
  TransactionListSchema,
} from "./list-transactions";

const tx = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id,
  date: "2026-05-01",
  amount: -1_000,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-1",
  account_name: "Checking",
  payee_id: null,
  payee_name: "Payee",
  category_id: null,
  category_name: "Generic",
  flag_color: null,
  transfer_account_id: null,
  deleted: false,
  ...overrides,
});

describe("computeTransactionList", () => {
  const fetched: Transaction[] = [
    tx("t1", { date: "2026-03-10", amount: -10_000 }),
    tx("t3", { date: "2026-05-02", amount: -5_000 }),
    tx("t2", { date: "2026-03-20", amount: -2_500 }),
    // A hybrid split part from the category endpoint.
    tx("s1", {
      date: "2026-05-01",
      amount: -1_500,
      type: "subtransaction",
      parent_transaction_id: "p1",
    }),
  ];

  test("lists the most recent `limit`, but totals every match", () => {
    const r = computeTransactionList(fetched, { limit: 2, iso: "USD" });
    expect(r.transactions.map((t) => t.id)).toEqual(["t3", "s1"]);
    expect(r.count).toBe(4);
    expect(r.total).toBe(-19_000);
  });

  test("totals by month in chronological order", () => {
    const r = computeTransactionList(fetched, { limit: 100, iso: "USD" });
    expect(r.by_month).toEqual([
      { month: "2026-03-01", count: 2, total: -12_500 },
      { month: "2026-05-01", count: 2, total: -6_500 },
    ]);
  });

  test("result, hybrid rows included, conforms to TransactionListSchema", () => {
    const r = computeTransactionList(fetched, { limit: 100, iso: "USD" });
    expect(() => TransactionListSchema.parse(r)).not.toThrow();
  });
});

describe("renderTransactionList", () => {
  test("says so when nothing matches", () => {
    expect(
      renderTransactionList(
        computeTransactionList([], { limit: 10, iso: "USD" }),
        { includeIds: false },
      ),
    ).toBe("No transactions match.");
  });
});
