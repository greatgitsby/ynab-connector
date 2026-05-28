import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  BudgetDetail,
  MonthDetail,
  Transaction,
  YnabClient,
} from "../ynab";
import {
  text,
  handleError,
  fmtMoney,
  fmtPercent,
  pushSection,
} from "../format";
import {
  resolveMonthSpec,
  monthEndDate,
  daysInMonth,
} from "../month-window";
import { isSpendingCategory, isTransferTx } from "../predicates";

// ---- Result types

export interface CategorySpendingRow {
  id: string;
  name: string;
  // Total outflow magnitude in milliunits (positive number).
  magnitude: number;
}

export interface PositiveInflowRow {
  id: string;
  name: string;
  // Total positive activity in milliunits.
  positive: number;
}

export interface OutflowRef {
  date: string;
  amount: number;
  payee_name: string | null;
  category_name: string | null;
  account_name: string;
  parent_id: string;
  sub_id?: string;
}

export interface SpendingBreakdown {
  range: {
    start: string;
    end: string;
    // Pre-formatted label: "2026-04" or "2026-03 to 2026-04 (2 months)".
    label: string;
    months: number;
    days: number;
  };
  totals: {
    spending: number;
    monthlyAvg: number;
    dailyAvg: number;
  };
  largestOutflow: OutflowRef | null;
  mostFrequent: { categoryName: string; count: number } | null;
  spending: CategorySpendingRow[];
  positiveInflows: PositiveInflowRow[];
}

// ---- Helpers (tool-local — kept private to the breakdown view)

// Single largest outflow (most-negative parent or sub). Skips transfers — a
// move between accounts isn't spending even though one side is negative.
const findLargestOutflow = (txs: Transaction[]): OutflowRef | null => {
  let best: OutflowRef | null = null;
  const consider = (o: OutflowRef) => {
    if (!best || o.amount < best.amount) best = o;
  };
  for (const t of txs) {
    if (t.subtransactions?.length) {
      for (const s of t.subtransactions) {
        if (s.amount >= 0) continue;
        consider({
          date: t.date,
          amount: s.amount,
          payee_name: s.payee_name ?? t.payee_name,
          category_name: s.category_name,
          account_name: t.account_name,
          parent_id: t.id,
          sub_id: s.id,
        });
      }
    } else {
      if (isTransferTx(t)) continue;
      if (t.amount >= 0) continue;
      consider({
        date: t.date,
        amount: t.amount,
        payee_name: t.payee_name,
        category_name: t.category_name,
        account_name: t.account_name,
        parent_id: t.id,
      });
    }
  }
  return best;
};

// Spending category with the most transactions in `txs`. Subtransactions
// count independently. Transfers, uncategorized rows, and Inflow:RTA are
// skipped — they aren't "spending categories" in the Reflect sense.
const findMostFrequentCategory = (
  txs: Transaction[],
): { categoryName: string; count: number } | null => {
  const counts = new Map<string, number>();
  const bump = (name: string | null) => {
    if (!name || name === "Uncategorized" || name.startsWith("Inflow")) return;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  for (const t of txs) {
    if (t.subtransactions?.length) {
      for (const s of t.subtransactions) bump(s.category_name);
    } else {
      if (isTransferTx(t)) continue;
      bump(t.category_name);
    }
  }
  let best: { categoryName: string; count: number } | null = null;
  for (const [name, count] of counts) {
    if (!best || count > best.count) best = { categoryName: name, count };
  }
  return best;
};

// ---- Compute (pure)

export interface ComputeOpts {
  start: string;
  end: string;
}

// Assumes monthsInRange has at least one MonthDetail. Handler validates
// the date range and emits its own error string when monthsInRange is empty.
export const computeSpendingBreakdown = (
  monthsInRange: MonthDetail[],
  transactions: Transaction[],
  opts: ComputeOpts,
): SpendingBreakdown => {
  const { start, end } = opts;
  const spendByCat = new Map<string, CategorySpendingRow>();
  const positiveByCat = new Map<string, PositiveInflowRow>();
  let totalSpend = 0;
  for (const m of monthsInRange) {
    for (const cat of m.categories ?? []) {
      if (!isSpendingCategory(cat)) continue;
      if (cat.activity < 0) {
        const row = spendByCat.get(cat.id) ?? {
          id: cat.id,
          name: cat.name,
          magnitude: 0,
        };
        row.magnitude += -cat.activity;
        spendByCat.set(cat.id, row);
        totalSpend += -cat.activity;
      } else if (cat.activity > 0) {
        const row = positiveByCat.get(cat.id) ?? {
          id: cat.id,
          name: cat.name,
          positive: 0,
        };
        row.positive += cat.activity;
        positiveByCat.set(cat.id, row);
      }
    }
  }
  const spending = [...spendByCat.values()].sort(
    (a, b) => b.magnitude - a.magnitude,
  );
  const positiveInflows = [...positiveByCat.values()].sort(
    (a, b) => b.positive - a.positive,
  );

  const numMonths = monthsInRange.length;
  const totalDays = monthsInRange.reduce(
    (s, m) => s + daysInMonth(m.month),
    0,
  );
  const label =
    start === end
      ? start.slice(0, 7)
      : `${start.slice(0, 7)} to ${end.slice(0, 7)} (${numMonths} months)`;

  return {
    range: { start, end, label, months: numMonths, days: totalDays },
    totals: {
      spending: totalSpend,
      monthlyAvg: totalSpend / numMonths,
      dailyAvg: totalSpend / totalDays,
    },
    largestOutflow: findLargestOutflow(transactions),
    mostFrequent: findMostFrequentCategory(transactions),
    spending,
    positiveInflows,
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

export const renderSpendingBreakdown = (
  r: SpendingBreakdown,
  opts: RenderOpts,
): string => {
  const out: string[] = [];
  out.push(`Spending Breakdown: ${r.range.label}`);
  out.push("");
  out.push(`Total Spending: ${fmtMoney(r.totals.spending)}`);
  if (r.range.months > 1) {
    out.push(`Average Monthly Spending: ${fmtMoney(r.totals.monthlyAvg)}`);
  }
  out.push(
    `Average Daily Spending: ${fmtMoney(r.totals.dailyAvg)} (over ${r.range.days} days)`,
  );
  out.push(
    r.mostFrequent
      ? `Most Frequent Category: ${r.mostFrequent.categoryName} (${r.mostFrequent.count} transactions)`
      : "Most Frequent Category: (none)",
  );
  if (r.largestOutflow) {
    const largest = r.largestOutflow;
    const idSuffix = opts.includeIds
      ? ` — id ${largest.sub_id ?? largest.parent_id}`
      : "";
    const cat = largest.category_name ? ` → ${largest.category_name}` : "";
    out.push(
      `Largest Outflow: ${largest.payee_name ?? "(no payee)"} ${fmtMoney(largest.amount)} on ${largest.date}${cat} [${largest.account_name}]${idSuffix}`,
    );
  } else {
    out.push("Largest Outflow: (none)");
  }
  out.push("");

  pushSection(
    out,
    "Spending by category (sorted desc)",
    r.spending,
    r.spending.length,
    (row) => {
      const idSuffix = opts.includeIds ? ` — id ${row.id}` : "";
      return `- ${row.name}: ${fmtMoney(row.magnitude)} (${fmtPercent(row.magnitude, r.totals.spending)})${idSuffix}`;
    },
  );

  pushSection(
    out,
    "Positive Inflow Categories (refunds, transfers in)",
    r.positiveInflows,
    r.positiveInflows.length,
    (row) => {
      const idSuffix = opts.includeIds ? ` — id ${row.id}` : "";
      return `- ${row.name}: +${fmtMoney(row.positive)}${idSuffix}`;
    },
  );

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reflect: spending breakdown over a date range. Mirrors YNAB's in-app Spending Breakdown tab. Returns total spending, average monthly and daily spending, most frequent spending category (by transaction count), single largest outflow (by transaction amount), per-category share sorted desc, and a separate list of categories with net positive activity (refunds, transfers in). Range defaults to the previous calendar month — pass start_month / end_month to widen it.";

export const registerReflectSpendingBreakdown = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "reflect_spending_breakdown",
    {
      description: DESCRIPTION,
      inputSchema: {
        budget_id: z.string(),
        start_month: z
          .string()
          .optional()
          .default("last_month")
          .describe("YYYY-MM-01, 'current', or 'last_month'"),
        end_month: z
          .string()
          .optional()
          .describe(
            "YYYY-MM-01, 'current', or 'last_month'. Defaults to start_month for a single-month view.",
          ),
        include_ids: z.boolean().optional().default(false),
      },
    },
    async ({ budget_id, start_month, end_month, include_ids }) => {
      try {
        const c = getClient();
        const start = resolveMonthSpec(start_month);
        const end = resolveMonthSpec(end_month ?? start_month);
        if (start > end) {
          return text(
            `Error: start_month (${start.slice(0, 7)}) is after end_month (${end.slice(0, 7)}).`,
          );
        }
        const budgetRes = await c.getBudget(budget_id);
        const budget: BudgetDetail = budgetRes.data.budget;
        const monthsInRange = (budget.months ?? []).filter(
          (m) => m.month >= start && m.month <= end,
        );
        if (!monthsInRange.length) {
          return text(
            `No month data in ${start.slice(0, 7)} to ${end.slice(0, 7)} (budget starts ${budget.first_month}).`,
          );
        }
        const endDate = monthEndDate(end);
        const txRes = await c.listTransactions(budget_id, { sinceDate: start });
        const txs = txRes.data.transactions.filter(
          (t) => t.date >= start && t.date <= endDate,
        );
        const breakdown = computeSpendingBreakdown(monthsInRange, txs, {
          start,
          end,
        });
        return text(
          renderSpendingBreakdown(breakdown, { includeIds: include_ids }),
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
