import { z } from "zod";
import { monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MonthSummary, YnabClient } from "../ynab";
import { MonthSummarySchema } from "../wire";
import { result, handleError, padMoney } from "../format";
import { resolveMonthRange } from "../month-window";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

export const MonthListSchema = z.object({
  iso: z.string(),
  // Chronological.
  months: z.array(MonthSummarySchema),
});
export type MonthList = z.infer<typeof MonthListSchema>;

// ---- Compute (pure)

export const computeMonthList = (
  months: MonthSummary[],
  opts: { since: string; until: string; iso: string },
): MonthList => ({
  iso: opts.iso,
  months: months
    .filter((m) => !m.deleted && m.month >= opts.since && m.month <= opts.until)
    .sort((a, b) => a.month.localeCompare(b.month)),
});

// ---- Render (pure)

const COL = 14;

export const renderMonthList = (list: MonthList): string => {
  if (!list.months.length) return "No months in that range.";
  const { iso } = list;
  const header = ["Income", "Assigned", "Activity", "Ready to Assign"]
    .map((h) => h.padStart(COL + (h === "Ready to Assign" ? 2 : 0)))
    .join("");
  const out = [`${"Month".padEnd(9)}${header}  Age of money`];
  for (const m of list.months) {
    const aom = m.age_of_money == null ? "" : `  ${m.age_of_money} days`;
    out.push(
      `${m.month.slice(0, 7).padEnd(9)}${padMoney(m.income, COL, iso)}${padMoney(m.budgeted, COL, iso)}${padMoney(m.activity, COL, iso)}${padMoney(m.to_be_budgeted, COL + 2, iso)}${aom}`,
    );
  }
  return out.join("\n");
};

// ---- MCP tool registration

const DESCRIPTION =
  "Plan-level totals for each month in a range: income, assigned " +
  "(budgeted), activity, Ready to Assign, and age of money. Activity is " +
  "negative when categories spent more than they received. The range " +
  "defaults to the 12 months ending with the current month. For " +
  "per-category amounts use get_month (one month) or reflect_income_expense " +
  "(many months).";

export const registerListMonths = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "list_months",
    {
      title: "List Months",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        since_month: monthParam.optional(),
        until_month: monthParam.optional().default("current"),
      },
      outputSchema: MonthListSchema.shape,
    },
    async ({ plan_id, since_month, until_month }) => {
      try {
        const c = getClient();
        const [{ data }, iso] = await Promise.all([
          c.listMonths(plan_id),
          c.planIso(plan_id),
        ]);
        const range = resolveMonthRange(since_month, until_month, 12);
        const list = computeMonthList(data.months, { ...range, iso });
        return result(renderMonthList(list), list);
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
