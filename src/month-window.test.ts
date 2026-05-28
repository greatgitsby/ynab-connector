import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { BudgetDetail, MonthDetail } from "./ynab";
import {
  resolveMonthWindow,
  resolveMonthSpec,
  monthEndDate,
  daysInMonth,
} from "./month-window";

const month = (m: string, overrides: Partial<MonthDetail> = {}): MonthDetail => ({
  month: m,
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 0,
  age_of_money: null,
  categories: [],
  ...overrides,
});

const budget = (overrides: Partial<BudgetDetail> = {}): BudgetDetail => ({
  id: "b-1",
  name: "Test Budget",
  last_modified_on: "2026-05-01",
  first_month: "2024-01-01",
  last_month: "2026-05-01",
  ...overrides,
});

describe("resolveMonthSpec", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  test("returns 'current' as the current month", () => {
    expect(resolveMonthSpec("current")).toBe("2026-05-01");
  });

  test("returns 'last_month' as the previous month", () => {
    expect(resolveMonthSpec("last_month")).toBe("2026-04-01");
  });

  test("crosses a year boundary in last_month", () => {
    vi.setSystemTime(new Date("2026-01-15T10:00:00Z"));
    expect(resolveMonthSpec("last_month")).toBe("2025-12-01");
  });

  test("passes a literal YYYY-MM-01 through", () => {
    expect(resolveMonthSpec("2025-08-01")).toBe("2025-08-01");
  });
});

describe("monthEndDate", () => {
  test("returns the last day of the month", () => {
    expect(monthEndDate("2026-01-01")).toBe("2026-01-31");
    expect(monthEndDate("2026-02-01")).toBe("2026-02-28");
    expect(monthEndDate("2024-02-01")).toBe("2024-02-29"); // leap year
    expect(monthEndDate("2026-04-01")).toBe("2026-04-30");
  });
});

describe("daysInMonth", () => {
  test("returns days for various months", () => {
    expect(daysInMonth("2026-01-01")).toBe(31);
    expect(daysInMonth("2026-02-01")).toBe(28);
    expect(daysInMonth("2024-02-01")).toBe(29);
    expect(daysInMonth("2026-04-01")).toBe(30);
  });
});

describe("resolveMonthWindow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  test("returns the requested span when the Budget has every month", () => {
    const b = budget({
      first_month: "2024-01-01",
      months: [
        month("2026-03-01"),
        month("2026-04-01"),
        month("2026-05-01"),
      ],
    });
    const w = resolveMonthWindow(b, 3);
    expect(w.requested).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
    expect(w.present).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
    expect(w.months).toHaveLength(3);
    expect(w.truncationNote).toBeNull();
  });

  test("clamps to budget.first_month and emits a truncation note", () => {
    const b = budget({
      first_month: "2026-04-01",
      months: [month("2026-04-01"), month("2026-05-01")],
    });
    const w = resolveMonthWindow(b, 6);
    expect(w.requested).toEqual(["2026-04-01", "2026-05-01"]);
    expect(w.present).toEqual(["2026-04-01", "2026-05-01"]);
    expect(w.truncationNote).toBe(
      "(Budget starts 2026-04-01; window truncated to 2 of 6 requested months.)",
    );
  });

  test("present is a subset when a requested month is missing", () => {
    const b = budget({
      first_month: "2024-01-01",
      // 2026-04 is missing.
      months: [month("2026-03-01"), month("2026-05-01")],
    });
    const w = resolveMonthWindow(b, 3);
    expect(w.requested).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
    expect(w.present).toEqual(["2026-03-01", "2026-05-01"]);
    expect(w.months).toHaveLength(2);
    expect(w.truncationNote).toBe(
      "(Budget starts 2024-01-01; window truncated to 2 of 3 requested months.)",
    );
  });

  test("indexes every MonthDetail in monthsByKey, not just the window", () => {
    const b = budget({
      months: [
        month("2025-12-01"),
        month("2026-03-01"),
        month("2026-04-01"),
        month("2026-05-01"),
      ],
    });
    const w = resolveMonthWindow(b, 2);
    expect(w.monthsByKey.size).toBe(4);
    expect(w.monthsByKey.get("2025-12-01")).toBeDefined();
  });
});
