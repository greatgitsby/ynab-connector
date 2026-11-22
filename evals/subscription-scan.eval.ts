import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { categoryId, plan } from "./harness";
import { CATEGORIES, TRANSACTIONS, TX } from "./fixtures/subscription-scan";

// Failures from the 2026-11-22 subscription-scan rerun, one eval each. They
// grade the outcome an agent needs, not an implementation: where the tool has
// no way to express the answer yet, the eval names the contract it checks
// (e.g. a `confidence` field) so a fix can meet it. "Regression" evals guard
// what already worked in that run. Cases 3 to 9 covered find_recurring_charges,
// since removed: the agent finds recurring charges with query_transactions.

const SCAN = { since_date: "2026-05-22" };

const p = plan(TRANSACTIONS, CATEGORIES);
beforeEach(() => p.install());
afterEach(() => p.uninstall());

describe("query_transactions", () => {
  test("case 1: search 'Anthropic OR Claude' finds the charges, and several terms are accepted", async () => {
    const or = await p.call("query_transactions", { search: "Anthropic OR Claude", since_date: SCAN.since_date });
    expect(or.isError, or.text).toBe(false);
    expect(or.structured.count, "an OR query should match, not return nothing").toBe(6);

    // Several terms in one call: an array, or OR in the string.
    const asArray = await p.call("query_transactions", { search: ["Discord", "Fsd"], since_date: SCAN.since_date });
    const asOr = await p.call("query_transactions", { search: "Discord OR Fsd", since_date: SCAN.since_date });
    expect([asArray, asOr].some((r) => !r.isError && r.structured.count === 2), asArray.text).toBe(true);
  });

  test("case 2: fields including id puts the id in each text row", async () => {
    const r = await p.call("query_transactions", {
      payees: ["Anthropic Claude"],
      fields: ["id", "date", "amount", "payee"],
    });
    expect(r.isError, r.text).toBe(false);
    const ids = r.structured.rows.map((x: { id: string }) => x.id);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(r.text, "id was asked for in fields").toContain(id);
  });

  test("case 13: exclude_transfers drops Apple Card payments from the slush payee groups", async () => {
    const r = await p.call("query_transactions", {
      categories: ["NFFF", "Trey Comma"],
      since_date: SCAN.since_date,
      group_by: "payee",
      exclude_transfers: true,
    });
    expect(r.isError, r.text).toBe(false);
    const names = r.structured.groups.map((g: { name: string }) => g.name);
    expect(names, "card payments are not spending").not.toContain("Apple Card Payment");
  });

  test("regression: group_by payee on slush categories, matched by name without emoji", async () => {
    const r = await p.call("query_transactions", {
      categories: ["nfff", "trey comma"],
      since_date: SCAN.since_date,
      group_by: "payee",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.matched.categories.map((c: { name: string }) => c.name)).toEqual(["🎉 NFFF", "Trey Comma"]);
    const anthropic = r.structured.groups.find((g: { name: string }) => g.name === "Anthropic");
    expect(anthropic).toMatchObject({ count: 4, total: -740140, first_date: "2026-06-09", last_date: "2026-09-02" });
  });
});

describe("suggest_split", () => {
  test("case 10: Discord Nitro $99.99 is not a mix of unrelated goal targets", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.discord.id });
    expect(r.isError, r.text).toBe(false);
    const top = r.structured.suggestions[0];
    const goalParts = top?.parts.filter((x: { source: string }) => x.source === "goal") ?? [];
    expect(
      goalParts.length,
      `memo says "Discord Nitro (yearly)"; top was ${top?.parts.map((x: { category_name: string }) => x.category_name).join(" + ")}`,
    ).toBeLessThanOrEqual(1);
    expect(top?.parts.length ?? 0).toBeLessThanOrEqual(2);
  });

  // Contract: each suggestion carries `confidence`; one resting only on an
  // amount equal to a goal target is "low".
  test("case 11: $108.11 FSD matching the Tesla goal amount alone is low confidence", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.fsdOct.id });
    expect(r.isError, r.text).toBe(false);
    const tesla = r.structured.suggestions.find(
      (s: { parts: { category_id: string }[] }) =>
        s.parts.length === 1 && s.parts[0].category_id === categoryId("Tesla Premium Connectivity"),
    );
    expect(tesla, "fixture should still offer the Tesla goal match").toBeDefined();
    expect(tesla.confidence, "amount-only goal match").toBe("low");
  });

  test("case 12: no one-part 'split' back into the category the charge is already in", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.privacy399.id });
    expect(r.isError, r.text).toBe(false);
    const noop = r.structured.suggestions.filter(
      (s: { parts: { category_id: string }[] }) =>
        s.parts.length === 1 && s.parts[0].category_id === categoryId("Trey Comma"),
    );
    expect(noop, "Privacy $3.99 → Trey Comma, where it already is").toEqual([]);
  });

  test("regression: the 11/9 $24.01 Privacy.com charge splits into Netflix + Spotify", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.privacy2401.id });
    expect(r.isError, r.text).toBe(false);
    const top = r.structured.suggestions[0].parts.map((x: { category_name: string }) => x.category_name).sort();
    expect(top).toEqual(["🎥 Netflix", "🎶 Spotify + HULU"]);
  });
});

describe("get_month", () => {
  test("regression: compact get_month is a flat list with goal targets", async () => {
    const r = await p.call("get_month", { compact: true, only: ["has_goal"] });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.groups).toBeUndefined();
    expect(r.structured.categories.find((c: { name: string }) => c.name === "Tesla Premium Connectivity")).toMatchObject({
      goal_target: 108110,
    });
  });
});
