import { describe, test, expect } from "vitest";
import type { Budget } from "../ynab";
import {
  computeBudgetList,
  renderBudgetList,
  BudgetListSchema,
} from "./list-budgets";

const budget = (overrides: Partial<Budget> & { id: string; name: string }): Budget => ({
  last_modified_on: "2026-05-01",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  ...overrides,
});

describe("computeBudgetList", () => {
  test("filters out (Archived) by default", () => {
    const r = computeBudgetList(
      [
        budget({ id: "live", name: "Family" }),
        budget({ id: "old", name: "Side Project (Archived)" }),
      ],
      { includeArchived: false },
    );
    expect(r.budgets.map((b) => b.id)).toEqual(["live"]);
  });

  test("keeps archived when includeArchived is true", () => {
    const r = computeBudgetList(
      [
        budget({ id: "live", name: "Family" }),
        budget({ id: "old", name: "Side Project (Archived)" }),
      ],
      { includeArchived: true },
    );
    expect(r.budgets).toHaveLength(2);
  });

  test("result conforms to BudgetListSchema", () => {
    const r = computeBudgetList(
      [
        budget({
          id: "b-1",
          name: "Family",
          currency_format: { iso_code: "USD", decimal_digits: 2 },
        }),
      ],
      { includeArchived: false },
    );
    expect(() => BudgetListSchema.parse(r)).not.toThrow();
  });
});

describe("renderBudgetList", () => {
  test("'No budgets found.' on empty", () => {
    expect(renderBudgetList({ budgets: [] })).toBe("No budgets found.");
  });

  test("emits id, currency, and last_modified per row", () => {
    const r = computeBudgetList(
      [
        budget({
          id: "b-1",
          name: "Family",
          currency_format: { iso_code: "USD", decimal_digits: 2 },
        }),
      ],
      { includeArchived: false },
    );
    const out = renderBudgetList(r);
    expect(out).toContain("- Family (id: b-1) — USD, last modified 2026-05-01");
  });

  test("defaults to USD when currency_format is missing", () => {
    const r = computeBudgetList(
      [budget({ id: "b-1", name: "Family" })],
      { includeArchived: false },
    );
    expect(renderBudgetList(r)).toContain("— USD,");
  });
});
