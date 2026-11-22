import { describe, expect, test } from "vitest";
import type { Category, MonthDetail } from "../ynab";
import type { FlatRow } from "../rows";
import { buildCandidates, computeSplitSuggestions, findSplits, SplitSuggestionsSchema, type Candidate } from "./suggest-split";

const cat = (id: string, over: Partial<Category> = {}): Category =>
  ({ id, name: id, category_group_id: "g", hidden: false, internal: false, deleted: false, budgeted: 0, activity: 0, balance: 0, ...over }) as Category;

const month = (categories: Category[]): MonthDetail => ({
  month: "2026-11-01", income: 0, budgeted: 0, activity: 0, to_be_budgeted: 0, age_of_money: null, deleted: false, categories,
});

const hist = (category_id: string, amount: number): FlatRow =>
  ({ id: `h-${category_id}-${amount}`, part_id: null, date: "2026-10-01", amount, payee: "Virtual Card", payee_id: "p", category: category_id, category_id, account: "A", account_id: "a", memo: null, approved: true, cleared: "cleared", flag: null, transfer: false, imported: true });

describe("findSplits", () => {
  const c = (category_id: string, amount: number): Candidate =>
    ({ category_id, category_name: category_id, amount, source: "goal", times: 0, goal_match: true, uncharged: true });

  test("finds every exact combination, each category once", () => {
    const { combos, exhaustive } = findSplits([c("a", 9820), c("b", 14190), c("c", 4190), c("d", 10000), c("a", 14190)], 24010, { maxParts: 5, maxResults: 5 });
    expect(exhaustive).toBe(true);
    expect(combos.map((x) => x.map((p) => p.category_id).sort().join("+")).sort()).toEqual(["a+b", "a+c+d"].sort());
  });

  test("respects max_parts and reports a stopped search", () => {
    const many = Array.from({ length: 40 }, (_, i) => c(`k${i}`, 1));
    expect(findSplits(many, 3, { maxParts: 2, maxResults: 5 }).combos).toEqual([]);
    expect(findSplits(many, 20, { maxParts: 20, maxResults: 5, budget: 1000 }).exhaustive).toBe(false);
  });
});

describe("computeSplitSuggestions", () => {
  test("ranks repeat history and goal matches first and emits signed subtransactions", () => {
    const m = month([
      cat("netflix", { goal_type: "NEED", goal_target: 9820 }),
      cat("spotify", { goal_type: "NEED", goal_target: 14190 }),
      cat("misc"),
      cat("hidden", { hidden: true, goal_type: "NEED", goal_target: 24010 }),
    ]);
    const candidates = buildCandidates(
      [hist("netflix", -9820), hist("netflix", -9820), hist("spotify", -14190), hist("misc", -9820), hist("misc", 5)],
      m,
      { sign: -1 },
    );
    expect(candidates.map((x) => [x.category_id, x.amount, x.times, x.goal_match])).toEqual([
      ["netflix", 9820, 2, true],
      ["spotify", 14190, 1, true],
      ["misc", 9820, 1, false],
    ]);
    const s = computeSplitSuggestions({ amount: -24010, tx: null, alreadySplit: false, candidates }, { iso: "USD", maxParts: 5, maxSuggestions: 5 });
    expect(() => SplitSuggestionsSchema.parse(s)).not.toThrow();
    expect(s.suggestions.map((g) => g.parts.map((p) => p.category_id))).toEqual([
      ["spotify", "netflix"],
      ["spotify", "misc"],
    ]);
    expect(s.suggestions[0].subtransactions).toEqual([
      { amount_milliunits: -14190, category_id: "spotify" },
      { amount_milliunits: -9820, category_id: "netflix" },
    ]);
  });
});
