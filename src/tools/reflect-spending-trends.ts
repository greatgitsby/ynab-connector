import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetDetail, YnabClient } from "../ynab";
import { text, handleError, fmtMoney, padMoney } from "../format";
import { resolveMonthWindow } from "../month-window";
import { isSpendingCategory } from "../predicates";

// ---- Result types

export interface MonthlyNet {
  month: string;
  // -m.activity in milliunits. Positive when non-Inflow categories spent
  // more than they received; negative when refunds/transfers-in exceeded
  // spending.
  value: number;
}

export interface CategoryTrend {
  id: string;
  name: string;
  // Total spending magnitude across the window in milliunits.
  total: number;
  // Months where the category had outflows (mag > 0), parallel to window.
  // Used to compute per-month stats over present months only.
  presentMonths: { month: string; magnitude: number }[];
  // null when there were no months with outflows in the window.
  stats: {
    avg: number;
    min: { month: string; v: number };
    max: { month: string; v: number };
  } | null;
}

export interface SpendingTrends {
  budgetName: string;
  iso: string;
  window: string[];
  truncationNote: string | null;
  monthlyNet: MonthlyNet[];
  avgNet: number;
  // All categories ranked desc by total spending magnitude. Render slices
  // this to a top-N for display.
  ranked: CategoryTrend[];
}

// ---- Compute (pure)

export interface ComputeOpts {
  monthsBack: number;
}

export const computeSpendingTrends = (
  budget: BudgetDetail,
  opts: ComputeOpts,
): SpendingTrends => {
  const iso = budget.currency_format?.iso_code ?? "USD";
  const win = resolveMonthWindow(budget, opts.monthsBack);
  const window = win.present;
  const monthsInWindow = win.months;

  const monthlyNet: MonthlyNet[] = monthsInWindow.map((m) => ({
    month: m.month,
    value: -m.activity,
  }));
  const totalNet = monthlyNet.reduce((s, x) => s + x.value, 0);
  const avgNet = monthlyNet.length ? totalNet / monthlyNet.length : 0;

  type Agg = {
    id: string;
    name: string;
    total: number;
    monthly: Map<string, number>;
  };
  const agg = new Map<string, Agg>();
  for (const m of monthsInWindow) {
    for (const cat of m.categories ?? []) {
      if (!isSpendingCategory(cat)) continue;
      const mag = cat.activity < 0 ? -cat.activity : 0;
      if (mag === 0) continue;
      let row = agg.get(cat.id);
      if (!row) {
        row = { id: cat.id, name: cat.name, total: 0, monthly: new Map() };
        agg.set(cat.id, row);
      }
      row.total += mag;
      row.monthly.set(m.month, (row.monthly.get(m.month) ?? 0) + mag);
    }
  }

  const ranked: CategoryTrend[] = [...agg.values()]
    .sort((a, b) => b.total - a.total)
    .map((row) => {
      const presentMonths = window
        .map((k) => ({ month: k, magnitude: row.monthly.get(k) ?? 0 }))
        .filter((x) => x.magnitude > 0);
      let stats: CategoryTrend["stats"] = null;
      if (presentMonths.length) {
        const min = presentMonths.reduce((a, b) =>
          b.magnitude < a.magnitude ? b : a,
        );
        const max = presentMonths.reduce((a, b) =>
          b.magnitude > a.magnitude ? b : a,
        );
        stats = {
          avg: row.total / presentMonths.length,
          min: { month: min.month, v: min.magnitude },
          max: { month: max.month, v: max.magnitude },
        };
      }
      return {
        id: row.id,
        name: row.name,
        total: row.total,
        presentMonths,
        stats,
      };
    });

  return {
    budgetName: budget.name,
    iso,
    window,
    truncationNote: win.truncationNote,
    monthlyNet,
    avgNet,
    ranked,
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
  topN: number;
}

const COL_W = 14;
const DELTA_W = 22;

export const renderSpendingTrends = (
  trends: SpendingTrends,
  opts: RenderOpts,
): string => {
  const { window, iso, budgetName, monthlyNet, avgNet, ranked } = trends;
  const out: string[] = [];

  const winStart = window[0] ?? "(none)";
  const winEnd = window[window.length - 1] ?? "(none)";
  out.push(
    `Spending Trends: ${budgetName} — last ${window.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
  );
  if (trends.truncationNote) out.push(trends.truncationNote);
  out.push("");

  out.push(`## Monthly net activity (last ${window.length} months)`);
  out.push(
    `${"Month".padEnd(10)}${"Net Activity".padStart(COL_W)}${"vs Average".padStart(DELTA_W)}`,
  );
  for (const m of monthlyNet) {
    const delta = m.value - avgNet;
    const arrow = delta >= 0 ? "↑" : "↓";
    const sign = delta >= 0 ? "+" : "";
    const pct =
      avgNet !== 0
        ? ` (${((delta / Math.abs(avgNet)) * 100).toFixed(1)}%)`
        : "";
    const deltaStr = `${arrow} ${sign}${fmtMoney(delta, iso)}${pct}`;
    out.push(
      `${m.month.slice(0, 7).padEnd(10)}${padMoney(m.value, COL_W, iso)}${deltaStr.padStart(DELTA_W)}`,
    );
  }
  if (monthlyNet.length) {
    out.push(`${"Average".padEnd(10)}${padMoney(avgNet, COL_W, iso)}`);
  }
  out.push("");

  const topTrend = ranked.slice(0, opts.topN);
  out.push(
    ranked.length <= opts.topN
      ? `## Top categories month-over-month (${ranked.length})`
      : `## Top categories month-over-month (showing ${opts.topN} of ${ranked.length})`,
  );

  if (!topTrend.length) {
    out.push("(none)");
  } else if (window.length === 1) {
    for (const c of topTrend) {
      const only = c.presentMonths[0]?.magnitude ?? 0;
      const idSuffix = opts.includeIds ? ` — id ${c.id}` : "";
      out.push(
        `- ${c.name}: ${fmtMoney(only, iso)} (${window[0].slice(0, 7)})${idSuffix}`,
      );
    }
  } else {
    for (const c of topTrend) {
      const idSuffix = opts.includeIds ? ` — id ${c.id}` : "";
      if (!c.stats) {
        out.push(
          `- ${c.name}: avg ${fmtMoney(0, iso)} (no spending)${idSuffix}`,
        );
        continue;
      }
      const cadence =
        c.presentMonths.length === window.length
          ? ""
          : ` (${c.presentMonths.length}/${window.length} months)`;
      out.push(
        `- ${c.name}: avg ${fmtMoney(c.stats.avg, iso)}${cadence}, min ${fmtMoney(c.stats.min.v, iso)} (${c.stats.min.month.slice(0, 7)}), max ${fmtMoney(c.stats.max.v, iso)} (${c.stats.max.month.slice(0, 7)})${idSuffix}`,
      );
    }
  }

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reflect: monthly net activity over the last N months (default 6, matching YNAB's default) with each month's delta from the window average. Net activity = -month.activity, which mirrors what YNAB shows on Spending Trends: positive means non-Inflow categories spent more than they received; negative means refunds/transfers-in exceeded spending. Also lists the top categories ranked by total spending magnitude with their month-over-month average / min / max.";

const TOP_TREND_DEFAULT = 5;

export const registerReflectSpendingTrends = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "reflect_spending_trends",
    {
      description: DESCRIPTION,
      inputSchema: {
        budget_id: z.string(),
        months_back: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .default(6),
        include_ids: z.boolean().optional().default(false),
      },
    },
    async ({ budget_id, months_back, include_ids }) => {
      try {
        const c = getClient();
        const { data } = await c.getBudget(budget_id);
        const trends = computeSpendingTrends(data.budget, {
          monthsBack: months_back,
        });
        return text(
          renderSpendingTrends(trends, {
            includeIds: include_ids,
            topN: TOP_TREND_DEFAULT,
          }),
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
