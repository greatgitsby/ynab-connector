import { describe, expect, test } from "vitest";
import type { FlatRow } from "../rows";
import { computeQuery, filterRows, QueryResultSchema, sortRows } from "./query-transactions";

const row = (id: string, over: Partial<FlatRow> = {}): FlatRow => ({
  id,
  part_id: null,
  date: "2026-10-01",
  amount: -1000,
  payee: "Store",
  payee_id: "p-store",
  category: "Food",
  category_id: "c-food",
  account: "Checking",
  account_id: "a1",
  memo: null,
  approved: true,
  cleared: "cleared",
  flag: null,
  transfer: false,
  imported: true,
  ...over,
});

const rows = [
  row("t1", { date: "2026-09-03", amount: -1200 }),
  row("t2", { date: "2026-10-03", amount: -1000, memo: "Birthday cake" }),
  row("t3", { date: "2026-10-20", amount: -9000, payee: "Cafe", payee_id: "p-cafe", category: "Dining", category_id: "c-dine" }),
  row("t4", { date: "2026-10-21", amount: 50000, payee: "Employer", payee_id: "p-job", category: "Inflow", category_id: "c-in", account_id: "a2" }),
  row("t5", { date: "2026-10-22", amount: -20000, payee: "Transfer : Savings", payee_id: "p-xfer", category: null, category_id: null, transfer: true }),
  row("t6", { date: "2026-10-05", amount: -800 }),
];

describe("filterRows", () => {
  test("ORs within a kind and ANDs across kinds", () => {
    const ids = (f: Parameters<typeof filterRows>[1]) => filterRows(rows, f).map((r) => r.id);
    expect(ids({ categoryIds: new Set(["c-food", "c-dine"]) })).toEqual(["t1", "t2", "t3", "t6"]);
    expect(ids({ categoryIds: new Set(["c-food", "c-dine"]), payeeIds: new Set(["p-cafe"]) })).toEqual(["t3"]);
    expect(ids({ accountIds: new Set(["a2"]) })).toEqual(["t4"]);
  });

  test("search covers payee and memo; direction and transfers narrow", () => {
    expect(filterRows(rows, { search: "CAKE" }).map((r) => r.id)).toEqual(["t2"]);
    expect(filterRows(rows, { search: "caf" }).map((r) => r.id)).toEqual(["t3"]);
    expect(filterRows(rows, { direction: "inflow" }).map((r) => r.id)).toEqual(["t4"]);
    expect(filterRows(rows, { excludeTransfers: true, direction: "outflow" }).map((r) => r.id)).toEqual(["t1", "t2", "t3", "t6"]);
  });
});

describe("computeQuery", () => {
  const base = { iso: "USD", groupLimit: 100, offset: 0, fields: ["id", "amount"] as const };

  test("groups by payee with count, total, typical, and date span; totals cover every row", () => {
    const q = computeQuery(sortRows(rows), { ...base, groupBy: "payee", limit: 0 });
    expect(() => QueryResultSchema.parse(q)).not.toThrow();
    expect(q.count).toBe(6);
    expect(q.inflow).toBe(50000);
    expect(q.outflow).toBe(-32000);
    expect(q.rows).toEqual([]);
    expect(q.next_offset).toBeNull();
    expect(q.groups[0].key).toBe("p-job");
    expect(q.groups.find((g) => g.key === "p-store")).toEqual({
      key: "p-store",
      name: "Store",
      count: 3,
      total: -3000,
      typical_amount: -1000,
      min_amount: -1200,
      max_amount: -800,
      first_date: "2026-09-03",
      last_date: "2026-10-05",
    });
  });

  test("months group chronologically; the group cap keeps the count", () => {
    const q = computeQuery(sortRows(rows), { ...base, groupBy: "month", groupLimit: 1, limit: 0 });
    expect(q.group_count).toBe(2);
    expect(q.groups.map((g) => [g.key, g.count])).toEqual([["2026-09-01", 1]]);
  });

  test("pages newest first", () => {
    const sorted = sortRows(rows);
    const p1 = computeQuery(sorted, { ...base, limit: 4 });
    expect(p1.rows.map((r) => r.id)).toEqual(["t5", "t4", "t3", "t6"]);
    expect(p1.next_offset).toBe(4);
    const p2 = computeQuery(sorted, { ...base, limit: 4, offset: 4 });
    expect(p2.rows.map((r) => r.id)).toEqual(["t2", "t1"]);
    expect(p2.next_offset).toBeNull();
  });
});
