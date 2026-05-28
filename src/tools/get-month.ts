import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  Category,
  CategoryGroup,
  MonthDetail,
  YnabClient,
} from "../ynab";
import {
  text,
  handleError,
  fmtMoney,
  fmtCategoryLine,
} from "../format";

// ---- Result types

export interface MonthGroupReport {
  name: string;
  // Categories belonging to this group that have data in the month, in
  // category_groups order.
  categories: Category[];
}

export interface MonthReport {
  month: string;
  income: number;
  budgeted: number;
  activity: number;
  toBeBudgeted: number;
  ageOfMoney: number | null;
  groups: MonthGroupReport[];
}

// ---- Compute (pure)

export interface ComputeOpts {
  includeHidden: boolean;
}

export const computeMonthReport = (
  monthDetail: MonthDetail,
  categoryGroups: CategoryGroup[],
  opts: ComputeOpts,
): MonthReport => {
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
  out.push(`Month: ${report.month}`);
  out.push(`Income:         ${fmtMoney(report.income)}`);
  out.push(`Budgeted:       ${fmtMoney(report.budgeted)}`);
  out.push(`Activity:       ${fmtMoney(report.activity)}`);
  out.push(`To be budgeted: ${fmtMoney(report.toBeBudgeted)}`);
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
      description: DESCRIPTION,
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
    },
    async ({ budget_id, month, include_hidden, include_ids }) => {
      try {
        const c = getClient();
        const [monthRes, catsRes] = await Promise.all([
          c.getMonth(budget_id, month),
          c.listCategories(budget_id),
        ]);
        const report = computeMonthReport(
          monthRes.data.month,
          catsRes.data.category_groups,
          { includeHidden: include_hidden },
        );
        return text(renderMonthReport(report, { includeIds: include_ids }));
      } catch (e) {
        return handleError(e);
      }
    },
  );
};
