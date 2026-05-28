import { describe, test, expect } from "vitest";
import type { Category, Transaction } from "./ynab";
import {
  isSpendingCategory,
  isInflowRta,
  isUncategorizedInternal,
  isInboxableTx,
  isTransferTx,
} from "./predicates";

const cat = (overrides: Partial<Category>): Category => ({
  id: "cat-1",
  category_group_id: "grp-1",
  name: "Groceries",
  hidden: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const tx = (overrides: Partial<Transaction>): Transaction => ({
  id: "tx-1",
  date: "2026-05-01",
  amount: -50_000,
  memo: null,
  cleared: "cleared",
  approved: true,
  account_id: "acc-1",
  account_name: "Checking",
  payee_id: null,
  payee_name: "Costco",
  category_id: "cat-1",
  category_name: "Groceries",
  flag_color: null,
  transfer_account_id: null,
  ...overrides,
});

describe("isSpendingCategory", () => {
  test("accepts a visible non-internal category", () => {
    expect(isSpendingCategory(cat({}))).toBe(true);
  });

  test("rejects hidden", () => {
    expect(isSpendingCategory(cat({ hidden: true }))).toBe(false);
  });

  test("rejects deleted", () => {
    expect(isSpendingCategory(cat({ deleted: true }))).toBe(false);
  });

  test("rejects internal", () => {
    expect(isSpendingCategory(cat({ internal: true }))).toBe(false);
  });
});

describe("isInflowRta", () => {
  test("accepts internal categories with names starting with Inflow", () => {
    expect(
      isInflowRta(cat({ internal: true, name: "Inflow: Ready to Assign" })),
    ).toBe(true);
  });

  test("rejects non-internal categories", () => {
    expect(isInflowRta(cat({ name: "Inflow: Ready to Assign" }))).toBe(false);
  });

  test("rejects internal categories with other names", () => {
    expect(isInflowRta(cat({ internal: true, name: "Uncategorized" }))).toBe(
      false,
    );
  });
});

describe("isUncategorizedInternal", () => {
  test("accepts internal Uncategorized only", () => {
    expect(
      isUncategorizedInternal(cat({ internal: true, name: "Uncategorized" })),
    ).toBe(true);
  });

  test("rejects a user-named 'Uncategorized' that is not internal", () => {
    expect(isUncategorizedInternal(cat({ name: "Uncategorized" }))).toBe(false);
  });

  test("rejects internal Inflow", () => {
    expect(
      isUncategorizedInternal(
        cat({ internal: true, name: "Inflow: Ready to Assign" }),
      ),
    ).toBe(false);
  });
});

describe("isInboxableTx", () => {
  test("accepts a regular non-transfer", () => {
    expect(isInboxableTx(tx({}))).toBe(true);
  });

  test("accepts an unapproved transfer", () => {
    expect(
      isInboxableTx(tx({ transfer_account_id: "acc-2", approved: false })),
    ).toBe(true);
  });

  test("rejects an approved transfer", () => {
    expect(
      isInboxableTx(tx({ transfer_account_id: "acc-2", approved: true })),
    ).toBe(false);
  });
});

describe("isTransferTx", () => {
  test("true when transfer_account_id is set", () => {
    expect(isTransferTx(tx({ transfer_account_id: "acc-2" }))).toBe(true);
  });

  test("false when transfer_account_id is null", () => {
    expect(isTransferTx(tx({}))).toBe(false);
  });
});
