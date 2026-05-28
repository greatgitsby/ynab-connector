import { describe, test, expect } from "vitest";
import type { Transaction } from "../ynab";
import {
  computeTransactionList,
  renderTransactionList,
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
  ...overrides,
});

describe("computeTransactionList", () => {
  test("takes the last `limit` txs and reverses to most-recent-first", () => {
    const fetched: Transaction[] = [
      tx("t1", { date: "2026-05-01" }),
      tx("t2", { date: "2026-05-02" }),
      tx("t3", { date: "2026-05-03" }),
      tx("t4", { date: "2026-05-04" }),
      tx("t5", { date: "2026-05-05" }),
    ];
    const r = computeTransactionList(fetched, { limit: 3 });
    expect(r.transactions.map((t) => t.id)).toEqual(["t5", "t4", "t3"]);
  });

  test("returns all when fetched < limit", () => {
    const fetched: Transaction[] = [tx("t1"), tx("t2")];
    const r = computeTransactionList(fetched, { limit: 100 });
    expect(r.transactions).toHaveLength(2);
  });

  test("empty input -> empty output", () => {
    expect(
      computeTransactionList([], { limit: 100 }).transactions,
    ).toHaveLength(0);
  });
});

describe("renderTransactionList", () => {
  test("emits 'No transactions match.' on empty", () => {
    expect(
      renderTransactionList({ transactions: [] }, { includeIds: false }),
    ).toBe("No transactions match.");
  });

  test("one line per tx, separator newline", () => {
    const out = renderTransactionList(
      { transactions: [tx("a"), tx("b")] },
      { includeIds: false },
    );
    expect(out.split("\n")).toHaveLength(2);
  });
});
