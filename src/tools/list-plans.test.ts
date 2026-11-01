import { describe, test, expect } from "vitest";
import type { Plan } from "../ynab";
import {
  computePlanList,
  renderPlanList,
  PlanListSchema,
} from "./list-plans";

const plan = (overrides: Partial<Plan> & { id: string; name: string }): Plan => ({
  last_modified_on: "2026-05-01",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  ...overrides,
});

describe("computePlanList", () => {
  test("keeps archived plans, most recently modified first", () => {
    const r = computePlanList([
      plan({ id: "old", name: "Family 2025 (Archived on 2026-01-02)", last_modified_on: "2026-01-03T00:00:00Z" }),
      plan({
        id: "live",
        name: "Family",
        last_modified_on: "2026-10-31T00:00:00Z",
        currency_format: {
          iso_code: "USD",
          example_format: "123,456.78",
          decimal_digits: 2,
          decimal_separator: ".",
          symbol_first: true,
          group_separator: ",",
          currency_symbol: "$",
          display_symbol: true,
        },
      }),
    ]);
    expect(r.plans.map((p) => p.id)).toEqual(["live", "old"]);
    expect(() => PlanListSchema.parse(r)).not.toThrow();
  });
});

describe("renderPlanList", () => {
  test("'No plans found.' on empty", () => {
    expect(renderPlanList({ plans: [] })).toBe("No plans found.");
  });

  test("defaults to USD when currency_format is missing", () => {
    expect(
      renderPlanList(computePlanList([plan({ id: "b-1", name: "Family" })])),
    ).toContain("(USD,");
  });
});
