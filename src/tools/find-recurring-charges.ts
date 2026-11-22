import { z } from "zod";
import { dateParam, includeIdsParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { YnabClient } from "../ynab";
import { fmtMoney, handleError, result } from "../format";
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
  // From the most recent charge.
  category: z.string().nullable(),
  category_id: z.string().nullable(),
  account: z.string(),
  cadence: z.enum(CADENCES.map((c) => c.name) as [string, ...string[]]),
  // Median days between charges.
  interval_days: z.number().int(),
  typical_amount: z.number().int(),
  min_amount: z.number().int(),
  max_amount: z.number().int(),
  // Most charges within 15% of the typical amount.
  steady_amount: z.boolean(),
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
  last_transaction_id: z.string(),
});
export type Series = z.infer<typeof SeriesSchema>;

export const RecurringSchema = z.object({
  iso: z.string(),
  since_date: z.string(),
  as_of: z.string(),
  // Sum of monthly_equivalent over active and late outflow series.
  monthly_total: z.number().int(),
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

// A series, or null when the dates don't keep one cadence: at least three
// quarters of the gaps must fall within the cadence's tolerance.
export const detectSeries = (
  rows: FlatRow[],
  opts: { minOccurrences: number; today: string; scheduledPayees: ReadonlySet<string> },
): Series | null => {
  const occ = byDate(rows);
  if (occ.length < opts.minOccurrences) return null;
  const gaps = occ.slice(1).map((r, i) => daysBetween(occ[i].date, r.date));
  const med = median(gaps);
  const cadence = CADENCES.find((c) => Math.abs(med - c.days) <= c.tol);
  if (!cadence) return null;
  const onBeat = gaps.filter((g) => Math.abs(g - cadence.days) <= cadence.tol).length;
  if (onBeat < gaps.length * 0.75) return null;

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
  return {
    payee: last.payee ?? "(no payee)",
    payee_id: last.payee_id,
    category: last.category,
    category_id: last.category_id,
    account: last.account,
    cadence: cadence.name,
    interval_days: med,
    typical_amount: typical,
    min_amount: Math.min(...amounts),
    max_amount: Math.max(...amounts),
    steady_amount: near >= amounts.length * 0.75,
    monthly_equivalent: Math.round((typical * 30.44) / cadence.days),
    count: occ.length,
    first_date: occ[0].date,
    last_date: last.date,
    next_expected_date: next,
    status,
    scheduled: !!last.payee_id && opts.scheduledPayees.has(last.payee_id),
    last_transaction_id: last.id,
  };
};

// Per payee: the payee's whole history if it keeps a cadence (a utility bill
// that varies), else each exact amount that does (two Apple subscriptions, or
// several Privacy.com cards behind one payee).
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
  },
): Recurring => {
  const byPayee = new Map<string, FlatRow[]>();
  for (const r of rows) {
    if (r.transfer || r.amount === 0) continue;
    if (!opts.includeIncome && r.amount > 0) continue;
    const key = `${r.payee_id ?? r.payee ?? "none"}|${Math.sign(r.amount)}`;
    byPayee.set(key, [...(byPayee.get(key) ?? []), r]);
  }
  const series: Series[] = [];
  for (const group of byPayee.values()) {
    if (group.every((r) => !r.payee_id && !r.payee)) continue;
    const whole = detectSeries(group, opts);
    if (whole) {
      series.push(whole);
      continue;
    }
    const byAmount = new Map<number, FlatRow[]>();
    for (const r of group) byAmount.set(r.amount, [...(byAmount.get(r.amount) ?? []), r]);
    for (const same of byAmount.values()) {
      const s = detectSeries(same, opts);
      if (s) series.push(s);
    }
  }
  const kept = series
    .filter((s) => opts.includeLapsed || s.status !== "lapsed")
    .sort(
      (a, b) =>
        a.next_expected_date.localeCompare(b.next_expected_date) ||
        a.payee.localeCompare(b.payee),
    );
  return {
    iso: opts.iso,
    since_date: opts.sinceDate,
    as_of: opts.today,
    monthly_total: kept
      .filter((s) => s.status !== "lapsed" && s.typical_amount < 0)
      .reduce((a, s) => a + s.monthly_equivalent, 0),
    series: kept,
  };
};

// ---- Render (pure)

export const renderRecurring = (r: Recurring, opts: { includeIds: boolean }): string => {
  if (!r.series.length) return `No recurring charges found since ${r.since_date}.`;
  const { iso } = r;
  const out = [
    `${r.series.length} recurring series since ${r.since_date} (as of ${r.as_of}); outflows ≈ ${fmtMoney(r.monthly_total, iso)}/month`,
    "",
  ];
  for (const s of r.series) {
    const amt = s.steady_amount
      ? fmtMoney(s.typical_amount, iso)
      : `~${fmtMoney(s.typical_amount, iso)} (${fmtMoney(s.min_amount, iso)} to ${fmtMoney(s.max_amount, iso)})`;
    const flags = [
      s.status !== "active" ? s.status : "",
      s.scheduled ? "scheduled" : "",
    ].filter(Boolean);
    const ids = opts.includeIds
      ? ` — payee ${s.payee_id ?? "none"}, category ${s.category_id ?? "none"}, last tx ${s.last_transaction_id}`
      : "";
    out.push(
      `- ${s.payee} ${amt} ${s.cadence} → ${s.category ?? "(uncategorized)"}; next ${s.next_expected_date}, last ${s.last_date}, ${s.count}×${flags.length ? ` [${flags.join(", ")}]` : ""}${ids}`,
    );
  }
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Recurring charges (subscriptions, bills): payees, or one exact amount from a payee, that repeat on a steady cadence " +
  "(weekly, biweekly, monthly, quarterly, semiannual, yearly). Each series has its typical amount and range, whether the amount is steady, " +
  "the current category (from the latest charge), the next expected date, a monthly equivalent, whether a scheduled transaction already covers it, " +
  "and a status: active, late (overdue by under one cycle), or lapsed (probably cancelled; hidden unless include_lapsed). " +
  "Several subscriptions behind one payee, such as Privacy.com cards, come back as separate series by amount. " +
  "Looks back 400 days by default; a yearly charge needs min_occurrences within the window. Transfers are excluded; income only with include_income.";

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
        });
        return result(renderRecurring(r, { includeIds: args.include_ids }), r);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
