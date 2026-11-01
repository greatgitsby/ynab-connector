import { describe, test, expect } from "vitest";
import type { Category, MoneyMovement } from "../ynab";
import {
  computeMoneyMovements,
  MoneyMovementReportSchema,
  renderMoneyMovements,
} from "./list-money-movements";

const cat = (id: string, overrides: Partial<Category> = {}): Category => ({
  id,
  category_group_id: "grp",
  name: id,
  hidden: false,
  internal: false,
  deleted: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const categories = [
  cat("Travel", { goal_type: "TBD", goal_target: 2_000_000 }),
  cat("Dining"),
  cat("Rent", { goal_type: "NEED", goal_cadence: 1, goal_cadence_frequency: 1 }),
];

let n = 0;
const mm = (
  from: string | null,
  to: string | null,
  amount: number,
  overrides: Partial<MoneyMovement> = {},
): MoneyMovement => ({
  id: `mm-${++n}`,
  month: "2026-10-01",
  moved_at: `2026-10-${String(10 + n).padStart(2, "0")}T12:00:00Z`,
  from_category_id: from,
  to_category_id: to,
  amount,
  ...overrides,
});

const movements = [
  mm(null, "Rent", 1_500_000),
  mm(null, "Dining", 300_000),
  mm("Travel", "Dining", 120_000),
  mm("Rent", "Dining", 50_000),
  mm("Dining", null, 20_000),
  mm(null, "Travel", 999, { month: "2026-07-01" }),
  mm(null, "Travel", 999, { deleted: true }),
];

const opts = { since: "2026-08-01", until: "2026-10-01", iso: "USD" };

describe("computeMoneyMovements", () => {
  test("nets each category's assignments, returns, and moves", () => {
    const r = computeMoneyMovements(movements, categories, opts);
    const dining = r.by_category.find((f) => f.category_id === "Dining");
    expect(dining).toEqual({
      category_id: "Dining",
      category_name: "Dining",
      assigned: 300_000,
      unassigned: 20_000,
      moved_in: 170_000,
      moved_out: 0,
      net: 450_000,
    });
    const travel = r.by_category.find((f) => f.category_id === "Travel");
    expect(travel?.net).toBe(-120_000);
    expect(() => MoneyMovementReportSchema.parse(r)).not.toThrow();
  });

  test("drops deleted and out-of-range rows, names Ready to Assign", () => {
    const r = computeMoneyMovements(movements, categories, opts);
    expect(r.money_movements).toHaveLength(5);
    expect(r.money_movements.at(-1)?.from_category_name).toBe("Ready to Assign");
  });

  test("flags only category-to-category moves out of savings goals", () => {
    const r = computeMoneyMovements(movements, categories, opts);
    expect(
      r.money_movements
        .filter((m) => m.from_savings)
        .map((m) => [m.from_category_name, m.to_category_name]),
    ).toEqual([["Travel", "Dining"]]);
    expect(renderMoneyMovements(r, { includeIds: false, maxRows: 50 })).toContain(
      "## Moved out of savings goals (1)\n- 2026-10 $120.00 Travel → Dining",
    );
  });
});
