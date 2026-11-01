import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import type { MonthDetail } from "./ynab";
import {
  addMonths,
  monthEndDate,
  monthsBetween,
  resolveMonth,
  resolveMonthRange,
  resolveMonthWindow,
} from "./month-window";

const month = (m: string): MonthDetail => ({
  month: m,
  income: 0,
  budgeted: 0,
  activity: 0,
  to_be_budgeted: 0,
  age_of_money: null,
  deleted: false,
  categories: [],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-15T10:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("month specs", () => {
  test("resolves 'current' and passes YYYY-MM-01 through", () => {
    expect(resolveMonth("current")).toBe("2026-05-01");
    expect(resolveMonth("2025-08-01")).toBe("2025-08-01");
  });

  test("addMonths crosses year boundaries both ways", () => {
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(addMonths("2025-11-01", 3)).toBe("2026-02-01");
  });

  test("resolveMonthRange defaults to N months ending at until_month", () => {
    expect(resolveMonthRange(undefined, "current", 3)).toEqual({
      since: "2026-03-01",
      until: "2026-05-01",
    });
    expect(resolveMonthRange("2025-12-01", "2026-02-01", 3)).toEqual({
      since: "2025-12-01",
      until: "2026-02-01",
    });
  });

  test("monthsBetween is inclusive and empty when reversed", () => {
    expect(monthsBetween("2025-12-01", "2026-02-01")).toEqual([
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
    expect(monthsBetween("2026-02-01", "2025-12-01")).toEqual([]);
  });
});

describe("monthEndDate", () => {
  test("returns the last day of the month", () => {
    expect(monthEndDate("2026-01-01")).toBe("2026-01-31");
    expect(monthEndDate("2026-02-01")).toBe("2026-02-28");
    expect(monthEndDate("2024-02-01")).toBe("2024-02-29");
    expect(monthEndDate("2026-04-01")).toBe("2026-04-30");
  });
});

describe("resolveMonthWindow", () => {
  test("returns the requested span when the Plan has every month", () => {
    const w = resolveMonthWindow(
      [month("2026-03-01"), month("2026-04-01"), month("2026-05-01")],
      "2026-03-01",
      "2026-05-01",
    );
    expect(w.present).toEqual(["2026-03-01", "2026-04-01", "2026-05-01"]);
    expect(w.months).toHaveLength(3);
    expect(w.truncation_note).toBeNull();
  });

  test("notes months the Plan has no data for", () => {
    const w = resolveMonthWindow(
      [month("2026-04-01"), month("2026-05-01")],
      "2026-01-01",
      "2026-05-01",
    );
    expect(w.requested).toHaveLength(5);
    expect(w.present).toEqual(["2026-04-01", "2026-05-01"]);
    expect(w.truncation_note).toBe(
      "(The Plan has data for 2 of 5 requested months.)",
    );
  });
});
