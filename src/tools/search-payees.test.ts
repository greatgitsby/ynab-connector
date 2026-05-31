import { describe, test, expect } from "vitest";
import type { Payee } from "../ynab";
import {
  computePayeeSearch,
  renderPayeeSearch,
  PayeeSearchResultSchema,
} from "./search-payees";

const p = (over: Partial<Payee> & { id: string; name: string }): Payee => ({
  transfer_account_id: null,
  deleted: false,
  ...over,
});

const payees: Payee[] = [
  p({ id: "p1", name: "Starbucks" }),
  p({ id: "p2", name: "Starbucks Westshore" }),
  p({ id: "p3", name: "STAR Market" }),
  p({ id: "p4", name: "Whole Foods" }),
  p({ id: "p5", name: "Old Coffee Place", deleted: true }),
  p({ id: "p6", name: "Transfer : Checking", transfer_account_id: "acc-1" }),
];

describe("computePayeeSearch", () => {
  test("substring matches are case-insensitive, sorted by name length", () => {
    const result = computePayeeSearch(payees, "star", 20);
    expect(result.matches.map((m) => m.name)).toEqual([
      "Starbucks",
      "STAR Market",
      "Starbucks Westshore",
    ]);
    expect(result.totalMatched).toBe(3);
  });

  test("excludes deleted payees", () => {
    const result = computePayeeSearch(payees, "coffee", 20);
    expect(result.matches).toEqual([]);
    expect(result.totalMatched).toBe(0);
  });

  test("sorts by name length then alphabetical", () => {
    const result = computePayeeSearch(payees, "starbucks", 20);
    expect(result.matches.map((m) => m.name)).toEqual([
      "Starbucks",
      "Starbucks Westshore",
    ]);
  });

  test("caps at limit and reports totalMatched separately", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      p({ id: `p${i}`, name: `Match ${i.toString().padStart(2, "0")}` }),
    );
    const result = computePayeeSearch(many, "match", 5);
    expect(result.matches).toHaveLength(5);
    expect(result.totalMatched).toBe(30);
    expect(result.cap).toBe(5);
  });

  test("trims whitespace from the query", () => {
    const result = computePayeeSearch(payees, "  whole  ", 20);
    expect(result.matches.map((m) => m.name)).toEqual(["Whole Foods"]);
  });

  test("propagates transfer_account_id on matches", () => {
    const result = computePayeeSearch(payees, "transfer", 20);
    expect(result.matches[0]).toMatchObject({
      transfer_account_id: "acc-1",
    });
  });

  test("compute result conforms to PayeeSearchResultSchema", () => {
    const r = computePayeeSearch(payees, "star", 20);
    expect(() => PayeeSearchResultSchema.parse(r)).not.toThrow();
  });
});

describe("renderPayeeSearch", () => {
  test("renders a no-match message with the query", () => {
    const result = { matches: [], totalMatched: 0, cap: 20 };
    expect(renderPayeeSearch(result, "Foo")).toBe('No payees match "Foo".');
  });

  test("includes id suffix and transfer note", () => {
    const result = computePayeeSearch(payees, "star", 20);
    const rendered = renderPayeeSearch(result, "star");
    expect(rendered).toContain("Starbucks — id p1");
    const transferResult = computePayeeSearch(payees, "transfer", 20);
    const transferRendered = renderPayeeSearch(transferResult, "transfer");
    expect(transferRendered).toContain("(transfer) — id p6");
  });

  test("header shows 'showing N of M' when capped", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      p({ id: `p${i}`, name: `Match ${i.toString().padStart(2, "0")}` }),
    );
    const result = computePayeeSearch(many, "match", 5);
    const rendered = renderPayeeSearch(result, "match");
    expect(rendered).toContain('showing 5 of 30');
  });
});
