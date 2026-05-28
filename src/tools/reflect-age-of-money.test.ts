import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { BudgetDetail, MonthDetail } from "../ynab";
import {
  computeAgeOfMoneyTrend,
  renderAgeOfMoneyTrend,
} from "./reflect-age-of-money";

const month = (m: string, aom: number | null): MonthDetail => ({
  month: m,
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 0,
  age_of_money: aom,
  categories: [],
});

const budget = (months: MonthDetail[]): BudgetDetail => ({
  id: "b-1",
  name: "Test Plan",
  last_modified_on: "2026-05-01",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  months,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-20T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("computeAgeOfMoneyTrend", () => {
  test("history entries match the window with per-month status", () => {
    const b = budget([
      month("2026-01-01", 12),
      month("2026-02-01", null), // n/a
      month("2026-03-01", 18),
      month("2026-04-01", 21),
      month("2026-05-01", 25),
    ]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 5 });
    expect(r.history.map((e) => e.aom)).toEqual([12, null, 18, 21, 25]);
  });

  test("missing month surfaces as 'no_data'", () => {
    const b = budget([
      month("2026-04-01", 21),
      month("2026-05-01", 25),
      // March missing.
    ]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 3 });
    const march = r.history.find((e) => e.month.startsWith("2026-03"));
    expect(march?.aom).toBe("no_data");
  });

  test("current reads the latest month's age_of_money", () => {
    const b = budget([month("2026-05-01", 25)]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 1 });
    expect(r.current).toBe(25);
  });

  test("average is over reported months only", () => {
    const b = budget([
      month("2026-04-01", 20),
      month("2026-05-01", 30),
    ]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 2 });
    expect(r.average).toBe(25);
  });

  test("delta is last - first across reported months", () => {
    const b = budget([
      month("2026-04-01", 20),
      month("2026-05-01", 30),
    ]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 2 });
    expect(r.delta).toBe(10);
  });

  test("delta is null when only one reported month", () => {
    const b = budget([month("2026-05-01", 30)]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 1 });
    expect(r.delta).toBeNull();
  });

  test("average is null when no months report age_of_money", () => {
    const b = budget([month("2026-05-01", null)]);
    const r = computeAgeOfMoneyTrend(b, { monthsBack: 1 });
    expect(r.average).toBeNull();
  });
});

describe("renderAgeOfMoneyTrend", () => {
  test("renders Current, monthly lines, Average, and Trend", () => {
    const b = budget([
      month("2026-04-01", 20),
      month("2026-05-01", 30),
    ]);
    const trend = computeAgeOfMoneyTrend(b, { monthsBack: 2 });
    const out = renderAgeOfMoneyTrend(trend);
    expect(out).toContain("Current: 30 days");
    expect(out).toContain("- 2026-04: 20 days");
    expect(out).toContain("- 2026-05: 30 days");
    expect(out).toContain("Average: 25 days");
    expect(out).toContain("Trend: +10 days");
  });

  test("falls back to '(age of money not yet available)' when none reported", () => {
    const b = budget([month("2026-05-01", null)]);
    const out = renderAgeOfMoneyTrend(
      computeAgeOfMoneyTrend(b, { monthsBack: 1 }),
    );
    expect(out).toContain("(age of money not yet available)");
  });
});
