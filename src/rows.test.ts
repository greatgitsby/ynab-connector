import { describe, expect, test } from "vitest";
import type { Transaction } from "./ynab";
import { flattenTransactions, pickRow } from "./rows";

const tx = (over: Partial<Transaction>): Transaction => ({
  id: "t1",
  date: "2026-11-01",
  amount: -5000,
  memo: "parent memo",
  cleared: "cleared",
  approved: true,
  flag_color: null,
  account_id: "a1",
  account_name: "Checking",
  payee_id: "p1",
  payee_name: "Store",
  category_id: "c1",
  category_name: "Food",
  transfer_account_id: null,
  deleted: false,
  ...over,
});

const sub = (id: string, amount: number, over: Record<string, unknown> = {}) => ({
  id,
  transaction_id: "t1",
  amount,
  memo: null,
  payee_id: null,
  payee_name: null,
  category_id: `c-${id}`,
  category_name: `Cat ${id}`,
  transfer_account_id: null,
  deleted: false,
  ...over,
});

describe("flattenTransactions", () => {
  test("a split becomes one row per live part, inheriting payee and memo", () => {
    const rows = flattenTransactions([
      tx({
        category_id: null,
        category_name: "Split",
        subtransactions: [sub("s1", -3000, { memo: "own memo" }), sub("s2", -2000, { payee_id: "p2", payee_name: "Other" }), sub("s3", -9, { deleted: true })],
      }),
    ]);
    expect(rows.map((r) => [r.id, r.part_id, r.amount, r.payee, r.category_id, r.memo])).toEqual([
      ["t1", "s1", -3000, "Store", "c-s1", "own memo"],
      ["t1", "s2", -2000, "Other", "c-s2", "parent memo"],
    ]);
  });

  test("a hybrid part row keeps its parent's id; deleted rows drop", () => {
    const rows = flattenTransactions([
      tx({ id: "s9", type: "subtransaction", parent_transaction_id: "t9" }),
      tx({ id: "gone", deleted: true }),
    ]);
    expect(rows.map((r) => [r.id, r.part_id])).toEqual([["t9", "s9"]]);
  });
});

describe("pickRow", () => {
  test("returns only chosen fields, adds part_id with id, and drops null memo", () => {
    const [plain] = flattenTransactions([tx({ memo: null })]);
    expect(pickRow(plain, ["id", "amount", "memo"])).toEqual({ id: "t1", amount: -5000 });
    const [part] = flattenTransactions([tx({ subtransactions: [sub("s1", -5000)] })]);
    expect(pickRow(part, ["id", "category"])).toEqual({ id: "t1", part_id: "s1", category: "Cat s1" });
  });
});
