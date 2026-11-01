import { describe, test, expect } from "vitest";
import type { MonthSummary } from "../ynab";
import { computeMonthList, MonthListSchema, renderMonthList } from "./list-months";

const month = (m: string, overrides: Partial<MonthSummary> = {}): MonthSummary => ({
  month: m,
  income: 5_000_000,
  budgeted: 4_000_000,
  activity: -3_500_000,
  to_be_budgeted: 250_000,
  age_of_money: 30,
  deleted: false,
  ...overrides,
});

describe("computeMonthList", () => {
  const months = [
    month("2026-05-01"),
    month("2026-03-01", { age_of_money: null }),
    month("2026-04-01", { deleted: true }),
    month("2026-01-01"),
  ];

  test("keeps the range in chronological order and drops deleted months", () => {
    const r = computeMonthList(months, {
      since: "2026-02-01",
      until: "2026-05-01",
      iso: "USD",
    });
    expect(r.months.map((m) => m.month)).toEqual(["2026-03-01", "2026-05-01"]);
    expect(() => MonthListSchema.parse(r)).not.toThrow();
  });

  test("renders one row per month and skips a missing age of money", () => {
    const out = renderMonthList(
      computeMonthList(months, { since: "2026-03-01", until: "2026-05-01", iso: "USD" }),
    );
    const rows = out.split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).not.toContain("days");
    expect(rows[2]).toContain("30 days");
  });
});
