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

  test("skipped cycles keep a series, flagged irregular; the usual category wins over the latest", () => {
    const s = detectSeries(
      [row("2026-07-13", -108110), row("2026-08-11", -108110, { category: "Fun Money", category_id: "c-n" }), row("2026-10-05", -108110, { category: "Fun Money", category_id: "c-n" })],
      opts,
    );
    expect(s).toMatchObject({ cadence: "monthly", regular: false, category: "Fun Money", confidence: "medium" });
    const apple = [["2026-07-05", "c-n"], ["2026-08-04", "c-tv"], ["2026-09-04", "c-tv"], ["2026-10-05", "c-tv"], ["2026-11-04", "c-n"]];
    expect(detectSeries(apple.map(([d, c]) => row(d, -17460, { category_id: c, category: c })), opts)?.category_id).toBe("c-tv");
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

  const scan = (rows: FlatRow[], extra: { limit?: number; offset?: number } = {}) =>
    computeRecurring(rows, { ...opts, minOccurrences: 2, iso: "USD", sinceDate: "2026-01-01", includeIncome: false, includeLapsed: true, ...extra });

  test("a renamed payee that charged the same amount stays one series; one that didn't is separate", () => {
    const a = { payee: "Anthropic", payee_id: "p-a" };
    const ac = { payee: "Anthropic Claude", payee_id: "p-ac" };
    const ap = { payee: "Anthropic Pizza", payee_id: "p-ap" };
    const r = scan([
      row("2026-08-02", -218400, a), row("2026-09-02", -218400, a),
      row("2026-10-02", -218400, ac), row("2026-11-02", -218400, ac),
      row("2026-10-10", -3000, ap), row("2026-11-10", -3000, ap),
    ]);
    expect(r.series.map((s) => [s.payee, s.count, s.status])).toEqual([
      ["Anthropic Claude", 4, "active"],
      ["Anthropic Pizza", 2, "active"],
    ]);
  });

  test("two subscriptions on interleaved dates are two monthly series, not one biweekly guess", () => {
    const apple = { payee: "Apple", payee_id: "p-apple" };
    const r = scan(
      ["06", "07", "08", "09", "10", "11"].flatMap((m) => [row(`2026-${m}-05`, -2990, apple), row(`2026-${m}-19`, -999, apple)]),
    );
    expect(r.series.map((s) => [s.typical_amount, s.cadence])).toEqual([
      [-2990, "monthly"],
      [-999, "monthly"],
    ]);
  });

  test("a varying bill with no repeating amount is still one series", () => {
    const util = { payee: "Power Co", payee_id: "p-pow" };
    const r = scan([row("2026-08-10", -9000, util), row("2026-09-10", -15000, util), row("2026-10-10", -12000, util), row("2026-11-10", -11000, util)]);
    expect(r.series.map((s) => [s.payee, s.count, s.steady_amount])).toEqual([["Power Co", 4, false]]);
  });

  test("a price change folds the old series into the new one", () => {
    const apple = { payee: "Apple", payee_id: "p-apple" };
    const r = scan([
      row("2026-06-22", -6540, apple), row("2026-07-22", -6540, apple),
      ...["2026-08-23", "2026-09-22", "2026-10-22"].map((d) => row(d, -7630, apple)),
      ...["2026-06-01", "2026-06-09", "2026-07-30"].map((d) => row(d, -2990, apple)),
    ]);
    expect(r.series.find((s) => s.typical_amount === -7630)).toMatchObject({
      previous_amount: -6540, price_changed_on: "2026-08-23", first_date: "2026-06-22", count: 5, confidence: "high",
    });
    expect(r.series.some((s) => s.typical_amount === -6540)).toBe(false);
  });

  test("habitual spending is low confidence; results page", () => {
    const r = scan([row("2026-10-03", -6450, { payee: "Cafe", payee_id: "p-c" }), row("2026-10-10", -5200, { payee: "Cafe", payee_id: "p-c" })]);
    expect(r.series[0]).toMatchObject({ cadence: "weekly", confidence: "low" });
    const many = Array.from({ length: 5 }, (_, i) =>
      ["2026-09-15", "2026-10-15", "2026-11-15"].map((d) => row(d, -1000 - i, { payee: `S${i}`, payee_id: `p-s${i}` })),
    ).flat();
    const p1 = scan(many, { limit: 2 });
    const p3 = scan(many, { limit: 2, offset: 4 });
    expect([p1.series_count, p1.series.length, p1.next_offset, p3.series.length, p3.next_offset]).toEqual([5, 2, 2, 1, null]);
    expect(p1.monthly_total).toBe(p3.monthly_total);
  });
});
