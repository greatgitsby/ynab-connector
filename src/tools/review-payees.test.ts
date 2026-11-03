import { describe, test, expect } from "vitest";
import type { Payee, ScheduledTransaction, SubTransaction, Transaction } from "../ynab";
import {
  computePayeeReview,
  payeeKey,
  PayeeReviewSchema,
  renderPayeeReview,
} from "./review-payees";

const p = (id: string, name: string, over: Partial<Payee> = {}): Payee => ({
  id,
  name,
  transfer_account_id: null,
  deleted: false,
  ...over,
});

const tx = (id: string, payee_id: string | null, date: string, subs: Partial<SubTransaction>[] = []) =>
  ({
    id,
    date,
    amount: -1000,
    payee_id,
    deleted: false,
    subtransactions: subs.map((s, i) => ({ id: `${id}-${i}`, transaction_id: id, amount: -500, deleted: false, ...s })),
  }) as Transaction;

const st = (id: string, payee_id: string | null, subs: Partial<SubTransaction>[] = []) =>
  ({
    id,
    date_next: "2026-12-01",
    amount: -1000,
    payee_id,
    deleted: false,
    subtransactions: subs,
  }) as ScheduledTransaction;

const payees = [
  p("sb", "Starbucks"),
  p("sb2", "STARBUCKS #04412"),
  p("sbw", "Starbucks Westshore"),
  p("bb", "SQ *Blue Bottle"),
  p("bb2", "Blue Bottle"),
  p("star", "Star"),
  p("starm", "Star Market"),
  p("gym", "Gym"),
  p("never", "Never Used"),
  p("gone", "Starbucks Old", { deleted: true }),
  p("xfer", "Transfer : Savings", { transfer_account_id: "acc-2" }),
];

const transactions = [
  tx("t1", "sb", "2026-10-01"),
  tx("t2", "sb", "2026-10-20"),
  tx("t3", "sb2", "2025-01-01"),
  // A split whose part names a different payee counts for both.
  tx("t4", "sbw", "2026-03-03", [{ payee_id: "bb" }, { payee_id: "sbw" }]),
  tx("t5", "starm", "2026-01-01"),
  tx("t6", "starm", "2026-02-01"),
  tx("t7", "xfer", "2026-02-01"),
  { ...tx("t8", "never", "2026-02-01"), deleted: true },
];

const scheduled = [st("s1", "gym"), st("s2", null, [{ payee_id: "bb2", deleted: false }])];

describe("payeeKey", () => {
  test("ignores case, punctuation, store numbers, processor prefixes, and 'the'", () => {
    expect(payeeKey("STARBUCKS #04412")).toBe("starbucks");
    expect(payeeKey("SQ *Blue Bottle")).toBe("bluebottle");
    expect(payeeKey("The Home Depot")).toBe("homedepot");
    expect(payeeKey("Café Rio")).toBe("caferio");
    expect(payeeKey("7-Eleven")).toBe("7eleven");
  });
});

describe("computePayeeReview", () => {
  const review = computePayeeReview(payees, transactions, scheduled, 1);
  const usage = (id: string) =>
    [...review.little_used, ...review.duplicate_groups.flatMap((g) => g.payees)].find((u) => u.id === id);

  test("counts transactions, split parts, last use, and schedules; skips deleted and transfer payees", () => {
    expect(review.payee_count).toBe(9);
    expect(usage("sb")).toMatchObject({ transaction_count: 2, last_used: "2026-10-20" });
    expect(usage("sbw")).toMatchObject({ transaction_count: 1 });
    expect(usage("bb")).toMatchObject({ transaction_count: 1, last_used: "2026-03-03" });
    expect(usage("bb2")).toMatchObject({ transaction_count: 0, scheduled_count: 1 });
    expect(usage("never")).toMatchObject({ transaction_count: 0, last_used: null });
  });

  test("groups same-key and prefix names, most-used first, busiest group first", () => {
    expect(review.duplicate_groups.map((g) => g.payees.map((u) => u.id))).toEqual([
      ["sb", "sb2", "sbw"],
      ["bb", "bb2"],
    ]);
  });

  test("a short key does not swallow longer names", () => {
    const ids = review.duplicate_groups.flatMap((g) => g.payees.map((u) => u.id));
    expect(ids).not.toContain("star");
    expect(ids).not.toContain("starm");
  });

  test("little used: at most max_uses transactions and nothing scheduled", () => {
    expect(review.little_used.map((u) => u.id)).toEqual(["never", "star", "bb", "sb2", "sbw"]);
    expect(computePayeeReview(payees, transactions, scheduled, 0).little_used.map((u) => u.id)).toEqual([
      "never",
      "star",
    ]);
  });

  test("conforms to PayeeReviewSchema", () => {
    expect(() => PayeeReviewSchema.parse(review)).not.toThrow();
  });
});

describe("renderPayeeReview", () => {
  test("shows usage and ids on request", () => {
    const review = computePayeeReview(payees, transactions, scheduled, 1);
    const text = renderPayeeReview(review, 1, true);
    expect(text).toContain("Starbucks (2 transactions, last 2026-10-20) — id sb");
    expect(text).toContain("Blue Bottle (0 transactions, 1 scheduled) — id bb2");
  });
});
