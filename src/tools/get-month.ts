import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Category,
  CategoryGroup,
  MonthDetail,
  YnabClient,
} from "../ynab";
import {
  result,
  handleError,
  fmtMoney,
  fmtCategoryLine,
} from "../format";

// ---- Result types (zod is the single source of truth; the TS types are
// inferred and the schema doubles as the tool's outputSchema — see ADR 0002).
// Money is in milliunits; ageOfMoney is a day count.

// Mirrors the YNAB Category shape (see ynab.ts). Money fields are milliunits.
const CategorySchema = z.object({
  id: z.string(),
  category_group_id: z.string(),
  category_group_name: z.string().optional(),
  name: z.string(),
  hidden: z.boolean(),
  internal: z.boolean().optional(),
  deleted: z.boolean().optional(),
  budgeted: z.number(),
  activity: z.number(),
  balance: z.number(),
  goal_type: z.string().nullable().optional(),
  goal_target: z.number().nullable().optional(),
  goal_target_date: z.string().nullable().optional(),
  goal_cadence: z.number().nullable().optional(),
  goal_cadence_frequency: z.number().nullable().optional(),
  goal_months_to_budget: z.number().nullable().optional(),
  goal_percentage_complete: z.number().nullable().optional(),
  goal_under_funded: z.number().nullable().optional(),
  goal_overall_funded: z.number().nullable().optional(),
  goal_overall_left: z.number().nullable().optional(),
});

const MonthGroupReportSchema = z.object({
  name: z.string(),
  // Categories belonging to this group that have data in the month, in
  // category_groups order.
  categories: z.array(CategorySchema),
});
export type MonthGroupReport = z.infer<typeof MonthGroupReportSchema>;

export const MonthReportSchema = z.object({
  // Currency code (e.g. "USD") for formatting the milliunit amounts below.
  iso: z.string(),
  month: z.string(),
  income: z.number(),
  budgeted: z.number(),
  activity: z.number(),
  toBeBudgeted: z.number(),
  ageOfMoney: z.number().nullable(),
  groups: z.array(MonthGroupReportSchema),
});
export type MonthReport = z.infer<typeof MonthReportSchema>;

// ---- Compute (pure)

export interface ComputeOpts {
  includeHidden: boolean;
  // Currency code for the structured payload. Optional for callers (tests)
  // that don't care; the handler always passes the budget's real code.
  iso?: string;
}

export const computeMonthReport = (
  monthDetail: MonthDetail,
  categoryGroups: CategoryGroup[],
  opts: ComputeOpts,
): MonthReport => {
  const iso = opts.iso ?? "USD";
  const byId = new Map(monthDetail.categories.map((cat) => [cat.id, cat]));
  const groups: MonthGroupReport[] = [];
  for (const g of categoryGroups) {
    if (g.hidden && !opts.includeHidden) continue;
    const categories: Category[] = [];
    for (const groupCat of g.categories) {
      if (groupCat.hidden && !opts.includeHidden) continue;
      const monthCat = byId.get(groupCat.id);
      if (!monthCat) continue;
      categories.push(monthCat);
    }
    if (!categories.length) continue;
    groups.push({ name: g.name, categories });
  }

  return {
    iso,
    month: monthDetail.month,
    income: monthDetail.income,
    budgeted: monthDetail.budgeted,
    activity: monthDetail.activity,
    toBeBudgeted: monthDetail.to_be_budgeted,
    ageOfMoney: monthDetail.age_of_money,
    groups,
  };
};

// ---- Render (pure)

export interface RenderOpts {
  includeIds: boolean;
}

export const renderMonthReport = (
  report: MonthReport,
  opts: RenderOpts,
): string => {
  const out: string[] = [];
  const iso = report.iso;
  out.push(`Month: ${report.month}`);
  out.push(`Income:         ${fmtMoney(report.income, iso)}`);
  out.push(`Budgeted:       ${fmtMoney(report.budgeted, iso)}`);
  out.push(`Activity:       ${fmtMoney(report.activity, iso)}`);
  out.push(`To be budgeted: ${fmtMoney(report.toBeBudgeted, iso)}`);
  if (report.ageOfMoney !== null) {
    out.push(`Age of money:   ${report.ageOfMoney} days`);
  }
  out.push("");

  for (const g of report.groups) {
    out.push(`## ${g.name}`);
    for (const c of g.categories) {
      out.push(fmtCategoryLine(c, report.month, opts.includeIds));
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
};

// ---- MCP tool registration

const DESCRIPTION =
  "Full month breakdown grouped by category group: income, budgeted, activity, to-be-budgeted, and every category's budgeted/activity/balance/goal for that month. Defaults to the current month.";

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
        budget_id: z.string(),
        month: z
          .string()
          .optional()
          .default("current")
          .describe("YYYY-MM-01 or 'current'"),
        include_hidden: z.boolean().optional().default(false),
        include_ids: z.boolean().optional().default(false),
      },
      outputSchema: MonthReportSchema.shape,
    },
    async ({ budget_id, month, include_hidden, include_ids }) => {
      try {
        const c = getClient();
        const [monthRes, catsRes, settingsRes] = await Promise.all([
          c.getMonth(budget_id, month),
          c.listCategories(budget_id),
          c.getBudgetSettings(budget_id),
        ]);
        const iso =
          settingsRes.data.settings.currency_format?.iso_code ?? "USD";
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
