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
  test("filters out (Archived) by default", () => {
    const r = computePlanList(
      [
        plan({ id: "live", name: "Family" }),
        plan({ id: "old", name: "Side Project (Archived)" }),
      ],
      { includeArchived: false },
    );
    expect(r.plans.map((b) => b.id)).toEqual(["live"]);
  });

  test("keeps archived when includeArchived is true", () => {
    const r = computePlanList(
      [
        plan({ id: "live", name: "Family" }),
        plan({ id: "old", name: "Side Project (Archived)" }),
      ],
      { includeArchived: true },
    );
    expect(r.plans).toHaveLength(2);
  });

  test("result conforms to PlanListSchema", () => {
    const r = computePlanList(
      [
        plan({
          id: "b-1",
          name: "Family",
          currency_format: { iso_code: "USD", decimal_digits: 2 },
        }),
      ],
      { includeArchived: false },
    );
    expect(() => PlanListSchema.parse(r)).not.toThrow();
  });
});

describe("renderPlanList", () => {
  test("'No plans found.' on empty", () => {
    expect(renderPlanList({ plans: [] })).toBe("No plans found.");
  });

  test("emits id, currency, and last_modified per row", () => {
    const r = computePlanList(
      [
        plan({
          id: "b-1",
          name: "Family",
          currency_format: { iso_code: "USD", decimal_digits: 2 },
        }),
      ],
      { includeArchived: false },
    );
    const out = renderPlanList(r);
    expect(out).toContain("- Family (id: b-1) — USD, last modified 2026-05-01");
  });

  test("defaults to USD when currency_format is missing", () => {
    const r = computePlanList(
      [plan({ id: "b-1", name: "Family" })],
      { includeArchived: false },
    );
    expect(renderPlanList(r)).toContain("— USD,");
  });
});
