import { z } from "zod";
import { includeIdsParam, monthParam, planIdParam } from "../schemas";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Category, CategoryGroup, MonthDetail, YnabClient } from "../ynab";
import { CategorySchema, MonthSummarySchema } from "../wire";
import { result, handleError, fmtMoney, fmtCategoryLine } from "../format";

// ---- Result type (zod is the source of truth; see docs/internals/structured-output.md)

// YNAB's month summary, plus its categories grouped in the Plan's order.
export const MonthReportSchema = MonthSummarySchema.extend({
  iso: z.string(),
  groups: z.array(
    z.object({ name: z.string(), categories: z.array(CategorySchema) }),
  ),
});
export type MonthReport = z.infer<typeof MonthReportSchema>;

// ---- Compute (pure)

// GET /months/{month} returns categories in no particular order, so the
// group order comes from GET /categories. Internal categories are left out:
// Inflow: Ready to Assign's balance is a lifetime figure, not this month's.
export const computeMonthReport = (
  monthDetail: MonthDetail,
  categoryGroups: CategoryGroup[],
  opts: { includeHidden: boolean; iso: string },
): MonthReport => {
  const { categories: monthCategories, ...summary } = monthDetail;
  const byId = new Map(monthCategories.map((cat) => [cat.id, cat]));
  const groups: MonthReport["groups"] = [];
  for (const g of categoryGroups) {
    if (g.deleted || g.internal || (g.hidden && !opts.includeHidden)) continue;
    const categories: Category[] = [];
    for (const groupCat of g.categories ?? []) {
      const monthCat = byId.get(groupCat.id);
      if (!monthCat || monthCat.deleted || monthCat.internal) continue;
      if (monthCat.hidden && !opts.includeHidden) continue;
      categories.push(monthCat);
    }
    if (categories.length) groups.push({ name: g.name, categories });
  }
  return { ...summary, iso: opts.iso, groups };
};

// ---- Render (pure)

export const renderMonthReport = (
  report: MonthReport,
  opts: { includeIds: boolean },
): string => {
  const { iso } = report;
  const out: string[] = [];
  out.push(`Month: ${report.month}`);
  out.push(`Ready to Assign: ${fmtMoney(report.to_be_budgeted, iso)}`);
  out.push(`Income:          ${fmtMoney(report.income, iso)}`);
  out.push(`Assigned:        ${fmtMoney(report.budgeted, iso)}`);
  out.push(`Activity:        ${fmtMoney(report.activity, iso)}`);
  if (report.age_of_money != null) {
    out.push(`Age of money:    ${report.age_of_money} days`);
  }
  if (report.note) out.push(`Note: ${report.note}`);
  out.push("");
  for (const g of report.groups) {
    out.push(`## ${g.name}`);
    for (const c of g.categories) {
      out.push(fmtCategoryLine(c, report.month, iso, opts.includeIds));
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "One month of a plan: Ready to Assign, income, assigned, activity, and age " +
  "of money, then each category's budgeted (assigned), activity, balance " +
  "(available), and goal, grouped by category group. Defaults to the " +
  "current month. Use list_months for these totals across many months.";

export const registerGetMonth = (
  server: McpServer,
  getClient: () => YnabClient,
) => {
  server.registerTool(
    "get_month",
    {
      title: "Get Month",
      description: DESCRIPTION,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        plan_id: planIdParam,
        month: monthParam.optional().default("current"),
        include_hidden: z.boolean().optional().default(false),
        include_ids: includeIdsParam,
      },
      outputSchema: MonthReportSchema.shape,
    },
    async ({ plan_id, month, include_hidden, include_ids }) => {
      try {
        const c = getClient();
        const [monthRes, catsRes, iso] = await Promise.all([
          c.getMonth(plan_id, month),
          c.listCategories(plan_id),
          c.planIso(plan_id),
        ]);
        const report = computeMonthReport(
          monthRes.data.month,
          catsRes.data.category_groups,
          { includeHidden: include_hidden, iso },
        );
        return result(
          renderMonthReport(report, { includeIds: include_ids }),
          report,
        );
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
