import { describe, test, expect } from "vitest";
import type { Payee } from "../ynab";
import {
  computePayeeList,
  renderPayeeList,
  PayeeListSchema,
} from "./list-payees";

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

describe("computePayeeList", () => {
  test("substring matches are case-insensitive, sorted by name length", () => {
    const result = computePayeeList(payees, "star", 20);
    expect(result.payees.map((m) => m.name)).toEqual([
      "Starbucks",
      "STAR Market",
      "Starbucks Westshore",
    ]);
    expect(result.total_matched).toBe(3);
  });

  test("excludes deleted payees", () => {
    const result = computePayeeList(payees, "coffee", 20);
    expect(result.payees).toEqual([]);
    expect(result.total_matched).toBe(0);
  });

  test("sorts by name length then alphabetical", () => {
    const result = computePayeeList(payees, "starbucks", 20);
    expect(result.payees.map((m) => m.name)).toEqual([
      "Starbucks",
      "Starbucks Westshore",
    ]);
  });

  test("caps at limit and reports totalMatched separately", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      p({ id: `p${i}`, name: `Match ${i.toString().padStart(2, "0")}` }),
    );
    const result = computePayeeList(many, "match", 5);
    expect(result.payees).toHaveLength(5);
    expect(result.total_matched).toBe(30);
  });

  test("trims whitespace from the query", () => {
    const result = computePayeeList(payees, "  whole  ", 20);
    expect(result.payees.map((m) => m.name)).toEqual(["Whole Foods"]);
  });

  test("propagates transfer_account_id on matches", () => {
    const result = computePayeeList(payees, "transfer", 20);
    expect(result.payees[0]).toMatchObject({
      transfer_account_id: "acc-1",
    });
  });

  test("compute result conforms to PayeeListSchema", () => {
    const r = computePayeeList(payees, "star", 20);
    expect(() => PayeeListSchema.parse(r)).not.toThrow();
  });
});

describe("renderPayeeList", () => {
  test("renders a no-match message with the query", () => {
    const result = { payees: [], total_matched: 0 };
    expect(renderPayeeList(result, "Foo")).toBe('No payees match "Foo".');
  });

  test("an empty query lists every live payee", () => {
    expect(computePayeeList(payees, "", 50).total_matched).toBe(5);
  });

  test("includes id suffix and transfer note", () => {
    const result = computePayeeList(payees, "star", 20);
    const rendered = renderPayeeList(result, "star");
    expect(rendered).toContain("Starbucks — id p1");
    const transferResult = computePayeeList(payees, "transfer", 20);
    const transferRendered = renderPayeeList(transferResult, "transfer");
    expect(transferRendered).toContain("(transfer) — id p6");
  });

  test("header shows 'showing N of M' when capped", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      p({ id: `p${i}`, name: `Match ${i.toString().padStart(2, "0")}` }),
    );
    const result = computePayeeList(many, "match", 5);
    const rendered = renderPayeeList(result, "match");
    expect(rendered).toContain('showing 5 of 30');
  });
});
