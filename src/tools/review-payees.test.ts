import { describe, test, expect } from "vitest";
import type { Payee, ScheduledTransaction, SubTransaction, Transaction } from "../ynab";
import {
  computePayeeReview,
  payeeKey,
  PayeeReviewSchema,
  renderPayeeReview,
  unescapeHtml,
  type ReviewOptions,
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
  p("amz", "Amazon"),
  p("amz2", "Amazon.com"),
  p("amzpay", "Amazon Payroll"),
  p("aws", "Amazon Web Services"),
  p("apple", "Apple"),
  p("applecard", "Apple Card Payment"),
  p("costco", "Costco"),
  p("costcogas", "Costco Gas"),
  p("venmo", "Venmo"),
  p("venmojane", "Venmo Jane Doe"),
  p("brew1", "Board &amp; Brew"),
  p("brew2", "Board &amp; Brew"),
  p("brew3", "Board & Brew"),
  p("gym", "Gym"),
  p("never", "Never Used"),
  p("gone", "Starbucks", { deleted: true }),
  p("xfer", "Transfer : Savings", { transfer_account_id: "acc-2" }),
];

const transactions = [
  tx("t1", "sb", "2026-10-01"),
  tx("t2", "sb", "2026-10-20"),
  tx("t3", "sb2", "2025-01-01"),
  // A split whose part names a different payee counts for both.
  tx("t4", "sbw", "2026-03-03", [{ payee_id: "bb" }, { payee_id: "sbw" }]),
  tx("t5", "amz", "2026-01-01"),
  tx("t6", "amz", "2026-02-01"),
  tx("t7", "xfer", "2026-02-01"),
  { ...tx("t8", "never", "2026-02-01"), deleted: true },
  tx("t9", "brew1", "2024-05-05"),
];

const scheduled = [st("s1", "gym"), st("s2", null, [{ payee_id: "bb2", deleted: false }])];

const opts = (over: Partial<ReviewOptions> = {}): ReviewOptions => ({
  maxUses: 1,
  query: "",
  offset: 0,
  limit: 50,
  ...over,
});
const review = (over: Partial<ReviewOptions> = {}) =>
  computePayeeReview(payees, transactions, scheduled, opts(over));
const groupIds = (r: ReturnType<typeof review>) =>
  r.duplicates!.items.map((g) => g.payees.map((u) => u.id));

describe("payeeKey", () => {
  test("ignores formatting, store numbers, processor prefixes, and corporate suffixes", () => {
    expect(payeeKey("STARBUCKS #04412")).toBe("starbucks");
    expect(payeeKey("SQ *Blue Bottle")).toBe("bluebottle");
    expect(payeeKey("The Home Depot")).toBe("homedepot");
    expect(payeeKey("Café Rio")).toBe("caferio");
    expect(payeeKey("7-Eleven")).toBe("7eleven");
    expect(payeeKey("H&M0161")).toBe(payeeKey("H & M"));
    expect(payeeKey("Board &amp; Brew")).toBe(payeeKey("Board and Brew"));
    expect(payeeKey("Amazon.com, Inc.")).toBe("amazon");
  });
});

describe("unescapeHtml", () => {
  test("decodes named, numeric, and double-escaped entities", () => {
    expect(unescapeHtml("Board &amp; Brew")).toBe("Board & Brew");
    expect(unescapeHtml("Dave&#39;s &#x26; Co")).toBe("Dave's & Co");
    expect(unescapeHtml("A &amp;amp; B")).toBe("A & B");
    expect(unescapeHtml("AT&T")).toBe("AT&T");
  });
});

describe("computePayeeReview", () => {
  test("counts transactions, split parts, last use, and schedules; skips deleted and transfer payees", () => {
    const all = review({ show: "all", limit: 500 });
    const usage = (id: string) => all.all!.items.find((u) => u.id === id);
    expect(all.payee_count).toBe(20);
    expect(usage("sb")).toMatchObject({ transaction_count: 2, last_used: "2026-10-20" });
    expect(usage("sbw")).toMatchObject({ transaction_count: 1 });
    expect(usage("bb")).toMatchObject({ transaction_count: 1, last_used: "2026-03-03" });
    expect(usage("bb2")).toMatchObject({ transaction_count: 0, scheduled_count: 1 });
    expect(usage("never")).toMatchObject({ transaction_count: 0, last_used: null });
    expect(usage("xfer")).toBeUndefined();
  });

  test("groups only names that match once formatting is ignored", () => {
    // Not grouped: Westshore, Amazon Payroll/Web Services, Apple Card Payment,
    // Costco Gas, Venmo Jane Doe.
    expect(groupIds(review())).toEqual([
      ["sb", "sb2"],
      ["amz", "amz2"],
      ["brew1", "brew3", "brew2"],
      ["bb", "bb2"],
    ]);
  });

  test("flags names stored with HTML entities", () => {
    expect(review().html_escaped!.items).toEqual([
      expect.objectContaining({ id: "brew1", unescaped_name: "Board & Brew" }),
      expect.objectContaining({ id: "brew2", unescaped_name: "Board & Brew" }),
    ]);
  });

  test("little used: at most max_uses transactions and nothing scheduled, oldest first", () => {
    const little = (maxUses: number) => review({ maxUses }).little_used!.items.map((u) => u.id);
    expect([...little(0)].sort()).toEqual([
      "amz2", "amzpay", "apple", "applecard", "aws", "brew2", "brew3", "costco", "costcogas", "never", "venmo", "venmojane",
    ]);
    expect(little(1).slice(12)).toEqual(["brew1", "sb2", "bb", "sbw"]);
  });

  test("query narrows every section; a group matches when any member does", () => {
    const r = review({ query: "STARBUCKS #" });
    expect(groupIds(r)).toEqual([["sb", "sb2"]]);
    expect(r.little_used!.items.map((u) => u.id)).toEqual(["sb2"]);
    expect(review({ query: "board & brew", show: "all" }).all!.total).toBe(3);
  });

  test("show picks one section, and offset/limit page it with the full total", () => {
    const r = review({ show: "duplicates", offset: 1, limit: 2 });
    expect(r.little_used).toBeUndefined();
    expect(r.html_escaped).toBeUndefined();
    expect(r.duplicates!.total).toBe(4);
    expect(groupIds(r)).toEqual([["amz", "amz2"], ["brew1", "brew3", "brew2"]]);
    expect(review().all).toBeUndefined();
  });

  test("conforms to PayeeReviewSchema", () => {
    expect(() => PayeeReviewSchema.parse(review())).not.toThrow();
    expect(() => PayeeReviewSchema.parse(review({ show: "all" }))).not.toThrow();
  });
});

describe("renderPayeeReview", () => {
  test("shows usage, ids, and how to fetch the next page", () => {
    const o = opts({ show: "duplicates", limit: 2 });
    const text = renderPayeeReview(computePayeeReview(payees, transactions, scheduled, o), o, true);
    expect(text).toContain("Likely duplicates (1–2 of 4)");
    expect(text).toContain("Starbucks (2 transactions, last 2026-10-20) — id sb");
    expect(text).toContain('More: show "duplicates", offset 2.');
  });
});
