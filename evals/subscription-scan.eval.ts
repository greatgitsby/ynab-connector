import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { categoryId, plan } from "./harness";
import {
  CATEGORIES,
  HABITUAL_PAYEES,
  SUBSCRIPTION_PAYEES,
  TRANSACTIONS,
  TX,
  manySubscriptions,
} from "./fixtures/subscription-scan";

// Failures from the 2026-11-22 subscription-scan rerun, one eval each. They
// grade the outcome an agent needs, not an implementation: where the tool has
// no way to express the answer yet, the eval names the contract it checks
// (e.g. a `confidence` field) so a fix can meet it. "Regression" evals guard
// what already worked in that run.

const SCAN = { since_date: "2026-05-22", min_occurrences: 2, include_lapsed: true };
type Series = Record<string, any>;

const p = plan(TRANSACTIONS, CATEGORIES);
beforeEach(() => p.install());
afterEach(() => p.uninstall());

const recurring = async (args: Record<string, unknown> = SCAN): Promise<Series[]> => {
  const r = await p.call("find_recurring_charges", args);
  expect(r.isError, r.text).toBe(false);
  return r.structured.series;
};

// Higher means more subscription-like. Accepts a numeric score or a
// high/medium/low confidence; undefined when the series carries neither.
const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
const rank = (x: Record<string, any>): number | undefined =>
  typeof x.score === "number" && !("parts" in x)
    ? x.score
    : typeof x.subscription_score === "number"
      ? x.subscription_score
      : typeof x.confidence === "number"
        ? x.confidence
        : RANK[x.confidence];

describe("query_transactions", () => {
  test("case 1: search 'Anthropic OR Claude' finds the charges, and several terms are accepted", async () => {
    const or = await p.call("query_transactions", { search: "Anthropic OR Claude", since_date: SCAN.since_date });
    expect(or.isError, or.text).toBe(false);
    expect(or.structured.count, "an OR query should match, not return nothing").toBe(6);

    // Several terms in one call: an array, or OR in the string.
    const asArray = await p.call("query_transactions", { search: ["Arcade", "Navi"], since_date: SCAN.since_date });
    const asOr = await p.call("query_transactions", { search: "Arcade OR Navi", since_date: SCAN.since_date });
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
      categories: ["Fun Money", "Pocket Money"],
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
      categories: ["fun-money", "pocket money"],
      since_date: SCAN.since_date,
      group_by: "payee",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.structured.matched.categories.map((c: { name: string }) => c.name)).toEqual(["🎉 Fun Money", "Pocket Money"]);
    const anthropic = r.structured.groups.find((g: { name: string }) => g.name === "Anthropic");
    expect(anthropic).toMatchObject({ count: 4, total: -740140, first_date: "2026-06-09", last_date: "2026-09-02" });
  });
});

describe("find_recurring_charges", () => {
  test("case 3a regression: a 43-series result is complete, valid JSON", async () => {
    const big = plan(manySubscriptions(), CATEGORIES);
    p.uninstall();
    await big.install();
    const r = await big.call("find_recurring_charges", SCAN);
    expect(r.isError, r.text).toBe(false);
    expect(JSON.parse(JSON.stringify(r.structured)).series).toHaveLength(43);
  });

  // The 8,192-byte cut is in the client's write_to_file, outside this repo.
  // The server's part is to let a large result come back in pages that fit.
  // Contract: `limit` and `offset` inputs, `next_offset` in the result, as in
  // query_transactions.
  test("case 3b: a 43-series result pages into structured JSON under 8 KiB each", async () => {
    const big = plan(manySubscriptions(), CATEGORIES);
    p.uninstall();
    await big.install();
    const schema = (await big.tools()).find((t) => t.name === "find_recurring_charges")!.inputSchema;
    expect(Object.keys(schema.properties ?? {}), "no paging inputs").toEqual(
      expect.arrayContaining(["limit", "offset"]),
    );
    const seen: string[] = [];
    let offset: number | null = 0;
    for (let i = 0; offset != null && i < 20; i++) {
      const r = await big.call("find_recurring_charges", { ...SCAN, limit: 15, offset });
      expect(r.isError, r.text).toBe(false);
      expect(new TextEncoder().encode(JSON.stringify(r.structured)).length).toBeLessThanOrEqual(8192);
      seen.push(...r.structured.series.map((s: Series) => s.payee));
      offset = r.structured.next_offset ?? null;
    }
    expect(new Set(seen).size).toBe(43);
  });

  test("case 4: a renamed payee stays one series (Anthropic → Anthropic Claude, $218.40)", async () => {
    const s = (await recurring()).filter((x) => /anthropic/i.test(x.payee) && x.typical_amount === -218400);
    expect(s, JSON.stringify(s.map((x) => [x.payee, x.status, x.count]))).toHaveLength(1);
    expect(s[0]).toMatchObject({ cadence: "monthly", status: "active", last_date: "2026-11-02" });
    expect(s[0].count).toBeGreaterThanOrEqual(4);
  });

  test("case 5: Google One $1.99 monthly survives a renamed charge and a 61-day gap", async () => {
    const s = (await recurring()).filter((x) => /google/i.test(x.payee) && x.typical_amount === -1990);
    expect(s, "Google One is missing").toHaveLength(1);
    expect(s[0]).toMatchObject({ cadence: "monthly", status: "active" });
  });

  test("case 6: Virtual Card $108.11 on irregular dates is flagged", async () => {
    const s = (await recurring()).filter((x) => x.payee === "Virtual Card" && x.typical_amount === -108110);
    expect(s, "3 charges of the same amount in 4 months, dropped").toHaveLength(1);
  });

  test("case 7: Apple $17.46 is labeled with its usual category, iCloud", async () => {
    const s = (await recurring()).find((x) => x.payee === "Apple" && x.typical_amount === -17460);
    expect(s).toBeDefined();
    expect(s!.category, "3 of 5 charges are iCloud; only the latest is Fun Money").toBe("iCloud");
    expect(s!.category_id).toBe(categoryId("iCloud"));
  });

  // Pass: one series spans both prices, or the new series names the old price.
  test.each([
    ["iCloud", "Apple", -6540, -7630],
    ["Prime Video", "Amazon Prime Video Channels", -18550, -21830],
  ])("case 8: %s price change is one series or linked", async (_label, payee, oldAmt, newAmt) => {
    const all = (await recurring()).filter((x) => x.payee === payee);
    const merged = all.find((x) => x.min_amount <= newAmt && x.max_amount >= oldAmt && x.status !== "lapsed");
    const current = all.find((x) => x.typical_amount === newAmt);
    const linked = current && JSON.stringify(current).includes(String(oldAmt));
    const lapsedOld = all.find((x) => x.typical_amount === oldAmt && x.status === "lapsed");
    expect(!!merged || !!linked, "old price shows as a separate lapsed series").toBe(true);
    if (!linked) expect(lapsedOld).toBeUndefined();
  });

  // Contract: each series carries a numeric `score` or a high/medium/low
  // `confidence`, and habitual spending ranks below every subscription.
  test("case 9: habitual spending ranks below subscriptions at min_occurrences 2", async () => {
    const all = await recurring();
    const subs = all.filter((x) => SUBSCRIPTION_PAYEES.includes(x.payee) && x.status !== "lapsed");
    const habits = all.filter((x) => HABITUAL_PAYEES.includes(x.payee));
    expect(subs.length).toBeGreaterThan(0);
    const unranked = [...subs, ...habits].filter((x) => rank(x) === undefined);
    expect(unranked.length, "series carry no score or confidence").toBe(0);
    const floor = Math.min(...subs.map((x) => rank(x)!));
    const leaks = habits.filter((x) => rank(x)! >= floor).map((x) => x.payee);
    expect(leaks, "habitual payees rank with subscriptions").toEqual([]);
    expect(all.map((x) => x.payee), "card payments are not subscriptions").not.toContain("Apple Card Payment");
  });

  // The 11/9 charge is unsplit in the fixture, so both read as late, not lapsed.
  test("regression: Virtual Card Netflix and Spotify cards are separate current series", async () => {
    const s = (await recurring()).filter((x) => x.payee === "Virtual Card" && x.status !== "lapsed");
    expect(s.map((x) => [x.typical_amount, x.cadence])).toEqual(
      expect.arrayContaining([
        [-9820, "monthly"],
        [-14190, "monthly"],
      ]),
    );
  });
});

describe("suggest_split", () => {
  test("case 10: Arcade Pass $99.99 is not a mix of unrelated goal targets", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.discord.id });
    expect(r.isError, r.text).toBe(false);
    const top = r.structured.suggestions[0];
    const goalParts = top?.parts.filter((x: { source: string }) => x.source === "goal") ?? [];
    expect(
      goalParts.length,
      `memo says "Arcade Pass (yearly)"; top was ${top?.parts.map((x: { category_name: string }) => x.category_name).join(" + ")}`,
    ).toBeLessThanOrEqual(1);
    expect(top?.parts.length ?? 0).toBeLessThanOrEqual(2);
  });

  // Contract: each suggestion carries `confidence`; one resting only on an
  // amount equal to a goal target is "low".
  test("case 11: $108.11 FSD matching the Car goal amount alone is low confidence", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.fsdOct.id });
    expect(r.isError, r.text).toBe(false);
    const tesla = r.structured.suggestions.find(
      (s: { parts: { category_id: string }[] }) =>
        s.parts.length === 1 && s.parts[0].category_id === categoryId("Car App"),
    );
    expect(tesla, "fixture should still offer the Car goal match").toBeDefined();
    expect(tesla.confidence, "amount-only goal match").toBe("low");
  });

  test("case 12: no one-part 'split' back into the category the charge is already in", async () => {
    const r = await p.call("suggest_split", { transaction_id: TX.privacy399.id });
    expect(r.isError, r.text).toBe(false);
    const noop = r.structured.suggestions.filter(
      (s: { parts: { category_id: string }[] }) =>
        s.parts.length === 1 && s.parts[0].category_id === categoryId("Pocket Money"),
    );
    expect(noop, "Privacy $3.99 → Pocket Money, where it already is").toEqual([]);
  });

  test("regression: the 11/9 $24.01 Virtual Card charge splits into Netflix + Spotify", async () => {
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
    expect(r.structured.categories.find((c: { name: string }) => c.name === "Car App")).toMatchObject({
      goal_target: 108110,
    });
  });
});
