import { describe, expect, test } from "vitest";
import type { FlatRow } from "../rows";
import { computeRecurring, detectSeries, RecurringSchema } from "./find-recurring-charges";

const row = (date: string, amount: number, over: Partial<FlatRow> = {}): FlatRow => ({
  id: `t-${date}-${amount}`,
  part_id: null,
  date,
  amount,
  payee: "Netflix",
  payee_id: "p-net",
  category: "TV",
  category_id: "c-tv",
  account: "Card",
  account_id: "a1",
  memo: null,
  approved: true,
  cleared: "cleared",
  flag: null,
  transfer: false,
  imported: true,
  ...over,
});

const opts = { minOccurrences: 3, today: "2026-11-20", scheduledPayees: new Set<string>() };

describe("detectSeries", () => {
  test("a monthly charge predicts the same day next month", () => {
    const s = detectSeries(
      [row("2026-07-31", -1549), row("2026-08-31", -1549), row("2026-09-30", -1549), row("2026-10-31", -1549)],
      opts,
    );
    expect(s).toMatchObject({ cadence: "monthly", typical_amount: -1549, steady_amount: true, next_expected_date: "2026-11-30", status: "active", count: 4 });
  });

  test("irregular dates are not a series", () => {
    expect(detectSeries([row("2026-07-01", -1), row("2026-07-04", -1), row("2026-08-30", -1), row("2026-09-02", -1)], opts)).toBeNull();
  });

  test("a varying bill is a series flagged unsteady; an overdue one is late, then lapsed", () => {
    const bills = [row("2026-07-10", -9000), row("2026-08-10", -15000), row("2026-09-10", -12000)];
    expect(detectSeries(bills, { ...opts, today: "2026-10-25" })).toMatchObject({ steady_amount: false, next_expected_date: "2026-10-10", status: "late" });
    expect(detectSeries(bills, { ...opts, today: "2027-01-01" })?.status).toBe("lapsed");
  });
});

describe("computeRecurring", () => {
  test("splits one payee's subscriptions by amount and skips transfers and income", () => {
    const priv = { payee: "Virtual Card", payee_id: "p-priv" };
    const rows = [
      ...["2026-08-06", "2026-09-06", "2026-10-06", "2026-11-06"].map((d) => row(d, -9820, { ...priv, category: "Netflix" })),
      ...["2026-08-07", "2026-09-08", "2026-10-07", "2026-11-07"].map((d) => row(d, -14190, { ...priv, category: "Spotify" })),
      row("2026-09-20", -50000, priv),
      ...["2026-09-01", "2026-10-01", "2026-11-01"].map((d) => row(d, -100000, { payee: "Savings", payee_id: "p-x", transfer: true })),
      ...["2026-09-01", "2026-10-01", "2026-11-01"].map((d) => row(d, 500000, { payee: "Job", payee_id: "p-job" })),
    ];
    const r = computeRecurring(rows, {
      ...opts,
      iso: "USD",
      sinceDate: "2026-01-01",
      includeIncome: false,
      includeLapsed: false,
      scheduledPayees: new Set(["p-priv"]),
    });
    expect(() => RecurringSchema.parse(r)).not.toThrow();
    expect(r.series.map((s) => [s.payee, s.typical_amount, s.category, s.scheduled])).toEqual([
      ["Virtual Card", -9820, "Netflix", true],
      ["Virtual Card", -14190, "Spotify", true],
    ]);
    expect(r.monthly_total).toBe(Math.round((-9820 * 30.44) / 30) + Math.round((-14190 * 30.44) / 30));
  });
});
