import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { plan } from "./harness";
import { CATEGORIES, TRANSACTIONS } from "./fixtures/subscription-scan";

// Failures from a 2026-11-22 subscription-scan run, one eval each. They
// grade the outcome an agent needs, not an implementation: where the tool has
// no way to express the answer yet, the eval names the contract it checks
// (e.g. a `confidence` field) so a fix can meet it. "Regression" evals guard
// what already worked in that run. Cases 3 to 9 covered find_recurring_charges
// and 10 to 12 suggest_split, both since removed: the agent finds recurring
// charges with query_transactions and works out splits itself.

const SCAN = { since_date: "2026-05-22" };

const p = plan(TRANSACTIONS, CATEGORIES);
beforeEach(() => p.install());
afterEach(() => p.uninstall());

describe("query_transactions", () => {
  test("case 1: search 'Anthropic OR Claude' finds the charges, and several terms are accepted", async () => {
    const or = await p.call("query_transactions", {
      search: "Anthropic OR Claude",
      since_date: SCAN.since_date,
    });
    expect(or.isError, or.text).toBe(false);
    expect(
      or.structured.count,
      "an OR query should match, not return nothing",
    ).toBe(6);

    // Several terms in one call: an array, or OR in the string.
    const asArray = await p.call("query_transactions", {
      search: ["Arcade", "Navi"],
      since_date: SCAN.since_date,
    });
    const asOr = await p.call("query_transactions", {
      search: "Arcade OR Navi",
      since_date: SCAN.since_date,
    });
    expect(
      [asArray, asOr].some((r) => !r.isError && r.structured.count === 2),
      asArray.text,
    ).toBe(true);
  });

  test("case 2: fields including id puts the id in each text row", async () => {
    const r = await p.call("query_transactions", {
      payees: ["Anthropic Claude"],
      fields: ["id", "date", "amount", "payee"],
    });
    expect(r.isError, r.text).toBe(false);
    const ids = r.structured.rows.map((x: { id: string }) => x.id);
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(r.text, "id was asked for in fields").toContain(id);
  });

  test("case 13: exclude_transfers drops Apple Card payments from the slush payee groups", async () => {
    const r = await p.call("query_transactions", {
      categories: ["Fun Money", "Pocket Money"],
      since_date: SCAN.since_date,
      group_by: "payee",
      exclude_transfers: true,
    });
    expect(r.isError, r.text).toBe(false);
    const names = r.structured.groups.map((g: { name: string }) => g.name);
    expect(names, "card payments are not spending").not.toContain(
      "Apple Card Payment",
    );
  });

  test("regression: group_by payee on slush categories, matched by name without emoji", async () => {
    const r = await p.call("query_transactions", {
      categories: ["fun money", "pocket money"],
      since_date: SCAN.since_date,
      group_by: "payee",
    });
    expect(r.isError, r.text).toBe(false);
    expect(
      r.structured.matched.categories.map((c: { name: string }) => c.name),
    ).toEqual(["🎉 Fun Money", "Pocket Money"]);
    const anthropic = r.structured.groups.find(
      (g: { name: string }) => g.name === "Anthropic",
    );
    expect(anthropic).toMatchObject({
      count: 4,
      total: -241600,
      first_date: "2026-06-09",
      last_date: "2026-09-02",
    });
  });
});

describe("get_month", () => {
  test("regression: compact get_month is a flat list with goal targets", async () => {
    const r = await p.call("get_month", { compact: true, only: ["has_goal"] });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.groups).toBeUndefined();
    expect(
      r.structured.categories.find(
        (c: { name: string }) => c.name === "🚗 Car App",
      ),
    ).toMatchObject({
      goal_target: 99000,
    });
  });
});
