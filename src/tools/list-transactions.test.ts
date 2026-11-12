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

const fetched: Transaction[] = [
  tx("t1", { date: "2026-03-10", amount: -10_000 }),
  tx("t3", { date: "2026-05-02", amount: -5_000 }),
  tx("t2", { date: "2026-03-20", amount: -2_500 }),
  // A split parent from the account endpoint, with a deleted part.
  tx("p2", {
    date: "2026-03-05",
    amount: -3_000,
    category_name: "Split",
    subtransactions: [
      { id: "p2-a", transaction_id: "p2", amount: -2_000, memo: "Spotify", payee_id: null, payee_name: null, category_id: "c-a", category_name: "Music", transfer_account_id: null, transfer_transaction_id: null, deleted: false },
      { id: "p2-b", transaction_id: "p2", amount: -1_000, memo: null, payee_id: null, payee_name: "Netflix", category_id: "c-b", category_name: "TV", transfer_account_id: null, transfer_transaction_id: null, deleted: false },
      { id: "p2-x", transaction_id: "p2", amount: -9_000, memo: null, payee_id: null, payee_name: null, category_id: "c-a", category_name: "Gone", transfer_account_id: null, transfer_transaction_id: null, deleted: true },
    ],
  }),
  // A hybrid split part from the category endpoint.
  tx("s1", {
    date: "2026-05-01",
    amount: -1_500,
    type: "subtransaction",
    parent_transaction_id: "p1",
  }),
];

describe("computeTransactionList", () => {
  test("lists the most recent `limit`, but totals every match", () => {
    const r = computeTransactionList(fetched, { limit: 2, iso: "USD" });
    expect(r.transactions.map((t) => t.id)).toEqual(["t3", "s1"]);
    expect(r.count).toBe(5);
    expect(r.total).toBe(-22_000);
  });

  test("totals by month in chronological order", () => {
    const r = computeTransactionList(fetched, { limit: 100, iso: "USD" });
    expect(r.by_month).toEqual([
      { month: "2026-03-01", count: 3, total: -15_500 },
      { month: "2026-05-01", count: 2, total: -6_500 },
    ]);
  });

  test("result, hybrid rows included, conforms to TransactionListSchema", () => {
    const r = computeTransactionList(fetched, { limit: 100, iso: "USD" });
    expect(() => TransactionListSchema.parse(r)).not.toThrow();
  });
});

describe("renderTransactionList", () => {
  test("lists a split's live parts under it", () => {
    const out = renderTransactionList(
      computeTransactionList(fetched, { limit: 100, iso: "USD" }),
      { includeIds: true },
    );
    expect(out).toContain(
      "(2-way split) [Checking] — id p2\n  - -$2.00 → Music \"Spotify\" — id p2-a\n  - -$1.00 Netflix → TV — id p2-b",
    );
    expect(out).not.toContain("Gone");
  });

  test("says so when nothing matches", () => {
    expect(
      renderTransactionList(
        computeTransactionList([], { limit: 10, iso: "USD" }),
        { includeIds: false },
      ),
    ).toBe("No transactions match.");
  });
});
