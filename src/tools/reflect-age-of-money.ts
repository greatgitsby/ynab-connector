import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BudgetDetail, YnabClient } from "../ynab";
import { text, handleError } from "../format";
import { resolveMonthWindow } from "../month-window";

// ---- Result types

export interface AgeOfMoneyEntry {
  month: string;
  // null when YNAB didn't return age_of_money for that month, "no_data" when
  // the month itself is missing from the Budget.
  aom: number | null | "no_data";
}

export interface AgeOfMoneyTrend {
  budgetName: string;
  requested: string[];
  current: number | null;
  history: AgeOfMoneyEntry[];
  // Average over months where AoM was reported. null when none.
  average: number | null;
  // Last - first across reported months. null when fewer than 2 reported.
  delta: number | null;
}

// ---- Compute (pure)

export interface ComputeOpts {
  monthsBack: number;
}

export const computeAgeOfMoneyTrend = (
  budget: BudgetDetail,
  opts: ComputeOpts,
): AgeOfMoneyTrend => {
  const win = resolveMonthWindow(budget, opts.monthsBack);
  const { requested, monthsByKey } = win;

  const latest = monthsByKey.get(requested[requested.length - 1] ?? "");
  const current = latest?.age_of_money ?? null;

  const history: AgeOfMoneyEntry[] = [];
  const aomVals: number[] = [];
  for (const k of requested) {
    const m = monthsByKey.get(k);
    if (!m) {
      history.push({ month: k, aom: "no_data" });
      continue;
    }
    if (m.age_of_money == null) {
      history.push({ month: k, aom: null });
      continue;
    }
    history.push({ month: k, aom: m.age_of_money });
    aomVals.push(m.age_of_money);
  }

  const average = aomVals.length
    ? aomVals.reduce((s, v) => s + v, 0) / aomVals.length
    : null;
  const delta =
    aomVals.length >= 2 ? aomVals[aomVals.length - 1] - aomVals[0] : null;

  return {
    budgetName: budget.name,
    requested,
    current,
    history,
    average,
    delta,
  };
};

// ---- Render (pure)

export const renderAgeOfMoneyTrend = (trend: AgeOfMoneyTrend): string => {
  const { requested, budgetName, current, history, average, delta } = trend;
  const out: string[] = [];
  const winStart = requested[0] ?? "(none)";
  const winEnd = requested[requested.length - 1] ?? "(none)";
  out.push(
    `Age of Money: ${budgetName} — last ${requested.length} months (${winStart.slice(0, 7)} to ${winEnd.slice(0, 7)})`,
  );
  out.push("");

  if (current != null) {
    out.push(`Current: ${current} days`);
    out.push("");
  }

  for (const entry of history) {
    if (entry.aom === "no_data") {
      out.push(`- ${entry.month.slice(0, 7)}: (no data)`);
    } else if (entry.aom == null) {
      out.push(`- ${entry.month.slice(0, 7)}: (n/a)`);
    } else {
      out.push(`- ${entry.month.slice(0, 7)}: ${entry.aom} days`);
    }
  }

  if (average == null) {
    out.push("");
    out.push("(age of money not yet available)");
  } else {
    out.push("");
    out.push(`Average: ${Math.round(average)} days`);
    if (delta == null) {
      out.push("Trend: n/a (single data point)");
    } else {
      const sign = delta >= 0 ? "+" : "";
      const reportedCount = history.filter(
        (e) => typeof e.aom === "number",
      ).length;
      out.push(
        `Trend: ${sign}${delta} days vs ${reportedCount} months ago`,
      );
    }
  }

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Reflect: age-of-money trend over the last N months (default 5). Age of money is YNAB's measure of how long money sits in accounts between earning and spending. Returns the current value (latest month), monthly history, average, and start-to-end delta.";

export const registerReflectAgeOfMoney = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "reflect_age_of_money",
    {
      title: "Reflect: Age of Money",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        budget_id: z.string(),
        months_back: z
          .number()
          .int()
          .min(1)
          .max(24)
          .optional()
          .default(5),
      },
    },
    async ({ budget_id, months_back }) => {
      try {
        const c = getClient();
        const { data } = await c.getBudget(budget_id);
        const trend = computeAgeOfMoneyTrend(data.budget, {
          monthsBack: months_back,
        });
        return text(renderAgeOfMoneyTrend(trend));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
