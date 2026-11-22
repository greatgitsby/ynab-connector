import { z } from "zod";
import { dateParam, includeIdsParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { YnabClient } from "../ynab";
import { fmtMoney, handleError, result } from "../format";
import { normalizeName } from "../resolve";
import { isCardPaymentPayee } from "../predicates";
import {
  addDays,
  daysBetween,
  flattenTransactions,
  median,
  todayIso,
  type FlatRow,
} from "../rows";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

const CADENCES = [
  { name: "weekly", days: 7, tol: 2, months: 0 },
  { name: "biweekly", days: 14, tol: 3, months: 0 },
  { name: "monthly", days: 30, tol: 5, months: 1 },
  { name: "quarterly", days: 91, tol: 12, months: 3 },
  { name: "semiannual", days: 182, tol: 20, months: 6 },
  { name: "yearly", days: 365, tol: 25, months: 12 },
] as const;
type Cadence = (typeof CADENCES)[number];

const SeriesSchema = z.object({
  payee: z.string(),
  payee_id: z.string().nullable(),
  // The most common category across the charges; ties go to the latest.
  category: z.string().nullable(),
  category_id: z.string().nullable(),
  account: z.string(),
  cadence: z.enum(CADENCES.map((c) => c.name) as [string, ...string[]]),
  // Median days between charges.
  interval_days: z.number().int(),
  // False when some cycles were skipped: every gap is one to three cycles.
  regular: z.boolean(),
  typical_amount: z.number().int(),
  min_amount: z.number().int(),
  max_amount: z.number().int(),
  // Most charges within 15% of the typical amount. Amounts are at the
  // current price when previous_amount is set.
  steady_amount: z.boolean(),
  // A price change: the earlier series at this amount, now part of this one.
  previous_amount: z.number().int().optional(),
  price_changed_on: z.string().optional(),
  // typical_amount scaled to a month, for comparing cadences.
  monthly_equivalent: z.number().int(),
  count: z.number().int(),
  first_date: z.string(),
  last_date: z.string(),
  next_expected_date: z.string(),
  // active: next charge not yet overdue. late: overdue by less than a cycle.
  // lapsed: overdue by more, probably cancelled.
  status: z.enum(["active", "late", "lapsed"]),
  // A scheduled transaction exists for this payee.
  scheduled: z.boolean(),
  // How subscription-like: an exact repeating amount, many charges, and a
  // monthly or longer cadence count for it. Habitual spending (coffee, rides)
  // that happens to repeat is "low".
  confidence: z.enum(["high", "medium", "low"]),
  last_transaction_id: z.string(),
});
export type Series = z.infer<typeof SeriesSchema>;

export const RecurringSchema = z.object({
  iso: z.string(),
  since_date: z.string(),
  as_of: z.string(),
  // Sum of monthly_equivalent over active and late outflow series, every page.
  monthly_total: z.number().int(),
  series_count: z.number().int(),
  offset: z.number().int(),
  next_offset: z.number().int().nullable(),
  series: z.array(SeriesSchema),
});
export type Recurring = z.infer<typeof RecurringSchema>;

// ---- Compute (pure)

const addMonthsClamped = (date: string, months: number): string => {
  const [y, m, d] = date.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m - 1 + months, Math.min(d, last)));
  return t.toISOString().slice(0, 10);
};

const nextDate = (last: string, c: Cadence): string =>
  c.months ? addMonthsClamped(last, c.months) : addDays(last, c.days);

// One occurrence per date, so two rows on one day don't read as a 0-day cycle.
const byDate = (rows: FlatRow[]): FlatRow[] => {
  const m = new Map<string, FlatRow>();
  for (const r of rows) {
    const prev = m.get(r.date);
    m.set(r.date, prev ? { ...prev, amount: prev.amount + r.amount } : r);
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
};

// Regular: at least three quarters of the gaps fall within the median's
// cadence. Otherwise, with three or more charges of one exact amount, skipped
// cycles: every gap is one to three cycles of the shortest gap's cadence (a
// card that missed a month). Varying amounts on loose dates are habits.
const fitCadence = (gaps: number[], oneAmount: boolean): { cadence: Cadence; regular: boolean } | null => {
  const med = median(gaps);
  const cadence = CADENCES.find((c) => Math.abs(med - c.days) <= c.tol);
  if (cadence) {
    const onBeat = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tol).length;
    if (onBeat >= gaps.length * 0.75) return { cadence, regular: true };
  }
  if (gaps.length < 2 || !oneAmount) return null;
  const shortest = Math.min(...gaps);
  const base = CADENCES.find((c) => Math.abs(shortest - c.days) <= c.tol);
  if (!base) return null;
  const skips = gaps.every((g) => [1, 2, 3].some((k) => Math.abs(g - k * base.days) <= base.tol * k));
  return skips ? { cadence: base, regular: false } : null;
};

const confidenceOf = (s: Pick<Series, "min_amount" | "max_amount" | "steady_amount" | "count" | "cadence" | "regular">): Series["confidence"] => {
  const score =
    (s.min_amount === s.max_amount ? 2 : s.steady_amount ? 1 : 0) +
    (s.count >= 5 ? 2 : s.count >= 3 ? 1 : -1) -
    (s.cadence === "weekly" || s.cadence === "biweekly" ? 1 : 0) -
    (s.regular ? 0 : 1);
  return score >= 3 ? "high" : score === 2 ? "medium" : "low";
};

// The row whose category is most common; ties go to the latest.
const usualRow = (rows: FlatRow[]): FlatRow => {
  const n = new Map<string, number>();
  for (const r of rows) n.set(r.category_id ?? "", (n.get(r.category_id ?? "") ?? 0) + 1);
  return [...rows].sort(
    (a, b) => n.get(b.category_id ?? "")! - n.get(a.category_id ?? "")! || b.date.localeCompare(a.date),
  )[0];
};

// A series, or null when the dates don't keep one cadence.
export const detectSeries = (
  rows: FlatRow[],
  opts: { minOccurrences: number; today: string; scheduledPayees: ReadonlySet<string> },
): Series | null => {
  const occ = byDate(rows);
  if (occ.length < opts.minOccurrences) return null;
  const gaps = occ.slice(1).map((r, i) => daysBetween(occ[i].date, r.date));
  const med = median(gaps);
  const fit = fitCadence(gaps, new Set(occ.map((r) => r.amount)).size === 1);
  if (!fit) return null;
  const { cadence, regular } = fit;

  const amounts = occ.map((r) => r.amount);
  const typical = median(amounts);
  const near = amounts.filter(
    (a) => Math.abs(a - typical) <= Math.abs(typical) * 0.15,
  ).length;
  const last = occ[occ.length - 1];
  const next = nextDate(last.date, cadence);
  const overdue = daysBetween(next, opts.today);
  const status =
    overdue <= cadence.tol ? "active" : overdue <= cadence.days + cadence.tol ? "late" : "lapsed";
  const usual = usualRow(rows);
  const shape = {
    cadence: cadence.name,
    regular,
    min_amount: Math.min(...amounts),
    max_amount: Math.max(...amounts),
    steady_amount: near >= amounts.length * 0.75,
    count: occ.length,
  };
  return {
    payee: last.payee ?? "(no payee)",
    payee_id: last.payee_id,
    category: usual.category,
    category_id: usual.category_id,
    account: last.account,
    ...shape,
    interval_days: med,
    typical_amount: typical,
    monthly_equivalent: Math.round((typical * 30.44) / cadence.days),
    first_date: occ[0].date,
    last_date: last.date,
    next_expected_date: next,
    status,
    scheduled: !!last.payee_id && opts.scheduledPayees.has(last.payee_id),
    confidence: confidenceOf(shape),
    last_transaction_id: last.id,
  };
};

// Payees one rename apart share a group: one name is the other plus words
// ("Google" and "Google One", "Anthropic" and "Anthropic Claude") and they
// charged at least one identical amount. Returns each payee key's group key.
const payeeFamilies = (rows: FlatRow[], keyOf: (r: FlatRow) => string): Map<string, string> => {
  const info = new Map<string, { words: string[]; amounts: Set<number> }>();
  for (const r of rows) {
    const k = keyOf(r);
    const i = info.get(k) ?? { words: normalizeName(r.payee ?? "").split(" ").filter(Boolean), amounts: new Set() };
    i.amounts.add(r.amount);
    info.set(k, i);
  }
  const root = new Map([...info.keys()].map((k) => [k, k]));
  const find = (k: string): string => (root.get(k) === k ? k : find(root.get(k)!));
  const byFirst = new Map<string, string[]>();
  for (const [k, i] of info) if (i.words.length) byFirst.set(i.words[0], [...(byFirst.get(i.words[0]) ?? []), k]);
  for (const keys of byFirst.values()) {
    for (const a of keys) {
      for (const b of keys) {
        const [wa, wb] = [info.get(a)!, info.get(b)!];
        if (a === b || wa.words.length >= wb.words.length) continue;
        if (!wa.words.every((w, i) => wb.words[i] === w)) continue;
        if (![...wa.amounts].some((x) => wb.amounts.has(x))) continue;
        root.set(find(a), find(b));
      }
    }
  }
  return new Map([...info.keys()].map((k) => [k, find(k)]));
};

// A series that starts within a cycle after another of the same cadence ended,
// at a price within half of it, is a price change: fold the earlier one in.
const linkPriceChanges = (list: Series[]): Series[] => {
  const out: Series[] = [];
  for (const s of [...list].sort((a, b) => a.first_date.localeCompare(b.first_date))) {
    const c = CADENCES.find((x) => x.name === s.cadence)!;
    const i = out.findIndex(
      (o) =>
        o.cadence === s.cadence &&
        o.last_date < s.first_date &&
        daysBetween(o.last_date, s.first_date) <= c.days + c.tol &&
        Math.abs(s.typical_amount - o.typical_amount) <= Math.abs(o.typical_amount) * 0.5,
    );
    if (i < 0) {
      out.push(s);
      continue;
    }
    const [prev] = out.splice(i, 1);
    const merged = {
      ...s,
      previous_amount: prev.typical_amount,
      price_changed_on: s.first_date,
      first_date: prev.first_date,
      count: s.count + prev.count,
    };
    out.push({ ...merged, confidence: confidenceOf(merged) });
  }
  return out;
};

// Per payee: each exact amount that keeps a cadence (two Apple subscriptions,
// or several Privacy.com cards behind one payee), else the payee's whole
// history if it does (a utility bill that varies).
export const computeRecurring = (
  rows: FlatRow[],
  opts: {
    iso: string;
    sinceDate: string;
    today: string;
    minOccurrences: number;
    includeIncome: boolean;
    includeLapsed: boolean;
    scheduledPayees: ReadonlySet<string>;
    limit?: number;
    offset?: number;
  },
): Recurring => {
  const used = rows.filter(
    (r) =>
      !r.transfer &&
      !isCardPaymentPayee(r.payee) &&
      r.amount !== 0 &&
      (opts.includeIncome || r.amount < 0),
  );
  const payeeKey = (r: FlatRow) => r.payee_id ?? r.payee ?? "none";
  const family = payeeFamilies(used, payeeKey);
  const byPayee = new Map<string, FlatRow[]>();
  for (const r of used) {
    const key = `${family.get(payeeKey(r))}|${Math.sign(r.amount)}`;
    byPayee.set(key, [...(byPayee.get(key) ?? []), r]);
  }
  const series: Series[] = [];
  for (const group of byPayee.values()) {
    if (group.every((r) => !r.payee_id && !r.payee)) continue;
    const byAmount = new Map<number, FlatRow[]>();
    for (const r of group) byAmount.set(r.amount, [...(byAmount.get(r.amount) ?? []), r]);
    const found: Series[] = [];
    for (const same of byAmount.values()) {
      const s = detectSeries(same, opts);
      if (s) found.push(s);
    }
    // The whole payee only when no exact amount repeats (a bill that varies).
    // Mixing amounts beside repeating ones guesses: two monthly subscriptions
    // on interleaved dates read as one biweekly series.
    const whole = found.length ? null : detectSeries(group, opts);
    series.push(...(whole ? [whole] : linkPriceChanges(found)));
  }
  const kept = series
    .filter((s) => opts.includeLapsed || s.status !== "lapsed")
    .sort(
      (a, b) =>
        a.next_expected_date.localeCompare(b.next_expected_date) ||
        a.payee.localeCompare(b.payee),
    );
  const offset = opts.offset ?? 0;
  const page = kept.slice(offset, opts.limit === undefined ? undefined : offset + opts.limit);
  const end = offset + page.length;
  return {
    iso: opts.iso,
    since_date: opts.sinceDate,
    as_of: opts.today,
    monthly_total: kept
      .filter((s) => s.status !== "lapsed" && s.typical_amount < 0)
      .reduce((a, s) => a + s.monthly_equivalent, 0),
    series_count: kept.length,
    offset,
    next_offset: end < kept.length ? end : null,
    series: page,
  };
};

// ---- Render (pure)

export const renderRecurring = (r: Recurring, opts: { includeIds: boolean }): string => {
  if (!r.series_count) return `No recurring charges found since ${r.since_date}.`;
  const { iso } = r;
  const shown = r.series.length < r.series_count ? ` (${r.offset + 1}–${r.offset + r.series.length} shown)` : "";
  const out = [
    `${r.series_count} recurring series${shown} since ${r.since_date} (as of ${r.as_of}); outflows ≈ ${fmtMoney(r.monthly_total, iso)}/month`,
    "",
  ];
  for (const s of r.series) {
    const amt = s.steady_amount
      ? fmtMoney(s.typical_amount, iso)
      : `~${fmtMoney(s.typical_amount, iso)} (${fmtMoney(s.min_amount, iso)} to ${fmtMoney(s.max_amount, iso)})`;
    const flags = [
      s.status !== "active" ? s.status : "",
      s.scheduled ? "scheduled" : "",
      s.regular ? "" : "skips cycles",
      s.previous_amount !== undefined ? `was ${fmtMoney(s.previous_amount, iso)} until ${s.price_changed_on}` : "",
      s.confidence === "high" ? "" : `${s.confidence} confidence`,
    ].filter(Boolean);
    const ids = opts.includeIds
      ? ` — payee ${s.payee_id ?? "none"}, category ${s.category_id ?? "none"}, last tx ${s.last_transaction_id}`
      : "";
    out.push(
      `- ${s.payee} ${amt} ${s.cadence} → ${s.category ?? "(uncategorized)"}; next ${s.next_expected_date}, last ${s.last_date}, ${s.count}×${flags.length ? ` [${flags.join(", ")}]` : ""}${ids}`,
    );
  }
  if (r.next_offset != null) out.push(`(more: pass offset ${r.next_offset})`);
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Recurring charges (subscriptions, bills): payees, or one exact amount from a payee, that repeat on a steady cadence " +
  "(weekly, biweekly, monthly, quarterly, semiannual, yearly), including ones that skipped a cycle (regular: false). Each series has its typical amount and range, whether the amount is steady, " +
  "its usual category (the most common across charges), the next expected date, a monthly equivalent, whether a scheduled transaction already covers it, " +
  "a status: active, late (overdue by under one cycle), or lapsed (probably cancelled; hidden unless include_lapsed), " +
  "and a confidence (high, medium, low) that it is a subscription rather than habitual spending such as coffee or rides. " +
  "Each exact amount that repeats is its own series, so several subscriptions behind one payee, such as Privacy.com cards, come back separately; " +
  "a payee's varying charges are one series only when no single amount repeats (a utility bill). Charges this leaves out are not guessed at: check them with query_transactions. A renamed payee (\"Google\" then \"Google One\") stays one series, " +
  "and a price change folds the old price into the new series as previous_amount. Page with limit and offset. " +
  "Looks back 400 days by default; a yearly charge needs min_occurrences within the window. Transfers and credit card payments are excluded; income only with include_income.";

export const registerFindRecurringCharges = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "find_recurring_charges",
    {
      title: "Find Recurring Charges",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        since_date: dateParam.optional().describe("Start of the history to scan. Default: 400 days ago."),
        min_occurrences: z.number().int().min(2).max(24).optional().default(3),
        include_income: z.boolean().optional().default(false),
        include_lapsed: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(500).optional().describe("Series per page. Default: all."),
        offset: z.number().int().min(0).optional().default(0),
        include_ids: includeIdsParam,
      },
      outputSchema: RecurringSchema.shape,
    },
    async (args) => {
      try {
        const c = getClient();
        const today = todayIso();
        const sinceDate = args.since_date ?? addDays(today, -400);
        const [txRes, schedRes, iso] = await Promise.all([
          c.listTransactions(args.plan_id, { sinceDate }),
          c.listScheduledTransactions(args.plan_id),
          c.planIso(args.plan_id),
        ]);
        const scheduledPayees = new Set(
          schedRes.data.scheduled_transactions
            .filter((s) => !s.deleted && s.payee_id)
            .map((s) => s.payee_id as string),
        );
        const r = computeRecurring(flattenTransactions(txRes.data.transactions), {
          iso,
          sinceDate,
          today,
          minOccurrences: args.min_occurrences,
          includeIncome: args.include_income,
          includeLapsed: args.include_lapsed,
          scheduledPayees,
          limit: args.limit,
          offset: args.offset,
        });
        return result(renderRecurring(r, { includeIds: args.include_ids }), r);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
